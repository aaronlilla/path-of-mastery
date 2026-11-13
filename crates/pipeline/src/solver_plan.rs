//! Plan leads and the open-ended stop rule: the AI plans and the solver tests.
//!
//! The goal's `plan.leads` come from the player's own AI: each names an ascendancy (or class), key uniques, supports,
//! keystones and why. Each runs as its own solve: that context only, its uniques must-use when the wealth tier allows
//! them (a unique above the tier is reported, never used), its supports required, its keystones seeded. The plan runs
//! first; the solver's own leads (the goal as asked, every class that fits the skill) run after it as one more lead.
//!
//! With a time budget the leads share it, one round each. Without one (0 or left out) the run has no clock: each round
//! gives every live lead a solve with twice the tries of its last (`ROUND_TRIES` first); a lead stalls when a whole
//! round gains less than `STALL_GAIN` over its best so far. Each stalled lead is published at once in the snapshot's `stalls` (how close it
//! came, what held it back, whether more time helps) while the others keep running; the AI may send replacement leads
//! into the running solve (`Handle::add_leads`), which join the loop at their own first round. The run ends when a
//! result meets every target (`met`). With a plan, a run whose every lead has stalled waits (`idle`, no work) for new
//! leads or Stop (the app stops it when the AI's answer to that adds none); without one it ends `stalled`.

use super::*;

/// The first round's tries per lead with no time budget (or the options' `maxEvals`); each later round doubles them.
/// The round has no clock: the work is its tries, so a busy PC takes longer, never does less.
const ROUND_TRIES: u64 = 37_500;
/// A lead stalls when a whole round (twice the tries of the one before, as many as all earlier rounds and one more
/// first round) gains less than this (5%) on its goal progress. Judged at the round's end only: a round finds its best
/// in its last phases (P1 trace: 1.48M at 48k of 75k tries, 3.31M at 77k), so a cut mid-round would cut the gain.
const STALL_GAIN: f64 = 0.05;
/// Results kept per lead (its best round's best).
const KEEP: usize = 3;

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
struct PlanLead {
    name: String,
    class_name: Option<String>,
    ascendancy: Option<String>,
    uniques: Vec<String>,
    supports: Vec<String>,
    keystones: Vec<String>,
    why: Option<String>,
    /// The stalled lead this one replaces (the AI's swap; the panel shows it under that lead).
    replaces: Option<String>,
    /// The lead's own start build (build XML text playing the goal's skill, e.g. a compiled route): every round of this
    /// lead starts from it as a whole build instead of the open build.
    start_build: Option<String>,
}

fn plan_leads(goal: &Value) -> Vec<PlanLead> {
    goal.pointer("/plan/leads").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default()
}

/// The goal has a plan, or the options set no time budget.
pub(super) fn wanted(goal_json: &str, opts: &Options) -> bool {
    let plan = serde_json::from_str::<Value>(goal_json).map(|g| !plan_leads(&g).is_empty()).unwrap_or(false);
    plan || opts.time_budget_ms.unwrap_or(0) == 0
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Status {
    Live,
    Met,
    Stalled,
    Failed,
    Stopped,
}

impl Status {
    fn word(self) -> &'static str {
        match self {
            Status::Live => "running",
            Status::Met => "met",
            Status::Stalled => "stalled",
            Status::Failed => "error",
            Status::Stopped => "stopped",
        }
    }
}

struct Lead {
    name: String,
    class_name: Option<String>,
    ascendancy: Option<String>,
    why: Option<String>,
    replaces: Option<String>,
    /// The lead's own start build (None: the open build).
    xml: Option<String>,
    goal: Value,
    notes: Vec<String>,
    status: Status,
    rounds: u32,
    evals: u64,
    /// The best round's best results (result json, build text), best first.
    kept: Vec<(Value, Arc<String>)>,
    baseline: Option<Value>,
    last_gain: Option<f64>,
    /// The best round was cut by the clock before its tries were spent (a slow PC), not proven out.
    clock_cut: bool,
    error: Option<String>,
}

/// Gain of `b` over `o` (feasibility first, then progress in log terms).
fn gain(b: Option<(bool, f64)>, o: Option<(bool, f64)>) -> f64 {
    match (b, o) {
        (Some(b), Some(o)) if b.0 && !o.0 => f64::INFINITY,
        (Some(b), Some(o)) if !b.0 && o.0 => -1.0,
        (Some(b), Some(o)) => (b.1 - o.1).exp() - 1.0,
        (Some(_), None) => f64::INFINITY,
        (None, _) => -1.0,
    }
}

/// Goal progress of one result: (every limit met, the parent scorer's own score: weights, limits and soft pushes).
/// A row without a score falls back to the sum of ln(value), each valued target capped at its value.
fn progress(r: &Value) -> (bool, f64) {
    let feasible = r["limitsMet"].as_bool() == Some(true);
    if let Some(sc) = r["score"].as_f64().filter(|s| s.is_finite()) {
        return (feasible, sc);
    }
    let q = r["targets"]
        .as_array()
        .map(|ts| {
            ts.iter()
                .map(|t| {
                    let v = t["value"].as_f64().unwrap_or(0.0).max(1e-9);
                    match t["target"].as_f64().filter(|x| *x > 0.0) {
                        Some(tv) => v.min(tv).ln(),
                        None => v.ln(),
                    }
                })
                .sum()
        })
        .unwrap_or(f64::NEG_INFINITY);
    (feasible, q)
}

fn better(a: (bool, f64), b: (bool, f64)) -> bool {
    (a.0 && !b.0) || (a.0 == b.0 && a.1 > b.1)
}

/// Every limit met and every target with a value reached (a goal with no target value is never met: it runs until stalled).
fn all_met(r: &Value) -> bool {
    let ts = r["targets"].as_array().cloned().unwrap_or_default();
    r["limitsMet"].as_bool() == Some(true) && ts.iter().any(|t| t["target"].is_number()) && ts.iter().all(|t| t["met"].as_bool() != Some(false))
}

fn short(x: f64) -> String {
    super::short_num(x)
}

/// How early a plan lead's support is tried (0.5 is the neutral order, 1 the first).
const LEAD_SUPPORT_PRIORITY: f64 = 0.9;

/// The goal JSON for one plan lead (the goal as asked, narrowed to the lead), with what was left out and why.
fn lead_goal(raw: &Value, goal: &Goal, p: &PlanLead) -> (Value, Vec<String>) {
    let mut g = raw.clone();
    let mut notes = Vec::new();
    let o = g.as_object_mut().expect("goal object");
    o.remove("plan");
    if let Some(c) = p.class_name.as_ref().filter(|c| !c.trim().is_empty()) {
        o.insert("className".into(), json!(c));
    }
    if let Some(a) = p.ascendancy.as_ref().filter(|a| !a.trim().is_empty()) {
        o.insert("ascendancy".into(), json!(a));
    }
    // A lead's supports are soft hypotheses: tried first (priority), kept only if the engine values them. gems.require stays the player's own locks.
    let mut soft: serde_json::Map<String, Value> = o.get("priority").and_then(|v| v["supports"].as_object().cloned()).unwrap_or_default();
    for s in &p.supports {
        if find_gem(s).is_some() {
            let v = soft.get(s).and_then(|x| x.as_f64()).unwrap_or(0.0).max(LEAD_SUPPORT_PRIORITY);
            soft.insert(s.clone(), json!(v));
        } else {
            notes.push(format!("{s}: no such gem, left out"));
        }
    }
    let pr = o.entry("priority").or_insert_with(|| json!({}));
    if !pr.is_object() {
        *pr = json!({});
    }
    pr["supports"] = Value::Object(soft);
    let wealth = goal.wealth.unwrap_or(Wealth::Mirror);
    let mut must: Vec<Value> = o.get("items").and_then(|v| v["mustUse"].as_array().cloned()).unwrap_or_default();
    for u in &p.uniques {
        let price = Wealth::price(&goal.unique_prices, u);
        if Wealth::of_price(price) <= wealth {
            must.push(json!(u));
        } else {
            notes.push(match price {
                Some(d) => format!("{u} left out: about {d:.1} divine, above {}", wealth.key()),
                None => format!("{u} left out: not on the market, above {}", wealth.key()),
            });
        }
    }
    let items = o.entry("items").or_insert_with(|| json!({}));
    if !items.is_object() {
        *items = json!({});
    }
    items["mustUse"] = json!(must);
    if !p.keystones.is_empty() {
        o.insert("keystones".into(), json!(p.keystones));
    }
    (g, notes)
}

/// What held a lead's best result back, in one line: the limit or target short, the gear budget at the tier, the gear's share.
fn limiting(r: &Value, goal: &Goal, baseline: Option<&Value>) -> String {
    let mut bits = Vec::new();
    match r["blocking"]["kind"].as_str() {
        Some("limit") => {
            let name = r["blocking"]["name"].as_str().unwrap_or("");
            let l = r["limits"].as_array().and_then(|ls| ls.iter().find(|l| l["name"] == name).cloned());
            bits.push(match l {
                Some(l) => format!("{name}: {} of {}", short(l["value"].as_f64().unwrap_or(0.0)), short(l["need"].as_f64().unwrap_or(0.0))),
                None => name.to_string(),
            });
        }
        Some("target") => {
            let name = r["blocking"]["name"].as_str().unwrap_or("");
            if let Some(t) = r["targets"].as_array().and_then(|ts| ts.iter().find(|t| t["name"] == name)) {
                bits.push(format!("{name} {} of {}", short(t["value"].as_f64().unwrap_or(0.0)), short(t["target"].as_f64().unwrap_or(0.0))));
                // (the tree and gems alone, nothing equipped: how much of the damage the gear carries)
                let dps = matches!(t["metric"].as_str(), Some("combined" | "hit" | "dot" | "boss" | "full" | "minion" | "clear" | "bossdps" | ""));
                if let (true, Some(d)) = (dps, baseline.and_then(|b| b["dps"].as_f64())) {
                    bits.push(format!("tree and gems alone give {} of it", short(d)));
                }
            }
        }
        _ => {}
    }
    if let (Some(w), Some(cost)) = (goal.wealth, r["costDivines"].as_f64()) {
        if let Some(b) = w.budget().filter(|b| cost >= 0.9 * b) {
            // (bare slots beside a spent budget: the split, not the budget, held it back)
            bits.push(match r["bareSlots"].as_u64().unwrap_or(0) {
                0 => format!("gear budget used up at {} ({cost:.1} of {b:.0} divine)", w.key()),
                n => format!("{n} gear slots bare while gems and links take {:.1} of {b:.0} divine", r["gemsDivines"].as_f64().unwrap_or(0.0)),
            });
        }
    }
    if let Some(l) = r["lead"]["label"].as_str() {
        bits.push(format!("best route {l}"));
    }
    if bits.is_empty() {
        "nothing short".into()
    } else {
        bits.join("; ")
    }
}

struct Driver {
    xml: String,
    raw: Value,
    opts: Options,
    goal: Goal,
    shared: Arc<(Mutex<Shared>, std::sync::Condvar)>,
    cancel: Arc<AtomicBool>,
    inbox: Arc<Mutex<Vec<Value>>>,
    leads: Vec<Lead>,
    started: Instant,
    evals: u64,
    /// The last lead round's final snapshot: its assumptions, level and points stand for the whole run.
    last: Value,
    /// The goal came with a plan: an AI is there to answer stalls, so a run whose every lead stalled waits for it.
    planned: bool,
    /// Every lead has stalled and the run waits for new leads or Stop.
    idle: bool,
}

fn new_lead(name: String, p: &PlanLead, (goal, notes): (Value, Vec<String>)) -> Lead {
    Lead { name, class_name: p.class_name.clone(), ascendancy: p.ascendancy.clone(), why: p.why.clone(), replaces: p.replaces.clone(), xml: p.start_build.clone().filter(|x| !x.trim().is_empty()), goal, notes, status: Status::Live, rounds: 0, evals: 0, kept: Vec::new(), baseline: None, last_gain: None, clock_cut: false, error: None }
}

/// One lead's best against every target value and limit, what limits it and whether time helps (`SolveEnd` and `stalls` rows).
fn end_row(row: &Value, r: Option<&Value>) -> Value {
    let mut values: Vec<Value> = r.and_then(|r| r["targets"].as_array()).map(|ts| ts.iter().filter(|t| t["target"].is_number()).map(|t| json!({ "name": t["name"], "value": t["value"], "need": t["target"] })).collect()).unwrap_or_default();
    values.extend(r.and_then(|r| r["limits"].as_array()).map(|ls| ls.iter().map(|l| json!({ "name": l["name"], "value": l["value"], "need": l["need"] })).collect::<Vec<_>>()).unwrap_or_default());
    let mut lead = json!({ "name": row["name"], "values": values, "moreTimeHelps": row["moreTimeHelps"] });
    let limiting = match (row["limiting"].as_str(), row["error"].as_str()) {
        (_, Some(err)) => Some(format!("did not run: {err}")),
        (Some(l), _) => Some(l.to_string()),
        _ => None,
    };
    if let Some(l) = limiting {
        lead["limiting"] = json!(l);
    }
    lead
}

type RoundFn<'a> = dyn FnMut(&mut Driver, usize, u64, Option<u64>, u32) -> Option<(Value, Vec<Arc<String>>)> + 'a;

impl Driver {
    fn new(xml: String, raw: Value, opts: Options, shared: Arc<(Mutex<Shared>, std::sync::Condvar)>, cancel: Arc<AtomicBool>, inbox: Arc<Mutex<Vec<Value>>>) -> Result<Self, String> {
        let goal: Goal = serde_json::from_value(raw.clone()).map_err(|e| format!("goal json: {e}"))?;
        let plan = plan_leads(&raw);
        let mut leads: Vec<Lead> = Vec::new();
        for (k, p) in plan.iter().enumerate() {
            let name = if p.name.trim().is_empty() { format!("Lead {}", k + 1) } else { p.name.clone() };
            leads.push(new_lead(name, p, lead_goal(&raw, &goal, p)));
        }
        // The solver's own leads run beside the plan: the goal as asked, every class that fits the skill.
        let mut own = raw.clone();
        own.as_object_mut().ok_or("goal json: not an object")?.remove("plan");
        let me = PlanLead { class_name: goal.class_name.clone(), ascendancy: goal.ascendancy.clone(), ..Default::default() };
        leads.push(new_lead("Solver's own leads".into(), &me, (own, Vec::new())));
        Ok(Driver { xml, raw, opts, goal, shared, cancel, inbox, leads, started: Instant::now(), evals: 0, last: json!({}), planned: !plan.is_empty(), idle: false })
    }

    /// Leads the AI sent since the last look join the run (bad entries dropped). True when any arrived.
    fn take_new(&mut self) -> bool {
        let new: Vec<Value> = std::mem::take(&mut *self.inbox.lock().unwrap_or_else(|e| e.into_inner()));
        let mut any = false;
        for v in new {
            let Ok(p) = serde_json::from_value::<PlanLead>(v) else { continue };
            let name = if p.name.trim().is_empty() { format!("Lead {}", self.leads.len() + 1) } else { p.name.clone() };
            let g = lead_goal(&self.raw, &self.goal, &p);
            self.leads.push(new_lead(name, &p, g));
            any = true;
        }
        any
    }

    /// The lead loop: always the live lead with the fewest rounds next (a new lead starts at its own first round), until
    /// `met`, `stopped`, `budget` (every lead had its one round of a time budget), or `stalled`/`error` without a plan.
    /// With a plan, every lead stalled means wait for new leads or Stop. `solve` runs one round (a fake in tests).
    fn run(&mut self, solve: &mut RoundFn) -> &'static str {
        let budget = self.opts.time_budget_ms.filter(|&b| b > 0);
        let n = self.leads.len() as u64;
        loop {
            if self.cancel.load(Ordering::Relaxed) {
                return "stopped";
            }
            if self.take_new() {
                self.idle = false;
                self.publish(None, None);
            }
            let next = (0..self.leads.len()).filter(|&i| self.leads[i].status == Status::Live && (budget.is_none() || self.leads[i].rounds == 0)).min_by_key(|&i| self.leads[i].rounds);
            let Some(i) = next else {
                if budget.is_some() {
                    return "budget";
                }
                if !self.planned {
                    return if self.leads.iter().all(|l| l.status == Status::Failed) { "error" } else { "stalled" };
                }
                if !self.idle {
                    self.idle = true;
                    self.publish(None, None);
                }
                // (no work while waiting: a look at the inbox and Stop four times a second)
                std::thread::sleep(std::time::Duration::from_millis(250));
                continue;
            };
            let k = self.leads[i].rounds;
            let (ms, evals) = match budget {
                Some(b) => ((b / n).max(1000), self.opts.max_evals.map(|m| (m / n).max(1))),
                None => {
                    let tries = self.opts.max_evals.unwrap_or(ROUND_TRIES) << k.min(10);
                    // (no clock: a second per try never binds, so the round always does its tries)
                    (tries.saturating_mul(1000), Some(tries))
                }
            };
            if let Some((snap, xmls)) = solve(self, i, ms, evals, k + 1) {
                self.record(i, snap, xmls);
            }
            self.publish(None, None);
            if self.cancel.load(Ordering::Relaxed) {
                return "stopped";
            }
            if self.leads[i].status == Status::Met {
                return "met";
            }
        }
    }

    /// The results of every finished lead round, best first (one list: picks and results index into it).
    fn kept(&self) -> Vec<(usize, Value, Arc<String>)> {
        let mut v: Vec<(usize, Value, Arc<String>)> = self.leads.iter().enumerate().flat_map(|(i, l)| l.kept.iter().map(move |(r, x)| (i, r.clone(), x.clone()))).collect();
        v.sort_by(|a, b| {
            let (pa, pb) = (progress(&a.1), progress(&b.1));
            if better(pa, pb) {
                std::cmp::Ordering::Less
            } else if better(pb, pa) {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        });
        v
    }

    fn lead_json(&self, i: usize, best_at: Option<usize>, best: Option<&Value>) -> Value {
        let l = &self.leads[i];
        let targets: Vec<Value> = best.and_then(|r| r["targets"].as_array()).map(|ts| ts.iter().map(|t| json!({ "name": t["name"], "value": t["value"], "target": t["target"], "met": t["met"] })).collect()).unwrap_or_default();
        let more_time = match l.status {
            Status::Met | Status::Failed => false,
            Status::Stalled => l.clock_cut,
            Status::Live | Status::Stopped => l.rounds < 2 || l.clock_cut || l.last_gain.is_some_and(|g| g >= STALL_GAIN),
        };
        json!({
            "id": i,
            "name": l.name,
            "replaces": l.replaces,
            "className": l.class_name,
            "ascendancy": l.ascendancy,
            "why": l.why,
            "status": l.status.word(),
            "rounds": l.rounds,
            "evaluations": l.evals,
            "best": best_at,
            "targets": targets,
            "limitsMet": best.map(|r| r["limitsMet"].clone()).unwrap_or(Value::Null),
            "limiting": best.map(|r| limiting(r, &self.goal, l.baseline.as_ref())),
            "moreTimeHelps": more_time,
            "lastGainPct": l.last_gain.map(|g| (g * 1000.0).round() / 10.0),
            "notes": l.notes,
            "error": l.error,
        })
    }

    /// The outer snapshot: the finished rounds' results (best first), then the running round's live ones; picks are
    /// each lead's best; `plan` has every lead's standing.
    fn publish(&self, live: Option<(usize, &Value, &[Arc<String>])>, end: Option<&str>) {
        let kept = self.kept();
        let mut results: Vec<Value> = Vec::new();
        let mut xmls: Vec<Arc<String>> = Vec::new();
        let mut best_at: Vec<Option<usize>> = vec![None; self.leads.len()];
        let mut start_seen = false;
        for (li, mut r, x) in kept {
            // (the open build's own row is the same in every lead: listed once)
            if r["start"].as_bool() == Some(true) {
                if start_seen {
                    continue;
                }
                start_seen = true;
            } else if best_at[li].is_none() {
                best_at[li] = Some(results.len());
            }
            r["index"] = json!(results.len());
            r["planLead"] = json!(self.leads[li].name);
            results.push(r);
            xmls.push(x);
        }
        let mut picks: Vec<usize> = best_at.iter().flatten().copied().collect();
        picks.sort_unstable();
        let mut snap = live.map(|(_, s, _)| s.clone()).unwrap_or_else(|| self.last.clone());
        if let Some((li, s, lx)) = live {
            for (k, r) in s["results"].as_array().cloned().unwrap_or_default().into_iter().enumerate() {
                let Some(x) = lx.get(k) else { continue };
                let mut r = r;
                r["index"] = json!(results.len());
                r["planLead"] = json!(self.leads[li].name);
                results.push(r);
                xmls.push(x.clone());
            }
            snap["candidate"] = json!(format!("{} · {}", self.leads[li].name, s["candidate"].as_str().unwrap_or("")));
        }
        let lead_rows: Vec<Value> = (0..self.leads.len()).map(|i| self.lead_json(i, best_at[i], best_at[i].map(|k| &results[k]))).collect();
        let o = snap.as_object_mut().expect("snapshot object");
        let elapsed = self.started.elapsed().as_millis() as u64;
        let evals = self.evals + live.and_then(|(_, s, _)| s["evaluations"].as_u64()).unwrap_or(0);
        o.insert("active".into(), json!(end.is_none()));
        o.insert("done".into(), json!(false));
        o.insert("idle".into(), json!(self.idle && end.is_none()));
        o.insert("evaluations".into(), json!(evals));
        o.insert("elapsedMs".into(), json!(elapsed));
        o.insert("evalsPerSec".into(), json!(if elapsed > 0 { (evals as f64 * 1000.0 / elapsed as f64).round() } else { 0.0 }));
        if live.is_none() {
            o.insert("layer".into(), json!(if end.is_some() { "done" } else if self.idle { "waiting for new leads" } else { "plan" }));
            o.insert("budgetMs".into(), json!(self.opts.time_budget_ms.unwrap_or(0)));
            if let Some(b) = self.leads.iter().filter_map(|l| l.baseline.clone()).next() {
                o.insert("baseline".into(), b);
            }
        }
        // (`leads` is the inner solver's own weapon/route leads: it means nothing across lead solves)
        o.remove("leads");
        o.insert("results".into(), json!(&results));
        o.insert("picks".into(), json!(picks));
        o.insert("plan".into(), json!({ "leads": lead_rows }));
        if let Some(e) = end {
            o.insert("endReason".into(), json!(e));
        }
        // Each lead that stalled (or could not run) while the run goes on: its record for the AI's swap, by lead id.
        let stalls: Vec<Value> = (0..self.leads.len())
            .filter(|&i| matches!(self.leads[i].status, Status::Stalled | Status::Failed))
            .map(|i| {
                let mut r = end_row(&lead_rows[i], best_at[i].map(|k| &results[k]));
                r["id"] = json!(i);
                r
            })
            .collect();
        o.insert("stalls".into(), json!(stalls));
        // The run ended by itself (`SolveEnd`): each lead's best against every target value and limit, for the AI to re-plan.
        if let Some(e @ ("met" | "stalled")) = end {
            let rows: Vec<Value> = lead_rows.iter().zip(&best_at).map(|(row, b)| end_row(row, b.map(|k| &results[k]))).collect();
            o.insert("end".into(), json!({ "reason": e, "leads": rows }));
        }
        let (m, cv) = &*self.shared;
        let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
        g.snapshot = snap;
        for (r, x) in results.iter().zip(&xmls) {
            if let Some(id) = r["id"].as_str() {
                g.by_id.entry(id.to_string()).or_insert_with(|| x.clone());
            }
        }
        g.results = xmls;
        g.version += 1;
        cv.notify_all();
    }

    /// One round of lead `i`: a whole solve of its goal with this budget, the outer snapshot updated as it goes. Returns
    /// the round's final snapshot and builds (None: the lead could not start, marked failed).
    fn solve_lead(&mut self, i: usize, ms: u64, evals: Option<u64>, round: u32) -> Option<(Value, Vec<Arc<String>>)> {
        let goal: Goal = match serde_json::from_value(self.leads[i].goal.clone()) {
            Ok(g) => g,
            Err(e) => {
                self.leads[i].status = Status::Failed;
                self.leads[i].error = Some(format!("goal json: {e}"));
                return None;
            }
        };
        let mut opts = self.opts.clone();
        opts.time_budget_ms = Some(ms);
        opts.max_evals = evals;
        opts.in_plan = true;
        // (each round from its own seed: a fresh search, not the last one again)
        opts.seed = Some(self.opts.seed.unwrap_or(0).wrapping_add(round as u64 - 1));
        let sub = Arc::new((Mutex::new(Shared { snapshot: json!({ "results": [] }), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        // (its own stop: Stop reaches it below)
        let sub_cancel = Arc::new(AtomicBool::new(false));
        let (xml, sh, ca) = (self.leads[i].xml.clone().unwrap_or_else(|| self.xml.clone()), sub.clone(), sub_cancel.clone());
        let t = std::thread::Builder::new().name("solve-lead".into()).stack_size(WORKER_STACK).spawn(move || {
            crate::solver::below_normal();
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
                pom_engine::modparser::text_rules::set_active(true);
                Solver::new(xml, goal, opts, sh.clone(), ca)?.run()
            }));
            let err = match r {
                Ok(Ok(())) => None,
                Ok(Err(e)) => Some(e),
                Err(_) => Some("the solver stopped on an internal error".to_string()),
            };
            let (m, cv) = &*sh;
            let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
            g.done = true;
            g.version += 1;
            if let Some(e) = err {
                g.snapshot["error"] = json!(e);
            }
            cv.notify_all();
        });
        let Ok(t) = t else {
            self.leads[i].status = Status::Failed;
            self.leads[i].error = Some("cannot start the solver thread".into());
            return None;
        };
        let mut seen = 0;
        let (snap, xmls) = loop {
            if self.cancel.load(Ordering::Relaxed) {
                sub_cancel.store(true, Ordering::Relaxed);
            }
            let (snap, xmls, done) = {
                let (m, cv) = &*sub;
                let mut g = m.lock().unwrap_or_else(|e| e.into_inner());
                let deadline = Instant::now() + std::time::Duration::from_millis(1000);
                while g.version <= seen && !g.done {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    g = cv.wait_timeout(g, deadline - now).map(|r| r.0).unwrap_or_else(|e| e.into_inner().0);
                }
                seen = g.version;
                (g.snapshot.clone(), g.results.clone(), g.done)
            };
            if done {
                break (snap, xmls);
            }
            self.publish(Some((i, &snap, &xmls)), None);
        };
        let _ = t.join();
        Some((snap, xmls))
    }

    /// Books a lead round: its tries, its best if it gained, and whether it met, stalled or was stopped.
    fn record(&mut self, i: usize, snap: Value, xmls: Vec<Arc<String>>) {
        if snap.is_object() {
            self.last = snap.clone();
            if let Some(o) = self.last.as_object_mut() {
                o.remove("error");
            }
        }
        let l = &mut self.leads[i];
        l.rounds += 1;
        let used = snap["evaluations"].as_u64().unwrap_or(0);
        l.evals += used;
        self.evals += used;
        if let Some(e) = snap["error"].as_str() {
            l.status = Status::Failed;
            l.error = Some(e.to_string());
            return;
        }
        let mut rs: Vec<(Value, Arc<String>)> = snap["results"].as_array().cloned().unwrap_or_default().into_iter().zip(xmls).collect();
        rs.sort_by(|a, b| if better(progress(&a.0), progress(&b.0)) { std::cmp::Ordering::Less } else if better(progress(&b.0), progress(&a.0)) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Equal });
        let best = rs.iter().find(|(r, _)| r["start"].as_bool() != Some(true)).map(|(r, _)| progress(r));
        let old = l.kept.iter().find(|(r, _)| r["start"].as_bool() != Some(true)).map(|(r, _)| progress(r));
        // Gain of this round's best over the lead's best so far.
        let gain = gain(best, old);
        let clock_cut = snap["assumptions"].as_array().is_some_and(|a| a.iter().any(|x| x.as_str().is_some_and(|s| s.starts_with("Stopped at the time limit"))));
        if gain > 0.0 {
            l.kept = rs.into_iter().take(KEEP).collect();
            l.baseline = snap.get("baseline").cloned().filter(|b| !b.is_null());
            l.clock_cut = clock_cut;
        }
        if l.rounds >= 2 {
            l.last_gain = Some(gain.min(10.0));
        }
        if self.cancel.load(Ordering::Relaxed) {
            l.status = Status::Stopped;
        } else if l.kept.iter().any(|(r, _)| all_met(r)) {
            l.status = Status::Met;
        } else if self.opts.time_budget_ms.unwrap_or(0) == 0 && l.rounds >= 2 && gain < STALL_GAIN {
            l.status = Status::Stalled;
        }
    }
}

/// Runs the plan (and the solver's own leads) to the end: `met`, `stalled` (no plan), `stopped`, or `budget` (a time budget spent).
pub(super) fn drive(xml: String, goal_json: String, opts: Options, shared: Arc<(Mutex<Shared>, std::sync::Condvar)>, cancel: Arc<AtomicBool>, inbox: Arc<Mutex<Vec<Value>>>) -> Result<(), String> {
    let raw: Value = serde_json::from_str(&goal_json).map_err(|e| format!("goal json: {e}"))?;
    let mut d = Driver::new(xml, raw, opts, shared, cancel, inbox)?;
    let reason = d.run(&mut |d, i, ms, evals, round| d.solve_lead(i, ms, evals, round));
    d.idle = false;
    d.publish(None, Some(reason));
    if reason == "error" {
        return Err(d.leads.iter().filter_map(|l| l.error.as_ref().map(|e| format!("{}: {e}", l.name))).collect::<Vec<_>>().join("; "));
    }
    Ok(())
}

/// One finalist as the pick sees it.
pub(super) struct Cand {
    /// The asked figure (Both: the weaker side over its bar).
    pub main: f64,
    /// The other side (credited EHP for a damage ask).
    pub other: f64,
    /// Every stated target reached.
    pub met: bool,
    /// Every hard limit met.
    pub hard: bool,
    /// Survives every counted boss preset.
    pub survives: bool,
    pub score: f64,
}

/// How the pick ranks the finalists that pass the filters.
#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum PickRule {
    /// A single-goal ask: up to `TRADE_GIVE` of the asked figure for a clearly safer build.
    Trade,
    /// Both: the weaker side decides.
    Main,
    /// Several asks: the solver's own score.
    Score,
}

pub(super) struct Picked {
    pub pick: usize,
    /// The highest asked figure, when it is not the pick: stays in the list, marked.
    pub extreme: Option<usize>,
    /// No finalist reaches a stated target: the pick is the best one anyway.
    pub miss: bool,
}

/// What a single-goal pick may give up of the asked figure.
pub(super) const TRADE_GIVE: f64 = 0.15;
/// The other side must beat the top build's by this much to count as clearly safer.
const TRADE_CLEAR: f64 = 1.05;

/// The final pick: hard limits first; never below a stated target when a finalist meets it; a finalist
/// that survives every counted preset beats one that does not; then the rule.
pub(super) fn pick_final(c: &[Cand], rule: PickRule) -> Option<Picked> {
    let top = |ix: &[usize], f: &dyn Fn(&Cand) -> f64| ix.iter().copied().max_by(|&a, &b| f(&c[a]).total_cmp(&f(&c[b])));
    let mut pool: Vec<usize> = (0..c.len()).filter(|&i| c[i].hard).collect();
    if pool.is_empty() {
        pool = (0..c.len()).collect();
    }
    let extreme = top(&pool, &|x| x.main);
    let miss = !pool.iter().any(|&i| c[i].met);
    if !miss {
        pool.retain(|&i| c[i].met);
    }
    if pool.iter().any(|&i| c[i].survives) {
        pool.retain(|&i| c[i].survives);
    }
    let base = top(&pool, &|x| x.main)?;
    let pick = match rule {
        _ if miss => top(&pool, &|x| x.score)?,
        PickRule::Main => base,
        PickRule::Score => top(&pool, &|x| x.score)?,
        PickRule::Trade => {
            let near: Vec<usize> = pool.iter().copied().filter(|&i| c[i].main >= c[base].main * (1.0 - TRADE_GIVE)).collect();
            match top(&near, &|x| x.other) {
                Some(s) if c[s].other > c[base].other * TRADE_CLEAR => s,
                _ => base,
            }
        }
    };
    Some(Picked { pick, extreme: extreme.filter(|&e| e != pick), miss })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(main: f64, other: f64, met: bool, survives: bool) -> Cand {
        Cand { main, other, met, hard: true, survives, score: main.ln() + 0.1 * other.ln() }
    }

    /// 3M target; finalists 3.1M (safer) and 3.6M: the safer one is picked (inside 15%, above the target), the 3.6M stays as the extreme.
    #[test]
    fn pick_trades_but_stays_above_target() {
        let c = [cand(3.6e6, 100e3, true, true), cand(3.1e6, 200e3, true, true), cand(2.9e6, 900e3, false, true)];
        let p = pick_final(&c, PickRule::Trade).unwrap();
        assert_eq!((p.pick, p.extreme, p.miss), (1, Some(0), false), "never the 2.9M one, whatever its EHP");
    }

    /// No finalist meets the target: the best by score, and the miss is stated.
    #[test]
    fn pick_states_the_miss() {
        let c = [cand(2.0e6, 100e3, false, true), cand(2.5e6, 100e3, false, true)];
        let p = pick_final(&c, PickRule::Trade).unwrap();
        assert_eq!((p.pick, p.miss), (1, true));
    }

    /// A preset one-shot against a survivor at similar DPS: the survivor.
    #[test]
    fn pick_prefers_the_survivor() {
        let c = [cand(3.5e6, 100e3, true, false), cand(3.4e6, 100e3, true, true)];
        assert_eq!(pick_final(&c, PickRule::Trade).unwrap().pick, 1);
    }

    /// Both: the weaker side decides (main is the weaker side over its bar).
    #[test]
    fn pick_both_takes_the_weaker_side() {
        let c = [cand(2.0, 1.0, true, true), cand(4.0, 1.0, true, true), cand(3.0, 1.0, true, true)];
        assert_eq!(pick_final(&c, PickRule::Main).unwrap().pick, 1);
    }

    /// A plan lead narrows the goal: its ascendancy, its supports soft (a player lock stays required), its keystones; a unique above the wealth
    /// tier is left out with a note, never used.
    #[test]
    fn plan_lead_goal() {
        let raw: Value = serde_json::from_str(r#"{"skill":"Poisonous Concoction","wealth":"league-start","assume":{"playMode":"mapping"},"plan":{"leads":[]}}"#).unwrap();
        let goal: Goal = serde_json::from_value(raw.clone()).unwrap();
        let p = PlanLead { name: "x".into(), ascendancy: Some("Pathfinder".into()), supports: vec!["Unbound Ailments".into(), "Not A Gem".into()], uniques: vec!["Headhunter".into()], keystones: vec!["Point Blank".into()], ..Default::default() };
        let (g, notes) = lead_goal(&raw, &goal, &p);
        assert_eq!(g["ascendancy"], "Pathfinder");
        assert!(g.get("plan").is_none());
        assert_eq!(g["gems"].get("require").cloned().unwrap_or(json!([])), json!([]));
        assert_eq!(g["priority"]["supports"], json!({"Unbound Ailments": 0.9}));
        // a support the player locked stays required
        let raw2: Value = serde_json::from_str(r#"{"skill":"Poisonous Concoction","gems":{"require":["Hextouch"]}}"#).unwrap();
        let goal2: Goal = serde_json::from_value(raw2.clone()).unwrap();
        let (g2, _) = lead_goal(&raw2, &goal2, &p);
        assert_eq!(g2["gems"]["require"], json!(["Hextouch"]));
        assert_eq!(g["items"]["mustUse"], json!([]), "{notes:?}");
        assert_eq!(g["keystones"], json!(["Point Blank"]));
        assert!(notes.iter().any(|n| n.starts_with("Headhunter left out")) && notes.iter().any(|n| n.starts_with("Not A Gem")), "{notes:?}");
    }

    /// A lead's `startBuild` is that lead's start (an added lead's too); a lead without one and the solver's own leads
    /// start from the open build, and the build text never reaches a lead's goal.
    #[test]
    fn lead_carries_its_start_build() {
        let goal = r#"{"skill":"Poisonous Concoction","plan":{"leads":[{"name":"A","startBuild":"<route-a/>"},{"name":"B"}]}}"#;
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let inbox = Arc::new(Mutex::new(vec![json!({ "name": "C", "startBuild": "<route-c/>" })]));
        let mut d = Driver::new("<open/>".into(), serde_json::from_str(goal).unwrap(), Options::default(), shared, Arc::new(AtomicBool::new(false)), inbox).unwrap();
        assert!(d.take_new());
        let starts: Vec<(&str, Option<&str>)> = d.leads.iter().map(|l| (l.name.as_str(), l.xml.as_deref())).collect();
        assert_eq!(starts, vec![("A", Some("<route-a/>")), ("B", None), ("Solver's own leads", None), ("C", Some("<route-c/>"))]);
        assert!(d.leads.iter().all(|l| !l.goal.to_string().contains("route-")));
    }

    /// The four SRS lead results of one run, all limits met: the parent scorer puts Necromancer first;
    /// the unweighted sum of ln(value) put the solver's own leads first (11.7165 against 11.7074).
    #[test]
    fn leads_rank_by_the_parent_score() {
        let row = |lead: &str, dps: f64, ms: f64, score: f64| json!({ "planLead": lead, "limitsMet": true, "score": score, "targets": [{ "name": "DPS", "value": dps }, { "name": "Movement speed", "value": ms }] });
        let rows = [
            row("Solver's own leads", 55604.508743453654, 2.2045420118343197, 11.321279460929883),
            row("Necromancer spirits", 91325.31067587201, 1.33, 11.555472724645561),
            row("Hierophant spirits", 67987.01361489845, 1.65, 11.374159633624709),
            row("Occultist spirits", 53988.95007455419, 1.41, 11.068329528553237),
        ];
        let best = rows.iter().max_by(|a, b| if better(progress(a), progress(b)) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less }).unwrap();
        assert_eq!(best["planLead"], "Necromancer spirits");
        // (the same rows without a score fall back to the old sum)
        let old = |r: &Value| { let mut r = r.clone(); r.as_object_mut().unwrap().remove("score"); r };
        assert_eq!(rows.iter().map(old).max_by(|a, b| if better(progress(a), progress(b)) { std::cmp::Ordering::Greater } else { std::cmp::Ordering::Less }).unwrap()["planLead"], "Solver's own leads");
    }

    /// No clock: round k does ROUND_TRIES << (k-1) tries; a round that gains 5% or more keeps the lead going, a round
    /// under 5% stalls it, however long the PC took.
    #[test]
    fn a_flat_round_stalls_a_lead() {
        let goal = r#"{"skill":"Poisonous Concoction","assume":{"playMode":"mapping"},"targets":[{"name":"DPS","value":1000000000}]}"#;
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut d = Driver::new(String::new(), serde_json::from_str(goal).unwrap(), Options::default(), shared, Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(Vec::new()))).unwrap();
        let mut tries = Vec::new();
        // (DPS per round: +50%, +9%, +2%; an hour per round: the clock does not count)
        let mut fake = |_d: &mut Driver, _i: usize, ms: u64, ev: Option<u64>, round: u32| {
            tries.push((ev, ms >= 1000 * ev.unwrap_or(0)));
            let v = [100.0, 150.0, 163.5, 166.8][round as usize - 1];
            Some((json!({ "evaluations": ev, "elapsedMs": 3_600_000, "results": [{ "limitsMet": true, "score": f64::ln(v), "targets": [{ "name": "DPS", "value": v, "target": 1e9, "met": false }] }] }), vec![Arc::new(format!("x{v}"))]))
        };
        assert_eq!(d.run(&mut fake), "stalled");
        assert_eq!(tries, vec![(Some(37_500), true), (Some(75_000), true), (Some(150_000), true), (Some(300_000), true)]);
        assert_eq!((d.leads[0].status, d.leads[0].rounds), (Status::Stalled, 4), "+9% keeps going, +2% stalls");
    }

    /// Lead A stalls while the others run and is published in `stalls`; a lead sent into the running solve is picked
    /// up and runs, A's best stays in the results, and once every lead has stalled the run waits (`idle`) until Stop.
    #[test]
    fn add_lead_to_running_solve() {
        let goal = r#"{"skill":"Poisonous Concoction","assume":{"playMode":"mapping"},"targets":[{"name":"DPS","value":1000000000}],"plan":{"leads":[{"name":"A","ascendancy":"Assassin"}]}}"#;
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let (cancel, inbox) = (Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(Vec::new())));
        let (sh, ca, ib) = (shared.clone(), cancel.clone(), inbox.clone());
        let t = std::thread::spawn(move || {
            let mut d = Driver::new(String::new(), serde_json::from_str(goal).unwrap(), Options::default(), sh, ca, ib.clone()).unwrap();
            let mut sent = false;
            // (each fake round: the lead's base value plus 1% per round: a plateau)
            let mut fake = |d: &mut Driver, i: usize, _ms: u64, _ev: Option<u64>, round: u32| {
                if d.leads[0].status == Status::Stalled && !sent {
                    sent = true;
                    ib.lock().unwrap().push(json!({ "name": "C", "ascendancy": "Pathfinder", "replaces": "A" }));
                }
                let base = match d.leads[i].name.as_str() { "A" => 100.0, "C" => 300.0, _ => 50.0 };
                let v = base * (1.0 + 0.01 * (round - 1) as f64);
                Some((json!({ "evaluations": 10, "elapsedMs": 120_000, "results": [{ "limitsMet": true, "targets": [{ "name": "DPS", "value": v, "target": 1e9, "met": false }] }] }), vec![Arc::new(format!("{}-{v}", d.leads[i].name))]))
            };
            let reason = d.run(&mut fake);
            (reason, d.leads.iter().map(|l| (l.name.clone(), l.status, l.rounds)).collect::<Vec<_>>())
        });
        let deadline = Instant::now() + std::time::Duration::from_secs(20);
        let snap = loop {
            let s = shared.0.lock().unwrap().snapshot.clone();
            if s["idle"] == true {
                break s;
            }
            assert!(Instant::now() < deadline, "never went idle: {s}");
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        cancel.store(true, Ordering::Relaxed);
        let (reason, leads) = t.join().unwrap();
        assert_eq!(reason, "stopped");
        assert_eq!(leads.iter().map(|l| (l.0.as_str(), l.1, l.2)).collect::<Vec<_>>(), vec![("A", Status::Stalled, 2), ("Solver's own leads", Status::Stalled, 2), ("C", Status::Stalled, 2)]);
        let rs = snap["results"].as_array().unwrap();
        assert_eq!(rs[0]["planLead"], "C", "{snap}");
        assert!(rs.iter().any(|r| r["planLead"] == "A" && r["targets"][0]["value"].as_f64() > Some(100.5)), "A's best kept: {snap}");
        let stalls = snap["stalls"].as_array().unwrap();
        assert_eq!(stalls.len(), 3, "{snap}");
        assert_eq!(stalls[0]["name"], "A");
        assert_eq!(stalls[0]["values"][0]["need"], 1e9);
        assert_eq!(snap["plan"]["leads"][2]["replaces"], "A");
    }

    /// A record's id is its xml hash and fetches the same build after the list is re-sorted by a better result.
    #[test]
    fn record_fetched_by_id_survives_a_resort() {
        let goal = r#"{"skill":"Poisonous Concoction","assume":{"playMode":"mapping"},"plan":{"leads":[{"name":"A"}]}}"#;
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut d = Driver::new(String::new(), serde_json::from_str(goal).unwrap(), Options::default(), shared.clone(), Arc::new(AtomicBool::new(false)), Arc::new(Mutex::new(Vec::new()))).unwrap();
        let rec = |xml: &str, score: f64| (json!({ "id": xml_hash(xml), "xmlHash": xml_hash(xml), "limitsMet": true, "score": score, "targets": [{ "name": "DPS", "value": score }] }), Arc::new(xml.to_string()));
        d.leads[0].kept = vec![rec("<first/>", 10.0)];
        d.publish(None, None);
        let first = shared.0.lock().unwrap().snapshot["results"][0]["id"].as_str().unwrap().to_string();
        d.leads[0].kept.push(rec("<better/>", 11.0));
        d.publish(None, None);
        let g = shared.0.lock().unwrap();
        assert_eq!(g.snapshot["results"][1]["id"], first.as_str(), "re-sorted to second place");
        assert_eq!(xml_hash(g.by_id.get(&first).unwrap()), first);
        assert_eq!(g.by_id.len(), 2);
    }
}
