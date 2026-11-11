//! Node Power: upstream's `CalcsTab:PowerBuilder` for the unallocated nodes. For each node the build is calculated
//! with just that node's mods added (`calcFunc({ addNodes = { [node] = true } })`: no path), and compared with the build
//! (`CalculateCombinedOffDefStat` for the default view, `CalculatePowerStat` for a chosen stat). A node more than one
//! step away also gets the chosen stat's change for allocating its whole path (`pathPower`). Masteries are tried with
//! each effect they offer and keep the best. Runs in steps so the engine host can answer other commands in between.
//!
//! With a chosen stat the allocated Normal/Notable/Keystone/Mastery nodes also get their removal power
//! (`calcFunc({ removeNodes })`, the change for taking the node, or all its dependents, away: negative when it helps),
//! flagged `allocated`, for the report's Show Allocated filter.
//!
//! Not done (upstream does them): the `clusterNodeMap`
//! cluster notables of the power report, and the minion's DPS (the engine's stat dump has no minion output).

use crate::session::{nodes_in_xml, Session};
use pom_engine::fxhash::HashMap;
use serde_json::{json, Value};

/// Offence and defence inputs of the default view, in `names` order.
pub(crate) const COMBINED: [&str; 9] = ["LifeUnreserved", "Life", "Armour", "EnergyShieldRecoveryCap", "EnergyShield", "Evasion", "LifeRegenRecovery", "EnergyShieldRegenRecovery", "CombinedDPS"];

const NEGATED: [&str; 5] = ["PhysicalTakenHit", "LightningTakenHit", "ColdTakenHit", "FireTakenHit", "ChaosTakenHit"];

struct Job {
    id: i64,
    dist: i64,
    /// The node counts towards the maxima (it has a path and is not an ascendancy node).
    counts: bool,
    mastery: Option<i64>,
    key: String,
    path: Vec<i64>,
    /// A mastery node: its effects (all evaluated; the node keeps the best).
    effects: Vec<i64>,
    /// An allocated node: its removal power, with the nodes that go with it.
    remove: Option<Vec<i64>>,
}

/// What a worker needs to evaluate a job: the run's fixed inputs (never changed after `start`).
struct Shared {
    stat: Option<String>,
    base_nodes: Vec<i64>,
    names: Vec<String>,
    base: Vec<Option<f64>>,
    /// For each cache key, the first job that has it: the value cached under a key is always that job's, whichever worker
    /// computes it (upstream reuses the first node's figures for every node with the same mods).
    owner: HashMap<String, usize>,
}

type Cache = std::sync::Mutex<HashMap<String, Vec<Option<f64>>>>;

/// One finished job: its row, and for each candidate the (single, offence, defence) the maxima are taken from.
struct Done {
    row: Value,
    counts: bool,
    dist: i64,
    cands: Vec<(f64, f64, f64)>,
}

/// A worker thread with its own session (a session is not shared between threads): it takes job indexes and sends back
/// `(index, result)`.
struct Worker {
    tx: std::sync::mpsc::Sender<Vec<usize>>,
}

pub struct PowerRun {
    xml: String,
    shared: std::sync::Arc<Shared>,
    jobs: std::sync::Arc<Vec<Job>>,
    next: usize,
    cache: std::sync::Arc<Cache>,
    max: [f64; 5],
    workers: Vec<Worker>,
    results: Option<std::sync::mpsc::Receiver<(usize, Result<Done, String>)>>,
}

fn val(v: &[Option<f64>], names: &[String], n: &str) -> Option<f64> {
    names.iter().position(|x| x == n).and_then(|i| v[i])
}

fn is_damage_stat(stat: &str) -> bool {
    stat == "AverageDamage" || stat == "TotalDot" || stat.contains("DPS")
}

/// `data.powerStatList.GetFromOutput` for `stat`: damage stats add the minion's, and without FullDPS (no skill in
/// Full DPS) that stat is the player's plus the minion's CombinedDPS.
fn from_output(stat: &str, v: &[Option<f64>], names: &[String], use_full: bool) -> f64 {
    let g = |n: &str| val(v, names, n).unwrap_or(0.0);
    let x = if stat == "FullDPS" {
        // Upstream's calculator only has FullDPS when some skill is included in Full DPS.
        match val(v, names, "FullDPS") {
            Some(f) if use_full => f,
            _ => g("CombinedDPS") + g("Minion.CombinedDPS"),
        }
    } else if is_damage_stat(stat) {
        g(stat) + g(&format!("Minion.{stat}"))
    } else {
        g(stat)
    };
    if NEGATED.contains(&stat) {
        -x
    } else {
        x
    }
}

impl Shared {
    fn power(&self, v: &[Option<f64>]) -> (f64, f64, f64) {
        match &self.stat {
            Some(stat) => {
                let uf = stat == "FullDPS" && val(&self.base, &self.names, "FullDPS").is_some_and(|x| x != 0.0);
                let s = from_output(stat, v, &self.names, uf) - from_output(stat, &self.base, &self.names, uf);
                (0.0, 0.0, s)
            }
            None => {
                let g = |vals: &[Option<f64>], n: &str| val(vals, &self.names, n).unwrap_or(0.0);
                let (o, m) = (v, &self.base[..]);
                let es = |vals: &[Option<f64>]| val(vals, &self.names, "EnergyShieldRecoveryCap").or_else(|| val(vals, &self.names, "EnergyShield")).unwrap_or(0.0);
                let defence = (g(o, "LifeUnreserved") - g(m, "LifeUnreserved")) / 3000f64.max(g(m, "Life"))
                    + (g(o, "Armour") - g(m, "Armour")) / 10000f64.max(g(m, "Armour"))
                    + (es(o) - es(m)) / 3000f64.max(es(m))
                    + (g(o, "Evasion") - g(m, "Evasion")) / 10000f64.max(g(m, "Evasion"))
                    + (g(o, "LifeRegenRecovery") - g(m, "LifeRegenRecovery")) / 500.0
                    + (g(o, "EnergyShieldRegenRecovery") - g(m, "EnergyShieldRegenRecovery")) / 1000.0;
                let modified = g(m, "CombinedDPS") + g(m, "Minion.CombinedDPS");
                let incr = g(o, "CombinedDPS") + g(o, "Minion.CombinedDPS") - modified;
                // 0 / 0 is NaN in upstream too (sent as null).
                let offence = incr / modified;
                (offence, defence, offence)
            }
        }
    }
}

fn names_for(stat: &Option<String>) -> Vec<String> {
    match stat {
        None => COMBINED.iter().map(|s| s.to_string()).chain(["Minion.CombinedDPS".to_string()]).collect(),
        Some(s) if s == "FullDPS" => vec!["FullDPS".into(), "CombinedDPS".into(), "Minion.CombinedDPS".into()],
        Some(s) if is_damage_stat(s) => vec![s.clone(), format!("Minion.{s}")],
        Some(s) => vec![s.clone()],
    }
}

/// Starts a run over the unallocated nodes within `max_depth` steps; returns it with the number of nodes to evaluate.
pub fn start(session: &mut Session, max_depth: Option<i64>, stat: Option<String>) -> Result<(PowerRun, usize), String> {
    session.ensure_node_list()?;
    let xml = session.xml().to_string();
    let names = names_for(&stat);
    let base_nodes = nodes_in_xml(&xml)?;
    let name_refs: Vec<&str> = names.iter().map(|s| s.as_str()).collect();
    let base = session.eval_nodes(&base_nodes, &name_refs)?;
    let paths = session.paths()?;
    let granted: pom_engine::fxhash::HashSet<i64> = session.granted_nodes().into_iter().collect();
    let mut jobs: Vec<Job> = Vec::new();
    let mut ids: Vec<i64> = paths.nodes.keys().copied().collect();
    ids.sort_unstable();
    for id in ids {
        let n = &paths.nodes[&id];
        // An unallocated mastery carries every one of its effects' mods (upstream's `allMasteryOptions`), so it counts
        // whenever it offers effects, whatever mods its own node holds.
        let is_mastery = n.kind == "Mastery";
        if paths.alloc.contains(&id) || (is_mastery && !n.has_mastery_effects) || (!is_mastery && !n.has_mods) || granted.contains(&id) || n.kind == "ClassStart" || n.kind == "AscendClassStart" {
            continue;
        }
        let mut dist = if n.path_dist > 0 { n.path_dist } else { 1000 };
        if n.leap && !is_mastery {
            dist = 1;
        }
        if max_depth.is_some_and(|m| dist > m) {
            continue;
        }
        // The report's distance for a mastery is the length of its path (1 when none reaches it), not `pathDist`
        // (TreeTab:BuildPowerReportList: `node.power.distance or #node.path`; masteries never get a `power.distance`).
        if is_mastery {
            dist = (n.path.len() as i64).max(1);
        }
        let counts = !n.path.is_empty() && n.ascendancy.is_none();
        if n.kind == "Mastery" {
            let effects: Vec<i64> = n.mastery_effects.iter().copied().filter(|e| !paths.mastery_selections.iter().any(|&(m, x)| x == *e && m != id)).collect();
            if effects.is_empty() {
                continue;
            }
            jobs.push(Job { id, dist, counts, mastery: Some(0), key: String::new(), path: n.path.clone(), effects, remove: None });
        } else {
            jobs.push(Job { id, dist, counts, mastery: None, key: n.mod_key.clone(), path: n.path.clone(), effects: Vec::new(), remove: None });
        }
    }
    // Nearest first, as upstream works through them.
    jobs.sort_by_key(|j| (j.dist, j.id));
    // Removal power of the allocated nodes the report lists (a chosen stat only, as in upstream).
    if stat.is_some() {
        let mut alloc: Vec<i64> = paths.alloc.iter().copied().collect();
        alloc.sort_unstable();
        for id in alloc {
            let n = &paths.nodes[&id];
            let listed = matches!(n.kind.as_str(), "Normal" | "Notable" | "Keystone" | "Mastery") && n.ascendancy.is_none();
            let sel = paths.mastery_selections.iter().find(|&&(m, _)| m == id).map(|&(_, e)| e);
            if !listed || !n.has_mods || granted.contains(&id) || (n.kind == "Mastery" && sel.is_none()) {
                continue;
            }
            let mut depends = n.depends.clone();
            if !depends.contains(&id) {
                depends.push(id);
            }
            let dist = (n.depends.len() as i64).max(1);
            let effects = sel.filter(|_| n.kind == "Mastery").into_iter().collect();
            jobs.push(Job { id, dist, counts: false, mastery: None, key: format!("{}_remove", n.mod_key), path: Vec::new(), effects, remove: Some(depends) });
        }
    }
    let total = jobs.len();
    let mut owner: HashMap<String, usize> = Default::default();
    for (i, j) in jobs.iter().enumerate() {
        if !j.key.is_empty() {
            owner.entry(j.key.clone()).or_insert(i);
        }
    }
    let shared = std::sync::Arc::new(Shared { stat, base_nodes, names, base, owner });
    Ok((PowerRun { xml, shared, jobs: std::sync::Arc::new(jobs), next: 0, cache: Default::default(), max: [0.0; 5], workers: Vec::new(), results: None }, total))
}

/// Evaluates one job on `session`.
fn compute(session: &mut Session, sh: &Shared, cache: &Cache, jobs: &[Job], j: &Job) -> Result<Done, String> {
    let name_refs: Vec<&str> = sh.names.iter().map(|s| s.as_str()).collect();
    let names = &name_refs[..];
    let (id, dist, counts, key) = (j.id, j.dist, j.counts, &j.key);
    let get = |k: &str| cache.lock().ok().and_then(|c| c.get(k).cloned());
    let put = |k: &str, v: &Vec<Option<f64>>| {
        if let Ok(mut c) = cache.lock() {
            c.insert(k.to_string(), v.clone());
        }
    };
    if let Some(depends) = &j.remove {
        let without = |gone: &[i64]| -> Vec<i64> { sh.base_nodes.iter().copied().filter(|n| !gone.contains(n)).collect() };
        let vals = match get(key) {
            Some(v) => v,
            None => {
                let o = sh.owner.get(key).map_or(j, |&i| &jobs[i]);
                let v = session.eval_nodes_with(&without(&[o.id]), names, &[], None)?;
                put(key, &v);
                v
            }
        };
        let single = sh.power(&vals).2;
        let mut path_power = single;
        if depends.len() > 1 {
            let v = session.eval_nodes_with(&without(depends), names, &[], None)?;
            path_power = sh.power(&v).2;
        }
        let mut row = json!({ "id": id, "dist": dist, "offence": 0.0, "defence": 0.0, "single": single, "pathPower": path_power, "allocated": true });
        if let Some(&e) = j.effects.first() {
            row["effects"] = json!([{ "e": e, "offence": 0.0, "defence": 0.0, "single": single, "pathPower": path_power }]);
        }
        return Ok(Done { row, counts: false, dist, cands: Vec::new() });
    }
    let is_mastery = j.mastery.is_some();
    let mut best: Option<(f64, f64, f64, Option<f64>)> = None;
    let mut per_effect: Vec<Value> = Vec::new();
    let mut cands: Vec<(f64, f64, f64)> = Vec::new();
    let candidates: Vec<Option<i64>> = if is_mastery { j.effects.iter().map(|&e| Some(e)).collect() } else { vec![None] };
    for eff in candidates {
        let cached = if eff.is_none() { get(key) } else { None };
        let vals: Vec<Option<f64>> = match cached {
            Some(v) => v,
            None => {
                // Under a key the value is the first job's own; a mastery effect is always this job's.
                let o = if eff.is_none() { sh.owner.get(key).map_or(j, |&i| &jobs[i]) } else { j };
                let mut nodes = sh.base_nodes.clone();
                nodes.push(o.id);
                let v = session.eval_nodes_with(&nodes, names, &[o.id], eff.map(|e| (o.id, e)))?;
                if eff.is_none() {
                    put(key, &v);
                }
                v
            }
        };
        let (off, def, single) = sh.power(&vals);
        // The chosen stat's change for the whole path (nodes more than one step away only).
        let mut path_power = None;
        if sh.stat.is_some() && counts {
            path_power = Some(single);
            if dist > 1 {
                let mut nodes = sh.base_nodes.clone();
                for &p in &j.path {
                    if !nodes.contains(&p) {
                        nodes.push(p);
                    }
                }
                let v = session.eval_nodes_with(&nodes, names, &[], eff.map(|e| (id, e)))?;
                path_power = Some(sh.power(&v).2);
            }
        }
        cands.push((single, off, def));
        if let Some(e) = eff {
            per_effect.push(json!({ "e": e, "offence": off, "defence": def, "single": single, "pathPower": path_power }));
        }
        best = Some(match best {
            None => (off, def, single, path_power),
            Some(b) => (b.0.max(off), b.1.max(def), b.2.max(single), match (b.3, path_power) {
                (Some(x), Some(y)) => Some(x.max(y)),
                (x, y) => x.or(y),
            }),
        });
    }
    let (off, def, single, pp) = best.unwrap_or((0.0, 0.0, 0.0, None));
    let mut row = json!({ "id": id, "dist": dist, "offence": off, "defence": def, "single": single, "pathPower": pp });
    if is_mastery {
        // Each effect keeps its own power: upstream's report lists one row per effect.
        row["effects"] = Value::Array(per_effect);
    }
    Ok(Done { row, counts, dist, cands })
}

/// Worker threads for a run: the cores less two (the machine stays usable); none when that leaves fewer than two.
/// `POM_POWER_THREADS` sets the number (1 or 0: the calling thread only).
fn worker_count(jobs: usize) -> usize {
    if let Some(t) = std::env::var("POM_POWER_THREADS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return if t <= 1 { 0 } else { t.min(jobs) };
    }
    let cores = std::thread::available_parallelism().map(|c| c.get()).unwrap_or(1);
    let n = cores.saturating_sub(2).min(12).min(jobs / 8);
    if n < 2 {
        0
    } else {
        n
    }
}

fn start_workers(run: &mut PowerRun) {
    let n = worker_count(run.jobs.len());
    if n == 0 {
        return;
    }
    let (rtx, rrx) = std::sync::mpsc::channel::<(usize, Result<Done, String>)>();
    for t in 0..n {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<usize>>();
        let (xml, sh, jobs, cache, rtx) = (run.xml.clone(), run.shared.clone(), run.jobs.clone(), run.cache.clone(), rtx.clone());
        let spawned = std::thread::Builder::new().name(format!("power-{t}")).stack_size(64 * 1024 * 1024).spawn(move || {
            let mut session = Session::new(xml, pom_calc::data::game_data());
            for batch in rx {
                for i in batch {
                    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| compute(&mut session, &sh, &cache, &jobs, &jobs[i]))).unwrap_or_else(|_| Err("node power worker failed".into()));
                    if rtx.send((i, r)).is_err() {
                        return;
                    }
                }
            }
        });
        if spawned.is_ok() {
            run.workers.push(Worker { tx });
        }
    }
    run.results = Some(rrx);
}

/// Works for about `budget_ms` and returns the nodes finished (see `NodePowerStep` in the protocol).
pub fn step(session: &mut Session, run: &mut PowerRun, budget_ms: u64) -> Result<Value, String> {
    if session.xml() != run.xml {
        return Ok(json!({ "active": false, "done": true, "progress": 0, "nodes": [] }));
    }
    let started = std::time::Instant::now();
    let mut out: Vec<Value> = Vec::new();
    if run.results.is_none() {
        start_workers(run);
    }
    let total = run.jobs.len();
    while run.next < total {
        let mut finished: Vec<(usize, Done)> = Vec::new();
        if run.workers.is_empty() {
            let i = run.next;
            run.next += 1;
            finished.push((i, compute(session, &run.shared, &run.cache, &run.jobs, &run.jobs[i])?));
        } else {
            // Two jobs per worker per round; the step ends after the first round that passes the budget.
            let n = run.workers.len();
            let take = (n * 2).min(total - run.next);
            let mut batches: Vec<Vec<usize>> = vec![Vec::new(); n];
            // Jobs with the same key go to the same worker, in job order, so what a worker has already worked out (and the
            // cached figures) never depends on how the threads happened to run: a run gives the same rows every time.
            for k in 0..take {
                let i = run.next + k;
                let key = &run.jobs[i].key;
                let w = if key.is_empty() { i % n } else { run.shared.owner.get(key).copied().unwrap_or(i) % n };
                batches[w].push(i);
            }
            run.next += take;
            for (w, b) in run.workers.iter().zip(batches) {
                if !b.is_empty() && w.tx.send(b).is_err() {
                    return Err("node power worker stopped".into());
                }
            }
            let rx = run.results.as_ref().ok_or("node power workers missing")?;
            for _ in 0..take {
                let (i, r) = rx.recv().map_err(|_| "node power worker stopped".to_string())?;
                finished.push((i, r?));
            }
            finished.sort_by_key(|f| f.0);
        }
        for (_, d) in finished {
            if d.counts {
                let dd = d.dist.max(1) as f64;
                for (single, off, def) in &d.cands {
                    run.max[0] = run.max[0].max(*single);
                    run.max[1] = run.max[1].max(*off);
                    run.max[2] = run.max[2].max(*off / dd);
                    run.max[3] = run.max[3].max(*def);
                    run.max[4] = run.max[4].max(*def / dd);
                }
            }
            out.push(d.row);
        }
        if started.elapsed().as_millis() as u64 >= budget_ms {
            break;
        }
    }
    let done = run.next >= total;
    let mut v = json!({ "active": true, "done": done, "progress": if run.jobs.is_empty() { 100 } else { run.next * 100 / run.jobs.len() }, "nodes": out });
    if done {
        v["max"] = json!({ "singleStat": run.max[0], "offence": run.max[1], "offencePerPoint": run.max[2], "defence": run.max[3], "defencePerPoint": run.max[4] });
    }
    Ok(v)
}
