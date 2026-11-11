//! Optimize pathing. Upstream has no optimizer; this looks for a connected tree that keeps
//! every allocated notable, keystone, mastery and jewel socket (and everything the engine can't move without changing
//! the build: ascendancy nodes, cluster jewel nodes, nodes in a jewel's radius, tattoos, Intuitive Leap exceptions) and
//! uses fewer points (objective `points`), or, for a stat objective, the same or fewer points with a better value of
//! that stat. Candidates are scored by `Session::eval_nodes`, so every number is what the calc gives for that node list.

use crate::session::{nodes_in_xml, Session};
use crate::treeclick::{ClickNode, TreePaths};
use pom_engine::fxhash::{HashMap, HashSet};
use serde_json::{json, Value};

/// Stats the result lists when they change.
const REPORT: [&str; 14] = ["Life", "TotalEHP", "CombinedDPS", "FullDPS", "Str", "Dex", "Int", "Mana", "EnergyShield", "Armour", "Evasion", "FireResist", "ColdResist", "LightningResist"];

/// The most time a stat objective searches.
const STAT_BUDGET_MS: u128 = 3000;

/// The longest one step may run on a single piece of work, so that a cancel takes effect within about this time.
const INNER_SLICE_MS: u128 = 600;

pub struct OptRun {
    xml: String,
    objective: String,
    paths: std::rc::Rc<TreePaths>,
    /// Nodes of the build the search never touches (ascendancy, cluster, radius, tattoo, Intuitive Leap nodes).
    fixed: Vec<i64>,
    /// The main tree's allocated nodes the search works on, class start first.
    work: Vec<i64>,
    required: HashSet<i64>,
    base_nodes: Vec<i64>,
    best: Option<Vec<i64>>,
    started: std::time::Instant,
    elapsed_ms: u128,
    evaluated: u64,
    /// Stat objective state.
    cur: Vec<i64>,
    cur_val: f64,
    base_val: f64,
    stalled: bool,
    done: bool,
    candidates: usize,
    /// The point-saving search's state between steps.
    pts: PointsState,
}

fn is_main(n: &ClickNode) -> bool {
    n.ascendancy.is_none() && n.kind != "ClassStart" && n.kind != "AscendClassStart"
}

fn adjacency(paths: &TreePaths) -> HashMap<i64, Vec<i64>> {
    let mut adj: HashMap<i64, Vec<i64>> = HashMap::default();
    for (&id, n) in &paths.nodes {
        for &l in &n.linked {
            if paths.nodes.contains_key(&l) && l != id {
                let e = adj.entry(id).or_default();
                if !e.contains(&l) {
                    e.push(l);
                }
                let e = adj.entry(l).or_default();
                if !e.contains(&id) {
                    e.push(id);
                }
            }
        }
    }
    for v in adj.values_mut() {
        v.sort_unstable();
    }
    adj
}

/// Takahashi-Matsuyama Steiner tree from `root` over `terminals`, with `order` breaking ties between equally near
/// terminals and routes. Nodes reachable only through a mastery are never used as links.
pub(crate) fn steiner(paths: &TreePaths, adj: &HashMap<i64, Vec<i64>>, root: i64, terminals: &[i64], seed: u64, forbid: Option<i64>, avoid: &HashSet<i64>) -> Option<HashSet<i64>> {
    steiner_from(paths, adj, &[root], terminals, seed, forbid, avoid)
}

/// `steiner` grown from several starts at once (a class start and the extra starts an Ascendant opens).
pub(crate) fn steiner_from(paths: &TreePaths, adj: &HashMap<i64, Vec<i64>>, roots: &[i64], terminals: &[i64], seed: u64, forbid: Option<i64>, avoid: &HashSet<i64>) -> Option<HashSet<i64>> {
    let root = roots[0];
    let rank = |id: i64| -> u64 {
        if seed == 0 {
            id as u64
        } else {
            let mut x = (id as u64) ^ seed.wrapping_mul(0x9E37_79B9_7F4A_7C15);
            x ^= x >> 33;
            x = x.wrapping_mul(0xFF51_AFD7_ED55_8CCD);
            x ^= x >> 29;
            x
        }
    };
    let allowed = |id: i64| Some(id) != forbid && !avoid.contains(&id) && paths.nodes.get(&id).is_some_and(|n| roots.contains(&id) || (is_main(n) && (n.kind == "Mastery" || n.kind == "Keystone" || !n.path.is_empty() || paths.alloc.contains(&id))));
    let mut tree: HashSet<i64> = roots.iter().copied().collect();
    let mut remaining: HashSet<i64> = terminals.iter().copied().filter(|t| !roots.contains(t)).collect();
    while !remaining.is_empty() {
        // Multi-source BFS from the tree.
        let mut prev: HashMap<i64, i64> = HashMap::default();
        let mut seen: HashSet<i64> = tree.clone();
        let mut frontier: Vec<i64> = tree.iter().copied().collect();
        frontier.sort_by_key(|&i| rank(i));
        let mut found: Option<i64> = None;
        'bfs: while !frontier.is_empty() && found.is_none() {
            let mut next: Vec<i64> = Vec::new();
            for &u in &frontier {
                // A mastery is only ever an endpoint.
                if !roots.contains(&u) && paths.nodes.get(&u).is_some_and(|n| n.kind == "Mastery") && !tree.contains(&u) {
                    continue;
                }
                let Some(ns) = adj.get(&u) else { continue };
                let mut ns: Vec<i64> = ns.clone();
                ns.sort_by_key(|&i| rank(i));
                for v in ns {
                    if seen.contains(&v) || !allowed(v) {
                        continue;
                    }
                    seen.insert(v);
                    prev.insert(v, u);
                    next.push(v);
                }
            }
            // The nearest terminal of this layer (lowest rank).
            let mut hits: Vec<i64> = next.iter().copied().filter(|v| remaining.contains(v)).collect();
            hits.sort_by_key(|&i| rank(i));
            if let Some(&h) = hits.first() {
                found = Some(h);
                break 'bfs;
            }
            frontier = next;
        }
        let t = found?;
        let mut cur = t;
        loop {
            tree.insert(cur);
            remaining.remove(&cur);
            if tree.contains(&prev[&cur]) {
                break;
            }
            cur = prev[&cur];
        }
        // (the loop above stops once it meets the tree; the met node is already in it)
    }
    // Drop non-terminal leaves.
    let term: HashSet<i64> = terminals.iter().copied().collect();
    loop {
        let mut removed = false;
        let ids: Vec<i64> = tree.iter().copied().collect();
        for id in ids {
            if roots.contains(&id) || term.contains(&id) {
                continue;
            }
            let deg = adj.get(&id).map_or(0, |ns| ns.iter().filter(|n| tree.contains(n)).count());
            if deg <= 1 {
                tree.remove(&id);
                removed = true;
            }
        }
        if !removed {
            break;
        }
    }
    Some(tree)
}

/// The nodes of `work` still joined to the class start by nodes of the set (a mastery is only an endpoint).
fn connected(paths: &TreePaths, adj: &HashMap<i64, Vec<i64>>, root: i64, set: &HashSet<i64>) -> HashSet<i64> {
    let mut seen: HashSet<i64> = HashSet::default();
    seen.insert(root);
    let mut stack = vec![root];
    while let Some(u) = stack.pop() {
        if u != root && paths.nodes.get(&u).is_some_and(|n| n.kind == "Mastery") {
            continue;
        }
        for &v in adj.get(&u).map_or(&[][..], |v| v.as_slice()) {
            if set.contains(&v) && seen.insert(v) {
                stack.push(v);
            }
        }
    }
    seen
}

pub fn start(session: &mut Session, objective: String) -> Result<(OptRun, usize), String> {
    session.ensure_node_list()?;
    let xml = session.xml().to_string();
    let base_nodes = nodes_in_xml(&xml)?;
    // The build's facts (which allocated nodes are plain) come from learning it once.
    session.eval_nodes(&base_nodes, &["Life"])?;
    let simple = session.simple_nodes();
    let paths = session.paths()?;
    let adj = adjacency(&paths);
    let root = paths.alloc.iter().copied().filter(|id| paths.nodes.get(id).is_some_and(|n| n.kind == "ClassStart")).min().ok_or("no class start")?;
    // Allocated main-tree nodes joined to the class start.
    let main_alloc: HashSet<i64> = paths.alloc.iter().copied().filter(|id| paths.nodes.get(id).is_some_and(|n| is_main(n))).collect();
    let mut with_root = main_alloc.clone();
    with_root.insert(root);
    let comp = connected(&paths, &adj, root, &with_root);
    let mut fixed: Vec<i64> = Vec::new();
    for &id in &base_nodes {
        if !comp.contains(&id) {
            fixed.push(id);
        }
    }
    let mut required: HashSet<i64> = HashSet::default();
    let mut work: Vec<i64> = vec![root];
    for &id in &base_nodes {
        if id == root || !comp.contains(&id) {
            continue;
        }
        work.push(id);
        let n = &paths.nodes[&id];
        let keep = matches!(n.kind.as_str(), "Notable" | "Keystone" | "Mastery" | "Socket")
            || id >= 65536
            || !n.other_options.is_empty()
            || !simple.contains(&id);
        if keep {
            required.insert(id);
        }
    }
    let candidates = work.len();
    let run = OptRun { xml, objective, paths, fixed, work, required, base_nodes, best: None, started: std::time::Instant::now(), elapsed_ms: 0, evaluated: 0, cur: Vec::new(), cur_val: 0.0, base_val: 0.0, stalled: false, done: false, candidates, pts: PointsState::default() };
    Ok((run, candidates))
}

fn objective_names(obj: &str) -> Vec<&'static str> {
    match obj {
        "FullDPS" => vec!["FullDPS"],
        "CombinedDPS" => vec!["CombinedDPS"],
        "TotalDPS" => vec!["TotalDPS"],
        "Life" => vec!["Life"],
        "TotalEHP" => vec!["TotalEHP"],
        "EnergyShield" => vec!["EnergyShield"],
        "Mana" => vec!["Mana"],
        "Armour" => vec!["Armour"],
        "Evasion" => vec!["Evasion"],
        _ => vec![],
    }
}

fn result(session: &mut Session, run: &OptRun, set: &[i64]) -> Result<Value, String> {
    let mut nodes: Vec<i64> = set.to_vec();
    nodes.extend(run.fixed.iter().copied());
    // Keep the build's own order for what stays, new nodes last.
    let keep: HashSet<i64> = nodes.iter().copied().collect();
    let mut ordered: Vec<i64> = run.base_nodes.iter().copied().filter(|n| keep.contains(n)).collect();
    for n in &nodes {
        if !ordered.contains(n) {
            ordered.push(*n);
        }
    }
    let base_set: HashSet<i64> = run.base_nodes.iter().copied().collect();
    let new_set: HashSet<i64> = ordered.iter().copied().collect();
    let mut added: Vec<i64> = ordered.iter().copied().filter(|n| !base_set.contains(n)).collect();
    let mut removed: Vec<i64> = run.base_nodes.iter().copied().filter(|n| !new_set.contains(n)).collect();
    added.sort_unstable();
    removed.sort_unstable();
    let is_pt = |id: &i64| run.paths.nodes.get(id).is_some_and(|n| !matches!(n.kind.as_str(), "ClassStart" | "AscendClassStart") && n.ascendancy.is_none());
    let points_before = run.base_nodes.iter().filter(|n| is_pt(n)).count();
    let points_after = ordered.iter().filter(|n| is_pt(n)).count();
    let names: Vec<&str> = REPORT.to_vec();
    let before = session.eval_nodes(&run.base_nodes, &names)?;
    let after = session.eval_nodes(&ordered, &names)?;
    let mut stats = Vec::new();
    for (i, n) in names.iter().enumerate() {
        if let (Some(b), Some(a)) = (before[i], after[i]) {
            if (a - b).abs() > 1e-9 * b.abs().max(1.0) {
                stats.push(json!([n, b, a]));
            }
        }
    }
    let kept = run.required.iter().filter(|id| run.paths.nodes.get(id).is_some_and(|n| matches!(n.kind.as_str(), "Notable" | "Keystone" | "Mastery" | "Socket"))).count();
    Ok(json!({ "nodeIds": ordered, "added": added, "removed": removed, "pointsBefore": points_before, "pointsAfter": points_after, "stats": stats, "keptNotables": kept }))
}

/// Stats a point-saving result must not lower (every one is "higher is better").
const KEEP: [&str; 36] = [
    "Life", "LifeUnreserved", "EnergyShield", "Mana", "ManaUnreserved", "Armour", "Evasion", "TotalEHP", "CombinedDPS", "FullDPS", "TotalDPS", "AverageHit", "Speed", "Str", "Dex", "Int",
    "FireResist", "ColdResist", "LightningResist", "ChaosResist", "EffectiveBlockChance", "EffectiveSpellBlockChance", "EffectiveMovementSpeedMod", "LifeRegenRecovery", "ManaRegenRecovery",
    "EnergyShieldRegenRecovery", "PhysicalDamageReduction", "EffectiveSpellSuppressionChance", "AttackDodgeChance", "SpellDodgeChance", "CritChance", "CritMultiplier", "HitChance",
    "AreaOfEffectRadiusMetres", "Devotion", "TotalDot",
];

/// Where the point-saving search stands between steps, so a step can stop after its slice and a cancel takes effect then.
#[derive(Default)]
pub struct PointsState {
    /// The values of `KEEP` for the build as it is: no result may be lower on any of them.
    base: Option<Vec<Option<f64>>>,
    cur: Vec<i64>,
    tried: HashSet<Vec<i64>>,
    /// Candidates of the current round still to try (next one last).
    cands: Vec<Vec<i64>>,
    /// A round of candidates was made and none of them has been taken yet.
    round_open: bool,
    finished: bool,
}

/// The point-saving search: fewer points, nothing allocated that the build needs, and no stat in `KEEP` lower than now.
/// Candidates are the Steiner trees, single removable branches and reroutes around one node; the first that passes is
/// taken and the search goes on from there. It works for about `slice_ms` and returns whether it is finished; the
/// shorter tree is then in `run.pts.cur` (`None` when no fewer-point tree keeps every stat).
fn shorter(session: &mut Session, run: &mut OptRun, slice_ms: u128) -> Result<bool, String> {
    let adj = adjacency(&run.paths);
    let root = run.work[0];
    let names: Vec<&str> = KEEP.to_vec();
    let fixed = run.fixed.clone();
    let slice_start = std::time::Instant::now();
    let eval = |session: &mut Session, w: &[i64]| -> Result<Vec<Option<f64>>, String> {
        let mut nodes: Vec<i64> = w.to_vec();
        nodes.extend(fixed.iter().copied());
        session.eval_nodes(&nodes, &names)
    };
    if run.pts.base.is_none() {
        let work = run.work.clone();
        run.pts.base = Some(eval(session, &work)?);
        run.pts.cur = work;
    }
    let base = run.pts.base.clone().unwrap_or_default();
    let ok = |v: &[Option<f64>]| -> bool {
        base.iter().zip(v).all(|(b, c)| match (b, c) {
            (Some(b), Some(c)) => *c >= *b - 1e-9 * b.abs().max(1.0),
            (Some(_), None) => false,
            _ => true,
        })
    };
    while !run.pts.finished {
        // The whole search never takes longer than the stat searches do.
        if run.started.elapsed().as_millis() >= STAT_BUDGET_MS {
            run.pts.finished = true;
            break;
        }
        if slice_start.elapsed().as_millis() >= slice_ms {
            return Ok(false);
        }
        if run.pts.cands.is_empty() {
            if run.pts.round_open {
                // Every candidate of this round failed: nothing shorter keeps the stats.
                run.pts.finished = true;
                break;
            }
            let mut terminals: Vec<i64> = run.required.iter().copied().collect();
            terminals.sort_unstable();
            let cur = run.pts.cur.clone();
            let mut cands: Vec<Vec<i64>> = Vec::new();
            for seed in 0..12u64 {
                if let Some(t) = steiner(&run.paths, &adj, root, &terminals, seed, None, &HashSet::default()) {
                    cands.push(t.into_iter().collect());
                }
            }
            let set: HashSet<i64> = cur.iter().copied().collect();
            for &id in &cur {
                if id == root || run.required.contains(&id) {
                    continue;
                }
                let mut s = set.clone();
                s.remove(&id);
                let c = connected(&run.paths, &adj, root, &s);
                let group: Vec<i64> = cur.iter().copied().filter(|x| *x != id && c.contains(x)).collect();
                if run.required.iter().all(|r| group.contains(r)) {
                    cands.push(group);
                }
            }
            let mut movable: Vec<i64> = cur.iter().copied().filter(|id| *id != root && !run.required.contains(id)).collect();
            movable.sort_unstable();
            for x in movable {
                for seed in 0..2u64 {
                    if let Some(t) = steiner(&run.paths, &adj, root, &terminals, seed, Some(x), &HashSet::default()) {
                        cands.push(t.into_iter().collect());
                    }
                }
            }
            cands.reverse();
            run.pts.cands = cands;
            run.pts.round_open = true;
            continue;
        }
        let Some(mut w) = run.pts.cands.pop() else { continue };
        w.sort_unstable();
        if w.len() >= run.pts.cur.len() || !run.pts.tried.insert(w.clone()) {
            continue;
        }
        let v = eval(session, &w)?;
        run.evaluated += 1;
        if ok(&v) {
            run.pts.cur = w;
            run.pts.cands.clear();
            run.pts.round_open = false;
        }
    }
    Ok(true)
}

/// A stat objective: swap the least useful removable leaf for the most useful node next to the tree while the stat
/// improves; the point count never grows.
fn improve(session: &mut Session, run: &mut OptRun, budget_ms: u128) -> Result<(), String> {
    let names = objective_names(&run.objective);
    if names.is_empty() {
        return Err(format!("unknown objective {}", run.objective));
    }
    let adj = adjacency(&run.paths);
    let root = run.work[0];
    let started = std::time::Instant::now();
    let fixed = run.fixed.clone();
    let eval = |session: &mut Session, work: &[i64]| -> Result<f64, String> {
        let mut nodes: Vec<i64> = work.to_vec();
        nodes.extend(fixed.iter().copied());
        Ok(session.eval_nodes(&nodes, &names)?[0].unwrap_or(0.0))
    };
    if run.cur.is_empty() {
        run.cur = run.work.clone();
        run.cur_val = eval(session, &run.cur)?;
        run.base_val = run.cur_val;
        run.evaluated += 1;
    }
    while started.elapsed().as_millis() < budget_ms && run.started.elapsed().as_millis() < STAT_BUDGET_MS {
        let set: HashSet<i64> = run.cur.iter().copied().collect();
        // Removable groups: a node that no required node hangs off, with the nodes that only it holds on.
        let mut groups: Vec<Vec<i64>> = Vec::new();
        for &id in &run.cur {
            if id == root || run.required.contains(&id) {
                continue;
            }
            let mut s = set.clone();
            s.remove(&id);
            let c = connected(&run.paths, &adj, root, &s);
            let group: Vec<i64> = run.cur.iter().copied().filter(|x| *x == id || !c.contains(x)).collect();
            if group.iter().all(|g| !run.required.contains(g)) && !group.contains(&root) {
                groups.push(group);
            }
        }
        // Rerouting: a node the tree could do without if another route reached what hangs off it.
        let mut terminals: Vec<i64> = run.required.iter().copied().collect();
        terminals.sort_unstable();
        let mut bestr: Option<(f64, Vec<i64>)> = None;
        let mut movable: Vec<i64> = run.cur.iter().copied().filter(|id| *id != root && !run.required.contains(id)).collect();
        movable.sort_unstable();
        for x in movable {
            for seed in 0..3u64 {
                let Some(t) = steiner(&run.paths, &adj, root, &terminals, seed, Some(x), &HashSet::default()) else { continue };
                if t.len() > run.cur.len() {
                    continue;
                }
                let mut w: Vec<i64> = t.into_iter().collect();
                w.sort_unstable();
                if w == { let mut c = run.cur.clone(); c.sort_unstable(); c } {
                    continue;
                }
                let v = eval(session, &w)?;
                run.evaluated += 1;
                if bestr.as_ref().is_none_or(|b| v > b.0) {
                    bestr = Some((v, w));
                }
                if started.elapsed().as_millis() >= budget_ms.max(INNER_SLICE_MS) {
                    break;
                }
            }
            if started.elapsed().as_millis() >= budget_ms.max(INNER_SLICE_MS) {
                break;
            }
        }
        if let Some((v, w)) = bestr {
            if v > run.cur_val + 1e-9 * run.cur_val.abs().max(1.0) {
                run.cur = w;
                run.cur_val = v;
                continue;
            }
        }
        if groups.is_empty() {
            run.stalled = true;
            break;
        }
        // Each group's loss, cheapest first.
        let mut losses: Vec<(f64, usize)> = Vec::new();
        for (i, g) in groups.iter().enumerate() {
            let w: Vec<i64> = run.cur.iter().copied().filter(|x| !g.contains(x)).collect();
            losses.push((run.cur_val - eval(session, &w)?, i));
            run.evaluated += 1;
            if started.elapsed().as_millis() >= budget_ms {
                return Ok(());
            }
        }
        losses.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.cmp(&b.1)));
        let mut improved = false;
        for &(_, gi) in losses.iter().take(3) {
            let g = &groups[gi];
            let mut w: Vec<i64> = run.cur.iter().copied().filter(|x| !g.contains(x)).collect();
            let mut val = eval(session, &w)?;
            run.evaluated += 1;
            // Spend the freed points on the best nodes next to the tree, one at a time.
            for _ in 0..g.len() {
                let wset: HashSet<i64> = w.iter().copied().collect();
                let mut best: Option<(f64, i64)> = None;
                let mut seen: HashSet<i64> = HashSet::default();
                for &id in &w {
                    if id != root && paths_mastery(&run.paths, id) {
                        continue;
                    }
                    for &v in adj.get(&id).map_or(&[][..], |v| v.as_slice()) {
                        if wset.contains(&v) || g.contains(&v) || !seen.insert(v) {
                            continue;
                        }
                        let Some(n) = run.paths.nodes.get(&v) else { continue };
                        if !(is_main(n) && matches!(n.kind.as_str(), "Normal" | "Notable") && n.other_options.is_empty() && v < 65536 && !n.leap && !n.path.is_empty()) {
                            continue;
                        }
                        let mut t = w.clone();
                        t.push(v);
                        let x = eval(session, &t)?;
                        run.evaluated += 1;
                        if best.is_none_or(|b| x > b.0 || (x == b.0 && v < b.1)) {
                            best = Some((x, v));
                        }
                        if started.elapsed().as_millis() >= budget_ms.max(INNER_SLICE_MS) {
                            return Ok(());
                        }
                    }
                }
                match best {
                    Some((x, v)) if x > val => {
                        w.push(v);
                        val = x;
                    }
                    _ => break,
                }
            }
            if val > run.cur_val + 1e-9 * run.cur_val.abs().max(1.0) {
                run.cur = w;
                run.cur_val = val;
                improved = true;
                break;
            }
        }
        if !improved {
            run.stalled = true;
            break;
        }
    }
    Ok(())
}

fn paths_mastery(paths: &TreePaths, id: i64) -> bool {
    paths.nodes.get(&id).is_some_and(|n| n.kind == "Mastery")
}

/// Works for about `budget_ms` and returns `OptimizeStep` JSON.
pub fn step(session: &mut Session, run: &mut OptRun, budget_ms: u64) -> Result<Value, String> {
    if session.xml() != run.xml {
        return Ok(json!({ "active": false, "done": true, "progress": 0, "evaluated": run.evaluated, "best": null }));
    }
    if run.done {
        return Ok(json!({ "active": true, "done": true, "progress": 100, "evaluated": run.evaluated, "best": null }));
    }
    let t0 = std::time::Instant::now();
    let mut best = Value::Null;
    if run.objective == "points" {
        let finished = shorter(session, run, budget_ms.max(1) as u128)?;
        run.elapsed_ms = run.started.elapsed().as_millis();
        if finished {
            if run.pts.cur.len() < run.work.len() {
                let mut cur = run.pts.cur.clone();
                cur.sort_unstable();
                best = result(session, run, &cur)?;
            }
            run.done = true;
        }
    } else {
        improve(session, run, budget_ms as u128)?;
        run.elapsed_ms = run.started.elapsed().as_millis();
        if run.stalled || run.elapsed_ms >= STAT_BUDGET_MS {
            run.done = true;
        }
        if run.cur_val > run.base_val + 1e-9 * run.base_val.abs().max(1.0) && !run.cur.is_empty() {
            let cur = run.cur.clone();
            best = result(session, run, &cur)?;
        }
    }
    let _ = t0;
    let progress = if run.done { 100 } else { (run.elapsed_ms.min(STAT_BUDGET_MS) * 100 / STAT_BUDGET_MS) as i64 };
    Ok(json!({ "active": true, "done": run.done, "progress": progress, "evaluated": run.evaluated, "best": best }))
}

/// Smart pathing: the fewest-point tree from the class start that reaches every `wanted` node and never enters an
/// `avoid` node, with everything the build holds that the tree can't move (`fixed`) and every allocated notable,
/// keystone, mastery, socket and plain-looking node that matters (`required`): the current tree is wanted by default.
/// Returns `{"nodeIds"}` for `setNodes`, or `{"unreachable": [ids]}` when a wanted node can't be reached.
pub fn path_solve(session: &mut Session, wanted: &[i64], avoid: &[i64]) -> Result<Value, String> {
    let (run, _) = start(session, "points".into())?;
    let adj = adjacency(&run.paths);
    let root = run.work[0];
    let avoid: HashSet<i64> = avoid.iter().copied().collect();
    // Never drop an allocated node: the whole current tree is required, minus nodes the user marked avoid.
    let mut terms: Vec<i64> = wanted.iter().chain(&run.work).copied().filter(|id| *id != root && !avoid.contains(id)).collect();
    terms.sort_unstable();
    terms.dedup();
    let tree = loop {
        // Shortest of a few tie-breaks: the greedy join is not always the smallest tree.
        let best = (0..8u64).filter_map(|seed| steiner(&run.paths, &adj, root, &terms, seed, None, &avoid)).min_by_key(|t| t.len());
        if let Some(t) = best {
            break t;
        }
        let bad: Vec<i64> = terms.iter().copied().filter(|t| steiner(&run.paths, &adj, root, &[*t], 0, None, &avoid).is_none()).collect();
        let bad_wanted: Vec<i64> = bad.iter().copied().filter(|t| wanted.contains(t)).collect();
        if !bad_wanted.is_empty() {
            return Ok(json!({ "unreachable": bad_wanted }));
        }
        if bad.is_empty() {
            return Err("no route found".into());
        }
        // A kept mastery or special node that the avoided nodes cut off is let go rather than refusing the click.
        terms.retain(|t| !bad.contains(t));
    };
    let mut ordered: Vec<i64> = run.base_nodes.iter().copied().filter(|n| tree.contains(n) || run.fixed.contains(n)).collect();
    let mut fresh: Vec<i64> = tree.iter().copied().filter(|n| !ordered.contains(n)).collect();
    fresh.sort_unstable();
    ordered.extend(fresh);
    Ok(json!({ "nodeIds": ordered }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(edges: &[(i64, i64)], kinds: &[(i64, &str)]) -> TreePaths {
        let mut nodes: HashMap<i64, crate::treeclick::ClickNode> = HashMap::default();
        for &(id, kind) in kinds {
            let linked = edges.iter().filter_map(|&(a, b)| if a == id { Some(b) } else if b == id { Some(a) } else { None }).collect();
            nodes.insert(id, crate::treeclick::ClickNode { path: vec![id], depends: vec![id], kind: kind.into(), ascendancy: None, leap: false, other_options: vec![], has_mastery_effects: false, mastery_effects: vec![], linked, has_mods: true, mod_key: String::new(), path_dist: 1 });
        }
        TreePaths { alloc: HashSet::default(), nodes, class_id: 0, ascend_class_id: 0, secondary_ascend_class_id: 0, mastery_selections: vec![], alloc_sequence: vec![], state: Value::Null, classes: HashMap::default(), alternate_ascendancies: HashMap::default() }
    }

    /// Root 1; a short way 1-2-4 and a long way 1-3-5-6-4 to the wanted node 4.
    #[test]
    fn avoided_node_is_never_used_and_unreachable_is_reported() {
        let kinds = [(1, "ClassStart"), (2, "Normal"), (3, "Normal"), (4, "Notable"), (5, "Normal"), (6, "Normal")];
        let p = paths(&[(1, 2), (2, 4), (1, 3), (3, 5), (5, 6), (6, 4)], &kinds);
        let adj = adjacency(&p);
        let none = HashSet::default();
        let short = steiner(&p, &adj, 1, &[4], 0, None, &none).unwrap();
        assert!(short.contains(&2) && short.len() == 3);
        let avoid: HashSet<i64> = [2].into_iter().collect();
        let long = steiner(&p, &adj, 1, &[4], 0, None, &avoid).unwrap();
        assert!(!long.contains(&2) && long.len() == 5);
        let avoid: HashSet<i64> = [2, 6].into_iter().collect();
        assert!(steiner(&p, &adj, 1, &[4], 0, None, &avoid).is_none());
    }
}
