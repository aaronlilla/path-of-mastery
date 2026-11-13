//! The completion beam and `pom-cli finish`.
//!
//! At finalization, inside the reserve, a bounded beam searches repair bundles on scratch copies of a final. Each
//! operator changes one thing: a gear line, the level of the utility gems that set an attribute requirement, attribute
//! nodes, a utility skill or a flask. Every child is a whole engine evaluation. Nodes rank by hard checklist failures,
//! then the limits' shortfall, then the score, so a bundle may lose a little on the way (a utility gem a few levels
//! down) before the step that pays for it (the attribute line the lower requirement frees). The final changes only for
//! a bundle that removes a hard failure, or keeps them and the shortfall and scores at least as well, less a hair when
//! it wastes less. Player locks hold: locked slots and required gems are never changed.
//!
//! Attributes are a constraint inside the search, not a prune after it: an unmet requirement is a hard failure, and
//! the cheapest source comes first because each source is a child ranked by what it costs (a lower utility gem level,
//! then a gear line, then a node: solver_basics.rs `attr_prune` and the limit repair). Every rule reads game data (gem
//! attribute multipliers, modifier families, resist and attribute amounts), never names.

use super::items::craft::{catalyst_of, line_flags, resist_amounts, resist_surplus, resist_surplus_line};
use super::items::{addable, craft_piece, Design, Fam, Piece, SlotKind};
use super::*;

/// Beam nodes kept per depth: the best overall, then the best child of each operator not yet in.
const WIDTH: usize = 4;
const DEPTH: usize = 3;
/// Score a bundle may give up for less waste (the attribute prune's hair, solver_basics.rs `PRUNE_COST`).
const TOL: f64 = 5e-4;
/// Levels the utility gems are tried at, highest first.
const LEVELS: [u32; 9] = [19, 17, 15, 13, 11, 9, 7, 4, 1];
/// Score a curse's delivery may cost: the 15% trade-off cap (solver_plan.rs `TRADE_GIVE`) of the
/// asked figure. The score is a log, so a share `g` of the damage is `-ln(1 - g)`.
fn curse_cost() -> f64 {
    -(1.0 - super::plan::TRADE_GIVE).ln()
}
/// Lines probed once per beam at most.
const MAX_LINES: usize = 320;
/// Engine figures each logged step carries (the ones the scorer reads).
const FIGS: [&str; 15] = ["Life", "EnergyShield", "TotalEHP", "Str", "ReqStr", "Dex", "ReqDex", "Int", "ReqInt", "FireResist", "ColdResist", "LightningResist", "ChaosResist", "FrenzyCharges", "Speed"];
const ATTRS: [&str; 3] = ["Str", "Dex", "Int"];
const OPS: [&str; 8] = ["gear line", "gem level", "attribute nodes", "utility", "keystone", "sustain", "curse delivery", "dead support"];
/// Upstream's over-cap resist figures (read with flasks off when flasks count, like the resist floors).
/// Stat-id parts of a support that makes frenzy charges (a bare "frenzy_charge" also matches what only scales with them).
const FRENZY_GEN: [&str; 2] = ["add_frenzy_charge", "gain_frenzy_charge"];
/// How far the package fallback's regrowth reaches for a notable (`grow` otherwise stops at six).
const FALLBACK_REACH: usize = 12;
/// What a passive point must add to the score to stay in a new package (solver_basics.rs `PRUNE_COST`).
const DEAD_POINT: f64 = 5e-4;
pub(super) const OVERCAP: [&str; 4] = ["FireResistOverCap", "ColdResistOverCap", "LightningResistOverCap", "ChaosResistOverCap"];

#[derive(Clone)]
struct Node {
    st: State,
    hard: Vec<String>,
    waste: usize,
    log: Vec<Value>,
    /// The state after each step of `log` (its changes are read from them once the beam is done).
    trail: Vec<State>,
    /// A curse's delivery is in this node's steps (it may only win within `curse_cost`).
    curse: bool,
    /// It loses past the trade-off cap against the beam's root on a side the ask does not name.
    over: bool,
}

/// Beam order: fewer hard failures, less shortfall, higher score.
fn order(a: &Node, b: &Node) -> std::cmp::Ordering {
    a.hard.len().cmp(&b.hard.len()).then(a.st.viol.total_cmp(&b.st.viol)).then(a.over.cmp(&b.over)).then(b.st.score.total_cmp(&a.st.score))
}

/// Whether `a` replaces the incumbent `b`.
fn better(a: &Node, b: &Node) -> bool {
    if a.hard.len() != b.hard.len() {
        return a.hard.len() < b.hard.len();
    }
    if (a.st.viol - b.st.viol).abs() > EPS {
        return a.st.viol < b.st.viol;
    }
    // (the same repair at less cost to what the ask does not name wins: a fix within the trade-off cap first)
    if a.over != b.over {
        return !a.over;
    }
    if (a.st.score - b.st.score).abs() > TOL {
        return a.st.score > b.st.score;
    }
    a.waste < b.waste || (a.waste == b.waste && a.st.score > b.st.score + EPS)
}

/// `group` (one socket group's text) with gem `id` at `level`.
pub(super) fn set_gem_level(group: &str, id: &str, level: u32) -> String {
    let key = format!("gemId=\"{id}\"");
    let Some(at) = group.find(&key) else { return group.to_string() };
    let start = group[..at].rfind("<Gem ").unwrap_or(at);
    let end = at + group[at..].find('>').unwrap_or(0);
    let tag = &group[start..end];
    let tag = match tag.find(" level=\"") {
        Some(i) => {
            let j = tag[i + 8..].find('"').map_or(tag.len(), |j| i + 8 + j + 1);
            format!("{} level=\"{level}\"{}", &tag[..i], &tag[j..])
        }
        None => format!("{tag} level=\"{level}\""),
    };
    format!("{}{tag}{}", &group[..start], &group[end..])
}

/// What changed between two build texts, as a player reads it: a link out or in (gems with levels), a passive or a
/// mastery effect out or in, a gear line out or in per slot (or the item itself), a config input. The record's steps
/// carry these, so every difference between the build given and the build written is named by a logged step.
pub(super) fn xml_diff(a: &str, b: &str) -> Vec<String> {
    use std::collections::BTreeSet;
    let read = |x: &str| -> BTreeSet<String> {
        let mut out = BTreeSet::new();
        let Ok(doc) = roxmltree::Document::parse(x) else { return out };
        let tree = crate::cached_tree(&tag_attr(x, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())).ok();
        let name = |id: i64| tree.and_then(|t| t.nodes.get(&id)).and_then(|n| n.get("name")).and_then(|v| v.as_str()).map_or_else(|| format!("node {id}"), String::from);
        if let Some(spec) = doc.descendants().find(|n| n.has_tag_name("Spec")) {
            for id in spec.attribute("nodes").unwrap_or("").split(',').filter_map(|v| v.trim().parse::<i64>().ok()) {
                out.insert(format!("passive {}", name(id)));
            }
            for m in spec.attribute("masteryEffects").unwrap_or("").split("},") {
                let v: Vec<i64> = m.trim_matches(|c| c == '{' || c == '}').split(',').filter_map(|v| v.trim().parse().ok()).collect();
                if let [n, e] = v[..] {
                    out.insert(format!("mastery {} effect {}", name(n), mastery_text(tree, n, e)));
                }
            }
        }
        if let Some(skills) = crate::edit::elements(doc.root_element(), "Skills").next() {
            for g in crate::edit::active_socket_groups(skills) {
                if g.attribute("enabled") == Some("false") {
                    continue;
                }
                let gems: Vec<String> = g.children().filter(|n| n.has_tag_name("Gem") && n.attribute("enabled") != Some("false")).map(|n| format!("{} {}", n.attribute("nameSpec").unwrap_or("?"), n.attribute("level").unwrap_or(""))).collect();
                if !gems.is_empty() {
                    out.insert(format!("link {}", gems.join(", ")));
                }
            }
        }
        let items: HashMap<&str, &str> = doc.descendants().filter(|n| n.has_tag_name("Item")).filter_map(|n| Some((n.attribute("id")?, n.text().unwrap_or("")))).collect();
        if let Some(set) = doc.descendants().find(|n| n.has_tag_name("ItemSet")) {
            for sl in set.children().filter(|n| n.has_tag_name("Slot")) {
                let (Some(slot), Some(text)) = (sl.attribute("name"), sl.attribute("itemId").and_then(|i| items.get(i))) else { continue };
                let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("Unique ID:") && !l.starts_with("Item Level:") && !l.starts_with("LevelReq:")).collect();
                out.insert(format!("{slot}: {}", lines.get(1).copied().unwrap_or("item")));
                for l in lines.iter().skip(2) {
                    out.insert(format!("{slot} line {l}"));
                }
                if sl.attribute("active") == Some("false") {
                    out.insert(format!("{slot} off"));
                }
            }
        }
        for i in doc.descendants().filter(|n| n.has_tag_name("Input")) {
            let v = i.attribute("number").or(i.attribute("boolean")).or(i.attribute("string")).unwrap_or("");
            out.insert(format!("config {}={v}", i.attribute("name").unwrap_or("?")));
        }
        out
    };
    let (x, y) = (read(a), read(b));
    let mut out: Vec<String> = x.difference(&y).map(|d| format!("{d} out")).collect();
    out.extend(y.difference(&x).map(|d| format!("{d} in")));
    out
}

/// A mastery effect's text from the tree data (its stat lines), or its id.
fn mastery_text(tree: Option<&pom_passives::treedata::TreeData>, node: i64, effect: i64) -> String {
    let Some((t, n)) = tree.and_then(|t| Some((t, t.nodes.get(&node)?))) else { return effect.to_string() };
    n.get("masteryEffects").map(|v| t.deref(v)).and_then(|v| v.as_array()).into_iter().flatten().map(|x| t.deref(x)).find(|x| x.get("effect").and_then(|v| v.as_i64()) == Some(effect)).and_then(|x| x.get("stats")).map(|v| pom_passives::treedata::str_list(t.deref(v)).join(" / ")).unwrap_or_else(|| effect.to_string())
}

/// The result's assumption lines for final `k`'s record: each kept repair with its engine figures, then what is left.
pub(super) fn record_lines(k: usize, rec: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for s in rec["kept"].as_array().into_iter().flatten() {
        let (b, a) = (&s["before"], &s["after"]);
        let mut names: Vec<String> = rec["targets"].as_array().into_iter().flatten().filter_map(|t| t.as_str().map(String::from)).collect();
        names.extend(["TotalEHP", "Life"].map(String::from));
        let mut figs: Vec<String> = names.iter().filter_map(|n| Some(format!("{n} {} -> {}", short_num(b[n].as_f64()?), short_num(a[n].as_f64()?)))).collect();
        figs.push(format!("score {:.4} -> {:.4}", b["score"].as_f64().unwrap_or(0.0), a["score"].as_f64().unwrap_or(0.0)));
        out.push(format!("Repair (final {k}): {} [{}]", s["what"].as_str().unwrap_or(""), figs.join(", ")));
    }
    let fb = &rec["fallback"];
    if let Some(skipped) = fb["skipped"].as_str() {
        out.push(format!("Package fallback (final {k}) not run, {skipped}: {}", fb["why"].as_array().into_iter().flatten().filter_map(|w| w.as_str()).collect::<Vec<_>>().join("; ")));
    }
    for t in fb["tried"].as_array().into_iter().flatten() {
        out.push(format!("Package fallback (final {k}) tried {}: {} failures left, score {:.4}", t["package"].as_str().unwrap_or(""), t["failures"].as_array().map_or(0, |a| a.len()), t["after"]["score"].as_f64().unwrap_or(0.0)));
    }
    for u in rec["unresolved"].as_array().into_iter().flatten() {
        out.push(format!("Unresolved (final {k}): {}", u.as_str().unwrap_or("")));
    }
    out
}

/// `pom-cli finish`: the finishing passes alone (the completion beam among them) on a frozen build. Returns the build
/// as the solver renders it today, the finished build, and the beam's record with the engine figures.
pub fn finish(xml: String, goal_json: &str, options_json: &str) -> Result<(String, String, Value), String> {
    let goal: Goal = serde_json::from_str(goal_json).map_err(|e| format!("goal json: {e}"))?;
    if goal.assume.play_mode.is_none() {
        return Err(mode::NEED_MODE.into());
    }
    let opts: Options = if options_json.trim().is_empty() { Options::default() } else { serde_json::from_str(options_json).map_err(|e| format!("options json: {e}"))? };
    clear::load_text_rules();
    pom_engine::modparser::text_rules::set_active(true);
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(xml.clone(), goal, opts, shared, Arc::new(AtomicBool::new(false)))?;
    let mut st = s.frozen_state(&xml)?;
    s.finalizing.set(true);
    let before = s.render(&st)?;
    let mut rec = s.finishing(&mut st)?;
    // (after the limit repair too: the build as it is written)
    rec["surplusLines"] = json!(s.surplus_lines(&st).into_iter().filter_map(|(i, m)| Some(format!("{}: {}", s.slots[i].name, st.gear.pieces[i].as_ref()?.base()?.fams[m].lines.join(" / ")))).collect::<Vec<_>>());
    rec["kept_items"] = json!(s.assumptions.iter().filter(|a| a.starts_with("Kept as the player's")).collect::<Vec<_>>());
    let after = match s.archive_add_written(&st)? {
        Some(w) => {
            let step = s.written_step(&st, &w)?;
            rec["after"] = step["after"].clone();
            let mut kept = rec["kept"].as_array().cloned().unwrap_or_default();
            kept.push(step);
            rec["kept"] = Value::Array(kept);
            w.0.to_string()
        }
        None => s.render(&st)?,
    };
    Ok((before, after, rec))
}

impl Solver {
    /// The finishing passes every final gets (the end of `run`, and `pom-cli finish`): the completion beam among them.
    pub(super) fn finishing(&mut self, f: &mut State) -> Result<Value, String> {
        // (a package whose passives scale a damage the skill does not deal is dead before any repair: no local operator
        // gives them back, so the new package gets the repairs and the dead one only when it loses)
        let dead = !self.off_actor_nodes(f).is_empty();
        let given = f.clone();
        let mut rec = if dead { Value::Null } else { self.finish_package(f)? };
        self.package_fallback(f, &mut rec, &given)?;
        self.sustain_report(f, &mut rec)?;
        // (the whole finish against the build given: a loss past the cap on what the ask does not name is unresolved,
        // with the hard failures it bought)
        if let Some(l) = self.cap_loss(&given.vals, &f.vals) {
            let now = self.hard_unmet(f);
            let fixed: Vec<String> = self.hard_unmet(&given).into_iter().filter(|h| !now.contains(h)).collect();
            let line = format!("The finish costs {l} for what the ask does not name, past the 15% trade-off cap{}", if fixed.is_empty() { String::new() } else { format!(", to fix: {}", fixed.join(", ")) });
            let mut u: Vec<Value> = rec["unresolved"].as_array().cloned().unwrap_or_default();
            u.push(Value::from(line));
            rec["unresolved"] = Value::Array(u);
        }
        Ok(rec)
    }

    /// The local repairs on one package: the finishing passes, the completion beam twice (repairs, then curse
    /// delivery), the limit repair.
    fn finish_package(&mut self, f: &mut State) -> Result<Value, String> {
        let before = self.figs(f);
        // (every pass is a logged step: what it changed, read from the texts, with the engine figures)
        let mut kept = Vec::new();
        self.logged_pass(f, &mut kept, "downside", |s, f| s.downside_pass(f))?;
        self.logged_pass(f, &mut kept, "keystone", |s, f| s.keystone_review(f).map(|_| ()))?;
        self.logged_pass(f, &mut kept, "dead modifier", |s, f| s.dead_mod_pass(f).map(|_| ()))?;
        self.logged_pass(f, &mut kept, "attribute nodes", |s, f| s.attr_prune(f).map(|_| ()))?;
        self.logged_pass(f, &mut kept, "dead aura", |s, f| s.dead_aura_pass(f).map(|_| ()))?;
        self.logged_pass(f, &mut kept, "support swap", |s, f| s.final_support_swap(f).map(|_| ()))?;
        // (the repairs first; the curse delivery on the repaired build, which the beam then repairs again)
        let first = self.completion_beam(f, false)?;
        let mut rec = self.completion_beam(f, true)?;
        kept.extend(first["kept"].as_array().cloned().unwrap_or_default());
        kept.extend(rec["kept"].as_array().cloned().unwrap_or_default());
        rec["tried"] = json!(first["tried"].as_u64().unwrap_or(0) + rec["tried"].as_u64().unwrap_or(0));
        rec["tries"] = json!(first["tries"].as_u64().unwrap_or(0) + rec["tries"].as_u64().unwrap_or(0));
        self.logged_pass(f, &mut kept, "finish checks", |s, f| s.finish_checks(f))?;
        self.logged_pass(f, &mut kept, "limit repair", |s, f| s.repair_limits_with(f, &[10.0, 100.0], true))?;
        rec["kept"] = Value::Array(kept);
        rec["before"] = before;
        rec["after"] = self.figs(f);
        Ok(rec)
    }

    /// Passives and mastery effects with a line the engine reads only in part whose dropped half is a cost
    /// (solver.rs `unpriced_downside`: the Chaos Mastery's life and shield loss per Chaos skill use) go: a mastery takes
    /// the best other effect it offers, or goes with the points spent again, whichever scores better; a passive goes
    /// with what only it holds up and the points are spent again. Done even when the score drops: the score never saw
    /// the cost.
    pub(super) fn downside_pass(&mut self, f: &mut State) -> Result<(), String> {
        let bad = self.downside(f.class);
        let used: HashSet<i64> = f.masteries.iter().filter(|(n, _)| f.nodes.contains(n)).map(|(_, e)| *e).collect();
        let hit: Vec<(i64, i64)> = f.masteries.iter().copied().filter(|(n, e)| f.nodes.contains(n) && bad.1.contains(e)).collect();
        for (n, _) in hit {
            let others: Vec<i64> = self.ctx[f.class].paths.nodes.get(&n).map_or(Vec::new(), |x| x.mastery_effects.iter().copied().filter(|e| !used.contains(e) && !bad.1.contains(e)).collect());
            let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = others.iter().map(|&e| (f.nodes.clone(), Some((n, e)))).collect();
            let r = self.eval_nodes(f, &cands);
            let swap = others.iter().zip(&r).filter_map(|(&e, v)| v.as_ref().map(|v| (e, v.0, v.1))).min_by(|a, b| a.2.total_cmp(&b.2).then(b.1.total_cmp(&a.1)));
            let mut t = match self.removal_groups(f, false, 12).into_iter().filter(|g| g.contains(&n)).min_by_key(|g| g.len()) {
                Some(g) => {
                    let mut t = Self::without(f, &g);
                    self.rebase(&mut t)?;
                    self.grow(&mut t, false)?;
                    Some(t)
                }
                None => None,
            };
            let mut s = f.clone();
            match swap {
                Some((e, _, _)) => {
                    s.masteries.retain(|(x, _)| *x != n);
                    s.masteries.push((n, e));
                    self.rebase(&mut s)?;
                }
                None => s = t.take().unwrap_or(s),
            }
            if let Some(t) = t.filter(|t| !t.vals.is_empty() && (t.viol, -t.score) < (s.viol, -s.score)) {
                s = t;
            }
            *f = s;
        }
        let nodes: Vec<i64> = f.nodes.iter().copied().filter(|n| bad.0.contains(n)).collect();
        for n in nodes {
            let Some(g) = self.removal_groups(f, false, 40).into_iter().filter(|g| g.contains(&n)).min_by_key(|g| g.len()) else { continue };
            let mut t = Self::without(f, &g);
            self.rebase(&mut t)?;
            self.grow(&mut t, false)?;
            *f = t;
        }
        Ok(())
    }

    /// What the local repairs left that only a new package fixes: the hard failures (a curse by hand aside: its cost
    /// is reported), and the passives a minion skill's build spends on the player's own damage.
    fn package_failures(&self, st: &State) -> Vec<String> {
        let mut out: Vec<String> = self.hard_unmet(st).into_iter().filter(|h| !h.contains("is cast by hand")).collect();
        let off = self.off_actor_nodes(st);
        if !off.is_empty() {
            out.push(format!("{} passive points scale only the player's damage; the damage is the minions': {}", off.len(), off.iter().map(|&n| self.node_info(n).0.clone()).collect::<Vec<_>>().join(", ")));
        }
        out
    }

    /// Allocated passives that change the player's own damage and no scored figure, when the main skill's damage is its
    /// minions' (solver_sens.rs `minion_actor`). Each node is given back alone and the engine reads both figures.
    pub(super) fn off_actor_nodes(&self, st: &State) -> Vec<i64> {
        if !sens::minion_actor(self.main_gem) {
            return Vec::new();
        }
        let Some(pi) = self.scorer.names.iter().position(|n| n == "CombinedDPS") else { return Vec::new() };
        let c = &self.ctx[st.class];
        // (an attribute passive past the requirement is the attribute operator's, counted as attribute nodes)
        let ids: Vec<i64> = st.nodes.iter().copied().filter(|&n| (c.is_main(n) || c.is_asc(n)) && self.attr_node(n).is_none()).collect();
        // (the build itself first, read the same way)
        let mut cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = vec![(st.nodes.clone(), None)];
        cands.extend(ids.iter().map(|&x| (st.nodes.iter().copied().filter(|&n| n != x).collect(), None)));
        let r = self.eval_nodes(st, &cands);
        let Some((s0, v0, own)) = r[0].as_ref().and_then(|(s, v, vals)| Some((*s, *v, vals.get(pi).copied().flatten()?))) else { return Vec::new() };
        ids.into_iter().zip(&r[1..]).filter_map(|(x, v)| {
            let (s, viol, vals) = v.as_ref()?;
            let p = vals.get(pi).copied().flatten()?;
            (*s >= s0 - EPS && *viol <= v0 + EPS && p < own * 0.999).then_some(x)
        }).collect()
    }

    /// Package fallback: when the local repairs leave a hard failure, the damage, defence and
    /// sustain package is made again instead of polishing the dead one, and each new package gets the same repairs:
    /// - the final's own lead remade: the off-actor passives given back (and kept out), the tree grown again, the
    ///   supports and the gear chosen again;
    /// - the next best leads the solve realized (none for a frozen build).
    /// The best package by failures left, then shortfall, then score, replaces the final.
    /// `rec` is Null when `f` has not had its local repairs yet (a dead package): it gets them only if no new package wins.
    /// `given` is the final as it came to the finishing passes: a new package's step reads its changes from it, so the
    /// record never names a repair of the package it replaced.
    fn package_fallback(&mut self, f: &mut State, rec: &mut Value, given: &State) -> Result<(), String> {
        let why = self.package_failures(f);
        if why.is_empty() || self.stop() {
            if rec.is_null() {
                *rec = self.finish_package(f)?;
            }
            // (the budget ran out first: the record says the fallback did not run, and why it would have)
            if !why.is_empty() {
                rec["fallback"] = json!({ "why": why, "tried": [], "kept": Value::Null, "skipped": "out of time" });
            }
            return Ok(());
        }
        let layer = std::mem::replace(&mut self.layer, "finishing: package fallback".into());
        let e0 = self.evals.load(Ordering::Relaxed);
        let rank = |fails: usize, s: &State| (fails, s.viol, -s.score);
        let mut best: (usize, f64, f64) = rank(why.len(), f);
        let mut tried = Vec::new();
        let mut won: Option<(State, Value, String)> = None;
        // 1. the own lead, remade (inside its share below); 2. the next best leads the solve realized
        let off = self.off_actor_nodes(f);
        let banned0 = self.banned.borrow().clone();
        let avoid0 = self.avoid.borrow().clone();
        self.banned.borrow_mut().extend(off.iter().copied());
        self.avoid.borrow_mut().extend(off.iter().copied());
        let mut cands: Vec<(String, State)> = vec![("own lead remade".into(), f.clone())];
        let mut others: Vec<(f64, String, State)> = self.book.leads.iter().filter(|l| Some(l.id) != f.lead && l.status != leads::Status::Dropped).filter_map(|l| Some((l.best, l.label.clone(), l.st.clone()?))).collect();
        others.sort_by(|a, b| b.0.total_cmp(&a.0));
        cands.extend(others.into_iter().take(2).map(|(_, label, s)| (format!("lead {label}"), s)));
        let n = cands.len();
        for (k, (label, mut s)) in cands.into_iter().enumerate() {
            if self.stop() {
                break;
            }
            // (the own lead, remade from its tree up, gets half of what is left; the next leads share the rest, so they
            // are tried too)
            let left = self.budget_ms.saturating_sub(self.spent());
            let e1 = self.evals.load(Ordering::Relaxed);
            self.phase_end.set(self.spent() + if k == 0 && n > 1 { left / 2 } else { left / (n - k) as u64 });
            let r = (|| -> Result<Value, String> {
                if k == 0 {
                    self.give_back_off_actor(&mut s, &off)?;
                    self.gem_layer(&mut s, true)?;
                    self.items_layer(&mut s, false)?;
                }
                let remade = json!(xml_diff(&self.render(given)?, &self.render(&s)?));
                let mut r = self.finish_package(&mut s)?;
                r["remade"] = remade;
                if let Some(step) = self.far_regrow(&mut s)? {
                    let mut kept = r["kept"].as_array().cloned().unwrap_or_default();
                    kept.push(step);
                    r["kept"] = Value::Array(kept);
                }
                Ok(r)
            })();
            self.phase_end.set(u64::MAX);
            let r = r?;
            if s.vals.is_empty() {
                continue;
            }
            let left = self.package_failures(&s);
            let k = rank(left.len(), &s);
            tried.push(json!({ "package": label, "failures": left, "after": self.figs(&s), "tries": self.evals.load(Ordering::Relaxed) - e1 }));
            if k < best {
                best = k;
                won = Some((s, r, label));
            }
        }
        let kept = won.as_ref().map(|w| w.2.clone());
        match won {
            Some((s, r, label)) => {
                let what = self.describe_package(given, &s);
                let before = self.figs(given);
                *f = s;
                let mut kept_log = r["kept"].as_array().cloned().unwrap_or_default();
                kept_log.insert(0, json!({ "op": "package fallback", "what": format!("{label}: {what}"), "before": before, "after": r["before"].clone(), "changes": r["remade"].clone() }));
                let fallback = json!({ "why": why, "tried": tried, "kept": kept, "tries": self.evals.load(Ordering::Relaxed) - e0 });
                let after = self.figs(f);
                *rec = r;
                rec["kept"] = Value::Array(kept_log);
                rec["before"] = rec["kept"][0]["before"].clone();
                rec["after"] = after;
                rec["fallback"] = fallback;
            }
            None => {
                *self.banned.borrow_mut() = banned0;
                *self.avoid.borrow_mut() = avoid0;
                if rec.is_null() {
                    *rec = self.finish_package(f)?;
                }
                rec["fallback"] = json!({ "why": why, "tried": tried, "kept": Value::Null, "tries": self.evals.load(Ordering::Relaxed) - e0 });
            }
        }
        let left = self.package_failures(f);
        if !left.is_empty() {
            let mut u: Vec<Value> = rec["unresolved"].as_array().cloned().unwrap_or_default();
            for l in left {
                if !u.iter().any(|x| *x == l) {
                    u.push(Value::from(l));
                }
            }
            rec["unresolved"] = Value::Array(u);
        }
        self.layer = layer;
        Ok(())
    }

    /// The off-actor passives `off` (banned by the caller) given back and their points spent again: every removable
    /// group that holds one and costs nothing scored goes first, round after round, and the tree grows again around
    /// them (`bfs_avoiding`); a passive that still holds up others is then routed around, kept when the build scores
    /// at least as well.
    /// The regrowth looks for notables up to `FALLBACK_REACH` away: the points freed are many, and within the usual six
    /// the off-actor build has nothing left that pays (SRS replay: flask passives at under a tenth of what
    /// the minion notables eight to eleven away pay per point).
    fn give_back_off_actor(&mut self, s: &mut State, off: &[i64]) -> Result<(), String> {
        for asc in [false, true] {
            loop {
                let groups: Vec<Vec<i64>> = self.removal_groups(s, asc, 12).into_iter().filter(|g| g.iter().any(|n| off.contains(n))).collect();
                if groups.is_empty() || self.stop() {
                    break;
                }
                let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(s, g).nodes, None)).collect();
                let r = self.eval_nodes(s, &cands);
                let free: Vec<i64> = groups.iter().zip(&r).filter(|(_, v)| v.as_ref().is_some_and(|(sc, viol, _)| *sc >= s.score - EPS && *viol <= s.viol + EPS)).flat_map(|(g, _)| g.iter().copied()).collect();
                if free.is_empty() {
                    break;
                }
                *s = Self::without(s, &free);
                self.rebase(s)?;
            }
            let saved = self.notable_reach.replace(FALLBACK_REACH);
            let r = self.grow(s, asc).and_then(|_| self.refine_tree(s, asc));
            self.notable_reach.set(saved);
            r?;
        }
        // (what is left holds up passives the build uses: each goes with what it holds, and the tree grows back around it)
        for x in off.iter().copied().filter(|x| s.nodes.contains(x)).collect::<Vec<_>>() {
            let asc = self.ctx[s.class].is_asc(x);
            let Some(g) = self.removal_groups(s, asc, 40).into_iter().filter(|g| g.contains(&x)).min_by_key(|g| g.len()) else { continue };
            if self.stop() {
                break;
            }
            let mut t = Self::without(s, &g);
            self.rebase(&mut t)?;
            let saved = self.notable_reach.replace(FALLBACK_REACH);
            let r = self.grow(&mut t, asc);
            self.notable_reach.set(saved);
            r?;
            if t.score >= s.score - TOL && t.viol <= s.viol + EPS {
                *s = t;
            }
        }
        Ok(())
    }

    /// Passive groups of a new package that pay under `DEAD_POINT` a point (an attribute passive aside: the attribute
    /// operator's) go back together, and the points grow again up to `FALLBACK_REACH` away; kept when the build scores
    /// at least as well. The step with its engine figures, or None.
    fn far_regrow(&mut self, s: &mut State) -> Result<Option<Value>, String> {
        let groups: Vec<Vec<i64>> = self.removal_groups(s, false, 4).into_iter().filter(|g| g.iter().all(|&n| self.attr_node(n).is_none())).collect();
        let r = self.eval_nodes(s, &groups.iter().map(|g| (Self::without(s, g).nodes, None)).collect::<Vec<_>>());
        let mut give: Vec<i64> = Vec::new();
        for (g, v) in groups.iter().zip(&r) {
            let Some((sc, viol, _)) = v else { continue };
            if *viol <= s.viol + EPS && (s.score - sc) / (g.len() as f64) < DEAD_POINT {
                for &n in g {
                    if !give.contains(&n) {
                        give.push(n);
                    }
                }
            }
        }
        if give.is_empty() || self.stop() {
            return Ok(None);
        }
        let mut t = Self::without(s, &give);
        self.rebase(&mut t)?;
        let banned0 = self.banned.borrow().clone();
        self.banned.borrow_mut().extend(give.iter().copied());
        let saved = self.notable_reach.replace(FALLBACK_REACH);
        let r = self.grow(&mut t, false);
        self.notable_reach.set(saved);
        *self.banned.borrow_mut() = banned0;
        r?;
        if t.score < s.score - EPS || t.viol > s.viol + EPS {
            return Ok(None);
        }
        let names = |st: &State, of: &State| st.nodes.iter().filter(|n| !of.nodes.contains(n)).map(|&n| self.node_info(n).0.clone()).collect::<Vec<_>>().join(", ");
        let step = json!({ "op": "package fallback", "what": format!("passives that paid under {DEAD_POINT} of the score a point given back ({}), grown again ({})", names(s, &t), names(&t, s)), "before": self.figs(s), "after": self.figs(&t), "changes": xml_diff(&self.render(s)?, &self.render(&t)?) });
        *s = t;
        Ok(Some(step))
    }

    /// What a new package changed, as a player reads it: the main link, the passives in and out, the gear slots.
    fn describe_package(&self, a: &State, b: &State) -> String {
        let names = |s: &State| s.main.iter().map(|g| gem_name(g).to_string()).collect::<Vec<_>>();
        let mut parts = vec![format!("main link {} -> {}", names(a).join(", "), names(b).join(", "))];
        if a.class != b.class {
            parts.push(format!("{} -> {}", self.ctx[a.class].label, self.ctx[b.class].label));
        }
        let out: Vec<String> = a.nodes.iter().filter(|n| !b.nodes.contains(n)).map(|&n| self.node_info(n).0.clone()).collect();
        let inn: Vec<String> = b.nodes.iter().filter(|n| !a.nodes.contains(n)).map(|&n| self.node_info(n).0.clone()).collect();
        parts.push(format!("{} passives out ({}), {} in ({})", out.len(), out.join(", "), inn.len(), inn.join(", ")));
        let slots: Vec<&str> = (0..self.slots.len()).filter(|&i| a.gear.pieces[i].as_ref().map(|p| &p.xml) != b.gear.pieces[i].as_ref().map(|p| &p.xml)).map(|i| self.slots[i].name.as_str()).collect();
        if !slots.is_empty() {
            parts.push(format!("gear remade: {}", slots.join(", ")));
        }
        parts.join("; ")
    }

    /// What the finished build still carries that the operators look at, with the engine's figures: the recovery
    /// under each cost the main skill pays, the share of the use rate it can pay, every flask (its uptime, what removing
    /// it does), the curses (delivered or by hand), the keystones, the supports that do nothing. What is wrong joins
    /// `unresolved`.
    fn sustain_report(&mut self, st: &State, rec: &mut Value) -> Result<(), String> {
        let mut bad: Vec<String> = Vec::new();
        let mut sus = serde_json::Map::new();
        for (r, rec_stats) in [("Mana", &["ManaRegenRecovery", "ManaLeechGainRate"][..]), ("ES", &["EnergyShieldRecharge", "EnergyShieldRegenRecovery", "EnergyShieldLeechGainRate"][..]), ("Life", &["LifeRegenRecovery", "LifeLeechGainRate"][..])] {
            let cost = self.stat(st, &format!("{r}PerSecondCost")).unwrap_or(0.0);
            if cost <= 0.0 {
                continue;
            }
            let recovery: f64 = rec_stats.iter().filter_map(|n| self.stat(st, n)).sum();
            let net = if r == "Life" { self.stat(st, "Solver.LifeRegenNet").map_or(recovery - cost, |n| n + self.stat(st, "LifeLeechGainRate").unwrap_or(0.0) - cost) } else { recovery - cost };
            let margin = self.stat(st, &format!("Solver.SustainMargin{r}")).unwrap_or(0.0);
            if net < margin {
                bad.push(format!("{r} cost {cost:.0}/s is not paid with a margin: net {net:.0}/s, wants {margin:.0}/s for the damage taken; the build is scored at {:.0}% of its use rate", 100.0 * self.sustain_rate(st)));
            }
            sus.insert(r.into(), json!({ "costPerSecond": cost, "recoveryPerSecond": recovery, "net": net, "margin": margin }));
        }
        sus.insert("paidShareOfUseRate".into(), json!(self.sustain_rate(st)));
        rec["sustain"] = Value::Object(sus);
        // Flasks: each slot's uptime in this mode, and what the build loses without it.
        let mut flasks = Vec::new();
        let slots: Vec<usize> = (0..self.slots.len()).filter(|&k| self.slots[k].kind == SlotKind::Flask && st.gear.pieces[k].is_some()).collect();
        let dead = self.dead_flasks(st)?;
        let without = self.flask_removal(st)?;
        for i in slots {
            let label = st.gear.pieces[i].as_ref().map(|p| p.label.split(':').next().unwrap_or("").to_string()).unwrap_or_default();
            flasks.push(json!({ "slot": self.slots[i].name, "flask": label, "does_something": !dead.contains(&i), "certified": !dead.contains(&i) && without.iter().any(|w| w.0 == i), "scoreWithout": without.iter().find(|w| w.0 == i).map(|w| w.1), "scoreWith": st.score }));
        }
        rec["flasks"] = json!(flasks);
        // Curses: delivered by their own link, or pressed by hand.
        rec["curses"] = json!(st.utils.iter().filter(|u| self.gems.iter().any(|g| g.id == util_root(u) && g.kind == Kind::Curse)).map(|u| json!({ "curse": gem_name(util_root(u)), "delivered": u.contains('+') })).collect::<Vec<_>>());
        // Keystones kept: the engine measured each without it (op_keystones), and none scored better.
        rec["keystones"] = json!(self.keystone_nodes(st).into_iter().map(|id| self.node_info(id).0.clone()).collect::<Vec<_>>());
        // Supports that do nothing (what the dead-support operator could not replace with one that pays).
        let dead_sups: Vec<String> = self.dead_supports(st)?.into_iter().map(|(g, _)| gem_name(g).to_string()).collect();
        for g in &dead_sups {
            bad.push(format!("{g} does nothing here: removing it changes no number"));
        }
        rec["deadSupports"] = json!(dead_sups);
        if !bad.is_empty() {
            let mut u: Vec<Value> = rec["unresolved"].as_array().cloned().unwrap_or_default();
            u.extend(bad.into_iter().map(Value::from));
            rec["unresolved"] = Value::Array(u);
        }
        Ok(())
    }

    /// The beam over repair bundles on scratch copies of `st` (kept in `st` when a bundle wins); its record lists the
    /// kept steps with the engine figures before and after each, and what is still unresolved.
    pub(super) fn completion_beam(&mut self, st: &mut State, curses: bool) -> Result<Value, String> {
        let layer = std::mem::replace(&mut self.layer, "finishing: completion beam".into());
        let e0 = self.evals.load(Ordering::Relaxed);
        let root = self.node(st.clone(), Vec::new(), Vec::new());
        let root_score = root.st.score;
        let (root_hard, root_vals) = (root.hard.len(), root.st.vals.clone());
        let probes = self.line_probes(st)?;
        let mut inc = root.clone();
        let mut beam = vec![root];
        let mut seen: HashSet<String> = HashSet::default();
        seen.insert(xml_hash(&st.base));
        let mut tried = 0usize;
        // (the delivery that came nearest, for the report when none wins: fewest failures, then the best score)
        let mut nearest: Option<Node> = None;
        for _ in 0..DEPTH {
            if self.stop() || beam.is_empty() {
                break;
            }
            let mut kids: Vec<(usize, Node)> = Vec::new();
            for n in beam.clone() {
                let ops = [self.op_lines(&n.st, &probes)?, self.op_levels(&n.st)?, self.op_attr_nodes(&n.st)?, self.op_utility(&n.st)?, self.op_keystones(&n.st)?, self.op_sustain(&n.st)?, if curses { self.op_curses(&n.st)? } else { Vec::new() }, self.op_dead_supports(&n.st)?];
                for (k, children) in ops.into_iter().enumerate() {
                    for (s, why) in children {
                        tried += 1;
                        if s.vals.is_empty() || !seen.insert(xml_hash(&s.base)) {
                            continue;
                        }
                        let mut log = n.log.clone();
                        log.push(json!({ "op": OPS[k], "what": format!("{why}{}", self.describe(&n.st, &s)), "before": self.figs(&n.st), "after": self.figs(&s) }));
                        let mut trail = n.trail.clone();
                        trail.push(s.clone());
                        let step_loss = self.cap_loss(&n.st.vals, &s.vals);
                        let mut kid = self.node(s, log, trail);
                        kid.curse = n.curse || k == 6;
                        kid.over = self.cap_loss(&root_vals, &kid.st.vals).is_some();
                        // (a step past the cap says what it costs, and what it fixes for it)
                        if let (Some(l), Some(step)) = (step_loss, kid.log.last_mut()) {
                            let fixed: Vec<&String> = n.hard.iter().filter(|h| !kid.hard.contains(h)).collect();
                            step["what"] = json!(format!("{} ({})", step["what"].as_str().unwrap_or(""), if fixed.is_empty() { format!("costs {l}") } else { format!("fixes {} at {l}", fixed.iter().map(|h| h.as_str()).collect::<Vec<_>>().join(", ")) }));
                        }
                        kids.push((k, kid));
                    }
                }
            }
            kids.sort_by(|a, b| order(&a.1, &b.1));
            for (_, k) in kids.iter().filter(|(_, k)| k.curse) {
                if nearest.as_ref().is_none_or(|n| order(k, n) == std::cmp::Ordering::Less) {
                    nearest = Some(k.clone());
                }
            }
            for (_, k) in &kids {
                // (a repair that removes no hard failure keeps what the ask does not name within the trade-off cap)
                let capped = k.hard.len() >= root_hard && self.cap_loss(&root_vals, &k.st.vals).is_some();
                if better(k, &inc) && !capped && (!k.curse || k.st.score >= root_score - curse_cost()) {
                    inc = k.clone();
                }
            }
            // (intermediate losses stay in the beam: the best of each operator goes on even when it scores less)
            let mut next: Vec<Node> = kids.iter().take(WIDTH / 2).map(|k| k.1.clone()).collect();
            for op in 0..OPS.len() {
                if next.len() >= WIDTH {
                    break;
                }
                if let Some((_, k)) = kids.iter().find(|k| k.0 == op && !next.iter().any(|n| n.st.base == k.1.st.base)) {
                    next.push(k.clone());
                }
            }
            beam = next;
        }
        // A flask that does nothing in this mode (the engine measured each without it: no score, limit or EHP moves) gives
        // its slot to the defence flask that adds the most EHP; no slot is left empty.
        for i in self.dead_flasks(&inc.st)? {
            let Some(s) = self.defence_flask_for(&inc.st, i)? else { continue };
            let label = |st: &State| st.gear.pieces[i].as_ref().map(|p| p.label.split(':').next().unwrap_or("").to_string()).unwrap_or_default();
            inc.log.push(json!({ "op": "utility", "what": format!("{}: {} did nothing in this mode; {} adds EHP. ", self.slots[i].name, label(&inc.st), label(&s)), "before": self.figs(&inc.st), "after": self.figs(&s) }));
            inc.trail.push(s.clone());
            inc.st = s;
        }
        // A support that moves no number gives its socket back (the beam's dead-support children win only where a
        // support that pays takes the socket).
        for _ in 0..inc.st.main.len() {
            let Some((g, s)) = self.dead_supports(&inc.st)?.into_iter().next() else { break };
            inc.log.push(json!({ "op": "dead support", "what": format!("{} does nothing here: removed. ", gem_name(g)), "before": self.figs(&inc.st), "after": self.figs(&s) }));
            inc.trail.push(s.clone());
            inc.st = s;
        }
        let mut prev = self.render(st)?;
        for (step, s) in inc.log.iter_mut().zip(&inc.trail) {
            let x = self.render(s)?;
            step["changes"] = json!(xml_diff(&prev, &x));
            prev = x;
        }
        let mut unresolved = self.unresolved(&inc.st)?;
        // A curse left by hand says what delivering it would cost: the engine's figures for the nearest bundle tried.
        if let Some(n) = nearest.filter(|n| n.st.base != inc.st.base) {
            let share = 100.0 * (1.0 - (n.st.score - root_score).exp());
            let why = format!(" (nearest delivery tried: {}; the damage would be {share:.0}% {}{})", n.log.last().and_then(|l| l["what"].as_str()).unwrap_or("").split(". ").next().unwrap_or(""), if share >= 0.0 { "lower" } else { "higher" }, if n.hard.is_empty() { String::new() } else { format!(", still failing: {}", n.hard.join(", ")) });
            for u in unresolved.iter_mut().filter(|u| u.contains("is cast by hand")) {
                u.push_str(&why);
            }
        }
        let surplus: Vec<String> = self.surplus_lines(&inc.st).into_iter().filter_map(|(i, m)| Some(format!("{}: {}", self.slots[i].name, inc.st.gear.pieces[i].as_ref()?.base()?.fams[m].lines.join(" / ")))).collect();
        let rec = json!({
            "tried": tried,
            "tries": self.evals.load(Ordering::Relaxed) - e0,
            "targets": self.scorer.targets.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
            "before": self.figs(st),
            "after": self.figs(&inc.st),
            "kept": inc.log,
            "surplusLines": surplus,
            "unresolved": unresolved,
            "frenzy": match self.frenzy(&inc.st) {
                None => Value::Null,
                Some(c) if c < 1.0 => json!("unresolved: none kept up"),
                Some(c) => json!(format!("{c:.0} kept up (engine)")),
            },
        });
        if !inc.log.is_empty() {
            // (a keystone the beam gave back stays out of the later passes' growth)
            for id in self.keystone_nodes(st).into_iter().filter(|id| !inc.st.nodes.contains(id)) {
                self.banned.borrow_mut().insert(id);
            }
            *st = inc.st;
        }
        self.layer = layer;
        Ok(rec)
    }

    fn node(&self, st: State, log: Vec<Value>, trail: Vec<State>) -> Node {
        Node { hard: self.hard_unmet(&st), waste: self.waste(&st), st, log, trail, curse: false, over: false }
    }

    fn stat(&self, st: &State, n: &str) -> Option<f64> {
        self.scorer.names.iter().position(|x| x == n).and_then(|i| st.vals.get(i).copied().flatten())
    }

    fn figs(&self, st: &State) -> Value {
        let mut o = self.figs_of(&st.vals, st.score, st.viol);
        o.insert("attributeNodes".into(), json!(self.attr_nodes(st)));
        Value::Object(o)
    }

    /// The figures of one evaluation: score, shortfall, the targets and `FIGS`.
    fn figs_of(&self, vals: &Vals, score: f64, viol: f64) -> serde_json::Map<String, Value> {
        let sc = &self.scorer;
        let mut o = serde_json::Map::new();
        o.insert("score".into(), json!(score));
        o.insert("shortfall".into(), json!(viol));
        for t in &sc.targets {
            o.insert(t.name.clone(), json!(sc.target_value(t, vals)));
        }
        for n in FIGS {
            if let Some(v) = sc.names.iter().position(|x| x == n).and_then(|i| vals.get(i).copied().flatten()) {
                o.insert(n.into(), json!(v));
            }
        }
        o
    }

    /// What `b` loses against `a` past the trade-off cap (15%, solver_plan.rs `TRADE_GIVE`) on a side the ask
    /// does not name: the defence (TotalEHP) when no target is defensive, the damage (CombinedDPS) when none is offensive.
    fn cap_loss(&self, a: &Vals, b: &Vals) -> Option<String> {
        let defensive = |m: &str| matches!(m, "ehp" | "pool" | "life" | "es" | "bossdef") || m.starts_with("maxhit:") || m.starts_with("resist:");
        let ms: Vec<&str> = self.scorer.targets.iter().map(|t| t.metric.trim()).collect();
        let mut guard = Vec::new();
        if !ms.iter().any(|m| defensive(m)) {
            guard.push("TotalEHP");
        }
        if !ms.is_empty() && ms.iter().all(|m| defensive(m)) {
            guard.push("CombinedDPS");
        }
        let get = |v: &Vals, n: &str| self.scorer.names.iter().position(|x| x == n).and_then(|i| v.get(i).copied().flatten());
        guard.into_iter().find_map(|n| {
            let (x, y) = (get(a, n)?, get(b, n)?);
            (x > 0.0 && y < x * (1.0 - super::plan::TRADE_GIVE)).then(|| format!("{n} {} -> {} ({:.0}%)", short_num(x), short_num(y), 100.0 * (y / x - 1.0)))
        })
    }

    /// Runs one finishing pass on `f` and logs what it changed as a step with the engine figures before and after and
    /// the changes read from the two texts. A pass that removes no hard failure and loses past the trade-off cap on a
    /// side the ask does not name is undone, and the step says so.
    fn logged_pass(&mut self, f: &mut State, log: &mut Vec<Value>, op: &str, pass: impl FnOnce(&mut Self, &mut State) -> Result<(), String>) -> Result<(), String> {
        let a = f.clone();
        pass(self, f)?;
        if f.vals.is_empty() {
            *f = a;
            return Ok(());
        }
        let changes = xml_diff(&self.render(&a)?, &self.render(f)?);
        if changes.is_empty() {
            return Ok(());
        }
        let loss = self.cap_loss(&a.vals, &f.vals);
        if let Some(l) = loss.as_ref().filter(|_| self.hard_unmet(f).len() >= self.hard_unmet(&a).len()) {
            log.push(json!({ "op": op, "what": format!("not kept: {} would cost {l} for what the ask does not name", self.describe(&a, f)), "before": self.figs(&a), "after": self.figs(&a), "changes": [] }));
            *f = a;
            return Ok(());
        }
        let what = match loss {
            Some(l) => format!("{} (fixes a hard failure at {l})", self.describe(&a, f)),
            None => self.describe(&a, f),
        };
        log.push(json!({ "op": op, "what": what, "before": self.figs(&a), "after": self.figs(f), "changes": changes }));
        Ok(())
    }

    /// The step that writes the result: what listing it changed (the basics a player fills in, the pantheon, the config
    /// switches the result settles on, the flasks it counts), with the figures of the text as written. Its figures are
    /// the record's "after", so the record is the build that was written.
    pub(super) fn written_step(&self, st: &State, written: &(Arc<String>, Vals, f64, f64)) -> Result<Value, String> {
        let (xml, vals, score, viol) = written;
        let mut after = self.figs_of(vals, *score, *viol);
        let get = |n: &str| self.scorer.names.iter().position(|x| x == n).and_then(|i| vals.get(i).copied().flatten());
        // (the card's number is the sheet's: when the scored figure is not the sheet's Combined DPS, the record says why)
        let mut why = Vec::new();
        if let (Some(sheet), Some(t)) = (get("CombinedDPS"), self.scorer.targets.first()) {
            let v = self.scorer.target_value(t, vals);
            if sheet > 0.0 && (v / sheet - 1.0).abs() > 0.01 {
                why.push(format!("{} {} is scored as the goal reads it (single target without cull, part-time flasks at their uptime, unpaid cost at the paid share); the sheet's Combined DPS is {}", t.name, short_num(v), short_num(sheet)));
            }
            after.insert("sheetCombinedDPS".into(), json!(sheet));
        }
        let changes = xml_diff(&self.render(st)?, xml);
        let what = format!("as listed: {}{}", if changes.is_empty() { "no change".to_string() } else { changes.join("; ") }, if why.is_empty() { String::new() } else { format!(". {}", why.join("; ")) });
        Ok(json!({ "op": "written", "what": what, "before": self.figs(st), "after": Value::Object(after), "changes": changes }))
    }

    fn attr_nodes(&self, st: &State) -> usize {
        st.nodes.iter().filter(|&&n| self.attr_node(n).is_some()).count()
    }

    /// The checklist's hard cells `st` misses, and the hard limits it breaks.
    pub(super) fn hard_unmet(&self, st: &State) -> Vec<String> {
        let names = |g: &[&'static str]| g.iter().map(|g| gem_name(g)).collect::<Vec<_>>();
        let mut out: Vec<String> = self.checks_for(&st.vals, &names(&st.main), &names(&st.utils), &st.base).iter().filter(|c| c["level"] == "hard" && c["status"] == "unmet").filter_map(|c| c["label"].as_str().map(String::from)).collect();
        let d = self.scorer.deficits(&st.vals);
        for (l, d) in self.scorer.limits.iter().zip(&d) {
            if !l.soft && *d > 0.0 && !out.contains(&l.name) {
                out.push(l.name.clone());
            }
        }
        out.extend(self.manual_curses(st).into_iter().map(|u| format!("{} is cast by hand (delivering it costs more than 15% of the damage or does not fit)", gem_name(u))));
        out
    }

    /// The curses the build leaves to be pressed by hand (a hex without the support that casts it by itself, solver.rs
    /// `Kind::Auto`), except the ones the player required.
    fn manual_curses(&self, st: &State) -> Vec<&'static str> {
        st.utils.iter().copied().filter(|u| !self.required.contains(u) && self.gems.iter().any(|g| g.id == *u && g.kind == Kind::Curse)).collect()
    }

    /// Curse delivery: each curse left to the player's hand gets the support that casts it by itself (a hex with
    /// Blasphemy), one child per curse and one with all of them. The engine rates the reservation it costs.
    fn op_curses(&mut self, st: &State) -> Result<Vec<(State, String)>, String> {
        let auto = |u: &str| self.gems.iter().find(|g| g.kind == Kind::Auto && util_root(g.id) == u).map(|g| g.id);
        let (mut states, mut whys) = (Vec::new(), Vec::new());
        let mut all = st.clone();
        for u in self.manual_curses(st) {
            let Some(a) = auto(u) else { continue };
            let swap = |s: &mut State| {
                if let Some(i) = s.utils.iter().position(|x| *x == u) {
                    s.utils[i] = a;
                }
            };
            let mut s = st.clone();
            swap(&mut s);
            swap(&mut all);
            states.push(s);
            whys.push(format!("{} is cast by hand: linked to {}. ", gem_name(u), gem_name(a.split('+').nth(1).unwrap_or(a))));
        }
        if states.len() > 1 {
            states.push(all);
            whys.push("every curse delivered by its own link. ".into());
        }
        let (mut keep, mut tight) = ((Vec::new(), Vec::new()), Vec::new());
        for (mut s, w) in states.into_iter().zip(whys) {
            self.price_gems(&mut s);
            // (a link the wealth budget has no room for is made room for the same way a missing socket is)
            if self.sockets_ok(&s.gear, Some(&st.gear)) && self.affordable(&s.gear, Some(&st.gear)) {
                keep.0.push(s);
                keep.1.push(w);
            } else {
                tight.push((s, w));
            }
        }
        let mut r: Vec<(State, String)> = self.eval_states_vs(keep.0, Some(&st.gear))?.into_iter().zip(keep.1).filter_map(|(s, w)| Some((s?, w))).collect();
        // A hex linked to its own caster reserves mana, and takes a socket where the gear has none free: the utility
        // skill the build misses least goes for it (one child per skill, the engine rates each). Where the room is
        // mana, only an aura frees it; where it is a socket or the wealth budget, any utility skill but a curse does.
        let mut more = Vec::new();
        let mut room: Vec<(State, String, bool)> = r.iter().filter(|(s, _)| self.hard_unmet(s).iter().any(|h| h.to_lowercase().contains("reservation"))).map(|(s, w)| (s.clone(), w.clone(), false)).collect();
        room.extend(tight.into_iter().map(|(s, w)| (s, w, true)));
        for (s, w, any) in &room {
            let kind = |u: &str| self.gems.iter().find(|g| g.id == util_root(u)).map(|g| g.kind);
            let drops: Vec<usize> = (0..s.utils.len()).filter(|&i| !self.required.contains(&s.utils[i]) && if *any { kind(s.utils[i]) != Some(Kind::Curse) } else { kind(s.utils[i]) == Some(Kind::Aura) }).collect();
            let mut kids: Vec<(usize, State)> = Vec::new();
            for &i in &drops {
                let mut kid = State { utils: s.utils.iter().enumerate().filter(|(k, _)| *k != i).map(|(_, u)| *u).collect(), ..s.clone() };
                self.price_gems(&mut kid);
                if self.sockets_ok(&kid.gear, Some(&st.gear)) && self.affordable(&kid.gear, Some(&st.gear)) {
                    kids.push((i, kid));
                }
            }
            let (ix, states): (Vec<usize>, Vec<State>) = kids.into_iter().unzip();
            for (i, kid) in ix.into_iter().zip(self.eval_states_vs(states, Some(&st.gear))?) {
                if let Some(mut kid) = kid {
                    // (what the dropped skill held up, resists first, is bought again from gear and tree)
                    // (with the delivered curse held in place, as the sustain repair holds the gems it pays for)
                    let new: Vec<&'static str> = kid.utils.iter().copied().filter(|u| !st.utils.contains(u)).collect();
                    if kid.viol > EPS {
                        let n = self.required.len();
                        self.required.extend(new.iter().copied());
                        let r = self.repair_limits_with(&mut kid, &[10.0], false);
                        self.required.truncate(n);
                        r?;
                    }
                    if !new.iter().all(|u| kid.utils.contains(u)) {
                        continue;
                    }
                    more.push((kid, format!("{w}{} dropped for the room. ", gem_name(util_root(s.utils[i])))));
                }
            }
        }
        // (a child dearer than `curse_cost` stays in the beam, where the next steps may buy back what it lost; it only
        // wins within the cost, else the curse stays by hand and is reported with the cost)
        r.extend(more);
        Ok(r)
    }

    /// The main-tree keystones `st` has allocated, read from the tree data.
    fn keystone_nodes(&self, st: &State) -> Vec<i64> {
        let Ok(tree) = crate::cached_tree(&tag_attr(&self.ctx[st.class].xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())) else { return Vec::new() };
        st.nodes.iter().copied().filter(|id| tree.nodes.get(id).and_then(|n| n.get("isKeystone")).and_then(|v| v.as_bool()).unwrap_or(false)).collect()
    }

    /// Keystone conflicts: each allocated keystone is given back in turn (with what only it holds on), the freed points
    /// spent again. A keystone that cancels a stat the build pays for (the shield made a mana pool, a crit multiplier
    /// under no crits) is a child that scores better without it; one the build uses scores less and the beam drops it.
    fn op_keystones(&mut self, st: &State) -> Result<Vec<(State, String)>, String> {
        let mut out = Vec::new();
        for id in self.keystone_nodes(st) {
            // (a keystone the player asked for is theirs: locked, like a required gem)
            if self.stop() || self.banned.borrow().contains(&id) || self.goal.keystones.iter().any(|k| k.trim().eq_ignore_ascii_case(&self.node_info(id).0)) {
                continue;
            }
            let Some(group) = self.removal_groups(st, false, 12).into_iter().find(|g| g.contains(&id)) else { continue };
            self.banned.borrow_mut().insert(id);
            let mut s = Self::without(st, &group);
            let r = self.rebase(&mut s).and_then(|_| self.grow(&mut s, false).map(|_| ()));
            self.banned.borrow_mut().remove(&id);
            r?;
            if !s.vals.is_empty() {
                out.push((s, format!("keystone {} given back. ", self.node_info(id).0)));
            }
        }
        Ok(out)
    }

    /// The share of the scored use rate the build can pay for (1 when covered; solver_boss.rs `sustain_rate`).
    fn sustain_rate(&self, st: &State) -> f64 {
        crate::solver_boss::sustain_rate(&|k| self.stat(st, k))
    }

    /// A cost the main skill pays per second is not covered at the scored use rate.
    fn unpaid(&self, st: &State) -> bool {
        let d = self.scorer.deficits(&st.vals);
        self.scorer.limits.iter().zip(&d).any(|(l, d)| *d > 0.0 && l.name.ends_with("sustainable")) || self.sustain_rate(st) < 1.0 - 1e-9
    }

    /// Sustain under the real cost: when the skill's mana, life or shield cost per second is not paid, a sustain gem
    /// (regeneration aura, cost support: solver_basics.rs `sustain_gems`) and, at a heavier penalty, the limit repair
    /// (gear, tree) with the gems held in place. Each child is a whole engine evaluation.
    fn op_sustain(&mut self, st: &State) -> Result<Vec<(State, String)>, String> {
        if !self.unpaid(st) {
            return Ok(Vec::new());
        }
        let mut out = Vec::new();
        let mut s = st.clone();
        if self.sustain_gems(&mut s)? && s.base != st.base {
            out.push((s, "a cost the build does not pay: sustain gem. ".to_string()));
        }
        let mut s = st.clone();
        self.repair_limits_with(&mut s, &[10.0], false)?;
        if s.base != st.base {
            out.push((s, "a cost the build does not pay: regeneration from gear and tree. ".to_string()));
        }
        Ok(out)
    }

    /// The supports of the main link whose removal moves no score and no limit, each with the state without it.
    fn dead_supports(&self, st: &State) -> Result<Vec<(&'static str, State)>, String> {
        let sups: Vec<&'static str> = st.main.iter().skip(1).copied().filter(|g| !self.required.contains(g)).collect();
        let states: Vec<State> = sups.iter().map(|g| State { main: st.main.iter().copied().filter(|x| x != g).collect(), ..st.clone() }).collect();
        Ok(sups.into_iter().zip(self.eval_states(states)?).filter_map(|(g, s)| s.filter(|s| s.score >= st.score - EPS && s.viol <= st.viol + EPS).map(|s| (g, s))).collect())
    }

    /// Dead supports: a support that moves nothing gives its socket to the support that pays most there (the engine
    /// rates each), or, when none pays, goes and leaves the socket free.
    fn op_dead_supports(&mut self, st: &State) -> Result<Vec<(State, String)>, String> {
        let mut out = Vec::new();
        for (g, bare) in self.dead_supports(st)? {
            let (mut states, mut names) = (Vec::new(), Vec::new());
            for c in self.support_candidates().into_iter().filter(|c| !bare.main.contains(c)) {
                let mut s = bare.clone();
                s.main.push(c);
                self.price_gems(&mut s);
                if self.mana_clash(&s.main) || !self.sockets_ok(&s.gear, Some(&st.gear)) || !self.affordable(&s.gear, Some(&st.gear)) {
                    continue;
                }
                states.push(s);
                names.push(c);
            }
            let best = self.eval_states_vs(states, Some(&st.gear))?.into_iter().zip(names).filter_map(|(s, c)| Some((s?, c))).filter(|(s, _)| s.viol <= st.viol + EPS).max_by(|a, b| a.0.score.total_cmp(&b.0.score));
            match best {
                Some((s, c)) if s.score > st.score + EPS => out.push((s, format!("{} does nothing here: {} takes its socket. ", gem_name(g), gem_name(c)))),
                _ => out.push((bare, format!("{} does nothing here: removed. ", gem_name(g)))),
            }
        }
        Ok(out)
    }

    /// Attribute nodes plus crafted lines spent on a resist or attribute the build already has past its need.
    fn waste(&self, st: &State) -> usize {
        self.attr_nodes(st) + self.surplus_lines(st).len()
    }

    /// How far element or attribute `e` is over what the build needs (below 0: short; -1 when nothing sets a need).
    fn spare(&self, st: &State, e: &str) -> f64 {
        if ATTRS.contains(&e) {
            return match (self.stat(st, e), self.stat(st, &format!("Req{e}"))) {
                (Some(v), Some(r)) if self.goal.limits.attributes => v - r,
                _ => -1.0,
            };
        }
        // (met floor: only what is past the cap is spare; a resist under its cap still pays, chaos most of all)
        let s = resist_surplus(&self.scorer, &st.vals, e);
        let over = |n: String| self.stat(st, &n).or_else(|| self.stat(st, &format!("{NO_FLASK}{n}")));
        if s < 0.0 { s } else { over(format!("{e}ResistOverCap")).map_or(s, |o| o.max(0.0)) }
    }

    /// (slot, family) of every crafted line whose whole amount the build has spare (a resist past its cap, an attribute
    /// past every requirement).
    fn surplus_lines(&self, st: &State) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        for i in (0..self.slots.len()).filter(|&i| !self.slots[i].locked) {
            let Some(Design::Craft { base, mods, .. }) = st.gear.pieces[i].as_ref().map(|p| &p.design) else { continue };
            for &m in mods {
                if !base.fams[m].implicit && resist_surplus_line(&base.fams[m].lines, &|e| self.spare(st, e)) {
                    out.push((i, m));
                }
            }
        }
        out
    }

    /// A line a repair may put on the gear: not local, not an implicit, and a resist or attribute only where the build
    /// is short of it.
    fn repair_line(&self, st: &State, f: &Fam) -> bool {
        !f.implicit && !f.local && !f.lines.is_empty() && f.lines.iter().flat_map(|l| resist_amounts(l)).all(|(e, _)| self.spare(st, e) < 0.0)
    }

    /// The value of every line a repair may add to the crafted pieces, probed once on the final (each as a custom line).
    fn line_probes(&self, st: &State) -> Result<HashMap<String, f64>, String> {
        let mut sets: Vec<Vec<String>> = Vec::new();
        let mut seen: HashSet<String> = HashSet::default();
        for i in (0..self.slots.len()).filter(|&i| !self.slots[i].locked) {
            let Some(Design::Craft { base, .. }) = st.gear.pieces[i].as_ref().map(|p| &p.design) else { continue };
            for f in base.fams.iter().filter(|f| self.repair_line(st, f)) {
                if sets.len() < MAX_LINES && seen.insert(f.lines.join("\n")) {
                    sets.push(f.lines.clone());
                }
            }
        }
        let (_, gains) = self.line_gains(st, &[], &sets)?;
        Ok(sets.into_iter().map(|s| s.join("\n")).zip(gains).collect())
    }

    /// Wasted-line repair: each crafted line the build has spare is replaced with the best line it needs (or dropped),
    /// and an open affix on an armour piece or jewel gets the best line that fits (solver_craft.rs `resist_trim_pass`,
    /// as children of the beam: a swap that loses a little may still pay with the next step).
    fn op_lines(&self, st: &State, probes: &HashMap<String, f64>) -> Result<Vec<(State, String)>, String> {
        let gain = |f: &Fam| probes.get(&f.lines.join("\n")).copied();
        let mut targets: Vec<(usize, Option<usize>)> = self.surplus_lines(st).into_iter().map(|(i, m)| (i, Some(m))).collect();
        for i in (0..self.slots.len()).filter(|&i| !self.slots[i].locked && matches!(self.slots[i].kind, SlotKind::Helmet | SlotKind::Body | SlotKind::Gloves | SlotKind::Boots | SlotKind::Belt | SlotKind::Amulet | SlotKind::Ring | SlotKind::Weapon2)) {
            if let Some(Design::Craft { base, mods, .. }) = st.gear.pieces[i].as_ref().map(|p| &p.design) {
                if (0..base.fams.len()).any(|c| !base.fams[c].implicit && addable(base, mods, c)) {
                    targets.push((i, None));
                }
            }
        }
        let (mut states, mut whys, mut moves) = (Vec::new(), Vec::new(), Vec::new());
        for (i, m) in targets {
            let Some(Design::Craft { base, mods, anoint }) = st.gear.pieces[i].as_ref().map(|p| p.design.clone()) else { continue };
            let rest: Vec<usize> = mods.iter().copied().filter(|&x| Some(x) != m).collect();
            let mut cands: Vec<(f64, usize)> = (0..base.fams.len()).filter(|&c| Some(c) != m && !rest.contains(&c) && self.repair_line(st, &base.fams[c]) && addable(&base, &rest, c)).filter_map(|c| Some((gain(&base.fams[c])?, c))).collect();
            cands.sort_by(|a, b| b.0.total_cmp(&a.0));
            let mut picks: Vec<Vec<usize>> = cands.iter().filter(|c| m.is_some() || c.0 > EPS).take(2).map(|c| [rest.as_slice(), &[c.1]].concat()).collect();
            // (a wasted line also comes off bare: its price may be what buys a needed line elsewhere)
            if m.is_some() {
                picks.push(rest.clone());
            }
            for p in picks {
                let piece = craft_piece(&base, p, anoint.clone(), self.item_level);
                let Some(g) = self.with_piece(&st.gear, i, Some(piece.clone())) else { continue };
                let mut s = st.clone();
                s.gear = Arc::new(g);
                states.push(s);
                moves.push((i, piece));
                whys.push(match m {
                    Some(m) => format!("{}: \"{}\" is past what the build needs. ", self.slots[i].name, base.fams[m].lines.join(" / ")),
                    None => format!("{}: an open affix. ", self.slots[i].name),
                });
            }
        }
        let r = self.eval_states(states)?;
        // Every slot's best change that does not lose, together (one child: a build with eight wasted lines needs eight).
        let mut best: Vec<(usize, f64, usize)> = Vec::new();
        for (k, s) in r.iter().enumerate() {
            let Some(s) = s.as_ref().filter(|s| s.viol <= st.viol + EPS && s.score >= st.score - TOL) else { continue };
            match best.iter_mut().find(|b| b.0 == moves[k].0) {
                Some(b) if s.score > b.1 => *b = (moves[k].0, s.score, k),
                Some(_) => {}
                None => best.push((moves[k].0, s.score, k)),
            }
        }
        let mut out: Vec<(State, String)> = r.into_iter().zip(whys).filter_map(|(s, w)| Some((s?, w))).collect();
        // Every wasted line off at once (one child: what they cost buys the needed lines in the next step).
        let sur = self.surplus_lines(st);
        if sur.len() > 1 {
            let mut g = (*st.gear).clone();
            for i in sur.iter().map(|x| x.0).collect::<HashSet<_>>() {
                let Some(Design::Craft { base, mods, anoint }) = g.pieces[i].as_ref().map(|p| p.design.clone()) else { continue };
                let keep: Vec<usize> = mods.into_iter().filter(|m| !sur.contains(&(i, *m))).collect();
                g = self.with_piece(&g, i, Some(craft_piece(&base, keep, anoint, self.item_level))).unwrap_or(g);
            }
            let mut s = st.clone();
            s.gear = Arc::new(g);
            if let Some(s) = self.eval_states(vec![s])?.pop().flatten() {
                out.push((s, format!("all {} wasted lines off. ", sur.len())));
            }
        }
        if best.len() > 1 {
            let mut g = (*st.gear).clone();
            for b in &best {
                g = self.with_piece(&g, moves[b.2].0, Some(moves[b.2].1.clone())).unwrap_or(g);
            }
            let mut s = st.clone();
            s.gear = Arc::new(g);
            if let Some(s) = self.eval_states(vec![s])?.pop().flatten() {
                out.push((s, format!("the best line repair of {} slots together. ", best.len())));
            }
        }
        Ok(out)
    }

    /// Attribute repair, cheapest source first: the utility gems that set an attribute requirement go down to the level
    /// where it stops falling (the knee), and halfway there; a gem whose own requirement does not set it keeps its
    /// level. Read from each gem's attribute multipliers; the main skill's link and required gems keep theirs.
    fn op_levels(&self, st: &State) -> Result<Vec<(State, String)>, String> {
        let mut out = Vec::new();
        for (k, a) in ATTRS.iter().enumerate() {
            let rq = format!("Req{a}");
            let Some(req) = self.stat(st, &rq) else { continue };
            let mult = |id: &str| gd::game_data().gems.get(id).map_or(0.0, |g| [g.req_str, g.req_dex, g.req_int][k]);
            let support = |id: &str| gd::game_data().gems.get(id).and_then(gd::gem_primary_effect).is_some_and(gd::is_support);
            let mut ids: Vec<&'static str> = st.utils.iter().flat_map(|u| u.split('+')).filter_map(find_gem).filter(|g| !support(g) && !self.required.contains(g) && *g != self.main_gem && mult(g) > 0.0).collect();
            ids.dedup();
            if ids.is_empty() {
                continue;
            }
            let cur = |id: &str| st.gem_levels.iter().find(|g| g.0 == id).map_or(u32::MAX, |g| g.1);
            let at = |gems: &[&'static str], l: u32| {
                let mut s = st.clone();
                for &g in gems {
                    s.gem_levels.retain(|x| x.0 != g);
                    s.gem_levels.push((g, cur(g).min(l)));
                }
                s
            };
            let r = self.eval_states(LEVELS.iter().map(|&l| at(&ids, l)).collect())?;
            let reqs: Vec<Option<f64>> = r.iter().map(|s| s.as_ref().and_then(|s| self.stat(s, &rq))).collect();
            let Some(low) = reqs.iter().flatten().copied().reduce(f64::min) else { continue };
            if low >= req - 1.0 {
                continue;
            }
            // (each level where the requirement steps down; the knee, and the middle step)
            let steps: Vec<usize> = (0..LEVELS.len()).filter(|&j| reqs[j].is_some_and(|q| q < reqs[..j].iter().flatten().copied().fold(req, f64::min) - 0.5)).collect();
            let Some(&knee) = steps.iter().find(|&&j| reqs[j].is_some_and(|q| q <= low + 0.5)) else { continue };
            let mut picks = vec![knee];
            if let Some(&mid) = steps.get(steps.len() / 2).filter(|&&j| j != knee) {
                picks.push(mid);
            }
            for j in picks {
                let q = reqs[j].unwrap_or(req);
                // (a gem put back to its own level that leaves the requirement where it is was not setting it)
                let back: Vec<Vec<&'static str>> = ids.iter().map(|g| ids.iter().copied().filter(|x| x != g).collect()).collect();
                let rb = if ids.len() > 1 { self.eval_states(back.iter().map(|g| at(g, LEVELS[j])).collect())? } else { Vec::new() };
                let mut keep = ids.clone();
                for (g, s) in ids.iter().zip(&rb) {
                    if s.as_ref().and_then(|s| self.stat(s, &rq)).is_some_and(|x| x <= q + 0.5) {
                        keep.retain(|x| x != g);
                    }
                }
                let s = if keep.len() == ids.len() { r[j].clone() } else { self.eval_states(vec![at(&keep, LEVELS[j])])?.pop().flatten() };
                let Some(s) = s else { continue };
                let q = self.stat(&s, &rq).unwrap_or(q);
                out.push((s, format!("{a} requirement {req:.0} -> {q:.0}. ")));
            }
        }
        Ok(out)
    }

    /// Spare attribute nodes go back and the points are spent again (solver_basics.rs `attr_prune`).
    fn op_attr_nodes(&mut self, st: &State) -> Result<Vec<(State, String)>, String> {
        let mut s = st.clone();
        if !self.attr_prune(&mut s)? || s.nodes == st.nodes {
            return Ok(Vec::new());
        }
        Ok(vec![(s, String::new())])
    }

    /// The utility set: a movement and a guard skill, a curse when none is linked, movement speed, a flask in place of
    /// one that does nothing in the mode, and a frenzy generator when the main skill scales with frenzy charges and the
    /// build keeps none up.
    fn op_utility(&mut self, st: &State) -> Result<Vec<(State, String)>, String> {
        let mut states = Vec::new();
        if let (Some(s), _) = self.fill_basics(st)? {
            states.push((s, String::new()));
        }
        // (every button the play mode allows taken and none of them moves: the movement skill takes one pressed
        // utility's place, each one tried; the goal's own gems stay)
        let moving = st.main.iter().chain(&st.utils).any(|u| self.moves(u));
        if !moving && checklist::wants(&self.goal, "movement-skill") && self.presses(st) >= self.press_cap() {
            for u in st.utils.iter().copied().filter(|u| self.pressed(u) && !self.required.contains(u)) {
                let mut t = st.clone();
                t.utils.retain(|x| *x != u);
                if let Ok(s) = self.add_utility(&t, Kind::Movement)? {
                    states.push((s, format!("{} gave its button to the movement skill. ", gem_name(u))));
                }
            }
        }
        let curse = st.utils.iter().any(|u| self.gems.iter().any(|g| g.id == util_root(u) && g.kind == Kind::Curse));
        if !curse {
            for kind in [Kind::Curse, Kind::Auto] {
                if let Ok(s) = self.add_utility(st, kind)? {
                    states.push((s, String::new()));
                }
            }
        }
        let mut s = st.clone();
        if self.movement_pass(&mut s)? {
            states.push((s, String::new()));
        }
        for i in self.dead_flasks(st)? {
            if let Some(s) = self.flask_for(st, i)? {
                states.push((s, format!("{} did nothing in this mode. ", self.slots[i].name)));
            }
        }
        if self.frenzy_short(st) {
            for needle in FRENZY_GEN {
                if let Ok(s) = self.add_support(st, needle)? {
                    states.push((s, String::new()));
                }
            }
        }
        let (s, w): (Vec<State>, Vec<String>) = states.into_iter().unzip();
        Ok(self.eval_states(s)?.into_iter().zip(w).filter_map(|(s, w)| Some((s?, w))).collect())
    }

    /// Each flask slot with the score the build has without that flask (the engine, flask removed).
    fn flask_removal(&self, st: &State) -> Result<Vec<(usize, f64, f64, f64)>, String> {
        let (mut ix, mut states) = (Vec::new(), Vec::new());
        for i in (0..self.slots.len()).filter(|&k| self.slots[k].kind == SlotKind::Flask && !self.slots[k].locked && st.gear.pieces[k].is_some()) {
            if let Some(g) = self.with_piece(&st.gear, i, None) {
                let mut s = st.clone();
                s.gear = Arc::new(g);
                ix.push(i);
                states.push(s);
            }
        }
        Ok(ix.into_iter().zip(self.eval_states(states)?).filter_map(|(i, s)| s.map(|s| (i, s.score, s.viol, self.stat(&s, "TotalEHP").unwrap_or(0.0)))).collect())
    }

    /// Flask slots whose flask can go without the score, any limit or the EHP moving.
    fn dead_flasks(&self, st: &State) -> Result<Vec<usize>, String> {
        let ehp = self.stat(st, "TotalEHP").unwrap_or(0.0);
        Ok(self.flask_removal(st)?.into_iter().filter(|(_, score, viol, e)| *score >= st.score - EPS && *viol <= st.viol + EPS && *e >= ehp - EPS).map(|(i, _, _, _)| i).collect())
    }

    /// The utility flask (bare, or with one suffix) that scores best in slot `i`, when one beats `st`.
    fn flask_for(&self, st: &State, i: usize) -> Result<Option<State>, String> {
        let mut states = Vec::new();
        for b in self.slot_bases(i) {
            let base = self.craft_base(&b, &[])?;
            if base.sub_type != "Utility" {
                continue;
            }
            let pieces = std::iter::once(Vec::new()).chain((0..base.fams.len()).filter(|&f| !base.fams[f].prefix && !base.fams[f].implicit).map(|f| vec![f]));
            for m in pieces {
                if let Some(g) = self.with_piece(&st.gear, i, Some(craft_piece(&base, m, None, self.item_level))) {
                    let mut s = st.clone();
                    s.gear = Arc::new(g);
                    states.push(s);
                }
            }
        }
        Ok(self.eval_states(states)?.into_iter().flatten().filter(|s| s.score > st.score + EPS && s.viol <= st.viol + EPS).max_by(|a, b| a.score.total_cmp(&b.score)))
    }

    /// The engine's frenzy charges when the main skill scales with them (a "per_frenzy_charge" stat id of its gem).
    /// The count is real: the charge switch is on only while the setup makes what it spends (solver_config.rs).
    fn frenzy(&self, st: &State) -> Option<f64> {
        let ge = gd::game_data().gems.get(self.main_gem).and_then(gd::gem_primary_effect)?;
        let mut names = ge.stats.iter().map(String::as_str).chain(ge.extra.get("constantStats").and_then(|c| c.as_array()).into_iter().flatten().filter_map(|p| p.get(0).and_then(|n| n.as_str())));
        names.any(|n| n.contains("per_frenzy_charge") || n.contains("per_removable_frenzy_charge")).then(|| self.stat(st, "FrenzyCharges").unwrap_or(0.0))
    }

    /// The main skill scales with frenzy charges and the engine keeps none up.
    fn frenzy_short(&self, st: &State) -> bool {
        self.frenzy(st).is_some_and(|c| c < 1.0)
    }

    /// What the beam could not fix on `st`: hard failures, frenzy, flasks that do nothing.
    fn unresolved(&self, st: &State) -> Result<Vec<String>, String> {
        let mut out = self.hard_unmet(st);
        if self.frenzy_short(st) {
            out.push(format!("{} scales with frenzy charges and the build keeps none up: no generator outpaces the spending", gem_name(self.main_gem)));
        }
        for i in self.dead_flasks(st)? {
            out.push(format!("{} does nothing in this mode and no flask that does fits", self.slots[i].name));
        }
        Ok(out)
    }

    /// What changed from `a` to `b`, as a player reads it: gear lines out and in, gem levels, gems, attribute nodes.
    fn describe(&self, a: &State, b: &State) -> String {
        let mut parts = Vec::new();
        let lines = |p: &Option<Piece>| -> Vec<String> { p.as_ref().map(|p| items::active_lines(&p.xml)).unwrap_or_default() };
        for i in 0..self.slots.len() {
            let (x, y) = (lines(&a.gear.pieces[i]), lines(&b.gear.pieces[i]));
            if x == y && a.gear.pieces[i].as_ref().map(|p| &p.label) == b.gear.pieces[i].as_ref().map(|p| &p.label) {
                continue;
            }
            let out: Vec<&String> = x.iter().filter(|l| !y.contains(l)).collect();
            let inn: Vec<&String> = y.iter().filter(|l| !x.contains(l)).collect();
            let name = |p: &Option<Piece>| p.as_ref().map_or("nothing".to_string(), |p| p.label.split(':').next().unwrap_or("").to_string());
            if out.is_empty() && inn.is_empty() {
                parts.push(format!("{}: {} -> {}", self.slots[i].name, name(&a.gear.pieces[i]), name(&b.gear.pieces[i])));
            } else {
                parts.push(format!("{}: {} -> {}", self.slots[i].name, if out.is_empty() { "-".into() } else { out.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" / ") }, if inn.is_empty() { "-".into() } else { inn.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" / ") }));
            }
        }
        for (g, l) in &b.gem_levels {
            if !a.gem_levels.contains(&(*g, *l)) {
                parts.push(format!("{} to level {l}", gem_name(g)));
            }
        }
        let gems = |s: &State| s.main.iter().chain(&s.utils).map(|g| gem_name(g)).collect::<Vec<_>>();
        let (ga, gb) = (gems(a), gems(b));
        let added: Vec<&String> = gb.iter().filter(|g| !ga.contains(g)).collect();
        let gone: Vec<&String> = ga.iter().filter(|g| !gb.contains(g)).collect();
        if !added.is_empty() || !gone.is_empty() {
            parts.push(format!("gems {} -> {}", if gone.is_empty() { "-".into() } else { gone.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ") }, if added.is_empty() { "-".into() } else { added.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ") }));
        }
        if a.nodes != b.nodes {
            let out: Vec<String> = a.nodes.iter().filter(|n| !b.nodes.contains(n)).map(|&n| self.node_info(n).0.clone()).collect();
            let inn: Vec<String> = b.nodes.iter().filter(|n| !a.nodes.contains(n)).map(|&n| self.node_info(n).0.clone()).collect();
            parts.push(format!("passives out ({}), in ({}); attribute nodes {} -> {}", out.join(", "), inn.join(", "), self.attr_nodes(a), self.attr_nodes(b)));
        }
        let tree = crate::cached_tree(&tag_attr(&self.ctx[b.class].xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into())).ok();
        let live = |s: &State| s.masteries.iter().copied().filter(|(n, _)| s.nodes.contains(n)).collect::<Vec<_>>();
        let (ma, mb) = (live(a), live(b));
        for (n, e) in ma.iter().filter(|m| !mb.contains(m)) {
            parts.push(format!("mastery {} out", mastery_text(tree, *n, *e)));
        }
        for (n, e) in mb.iter().filter(|m| !ma.contains(m)) {
            parts.push(format!("mastery {} in", mastery_text(tree, *n, *e)));
        }
        parts.join("; ")
    }

    /// The frozen build `xml` as a state: its tree, its socket groups, its items. A crafted rare becomes the solver's
    /// own design again (its families found line by line) so the repairs can change its lines.
    pub(super) fn frozen_state(&mut self, xml: &str) -> Result<State, String> {
        let (cid, aid, _, _) = self.seed.clone().ok_or("the build has no passive tree")?;
        let class = self.class_ctx(cid, aid)?;
        let (main, utils) = self.gems_of(xml);
        if main.first() != Some(&self.main_gem) {
            return Err(format!("the build's main group is not {}", self.goal.skill));
        }
        let mut gear = (*self.start_gear).clone();
        let mut kept = Vec::new();
        for i in 0..self.slots.len() {
            if gear.pieces[i].is_some() {
                continue;
            }
            if let Some(p) = self.player_pieces[i].clone() {
                let c = self.as_craft(&p);
                if c.is_none() && p.xml.contains("Rarity: RARE") {
                    kept.push(self.slots[i].name.clone());
                }
                gear.pieces[i] = Some(c.unwrap_or(p));
            }
        }
        if !kept.is_empty() {
            self.assumptions.push(format!("Kept as the player's items (no family matched every line): {}", kept.join(", ")));
        }
        gear.ready = true;
        let mut st = self.initial_state(class, Some((main, utils)), Some(Arc::new(gear)))?;
        self.assume_ailments(&mut st)?;
        Ok(st)
    }

    /// The enabled socket groups of `xml`: the main group (main skill first) and one utility entry per other group.
    pub(super) fn gems_of(&self, xml: &str) -> (Vec<&'static str>, Vec<&'static str>) {
        let Ok(doc) = roxmltree::Document::parse(xml) else { return Default::default() };
        let Some(skills) = crate::edit::elements(doc.root_element(), "Skills").next() else { return Default::default() };
        let main_at = tag_attr(xml, "Build", "mainSocketGroup").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1);
        let (mut main, mut utils) = (Vec::new(), Vec::new());
        for (k, g) in crate::edit::active_socket_groups(skills).into_iter().enumerate() {
            let ids: Vec<&'static str> = g.children().filter(|n| n.has_tag_name("Gem") && n.attribute("enabled") != Some("false")).filter_map(|n| n.attribute("nameSpec")).filter_map(find_gem).collect();
            if k + 1 == main_at {
                main = ids;
                continue;
            }
            if g.attribute("enabled") == Some("false") || ids.is_empty() {
                continue;
            }
            let joined = ids.join("+");
            utils.push(self.gems.iter().find(|x| x.id == joined).map_or(ids[0], |x| x.id));
        }
        if let Some(i) = main.iter().position(|g| *g == self.main_gem) {
            let m = main.remove(i);
            main.insert(0, m);
        }
        (main, utils)
    }

    /// A crafted rare of the frozen build as the solver's design on its base: every line matched to a family (most
    /// lines first), and the rebuilt text equal to the item's. None when any line matches nothing.
    fn as_craft(&self, p: &Piece) -> Option<Piece> {
        if !matches!(p.design, Design::Player) {
            return None;
        }
        let lines: Vec<&str> = p.xml.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        if lines.first() != Some(&"Rarity: RARE") {
            return None;
        }
        let game = pom_calc::data::game_data();
        let name = lines.iter().find(|l| game.item_bases.get(**l).is_some())?.to_string();
        let at = lines.iter().position(|l| l.starts_with("Implicits:"))?;
        let cat = lines[..at].iter().find_map(|l| l.strip_prefix("Catalyst: "));
        let body: Vec<String> = lines[at + 1..].iter().filter(|l| **l != "Corrupted").map(|l| l.to_string()).collect();
        let anoint = body.iter().find_map(|l| l.strip_prefix("{crafted}Allocates ").map(String::from));
        let take = |left: &mut Vec<String>, l: &str| match left.iter().position(|x| x == l) {
            Some(i) => {
                left.remove(i);
                true
            }
            None => false,
        };
        for base in [self.base(&name).ok(), self.base_craft(&name, &[]).ok()].into_iter().flatten() {
            let mut left = body.clone();
            if let Some(a) = &anoint {
                take(&mut left, &format!("{{crafted}}Allocates {a}"));
            }
            for l in &base.implicit {
                take(&mut left, &crate::edit::esc_text(l));
            }
            let mut order: Vec<usize> = (0..base.fams.len()).filter(|&f| !base.fams[f].lines.is_empty()).collect();
            order.sort_by_key(|&f| std::cmp::Reverse(base.fams[f].lines.len()));
            let mut mods: Vec<usize> = (0..base.fams.len()).filter(|&f| cat.is_some() && catalyst_of(&base.fams[f]) == cat).take(1).collect();
            // (a family the wealth budget stepped down matches one of its lower tiers: the base copy holds that tier,
            // as `step_to_budget` writes it)
            let mut b = (*base).clone();
            for f in order {
                let mut cand = Some(b.fams[f].clone());
                while let Some(fam) = cand {
                    let fl: Vec<String> = fam.lines.iter().map(|l| crate::edit::esc_text(&format!("{}{l}", line_flags(&fam, cat.is_some())))).collect();
                    let mut trial = left.clone();
                    if fl.iter().all(|l| take(&mut trial, l)) && addable(&b, &mods, f) {
                        left = trial;
                        b.fams[f] = fam;
                        mods.push(f);
                        break;
                    }
                    cand = fam.stepped();
                }
            }
            let base = Arc::new(b);
            if !left.is_empty() {
                continue;
            }
            let q = craft_piece(&base, mods, anoint.clone(), self.item_level);
            let norm = |x: &str| {
                let mut v: Vec<String> = x.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("LevelReq:") && !l.starts_with("Sockets:")).map(String::from).collect();
                v.sort();
                v
            };
            if norm(&q.xml) == norm(&p.xml) {
                return Some(q);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(f: &str) -> String {
        std::fs::read_to_string(format!("{}/testdata/{f}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }

    #[test]
    fn gem_level_set_in_its_own_tag() {
        let g = r#"<Skill><Gem nameSpec="A" gemId="Metadata/A" level="20" quality="20"/><Gem nameSpec="B" gemId="Metadata/B" level="20"/></Skill>"#;
        let t = set_gem_level(g, "Metadata/B", 7);
        assert!(t.contains(r#"gemId="Metadata/A" level="20""#) && t.contains(r#"gemId="Metadata/B" level="7""#), "{t}");
    }

    /// Every crafted rare of the frozen Righteous Fire and Flicker Strike replays becomes the solver's design again.
    #[test]
    fn frozen_rares_become_designs() {
        for (file, skill) in [("attr-rf.xml", "Righteous Fire"), ("attr-fs.xml", "Flicker Strike")] {
            let goal: Goal = serde_json::from_str(&format!(r#"{{"skill":"{skill}","level":90,"wealth":"league-start","targets":[{{"name":"DPS","metric":"combined"}}],"assume":{{"playMode":"mapping"}}}}"#)).unwrap();
            let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
            let xml = fixture(file);
            let mut s = Solver::new(xml.clone(), goal, serde_json::from_str(r#"{"threads":2}"#).unwrap(), shared, Arc::new(AtomicBool::new(false))).unwrap();
            let st = s.frozen_state(&xml).unwrap();
            println!("{file}: main {:?} utils {:?}", st.main.iter().map(|g| gem_name(g)).collect::<Vec<_>>(), st.utils.iter().map(|g| gem_name(g)).collect::<Vec<_>>());
            assert!(!s.assumptions.iter().any(|a| a.starts_with("Kept as the player's")), "{file}: {:?}", s.assumptions.last());
            assert!(st.utils.len() >= 4, "{file}: utility groups lost");
        }
    }

    /// Finish line, Righteous Fire replay: no crafted line on a resist past its
    /// cap, gloves and rings carry life, every kept repair logged with engine figures.
    #[test]
    fn rf_replay_wastes_no_line_and_fills_gloves_and_rings() {
        const RF: &str = r#"{"skill":"Righteous Fire","level":90,"wealth":"league-start","targets":[{"name":"DPS","metric":"combined"}],"assume":{"playMode":"mapping"}}"#;
        let (_, after, rec) = finish(fixture("attr-rf.xml"), RF, r#"{"timeBudgetMs":900000,"maxEvals":40000,"threads":6}"#).unwrap();
        println!("{}", serde_json::to_string_pretty(&rec).unwrap());
        assert!(rec["kept_items"].as_array().is_some_and(|a| a.is_empty()), "rares left as the player's: {}", rec["kept_items"]);
        // (resists only: an attribute line past its requirement still buys life or damage, so the engine decides it)
        let past: Vec<_> = rec["surplusLines"].as_array().into_iter().flatten().filter(|l| l.as_str().is_some_and(|l| l.contains("Resist"))).collect();
        assert!(past.is_empty(), "resist lines past the cap: {past:?}");
        for s in rec["kept"].as_array().into_iter().flatten() {
            assert!(s["before"]["score"].is_number() && s["after"]["score"].is_number(), "a repair without its engine figures: {s}");
        }
        let doc = roxmltree::Document::parse(&after).unwrap();
        let item = |slot: &str| -> String {
            let id = doc.descendants().find(|n| n.has_tag_name("Slot") && n.attribute("name") == Some(slot)).and_then(|n| n.attribute("itemId")).unwrap_or("");
            doc.descendants().find(|n| n.has_tag_name("Item") && n.attribute("id") == Some(id)).and_then(|n| n.text()).unwrap_or("").to_string()
        };
        for slot in ["Gloves", "Ring 1", "Ring 2"] {
            assert!(item(slot).contains("to maximum Life"), "{slot} carries no life:\n{}", item(slot));
            println!("{slot}:\n{}", item(slot));
        }
    }

    /// A summon whose damage is its minions' alone is studied on minion axes, never the player's damage axes.
    #[test]
    fn srs_studied_on_minion_axes() {
        let goal = std::fs::read_to_string(format!("{}/testdata/srs-goal.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let xml = fixture("srs-cli.xml");
        let mut s = Solver::new(xml.clone(), serde_json::from_str(&goal).unwrap(), serde_json::from_str(r#"{"threads":4}"#).unwrap(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let st = s.frozen_state(&xml).unwrap();
        assert!(sens::minion_actor(s.main_gem), "SRS read as a player hit");
        for g in ["Absolution", "Dominating Blow", "Fireball"] {
            assert!(!sens::minion_actor(find_gem(g).unwrap()), "{g} read as minions only");
        }
        let names: Vec<&str> = s.sens_axes(true).iter().map(|&i| sens::AXES[i].name).collect();
        println!("axes: {names:?}");
        for player in ["increased damage", "added fire (spell)", "cast speed", "crit", "fire penetration", "ignite route"] {
            assert!(!names.contains(&player), "player axis {player} measured for SRS");
        }
        assert!(names.iter().any(|n| n.starts_with("Minions have") && n.contains("Life")), "no minion life axis: {names:?}");
        let sens = s.sensitivity(&st).unwrap();
        for (k, &i) in sens.axes.iter().enumerate() {
            println!("{:60} marginal {:8.4} committed {:8.4}", sens::AXES[i].name, sens.marginal[k], sens.committed[k]);
        }
        let gain = |n: &str| sens.axes.iter().position(|&i| sens::AXES[i].name == n).map(|k| sens.committed[k]).unwrap_or(0.0);
        assert!(gain("minion damage") > 0.1 && gain("minion speed") > 0.05, "minion axes pay nothing");
    }

    /// Finish line, Summon Raging Spirit replay: its passives scale the
    /// player's own fire (the boots' Burning Ground), which no local repair gives back, so the package fallback remakes
    /// the package. A short solve from the replay fills the book with realized leads first, so the fallback tries the
    /// next leads too. No passive left that scales only the player's damage, a movement skill in, no passive group
    /// paying under 5e-4 of the score a point (solver_basics.rs `PRUNE_COST`), every step logged with engine figures.
    #[test]
    fn srs_replay_falls_back_to_a_minion_package() {
        let goal: Goal = serde_json::from_str(&std::fs::read_to_string(format!("{}/testdata/srs-goal.json", env!("CARGO_MANIFEST_DIR"))).unwrap()).unwrap();
        let xml = fixture("srs-cli.xml");
        clear::load_text_rules();
        pom_engine::modparser::text_rules::set_active(true);
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":3600000,"maxEvals":30000,"threads":6}"#).unwrap();
        let mut s = Solver::new(xml.clone(), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        s.run().unwrap();
        let realized = s.book.leads.iter().filter(|l| l.st.is_some() && l.status != leads::Status::Dropped).count();
        assert!(realized >= 2, "the solve realized {realized} leads");
        // (the finish gets tries of its own, as `pom-cli finish` does)
        s.max_evals = s.evals.load(Ordering::Relaxed) + 400_000;
        s.started = Instant::now();
        s.finalizing.set(true);
        let mut st = s.frozen_state(&xml).unwrap();
        let before = s.render(&st).unwrap();
        let rec = s.finishing(&mut st).unwrap();
        let after = s.render(&st).unwrap();
        println!("{}", serde_json::to_string_pretty(&rec).unwrap());
        let fb = &rec["fallback"];
        assert!(fb["why"].as_array().is_some_and(|w| w.iter().any(|w| w.as_str().is_some_and(|w| w.contains("scale only the player's damage")))), "fallback not triggered: {fb}");
        assert!(fb["kept"].is_string(), "no new package kept: {fb}");
        let leads: Vec<&Value> = fb["tried"].as_array().into_iter().flatten().filter(|t| t["package"].as_str().is_some_and(|p| p.starts_with("lead "))).collect();
        assert!(!leads.is_empty(), "no next lead tried: {}", fb["tried"]);
        for t in &leads {
            assert!(t["failures"].is_array() && t["after"]["score"].is_number(), "a lead tried without its figures: {t}");
        }
        let nodes = |x: &str| tag_attr(x, "Spec", "nodes").unwrap_or_default().split(',').map(String::from).collect::<HashSet<_>>();
        assert_ne!(nodes(&before), nodes(&after), "the package kept the same tree");
        let unresolved: Vec<&str> = rec["unresolved"].as_array().into_iter().flatten().filter_map(|u| u.as_str()).collect();
        assert!(!unresolved.iter().any(|u| u.contains("scale only the player's damage")), "player-damage passives left: {unresolved:?}");
        assert!(!unresolved.contains(&"Movement skill") && st.utils.iter().any(|u| s.moves(u)), "no movement skill: {unresolved:?}");
        // (the regrowth spends its points where they pay: no group bought for a hair, an attribute passive aside)
        let groups: Vec<Vec<i64>> = s.removal_groups(&st, false, 4).into_iter().filter(|g| g.iter().all(|&n| s.attr_node(n).is_none())).collect();
        let r = s.eval_nodes(&st, &groups.iter().map(|g| (Solver::without(&st, g).nodes, None)).collect::<Vec<_>>());
        for (g, v) in groups.iter().zip(&r) {
            let Some((sc, viol, _)) = v else { continue };
            let per = (st.score - sc) / g.len() as f64;
            println!("{:70} {per:+.5} a point", g.iter().map(|&n| s.node_info(n).0.clone()).collect::<Vec<_>>().join(", "));
            assert!(per >= DEAD_POINT || *viol > st.viol + EPS, "passives that pay {per:.5} a point: {:?}", g.iter().map(|&n| s.node_info(n).0.clone()).collect::<Vec<_>>());
        }
        for k in rec["kept"].as_array().into_iter().flatten() {
            assert!(k["before"]["score"].is_number() && k["after"]["score"].is_number(), "a repair without its engine figures: {k}");
        }
    }

    /// Finish line, Eldritch Battery replay (frozen in testdata, the goal asks for the keystone): the keystone stays, the
    /// shield pays the skill's cost, Despair is delivered, every flask the build keeps does something, no support is dead.
    #[test]
    fn eb_replay_keeps_keystone_pays_cost_and_delivers_curse() {
        let goal = std::fs::read_to_string(format!("{}/testdata/eb-goal.json", env!("CARGO_MANIFEST_DIR"))).unwrap();
        let (_, _, rec) = finish(fixture("eb-cli.xml"), &goal, r#"{"timeBudgetMs":900000,"maxEvals":40000,"threads":6}"#).unwrap();
        println!("{}", serde_json::to_string_pretty(&rec).unwrap());
        assert!(rec["keystones"].as_array().is_some_and(|k| k.iter().any(|k| k == "Eldritch Battery")), "keystone given back: {}", rec["keystones"]);
        assert!(rec["sustain"]["ES"]["net"].as_f64().is_some_and(|n| n >= 0.0), "shield cost not paid: {}", rec["sustain"]);
        assert!(rec["curses"].as_array().is_some_and(|c| !c.is_empty() && c.iter().all(|c| c["delivered"] == true)), "curse by hand: {} {}", rec["curses"], rec["unresolved"]);
        assert!(rec["flasks"].as_array().into_iter().flatten().all(|f| f["does_something"] == true), "a flask does nothing: {}", rec["flasks"]);
        assert!(rec["deadSupports"].as_array().is_some_and(|d| d.is_empty()), "dead supports: {}", rec["deadSupports"]);
    }
}
