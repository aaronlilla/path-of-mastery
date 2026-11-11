//! The honest re-check (PLAN 4.7, part 1 and 4): every shown result is scored again with conservative config. Each config
//! switch in the result's text is read as it stands (not by the solver's sourcer, which wrote most of them) and taken out
//! unless the result earns it under the stricter rules of `Sw::earned`. The raw and the conservative numbers go on the
//! result; a gap over 5% is flagged. Nothing here names an item, skill or node.
use super::*;
use regex::Regex;
use std::sync::OnceLock;

/// A result whose targets move by more than this share under conservative config is flagged.
pub(super) const FLAG_AT: f64 = 0.05;

#[derive(Clone, Debug)]
pub(super) struct Honest {
    /// The target that moves most, with its numbers on the result's own config and on the conservative one.
    pub target: String,
    pub raw: f64,
    pub honest: f64,
    /// (honest - raw) / raw.
    pub delta: f64,
    /// Labels of the switches the re-check took out.
    pub dropped: Vec<String>,
}

impl Honest {
    pub fn flagged(&self) -> bool {
        self.delta.abs() > FLAG_AT
    }

    pub fn text(&self) -> String {
        format!("Honest re-check: {} {} on the build's config, {} with only the switches it earns ({:+.0}%): without {}", self.target, short_num(self.raw), short_num(self.honest), self.delta * 100.0, self.dropped.join(", "))
    }

    pub fn json(&self) -> Value {
        json!({ "target": self.target, "raw": self.raw, "honest": self.honest, "delta": self.delta, "flagged": self.flagged(), "dropped": self.dropped, "text": self.text() })
    }
}

/// What the re-check found: nothing over FLAG_AT (with the numbers when switches were dropped), a drop over it, or no answer.
#[derive(Clone, Debug)]
pub(super) enum Check {
    Clean(Option<Honest>),
    Flagged(Honest),
    /// The conservative eval failed: the reason. Not the same as clean.
    Unknown(String),
}

impl Check {
    pub fn detail(&self) -> Option<&Honest> {
        match self {
            Check::Clean(h) => h.as_ref(),
            Check::Flagged(h) => Some(h),
            Check::Unknown(_) => None,
        }
    }

    pub fn json(&self) -> Value {
        let state = match self {
            Check::Clean(_) => "clean",
            Check::Flagged(_) => "flagged",
            Check::Unknown(_) => "unknown",
        };
        let mut v = self.detail().map_or_else(|| json!({ "flagged": false }), |h| h.json());
        v["state"] = json!(state);
        if let Check::Unknown(why) = self {
            v["reason"] = json!(why);
        }
        v
    }
}

/// The solve summary line: how many results move over 5%; None when none does.
pub(super) fn summary<'a>(all: impl Iterator<Item = &'a Honest>) -> Option<String> {
    let (n, bad) = all.fold((0, 0), |(n, b), h| (n + 1, b + h.flagged() as usize));
    (bad > 0).then(|| format!("{bad} of {n} results move more than {:.0}% when only the config the build earns is kept; each says which switches in its text", FLAG_AT * 100.0))
}

/// `pom-cli honest-measure`: a real build's text (its own config, the encounter already set) with the config it earns,
/// and its single-target DPS and credited EHP as the solver's own scorer reads them (flasks at their uptime, no cull).
/// Beyond `conservative_xml`, a source switch stays only when `config_for` turns it on for this build in this mode: the
/// Frenzy Charges its generation covers against what the main skill spends, a flask's buff only while the flask is
/// sustained, a "Full Life" effect only while mapping. The goal's targets are the DPS and EHP the finish line reads.
pub fn honest_measure(xml: String, goal_json: &str) -> Result<Value, String> {
    let goal: Goal = serde_json::from_str(goal_json).map_err(|e| format!("goal json: {e}"))?;
    if goal.assume.play_mode.is_none() {
        return Err(mode::NEED_MODE.into());
    }
    clear::load_text_rules();
    pom_engine::modparser::text_rules::set_active(true);
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(xml.clone(), goal, Options::default(), shared, Arc::new(AtomicBool::new(false)))?;
    let st = s.frozen_state(&xml)?;
    let vals = s.eval(vec![Cand::Xml(Arc::new(xml.clone()))]).pop().flatten().ok_or("the build could not be scored")?;
    let (mut text, mut dropped) = s.conservative_xml(&xml)?;
    // (config_for plus the setup's own inputs: Withered stacks, Lifetap)
    let on = inputs(&s.setup_config_with(&st, &vals));
    let sws = &config::data().sw;
    for (key, ins) in inputs(&text) {
        if s.goal.assume.config_on.contains(&key) || !sws.iter().any(|w| w.key == key && w.is_source()) {
            continue;
        }
        match on.iter().rev().find(|(k, _)| *k == key) {
            Some((_, x)) if *x == ins => {}
            Some((_, x)) => text = text.replacen(&ins, x, 1),
            None => {
                text = text.replacen(&ins, "", 1);
                dropped.push(config::short_label(&sws.iter().find(|w| w.key == key).map(|w| w.label.clone()).unwrap_or(key)));
            }
        }
    }
    let hv = s.eval(vec![Cand::Xml(Arc::new(text.clone()))]).pop().flatten().ok_or("the build scored on its earned config could not be computed")?;
    let sc = &s.scorer;
    let at = |n: &str| sc.names.iter().position(|m| m == n).and_then(|i| hv[i]);
    let t = |i: usize| sc.targets.get(i).map(|t| sc.target_value(t, &hv));
    Ok(json!({ "dps": t(0), "creditedEhp": t(1), "totalEhp": at("TotalEHP"), "flaskUptime": at("Solver.FlaskUptime2"), "dropped": dropped, "xml": text }))
}

/// `(key, whole <Input .../>)` of every config input in the text.
fn inputs(xml: &str) -> Vec<(String, String)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"<Input name="([^"]+)"[^>]*/>"#).unwrap());
    re.captures_iter(xml).map(|c| (c[1].to_string(), c[0].to_string())).collect()
}

impl Solver {
    /// The result's text with every config switch it does not earn taken out, and their labels. A defence is read on the
    /// numbers the build has with every defence switch off (block chance that exists only because "blocked recently" is
    /// on earns nothing).
    pub(super) fn conservative_xml(&self, xml: &str) -> Result<(String, Vec<String>), String> {
        let sws = &config::data().sw;
        let class_of = |key: &str| sws.iter().find(|s| s.key == key);
        let ins = inputs(xml);
        let mut bare = xml.to_string();
        for (_, text) in ins.iter().filter(|(k, _)| class_of(k).is_some_and(|s| s.is_defence())) {
            bare = bare.replacen(text, "", 1);
        }
        let vals: Vals = if bare == xml { Vec::new() } else { self.eval(vec![Cand::Xml(Arc::new(bare))]).pop().flatten().ok_or("the defence-free score could not be computed")? };
        let val = |k: &str| self.scorer.names.iter().position(|n| n == k).and_then(|i| vals.get(i).copied().flatten());
        let (mut out, mut dropped) = (xml.to_string(), Vec::new());
        for (key, text) in ins {
            // (the player's own switches stay: they asked for them)
            if self.goal.assume.config_on.contains(&key) {
                continue;
            }
            if let Some(sw) = class_of(&key).filter(|s| !s.earned(&val)) {
                out = out.replacen(&text, "", 1);
                dropped.push(config::short_label(&sw.label));
            }
        }
        Ok((out, dropped))
    }

    /// The re-check of one result (`xml`, evaluated as `vals`).
    pub(super) fn honest_check(&self, xml: &Arc<String>, vals: &Vals) -> Check {
        let (text, dropped) = match self.conservative_xml(xml) {
            Ok(r) => r,
            Err(e) => return Check::Unknown(e),
        };
        if dropped.is_empty() {
            return Check::Clean(None);
        }
        let Some(hv) = self.eval(vec![Cand::Xml(Arc::new(text))]).pop().flatten() else { return Check::Unknown("the result scored without its unearned switches could not be computed".into()) };
        let sc = &self.scorer;
        let worst = sc
            .targets
            .iter()
            .filter_map(|t| {
                let (raw, honest) = (sc.target_value(t, vals), sc.target_value(t, &hv));
                (raw.abs() > 1e-9).then(|| Honest { target: t.name.clone(), raw, honest, delta: (honest - raw) / raw.abs(), dropped: dropped.clone() })
            })
            .max_by(|a, b| a.delta.abs().partial_cmp(&b.delta.abs()).unwrap_or(std::cmp::Ordering::Equal));
        match worst {
            Some(h) if h.flagged() => Check::Flagged(h),
            h => Check::Clean(h),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solver_for(goal: &str) -> Solver {
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// Switches without a source are taken out; a player's own stay; the delta and the flag follow the numbers.
    #[test]
    fn unearned_switches_are_dropped() {
        let s = solver_for(r#"{"skill":"Cleave","assume":{"playMode":"mapping"},"targets":[{"name":"DPS","metric":"dps"}]}"#);
        // Killed Recently is a mapping-only playstyle switch; Blocked Recently needs 40% block, which these numbers lack.
        let x = r#"<Config><Input name="conditionKilledRecently" boolean="true"/><Input name="conditionBlockedRecently" boolean="true"/><Input name="enemyIsBoss" string="Pinnacle"/></Config>"#;
        let full = blank_build_xml(90).replace("</PathOfBuilding>", &format!("{x}</PathOfBuilding>"));
        let (t, dropped) = s.conservative_xml(&full).unwrap();
        assert!(!t.contains("conditionKilledRecently") && !t.contains("conditionBlockedRecently") && t.contains("enemyIsBoss"), "{t}");
        assert_eq!(dropped.len(), 2);
        let h = Honest { target: "DPS".into(), raw: 100.0, honest: 80.0, delta: -0.2, dropped };
        assert!(h.flagged() && summary([&h].into_iter()).is_some());
        assert!(!Honest { delta: -0.04, ..h }.flagged());
    }

    const SW: &str = r#"<Config><Input name="conditionKilledRecently" boolean="true"/><Input name="conditionBlockedRecently" boolean="true"/></Config>"#;

    /// Nothing to drop: clean. A drop over FLAG_AT: flagged. A forced eval failure: unknown, and conservative_xml errors
    /// instead of scoring against empty values.
    #[test]
    fn check_has_three_states_and_a_failed_eval_is_an_error() {
        let s = solver_for(r#"{"skill":"Cleave","assume":{"playMode":"mapping"},"targets":[{"name":"DPS","metric":"dps"}]}"#);
        let v = s.eval(vec![Cand::Xml(Arc::new(blank_build_xml(90)))]).pop().flatten().unwrap();
        let c = s.honest_check(&Arc::new(blank_build_xml(90)), &v);
        assert!(matches!(c, Check::Clean(None)) && c.json()["state"] == "clean", "{c:?}");
        let mut h = Honest { target: "DPS".into(), raw: 100.0, honest: 80.0, delta: -0.2, dropped: vec!["x".into()] };
        let flagged = Check::Flagged(h.clone());
        assert_eq!(flagged.json()["state"], "flagged");
        assert_eq!(flagged.json()["flagged"], true);
        h.delta = -0.04;
        assert_eq!(Check::Clean(Some(h)).json()["flagged"], false);
        s.cancel.store(true, Ordering::Relaxed);
        let err = s.conservative_xml(SW).unwrap_err();
        let u = s.honest_check(&Arc::new(SW.to_string()), &v);
        assert!(matches!(&u, Check::Unknown(r) if *r == err) && u.json()["state"] == "unknown" && u.json()["reason"] == err.as_str(), "{u:?}");
    }

    /// The in-app pconc Assassin: its card said 2.71M / 75k. Cull the Weak in the main link is
    /// a 1.36x cull multiplier no single enemy pays; Replica Rumi's (90% reduced duration) is up 2% of a fight but was
    /// mixed in at the mean uptime of every part-time flask (54%). Honest: no cull, each flask at its own uptime
    /// (the sidebar's 33.1k EHP with Rumi's off).
    #[test]
    fn single_target_scores_without_cull_and_each_flask_at_its_uptime() {
        let x = Arc::new(std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/pconc-rumi.xml")).unwrap());
        let s = solver_for(r#"{"skill":"Poisonous Concoction","level":90,"assume":{"playMode":"mapping"},"targets":[{"name":"DPS","metric":"combined"},{"name":"EHP","metric":"ehp"}]}"#);
        let v = s.eval(vec![Cand::Xml(x.clone())]).pop().flatten().unwrap();
        let at = |n: &str| s.scorer.names.iter().position(|m| m == n).and_then(|i| v[i]).unwrap();
        let (dps, ehp) = (s.scorer.target_value(&s.scorer.targets[0], &v), s.scorer.target_value(&s.scorer.targets[1], &v));
        let mut ses = crate::session::Session::new(x.to_string(), pom_calc::data::game_data());
        let first = ses.calc().unwrap();
        let combined = ses.finish().unwrap_or(first.stats)["player"]["CombinedDPS"].as_f64().unwrap();
        println!("pconc-rumi: DPS target {dps:.0} (sidebar CombinedDPS {combined:.0}) | EHP target {ehp:.0} | Rumi's uptime {:.3}", at("Solver.FlaskUptime2"));
        assert!(dps < combined / 1.3, "single target counts Cull the Weak: {dps} vs {combined}");
        assert!(ehp < 40_000.0, "Replica Rumi's counted near always on: EHP {ehp}");
    }

    /// Earlier results re-scored: raw is the sidebar (upstream's CombinedDPS and TotalEHP, what the card
    /// said), honest is the single-target goal's score now (no cull, each flask at its own fight uptime). An old result
    /// text keeps the switches its old sourcing wrote; the new sourcing leaves off the ones its own reasons fail (FS
    /// "makes 0.8 a second, spends 1.0": no charges, no bypass; Crush on a full-life hit; a rare nearby off a boss
    /// fight), so they are taken out here as it would (`flicker_charges_need_generation_over_spending`,
    /// `full_life_enemy_lines_count_while_mapping_only`, `rare_nearby_only_in_a_boss_fight`). Run with --ignored
    /// --nocapture; POM_SOLVE_RESULTS names the folder with the result files.
    #[test]
    #[ignore]
    fn honesty_table() {
        let w = std::env::var("POM_SOLVE_RESULTS").expect("POM_SOLVE_RESULTS: the folder holding out-fs, out-ed and out-pconc");
        let w = w.as_str();
        let fs_off: &[&str] = &["useFrenzyCharges", "overrideFrenzyCharges", "FlickerStrikeBypassCD", "conditionGainedFrenzyChargeRecently", "conditionEnemyCrushed"];
        let rare: &[&str] = &["multiplierNearbyRareOrUniqueEnemies"];
        let rows = [
            ("fs", "Flicker Strike", format!("{w}/out-fs/result0.xml"), fs_off),
            ("ed", "Essence Drain", format!("{w}/out-ed/result0.xml"), &[][..]),
            ("pconc", "Poisonous Concoction", format!("{w}/out-pconc/result0.xml"), rare),
            ("pconc-app", "Poisonous Concoction", concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/pconc-rumi.xml").to_string(), rare),
        ];
        for (tag, skill, path, off) in rows {
            let mut x = std::fs::read_to_string(&path).unwrap();
            let mut ses = crate::session::Session::new(x.clone(), pom_calc::data::game_data());
            let first = ses.calc().unwrap();
            let side = ses.finish().unwrap_or(first.stats);
            let (raw_dps, raw_ehp) = (side["player"]["CombinedDPS"].as_f64().unwrap_or(0.0), side["player"]["TotalEHP"].as_f64().unwrap_or(0.0));
            for (k, i) in inputs(&x.clone()) {
                // (a check goes to false, as the solver's decided_off writes it: upstream has the Flicker bypass on by default)
                if off.contains(&k.as_str()) {
                    let to = if i.contains("boolean=\"true\"") { i.replace("boolean=\"true\"", "boolean=\"false\"") } else { String::new() };
                    x = x.replacen(&i, &to, 1);
                }
            }
            let s = solver_for(&format!(r#"{{"skill":"{skill}","level":90,"assume":{{"playMode":"mapping"}},"targets":[{{"name":"DPS","metric":"combined"}},{{"name":"EHP","metric":"ehp"}}]}}"#));
            let v = s.eval(vec![Cand::Xml(Arc::new(x))]).pop().flatten().unwrap();
            let (dps, ehp) = (s.scorer.target_value(&s.scorer.targets[0], &v), s.scorer.target_value(&s.scorer.targets[1], &v));
            println!("{tag}: DPS raw {raw_dps:.0} honest {dps:.0} ({:+.0}%) | EHP raw {raw_ehp:.0} honest {ehp:.0} ({:+.0}%) | taken out {off:?}", (dps / raw_dps - 1.0) * 100.0, (ehp / raw_ehp - 1.0) * 100.0);
        }
    }
}
