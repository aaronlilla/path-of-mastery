//! Finish pass for the free basics a player fills in himself (solver_checklist.rs): a movement skill, a guard skill and
//! a pantheon. Each is found from game data by class (gem tags, the pantheon table), never by name, and tried as one
//! step: kept only when the limits do not get worse. What cannot be filled leaves a note ("no free socket") that the
//! result's checklist shows next to the missing item.

use super::*;
use std::collections::HashMap as StdMap;
use std::hash::{Hash, Hasher};

type Notes = Vec<(String, String)>;

static NOTES: Mutex<Option<StdMap<u64, Notes>>> = Mutex::new(None);

fn key(xml: &str) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    xml.hash(&mut h);
    h.finish()
}

/// Remembers why the basics of the build text `xml` that are still missing could not be filled.
pub(super) fn remember(xml: &str, notes: Notes) {
    if !notes.is_empty() {
        NOTES.lock().unwrap().get_or_insert_with(Default::default).insert(key(xml), notes);
    }
}

/// The reason the pass could not fill checklist item `id` of the build text `xml`.
pub(super) fn note_for(xml: &str, id: &str) -> Option<String> {
    NOTES.lock().unwrap().as_ref()?.get(&key(xml))?.iter().find(|(i, _)| i == id).map(|(_, w)| w.clone())
}

/// How far the checklist is from met: hard items count most.
fn badness(checks: &[Value]) -> f64 {
    checks.iter().filter(|c| c["status"] == "unmet").map(|c| match c["level"].as_str() {
        Some("hard") => 100.0,
        Some("soft") => 1.0,
        _ => 0.3,
    }).sum()
}

fn god_of(xml: &str, attr: &str) -> String {
    let k = format!("{attr}=\"");
    xml.find(&k).map(|i| xml[i + k.len()..].split('"').next().unwrap_or("None").to_string()).unwrap_or_else(|| "None".into())
}

impl Solver {
    /// `st` with a movement and a guard skill added when the checklist wants them and they fit; the notes say why not.
    pub(super) fn fill_basics(&mut self, st: &State) -> Result<(Option<State>, Notes), String> {
        let mut notes = Notes::new();
        if self.goal.wealth.is_none() || self.cancel.load(Ordering::Relaxed) {
            return Ok((None, notes));
        }
        let mut cur: Option<State> = None;
        for (id, kind) in [("movement-skill", Kind::Movement), ("guard-skill", Kind::Guard)] {
            let s = cur.as_ref().unwrap_or(st);
            // (the main skill counts: Flicker Strike is a movement skill)
            if !checklist::wants(&self.goal, id) || s.main.iter().chain(s.utils.iter()).any(|u| (kind == Kind::Movement && self.moves(u)) || self.gems.iter().any(|g| g.id == util_root(u) && g.kind == kind)) {
                continue;
            }
            match self.add_utility(s, kind)? {
                Ok(n) => cur = Some(n),
                Err(why) => notes.push((id.to_string(), why)),
            }
        }
        // Fortify for a melee build: a support whose granted effect names fortify, when nothing else (tree, item,
        // ascendancy) already gives the stacks. Static reasons for the basics no pass fills (they stay on the chip).
        let s = cur.as_ref().unwrap_or(st);
        let own = self.names.iter().position(|n| n == "FortificationStacks").map_or(0.0, |k| Scorer::get(&s.vals, k));
        if checklist::wants(&self.goal, "fortify") && own < 20.0 {
            match self.add_support(s, "fortify")? {
                Ok(n) => cur = Some(n),
                Err(why) => notes.push(("fortify".to_string(), why)),
            }
        }
        for (id, why) in [("life-sustain", "no leech, regeneration or recovery flask on this build"), ("stun-avoid", "no free source (the pantheon was tried)")] {
            notes.push((id.to_string(), why.to_string()));
        }
        Ok((cur, notes))
    }

    /// The best state with one more support (or one swapped in for the last non-required one when all links are full)
    /// whose granted effect carries a stat or constant stat naming `needle`, or why none fits. Kept only when the limits
    /// do not get worse and the score stays within 10%.
    pub(super) fn add_support(&self, st: &State, needle: &str) -> Result<Result<State, String>, String> {
        let grants = |id: &str| {
            let Some(ge) = gd::game_data().gems.get(id).and_then(gd::gem_primary_effect) else { return false };
            ge.stats.iter().any(|s| s.contains(needle))
                || ge.extra.get("constantStats").and_then(|c| c.as_array()).is_some_and(|a| a.iter().any(|p| p.get(0).and_then(|n| n.as_str()).is_some_and(|n| n.contains(needle))))
        };
        let ids: Vec<&'static str> = self.gems.iter().filter(|g| g.kind == Kind::Support && !st.main.contains(&g.id) && grants(g.id) && support_fits(g.id, self.main_gem)).map(|g| g.id).collect();
        if ids.is_empty() {
            return Ok(Err("no such support for this skill".into()));
        }
        let (mut states, mut texts) = (vec![st.clone()], vec![Cand::Xml(Arc::new(self.render(st)?))]);
        let mut no_socket = 0;
        let mut over = 0;
        for m in ids {
            let mut variants: Vec<Vec<&'static str>> = Vec::new();
            if st.main.len() < 6 {
                variants.push(st.main.iter().copied().chain(std::iter::once(m)).collect());
            } else if let Some(i) = (1..st.main.len()).rev().find(|&i| !self.required.contains(&st.main[i])) {
                let mut v = st.main.clone();
                v[i] = m;
                variants.push(v);
            }
            for main in variants {
                let mut s = st.clone();
                s.main = main;
                self.price_gems(&mut s);
                if self.mana_clash(&s.main) || !self.sockets_ok(&s.gear, Some(&st.gear)) {
                    no_socket += 1;
                    continue;
                }
                // (the wealth budget covers the link and gem cost too)
                if !self.affordable(&s.gear, Some(&st.gear)) {
                    over += 1;
                    continue;
                }
                texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
                states.push(s);
            }
        }
        if states.len() == 1 {
            return Ok(Err(if no_socket > 0 { "no free link or socket" } else if over > 0 { "over budget" } else { "none available" }.into()));
        }
        let r = self.pool.eval(texts, &self.names, &self.cancel);
        let Some(Some(base)) = r.first() else { return Ok(Err("not measured".into())) };
        let (base_s, base_viol) = self.score(base);
        let mut best: Option<(f64, usize)> = None;
        let mut cost = false;
        let mut broke: Option<String> = None;
        for (i, v) in r.iter().enumerate().skip(1) {
            let Some(v) = v else { continue };
            let (s, viol) = self.score(v);
            if viol > base_viol + EPS {
                if broke.is_none() {
                    let (db, dv) = (self.scorer.deficits(base), self.scorer.deficits(v));
                    broke = (0..dv.len()).find(|&k| dv[k] > db[k] + EPS).map(|k| self.scorer.limits[k].name.clone());
                }
                continue;
            }
            if s < base_s - 0.1 * base_s.abs() {
                cost = true;
                continue;
            }
            if best.is_none_or(|b| s > b.0) {
                best = Some((s, i));
            }
        }
        Ok(match best {
            Some((_, i)) => Ok(states.swap_remove(i)),
            None if cost => Err("costs over 10% of the score".into()),
            None => Err(format!("would break a limit: {}", broke.unwrap_or_default())),
        })
    }

    /// The best state with one more utility gem of `kind`, or why none fits.
    pub(super) fn add_utility(&self, st: &State, kind: Kind) -> Result<Result<State, String>, String> {
        let (mut states, mut texts) = (vec![st.clone()], vec![Cand::Xml(Arc::new(self.render(st)?))]);
        let mut no_socket = 0;
        let mut over = 0;
        let ids: Vec<&'static str> = self.gems.iter().filter(|g| g.kind == kind).map(|g| g.id).collect();
        if ids.is_empty() {
            return Ok(Err("no such skill for this level".into()));
        }
        // (no gem for a skill the gear grants, no second banner, no press past the play mode's cap)
        let granted = granted_skills(&st.gear);
        if ids.iter().all(|m| self.pressed(m)) && self.presses(st) >= self.press_cap() {
            return Ok(Err("every button is taken".into()));
        }
        for m in ids {
            let mut s = st.clone();
            s.utils.push(m);
            if !utils_ok(&s.utils, &granted) {
                continue;
            }
            self.price_gems(&mut s);
            if !self.sockets_ok(&s.gear, Some(&st.gear)) {
                no_socket += 1;
                continue;
            }
            if !self.affordable(&s.gear, Some(&st.gear)) {
                over += 1;
                continue;
            }
            texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
            states.push(s);
        }
        if states.len() == 1 {
            return Ok(Err(if no_socket > 0 { "no free socket" } else if over > 0 { "over budget" } else { "none available" }.into()));
        }
        let r = self.pool.eval(texts, &self.names, &self.cancel);
        let Some(Some(base)) = r.first() else { return Ok(Err("not measured".into())) };
        let base_viol = self.score(base).1;
        let mut best: Option<(f64, usize)> = None;
        for (i, v) in r.iter().enumerate().skip(1) {
            let Some(v) = v else { continue };
            let (s, viol) = self.score(v);
            if viol <= base_viol + EPS && best.is_none_or(|b| s > b.0) {
                best = Some((s, i));
            }
        }
        Ok(match best {
            Some((_, i)) => Ok(states.swap_remove(i)),
            None => Err("costs more than it is worth here".into()),
        })
    }

    /// The build text with the pantheon gods that fix the most of what the checklist misses (free: kept when the
    /// limits do not get worse and the checklist or the score improves), from the game's own god table. A god the
    /// build already set stays.
    pub(super) fn fill_pantheon(&self, xml: String, main: &[String], utils: &[String]) -> Result<(String, Notes), String> {
        let mut notes = Notes::new();
        let none = |g: &str| g == "None";
        let (major, minor) = (god_of(&xml, "pantheonMajorGod"), god_of(&xml, "pantheonMinorGod"));
        if self.goal.wealth.is_none() || !checklist::wants(&self.goal, "pantheon") || (!none(&major) && !none(&minor)) || self.cancel.load(Ordering::Relaxed) {
            return Ok((xml, notes));
        }
        let Ok(Some(table)) = pom_calc::data::game_data().extra.get("pantheons") else { return Ok((xml, notes)) };
        let gods: Vec<(String, bool)> = table.as_object().map(|o| o.iter().map(|(k, v)| (k.to_string(), v.get("isMajorGod").and_then(|b| b.as_bool()).unwrap_or(false))).collect()).unwrap_or_default();
        let with = |maj: &str, min: &str| -> Result<String, String> { set_tag_attr(&set_tag_attr(&xml, "Build", "pantheonMajorGod", maj)?, "Build", "pantheonMinorGod", min) };
        // The better of the candidates (index 0 is the build as it is): fewer unmet items, then a higher score; never a new shortfall.
        let pick = |cands: Vec<String>| -> Result<Option<usize>, String> {
            let r = self.pool.eval(cands.iter().map(|x| Cand::Xml(Arc::new(x.clone()))).collect(), &self.names, &self.cancel);
            let rate = |i: usize| -> Option<(f64, f64, f64)> {
                let v = r.get(i)?.as_ref()?;
                let (s, viol) = self.score(v);
                Some((viol, badness(&self.checks_for(v, main, utils, &cands[i])), s))
            };
            let Some(base) = rate(0) else { return Ok(None) };
            let mut best = (base, 0usize);
            for i in 1..cands.len() {
                let Some(c) = rate(i) else { continue };
                let better = c.0 <= base.0 + EPS && (c.1 < best.0 .1 - 1e-9 || ((c.1 - best.0 .1).abs() < 1e-9 && c.2 > best.0 .2 + EPS));
                if better {
                    best = (c, i);
                }
            }
            Ok((best.1 > 0).then_some(best.1))
        };
        let (mut major, mut minor) = (major, minor);
        if none(&major) {
            let c: Vec<String> = std::iter::once(Ok(xml.clone())).chain(gods.iter().filter(|g| g.1).map(|g| with(&g.0, &minor))).collect::<Result<_, String>>()?;
            if let Some(i) = pick(c)? {
                major = gods.iter().filter(|g| g.1).nth(i - 1).map(|g| g.0.clone()).unwrap_or(major);
            }
        }
        if none(&minor) {
            let xml_now = with(&major, &minor)?;
            let c: Vec<String> = std::iter::once(Ok(xml_now.clone())).chain(gods.iter().filter(|g| !g.1).map(|g| with(&major, &g.0))).collect::<Result<_, String>>()?;
            match pick(c)? {
                Some(i) => minor = gods.iter().filter(|g| !g.1).nth(i - 1).map(|g| g.0.clone()).unwrap_or(minor),
                // A minor god is free and every player takes one: when none moves the score or the checklist, the one
                // that guards against the most ailments nothing else on the build covers (the engine values none of
                // them: shock, blind, maim on you).
                None => {
                    let lines = |g: &str| -> Vec<String> {
                        let souls = table.get(g).and_then(|v| v.get("souls")).and_then(|s| s.as_array());
                        souls.iter().flat_map(|a| a.iter()).filter_map(|s| s.get("mods").and_then(|m| m.as_array())).flat_map(|a| a.iter().collect::<Vec<_>>()).filter_map(|m| m.get("line").and_then(|l| l.as_str()).map(String::from)).collect()
                    };
                    let have: Vec<String> = xml_now.lines().map(String::from).chain(lines(&major)).collect();
                    let open: Vec<&str> = items::SELF_AILMENTS.iter().map(|(a, _)| *a).filter(|a| !have.iter().any(|l| items::line_eases(l, a))).collect();
                    let covered = |g: &str| open.iter().filter(|a| lines(g).iter().any(|l| items::line_eases(l, a))).count();
                    // (nothing left open: still one, the first in the table)
                    if let Some(g) = gods.iter().filter(|g| !g.1).map(|g| (covered(&g.0), &g.0)).fold(None, |b: Option<(usize, &String)>, c| if b.is_none_or(|b| c.0 > b.0) { Some(c) } else { b }) {
                        minor = g.1.clone();
                    }
                }
            }
        }
        if none(&major) && none(&minor) {
            notes.push(("pantheon".into(), "no god helps this build".into()));
        }
        Ok((with(&major, &minor)?, notes))
    }
}

/// Strength, Dexterity or Intelligence a node gives when that is all it does ("+10 to Strength", "+10 to Strength and
/// Dexterity"), read from its stat text; None for any other node.
pub(super) fn attr_node(text: &str) -> Option<[f64; 3]> {
    let mut a = [0.0; 3];
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let (n, rest) = line.trim().strip_prefix('+')?.split_once(" to ")?;
        let n: f64 = n.parse().ok()?;
        for w in rest.split(" and ") {
            a[["strength", "dexterity", "intelligence"].iter().position(|x| *x == w.trim())?] += n;
        }
    }
    (a.iter().sum::<f64>() > 0.0).then_some(a)
}

/// Attribute left over after a node's give-back that the build keeps above what its gems and items need.
const ATTR_MARGIN: f64 = 25.0;
/// Score a pruned point may cost (a ten-point attribute node is worth a hair of life or damage).
const PRUNE_COST: f64 = 5e-4;

impl Solver {
    /// Small attribute nodes beyond what gems and items need (plus `ATTR_MARGIN`) go back, one leaf at a time, and the
    /// points they free are spent again. The tree refine keeps them when no regrown point beats the hair of life and
    /// damage the attribute gives.
    pub(super) fn attr_prune(&mut self, st: &mut State) -> Result<bool, String> {
        if !self.goal.limits.attributes {
            return Ok(false);
        }
        let at = |n: &str| self.names.iter().position(|x| x == n);
        let (have, need) = (["Str", "Dex", "Int"].map(at), ["ReqStr", "ReqDex", "ReqInt"].map(at));
        let mut improved = false;
        for _ in 0..60 {
            if self.stop() {
                break;
            }
            let spare = |v: &Vals, k: usize| -> f64 { have[k].map_or(0.0, |i| Scorer::get(v, i)) - need[k].map_or(0.0, |i| Scorer::get(v, i)) };
            let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = self
                .removal_groups(st, false, 1)
                .into_iter()
                .filter(|g| self.attr_node(g[0]).is_some_and(|a| (0..3).all(|k| a[k] == 0.0 || spare(&st.vals, k) - a[k] >= ATTR_MARGIN)))
                .map(|g| (Self::without(st, &g).nodes, None))
                .collect();
            if cands.is_empty() {
                break;
            }
            let r = self.eval_nodes(st, &cands);
            let best = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().filter(|v| v.1 <= st.viol + EPS && v.0 >= st.score - PRUNE_COST).map(|v| (v.0, i))).max_by(|a, b| a.0.total_cmp(&b.0));
            let Some((_, i)) = best else { break };
            let (s, viol, v) = r[i].clone().unwrap();
            st.nodes = cands[i].0.clone();
            st.score = s;
            st.viol = viol;
            st.vals = v;
            improved = true;
        }
        // Then chains of attribute nodes the build can spare are weighed against the best other point: Str and Int add
        // melee damage and mana, so the leaf test above keeps them, but a regrown build that scores what this one had
        // less a hair, with fewer attribute nodes, wins.
        let mut swapped = false;
        for _ in 0..15 {
            if self.stop() {
                break;
            }
            let spare = |v: &Vals, k: usize| -> f64 { have[k].map_or(0.0, |i| Scorer::get(v, i)) - need[k].map_or(0.0, |i| Scorer::get(v, i)) };
            // Chains of attribute nodes (up to 6) with nothing but attribute nodes behind them, whose attributes the build
            // can spare; and a spare attribute node on the way to other nodes (up to 10 together): those are regrown with
            // that node barred, so a route of other nodes wins when one costs no more.
            let groups: Vec<(Vec<i64>, Option<i64>)> = self
                .removal_groups(st, false, 10)
                .into_iter()
                .filter_map(|g| {
                    let a: Vec<[f64; 3]> = g.iter().filter_map(|&n| self.attr_node(n)).collect();
                    let sum = |k: usize| a.iter().map(|x| x[k]).sum::<f64>();
                    let root = if a.len() == g.len() { (g.len() <= 6).then_some(None)? } else { Some(self.attr_root(st, &g)?) };
                    (0..3).all(|k| sum(k) == 0.0 || spare(&st.vals, k) - sum(k) >= ATTR_MARGIN).then_some((g, root))
                })
                .collect();
            if groups.is_empty() {
                break;
            }
            let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(st, &g.0).nodes, None)).collect();
            let r = self.eval_nodes(st, &cands);
            // The cheapest per node go back and the freed points are spent again; the best of the regrown builds is kept
            // when it scores what the build had, less a hair.
            let mut order: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().filter(|v| v.1 <= st.viol + EPS).map(|v| ((st.score - v.0) / groups[i].0.len() as f64, i))).collect();
            order.sort_by(|a, b| a.0.total_cmp(&b.0));
            let n0 = st.nodes.iter().filter(|&&n| self.attr_node(n).is_some()).count();
            let mut best: Option<State> = None;
            for &(_, i) in order.iter().take(6) {
                if self.stop() {
                    break;
                }
                let (s0, viol0, v0) = r[i].clone().unwrap();
                let mut t = Self::without(st, &groups[i].0);
                (t.score, t.viol, t.vals) = (s0, viol0, v0);
                let bar = groups[i].1.filter(|x| self.banned.borrow_mut().insert(*x));
                let grown = self.grow(&mut t, false);
                if let Some(x) = bar {
                    self.banned.borrow_mut().remove(&x);
                }
                grown?;
                let n1 = t.nodes.iter().filter(|&&n| self.attr_node(n).is_some()).count();
                if t.viol <= st.viol + EPS && t.score >= st.score - PRUNE_COST && n1 < n0 && best.as_ref().is_none_or(|b| t.score > b.score) {
                    best = Some(t);
                }
            }
            let Some(t) = best else { break };
            *st = t;
            swapped = true;
        }
        improved |= swapped;
        if improved {
            self.rebase(st)?;
            self.grow(st, false)?;
        }
        Ok(improved)
    }

    pub(super) fn attr_node(&self, id: i64) -> Option<[f64; 3]> {
        attr_node(&self.node_info(id).1)
    }

    /// The attribute node of a removal group whose own removal strands the rest of it (the way in).
    fn attr_root(&self, st: &State, g: &[i64]) -> Option<i64> {
        let c = &self.ctx[st.class];
        let set: HashSet<i64> = st.nodes.iter().copied().filter(|&n| c.is_main(n) || c.is_asc(n)).collect();
        g.iter().copied().filter(|&x| self.attr_node(x).is_some()).find(|&x| {
            let mut s = set.clone();
            s.remove(&x);
            let conn = c.connected(&s, false);
            let mut d: Vec<i64> = st.nodes.iter().copied().filter(|&n| c.is_main(n) && (n == x || !conn.contains(&n))).collect();
            d.sort_unstable();
            d == g
        })
    }

    /// An aura that adds nothing to the score (the resistance it gave is capped without it, the mana it reserves buys
    /// nothing) goes back, one at a time; the free reservation is then offered to the next aura that does pay.
    pub(super) fn dead_aura_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let mut dropped = false;
        while !self.stop() {
            let mut states = Vec::new();
            let mut texts = Vec::new();
            for i in (0..st.utils.len()).filter(|&i| !self.required.contains(&st.utils[i]) && self.gems.iter().any(|g| g.id == util_root(st.utils[i]) && g.kind == Kind::Aura)) {
                let mut s = st.clone();
                s.utils.remove(i);
                self.price_gems(&mut s);
                texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
                states.push(s);
            }
            if states.is_empty() {
                break;
            }
            let r = self.eval(texts.clone());
            let mut best: Option<(f64, usize, f64)> = None;
            for (i, v) in r.iter().enumerate() {
                let Some(v) = v else { continue };
                let (s, viol) = self.score(v);
                if viol <= st.viol + EPS && s >= st.score - EPS && best.is_none_or(|b| s > b.0) {
                    best = Some((s, i, viol));
                }
            }
            let Some((s, i, viol)) = best else { break };
            let mut n = states.swap_remove(i);
            if let Cand::Xml(x) = &texts[i] {
                n.base = x.clone();
            }
            n.score = s;
            n.viol = viol;
            n.vals = r[i].clone().unwrap();
            self.settle(&mut n);
            *st = n;
            dropped = true;
        }
        if dropped && !self.stop() {
            self.gem_layer(st, false)?;
        }
        Ok(dropped)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Sustain: a lead or a support that fails the life or mana limit is paid for first (the gems `cost_fixers` finds by
// what they grant, regeneration and resistances on the tree and gear), the way a player keeps Efficacy or Righteous Fire
// and buys the upkeep. It is turned down only when that costs more than it gains.

impl Solver {
    /// One sustain gem for the failed limits, at the current penalty: a sustain aura added or in place of another
    /// utility skill, a cost support added or in place of a support the goal does not require. Kept when it scores.
    pub(super) fn sustain_gems(&self, st: &mut State) -> Result<bool, String> {
        let mut setups = Vec::new();
        for &u in self.fixers.1.iter().filter(|u| !st.utils.iter().any(|x| util_root(x) == **u)) {
            setups.push((st.main.clone(), st.utils.iter().copied().chain([u]).collect()));
            for i in (0..st.utils.len()).filter(|&i| !self.required.contains(&st.utils[i])) {
                let mut v = st.utils.clone();
                v[i] = u;
                setups.push((st.main.clone(), v));
            }
        }
        for &f in self.fixers.0.iter().filter(|f| !st.main.contains(f)) {
            if st.main.len() < 6 {
                setups.push((st.main.iter().copied().chain([f]).collect(), st.utils.clone()));
            }
            for i in (1..st.main.len()).filter(|&i| !self.required.contains(&st.main[i])) {
                let mut m = st.main.clone();
                m[i] = f;
                setups.push((m, st.utils.clone()));
            }
        }
        Ok(match self.try_setups_plain(st, setups)? {
            Some(n) => {
                *st = n;
                true
            }
            None => false,
        })
    }

    /// The best setup the gem layer turned down for its cost alone (no cost fixer saved it) gets the sustain bought:
    /// the limit repair (sustain gems, gear, tree) at a heavier penalty. Kept when the paid-for build beats `st`.
    pub(super) fn sustain_buy(&mut self, st: &mut State) -> Result<bool, String> {
        let Some((free, b)) = self.blocked.borrow_mut().take() else { return Ok(false) };
        let mut key: Vec<&'static str> = b.main.iter().chain(b.utils.iter()).copied().collect();
        key.sort_unstable();
        // (worth the repair only when the cost-free gain is real: 2% of the score)
        if free < st.score + 0.02 || self.stop() || !self.sustain_tried.borrow_mut().insert(key) {
            return Ok(false);
        }
        let s = self.sustain_paid(st, &b)?;
        if s.score > st.score + EPS && s.viol <= st.viol + EPS {
            *st = s;
            return Ok(true);
        }
        Ok(false)
    }

    /// `st` with the gems of setup `b` and the sustain they need bought: the limit repair (sustain gems, gear, tree) at
    /// 10x penalty, the gems being paid for held in place.
    pub(super) fn sustain_paid(&mut self, st: &State, b: &State) -> Result<State, String> {
        let mut s = st.clone();
        let new: Vec<&'static str> = b.main.iter().chain(b.utils.iter()).copied().filter(|g| !st.main.contains(g) && !st.utils.contains(g)).collect();
        (s.main, s.utils) = (b.main.clone(), b.utils.clone());
        self.rebase(&mut s)?;
        let (layer, n) = (self.layer.clone(), self.required.len());
        self.required.extend(new);
        let r = self.repair_limits_with(&mut s, &[10.0], false);
        self.required.truncate(n);
        self.layer = layer;
        r.map(|_| s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pom_engine::cjson::J;

    /// The pantheon fill on a real result with the gods taken off: it picks gods (or says none helps) and the build text
    /// keeps its limits.
    #[test]
    fn pantheon_fill_picks_gods_for_a_build_without() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"mapping","playMode":"mapping"}}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let xml = std::fs::read_to_string(format!("{}/testdata/finish-flicker.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let xml = set_tag_attr(&set_tag_attr(&xml, "Build", "pantheonMajorGod", "None").unwrap(), "Build", "pantheonMinorGod", "None").unwrap();
        let (out, notes) = s.fill_pantheon(xml, &["Flicker Strike".to_string()], &[]).unwrap();
        let (maj, min) = (god_of(&out, "pantheonMajorGod"), god_of(&out, "pantheonMinorGod"));
        println!("picked {maj} / {min}, notes {notes:?}");
        assert!(maj != "None" || min != "None" || !notes.is_empty(), "either gods were set or the pass says why not");
    }

    /// The Fortify fill: a melee skill with a free link gets the support whose granted effect names fortify (found from
    /// the gem's stats, not its name); a build that already has 20 stacks gets nothing.
    #[test]
    fn fortify_fill_adds_the_fortify_support() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"limits":{"attributes":false},"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"mapping","playMode":"mapping"}}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let c = s.candidates().unwrap();
        let st = s.initial_state(c[0], Some((vec![s.main_gem], vec![])), None).unwrap();
        let got = s.add_support(&st, "fortify").unwrap();
        let fortify = find_gem("Fortify").unwrap();
        println!("fortify fill: {:?}", got.as_ref().map(|n| n.main.clone()));
        assert!(got.is_ok_and(|n| n.main.contains(&fortify)), "Fortify support was added");
    }

    /// The solver opened on a testdata result for `skill` and `asc`, the fixture's tree, gear and gems (`main`, `utils`) as a state.
    fn open_result(file: &str, skill: &str, asc: &str, main: &[&str], utils: &[&str]) -> (Solver, State) {
        let goal: Goal = serde_json::from_str(&format!(r#"{{"skill":"{skill}","level":90,"wealth":"league-start","targets":[{{"name":"DPS","metric":"combined"}}],"assume":{{"playMode":"mapping"}},"ascendancy":"{asc}"}}"#)).unwrap();
        let xml = std::fs::read_to_string(format!("{}/testdata/{file}", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":3600000,"threads":2}"#).unwrap();
        let mut s = Solver::new(xml, goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let ci = s.candidates().unwrap()[0];
        let ids = |v: &[&str]| v.iter().map(|n| find_gem(n).unwrap_or_else(|| panic!("no gem {n}"))).collect::<Vec<_>>();
        let st = s.initial_state(ci, Some((ids(main), ids(utils))), None).unwrap();
        (s, st)
    }

    fn deficit(s: &Solver, st: &State, name: &str) -> f64 {
        let i = s.scorer.limits.iter().position(|l| l.name == name).unwrap_or_else(|| panic!("no limit {name}"));
        s.scorer.deficits(&st.vals)[i]
    }

    /// Righteous Fire under Chaos Inoculation (1 life, 1 unreserved): its burn, damage and spell buff need 2 unreserved
    /// life, so it does nothing though the sheet read 33k. Found from the skill's own
    /// stat-threshold mods: the limit fails it and it never becomes a result; the Inquisitor with life passes.
    #[test]
    fn main_skill_switched_off_by_its_own_threshold() {
        let rf = ["Righteous Fire", "Burning Damage", "Elemental Focus", "Concentrated Effect"];
        for (file, asc, off) in [("rf-ci-reliquarian.xml", "Reliquarian", true), ("rf-inquisitor.xml", "Inquisitor", false)] {
            let (s, st) = open_result(file, "Righteous Fire", asc, &rf, &[]);
            let d = deficit(&s, &st, MAIN_ON);
            println!("{asc}: life {} main-skill shortfall {d}", Scorer::get(&st.vals, s.names.iter().position(|n| n == "Life").unwrap()));
            assert_eq!(d > 0.0, off, "{asc}");
            assert_eq!(s.main_off(&st.vals), off, "{asc}");
        }
    }

    /// Efficacy on Essence Drain (an Occultist with Inspiration already linked): +20.7% DPS but mana went
    /// 96 -> 178/s, so the gem layer dropped it unpaid. Now the sustain is bought first (sustain gems found by their
    /// stats, gear, tree): Efficacy stays and mana is met; `sustain_buy` then keeps it only if that build scores higher.
    #[test]
    fn mana_short_support_gets_its_sustain_bought() {
        let main = ["Essence Drain", "Void Manipulation", "Swift Affliction", "Controlled Destruction", "Cull the Weak", "Inspiration"];
        let utils = ["Purity of Elements", "Purity of Lightning", "Despair", "Summon Lightning Golem", "Phase Run"];
        let (mut s, mut st) = open_result("ed-occultist.xml", "Essence Drain", "Occultist", &main, &utils);
        let names = |g: &[&'static str]| g.iter().map(|g| gem_name(g)).collect::<Vec<_>>();
        println!("fixers {:?} {:?}", names(&s.fixers.0), names(&s.fixers.1));
        let mana = "Mana cost sustainable";
        // (re-rendered, the fixture is a little short: its own sustain repaired first, so only Efficacy breaks it)
        s.repair_limits_with(&mut st, &[10.0], true).unwrap();
        assert!(deficit(&s, &st, mana) <= 1e-9, "the fixture meets mana");
        let eff = find_gem("Efficacy").unwrap();
        // (Efficacy in Inspiration's link: worth about +20% with the cost paid, but the mana breaks, as in the solve)
        let insp = st.main.iter().position(|g| *g == find_gem("Inspiration").unwrap()).expect("Inspiration linked");
        let mut with = st.main.clone();
        with[insp] = eff;
        let mut e = st.clone();
        e.main = with;
        s.rebase(&mut e).unwrap();
        let free = s.scorer.score_cost_free(&e.vals, &s.weights);
        println!("Efficacy: score {:.3} (free {free:.3}) vs {:.3}, mana shortfall {:.3}", e.score, st.score, deficit(&s, &e, mana));
        assert!(deficit(&s, &e, mana) > 0.0 && e.score < st.score && free > st.score + 0.02, "Efficacy is not held back by mana alone");
        // (what the gem layer does with a setup no cost fixer saves: buy its sustain, then weigh it against the build)
        let paid = s.sustain_paid(&st, &e).unwrap();
        println!("paid for: score {:.3} vs {:.3} without; main {:?} utils {:?}; mana shortfall {}", paid.score, st.score, names(&paid.main), names(&paid.utils), deficit(&s, &paid, mana));
        assert!(paid.main.contains(&eff), "Efficacy dropped");
        assert!(deficit(&s, &paid, mana) <= 1e-9, "mana still short");
    }

    #[test]
    fn badness_weights_hard_over_soft() {
        let c = |level: &str, status: &str| json!({ "level": level, "status": status });
        assert_eq!(badness(&[c("hard", "unmet"), c("soft", "unmet"), c("chip", "met")]), 101.0);
        assert!(badness(&[c("soft", "unmet"), c("soft", "unmet")]) < badness(&[c("hard", "unmet")]));
    }

    #[test]
    fn notes_are_kept_per_build_text() {
        remember("<a/>", vec![("movement-skill".into(), "no free socket".into())]);
        assert_eq!(note_for("<a/>", "movement-skill").as_deref(), Some("no free socket"));
        assert_eq!(note_for("<b/>", "movement-skill"), None);
    }

    /// The pantheon table from game data: majors and minors both exist, so the fill has gods of each kind to try.
    #[test]
    fn pantheon_table_has_majors_and_minors() {
        let Ok(Some(t)) = pom_calc::data::game_data().extra.get("pantheons") else { panic!("no pantheon table") };
        let o = t.as_object().unwrap();
        let major = |g: J| g.get("isMajorGod").and_then(|b| b.as_bool()).unwrap_or(false);
        assert!(o.iter().any(|(_, g)| major(g)) && o.iter().any(|(_, g)| !major(g)));
    }
}
