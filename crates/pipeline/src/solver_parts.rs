//! The solver's part catalog: every build-defining
//! choice one class context offers, each with what it excludes and what it costs in passive points. Built from the
//! solver's own data (`ClassCtx`, `catalog`, `unique_list`, base families), no new parsers.

use super::items::{slot_types, SlotKind, SocketItem, UniqueInfo};
use super::*;

/// What a part takes up: two parts that share any `Excl` cannot both be picked.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(super) enum Excl {
    /// Equipment slot (index into `Solver::slots`). A two-hand weapon also holds the off hand's slot.
    Slot(usize),
    /// A unique item, by name (the same unique cannot be worn twice).
    Unique(String),
    MasteryNode(i64),
    MasteryEffect(i64),
    /// The amulet's one anoint.
    Anoint,
    /// One of the main skill's links (the consumer counts the cap).
    Link,
    /// One side of a synergy-scan conflict (engine-data/synergies.json): opposite sides clash (`Excl::clashes`).
    Conflict(u32, bool),
}

pub(super) enum PartKind {
    /// Notable or keystone of the main tree.
    Node(i64),
    /// (mastery node, effect id)
    Mastery(i64, i64),
    /// Notable of the class context's own ascendancy.
    Asc(i64),
    /// (notable name, node id) oiled onto the amulet.
    Anoint(String, i64),
    Unique { slot: usize, u: Arc<UniqueInfo> },
    Support(&'static str),
    /// A rare modifier family (all its lines) that can roll on `slots`; slot-agnostic until scored.
    ModLine { text: String, slots: Vec<usize>, prefix: bool },
    /// A large cluster jewel design (socket, item, allocated passives) from `cluster_designs`.
    Cluster(SocketItem),
    /// A line only a top craft holds (influenced, eldritch, corruption), from `gear_parts` (solver_gearparts.rs).
    Gear(super::gearparts::GearPart),
}

pub(super) struct Part {
    pub kind: PartKind,
    pub label: String,
    pub excl: Vec<Excl>,
    /// Passive points from an empty tree (class start / ascendancy start); 0 for gear and gems. The beam re-prices
    /// node parts against its own tree with `ClassCtx::bfs`.
    pub cost: usize,
}

impl Solver {
    /// Every part class context `ci` can use. Unreachable tree nodes are left out.
    pub(super) fn part_catalog(&self, ci: usize) -> Vec<Part> {
        let c = &self.ctx[ci];
        let tree = crate::cached_tree(&tag_attr(&c.xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())).ok();
        let name = |id: i64| tree.and_then(|t| t.nodes.get(&id)).and_then(|n| n.get("name")).and_then(|n| n.as_str()).map_or_else(|| format!("node {id}"), String::from);
        let none: HashSet<i64> = HashSet::default();
        let mut out = Vec::new();
        let downside = self.downside(ci);

        // Tree: notables, keystones and mastery effects of the main tree, and the context's ascendancy notables.
        let main = c.bfs(&none, false);
        let asc = c.bfs(&none, true);
        let mut ids: Vec<i64> = c.paths.nodes.keys().copied().collect();
        ids.sort_unstable();
        for id in ids {
            let n = &c.paths.nodes[&id];
            if (!n.has_mods && n.kind != "Mastery") || downside.0.contains(&id) {
                continue;
            }
            match n.kind.as_str() {
                "Notable" | "Keystone" if c.allowed_main(id) => {
                    if let Some(&(d, _)) = main.get(&id) {
                        out.push(Part { kind: PartKind::Node(id), label: name(id), excl: Vec::new(), cost: d });
                    }
                }
                "Notable" if c.allowed_asc(id) => {
                    if let Some(&(d, _)) = asc.get(&id) {
                        out.push(Part { kind: PartKind::Asc(id), label: name(id), excl: Vec::new(), cost: d });
                    }
                }
                "Mastery" if c.allowed_main(id) => {
                    if let Some(&(d, _)) = main.get(&id) {
                        for &e in n.mastery_effects.iter().filter(|e| !downside.1.contains(e)) {
                            out.push(Part { kind: PartKind::Mastery(id, e), label: format!("{} effect {e}", name(id)), excl: vec![Excl::MasteryNode(id), Excl::MasteryEffect(e)], cost: d });
                        }
                    }
                }
                _ => {}
            }
        }

        // Supports for the main skill (the gem layer's delivery filter: no trigger, trap, mine or totem the skill is not).
        let tag = |id: &str, t: &str| gd::game_data().gems.get(id).is_some_and(|g| g.tags.get(t).copied().unwrap_or(false));
        let delivery = |id: &str| ["trigger", "trap", "mine", "totem"].iter().any(|t| tag(id, t) && !tag(self.main_gem, t));
        for g in self.gems.iter().filter(|g| g.kind == Kind::Support && g.id != self.main_gem && (!delivery(g.id) || self.required.contains(&g.id))) {
            out.push(Part { kind: PartKind::Support(g.id), label: g.name.clone(), excl: vec![Excl::Link], cost: 0 });
        }

        // Uniques, once per slot they fit (the slot is part of the choice). A two-hand weapon also holds Weapon 2.
        let w2 = self.slot_of(SlotKind::Weapon2);
        for (i, d) in self.slots.iter().enumerate() {
            if d.locked || d.kind == SlotKind::TreeJewel {
                continue;
            }
            let types = slot_types(d.kind);
            // (the uniques and their Foulborn forms)
            for u in self.uniques.iter().flat_map(|u| std::iter::once(u).chain(u.variants.iter().filter(|v| v.label.starts_with("Foulborn ")))) {
                if !types.contains(&u.item_type.as_str()) || (d.kind == SlotKind::Weapon1 && !self.weapon_ok(&u.item_type)) || (d.kind == SlotKind::Abyss) != (u.sub_type == "Abyss") {
                    continue;
                }
                let mut excl = vec![Excl::Slot(i), Excl::Unique(u.name.clone())];
                if u.two_hand && d.kind == SlotKind::Weapon1 {
                    excl.extend(w2.map(Excl::Slot));
                }
                let nm = if u.label.starts_with("Foulborn ") { u.label.trim_end_matches(" (unique)") } else { u.name.as_str() };
                out.push(Part { kind: PartKind::Unique { slot: i, u: u.clone() }, label: format!("{nm} ({})", d.name), excl, cost: 0 });
            }
        }

        // Anoints: every notable an amulet base can take.
        let amulet = self.slot_of(SlotKind::Amulet).filter(|&i| !self.slots[i].locked && self.rules.anoint != Some(false));
        if let Some(i) = amulet {
            let mut seen: HashSet<i64> = HashSet::default();
            for b in self.slot_bases(i) {
                for (node, n) in self.base(&b).map(|b| b.anoints.clone()).unwrap_or_default() {
                    if seen.insert(node) {
                        out.push(Part { kind: PartKind::Anoint(n.clone(), node), label: format!("anoint {n}"), excl: vec![Excl::Anoint], cost: 0 });
                    }
                }
            }
        }

        // Rare modifier families, one part per family, with every slot whose bases can roll it.
        let mut lines: Vec<(String, Vec<usize>, bool)> = Vec::new();
        let mut at: HashMap<String, usize> = HashMap::default();
        for (i, d) in self.slots.iter().enumerate() {
            if d.locked || matches!(d.kind, SlotKind::Flask | SlotKind::Abyss) {
                continue;
            }
            for b in self.slot_bases(i) {
                let Ok(b) = self.base(&b) else { continue };
                for f in &b.fams {
                    let k = *at.entry(f.key.clone()).or_insert_with(|| {
                        lines.push((f.lines.join("\n"), Vec::new(), f.prefix));
                        lines.len() - 1
                    });
                    if !lines[k].1.contains(&i) {
                        lines[k].1.push(i);
                    }
                }
            }
        }
        for (text, slots, prefix) in lines {
            out.push(Part { label: text.replace('\n', " / "), kind: PartKind::ModLine { text, slots, prefix }, excl: Vec::new(), cost: 0 });
        }
        out
    }
}

/// What every part is worth to one state: by the engine, at the state and in each primed state (the state plus a
/// committed package of an axis, see solver_sens.rs). All vectors are indexed like the `parts` passed to `screen`; a part
/// that cannot be applied (already there, does not fit the gear, did not evaluate) is worth 0.
pub(super) struct Screen {
    pub root: Vec<f64>,
    /// `primed[k][i]`: part `i` in the state primed with `primes[k]`, minus that primed state without it.
    pub primed: Vec<Vec<f64>>,
    pub evals: u64,
}

fn lead_num(s: &str) -> f64 {
    let a = s.find(|c: char| c.is_ascii_digit()).unwrap_or(0);
    let b = s[a..].find(|c: char| !c.is_ascii_digit() && c != '.').map_or(s.len(), |i| a + i);
    s[a..b].parse().unwrap_or(1.0)
}

/// The committed packages of the `n` axes that pay most beyond their slope (committed gain minus marginal gain scaled
/// by the size of the commitment): the states worth pricing parts in. Axes that pay no more than their slope are left out.
pub(super) fn convex_primes(sens: &sens::Sens, n: usize) -> Vec<Vec<&'static str>> {
    convex_rows(sens, n).into_iter().map(|(_, l)| l.to_vec()).collect()
}

/// The `AXES` indexes behind `convex_primes`, in the same order (a joint axis twice).
pub(super) fn convex_axes(sens: &sens::Sens, n: usize) -> Vec<usize> {
    convex_rows(sens, n).into_iter().map(|(i, _)| i).collect()
}

/// At most `n` primed states: a plain axis by what its commitment pays beyond its slope, a joint axis (route, stacking)
/// by its synergy, primed whole and with only its enabling half (`Axis::pair`). The best of each family (plain, route,
/// stacking) comes first, so one family cannot take every row; then the rest by value.
pub(super) fn convex_rows(sens: &sens::Sens, n: usize) -> Vec<(usize, &'static [&'static str])> {
    let ax = &*sens::AXES;
    let mut v: Vec<(f64, usize)> = sens
        .axes
        .iter()
        .enumerate()
        .map(|(k, &i)| (if ax[i].pair.is_empty() { sens.committed[k] - lead_num(ax[i].commit[0]) / lead_num(ax[i].unit[0]) * sens.marginal[k] } else { sens.synergy.get(k).copied().unwrap_or(0.0) }, i))
        .filter(|x| x.0 > 0.0)
        .collect();
    v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let family = |i: usize| if ax[i].pair.is_empty() { 0 } else if ax[i].route { 1 } else { 2 };
    let mut lead: Vec<(f64, usize)> = Vec::new();
    for f in 0..3 {
        lead.extend(v.iter().find(|x| family(x.1) == f).copied());
    }
    lead.sort_by(|a, b| b.0.total_cmp(&a.0));
    v.retain(|x| !lead.contains(x));
    lead.extend(v);
    let v = lead;
    let mut rows = Vec::new();
    for (_, i) in v {
        let need = if ax[i].pair.is_empty() { 1 } else { 2 };
        if !rows.is_empty() && rows.len() + need > n {
            continue;
        }
        rows.push((i, ax[i].commit));
        if need == 2 {
            rows.push((i, ax[i].pair));
        }
    }
    rows
}

/// The leads' route rows (at most `n`, more only for the reservations): defence axes take none; each joint family
/// (crit, conversion, transfer, stacking, ailment) that pays beyond its halves keeps a row pair for its best axis, best
/// first; then the best plain axis; then the rest by value while rows are left.
pub(super) fn lead_rows(sens: &sens::Sens, n: usize) -> Vec<(usize, &'static [&'static str])> {
    use sens::Family as F;
    let ax = &*sens::AXES;
    let mut v: Vec<(f64, usize)> = sens
        .axes
        .iter()
        .enumerate()
        .filter(|(_, &i)| ax[i].family != F::Defence)
        .map(|(k, &i)| (if ax[i].pair.is_empty() { sens.committed[k] - lead_num(ax[i].commit[0]) / lead_num(ax[i].unit[0]) * sens.marginal[k] } else { sens.synergy.get(k).copied().unwrap_or(0.0) }, i))
        .filter(|x| x.0 > 0.0)
        .collect();
    v.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut order: Vec<(f64, usize)> = Vec::new();
    for f in [F::Crit, F::Conversion, F::Transfer, F::Stacking, F::Ailment] {
        order.extend(v.iter().find(|x| ax[x.1].family == f && !ax[x.1].pair.is_empty()).copied());
    }
    order.sort_by(|a, b| b.0.total_cmp(&a.0));
    let reserved = order.len();
    order.extend(v.iter().find(|x| ax[x.1].pair.is_empty()).copied());
    v.retain(|x| !order.contains(x));
    order.extend(v);
    let mut rows = Vec::new();
    for (k, (_, i)) in order.into_iter().enumerate() {
        let need = if ax[i].pair.is_empty() { 1 } else { 2 };
        if k >= reserved && !rows.is_empty() && rows.len() + need > n.max(2 * reserved + 1) {
            continue;
        }
        rows.push((i, ax[i].commit));
        if need == 2 {
            rows.push((i, ax[i].pair));
        }
    }
    rows
}

/// What a keystone makes dead: (keystone, words of a line it nullifies, words that spare the line anyway). Lowercase.
const DEAD_UNDER: &[(&str, &[&str], &[&str])] = &[
    ("Resolute Technique", &["critical strike", "accuracy"], &[]),
    ("Elemental Overload", &["critical strike multiplier"], &[]),
    ("Roiling Tempest", &["fire damage", "cold damage", "chaos damage", "physical damage", "penetrate"], &["lightning", "reduction", "taken", "converted"]),
];

/// Whether a line is worthless under one of the allocated keystones (the engine zeroes such lines in a state that
/// has the keystone; this keeps them out of states that get it later and out of primed screens). The mods the
/// synergy scan found dead under the keystone (engine-data/synergies.json) or `DEAD_UNDER` says so.
/// shortcut: `DEAD_UNDER` stays until the scan is shown to cover every line it names; then drop it.
pub(super) fn line_is_dead(keystones: &[String], text: &str) -> bool {
    // (a line of several: dead only when every line is)
    text.split('\n').all(|l| {
        let t = l.to_lowercase();
        keystones.iter().any(|k| super::synergy::dead_mods(k).is_some_and(|d| super::synergy::line_dead_by(d, l)) || DEAD_UNDER.iter().any(|(n, hit, spare)| n == k && hit.iter().any(|w| t.contains(w)) && !spare.iter().any(|w| t.contains(w))))
    })
}

fn part_is_dead(keystones: &[String], p: &Part) -> bool {
    match &p.kind {
        PartKind::ModLine { text, .. } | PartKind::Gear(super::gearparts::GearPart { text, .. }) => line_is_dead(keystones, text),
        _ => false,
    }
}

impl Solver {
    /// Names of the keystones `st` has allocated that kill some lines (synergies.json `dead`, or `DEAD_UNDER`).
    pub(super) fn allocated_keystones(&self, st: &State) -> Vec<String> {
        let Ok(tree) = crate::cached_tree(&tag_attr(&self.ctx[st.class].xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())) else { return Vec::new() };
        st.nodes.iter().filter_map(|id| tree.nodes.get(id)?.get("name")?.as_str()).filter(|n| DEAD_UNDER.iter().any(|d| d.0 == *n) || super::synergy::dead_mods(n).is_some()).map(String::from).collect()
    }

    /// `Scorer::score` for screening and the beam: without the limits the finishing layers repair cheaply (resist and
    /// attribute floors, the life-and-ES floor) and, unless `keep_cost`, without the skill-cost limits (the gem layer
    /// repairs those with cost fixers; they punish any part that raises the skill's cost per second, such as attack
    /// speed or gem levels). Reservation and target limits stay.
    pub(super) fn relaxed_score(&self, v: &[Option<f64>], keep_cost: bool) -> f64 {
        let sc = &self.scorer;
        let floor = |l: &LimitDef| match &l.check {
            Check::AtLeast(i, _) => matches!(sc.names[*i].strip_prefix(NO_FLASK).unwrap_or(&sc.names[*i]), "FireResist" | "ColdResist" | "LightningResist" | "Solver.Pool"),
            Check::Ge(_, b) => b.iter().any(|&i| sc.names[i].starts_with("Req")),
            Check::AtMost(..) => false,
        };
        let back: f64 = sc.deficits(v).iter().zip(&sc.limits).filter(|(_, l)| floor(l) || (l.cost && !keep_cost)).map(|(d, _)| d).sum();
        self.score(v).0 + sc.penalty * back
    }

    /// The candidate that evaluates `st` with part `p` added, under the extra probe lines `prime`. Node-like parts use
    /// the fast node path on `base` (the state's text with `prime`), the rest a whole text. None: not applicable.
    fn part_cand(&self, st: &State, base: &Arc<String>, prime: &[&str], p: &Part) -> Result<Option<Cand>, String> {
        let text = |s: &State, extra: &[&str]| -> Result<Option<Cand>, String> {
            let mut l = prime.to_vec();
            l.extend(extra);
            Ok(Some(Cand::Xml(Arc::new(if l.is_empty() { self.render(s)? } else { self.render_with_probe(s, &l)? }))))
        };
        let node = |id: i64, mastery: Option<(i64, i64)>| {
            let mut nodes = self.full_nodes(st);
            if !nodes.contains(&id) {
                nodes.push(id);
            }
            Some(Cand::Nodes { base: base.clone(), nodes, mastery, pin: vec![id] })
        };
        match &p.kind {
            // (a bloodline node: the build text names the bloodline, and the engine keeps it only with its path)
            PartKind::Asc(id) if self.ctx[st.class].blood_of(*id).is_some() && !st.nodes.contains(id) => {
                let c = &self.ctx[st.class];
                let reach = c.bfs(&st.nodes.iter().copied().collect(), true);
                if !reach.contains_key(id) {
                    return Ok(None);
                }
                text(&State { nodes: st.nodes.iter().copied().chain(c.path_to(&reach, *id)).collect(), ..st.clone() }, &[])
            }
            PartKind::Node(id) | PartKind::Asc(id) | PartKind::Anoint(_, id) => Ok(if st.nodes.contains(id) { None } else { node(*id, None) }),
            PartKind::Mastery(n, e) => Ok(node(*n, Some((*n, *e)))),
            PartKind::Unique { slot, u } => match self.with_piece(&st.gear, *slot, Some(items::unique_piece(u))) {
                Some(g) => text(&State { gear: Arc::new(g), ..st.clone() }, &[]),
                None => Ok(None),
            },
            PartKind::Support(id) if !st.main.contains(id) && !self.mana_clash(&st.main.iter().copied().chain([*id]).collect::<Vec<_>>()) => text(&State { main: st.main.iter().copied().chain([*id]).collect(), ..st.clone() }, &[]),
            PartKind::Support(_) => Ok(None),
            PartKind::ModLine { text: t, .. } | PartKind::Gear(super::gearparts::GearPart { text: t, .. }) => text(st, &t.split('\n').collect::<Vec<_>>()),
            #[allow(unreachable_patterns)]
            _ => Ok(None),
        }
    }

    /// Real evaluation of every part at `st` and in `st` primed with each of `primes` (probe lines, see
    /// `convex_primes`). One batch per base text: the state's node-list candidates share one session, whole-text
    /// candidates ride along. Gains are in `relaxed_score` units (cost limits off: see there).
    pub(super) fn screen(&self, st: &State, parts: &[Part], primes: &[Vec<&str>], until: u64) -> Result<Screen, String> {
        let e0 = self.evals.load(Ordering::Relaxed);
        let keystones = self.allocated_keystones(st);
        let mut gains: Vec<Vec<f64>> = Vec::new();
        for prime in std::iter::once(&Vec::new()).chain(primes) {
            let base = Arc::new(if prime.is_empty() { st.base.to_string() } else { self.render_with_probe(st, prime)? });
            // [0] base as a node list, [1] base as a whole text, then the parts that apply
            let mut cands = vec![Cand::Nodes { base: base.clone(), nodes: self.full_nodes(st), mastery: None, pin: Vec::new() }, Cand::Xml(base.clone())];
            let mut nodes: Vec<bool> = vec![true, false];
            let mut at: Vec<Option<usize>> = Vec::with_capacity(parts.len());
            // Chunks of 48: the first (base + leading parts) always runs, later ones only before `until`; the rest gain 0
            // and are not even built (building a part's text costs more than its evaluation once past the mark).
            let mut r: Vec<Option<Vals>> = Vec::new();
            let run = |chunk: Vec<Cand>, r: &mut Vec<Option<Vals>>| {
                if r.is_empty() {
                    let saved = self.ignore_budget.replace(true);
                    r.extend(self.eval(chunk));
                    self.ignore_budget.set(saved);
                } else if self.spent() < until {
                    r.extend(self.eval(chunk));
                } else {
                    r.extend(chunk.iter().map(|_| None));
                }
            };
            for p in parts {
                if !r.is_empty() && self.spent() >= until {
                    at.push(None);
                    continue;
                }
                let c = if part_is_dead(&keystones, p) { None } else { self.part_cand(st, &base, prime, p)? };
                at.push(c.map(|c| {
                    nodes.push(matches!(c, Cand::Nodes { .. }));
                    cands.push(c);
                    r.len() + cands.len() - 1
                }));
                if cands.len() == 48 {
                    run(std::mem::take(&mut cands), &mut r);
                }
            }
            if !cands.is_empty() {
                run(cands, &mut r);
            }
            let s = |i: usize| r[i].as_ref().map(|v| self.relaxed_score(v, false));
            // (a base that still does not evaluate, cancelled or broken, measures nothing: every gain 0)
            let (Some(bn), Some(bx)) = (s(0), s(1)) else {
                gains.push(vec![0.0; parts.len()]);
                continue;
            };
            gains.push(at.iter().map(|a| a.and_then(|i| s(i).map(|x| x - if nodes[i] { bn } else { bx })).unwrap_or(0.0)).collect());
        }
        let root = gains.remove(0);
        Ok(Screen { root, primed: gains, evals: self.evals.load(Ordering::Relaxed) - e0 })
    }
}

impl Solver {
    /// The top 5 large cluster jewel designs `cluster_pass` finds for `st`, as parts. They need a state to be built
    /// against (path to the socket, freed points), so they are not part of `part_catalog`. Cost = passives taken.
    pub(super) fn cluster_parts(&mut self, st: &State) -> Result<Vec<Part>, String> {
        let ji = self.slot_of(SlotKind::TreeJewel);
        let mut ds = self.cluster_designs(st)?;
        ds.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        Ok(ds
            .iter()
            .filter_map(|d| d.gear.sockets.iter().find(|s| !s.kept && !s.nodes.is_empty()))
            .map(|s| Part { label: format!("{} @{}", s.label, s.node), excl: ji.map(Excl::Slot).into_iter().collect(), cost: s.nodes.len(), kind: PartKind::Cluster(s.clone()) })
            .collect::<Vec<_>>()
            .into_iter()
            .fold(Vec::<Part>::new(), |mut v, p| {
                let same = |q: &Part| matches!((&q.kind, &p.kind), (PartKind::Cluster(a), PartKind::Cluster(b)) if a.node == b.node && a.xml == b.xml);
                if v.len() < 5 && !v.iter().any(same) {
                    v.push(p);
                }
                v
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pool shortfall on the default `NoFlask:Solver.Pool` floor is repaired by the finish, so screening ignores it.
    #[test]
    fn relaxed_score_ignores_noflask_pool_deficit() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Poisonous Concoction","level":90,"targets":[{"name":"DPS"}]}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let v: Vals = vec![None; s.scorer.names.len()];
        assert!(s.relaxed_score(&v, true) > s.score(&v).0 + 1e-9, "the pool deficit stays in the relaxed score");
    }

    /// Resolute Technique (never crits) pays at root and not in the crit-primed state; Chaos Inoculation loses less in
    /// the ES-primed state than at root. Also prints the cost-limit finding and the screen's time and top parts.
    #[test]
    fn screen_rt_ci() {
        let goal = r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":1000000},{"name":"EHP","metric":"ehp","value":50000}],"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"]}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":600000,"maxEvals":4000000,"threads":4}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let ci = s.candidates().unwrap()[0];
        let mut st = s.initial_state(ci, None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();

        // Why attack speed and gem levels score negative: the raw score against the same score with floors / cost limits added back.
        let ax = |n: &str| sens::AXES.iter().find(|a| a.name == n).unwrap();
        let vals = |lines: &[&str]| s.eval(vec![Cand::Xml(Arc::new(s.render_with_probe(&st, lines).unwrap()))]).pop().unwrap().unwrap();
        let b = vals(&[]);
        let defs = |v: &Vals| s.scorer.deficits(v);
        for n in ["attack speed", "skill gem levels", "increased damage"] {
            let v = vals(ax(n).unit);
            let (raw, floors, nocost) = (s.score(&v).0 - s.score(&b).0, s.relaxed_score(&v, true) - s.relaxed_score(&b, true), s.relaxed_score(&v, false) - s.relaxed_score(&b, false));
            let moved: Vec<String> = defs(&v).iter().zip(defs(&b)).zip(&s.scorer.limits).filter(|((a, b), _)| (*a - *b).abs() > 1e-6).map(|((a, b), l)| format!("{} {b:.3}->{a:.3}", l.name)).collect();
            eprintln!("{n:18} raw {raw:+.4}  floors off {floors:+.4}  floors+cost off {nocost:+.4}  limits moved: {moved:?}");
        }

        let parts = s.part_catalog(ci);
        let id = |name: &str| parts.iter().position(|p| matches!(p.kind, PartKind::Node(_)) && p.label == name).unwrap_or_else(|| panic!("no part {name}"));
        let (rt, cit) = (id("Resolute Technique"), id("Chaos Inoculation"));
        let (c, e) = (ax("increased crit chance").commit, ax("energy shield").commit);
        let (basec, inc) = (ax("base crit chance").commit, ax("increased energy shield").commit);
        let multi = ax("crit multiplier").commit;
        let crit: Vec<&str> = basec.iter().chain(c).chain(multi).copied().collect();
        // a finished crit build (about 45% crit chance, 4x multiplier, accuracy enough to hit: the bare state is
        // accuracy-starved, which is most of what RT's "can't be evaded" is worth there)
        let crit_full = vec!["+3000 to Accuracy Rating","+4% to Critical Strike Chance", "400% increased Critical Strike Chance", "+200% to Critical Strike Multiplier"];
        let es: Vec<&str> = e.iter().chain(inc).copied().collect();
        let t = Instant::now();
        let scr = s.screen(&st, &parts, &[crit, es, crit_full], u64::MAX).unwrap();
        eprintln!("screen: {} parts, root + 3 primed states, {} evals, {:?}", parts.len(), scr.evals, t.elapsed());
        eprintln!("RT root {:+.4} crit-primed {:+.4} full-crit-primed {:+.4} | CI root {:+.4} ES-primed {:+.4}", scr.root[rt], scr.primed[0][rt], scr.primed[2][rt], scr.root[cit], scr.primed[1][cit]);
        let mut top: Vec<usize> = (0..parts.len()).collect();
        top.sort_by(|&a, &b| scr.root[b].partial_cmp(&scr.root[a]).unwrap());
        for &i in top.iter().take(10) {
            eprintln!("  {:+.4}  {}", scr.root[i], parts[i].label);
        }
        let sens = s.sensitivity(&st).unwrap();
        eprintln!("convex primes: {:?}", convex_primes(&sens, 4));
        assert!(scr.root[rt] > 0.0 && scr.primed[2][rt] < 0.0, "RT root {} full-crit-primed {}", scr.root[rt], scr.primed[2][rt]);
        assert!(scr.primed[1][cit] >= scr.root[cit], "CI root {} ES-primed {}", scr.root[cit], scr.primed[1][cit]);
    }

    /// Slayer context: only Slayer ascendancy notables; a ring unique is offered for both ring slots under one
    /// `Excl::Unique`; a two-hand unique holds Weapon 2.
    #[test]
    fn slayer_catalog() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let opts: Options = serde_json::from_str(r#"{"threads":1}"#).unwrap();
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        assert_eq!(cands.len(), 1);
        let ci = cands[0];
        let t = Instant::now();
        let parts = s.part_catalog(ci);
        let c = &s.ctx[ci];

        // The context's paths hold other ascendancies' notables too, so the filter is really tested.
        let slayer = c.asc_internal.clone().unwrap();
        assert!(c.paths.nodes.values().any(|n| n.kind == "Notable" && n.ascendancy.as_deref().is_some_and(|a| a != slayer)));
        let asc: Vec<i64> = parts.iter().filter_map(|p| if let PartKind::Asc(id) = p.kind { Some(id) } else { None }).collect();
        assert!(!asc.is_empty() && asc.iter().all(|id| c.paths.nodes[id].ascendancy.as_deref() == Some(slayer.as_str())), "{asc:?}");
        assert!(parts.iter().all(|p| !matches!(p.kind, PartKind::Node(id) if c.paths.nodes[&id].ascendancy.is_some())));

        // A ring unique: both ring slots, one Unique exclusivity key.
        let rings: Vec<usize> = s.slots.iter().enumerate().filter(|(_, d)| d.kind == SlotKind::Ring).map(|(i, _)| i).collect();
        assert_eq!(rings.len(), 2);
        let uniq = |p: &Part| if let PartKind::Unique { slot, u } = &p.kind { Some((*slot, u.clone())) } else { None };
        let ring = parts.iter().filter_map(uniq).find(|(_, u)| u.item_type == "Ring").unwrap().1.name.clone();
        let mine: Vec<&Part> = parts.iter().filter(|p| uniq(p).is_some_and(|(_, u)| u.name == ring)).collect();
        let mut slots: Vec<usize> = mine.iter().filter_map(|p| uniq(p).map(|x| x.0)).collect();
        slots.sort_unstable();
        assert_eq!(slots, rings, "{ring}");
        for p in &mine {
            assert_eq!(p.excl.iter().filter(|e| **e == Excl::Unique(ring.clone())).count(), 1);
        }

        // A two-hand unique in Weapon 1 holds Weapon 2.
        let (w1, w2) = (s.slot_of(SlotKind::Weapon1).unwrap(), s.slot_of(SlotKind::Weapon2).unwrap());
        let two = parts.iter().find(|p| uniq(p).is_some_and(|(sl, u)| sl == w1 && u.two_hand)).expect("a 2H unique");
        assert!(two.excl.contains(&Excl::Slot(w2)) && two.excl.contains(&Excl::Slot(w1)), "{:?}", two.excl);

        let n = |f: fn(&PartKind) -> bool| parts.iter().filter(|p| f(&p.kind)).count();
        println!(
            "Slayer parts in {:?}: node {} mastery {} asc {} anoint {} unique {} support {} modline {}",
            t.elapsed(),
            n(|k| matches!(k, PartKind::Node(_))),
            n(|k| matches!(k, PartKind::Mastery(..))),
            n(|k| matches!(k, PartKind::Asc(_))),
            n(|k| matches!(k, PartKind::Anoint(..))),
            n(|k| matches!(k, PartKind::Unique { .. })),
            n(|k| matches!(k, PartKind::Support(_))),
            n(|k| matches!(k, PartKind::ModLine { .. })),
        );
    }

    /// The Slayer catalog gains large cluster jewel parts whose socket item has passives.
    #[test]
    fn slayer_cluster_parts() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let opts: Options = serde_json::from_str(r#"{"threads":2}"#).unwrap();
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let ci = s.candidates().unwrap()[0];
        let st = s.initial_state(ci, None, None).unwrap();
        let t = Instant::now();
        let parts = s.cluster_parts(&st).unwrap();
        println!("cluster parts in {:?}:", t.elapsed());
        for p in &parts {
            println!("  {} (cost {}, nodes {})", p.label, p.cost, if let PartKind::Cluster(c) = &p.kind { c.nodes.len() } else { 0 });
        }
        let n = parts.iter().filter(|p| matches!(&p.kind, PartKind::Cluster(si) if !si.nodes.is_empty())).count();
        assert!((1..=5).contains(&n), "{n} cluster parts");
    }

    fn solver_for(skill: &str, asc: &str) -> (Solver, State) {
        let goal = format!(r#"{{"skill":"{skill}","ascendancy":"{asc}","level":90,"targets":[{{"name":"DPS","value":1000000}},{{"name":"EHP","metric":"ehp","value":50000}}],"items":{{"rarities":["rare","unique"],"mustUse":[],"neverUse":[],"lockSlots":[]}}}}"#);
        let goal: Goal = serde_json::from_str(&goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":6000000,"maxEvals":40000000,"threads":6}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let ci = s.candidates().unwrap()[0];
        let mut st = s.initial_state(ci, None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();
        (s, st)
    }

    fn show_rows(sens: &sens::Sens) {
        let mut j: Vec<usize> = (0..sens.axes.len()).filter(|&k| sens.synergy[k] != 0.0).collect();
        j.sort_by(|&a, &b| sens.synergy[b].total_cmp(&sens.synergy[a]));
        for &k in j.iter().take(12) {
            eprintln!("  joint: {:70} synergy {:+.3} committed {:+.3}", sens::AXES[sens.axes[k]].name, sens.synergy[k], sens.committed[k]);
        }
        for (k, &i) in sens.axes.iter().enumerate() {
            let n = sens::AXES[i].name;
            if n.contains("Lightning Damage Converted to Chaos") || n.contains("Lightning Damage as Extra Chaos") || n.ends_with("per 450 Armour") {
                eprintln!("  probe: {n:70} synergy {:+.3} committed {:+.3}", sens.synergy[k], sens.committed[k]);
            }
        }
        for (i, l) in convex_rows(sens, 6) {
            let k = sens.axes.iter().position(|&a| a == i).unwrap();
            eprintln!("  prime row: {:60} synergy {:+.3} committed {:+.3} lines {l:?}", sens::AXES[i].name, sens.synergy[k], sens.committed[k]);
        }
    }

    /// Mechanisms found from the game data, nothing named in solver code: on a Spark of the Nova
    /// state the scan's lightning-to-chaos + poison route leads the prime rows and a bloodline conversion notable leads
    /// the parts in its enabling row; Foulborn forms are uniques; a golem is a utility. On a Molten Strike Ascendant the
    /// scan's per-armour scaler is a joint axis whose armour row ranks the unique that carries it high; an Ascendant
    /// "Path of" node opens a second main-tree start.
    #[test]
    fn expert_coverage() {
        let joint: Vec<&sens::Axis> = sens::AXES.iter().filter(|a| !a.pair.is_empty()).collect();
        eprintln!("scanned joint axes: {} ({} routes, {} stacking)", joint.len(), joint.iter().filter(|a| a.name.contains(" + ")).count(), joint.iter().filter(|a| !a.name.contains(" + ")).count());

        // ---- Spark of the Nova (Occultist)
        let t = Instant::now();
        let (s, st) = solver_for("Spark of the Nova", "Occultist");
        let golems: Vec<&str> = st.utils.iter().copied().filter(|u| s.gems.iter().any(|g| g.id == *u && g.kind == Kind::Golem)).collect();
        eprintln!("Spark utils {:?}, golems {:?} ({:?})", st.utils, golems, t.elapsed());
        assert!(!golems.is_empty(), "no golem utility: {:?}", st.utils);
        let fb: Vec<&str> = s.uniques.iter().flat_map(|u| u.variants.iter()).filter(|v| v.label.starts_with("Foulborn ")).map(|v| v.label.as_str()).collect();
        eprintln!("Foulborn forms: {} e.g. {:?}", fb.len(), fb.iter().find(|l| l.contains("Blue Nightmare") && l.contains("Chaos")));
        assert!(fb.iter().any(|l| l.contains("Blue Nightmare") && l.contains("Converted to Chaos")));

        let sens = s.sensitivity_full(&st).unwrap();
        show_rows(&sens);
        let rows = convex_rows(&sens, 6);
        let route = rows.iter().map(|r| r.0).find(|&i| sens::AXES[i].commit.iter().any(|l| l.contains("Lightning Damage") && l.contains("Chaos")) && sens::AXES[i].pair.iter().any(|l| l.contains("Poison"))).expect("a lightning-to-chaos + poison route in the prime rows");
        let k = sens.axes.iter().position(|&a| a == route).unwrap();
        eprintln!("route {:?}: synergy {:+.3}", sens::AXES[route].name, sens.synergy[k]);
        let parts: Vec<Part> = s.part_catalog(st.class).into_iter().filter(|p| matches!(p.kind, PartKind::Asc(_) | PartKind::Unique { .. })).collect();
        let a = &sens::AXES[route];
        let scr = s.screen(&st, &parts, &[a.commit.to_vec(), a.pair.to_vec()], u64::MAX).unwrap();
        // lift: what the route's enabling half adds to a part (the beam's primed ranking)
        let lift = |i: usize| scr.primed[1][i] - scr.root[i];
        let mut top: Vec<usize> = (0..parts.len()).collect();
        top.sort_by(|&x, &y| lift(y).total_cmp(&lift(x)));
        eprintln!("Spark parts by lift in the route's enabling row ({} parts, {} evals; score = ln DPS):", parts.len(), scr.evals);
        for &i in top.iter().take(8) {
            eprintln!("  lift {:+.3} = x{:.2}  (root {:+.3}, enabling row {:+.3}, whole route {:+.3})  {}", lift(i), lift(i).exp(), scr.root[i], scr.primed[1][i], scr.primed[0][i], parts[i].label);
        }
        let c = &s.ctx[st.class];
        let lead = top.iter().take(5).find(|&&i| matches!(parts[i].kind, PartKind::Asc(id) if c.blood_of(id).is_some()) || parts[i].label.starts_with("Foulborn ")).copied();
        let lead = lead.expect("a bloodline or Foulborn part among the 5 best lifts in the route's enabling row");
        assert!(lift(lead) > 0.15, "{} {:+.3}", parts[lead].label, lift(lead));

        // ---- Molten Strike (Ascendant)
        let (s, st) = solver_for("Molten Strike", "Ascendant");
        let sens = s.sensitivity_full(&st).unwrap();
        show_rows(&sens);
        let stack = sens.axes.iter().copied().filter(|&i| sens::AXES[i].pair.iter().any(|l| l.ends_with(" to Armour")) && sens::AXES[i].commit.iter().any(|l| l.contains("Damage per") && l.ends_with(" Armour"))).max_by(|&x, &y| {
            let g = |i: usize| sens.synergy[sens.axes.iter().position(|&a| a == i).unwrap()];
            g(x).total_cmp(&g(y))
        }).expect("an armour-stacking axis");
        let k = sens.axes.iter().position(|&a| a == stack).unwrap();
        eprintln!("armour stacking {:?}: synergy {:+.3}, live {}", sens::AXES[stack].name, sens.synergy[k], s.live_axes.borrow().contains(&stack));
        assert!(sens.synergy[k] > 0.1);
        let parts: Vec<Part> = s.part_catalog(st.class).into_iter().filter(|p| matches!(p.kind, PartKind::Unique { .. })).collect();
        let a = &sens::AXES[stack];
        let scr = s.screen(&st, &parts, &[a.commit.to_vec(), a.pair.to_vec()], u64::MAX).unwrap();
        let lift = |i: usize| scr.primed[1][i] - scr.root[i];
        let mut top: Vec<usize> = (0..parts.len()).collect();
        top.sort_by(|&x, &y| lift(y).total_cmp(&lift(x)));
        eprintln!("Molten Strike uniques by lift in the armour row ({} parts):", parts.len());
        for &i in top.iter().take(6) {
            eprintln!("  lift {:+.3} = x{:.2}  (root {:+.3}, armour row {:+.3})  {}", lift(i), lift(i).exp(), scr.root[i], scr.primed[1][i], parts[i].label);
        }
        let carrier = top.iter().take(5).find(|&&i| matches!(&parts[i].kind, PartKind::Unique { u, .. } if u.xml.contains("Damage per") && u.xml.contains(" Armour"))).copied().expect("a per-armour unique among the 5 best lifts");
        assert!(lift(carrier) > 0.15, "{}", parts[carrier].label);

        // Ascendant second start: an allocated ascendancy node linked into the main tree is a main-tree root.
        let c = &s.ctx[st.class];
        let none: HashSet<i64> = HashSet::default();
        let asc = c.bfs(&none, true);
        let opener = s.part_catalog(st.class).iter().filter_map(|p| if let PartKind::Asc(id) = p.kind { Some(id) } else { None }).find(|&id| c.adj[&id].iter().any(|&m| c.is_main(m))).expect("an ascendancy node that opens a start");
        let path = c.path_to(&asc, opener);
        let alloc: HashSet<i64> = path.iter().copied().collect();
        let (far, near) = (c.bfs(&none, false), c.bfs(&alloc, false));
        let next = c.adj[&opener].iter().copied().find(|&m| c.is_main(m)).unwrap();
        eprintln!("opener {} (asc path {} nodes): its main neighbour {next} is {} points away from the class start, {} with it", c.paths.nodes[&opener].kind, path.len(), far[&next].0, near[&next].0);
        assert_eq!(near[&next].0, 1);
        assert!(far[&next].0 > 5);
        // a notable a few steps past it, grown through the second start, and what the engine makes of it
        let target = near.iter().filter(|(&id, &(d, _))| d <= 6 && c.kind(id) == "Notable" && far[&id].0 > d + 5).map(|(&id, _)| id).min().expect("a notable near the second start");
        let tree = c.tree_for(&[target], &path).unwrap();
        let mut grown = st.clone();
        grown.nodes = path.clone();
        let (m0, a0) = s.used(&grown);
        grown.nodes.extend(tree.iter().copied().filter(|&n| n != c.root));
        let (m1, a1) = s.used(&grown);
        let mut g2 = grown.clone();
        s.rebase(&mut g2).unwrap();
        let p = crate::treeclick::tree_paths(&s.render(&g2).unwrap(), pom_calc::data::game_data()).unwrap();
        eprintln!("Ascendant tree: asc {a0} points, main {m0} after the start's grants; with {} main nodes through the second start main {m1} asc {a1}; engine allocates the target: {}, score {:.4} -> {:.4}", tree.len() - 1, p.alloc.contains(&target), st.score, g2.score);
        assert!(p.alloc.contains(&target) && tree.len() - 1 <= near[&target].0 + 1);
    }
}

#[cfg(test)]
mod dead_tests {
    use super::*;

    #[test]
    fn keystones_kill_their_lines() {
        let rt = vec!["Resolute Technique".to_string()];
        assert!(line_is_dead(&rt, "#% increased Melee Critical Strike Chance"));
        assert!(!line_is_dead(&rt, "#% increased Attack Speed"));
        assert!(!line_is_dead(&[], "#% increased Melee Critical Strike Chance"));
        let tempest = vec!["Roiling Tempest".to_string()];
        assert!(line_is_dead(&tempest, "Adds # to # Cold Damage to Attacks"));
        assert!(!line_is_dead(&tempest, "Adds # to # Lightning Damage to Attacks"));
        assert!(!line_is_dead(&tempest, "#% to Cold Resistance"));
        assert!(!line_is_dead(&tempest, "#% additional Physical Damage Reduction"));
    }
}
