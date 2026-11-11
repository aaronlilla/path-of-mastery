//! The beam: from each class root (class start, scouted gems and gear, empty tree) it adds one
//! part at a time, keeps the best `width` states, and re-measures every kept state's sensitivity so a pick that makes
//! another axis valuable ("took crit, multi now pays") steers the next expansion. Every number is a real eval.
//!
//! Node parts pay their real path: a child's main tree is the Steiner tree (`ClassCtx::tree_for`) over all its node,
//! mastery and cluster-socket picks, and every point it spends costs `lambda` (what a free point is worth in this
//! class). Gear seam: gear parts are more `Part`s in `BeamRoot::parts` (mod lines ride on the
//! state as probe lines until the gear is realized) and `Fit` is the optional slot-budget check on a set of picks.

use super::gearparts::{GearPart, Side, SlotBudget};
use super::items::{addable, craft_piece, rank_key, unique_piece, Design, Fam, Gear, SlotKind};
use super::parts::{convex_axes, convex_primes, Excl, Part, PartKind, Screen};
use super::sens::{Sens, AXES};
use super::*;

/// One class's start for the beam.
pub(super) struct BeamRoot {
    /// Class start with the scouted gems and gear, empty tree, evaluated (`rebase`).
    pub st: State,
    pub parts: Vec<Part>,
    /// `parts` screened at `st`; `primed[k]` was primed with the committed package of `prime_axes[k]`.
    pub screen: Screen,
    pub prime_axes: Vec<usize>,
    /// Score of one free passive point (see `Solver::lambda`).
    pub lambda: f64,
}

/// Optional check that a set of picks still fits the gear (`SlotBudget`); the new pick is last.
pub(super) type Fit<'a> = Option<&'a dyn Fn(&BeamRoot, &[&Part]) -> bool>;

#[derive(Clone)]
pub(super) struct BeamCfg {
    pub width: usize,
    pub per_class: usize,
    pub per_sig: usize,
    pub depth: usize,
    /// Children per state: top parts by primed gain on the state's lead axes, by root gain, by Jev priority, random.
    pub by_prime: usize,
    pub by_root: usize,
    pub by_jev: usize,
    pub random: usize,
    /// Share of the passive points the beam's tree may use (the rest is for life and resist filler).
    pub point_share: f64,
    pub uniques: usize,
    pub keystones: usize,
    pub supports: usize,
    pub asc: usize,
    pub anoints: usize,
    /// Axes in a state's lead signature.
    pub lead: usize,
    pub leaves: usize,
    pub leaves_per_class: usize,
    /// States carrying a route's placeholder lines (`Hold`) kept per depth and route, besides `width` real ones; 0: no
    /// routes.
    pub holds: usize,
    pub seed: u64,
    /// `Solver::spent` mark the beam stops at.
    pub end_ms: u64,
}

impl Default for BeamCfg {
    fn default() -> Self {
        BeamCfg { width: 20, per_class: 8, per_sig: 4, depth: 8, by_prime: 100, by_root: 30, by_jev: 20, random: 10, point_share: 0.7, uniques: 4, keystones: 3, supports: 5, asc: 4, anoints: 1, lead: 3, leaves: 6, leaves_per_class: 3, holds: 4, seed: 0x5EED, end_ms: u64::MAX }
    }
}

/// A placeholder: one line of a joint axis's committed package (solver_sens.rs `scanned`) riding on a beam state as a
/// probe line until a picked part carries its modifier.
pub(super) type Hold = &'static str;

/// (name, flags, keyword flags) of every modifier the engine's mod parser reads from `lines` (rolls at their top).
fn mod_keys(lines: &[String]) -> Vec<(String, u64, u64)> {
    lines.iter().filter_map(|l| pom_engine::modparser::parse_mod(&super::sens::top_roll(l)).0).flatten().map(|m| (m.name, m.flags, m.keyword_flags)).collect()
}

pub(super) struct Beam {
    /// Index into the roots.
    pub root: usize,
    /// Part ids (into the root's `parts`), sorted.
    pub picks: Vec<u16>,
    /// The picks in the order taken, each with the `bscore` it added.
    pub gains: Vec<(u16, f64)>,
    pub st: State,
    /// Mod-line parts, as probe lines on the build text.
    pub lines: Vec<String>,
    pub sens: Sens,
    /// Axes (into `AXES`) whose marginal value rose most against the root's: the state's lead signature.
    pub lead: Vec<usize>,
    /// `relaxed_score`
    pub score: f64,
    /// `score + lambda * free points`
    pub bscore: f64,
    /// Placeholder halves of the route being entered (empty: a real state; only real states become leaves).
    pub holds: Vec<Hold>,
    /// Joint axes (into `AXES`) this lineage entered, in order.
    pub routes: Vec<usize>,
    /// Picks that supplied a hold, with the hold lines they replaced.
    pub swaps: Vec<(u16, Vec<&'static str>)>,
    /// Ranking: `bscore` on real states; on a hold state the parent's rank plus the pick's gain with the holds in place
    /// (a pick that replaces holds is not charged for what the real part gives less than the placeholder).
    pub rank: f64,
}

struct Kid {
    parent: usize,
    /// None: the parent entering a route (`route`).
    pi: Option<u16>,
    picks: Vec<u16>,
    st: State,
    lines: Vec<String>,
    score: f64,
    bscore: f64,
    holds: Vec<Hold>,
    route: Option<usize>,
    swap: Vec<Hold>,
    rank: f64,
    /// What the pick added (rank terms on a hold parent).
    gain: f64,
}

fn split(lines: &[String]) -> Vec<&str> {
    lines.iter().flat_map(|l| l.split('\n')).collect()
}

/// The `n` axes whose marginal value rose most over the root's (sorted ids: the signature).
fn lead_axes(root: &[f64], s: &Sens, n: usize) -> Vec<usize> {
    let mut v: Vec<(f64, usize)> = s.axes.iter().enumerate().filter_map(|(k, &a)| Some((s.marginal[k] - root.get(k)?, a))).filter(|x| x.0 > EPS).collect();
    v.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut out: Vec<usize> = v.into_iter().take(n).map(|x| x.1).collect();
    out.sort_unstable();
    out
}

impl Solver {
    /// What a free main-tree point is worth in a class: the scouted tree's gain over the empty tree, per point it used.
    pub(super) fn lambda(&self, root: &State, scouted: &State) -> f64 {
        let used = self.used(scouted).0.max(1) as f64;
        ((self.relaxed_score(&scouted.vals, false) - self.relaxed_score(&root.vals, false)) / used).max(0.0)
    }

    fn free_main(&self, st: &State) -> usize {
        self.points.saturating_sub(self.used(st).0)
    }

    fn beam_text(&self, st: &State, lines: &[String], holds: &[&str]) -> Result<String, String> {
        let mut all = split(lines);
        all.extend(holds);
        if all.is_empty() {
            self.render(st)
        } else {
            self.render_with_probe(st, &all)
        }
    }

    /// `sensitivity` of a beam state, its mod lines counted as gear.
    fn beam_sens(&self, st: &State, lines: &[String]) -> Result<Sens, String> {
        if lines.is_empty() {
            return self.sensitivity(st);
        }
        let extra = split(lines);
        let axes = self.sens_axes(false);
        let with = |set: &[&'static str]| extra.iter().copied().chain(set.iter().copied()).collect::<Vec<&str>>();
        let mut probes = vec![extra.clone()];
        probes.extend(axes.iter().map(|&i| with(AXES[i].unit)));
        probes.extend(axes.iter().map(|&i| with(AXES[i].commit)));
        let (base, g, xml_ms) = self.probe_gains(st, &probes)?;
        let n = axes.len();
        Ok(Sens { base: base + g[0], marginal: g[1..=n].iter().map(|x| x - g[0]).collect(), committed: g[n + 1..].iter().map(|x| x - g[0]).collect(), synergy: Vec::new(), axes, xml_ms })
    }

    fn part_priority(&self, p: &Part) -> f64 {
        let pr = &self.goal.priority;
        match &p.kind {
            PartKind::Support(_) => Priority::of(&pr.supports, &p.label),
            PartKind::Unique { u, .. } => Priority::of(&pr.uniques, &u.name),
            PartKind::ModLine { text, .. } | PartKind::Gear(GearPart { text, .. }) => pr.of_family("", text),
            _ => 0.5,
        }
    }

    /// The parts to try on `b`, as ranked lists with how many applicable children each may give.
    fn beam_order(&self, r: &BeamRoot, b: &Beam, cfg: &BeamCfg, rng: &mut u64) -> Vec<(Vec<u16>, usize)> {
        let n = r.parts.len() as u16;
        let ranked = |f: &dyn Fn(usize) -> f64| {
            let mut v: Vec<u16> = (0..n).collect();
            v.sort_by(|&a, &b| f(b as usize).total_cmp(&f(a as usize)));
            v
        };
        let mut out = Vec::new();
        if !r.prime_axes.is_empty() {
            // primed on the lead axes the screen has, else on every primed axis
            // (a hold state: on its route's rows)
            let lead: Vec<usize> = (0..r.prime_axes.len()).filter(|&k| if b.holds.is_empty() { b.lead.contains(&r.prime_axes[k]) } else { b.routes.last() == Some(&r.prime_axes[k]) }).collect();
            let rows = if lead.is_empty() { (0..r.prime_axes.len()).collect() } else { lead };
            // (by lift, what the primed state adds to a part over the root: the root list has the plainly good ones)
            out.push((ranked(&|i| rows.iter().map(|&k| r.screen.primed[k][i] - r.screen.root[i]).fold(f64::NEG_INFINITY, f64::max)), cfg.by_prime));
        }
        out.push((ranked(&|i| r.screen.root[i]), cfg.by_root));
        if !self.goal.priority.is_empty() {
            out.push((ranked(&|i| self.part_priority(&r.parts[i])), cfg.by_jev));
        }
        let mut v: Vec<u16> = (0..n).collect();
        for i in (1..v.len()).rev() {
            *rng ^= *rng << 13;
            *rng ^= *rng >> 7;
            *rng ^= *rng << 17;
            v.swap(i, (*rng % (i as u64 + 1)) as usize);
        }
        out.push((v, cfg.random));
        out
    }

    /// `b` plus part `pi`: the child's state and mod lines, and the candidate that evaluates it (tree changes as a node
    /// list on `base`, `b`'s text, the rest as whole texts with the hold lines `holds`). None: the part clashes, breaks a
    /// cap, does not fit or is unreachable.
    fn beam_child(&self, r: &BeamRoot, b: &Beam, pi: u16, cfg: &BeamCfg, fit: Fit, base: &Arc<String>, holds: &[&str]) -> Result<Option<(State, Vec<String>, Cand)>, String> {
        let p = &r.parts[pi as usize];
        let mut all: Vec<&Part> = b.picks.iter().map(|&i| &r.parts[i as usize]).collect();
        // (links are not exclusive: the support cap counts them)
        if p.excl.iter().any(|e| *e != Excl::Link && all.iter().any(|q| q.excl.iter().any(|f| e.clashes(f)))) {
            return Ok(None);
        }
        all.push(p);
        let c = &self.ctx[b.st.class];
        let count = |f: &dyn Fn(&PartKind) -> bool| all.iter().filter(|q| f(&q.kind)).count();
        if count(&|k| matches!(k, PartKind::Node(id) if c.kind(*id) == "Keystone")) > cfg.keystones
            || count(&|k| matches!(k, PartKind::Unique { .. })) > cfg.uniques
            || count(&|k| matches!(k, PartKind::Support(_))) > cfg.supports
            || count(&|k| matches!(k, PartKind::Asc(_))) > cfg.asc
            || count(&|k| matches!(k, PartKind::Anoint(..))) > cfg.anoints
        {
            return Ok(None);
        }
        if fit.is_some_and(|f| !f(r, &all)) {
            return Ok(None);
        }
        let st = &b.st;
        let mut ch = st.clone();
        let mut lines = b.lines.clone();
        // The main tree joining every node, mastery and cluster-socket pick, plus the ascendancy nodes taken.
        let tree = || -> Option<Vec<i64>> {
            let terms: Vec<i64> = all.iter().filter_map(|q| match &q.kind {
                PartKind::Node(id) => Some(*id),
                PartKind::Mastery(n, _) => Some(*n),
                PartKind::Cluster(s) => Some(s.node),
                _ => None,
            }).collect();
            let mut v: Vec<i64> = c.tree_for(&terms, &st.nodes)?.into_iter().filter(|&n| n != c.root).collect();
            v.sort_unstable();
            v.extend(st.nodes.iter().copied().filter(|&n| c.is_asc(n)));
            Some(v)
        };
        let gear = |g: Option<items::Gear>| g.map(Arc::new);
        let cand = match &p.kind {
            PartKind::Node(_) | PartKind::Mastery(..) => {
                let Some(n) = tree() else { return Ok(None) };
                ch.nodes = n;
                let m = if let PartKind::Mastery(n, e) = p.kind { Some((n, e)) } else { None };
                ch.masteries.extend(m);
                Cand::Nodes { base: base.clone(), nodes: self.full_nodes(&ch), mastery: m, pin: Vec::new() }
            }
            PartKind::Asc(id) => {
                let reach = c.bfs(&st.nodes.iter().copied().collect(), true);
                if !reach.contains_key(id) {
                    return Ok(None);
                }
                ch.nodes.extend(c.path_to(&reach, *id));
                if c.blood_in(&ch.nodes) != c.blood_in(&st.nodes) {
                    // (a bloodline's first node: the build text names the bloodline)
                    Cand::Xml(Arc::new(self.beam_text(&ch, &lines, holds)?))
                } else {
                    Cand::Nodes { base: base.clone(), nodes: self.full_nodes(&ch), mastery: None, pin: Vec::new() }
                }
            }
            PartKind::Cluster(s) => {
                let mut g = (*st.gear).clone();
                g.sockets.retain(|x| x.node != s.node);
                g.sockets.push(s.clone());
                if !self.affordable(&g, Some(&st.gear)) {
                    return Ok(None);
                }
                ch.gear = Arc::new(g);
                let Some(n) = tree() else { return Ok(None) };
                ch.nodes = n;
                Cand::Xml(Arc::new(self.beam_text(&ch, &lines, holds)?))
            }
            PartKind::Anoint(name, id) => {
                let Some(ai) = self.slot_of(SlotKind::Amulet) else { return Ok(None) };
                let Some(Design::Craft { base, mods, .. }) = st.gear.pieces[ai].as_ref().map(|p| &p.design) else { return Ok(None) };
                if st.nodes.contains(id) || !base.anoints.iter().any(|(n, _)| n == id) {
                    return Ok(None);
                }
                let Some(g) = gear(self.with_piece(&st.gear, ai, Some(craft_piece(base, mods.clone(), Some(name.clone()), self.item_level)))) else { return Ok(None) };
                ch.gear = g;
                Cand::Xml(Arc::new(self.beam_text(&ch, &lines, holds)?))
            }
            PartKind::Unique { slot, u } => {
                let Some(g) = gear(self.with_piece(&st.gear, *slot, Some(unique_piece(u)))) else { return Ok(None) };
                ch.gear = g;
                Cand::Xml(Arc::new(self.beam_text(&ch, &lines, holds)?))
            }
            PartKind::Support(id) => {
                if st.main.contains(id) {
                    return Ok(None);
                }
                if ch.main.len() < 6 {
                    ch.main.push(*id);
                } else {
                    // Full links: the support the gem layer added last (its weakest) that is neither required nor a pick.
                    let picked = |g: &str| all.iter().any(|q| matches!(q.kind, PartKind::Support(s) if s == g));
                    let Some(k) = (1..ch.main.len()).rev().find(|&k| !self.required.contains(&ch.main[k]) && !picked(ch.main[k])) else { return Ok(None) };
                    ch.main[k] = *id;
                }
                if self.mana_clash(&ch.main) {
                    return Ok(None);
                }
                self.price_gems(&mut ch);
                if !self.affordable(&ch.gear, Some(&st.gear)) || !self.sockets_ok(&ch.gear, Some(&st.gear)) {
                    return Ok(None);
                }
                Cand::Xml(Arc::new(self.beam_text(&ch, &lines, holds)?))
            }
            PartKind::ModLine { text, .. } | PartKind::Gear(GearPart { text, .. }) => {
                lines.push(text.clone());
                Cand::Xml(Arc::new(self.beam_text(&ch, &lines, holds)?))
            }
        };
        let (main, asc) = self.used(&ch);
        if main as f64 > cfg.point_share * self.points as f64 || asc > self.asc_points {
            return Ok(None);
        }
        Ok(Some((ch, lines, cand)))
    }

    /// Children `pis` of `b` evaluated with the hold lines `holds` in place of `b`'s: [0] `b` as a node list, [1] as a
    /// whole text, then each child (None where it does not apply).
    fn beam_batch(&self, r: &BeamRoot, b: &Beam, pis: &[u16], cfg: &BeamCfg, fit: Fit, holds: &[&'static str]) -> Result<Vec<Option<Vals>>, String> {
        let base = Arc::new(self.beam_text(&b.st, &b.lines, holds)?);
        let mut cands = vec![Cand::Nodes { base: base.clone(), nodes: self.full_nodes(&b.st), mastery: None, pin: Vec::new() }, Cand::Xml(base.clone())];
        let mut at = Vec::new();
        for &pi in pis {
            at.push(self.beam_child(r, b, pi, cfg, fit, &base, holds)?.map(|(_, _, c)| {
                cands.push(c);
                cands.len() - 1
            }));
        }
        let mut res = self.eval(cands);
        let mut out: Vec<Option<Vals>> = vec![res[0].take(), res[1].take()];
        out.extend(at.into_iter().map(|i| i.and_then(|i| res[i].take())));
        Ok(out)
    }

    /// Route entries of a real state: per joint axis (route or stacking scaler) of the root's prime rows, `b` with the
    /// axis's committed lines as holds. `bx`: `b` as a whole text, the scores' reference.
    fn beam_entries(&self, r: &BeamRoot, b: &Beam, bi: usize, bx: f64) -> Result<Vec<Kid>, String> {
        let mut axes: Vec<usize> = r.prime_axes.iter().copied().filter(|&i| !AXES[i].pair.is_empty() && !b.routes.contains(&i)).collect();
        axes.dedup();
        let mut cands = Vec::new();
        for &i in &axes {
            cands.push(Cand::Xml(Arc::new(self.beam_text(&b.st, &b.lines, AXES[i].commit)?)));
        }
        let mut res = self.eval(cands);
        let mut out = Vec::new();
        for (n, &i) in axes.iter().enumerate() {
            let Some(x) = res[n].as_ref().map(|v| self.relaxed_score(v, false)) else { continue };
            let mut st = b.st.clone();
            st.vals = res[n].take().unwrap_or_default();
            (st.score, st.viol) = self.score(&st.vals);
            let score = b.score + x - bx;
            let bscore = score + r.lambda * self.free_main(&st) as f64;
            out.push(Kid { parent: bi, pi: None, picks: b.picks.clone(), st, lines: b.lines.clone(), score, bscore, holds: AXES[i].commit.to_vec(), route: Some(i), swap: Vec::new(), rank: bscore, gain: bscore - b.bscore });
        }
        Ok(out)
    }

    /// The modifiers part `p` carries, as the engine's mod parser reads its lines: (name, flags, keyword flags).
    /// shortcut: supports and cluster jewels carry none (no text lines).
    fn part_mods(&self, ci: usize, p: &Part) -> Vec<(String, u64, u64)> {
        let c = &self.ctx[ci];
        let tree = crate::cached_tree(&tag_attr(&c.xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())).ok();
        let stats = |id: i64, eff: Option<i64>| -> Vec<String> {
            let Some((t, n)) = tree.and_then(|t| Some((t, t.nodes.get(&id)?))) else { return Vec::new() };
            match eff {
                None => n.get("stats").map(|v| pom_passives::treedata::str_list(t.deref(v))).unwrap_or_default(),
                Some(e) => n.get("masteryEffects").map(|v| t.deref(v)).and_then(|v| v.as_array()).into_iter().flat_map(|a| a.iter()).map(|x| t.deref(x)).find(|x| x.get("effect").and_then(|v| v.as_i64()) == Some(e)).and_then(|x| x.get("stats")).map(|v| pom_passives::treedata::str_list(t.deref(v))).unwrap_or_default(),
            }
        };
        let lines: Vec<String> = match &p.kind {
            PartKind::Node(id) | PartKind::Asc(id) | PartKind::Anoint(_, id) => stats(*id, None),
            PartKind::Mastery(n, e) => stats(*n, Some(*e)),
            PartKind::Unique { u, .. } => super::items::active_lines(&u.xml),
            PartKind::ModLine { text, .. } | PartKind::Gear(GearPart { text, .. }) => text.lines().map(String::from).collect(),
            PartKind::Support(_) | PartKind::Cluster(_) => Vec::new(),
        };
        mod_keys(&lines)
    }

    /// The beam over `roots` (one shared beam, at most `per_class` states per class). Returns the best leaves by
    /// `bscore`, at most `leaves_per_class` per class, each with its picks and what each pick added.
    ///
    /// Routes (`cfg.holds` > 0): a real state may enter a joint axis the scan found (`beam_entries`), carrying the
    /// axis's committed lines as placeholder holds, so the parts after it are scored with the route in place. A picked
    /// part that carries a hold line's modifier (same stat, at least the same flags) replaces that line: the state is
    /// scored without it from then on. Hold states have their own `cfg.holds` slots per route, the ones with the fewest
    /// holds left first; they are never leaves, so only states whose every hold real parts replaced come out.
    pub(super) fn beam(&self, roots: &[BeamRoot], cfg: &BeamCfg, fit: Fit) -> Result<Vec<Beam>, String> {
        assert!(roots.iter().all(|r| r.parts.len() < u16::MAX as usize));
        let mut rng = cfg.seed | 1;
        let mut seen: HashSet<(usize, Vec<u16>, Vec<&'static str>)> = HashSet::default();
        let mut cur: Vec<Beam> = Vec::new();
        let mut rsens: Vec<Vec<f64>> = Vec::new();
        for (ri, r) in roots.iter().enumerate() {
            let score = self.relaxed_score(&r.st.vals, false);
            let sens = self.sensitivity(&r.st)?;
            rsens.push(sens.marginal.clone());
            let bscore = score + r.lambda * self.free_main(&r.st) as f64;
            cur.push(Beam { root: ri, picks: Vec::new(), gains: Vec::new(), st: r.st.clone(), lines: Vec::new(), sens, lead: Vec::new(), score, bscore, holds: Vec::new(), routes: Vec::new(), swaps: Vec::new(), rank: bscore });
            seen.insert((ri, Vec::new(), Vec::new()));
        }
        // each hold line's modifiers, and each part's (only when routes are on)
        let hold_mods: HashMap<&'static str, Vec<(String, u64, u64)>> = if cfg.holds == 0 { HashMap::default() } else { roots.iter().flat_map(|r| r.prime_axes.iter()).flat_map(|&i| AXES[i].commit.iter()).map(|&l| (l, mod_keys(&[l.to_string()]))).collect() };
        let part_mods: Vec<Vec<Vec<(String, u64, u64)>>> = roots.iter().map(|r| if cfg.holds == 0 { Vec::new() } else { r.parts.iter().map(|p| self.part_mods(r.st.class, p)).collect() }).collect();
        let supplies = |ri: usize, pi: u16, h: &str| {
            let (pm, hm) = (&part_mods[ri][pi as usize], &hold_mods[h]);
            // (the same stat or a narrower one by the engine's naming, "ChaosDotMultiplier" of "DotMultiplier")
            !hm.is_empty() && hm.iter().all(|(n, f, k)| pm.iter().any(|(pn, pf, pk)| pn.ends_with(n.as_str()) && pf & f == *f && pk & k == *k))
        };
        let key = |h: &[Hold]| {
            let mut v = h.to_vec();
            v.sort_unstable();
            v
        };
        let mut done: Vec<Beam> = Vec::new();
        for _ in 0..cfg.depth {
            if cur.is_empty() || self.stop() || self.spent() >= cfg.end_ms {
                break;
            }
            let mut kids: Vec<Kid> = Vec::new();
            for (bi, b) in cur.iter().enumerate() {
                let r = &roots[b.root];
                let held = key(&b.holds);
                // [0] the parent as a node list, [1] as a whole text: each child's gain is taken against the same path.
                let mut cands = vec![Cand::Nodes { base: b.st.base.clone(), nodes: self.full_nodes(&b.st), mastery: None, pin: Vec::new() }, Cand::Xml(b.st.base.clone())];
                let mut made: Vec<(u16, Vec<u16>, State, Vec<String>, bool)> = Vec::new();
                let mut tried: HashSet<u16> = HashSet::default();
                for (list, quota) in self.beam_order(r, b, cfg, &mut rng) {
                    let mut k = 0;
                    for pi in list {
                        if k == quota {
                            break;
                        }
                        if b.picks.contains(&pi) || !tried.insert(pi) {
                            continue;
                        }
                        let mut picks = b.picks.clone();
                        picks.push(pi);
                        picks.sort_unstable();
                        if seen.contains(&(b.root, picks.clone(), held.clone())) {
                            continue;
                        }
                        if let Some((st, lines, cand)) = self.beam_child(r, b, pi, cfg, fit, &b.st.base, &b.holds)? {
                            k += 1;
                            made.push((pi, picks, st, lines, matches!(cand, Cand::Nodes { .. })));
                            cands.push(cand);
                        }
                    }
                }
                let res = self.eval(cands);
                let s = |i: usize| res[i].as_ref().map(|v| self.relaxed_score(v, false));
                let (Some(bn), Some(bx)) = (s(0), s(1)) else { continue };
                let reff = |nodes: bool| if nodes { bn } else { bx };
                // picks that replace hold lines, by the holds left
                let mut swapped: HashMap<Vec<&'static str>, Vec<(usize, bool)>> = HashMap::default();
                for (k, (pi, picks, mut st, lines, nodes)) in made.into_iter().enumerate() {
                    let Some(x) = s(k + 2) else { continue };
                    let score = b.score + x - reff(nodes);
                    let bscore = score + r.lambda * self.free_main(&st) as f64;
                    let (swap, holds): (Vec<Hold>, Vec<Hold>) = b.holds.iter().partition(|h| supplies(b.root, pi, h));
                    // (a replacing pick is scored without the lines it replaced, below)
                    if swap.is_empty() && bscore <= b.bscore + EPS {
                        continue;
                    }
                    st.vals = res[k + 2].clone().unwrap_or_default();
                    (st.score, st.viol) = self.score(&st.vals);
                    if !swap.is_empty() {
                        swapped.entry(holds.clone()).or_default().push((kids.len(), nodes));
                    }
                    let gain = bscore - b.bscore;
                    kids.push(Kid { parent: bi, pi: Some(pi), picks, st, lines, score, bscore, holds, route: None, swap, rank: b.rank + gain, gain });
                }
                for (rest, ks) in swapped {
                    let pis: Vec<u16> = ks.iter().filter_map(|&(k, _)| kids[k].pi).collect();
                    let real = self.beam_batch(r, b, &pis, cfg, fit, &rest)?;
                    for (n, &(k, nodes)) in ks.iter().enumerate() {
                        let kd = &mut kids[k];
                        let Some(v) = real[n + 2].as_ref() else {
                            kd.rank = f64::NEG_INFINITY;
                            continue;
                        };
                        kd.score = b.score + self.relaxed_score(v, false) - reff(nodes);
                        kd.st.vals = v.clone();
                        (kd.st.score, kd.st.viol) = self.score(&kd.st.vals);
                        kd.bscore = kd.score + r.lambda * self.free_main(&kd.st) as f64;
                        if rest.is_empty() {
                            kd.rank = kd.bscore;
                        }
                    }
                }
                if b.holds.is_empty() && cfg.holds > 0 {
                    kids.extend(self.beam_entries(r, b, bi, bx)?);
                }
            }
            kids.retain(|k| k.rank > f64::NEG_INFINITY);
            kids.sort_by(|a, b| b.rank.total_cmp(&a.rank));
            // Real states by rank. Each route's slots (its hold states, and the real states of a lineage that entered
            // it which the main pool did not take: a route still behind the plain states while it grows): half to the
            // states with the fewest holds left (then rank), so lineages get on with replacing them, the rest by rank.
            let routed = |k: &Kid| k.route.is_some() || !cur[k.parent].routes.is_empty();
            let mut order: Vec<(usize, usize)> = (0..kids.len()).filter(|&i| kids[i].holds.is_empty()).map(|i| (i, 0)).collect();
            let mut fewest: Vec<usize> = (0..kids.len()).filter(|&i| routed(&kids[i])).collect();
            fewest.sort_by_key(|&i| kids[i].holds.len());
            order.extend(fewest.into_iter().map(|i| (i, cfg.holds.div_ceil(2))));
            order.extend((0..kids.len()).filter(|&i| routed(&kids[i])).map(|i| (i, cfg.holds)));
            let mut kids: Vec<Option<Kid>> = kids.into_iter().map(Some).collect();
            let mut next: Vec<Beam> = Vec::new();
            let mut per_class: HashMap<usize, usize> = HashMap::default();
            let mut per_sig: HashMap<Vec<usize>, usize> = HashMap::default();
            let (mut measured, mut real) = (0, 0);
            let mut held: HashMap<usize, usize> = HashMap::default();
            for (i, quota) in order {
                if self.stop() {
                    break;
                }
                let Some(k) = kids[i].as_ref() else { continue };
                let full = real == cfg.width || measured >= cfg.width * 3 / 2;
                let lane = k.route.or_else(|| cur[k.parent].routes.last().copied()).unwrap_or(usize::MAX);
                // (quota 0: the main pool)
                if (quota == 0 && (full || per_class.get(&k.st.class).copied().unwrap_or(0) >= cfg.per_class)) || (quota > 0 && held.get(&lane).copied().unwrap_or(0) >= quota) {
                    continue;
                }
                let root = cur[k.parent].root;
                if seen.contains(&(root, k.picks.clone(), key(&k.holds))) {
                    kids[i] = None;
                    continue;
                }
                let Some(mut k) = kids[i].take() else { continue };
                seen.insert((root, k.picks.clone(), key(&k.holds)));
                k.st.base = Arc::new(self.beam_text(&k.st, &k.lines, &k.holds)?);
                self.settle(&mut k.st);
                let p = &cur[k.parent];
                let (mut gains, mut routes, mut swaps) = (p.gains.clone(), p.routes.clone(), p.swaps.clone());
                gains.extend(k.pi.map(|pi| (pi, k.gain)));
                routes.extend(k.route);
                if !k.swap.is_empty() {
                    swaps.extend(k.pi.map(|pi| (pi, k.swap.clone())));
                }
                let (sens, lead) = if k.holds.is_empty() {
                    let sens = self.beam_sens(&k.st, &k.lines)?;
                    let lead = lead_axes(&rsens[root], &sens, cfg.lead);
                    if quota == 0 {
                        measured += 1;
                        let n = per_sig.entry(lead.clone()).or_default();
                        if *n >= cfg.per_sig {
                            continue;
                        }
                        *n += 1;
                        *per_class.entry(k.st.class).or_default() += 1;
                        real += 1;
                    } else {
                        *held.entry(lane).or_default() += 1;
                    }
                    (sens, lead)
                } else {
                    // (hold states expand on their route's rows: no sensitivity needed)
                    *held.entry(lane).or_default() += 1;
                    (Sens { base: k.score, axes: Vec::new(), marginal: Vec::new(), committed: Vec::new(), synergy: Vec::new(), xml_ms: 0.0 }, Vec::new())
                };
                next.push(Beam { root, picks: k.picks, gains, st: k.st, lines: k.lines, sens, lead, score: k.score, bscore: k.bscore, holds: k.holds, routes, swaps, rank: k.rank });
            }
            done.append(&mut cur);
            cur = next;
        }
        done.append(&mut cur);
        // (no placeholder ever reaches a result)
        done.retain(|b| !b.picks.is_empty() && b.holds.is_empty());
        done.sort_by(|a, b| b.bscore.total_cmp(&a.bscore));
        let mut per_class: HashMap<usize, usize> = HashMap::default();
        let mut out = Vec::new();
        for b in done {
            let n = per_class.entry(b.st.class).or_default();
            if out.len() < cfg.leaves && *n < cfg.leaves_per_class {
                *n += 1;
                out.push(b);
            }
        }
        Ok(out)
    }
}

impl Solver {
    /// The expert phase: per class (the best three scouted, the open build's among them) the
    /// empty-tree root is measured and every part screened; one beam runs over all roots; each leaf is made into a
    /// real build. Phases end at their marks (screen +8%, beam +12%, realize +15% of the budget from the phase's
    /// start), each doing at least one class or leaf. Returns the realized states, each also added to the archive.
    pub(super) fn expert(&mut self, scouted: &[State]) -> Result<Vec<State>, String> {
        // Hard cap: the whole expert phase ends at 60% of the budget, so converge, kicks and the unique/jewel/gear passes
        // keep at least 40% (measured: the phase took 71-76% and those never ran).
        let hard = self.budget_ms * 60 / 100;
        self.phase_end.set(hard);
        let r = self.expert_inner(scouted, hard);
        self.phase_end.set(u64::MAX);
        r
    }

    fn expert_inner(&mut self, scouted: &[State], hard: u64) -> Result<Vec<State>, String> {
        let Some(full) = scouted.first() else { return Ok(Vec::new()) };
        let b = self.budget_ms;
        let mut roots: Vec<BeamRoot> = Vec::new();
        let mut gear: Vec<GearPart> = Vec::new();
        let mut lambda = None;
        // Each scouted class (the best three) gets an equal share of the screen, so the beam has a root for each and the
        // ascendancy comparison is not settled by which class the scout liked first. The share starts at the class's
        // screen, after its sensitivity, cluster designs and gear lines (those took the whole 8% once the gear lines
        // grew: every screen was cut to its first chunk and the beam kept one class).
        let n = scouted.len().min(3);
        for sc in scouted.iter().take(3) {
            // (the beam keeps its planned 12% before the hard cap: a later class whose sensitivity, parts and screen would eat it is
            // left out, so a small solve still runs the beam over the classes done; the first class always runs)
            if self.stop() || (!roots.is_empty() && self.spent() + b * 12 / 100 > hard) {
                break;
            }
            // A class cut off by the time cap has no scores (every evaluation after the cap reads None): drop it, keep the
            // classes done. Any other error stays an error.
            let root = (|| -> Result<BeamRoot, String> {
                self.current = self.ctx[sc.class].label.clone();
                let mut st = State { nodes: Vec::new(), masteries: Vec::new(), parts: Arc::default(), ..sc.clone() };
                self.rebase(&mut st)?;
                self.layer = "expert: sensitivity".into();
                self.publish();
                let sens = self.sensitivity_full(&st)?;
                // (6 rows: the best plain axis and the best route and stacking axis, each joint axis primed twice)
                let (prime_axes, primes) = (convex_axes(&sens, 6), convex_primes(&sens, 6));
                let mut parts = self.part_catalog(st.class);
                parts.extend(self.cluster_parts(&st)?);
                if self.rules.craft_top() {
                    if roots.is_empty() {
                        // Gear lines are the same for every class (shared gear): picked once, primed on the lead convex axis.
                        // Enchants are not picked here (no enchant families to write them yet); "in your Presence" lines are priced
                        // as always on, so they are left out.
                        gear = self.gear_parts(&st, primes.first().map_or(&[][..], |p| &p[..]), 40)?.into_iter().filter(|g| g.side != Side::Enchant && !g.text.contains("in your Presence")).collect();
                    }
                    parts.extend(gear.iter().map(|g| Part { label: format!("{} ({}{})", g.text.replace('\n', " / "), g.source, g.influence.as_deref().map(|i| format!(" {i}")).unwrap_or_default()), kind: PartKind::Gear(g.clone()), excl: Vec::new(), cost: 0 }));
                }
                self.conflict_excl(&mut parts);
                self.layer = "expert: screen".into();
                self.publish();
                let screen = self.screen(&st, &parts, &primes, self.spent() + b * 8 / 100 / n as u64)?;
                // Half the scouted tree's gain per point (measured: Molten Strike 19% of the reference DPS against 10%
                // with the gain per point of the tree's last tenth; Spark and Essence Drain the same either way).
                let l = *lambda.get_or_insert_with(|| self.lambda(&st, full) / 2.0);
                Ok(BeamRoot { st, parts, screen, prime_axes, lambda: l })
            })();
            match root {
                Ok(r) => roots.push(r),
                Err(_) if self.stop() => break,
                Err(e) => return Err(e),
            }
        }
        if roots.is_empty() || self.stop() {
            return Ok(Vec::new());
        }
        self.layer = "expert: beam".into();
        self.publish();
        let leaves = {
            // A gear pick needs a slot of its own set (not one a unique pick holds) whose top craft still takes it with
            // the gear picks placed before it. shortcut: greedy slot choice in pick order, no backtracking.
            let budget = RefCell::new(SlotBudget::new(self));
            let fit = |_: &BeamRoot, all: &[&Part]| -> bool {
                if !all.last().is_some_and(|p| matches!(p.kind, PartKind::Gear(_) | PartKind::Unique { .. })) {
                    return true;
                }
                let taken: Vec<usize> = all.iter().filter(|p| matches!(p.kind, PartKind::Unique { .. })).flat_map(|p| p.excl.iter().filter_map(|e| if let Excl::Slot(i) = e { Some(*i) } else { None })).collect();
                let mut at: HashMap<usize, Vec<&GearPart>> = HashMap::default();
                let mut bud = budget.borrow_mut();
                for p in all {
                    let PartKind::Gear(g) = &p.kind else { continue };
                    let ok = g.slots.iter().copied().find(|s| {
                        let mut v = at.get(s).cloned().unwrap_or_default();
                        v.push(g);
                        !taken.contains(s) && bud.fits(*s, &v)
                    });
                    let Some(s) = ok else { return false };
                    at.entry(s).or_default().push(g);
                }
                true
            };
            // (cut off by the cap: no leaves, the scouted states stand)
            match self.beam(&roots, &BeamCfg { end_ms: self.spent() + b * 12 / 100, ..BeamCfg::default() }, Some(&fit)) {
                Err(_) if self.stop() => return Ok(Vec::new()),
                r => r?,
            }
        };
        let real_end = self.spent() + b * 15 / 100;
        // Each class's best leaf first, sharing the time to the hard cap equally (a class's later leaves stop inside
        // their grow/items steps at the phase mark): every class reaches the finals as a realized build.
        let mut classes: Vec<usize> = Vec::new();
        let mut order: Vec<(&Beam, bool)> = Vec::new();
        for leaf in &leaves {
            if !classes.contains(&leaf.st.class) {
                classes.push(leaf.st.class);
                order.push((leaf, true));
            }
        }
        let rest: Vec<(&Beam, bool)> = leaves.iter().filter(|l| !order.iter().any(|(o, _)| std::ptr::eq(*o, *l))).map(|l| (l, false)).collect();
        order.extend(rest);
        let mut firsts_left = classes.len();
        let mut out = Vec::new();
        for (leaf, first) in order {
            if self.stop() || (!first && self.spent() >= real_end) {
                break;
            }
            self.layer = "expert: realize".into();
            self.current = self.ctx[leaf.st.class].label.clone();
            self.publish();
            self.phase_end.set(if first {
                firsts_left -= 1;
                self.spent() + hard.saturating_sub(self.spent()) / (firsts_left + 1) as u64
            } else {
                real_end.min(hard)
            });
            let st = self.realize(&roots[leaf.root], leaf);
            self.phase_end.set(hard);
            let st = match st {
                Err(_) if self.stop() => break,
                r => r?,
            };
            self.archive_add(&st)?;
            out.push(st);
        }
        Ok(out)
    }

    /// A beam leaf as a real build: its mod-line and gear picks written into the crafted rares of their slots (the
    /// top-craft path, `CraftRules`), then the free ascendancy and passive points grown and the open affixes filled
    /// greedily, the way the scout does. Picks that found no slot are dropped from the result's part list.
    fn realize(&mut self, r: &BeamRoot, leaf: &Beam) -> Result<State, String> {
        debug_assert!(leaf.holds.is_empty(), "a leaf with placeholder lines");
        let mut st = leaf.st.clone();
        let mut gear = (*st.gear).clone();
        let mut fixed: Vec<(usize, String)> = Vec::new();
        let mut parts = Vec::new();
        for &(pi, g) in &leaf.gains {
            let p = &r.parts[pi as usize];
            let placed = match &p.kind {
                PartKind::ModLine { text, slots, .. } => self.place_line(&mut gear, text, slots, None, &mut fixed)?,
                PartKind::Gear(gp) => self.place_line(&mut gear, &gp.text, &gp.slots, Some(gp), &mut fixed)?,
                _ => true,
            };
            if placed {
                parts.push((p.label.clone(), g));
            }
        }
        st.gear = Arc::new(gear);
        st.parts = Arc::new(parts);
        self.rebase(&mut st)?;
        self.grow(&mut st, true)?;
        self.grow(&mut st, false)?;
        // the slot plan primes for what the leaf is built around
        self.lead_hint = leaf.lead.clone();
        let items = self.items_layer(&mut st, false);
        self.lead_hint.clear();
        items?;
        Ok(st)
    }

    /// Writes one line (all lines of a family) onto the crafted rare of one of `slots`: on the item's base, else on
    /// another base the slot takes, as a top craft (`base_craft`, with the line's influence) when the goal allows it.
    /// The item's other lines stay when they still fit; a line placed for an earlier pick (`fixed`) is never pushed
    /// out. False: no slot could take it.
    fn place_line(&mut self, gear: &mut Gear, text: &str, slots: &[usize], gp: Option<&GearPart>, fixed: &mut Vec<(usize, String)>) -> Result<bool, String> {
        let mut order = slots.to_vec();
        order.sort_by_key(|&i| self.slots[i].kind == SlotKind::TreeJewel);
        for i in order {
            let Some(Design::Craft { base, mods, anoint }) = gear.pieces[i].as_ref().map(|p| p.design.clone()) else { continue };
            let mut names = vec![base.name.clone()];
            names.extend(self.slot_bases(i).into_iter().filter(|n| *n != base.name));
            for name in names {
                let mut inf: Vec<String> = if name == base.name { base.influences.clone() } else { Vec::new() };
                if let Some(x) = gp.and_then(|g| g.influence.clone()) {
                    if !inf.contains(&x) {
                        inf.push(x);
                    }
                }
                let cb = if self.rules.craft_top() {
                    match self.base_craft(&name, &inf) {
                        Ok(b) => b,
                        Err(_) => continue,
                    }
                } else if gp.is_none() {
                    self.base(&name)?
                } else {
                    continue;
                };
                let want = |f: &Fam| f.lines.join("\n") == text && gp.is_none_or(|g| f.source == g.source && f.influence == g.influence && f.implicit == (g.side == Side::Implicit));
                let Some(f) = cb.fams.iter().position(want) else { continue };
                let mut m: Vec<usize> = Vec::new();
                for &x in &mods {
                    if let Some(nx) = cb.fams.iter().position(|y| y.key == base.fams[x].key) {
                        if addable(&cb, &m, nx) {
                            m.push(nx);
                        }
                    }
                }
                if fixed.iter().any(|(s, k)| *s == i && !m.iter().any(|&x| cb.fams[x].key == *k)) {
                    continue;
                }
                if !m.contains(&f) {
                    while !addable(&cb, &m, f) {
                        let free = |x: usize| !fixed.contains(&(i, cb.fams[x].key.clone()));
                        let (ff, fx) = (&cb.fams[f], |x: usize| &cb.fams[x]);
                        let k = m.iter().position(|&x| free(x) && fx(x).group == ff.group && fx(x).implicit == ff.implicit).or_else(|| m.iter().rposition(|&x| free(x) && !fx(x).implicit && !ff.implicit && fx(x).prefix == ff.prefix));
                        let Some(k) = k else { break };
                        m.remove(k);
                    }
                    if !addable(&cb, &m, f) {
                        continue;
                    }
                    m.push(f);
                }
                let an = if cb.anoints.is_empty() { None } else { anoint.clone() };
                let Some(g) = self.with_piece(gear, i, Some(craft_piece(&cb, m, an, self.item_level))) else { continue };
                *gear = g;
                fixed.push((i, cb.fams[f].key.clone()));
                // The quick modifier rounds keep what they measured on the item's old base.
                let (old, new) = ((i, rank_key(&base)), (i, rank_key(&cb)));
                if old != new && !self.ranks.contains_key(&new) {
                    if let Some(rk) = self.ranks.get(&old) {
                        let v = cb.fams.iter().map(|y| base.fams.iter().position(|x| x.key == y.key).and_then(|k| rk.get(k).copied()).unwrap_or(f64::NAN)).collect();
                        self.ranks.insert(new, v);
                    }
                }
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A bare Boneshatter Slayer with ten parts (crit notables, multi notables, flat physical lines, two others): the
    /// beam's best leaf holds a crit part and a multi part, while one-step greedy (width 1) takes a flat one first.
    /// Then a default-width beam over the full catalog of the same state, with its eval count and wall time.
    #[test]
    fn beam_crit_multi_over_greedy() {
        let goal = r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":1000000},{"name":"EHP","metric":"ehp","value":50000}],"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"]}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":6000000,"maxEvals":40000000}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let ci = s.candidates().unwrap()[0];
        let mut st = s.initial_state(ci, None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();
        let mut scouted = st.clone();
        s.grow(&mut scouted, false).unwrap();
        let lambda = s.lambda(&st, &scouted);
        eprintln!("lambda {lambda:.5} (scouted {} points, relaxed {:.4} -> {:.4}), {} threads", s.used(&scouted).0, s.relaxed_score(&st.vals, false), s.relaxed_score(&scouted.vals, false), s.pool.threads);

        // The fixed parts, two picks allowed: crit (the 2 nearest crit-chance notables without accuracy, and a gear line),
        // multi (the same for crit multiplier), 2 flat physical lines, life, a resist. Crit and multi each pay little
        // alone (5% base crit); together they pay more than both flat lines.
        let c = &s.ctx[ci];
        let tree = crate::cached_tree(&tag_attr(&c.xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())).unwrap();
        let stats = |id: i64| tree.nodes.get(&id).and_then(|n| n.get("stats")).map(|v| pom_passives::treedata::str_list(tree.deref(v)).join(" / ")).unwrap_or_default();
        let cat = s.part_catalog(ci);
        let mut notables: Vec<(usize, i64, String)> = cat.iter().filter_map(|p| match p.kind { PartKind::Node(id) if c.kind(id) == "Notable" => Some((p.cost, id, p.label.clone())), _ => None }).collect();
        notables.sort_unstable();
        let pick = |want: &str, not: &str| -> Vec<(usize, i64, String)> { notables.iter().filter(|(_, id, _)| { let t = stats(*id); t.contains(want) && !t.contains(not) && !t.contains("Accuracy") }).take(2).cloned().collect() };
        let node = |(cost, id, label): (usize, i64, String)| Part { kind: PartKind::Node(id), label, excl: Vec::new(), cost };
        let line = |t: &str| Part { kind: PartKind::ModLine { text: t.into(), slots: Vec::new(), prefix: true }, label: t.into(), excl: Vec::new(), cost: 0 };
        let mut parts: Vec<Part> = pick("Critical Strike Chance", "Multiplier").into_iter().map(node).collect();
        parts.push(line("200% increased Critical Strike Chance"));
        parts.extend(pick("Critical Strike Multiplier", "Critical Strike Chance").into_iter().map(node));
        parts.push(line("+100% to Critical Strike Multiplier"));
        parts.push(line("Adds 25 to 50 Physical Damage to Attacks"));
        parts.push(line("Adds 12 to 24 Physical Damage to Attacks"));
        parts.push(line("+40 to maximum Life"));
        parts.push(line("+20% to Fire Resistance"));
        for p in &parts {
            let id = if let PartKind::Node(id) = p.kind { stats(id) } else { String::new() };
            eprintln!("  part {:30} cost {:2}  {id}", p.label, p.cost);
        }

        let sens = s.sensitivity(&st).unwrap();
        let (prime_axes, primes) = (convex_axes(&sens, 4), convex_primes(&sens, 4));
        let screen = s.screen(&st, &parts, &primes, u64::MAX).unwrap();
        for (i, p) in parts.iter().enumerate() {
            eprintln!("  screen {:30} root {:+.4} primed {:?}", p.label, screen.root[i], screen.primed.iter().map(|r| format!("{:+.4}", r[i])).collect::<Vec<_>>());
        }
        eprintln!("primed axes: {:?}", prime_axes.iter().map(|&i| AXES[i].name).collect::<Vec<_>>());
        let roots = [BeamRoot { st: st.clone(), parts, screen, prime_axes, lambda }];
        let show = |b: &Beam| b.gains.iter().map(|&(p, g)| format!("{} {g:+.4}", roots[0].parts[p as usize].label)).collect::<Vec<_>>();
        let cfg = BeamCfg::default();
        let two = BeamCfg { depth: 2, ..cfg.clone() };
        let leaves = s.beam(&roots, &two, None).unwrap();
        let greedy = s.beam(&roots, &BeamCfg { width: 1, ..two.clone() }, None).unwrap();
        let best = &leaves[0];
        eprintln!("beam best leaf: bscore {:.4} {:?}", best.bscore, show(best));
        eprintln!("greedy:         bscore {:.4} {:?}", greedy[0].bscore, show(&greedy[0]));
        // With the blend ratio a function of the base alone (solver.rs `eval_blended`), the same text scores the same in both runs,
        // and the crit+multi pair is again this state's best two picks: the beam finds it and never ends below greedy
        // (greedy may find it too: before, its lower score was the stale ratio's noise).
        let labels: Vec<&str> = best.picks.iter().map(|&p| roots[0].parts[p as usize].label.as_str()).collect();
        assert!(labels.iter().any(|l| l.contains("Critical Strike Chance")) && labels.iter().any(|l| l.contains("Critical Strike Multiplier")), "the beam missed the crit+multi pair: {:?}", show(best));
        assert!(best.bscore >= greedy[0].bscore - 1e-9, "greedy beat the beam: {:?}", show(&greedy[0]));

        // Default-width beam over the full catalog of the same state (one class, so all 20 states go to it).
        let mut parts = s.part_catalog(ci);
        parts.extend(s.cluster_parts(&st).unwrap());
        let (e0, t) = (s.evals.load(Ordering::Relaxed), Instant::now());
        let screen = s.screen(&st, &parts, &primes, u64::MAX).unwrap();
        eprintln!("full screen: {} parts, {} evals, {:.1} s", parts.len(), s.evals.load(Ordering::Relaxed) - e0, t.elapsed().as_secs_f64());
        let roots = [BeamRoot { st: st.clone(), parts, screen, prime_axes: roots[0].prime_axes.clone(), lambda }];
        let (e0, t) = (s.evals.load(Ordering::Relaxed), Instant::now());
        let leaves = s.beam(&roots, &BeamCfg { per_class: 20, ..cfg }, None).unwrap();
        eprintln!("full beam: {} evals, {:.1} s, {} leaves", s.evals.load(Ordering::Relaxed) - e0, t.elapsed().as_secs_f64(), leaves.len());
        for b in &leaves {
            eprintln!("  leaf bscore {:.4} relaxed {:.4} lead {:?}: {:?}", b.bscore, b.score, b.lead.iter().map(|&i| AXES[i].name).collect::<Vec<_>>(), b.gains.iter().map(|&(p, g)| format!("{} {g:+.4}", roots[0].parts[p as usize].label)).collect::<Vec<_>>());
        }
    }
    /// Spark of the Nova (Occultist), full catalog: the beam enters the scan's lightning-to-chaos + poison route with
    /// its lines as placeholders, real parts replace every placeholder line, and no leaf holds a placeholder. Prints
    /// the best route leaf's real DPS against the best leaf of the same beam without routes (not asserted: on this
    /// state the engine has the route behind the plain lightning leaves).
    #[test]
    fn beam_route_placeholders_spark() {
        let goal = r#"{"skill":"Spark of the Nova","ascendancy":"Occultist","level":90,"targets":[{"name":"DPS","value":1000000},{"name":"EHP","metric":"ehp","value":50000}],"items":{"rarities":["rare","unique"],"mustUse":[],"neverUse":[],"lockSlots":[]}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":6000000,"maxEvals":40000000,"threads":6}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let ci = s.candidates().unwrap()[0];
        let mut st = s.initial_state(ci, None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();
        let mut scouted = st.clone();
        s.grow(&mut scouted, false).unwrap();
        let lambda = s.lambda(&st, &scouted) / 2.0;
        let sens = s.sensitivity_full(&st).unwrap();
        let (prime_axes, primes) = (convex_axes(&sens, 6), convex_primes(&sens, 6));
        eprintln!("prime rows: {:?}", prime_axes.iter().map(|&i| AXES[i].name).collect::<Vec<_>>());
        let route = prime_axes.iter().copied().find(|&i| AXES[i].route && AXES[i].commit.iter().any(|l| l.contains("Lightning Damage Converted to Chaos")) && AXES[i].pair.iter().any(|l| l.contains("Poison"))).expect("the lightning-to-chaos + poison route in the prime rows");
        let parts = s.part_catalog(ci);
        let (e0, t) = (s.evals.load(Ordering::Relaxed), Instant::now());
        let screen = s.screen(&st, &parts, &primes, u64::MAX).unwrap();
        eprintln!("screen: {} parts, {} evals, {:.1} s", parts.len(), s.evals.load(Ordering::Relaxed) - e0, t.elapsed().as_secs_f64());
        let roots = [BeamRoot { st: st.clone(), parts, screen, prime_axes, lambda }];
        let dps_i = s.scorer.names.iter().position(|n| n == "CombinedDPS").unwrap();
        let dps = |b: &Beam| b.st.vals.get(dps_i).copied().flatten().unwrap_or(0.0);
        let label = |p: u16| roots[0].parts[p as usize].label.clone();
        let show = |b: &Beam| b.gains.iter().map(|&(p, g)| format!("{} {g:+.3}", label(p))).collect::<Vec<_>>();
        let cfg = BeamCfg { per_class: 20, ..BeamCfg::default() };

        let run = |cfg: &BeamCfg| {
            let (e0, t) = (s.evals.load(Ordering::Relaxed), Instant::now());
            let leaves = s.beam(&roots, cfg, None).unwrap();
            eprintln!("beam (holds {}): {} evals, {:.1} s, {} leaves", cfg.holds, s.evals.load(Ordering::Relaxed) - e0, t.elapsed().as_secs_f64(), leaves.len());
            for b in leaves.iter().filter(|b| cfg.holds == 0 || !b.routes.is_empty()).take(12) {
                eprintln!("  leaf bscore {:.3} DPS {:.0} routes {:?}: {:?}", b.bscore, dps(b), b.routes.iter().map(|&i| AXES[i].name).collect::<Vec<_>>(), show(b));
            }
            leaves
        };
        let plain = run(&BeamCfg { holds: 0, ..cfg.clone() });
        let with = run(&BeamCfg { leaves: 1000, leaves_per_class: 1000, ..cfg });
        assert!(with.iter().all(|b| b.holds.is_empty()), "a placeholder reached a leaf");
        let best_plain = plain.iter().map(|b| dps(b)).fold(0.0, f64::max);
        let routed: Vec<&Beam> = with.iter().filter(|b| b.routes.contains(&route)).collect();
        let r = routed.iter().max_by(|a, b| dps(a).total_cmp(&dps(b))).expect("no leaf entered the route");
        eprintln!("route {:?} entered; placeholders replaced:", AXES[route].name);
        for (p, lines) in &r.swaps {
            eprintln!("  {} replaced {:?}", label(*p), lines);
        }
        eprintln!("best route leaf DPS {:.0} (bscore {:.3}) vs best leaf without routes DPS {:.0} (bscore {:.3}): x{:.2}", dps(r), r.bscore, best_plain, plain[0].bscore, dps(r) / best_plain.max(1.0));
        let n: usize = AXES[route].commit.len();
        assert_eq!(r.swaps.iter().map(|(_, l)| l.len()).sum::<usize>(), n, "not every placeholder line was replaced by a real part");
    }

    /// The time cap reached inside a class's measurement is a cut, not a failure: the expert phase returns no leaves
    /// (the scouted states stand) instead of failing the whole solve with "probe base did not evaluate".
    #[test]
    fn expert_cut_by_cap_is_not_an_error() {
        let goal = r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":100000000}],"limits":{"cost":false,"pool":null,"resists":null,"attributes":false},"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"]}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":900000,"maxEvals":600000,"threads":2}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        let st = s.initial_state(cands[0], None, None).unwrap();
        s.phase_end.set(s.spent() + 150); // the cap falls inside the class's sensitivity batch: its evaluations read None
        let r = s.expert_inner(&[st], 0);
        assert!(r.as_ref().is_ok_and(|v| v.is_empty()), "cut expert phase: {:?}", r.err());
    }

    /// A crit-led leaf realized: the slot plan gets the leaf's lead axes, and top mode builds crafted top bases in the
    /// plan, the item kick and the base pass (not the basic bases).
    #[test]
    fn realize_crit_leaf_plans_top_gear() {
        let goal = r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":100000000}],"limits":{"cost":false,"pool":null,"resists":null,"attributes":false},"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"]}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":900000,"maxEvals":600000,"threads":6}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        let mut st = s.initial_state(cands[0], None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();
        let ax = |n: &str| AXES.iter().position(|a| a.name == n).unwrap();
        let lead = vec![ax("base crit chance"), ax("increased crit chance"), ax("crit multiplier")];
        let screen = s.screen(&st, &[], &[], u64::MAX).unwrap();
        let root = BeamRoot { st: st.clone(), parts: Vec::new(), screen, prime_axes: Vec::new(), lambda: 0.0 };
        let sens = s.sensitivity(&st).unwrap();
        let leaf = Beam { root: 0, picks: Vec::new(), gains: Vec::new(), st: st.clone(), lines: Vec::new(), sens, lead: lead.clone(), score: st.score, bscore: st.score, holds: Vec::new(), routes: Vec::new(), swaps: Vec::new(), rank: st.score };
        s.plan_lead.clear();
        let mut out = s.realize(&root, &leaf).unwrap();
        let names = |l: &[usize]| l.iter().map(|&i| AXES[i].name).collect::<Vec<_>>();
        eprintln!("leaf lead {:?}; slot plan lead {:?}", names(&lead), names(&s.plan_lead));
        assert_eq!(s.plan_lead, lead);
        let show = |p: &crate::solver::items::Piece| p.xml.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        let tops = |g: &State| g.gear.pieces.iter().flatten().filter_map(|p| p.base().map(|b| (p.label.clone(), b.top, b.influences.clone()))).collect::<Vec<_>>();
        let amu = s.slot_of(SlotKind::Amulet).unwrap();
        eprintln!("realized amulet:\n{}", show(out.gear.pieces[amu].as_ref().unwrap()));
        assert!(tops(&out).iter().all(|t| t.1), "basic base after realize: {:?}", tops(&out));
        // item kick: a crafted slot made again; the first picks that change an item
        let before = tops(&out);
        let mut kicked = None;
        for pick in (1..=6u64).map(|k| k * 53) {
            let k = s.item_kick(&out, pick).unwrap();
            assert!(tops(&k).iter().all(|t| t.1), "basic base after kick (pick {pick})");
            if let Some(i) = (0..k.gear.pieces.len()).find(|&i| k.gear.pieces[i].as_ref().map(|p| &p.xml) != out.gear.pieces[i].as_ref().map(|p| &p.xml)) {
                kicked = Some(show(k.gear.pieces[i].as_ref().unwrap()));
                break;
            }
        }
        eprintln!("kicked item:\n{}", kicked.expect("a kick that changed an item"));
        // base pass: other bases keep the influence and stay top crafts
        let moved = s.base_pass(&mut out).unwrap();
        let after = tops(&out);
        eprintln!("base pass took a better base: {moved}\nbefore {before:?}\nafter  {after:?}");
        assert!(after.iter().all(|t| t.1), "basic base after base pass");
    }

}
