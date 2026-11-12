//! Lead search: the solver chases several distinct leads (one ascendancy
//! context, one Weapon 1 and one damage route each), cuts the weak ones after a short first rung, and steps back to a
//! new weapon, route or reserve lead when a final stalls. Everything is read from game data and engine evaluations; no
//! build or item is named here.

use super::items::{slot_types, Piece, SlotKind};
use super::parts::{lead_rows, PartKind};
use super::sens::AXES;
use super::*;

/// One Weapon 1 choice: an allowed unique (or its Foulborn form), the best empty base of an allowed rare item type, or
/// the open build's own weapon.
#[derive(Clone)]
pub(super) struct WeaponOpt {
    pub name: String,
    pub item_type: String,
    /// None only in pure tests.
    pub piece: Option<Piece>,
    /// A one-hand weapon the off hand takes too: a lead may hold a second copy there.
    pub dual_ok: bool,
}

/// What one class context's screen found: each weapon's and route's worth, from its root (best weapon, bare tree).
#[derive(Clone, Default)]
pub(super) struct CtxGen {
    pub ctx: usize,
    pub weapons: Vec<WeaponOpt>,
    /// Gain of each weapon over the root weapon in the root state.
    pub root: Vec<f64>,
    /// The context's routes: distinct `AXES` indexes of its convex primes, best first.
    pub routes: Vec<usize>,
    /// `gain[r][w]`: weapon `w` in the root primed with route `r`, over the root weapon there.
    pub gain: Vec<Vec<f64>>,
    /// The four best ascendancy notables' summed gain under each route.
    pub asc_sum: Vec<f64>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Status {
    Live,
    Reserve,
    Dropped,
    Stalled,
    Final,
}

impl Status {
    pub(super) fn word(self) -> &'static str {
        match self {
            Status::Live => "live",
            Status::Reserve => "reserve",
            Status::Dropped => "dropped",
            Status::Stalled => "stalled",
            Status::Final => "final",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) enum Origin {
    Generated,
    /// A step back from lead `from`: "weapon", "route" or "reserve".
    Mutated { from: u16, what: &'static str },
}

#[derive(Clone)]
pub(super) struct Lead {
    pub id: u16,
    /// Index into `Solver::gens`.
    pub gen: usize,
    pub weapon: usize,
    /// Index into the gen's `routes`; None: the plain lead (no prime).
    pub route: Option<usize>,
    pub label: String,
    pub origin: Origin,
    pub st: Option<State>,
    pub best: f64,
    /// (budget spent, best score) after each round the lead was worked on.
    pub history: Vec<(u64, f64)>,
    pub status: Status,
    /// Step-backs in this lead's line so far (the next one tries weapon, route, reserve from here).
    pub steps: u8,
    /// (weapon, route) pairs this line has been.
    pub tried: Vec<(usize, Option<usize>)>,
    /// A second copy of the weapon in the off hand.
    pub dual: bool,
    /// A combo lead's pair (synergies.json, solver_synergy.rs), held from its start.
    pub combo: Option<Arc<super::synergy::ComboHold>>,
}

impl Lead {
    pub(super) fn new(id: u16, gen: usize, weapon: usize, route: Option<usize>, label: String) -> Lead {
        Lead { id, gen, weapon, route, label, origin: Origin::Generated, st: None, best: f64::NEG_INFINITY, history: Vec::new(), status: Status::Reserve, steps: 0, tried: vec![(weapon, route)], dual: false, combo: None }
    }
}

/// A step back from a stalled final.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Step {
    /// The same context and route, this weapon.
    Weapon(usize),
    /// The same weapon and context, this route.
    Route(usize),
    /// This reserve lead.
    Reserve(u16),
}

/// Step-backs per solve.
pub(super) const MAX_STEP_BACKS: usize = 3;
/// A final is stalled when its best rose less than this (about 1% DPS) over its last 3 rounds or 8% of the budget.
const STALL_GAIN: f64 = 0.01;

#[derive(Default)]
pub(super) struct LeadBook {
    pub leads: Vec<Lead>,
    pub step_backs: usize,
}

impl LeadBook {
    pub(super) fn add(&mut self, mut l: Lead) -> u16 {
        l.id = self.leads.len() as u16;
        self.leads.push(l);
        self.leads.len() as u16 - 1
    }

    pub(super) fn record(&mut self, id: u16, spent: u64, score: f64) {
        let l = &mut self.leads[id as usize];
        l.best = l.best.max(score);
        l.history.push((spent, l.best));
    }

    /// Whether lead `id`'s best rose less than `STALL_GAIN` over its last round, or over the last 5% of the budget
    /// (once it has been worked on that long). Kick rounds take seconds, so a final sees only one or two before the end:
    /// a round that gains nothing is the signal (its refinement counts as the first round, solver.rs `run`).
    pub(super) fn stalled(&self, id: u16, spent: u64, budget: u64) -> bool {
        let h = &self.leads[id as usize].history;
        let Some(&(_, now)) = h.last() else { return false };
        if h.len() >= 2 && now - h[h.len() - 2].1 < STALL_GAIN {
            return true;
        }
        let back = spent.saturating_sub(budget * 5 / 100);
        h.first().is_some_and(|f| f.0 <= back) && h.iter().rev().find(|x| x.0 <= back).is_some_and(|x| now - x.1 < STALL_GAIN)
    }

    /// The next step back for lead `id`: weapon, then route, then a reserve lead, starting from the line's own count, the
    /// first that has a candidate. None past `MAX_STEP_BACKS`.
    pub(super) fn next_step(&self, id: u16, gens: &[CtxGen]) -> Option<Step> {
        if self.step_backs >= MAX_STEP_BACKS {
            return None;
        }
        let l = &self.leads[id as usize];
        let g = gens.get(l.gen)?;
        for kind in (l.steps as usize).min(2)..3 {
            match kind {
                0 => {
                    let gain = |w: usize| l.route.map_or(g.root[w], |r| g.gain[r][w]);
                    let mut ws: Vec<usize> = (0..g.weapons.len()).filter(|&w| w != l.weapon && !l.tried.contains(&(w, l.route))).collect();
                    ws.sort_by(|&a, &b| gain(b).total_cmp(&gain(a)));
                    if let Some(&w) = ws.first() {
                        return Some(Step::Weapon(w));
                    }
                }
                1 => {
                    let mut rs: Vec<usize> = (0..g.routes.len()).filter(|&r| Some(r) != l.route && !l.tried.contains(&(l.weapon, Some(r)))).collect();
                    rs.sort_by(|&a, &b| g.gain[b][l.weapon].total_cmp(&g.gain[a][l.weapon]));
                    if let Some(&r) = rs.first() {
                        return Some(Step::Route(r));
                    }
                }
                _ => {
                    let best = self.leads.iter().filter(|x| x.status == Status::Reserve).max_by(|a, b| a.best.total_cmp(&b.best));
                    if let Some(x) = best {
                        return Some(Step::Reserve(x.id));
                    }
                }
            }
        }
        None
    }
}

/// Lead pairs (gen, weapon, route) from the screens (PLAN section 1 step 4-5): each context's own best pair; per route,
/// the context whose four best ascendancy notables gain most under it with its best weapon and its best weapon of
/// another item type; each context's plain root weapon. Deduped by (context, weapon), at most 3 per route and 4 per
/// weapon item type, cut to `max`, then filled to `min` by gain under the same caps; then the best pair whose weapon
/// the off hand takes too gets a dual-wield variant (the 4th field), in place of the last pair when full. `first`:
/// (gen, weapon) that must be lead 0 (the open build's).
pub(super) fn pair_leads(gens: &[CtxGen], first: Option<(usize, usize)>, max: usize, min: usize) -> Vec<(usize, usize, Option<usize>, bool)> {
    type P = (usize, usize, Option<usize>);
    let best_route = |g: &CtxGen, w: usize| (0..g.routes.len()).max_by(|&a, &b| g.gain[a][w].total_cmp(&g.gain[b][w]));
    let mut want: Vec<P> = Vec::new();
    if let Some((gi, w)) = first {
        want.push((gi, w, best_route(&gens[gi], w)));
    }
    // (each context's own best pair, on a weapon no earlier context took when it has one)
    for (gi, g) in gens.iter().enumerate() {
        let used: Vec<&str> = want.iter().map(|p| gens[p.0].weapons[p.1].name.as_str()).collect();
        let pairs: Vec<(usize, usize)> = (0..g.routes.len()).flat_map(|r| (0..g.weapons.len()).map(move |w| (r, w))).collect();
        let best = |fresh: bool| pairs.iter().copied().filter(|&(_, w)| !fresh || !used.contains(&g.weapons[w].name.as_str())).max_by(|a, b| g.gain[a.0][a.1].total_cmp(&g.gain[b.0][b.1]));
        if let Some((r, w)) = best(true).or_else(|| best(false)) {
            want.push((gi, w, Some(r)));
        }
    }
    let mut axes: Vec<usize> = Vec::new();
    for g in gens {
        for &a in &g.routes {
            if !axes.contains(&a) {
                axes.push(a);
            }
        }
    }
    let best_w = |g: &CtxGen, r: usize, not: Option<&str>| (0..g.weapons.len()).filter(|&w| not.is_none_or(|t| g.weapons[w].item_type != t)).max_by(|&a, &b| g.gain[r][a].total_cmp(&g.gain[r][b]));
    for &a in &axes {
        let at = gens.iter().enumerate().filter_map(|(gi, g)| g.routes.iter().position(|&x| x == a).map(|r| (gi, r))).max_by(|x, y| gens[x.0].asc_sum[x.1].total_cmp(&gens[y.0].asc_sum[y.1]));
        let Some((gi, r)) = at else { continue };
        let g = &gens[gi];
        if let Some(w) = best_w(g, r, None) {
            want.push((gi, w, Some(r)));
            if let Some(w2) = best_w(g, r, Some(&g.weapons[w].item_type)) {
                want.push((gi, w2, Some(r)));
            }
        }
    }
    for (gi, g) in gens.iter().enumerate() {
        if let Some(w) = (0..g.weapons.len()).max_by(|&a, &b| g.root[a].total_cmp(&g.root[b])) {
            want.push((gi, w, None));
        }
    }
    let axis = |p: &P| p.2.map(|r| gens[p.0].routes[r]);
    let take = |out: &mut Vec<P>, p: P| {
        let ty = &gens[p.0].weapons[p.1].item_type;
        if out.iter().any(|o| o.0 == p.0 && o.1 == p.1) || out.iter().filter(|o| axis(o) == axis(&p)).count() >= 3 || out.iter().filter(|o| &gens[o.0].weapons[o.1].item_type == ty).count() >= 4 {
            return;
        }
        out.push(p);
    };
    let mut out: Vec<P> = Vec::new();
    for p in want {
        if out.len() >= max {
            break;
        }
        take(&mut out, p);
    }
    if out.len() < min {
        let mut rest: Vec<(f64, P)> = gens.iter().enumerate().flat_map(|(gi, g)| (0..g.routes.len()).flat_map(move |r| (0..g.weapons.len()).map(move |w| (g.gain[r][w], (gi, w, Some(r)))))).collect();
        rest.sort_by(|a, b| b.0.total_cmp(&a.0));
        for (_, p) in rest {
            if out.len() >= min {
                break;
            }
            take(&mut out, p);
        }
    }
    let mut out: Vec<(usize, usize, Option<usize>, bool)> = out.into_iter().map(|p| (p.0, p.1, p.2, false)).collect();
    if let Some(p) = out.iter().find(|p| gens[p.0].weapons[p.1].dual_ok).copied() {
        // (full: the last pair of a context that keeps another makes room; a context's only pair never goes)
        let room = out.len() < max.max(2) || match (0..out.len()).rev().find(|&k| out.iter().filter(|o| o.0 == out[k].0).count() > 1) {
            Some(k) => {
                out.remove(k);
                true
            }
            None => false,
        };
        if room {
            out.push((p.0, p.1, p.2, true));
        }
    }
    out
}

/// Successive halving (cut 1): the `keep` best by score, and each route's best when it is within ln 2 of the top (half
/// the DPS at the same EHP), since a route that needs many points starts slow. Returns the surviving indexes.
pub(super) fn halve(ranked: &[(f64, Option<usize>)], keep: usize) -> Vec<usize> {
    let mut idx: Vec<usize> = (0..ranked.len()).filter(|&i| ranked[i].0.is_finite()).collect();
    idx.sort_by(|&a, &b| ranked[b].0.total_cmp(&ranked[a].0));
    let Some(&top) = idx.first() else { return Vec::new() };
    let mut out: Vec<usize> = idx.iter().copied().take(keep).collect();
    for &i in &idx {
        let r = ranked[i].1;
        if r.is_some() && !out.iter().any(|&o| ranked[o].1 == r) && ranked[top].0 - ranked[i].0 < std::f64::consts::LN_2 {
            out.push(i);
        }
    }
    out
}

/// Cut 1's verdict per lead from (score, score with every limit counted met, ascendancy and weapon): Live when `keep`
/// has it; Dropped only when more than ln 4 behind the top on the limit-free score and not the best of its ascendancy
/// and weapon (a lead that is behind only on a limit it has not repaired yet stays in reserve); else Reserve. A lead
/// without a state scores -inf and stays Reserve.
pub(super) fn cut_status<K: PartialEq>(leads: &[(f64, f64, K)], keep: &[usize]) -> Vec<Status> {
    let top = leads.iter().map(|l| l.1).filter(|x| x.is_finite()).fold(f64::NEG_INFINITY, f64::max);
    (0..leads.len())
        .map(|i| {
            let (s, free, k) = &leads[i];
            let pair_best = !leads.iter().enumerate().any(|(j, o)| j != i && o.2 == *k && (o.1 > *free || (o.1 == *free && j < i)));
            if keep.contains(&i) {
                Status::Live
            } else if s.is_finite() && top - free > 4f64.ln() && !pair_best {
                Status::Dropped
            } else {
                Status::Reserve
            }
        })
        .collect()
}

/// `pool` sorted best first with each lead's best state moved to the front (states without a lead count as their
/// own); the rest follow.
pub(super) fn one_per_lead(mut pool: Vec<State>) -> Vec<State> {
    pool.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    let mut seen: Vec<u16> = Vec::new();
    let (mut firsts, mut rest) = (Vec::new(), Vec::new());
    for st in pool {
        match st.lead {
            Some(l) if seen.contains(&l) => rest.push(st),
            Some(l) => {
                seen.push(l);
                firsts.push(st);
            }
            None => firsts.push(st),
        }
    }
    firsts.extend(rest);
    firsts
}

/// `xml` with every switch of `on` set as it is there; its other switches stay.
fn with_switches(xml: &str, on: &[config::On]) -> String {
    let mut x = xml.to_string();
    for o in on {
        if x.contains(&o.xml) {
            continue;
        }
        let at = format!("<Input name=\"{}\"", crate::edit::esc(&o.key));
        for _ in 0..3 {
            if !x.contains(&at) {
                break;
            }
            match crate::edit::set_config_input(&x, &o.key, None) {
                Ok(y) if y != x => x = y,
                _ => break,
            }
        }
        x = x.replacen("</Config>", &format!("{}</Config>", o.xml), 1);
    }
    x
}

impl Solver {
    /// The screen's text of `st` (with `piece` in Weapon 1, and the `probe` lines) under one setup: the root's settled
    /// switches `on` as the root has them, plus the weapon's own other switches.
    pub(super) fn screen_text(&self, st: &State, piece: Option<&Piece>, on: &[config::On], probe: &[&str]) -> Option<String> {
        let s = match piece {
            Some(p) => self.with_weapon(st, p)?,
            None => st.clone(),
        };
        let x = if probe.is_empty() { self.render(&s).ok()? } else { self.render_with_probe(&s, probe).ok()? };
        Some(with_switches(&x, on))
    }

    fn weapon_slot(&self) -> Result<usize, String> {
        self.slot_of(SlotKind::Weapon1).ok_or_else(|| "no Weapon 1 slot".to_string())
    }

    /// A lead's label, "2x <weapon>" for a dual-wield lead.
    fn dual_label(&self, gen: usize, w: usize, route: Option<usize>, dual: bool) -> String {
        let label = self.lead_label(gen, w, route);
        let name = &self.gens[gen].weapons[w].name;
        if dual { label.replacen(&format!(" · {name} · "), &format!(" · 2x {name} · "), 1) } else { label }
    }

    /// The off hand for a lead on `piece`: a second copy held there when `dual` (false when it cannot be worn: the
    /// gear is left as it was); otherwise, when the old lead was dual, whatever is held in the off hand is its copy (by
    /// slot, since crafts and anoints change its label) and is released and cleared.
    pub(super) fn set_off_hand(&self, st: &mut State, piece: &Piece, dual: bool, old_dual: bool) -> bool {
        let Some(w2) = self.slot_of(SlotKind::Weapon2) else { return !dual };
        let mut g = (*st.gear).clone();
        if dual {
            g.held.retain(|&i| i != w2);
            let Some(mut g) = self.with_piece(&g, w2, Some(piece.clone())) else { return false };
            g.held.push(w2);
            st.gear = Arc::new(g);
            return true;
        }
        if old_dual && g.held.contains(&w2) {
            g.held.retain(|&i| i != w2);
            g.pieces[w2] = None;
            st.gear = Arc::new(g);
        }
        true
    }

    /// `st` with `piece` in Weapon 1, held there; None when the piece cannot be worn with the rest.
    pub(super) fn with_weapon(&self, st: &State, piece: &Piece) -> Option<State> {
        let w1 = self.slot_of(SlotKind::Weapon1)?;
        let mut g = (*st.gear).clone();
        g.held.retain(|&i| i != w1);
        let mut g = self.with_piece(&g, w1, Some(piece.clone()))?;
        g.held.push(w1);
        Some(State { gear: Arc::new(g), ..st.clone() })
    }

    /// Every Weapon 1 choice: the allowed uniques and their Foulborn forms, the best empty base of each rare item type
    /// the slot allows (by its score in `st0`), and the open build's own weapon.
    fn weapon_opts(&self, st0: &State) -> Result<Vec<WeaponOpt>, String> {
        let w1 = self.weapon_slot()?;
        let types = slot_types(SlotKind::Weapon1);
        let mut out: Vec<WeaponOpt> = Vec::new();
        if let Some(p) = self.player_pieces.get(w1).cloned().flatten() {
            out.push(WeaponOpt { name: format!("your {}", p.item_type), item_type: p.item_type.clone(), piece: Some(p), dual_ok: false });
        }
        for u in self.uniques.iter().flat_map(|u| std::iter::once(u).chain(u.variants.iter().filter(|v| v.label.starts_with("Foulborn ")))) {
            if !types.contains(&u.item_type.as_str()) || !self.weapon_ok(&u.item_type) {
                continue;
            }
            let p = items::unique_piece(u);
            if self.with_piece(&st0.gear, w1, Some(p.clone())).is_some() {
                let name = if u.label.starts_with("Foulborn ") { u.label.trim_end_matches(" (unique)").to_string() } else { u.name.clone() };
                out.push(WeaponOpt { name, item_type: u.item_type.clone(), piece: Some(p), dual_ok: false });
            }
        }
        // Rare bases: the best of each item type by its plain score here.
        let mut rares: Vec<Piece> = Vec::new();
        for b in self.slot_bases(w1) {
            let p = self.empty_craft(&b)?;
            if self.with_piece(&st0.gear, w1, Some(p.clone())).is_some() {
                rares.push(p);
            }
        }
        if !rares.is_empty() {
            let texts: Vec<Option<String>> = rares.iter().map(|p| self.with_weapon(st0, p).and_then(|s| self.render(&s).ok())).collect();
            let sc = self.score_texts(texts);
            let mut best: Vec<(String, f64, usize)> = Vec::new();
            for (k, p) in rares.iter().enumerate() {
                match best.iter_mut().find(|b| b.0 == p.item_type) {
                    Some(b) if sc[k] > b.1 => *b = (p.item_type.clone(), sc[k], k),
                    Some(_) => {}
                    None => best.push((p.item_type.clone(), sc[k], k)),
                }
            }
            for (t, _, k) in best {
                let base = rares[k].base().map(|b| b.name.clone()).unwrap_or_default();
                out.push(WeaponOpt { name: format!("rare {base}"), item_type: t, piece: Some(rares[k].clone()), dual_ok: false });
            }
        }
        let w2 = self.slot_of(SlotKind::Weapon2).filter(|&i| !self.slots[i].locked);
        // (a second copy can be worn only of a crafted weapon: one unique of a kind is allowed, and the player's own is
        // one piece. shortcut: uniques whose data allows two are not read; add them if one matters.)
        for o in &mut out {
            o.dual_ok = o.piece.as_ref().is_some_and(|p| matches!(p.design, items::Design::Craft { .. }) && !p.two_hand && w2.is_some_and(|w2| slot_types(SlotKind::Weapon2).contains(&p.item_type.as_str()) && self.rules.slot_allows(&self.slots[w2].name, p)));
        }
        Ok(out)
    }

    /// Relaxed scores (resist, attribute and pool floors and skill cost off, `relaxed_score`) of whole build texts, one
    /// batch. A text that does not evaluate scores -inf.
    fn score_texts(&self, texts: Vec<Option<String>>) -> Vec<f64> {
        let at: Vec<Option<usize>> = {
            let mut n = 0;
            texts.iter().map(|t| t.as_ref().map(|_| { n += 1; n - 1 })).collect()
        };
        let r = self.eval(texts.into_iter().flatten().map(|t| Cand::Xml(Arc::new(t))).collect());
        at.iter().map(|a| a.and_then(|i| r[i].as_ref()).map_or(f64::NEG_INFINITY, |v| self.relaxed_score(v, false))).collect()
    }

    /// One context's screen (PLAN section 1 steps 1-3): its root (the best weapon on a bare tree), its routes (convex
    /// primes of a full sensitivity), and every weapon's and ascendancy notable's gain under each route.
    /// `rows`: the route rows an earlier context measured, with its root weapon; a context on the same root weapon takes
    /// them instead of measuring again (a bare root's sensitivity hardly moves with the ascendancy, and the full measure
    /// is most of a context's screen time).
    fn ctx_gen(&mut self, ci: usize, opts: &[WeaponOpt], until: u64, rows: &mut Option<(String, Vec<(usize, &'static [&'static str])>)>) -> Result<(CtxGen, State), String> {
        self.current = self.ctx[ci].label.clone();
        let st0 = self.initial_state(ci, None, None)?;
        let pieces: Vec<&Piece> = opts.iter().filter_map(|o| o.piece.as_ref()).collect();
        let texts: Vec<Option<String>> = pieces.iter().map(|p| self.with_weapon(&st0, p).and_then(|s| self.render(&s).ok())).collect();
        let root_sc = self.score_texts(texts);
        let wi = (0..pieces.len()).max_by(|&a, &b| root_sc[a].total_cmp(&root_sc[b])).ok_or("no Weapon 1 the goal allows")?;
        let mut root = self.with_weapon(&st0, pieces[wi]).ok_or("root weapon")?;
        self.rebase(&mut root)?;
        // One setup for the whole screen: the root's settled switches (a charge source on the root weapon, and the
        // bypass that spends it, count for every weapon).
        let on: Vec<config::On> = {
            let x = Arc::new(self.render(&root)?);
            let (_, _, on, _) = self.settle_config(&root, x, root.vals.clone());
            on.into_iter().filter(|o| !o.player).collect()
        };
        let texts: Vec<Option<String>> = pieces.iter().map(|p| self.screen_text(&st0, Some(p), &on, &[])).collect();
        let root_sc = self.score_texts(texts);
        self.layer = "leads: sensitivity".into();
        self.publish();
        let label = pieces[wi].label.clone();
        let r = match rows.as_ref().filter(|r| r.0 == label) {
            Some(r) => r.1.clone(),
            None => {
                let sens = self.sensitivity_full(&root)?;
                let r = lead_rows(&sens, 6);
                *rows = Some((label, r.clone()));
                r
            }
        };
        let (axes, primes): (Vec<usize>, Vec<Vec<&str>>) = r.into_iter().map(|(i, l)| (i, l.to_vec())).unzip();
        self.layer = "leads: screen".into();
        self.publish();
        // Weapons in each primed root, over the root weapon there.
        let mut wgain: Vec<Vec<f64>> = Vec::new();
        for (k, prime) in primes.iter().enumerate() {
            if self.spent() >= until {
                wgain.push(vec![0.0; pieces.len()]);
                continue;
            }
            // (each weapon with the package its route needs: `route_lines`)
            let probe = |p: &Piece| -> Vec<String> { self.route_lines(p, axes[k], prime) };
            let screen = |p: Option<&Piece>, own: &Piece| {
                let l = probe(own);
                self.screen_text(&root, p, &on, &l.iter().map(String::as_str).collect::<Vec<_>>())
            };
            let mut texts = vec![Some(screen(None, pieces[wi]).ok_or("root probe")?)];
            texts.extend(pieces.iter().map(|p| screen(Some(p), p)));
            let sc = self.score_texts(texts);
            wgain.push(sc[1..].iter().map(|x| if x.is_finite() && sc[0].is_finite() { x - sc[0] } else { f64::NEG_INFINITY }).collect());
        }
        let asc: Vec<parts::Part> = self.part_catalog(ci).into_iter().filter(|p| matches!(p.kind, PartKind::Asc(_))).collect();
        // (each prime with its route's package, as the weapon screen above: the root weapon sizes the crit chance)
        let owned: Vec<Vec<String>> = primes.iter().enumerate().map(|(k, p)| self.route_lines(pieces[wi], axes[k], p)).collect();
        let primes: Vec<Vec<&str>> = owned.iter().map(|l| l.iter().map(String::as_str).collect()).collect();
        let screen = self.screen(&root, &asc, &primes, until)?;
        let mut routes: Vec<usize> = Vec::new();
        for &a in &axes {
            if !routes.contains(&a) {
                routes.push(a);
            }
        }
        let ax = &axes;
        let rows = move |a: usize| (0..ax.len()).filter(move |&k| ax[k] == a);
        let gain: Vec<Vec<f64>> = routes.iter().map(|&a| (0..pieces.len()).map(|w| rows(a).map(|k| wgain[k][w]).fold(f64::NEG_INFINITY, f64::max)).collect()).collect();
        let asc_sum: Vec<f64> = routes
            .iter()
            .map(|&a| {
                let mut v: Vec<f64> = (0..asc.len()).map(|i| rows(a).map(|k| screen.primed[k][i]).fold(f64::NEG_INFINITY, f64::max)).collect();
                v.sort_by(|x, y| y.total_cmp(x));
                v.iter().take(4).filter(|x| x.is_finite()).sum()
            })
            .collect();
        let base = root_sc[wi];
        let rootg: Vec<f64> = root_sc.iter().map(|x| x - base).collect();
        let weapons: Vec<WeaponOpt> = opts.iter().filter(|o| o.piece.is_some()).cloned().collect();
        Ok((CtxGen { ctx: ci, weapons, root: rootg, routes, gain, asc_sum }, root))
    }

    /// The probe lines that screen `p` on route `a` (rows `lines`). A crit route's weapon is measured with the crit
    /// package a finished crit build brings it: crit chance taken to `CRIT_TARGET`% from the weapon's own base crit (read
    /// from the game's item bases, so a 5% axe needs more increased chance than a 7% dagger), and the multiplier of one.
    /// The fixed rows of `AXES` are sized for sensitivity, and under them a weapon whose damage pays only once crit is up
    /// ranks below one that pays without it. Other routes: the rows as they are.
    fn route_lines(&self, p: &Piece, a: usize, lines: &[&'static str]) -> Vec<String> {
        let ax = &AXES[a];
        // (accuracy on every route: the bare state starves a weapon with none of its own of hits, and a build has it from gear)
        let acc = "+3000 to Accuracy Rating".to_string();
        if ax.family != super::sens::Family::Crit || lines != ax.commit {
            return std::iter::once(acc).chain(lines.iter().map(|l| l.to_string())).collect();
        }
        const FLAT: f64 = 6.0;
        const CRIT_TARGET: f64 = 75.0;
        let game = pom_calc::data::game_data();
        let base = p.base().map(|b| b.name.clone()).or_else(|| p.xml.lines().map(str::trim).find(|l| game.item_bases.contains_key(*l)).map(String::from));
        let crit = base.and_then(|n| game.item_bases.get(&n).and_then(|b| b.weapon.as_ref()).and_then(|w| w.get("CritChanceBase").copied())).unwrap_or(5.0);
        let inc = ((CRIT_TARGET / (crit + FLAT) - 1.0) * 100.0).max(0.0).round();
        vec![acc, format!("+{FLAT}% to Critical Strike Chance"), format!("{inc}% increased Critical Strike Chance"), "+250% to Critical Strike Multiplier".to_string()]
    }

    fn lead_label(&self, gen: usize, w: usize, route: Option<usize>) -> String {
        let g = &self.gens[gen];
        let c = &self.ctx[g.ctx];
        let route = route.map_or("plain", |r| AXES[g.routes[r]].name);
        format!("{route} · {} · {}", g.weapons[w].name, c.asc_name.clone().unwrap_or_else(|| c.class_name.clone()))
    }

    /// Phase G: a screen per class context, then 8-16 leads (`pair_leads`). Returns the best root (its gems and gear
    /// seed every lead).
    pub(super) fn generate_leads(&mut self, cands: &[usize], until: u64) -> Result<Option<State>, String> {
        let Some(&c0) = cands.first() else { return Ok(None) };
        let st0 = self.initial_state(c0, None, None)?;
        let opts = self.weapon_opts(&st0)?;
        if opts.is_empty() {
            return Ok(None);
        }
        let own = self.seed.as_ref().map(|(c, a, _, _)| (*c, *a));
        let mut roots: Vec<State> = Vec::new();
        self.gens.clear();
        let mut rows = None;
        for (k, &ci) in cands.iter().enumerate() {
            if self.stop() || (k > 0 && self.spent() >= until) {
                break;
            }
            let my_end = self.spent() + until.saturating_sub(self.spent()) / (cands.len() - k) as u64;
            let (g, r) = self.ctx_gen(ci, &opts, my_end, &mut rows)?;
            self.gens.push(g);
            roots.push(r);
        }
        let w1 = self.weapon_slot()?;
        let own_weapon = self.player_pieces.get(w1).is_some_and(|p| p.is_some());
        let first = own.and_then(|(c, a)| self.gens.iter().position(|g| self.ctx[g.ctx].class_id == c && self.ctx[g.ctx].asc_id == a)).filter(|_| own_weapon).map(|gi| (gi, 0));
        let pairs = pair_leads(&self.gens, first, 16, 8);
        self.book = LeadBook::default();
        for (gi, w, r, dual) in pairs {
            let label = self.dual_label(gi, w, r, dual);
            let id = self.book.add(Lead::new(0, gi, w, r, label));
            self.book.leads[id as usize].dual = dual;
        }
        self.combo_leads(&roots)?;
        let best = (0..roots.len()).max_by(|&a, &b| roots[a].score.total_cmp(&roots[b].score)).unwrap_or(0);
        Ok(roots.into_iter().nth(best))
    }

    /// Rung 1 for one lead: its context, the shared gear with its weapon held, its own enemy ailments, gems for that
    /// weapon and route, then a quick items pass (at most 2/5 of `share`) and the ascendancy and tree until `share` ends.
    pub(super) fn lead_start(&mut self, id: u16, gear: &Arc<Gear>, share: u64) -> Result<State, String> {
        let (gen, w, route, dual) = {
            let l = &self.book.leads[id as usize];
            (l.gen, l.weapon, l.route, l.dual)
        };
        let (ci, piece) = (self.gens[gen].ctx, self.gens[gen].weapons[w].piece.clone().ok_or("lead without a weapon")?);
        self.current = self.book.leads[id as usize].label.clone();
        let end = self.spent() + share;
        let r = (|| -> Result<State, String> {
            let st0 = self.initial_state(ci, None, Some(gear.clone()))?;
            let mut st = self.with_weapon(&st0, &piece).unwrap_or(st0);
            // (a dual-wield lead holds a second copy in the off hand; one that cannot be worn makes it a one-weapon lead)
            if dual && !self.set_off_hand(&mut st, &piece, true, false) {
                let label = self.dual_label(gen, w, route, false);
                let l = &mut self.book.leads[id as usize];
                (l.dual, l.label) = (false, label);
            }
            st.lead = Some(id);
            self.rebase(&mut st)?;
            self.assume_ailments(&mut st)?;
            self.lead_hint = route.map(|r| vec![self.gens[gen].routes[r]]).unwrap_or_default();
            self.hold_combo(id, &mut st)?;
            self.phase_end.set(self.spent() + share * 2 / 5);
            self.layer = "gems".into();
            self.gem_layer(&mut st, false)?;
            // (a two-hand root weapon left the off hand empty: offer it again for a one-hand lead)
            if let Some(i2) = self.slot_of(SlotKind::Weapon2).filter(|&i| !self.slots[i].locked && st.gear.pieces[i].is_none()) {
                let mut ch = vec![(i2, None)];
                for b in self.slot_bases(i2) {
                    ch.push((i2, Some(self.empty_craft(&b)?)));
                }
                self.apply_best(&mut st, ch, true)?;
            }
            self.items_layer(&mut st, false)?;
            self.phase_end.set(end);
            self.trim(&mut st, false)?;
            self.trim(&mut st, true)?;
            self.layer = "ascendancy".into();
            self.grow(&mut st, true)?;
            self.layer = "tree".into();
            self.grow(&mut st, false)?;
            Ok(st)
        })();
        self.phase_end.set(u64::MAX);
        self.lead_hint.clear();
        let st = r?;
        self.archive_add(&st)?;
        self.publish();
        let l = &mut self.book.leads[id as usize];
        l.best = st.score;
        l.st = Some(st.clone());
        l.status = Status::Live;
        Ok(st)
    }

    /// Cut 1: soft limits back at full penalty, the EHP knee at the leads' median EHP, every score taken again; a quick
    /// limit repair on the best few; then `halve`. The survivors are Live (returned, best first), leads that lost by
    /// more than ln 4 are Dropped, the rest stay Reserve.
    pub(super) fn cut_one(&mut self, until: u64) -> Result<Vec<State>, String> {
        self.scorer.ramp = 1.0;
        let ehp = self.scorer.targets.iter().position(|t| t.metric.trim() == "ehp" && t.value.is_none());
        if let Some(k) = ehp {
            let t = &self.scorer.targets[k];
            let mut v: Vec<f64> = self.book.leads.iter().filter_map(|l| l.st.as_ref()).map(|s| self.scorer.target_value(t, &s.vals)).filter(|x| *x > 0.0).collect();
            v.sort_by(|a, b| a.total_cmp(b));
            if !v.is_empty() {
                self.scorer.knee = Some(v[v.len() / 2]);
            }
        }
        // Both: each side's bar is the leads' median on that side, so neither side's size decides which is the weaker.
        if let Some(c) = self.scorer.targets.iter().find(|t| t.pair.is_some()).filter(|t| t.value.is_none()) {
            let b = &self.scorer.targets[c.pair.unwrap_or(0)];
            let med = |t: &TargetDef| {
                let mut v: Vec<f64> = self.book.leads.iter().filter_map(|l| l.st.as_ref()).map(|s| self.scorer.target_value(t, &s.vals)).filter(|x| *x > 0.0).collect();
                v.sort_by(|a, b| a.total_cmp(b));
                v.get(v.len() / 2).copied()
            };
            if let (Some(mc), Some(mb)) = (med(c), med(b)) {
                self.scorer.bars = Some((mc, mb));
            }
        }
        let goal_w: Vec<f64> = self.scorer.targets.iter().map(|t| t.weight).collect();
        for e in self.archive.iter_mut() {
            let (s, viol) = self.scorer.score(&e.vals, &goal_w);
            e.score = s;
            e.viol = viol;
        }
        self.archive.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        for i in 0..self.book.leads.len() {
            if let Some(mut s) = self.book.leads[i].st.take() {
                (s.score, s.viol) = self.score(&s.vals);
                self.book.leads[i].best = s.score;
                self.book.leads[i].st = Some(s);
            }
        }
        // Repair the best six (10x penalty, inside the cut's time).
        let mut run: Vec<usize> = (0..self.book.leads.len()).filter(|&i| self.book.leads[i].st.is_some()).collect();
        run.sort_by(|&a, &b| self.book.leads[b].best.total_cmp(&self.book.leads[a].best));
        self.layer = "leads: cut".into();
        let n = run.len().min(6);
        for (k, &i) in run.iter().take(n).enumerate() {
            if self.stop() || self.spent() >= until {
                break;
            }
            let mut s = self.book.leads[i].st.clone().unwrap();
            self.current = self.book.leads[i].label.clone();
            self.phase_end.set(self.spent() + until.saturating_sub(self.spent()) / (n - k) as u64);
            let r = self.repair_limits_with(&mut s, &[10.0], false);
            self.phase_end.set(u64::MAX);
            r?;
            self.archive_add(&s)?;
            self.book.leads[i].best = s.score;
            self.book.leads[i].st = Some(s);
        }
        let ranked: Vec<(f64, Option<usize>)> = self.book.leads.iter().map(|l| (if l.st.is_some() { l.best } else { f64::NEG_INFINITY }, l.route.map(|r| self.gens[l.gen].routes[r]))).collect();
        let keep = halve(&ranked, 4);
        let pen = self.scorer.penalty;
        let rows: Vec<(f64, f64, (usize, String))> = self
            .book
            .leads
            .iter()
            .map(|l| {
                let key = (self.gens[l.gen].ctx, self.gens[l.gen].weapons[l.weapon].name.clone());
                match &l.st {
                    Some(s) => (l.best, s.score + pen * s.viol, key),
                    None => (f64::NEG_INFINITY, f64::NEG_INFINITY, key),
                }
            })
            .collect();
        let status = cut_status(&rows, &keep);
        let mut out = Vec::new();
        for (l, st) in self.book.leads.iter_mut().zip(status) {
            l.status = st;
        }
        for &i in &keep {
            if let Some(s) = self.book.leads[i].st.clone() {
                out.push(s);
            }
        }
        self.publish();
        Ok(out)
    }

    /// Step back from the stalled final `st` of lead `id` (PLAN section 3): the next weapon on its route, the next route
    /// for its weapon, or the best reserve lead, made within a 6% slice of the budget. Returns the candidate (with its
    /// new lead) or None when no step is left.
    pub(super) fn step_back(&mut self, st: &State, id: u16, rng: &mut u64) -> Result<Option<State>, String> {
        let Some(step) = self.book.next_step(id, &self.gens) else { return Ok(None) };
        self.book.step_backs += 1;
        self.book.leads[id as usize].status = Status::Stalled;
        let old = self.book.leads[id as usize].clone();
        let (gen, mut w, mut route, what) = match step {
            Step::Weapon(w) => (old.gen, w, old.route, "weapon"),
            Step::Route(r) => (old.gen, old.weapon, Some(r), "route"),
            Step::Reserve(rid) => {
                let r = &self.book.leads[rid as usize];
                (r.gen, r.weapon, r.route, "reserve")
            }
        };
        // (a dual lead stays dual on a new route, and on a new weapon that can be worn twice)
        let dual = match step {
            Step::Weapon(nw) => old.dual && self.gens[gen].weapons[nw].dual_ok,
            Step::Route(_) => old.dual,
            Step::Reserve(rid) => self.book.leads[rid as usize].dual,
        };
        let nid = match step {
            Step::Reserve(rid) => rid,
            _ => {
                let mut l = Lead::new(0, gen, w, route, self.dual_label(gen, w, route, dual));
                l.dual = dual;
                l.tried = old.tried.clone();
                l.tried.push((w, route));
                self.book.add(l)
            }
        };
        {
            let l = &mut self.book.leads[nid as usize];
            l.origin = Origin::Mutated { from: id, what };
            l.steps = old.steps + 1;
            if what == "reserve" {
                l.tried.extend(old.tried.iter().copied());
            }
            (w, route) = (l.weapon, l.route);
        }
        self.layer = format!("step back: {what}");
        self.current = self.book.leads[nid as usize].label.clone();
        self.publish();
        let slice_end = self.spent() + self.budget_ms * 6 / 100;
        self.phase_end.set(slice_end);
        let hint = route.map(|r| vec![self.gens[gen].routes[r]]).unwrap_or_default();
        self.lead_hint = hint;
        let r = (|| -> Result<Option<State>, String> {
            let mut s = match step {
                Step::Weapon(_) => {
                    let piece = self.gens[gen].weapons[w].piece.clone().ok_or("lead without a weapon")?;
                    let Some(mut s) = self.with_weapon(st, &piece) else { return Ok(None) };
                    // (the new weapon in both hands for a dual lead, else the old off-hand copy goes)
                    if !self.set_off_hand(&mut s, &piece, dual, old.dual) {
                        let label = self.dual_label(gen, w, route, false);
                        let l = &mut self.book.leads[nid as usize];
                        (l.dual, l.label) = (false, label);
                        self.set_off_hand(&mut s, &piece, false, old.dual);
                    }
                    s.lead = Some(nid);
                    self.rebase(&mut s)?;
                    self.assume_ailments(&mut s)?;
                    self.gem_layer(&mut s, true)?;
                    self.items_layer(&mut s, false)?;
                    s
                }
                Step::Route(_) => {
                    let mut s = st.clone();
                    s.lead = Some(nid);
                    self.gem_layer(&mut s, true)?;
                    self.items_layer(&mut s, false)?;
                    self.kick(&s, rng, 2)?
                }
                Step::Reserve(rid) => match self.book.leads[rid as usize].st.clone() {
                    Some(s) => s,
                    None => {
                        let gear = self.lead_gear.clone().ok_or("no lead gear")?;
                        let share = slice_end.saturating_sub(self.spent()) / 2;
                        self.phase_end.set(u64::MAX);
                        let s = self.lead_start(rid, &gear, share);
                        self.phase_end.set(slice_end);
                        s?
                    }
                },
            };
            self.grow(&mut s, true)?;
            self.grow(&mut s, false)?;
            self.refine_tree(&mut s, false)?;
            if matches!(step, Step::Reserve(_)) {
                self.converge(&mut s)?;
            }
            Ok(Some(s))
        })();
        self.phase_end.set(u64::MAX);
        self.lead_hint.clear();
        let s = r?;
        if let Some(s) = &s {
            self.archive_add(s)?;
            let l = &mut self.book.leads[nid as usize];
            l.best = l.best.max(s.score);
            l.st = Some(s.clone());
        }
        Ok(s)
    }

    /// The best result's tree, gems and Weapon 1 with nothing else equipped (an attack needs its weapon to hit at
    /// all): the floor any solved build must clearly beat.
    pub(super) fn no_gear_baseline(&mut self, st: &State) -> Result<(f64, f64), String> {
        let mut pieces = vec![None; self.slots.len()];
        if let Some(w1) = self.slot_of(SlotKind::Weapon1) {
            pieces[w1] = st.gear.pieces[w1].clone();
        }
        // (not `ready`: the empty slots still hold the gems, so the floor is the tree and gems, not a gemless build)
        let mut s = State { gear: Arc::new(Gear { ready: false, pieces, ..Default::default() }), ..st.clone() };
        self.rebase(&mut s)?;
        let ehp = self.scorer.targets.iter().find(|t| t.metric.trim() == "ehp").map_or(0.0, |t| self.scorer.target_value(t, &s.vals));
        Ok((self.scorer.damage_value(&s.vals), ehp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cg(types: &[&str], routes: &[usize], gain: Vec<Vec<f64>>, asc: Vec<f64>, root: Vec<f64>) -> CtxGen {
        CtxGen { ctx: 0, weapons: types.iter().enumerate().map(|(i, t)| WeaponOpt { name: format!("w{i}"), item_type: t.to_string(), piece: None, dual_ok: !t.starts_with("Two") }).collect(), root, routes: routes.to_vec(), gain, asc_sum: asc }
    }

    /// Cut 1 drops a lead only when it is far behind with its limits counted met and is not the best of its ascendancy
    /// and weapon: one 10 behind only on a life shortfall stays in reserve.
    #[test]
    fn cut_keeps_penalised_and_pair_best_in_reserve() {
        let rows = vec![(22.5, 22.5, (0, "a")), (12.0, 24.0, (1, "b")), (12.0, 12.0, (2, "c")), (11.0, 11.0, (2, "c")), (f64::NEG_INFINITY, f64::NEG_INFINITY, (3, "d"))];
        let s = cut_status(&rows, &[0]);
        assert_eq!(s, vec![Status::Live, Status::Reserve, Status::Reserve, Status::Dropped, Status::Reserve]);
    }

    /// Cut 1 keeps the top 4, plus a route's best within ln 2 of the top; a route further behind is not kept.
    #[test]
    fn halving_keeps_route_best() {
        let r = [(5.0, Some(1)), (4.9, Some(1)), (4.8, Some(2)), (4.7, Some(1)), (4.0, Some(3)), (4.6, Some(3)), (3.0, Some(4)), (f64::NEG_INFINITY, Some(5))];
        let mut k = halve(&r, 4);
        k.sort_unstable();
        assert_eq!(k, vec![0, 1, 2, 3, 5]);
    }

    /// A final flat for 3 rounds is stalled; its line steps back weapon, then route, then reserve, at most 3 times.
    #[test]
    fn stall_steps_back() {
        let g = cg(&["Claw", "Claw", "Axe"], &[10, 20], vec![vec![0.0, 0.5, 0.2], vec![0.1, 0.0, 0.9]], vec![1.0, 1.0], vec![0.0, 0.1, 0.2]);
        let mut b = LeadBook::default();
        let a = b.add(Lead::new(0, 0, 0, Some(0), "a".into()));
        let res = b.add(Lead::new(0, 0, 2, Some(1), "reserve".into()));
        b.leads[res as usize].best = 3.0;
        for (t, s) in [(1, 1.0), (2, 1.5)] {
            b.record(a, t, s);
            assert!(!b.stalled(a, t, 1_000_000), "round {t}");
        }
        b.record(a, 3, 1.501);
        assert!(b.stalled(a, 3, 1_000_000), "flat for a round");
        // first step: the next weapon on the route, by its primed gain (w1 0.5 before w2 0.2)
        assert_eq!(b.next_step(a, &[g.clone()]), Some(Step::Weapon(1)));
        b.step_backs += 1;
        let mut l2 = Lead::new(0, 0, 1, Some(0), "a2".into());
        l2.steps = 1;
        l2.tried = vec![(0, Some(0)), (1, Some(0))];
        let a2 = b.add(l2);
        assert_eq!(b.next_step(a2, &[g.clone()]), Some(Step::Route(1)));
        b.step_backs += 1;
        let mut l3 = Lead::new(0, 0, 1, Some(1), "a3".into());
        l3.steps = 2;
        let a3 = b.add(l3);
        assert_eq!(b.next_step(a3, &[g.clone()]), Some(Step::Reserve(res)));
        b.step_backs += 1;
        assert_eq!(b.next_step(a3, &[g]), None, "cap of {MAX_STEP_BACKS}");
        // a rising lead is not stalled
        let up = b.add(Lead::new(0, 0, 0, None, "up".into()));
        for (t, s) in [(1, 1.0), (2, 1.2), (3, 1.4), (4, 1.6)] {
            b.record(up, t, s);
        }
        assert!(!b.stalled(up, 4, 1_000_000));
    }

    const FLICKER: &str = r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}],"items":{"rarities":["normal","magic","rare","unique"],"slotRarities":{"Weapon 1":["unique"]}},"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"mapping","ailments":true}}"#;

    /// The Templar Flicker goal with a 240 s budget counted in evaluations (1.2 ms of budget per evaluation).
    fn flicker() -> Solver {
        let goal: Goal = serde_json::from_str(FLICKER).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":240000,"maxEvals":200000,"threads":4}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// Phase G on the Templar Flicker goal (Weapon 1 unique only) gives 8-16 leads over several weapon types and routes
    /// and every Templar ascendancy, each weapon one the slot allows; a lead's start has its weapon in and deals damage
    /// (the zero-DPS regression); the held weapon cannot be swapped out.
    #[test]
    fn leads_flicker_weapon_dps_held() {
        let mut s = flicker();
        let cands = s.candidates().unwrap();
        s.scorer.ramp = 0.2;
        let root = s.generate_leads(&cands, 240_000 * 8 / 100).unwrap().expect("a root");
        for l in &s.book.leads {
            println!("lead {}: {}", l.id, l.label);
        }
        let n = s.book.leads.len();
        assert!((8..=16).contains(&n), "{n} leads");
        let types: HashSet<String> = s.book.leads.iter().map(|l| s.gens[l.gen].weapons[l.weapon].item_type.clone()).collect();
        assert!(types.len() >= 3, "weapon types {types:?}");
        let routes: HashSet<usize> = s.book.leads.iter().filter_map(|l| l.route.map(|r| s.gens[l.gen].routes[r])).collect();
        assert!(routes.len() >= 3, "routes {routes:?}");
        for &c in &cands {
            assert!(s.book.leads.iter().any(|l| s.gens[l.gen].ctx == c), "{} has no lead", s.ctx[c].label);
        }
        let w1 = s.slot_of(SlotKind::Weapon1).unwrap();
        for l in &s.book.leads {
            assert!(s.rules.slot_allows(&s.slots[w1].name, s.gens[l.gen].weapons[l.weapon].piece.as_ref().unwrap()), "{}", l.label);
        }
        let st = s.lead_start(0, &root.gear.clone(), 12_000).unwrap();
        let wp = st.gear.pieces[w1].clone().expect("Weapon 1 is empty");
        assert!(wp.unique_name().is_some(), "Weapon 1 is not a unique: {}", wp.label);
        let dps = s.scorer.target_value(&s.scorer.targets[0], &st.vals);
        println!("lead 0 start: {} DPS {dps:.0}", wp.label);
        assert!(dps > 0.0, "DPS 0 after the lead's start");
        let other = s.uniques.iter().find(|u| slot_types(SlotKind::Weapon1).contains(&u.item_type.as_str()) && s.weapon_ok(&u.item_type) && u.label != wp.label).unwrap();
        assert!(s.with_piece(&st.gear, w1, Some(items::unique_piece(other))).is_none(), "the held weapon was swapped");
        let mut t = st.clone();
        s.phase_end.set(s.spent() + 3000);
        s.items_layer(&mut t, true).unwrap();
        s.phase_end.set(u64::MAX);
        // (the same unique in another form, Foulborn or variant, is the held weapon still)
        assert_eq!(t.gear.pieces[w1].as_ref().and_then(|p| p.unique_name().map(String::from)), wp.unique_name().map(String::from), "thorough items moved the held weapon");
    }

    /// The weapon screen runs under the root's settled switches: with Terminus Est ("Gain a Frenzy Charge on Critical
    /// Strike") as the root weapon, a weapon with no charge line is screened with charge use and the bypass on too.
    #[test]
    fn screen_uses_the_roots_switches() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"},{"name":"EHP","metric":"ehp"}],"assume":{"flasks":true,"flaskUptime":"bossing","playMode":"bossing","ailments":true,"charges":true}}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        // (Multistrike: three hits per use keep the root weapon's charges up)
        let st0 = s.initial_state(cands[0], Some((vec![s.main_gem, find_gem("Multistrike").unwrap()], vec![])), None).unwrap();
        let te = s.uniques.iter().find(|u| u.name == "Terminus Est").cloned().unwrap();
        let mut root = s.with_weapon(&st0, &items::unique_piece(&te)).unwrap();
        s.rebase(&mut root).unwrap();
        let x = Arc::new(s.render(&root).unwrap());
        let (_, _, on, _) = s.settle_config(&root, x, root.vals.clone());
        let on: Vec<config::On> = on.into_iter().filter(|o| !o.player).collect();
        let other = s.uniques.iter().find(|u| slot_types(SlotKind::Weapon1).contains(&u.item_type.as_str()) && s.weapon_ok(&u.item_type) && !u.xml.contains("Frenzy") && s.with_weapon(&st0, &items::unique_piece(u)).is_some()).cloned().unwrap();
        let p = items::unique_piece(&other);
        let own = s.render(&s.with_weapon(&st0, &p).unwrap()).unwrap();
        let screened = s.screen_text(&st0, Some(&p), &on, &[]).unwrap();
        println!("{} screened with {:?}", other.name, on.iter().map(|o| &o.key).collect::<Vec<_>>());
        for k in ["useFrenzyCharges", "FlickerStrikeBypassCD"] {
            let x = format!("<Input name=\"{k}\" boolean=\"true\"/>");
            assert!(screened.contains(&x), "{k} not on in the screen");
            if k == "useFrenzyCharges" {
                assert!(!own.contains(&x), "{} has its own charge source", other.name);
            }
        }
    }

    /// A crit two-hand (Atziri's Disfavour: flat physical, no crit of its own) pays only with its crit package. Screened
    /// under the crit route's weapon lines it must beat Rebuke of the Vaal (five elements, pays without crit); under the
    /// fixed sensitivity rows it did not (-6.46 against -5.74; with the package -3.54 against -3.70).
    #[test]
    fn crit_route_screens_weapons_with_their_package() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"},{"name":"EHP","metric":"ehp"}],"items":{"rarities":["normal","magic","rare","unique"],"slotRarities":{"Weapon 1":["unique"]}},"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"bossing","playMode":"bossing","ailments":true,"charges":true}}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        let st0 = s.initial_state(cands[0], None, None).unwrap();
        let opts = s.weapon_opts(&st0).unwrap();
        let piece = |n: &str| opts.iter().find(|o| o.name == n).unwrap().piece.clone().unwrap();
        let mut root = s.with_weapon(&st0, &piece("Rakiata's Dance")).unwrap();
        s.rebase(&mut root).unwrap();
        let on: Vec<config::On> = {
            let x = Arc::new(s.render(&root).unwrap());
            let (_, _, on, _) = s.settle_config(&root, x, root.vals.clone());
            on.into_iter().filter(|o| !o.player).collect()
        };
        let a = AXES.iter().position(|a| a.name == "crit").unwrap();
        let names = ["Atziri's Disfavour", "Rebuke of the Vaal"];
        let texts: Vec<Option<String>> = names
            .iter()
            .map(|n| {
                let p = piece(n);
                let l = s.route_lines(&p, a, AXES[a].commit);
                s.screen_text(&root, Some(&p), &on, &l.iter().map(String::as_str).collect::<Vec<_>>())
            })
            .collect();
        let sc = s.score_texts(texts);
        println!("crit route screen: {:?}", names.iter().zip(&sc).collect::<Vec<_>>());
        assert!(sc[0] > sc[1], "Disfavour {} under Rebuke {}", sc[0], sc[1]);
    }

    /// Every route's screen lines carry accuracy (a player gets it from gear), not only the crit route's.
    #[test]
    fn every_route_screen_has_accuracy() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"}],"wealth":"mid-league"}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let p = items::player_piece(&Arc::new(String::new()));
        for a in 0..AXES.len() {
            if AXES[a].family == super::sens::Family::Defence {
                continue;
            }
            for lines in [AXES[a].commit, AXES[a].pair] {
                if !lines.is_empty() {
                    assert!(s.route_lines(&p, a, lines).iter().any(|l| l.contains("Accuracy Rating")), "{} {:?}", AXES[a].name, lines);
                }
            }
        }
    }

    /// A bleeding lead's context assumes Bleeding and not Poisoned; the plain context is unchanged.
    #[test]
    fn ailments_per_lead() {
        let mut s = flicker();
        let cands = s.candidates().unwrap();
        let st = s.initial_state(cands[0], None, None).unwrap();
        let u = s.uniques.iter().find(|u| slot_types(SlotKind::Weapon1).contains(&u.item_type.as_str()) && s.weapon_ok(&u.item_type)).cloned().unwrap();
        let st = s.with_weapon(&st, &items::unique_piece(&u)).unwrap();
        let x = s.render_with_probe(&st, &["100% chance to cause Bleeding on Hit"]).unwrap();
        let m = s.ailment_mask(&x).unwrap();
        assert!(m & 4 != 0 && m & 1 == 0, "mask {m}");
        let (c, a) = (s.ctx[cands[0]].class_id, s.ctx[cands[0]].asc_id);
        let ci = s.class_ctx_with(c, a, m).unwrap();
        assert!(s.ctx[ci].xml.contains(r#"name="conditionEnemyBleeding" boolean="true""#), "bleeding not assumed");
        assert!(!s.ctx[ci].xml.contains(r#"name="conditionEnemyPoisoned" boolean="true""#), "poisoned assumed");
        assert!(!s.ctx[cands[0]].xml.contains(r#"name="conditionEnemyBleeding" boolean="true""#), "the plain context changed");
    }

    /// Routes from game data: minion damage that also affects you (Spiritual Aid, The Scourge) is a joint axis
    /// scaled by the data's minion damage rolls, and crit chance with multiplier is one joint route.
    #[test]
    fn transfer_and_crit_routes() {
        let a = AXES.iter().find(|a| a.name == "Increases and Reductions to Minion Damage also affect you").expect("no minion damage transfer axis");
        assert!(a.pair.len() == 1 && a.pair[0].starts_with("Minions deal ") && a.commit.contains(&a.name), "{:?}", a.commit);
        assert!(AXES.iter().any(|a| a.name.starts_with("Increases and Reductions to Minion Attack Speed")), "no attack speed transfer");
        let c = AXES.iter().find(|a| a.name == "crit").expect("no crit route");
        assert!(c.route && c.pair == ["+150% to Critical Strike Multiplier"]);
    }

    /// Route rows: defence takes none however much it pays; crit and minion transfer each keep a row pair next to a
    /// conversion route and a stacking scaler; the ailment route (chance with its damage-over-time multipliers) is joint.
    #[test]
    fn lead_rows_reserve_joint_families() {
        use super::super::sens::{Family, Sens};
        let find = |f: Family| AXES.iter().position(|a| a.family == f && (f == Family::Defence || !a.pair.is_empty())).unwrap_or_else(|| panic!("no {f:?} axis"));
        let (def, crit, tr, st, conv, ail) = (find(Family::Defence), find(Family::Crit), find(Family::Transfer), find(Family::Stacking), find(Family::Conversion), find(Family::Ailment));
        let plain = AXES.iter().position(|a| a.name == "increased damage").unwrap();
        assert!(AXES[ail].commit.iter().any(|l| l.contains("chance to")) && AXES[ail].pair.iter().all(|l| !l.contains("chance to")) && AXES[ail].route, "{}", AXES[ail].name);
        let axes = vec![def, plain, conv, st, crit, tr, ail];
        let sens = Sens { base: 0.0, axes: axes.clone(), marginal: vec![0.1; 7], committed: vec![9.0, 2.0, 1.0, 1.0, 0.3, 0.2, 0.1], synergy: vec![0.0, 0.0, 0.9, 0.8, 0.1, 0.05, 0.04], xml_ms: 0.0 };
        let rows: Vec<usize> = lead_rows(&sens, 6).into_iter().map(|r| r.0).collect();
        println!("rows {:?}", rows.iter().map(|&i| AXES[i].name).collect::<Vec<_>>());
        assert!(!rows.contains(&def), "defence took a row");
        for i in [crit, tr, ail, conv, st] {
            assert_eq!(rows.iter().filter(|&&r| r == i).count(), 2, "{} has no row pair", AXES[i].name);
        }
        assert!(rows.contains(&plain));
    }

    /// Pairs cover every context, several routes and weapon types, with no (context, weapon) twice and the caps held.
    #[test]
    fn pairs_cover_contexts_and_caps() {
        let gs = vec![
            cg(&["Claw", "Axe", "Sword", "Claw"], &[1, 2], vec![vec![0.9, 0.1, 0.3, 0.8], vec![0.1, 0.7, 0.6, 0.0]], vec![2.0, 1.0], vec![0.1, 0.0, 0.2, 0.3]),
            cg(&["Claw", "Axe", "Sword", "Claw"], &[2, 3], vec![vec![0.2, 0.9, 0.1, 0.0], vec![0.5, 0.4, 0.3, 0.2]], vec![3.0, 1.0], vec![0.0, 0.4, 0.0, 0.1]),
        ];
        let p = pair_leads(&gs, None, 16, 8);
        assert!(p.len() >= 4 && p.len() <= 16, "{p:?}");
        // one dual-wield variant, of a one-hand weapon already among the pairs
        let d: Vec<_> = p.iter().filter(|x| x.3).collect();
        assert_eq!(d.len(), 1, "{p:?}");
        assert!(gs[d[0].0].weapons[d[0].1].dual_ok && p.iter().any(|x| !x.3 && (x.0, x.1, x.2) == (d[0].0, d[0].1, d[0].2)), "{p:?}");
        let p: Vec<(usize, usize, Option<usize>)> = p.into_iter().filter(|x| !x.3).map(|x| (x.0, x.1, x.2)).collect();
        assert!(p.iter().any(|x| x.0 == 0) && p.iter().any(|x| x.0 == 1));
        for (i, a) in p.iter().enumerate() {
            assert!(!p[i + 1..].iter().any(|b| b.0 == a.0 && b.1 == a.1), "{p:?}");
        }
        let axes: Vec<Option<usize>> = p.iter().map(|x| x.2.map(|r| gs[x.0].routes[r])).collect();
        for a in &axes {
            assert!(axes.iter().filter(|b| *b == a).count() <= 3);
        }
        assert!(axes.iter().flatten().collect::<HashSet<_>>().len() >= 3, "{p:?}");
        // full with one pair per context: the dual variant never takes a context's only pair
        let p = pair_leads(&gs, None, 2, 2);
        assert!(p.iter().any(|x| x.0 == 0 && !x.3) && p.iter().any(|x| x.0 == 1 && !x.3), "{p:?}");
    }
}

/// A lead's label as worn: "Foulborn <name> [...]" reads "<name>" when the gear wears that unique only in its plain
/// form (a Foulborn lead may take the plain unique back, and the label must name the item exported).
pub(super) fn worn_label(label: &str, g: &super::items::Gear) -> String {
    let worn = |name: &str, foul: bool| g.pieces.iter().flatten().any(|p| p.unique_name() == Some(name) && p.label.starts_with("Foulborn ") == foul);
    label
        .split(" · ")
        .map(|seg| {
            let (pre, rest) = seg.strip_prefix("2x ").map_or(("", seg), |r| ("2x ", r));
            match rest.strip_prefix("Foulborn ").map(|r| r.split(" [").next().unwrap_or(r)) {
                Some(name) if worn(name, false) && !worn(name, true) => format!("{pre}{name}"),
                _ => seg.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(" · ")
}
