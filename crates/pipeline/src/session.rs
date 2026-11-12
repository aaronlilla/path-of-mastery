//! A loaded build that is edited in place: the engine side of a tree click.
//!
//! `Session` keeps the build's XML and recomputes after each change. Everything the change doesn't touch is served
//! from per-thread caches (parsed items, socket groups, config, mod lines), so a click pays for the passive tree and
//! the calc, not for re-reading the build. Stats come back in two steps: `calc` returns every stat except the three
//! FullDPS ones (`SkillDPS`, `FullDPS`, `FullDotDPS`) as soon as the main skill is done, and `finish` adds those by
//! running the FullDPS rows. Both results equal a fresh full calc of the same XML.
use crate::{build_env, dump, run, Env};
use pom_calc::setup::BuffMode;
use pom_engine::data::GameData;

pub struct Session {
    xml: String,
    game: &'static GameData,
    /// The pre-run env of the last `calc`, kept when its FullDPS rows are still to be run by `finish`.
    pending: Option<Box<Env>>,
    /// A result computed ahead for one edit (see `preview_node`): the edited XML, its stats and its pending env.
    preview: Option<(String, Stats, Option<Box<Env>>)>,
    /// The tree's paths and dependents for the build text they were built from (see `click_node`).
    paths: Option<(String, std::rc::Rc<crate::treeclick::TreePaths>)>,
    /// The XML parsed whole once without error (see `crate::XML_CHECKED`).
    checked: bool,
    /// Envs a calculation finished with, freed by `collect` after the result is handed back (freeing one is a few
    /// percent of a click). At most `TRASH_MAX` are kept.
    trash: Vec<Box<Env>>,
    /// Output keys the defence estimations and cost warnings write for this build (see `eval_nodes`).
    optional_keys: Option<pom_engine::fxhash::HashSet<String>>,
    /// For each output key, the last calc stage (index into `RUN_STAGES`) that changed it in that same full calc.
    stage_of: pom_engine::fxhash::HashMap<String, usize>,
    /// The build's scope keys outside `<Tree>` (see `eval_nodes`).
    base_keys: Option<pom_skills::xmlskills::ScopeKeys>,
    /// The build text the learned state above (and `base_ranges`) came from.
    learned_for: Option<String>,
    /// That text's `<Tree>` element range and active node-list range.
    base_ranges: Option<(usize, usize, std::ops::Range<usize>)>,
    /// That text's parsed active spec.
    base_spec: Option<pom_passives::xmlspec::ParsedSpec>,
    /// That text's finished setup (before the calc) and its allocated-passive facts, for patched evaluations.
    base_setup: Option<std::rc::Rc<Setup>>,
    /// The same for that text with one allocated node taken away, by that node (`None`: its setup failed), so a
    /// candidate that also drops a node no patch can take away is patched from there (see `eval_patched`).
    derived: pom_engine::fxhash::HashMap<i64, Option<std::rc::Rc<Setup>>>,
    /// A mastery choice added to the candidate of the running evaluation (see `eval_nodes_with`).
    eval_mastery: Option<(i64, i64)>,
    /// The Calcs tab's last result and the build text it was computed for (see `calcs`).
    calcs_cache: Option<((String, BuffMode), std::rc::Rc<crate::calcs::CalcsOut>)>,
    /// The FullDPS result of the kept preview (see `finish_preview`), for the preview text it was computed for.
    preview_full: Option<(String, u64, serde_json::Value)>,
    /// The gem picker's base value (see `tabdata_skills::gem_power`): the build text, stat and FullDPS mode it is for.
    pub(crate) gem_base: Option<(String, u64, String, bool, f64)>,
    /// The breakdown tables of the same Calcs-mode run, for the build text they were computed for.
    breakdown_cache: Option<((String, BuffMode), serde_json::Value)>,
    /// The buff mode the Calcs tab was asked to use (`None`: the one the build saved, see `calcs_buff_mode`).
    calcs_buff_mode: Option<BuffMode>,
    /// The main skill's flags and the build text they were computed for (see `main_skill`).
    main_skill_cache: Option<(String, serde_json::Value)>,
}

/// A finished setup (before the calc), its allocated-passive facts and the node list it was built from.
type Setup = (Box<Env>, crate::TreeFacts, Vec<i64>);

/// At most this many `derived` setups are kept per build.
const DERIVED_MAX: usize = 32;

const TRASH_MAX: usize = 4;

#[derive(Clone)]
pub struct Stats {
    /// `dump`'s `{player: {...}}` stat map.
    pub stats: serde_json::Value,
    /// False when the FullDPS stats are missing and `finish` will supply them.
    pub complete: bool,
}

impl Session {
    pub fn new(xml: String, game: &'static GameData) -> Session {
        Session { xml, game, pending: None, preview: None, paths: None, checked: false, trash: Vec::new(), optional_keys: None, stage_of: Default::default(), base_keys: None, learned_for: None, base_ranges: None, base_spec: None, base_setup: None, derived: Default::default(), eval_mastery: None, calcs_cache: None, preview_full: None, gem_base: None, breakdown_cache: None, calcs_buff_mode: None, main_skill_cache: None }
    }

    pub fn xml(&self) -> &str {
        &self.xml
    }

    /// Stats for the current XML. When the build has FullDPS skills their rows are skipped here (`complete` is
    /// false); call `finish` for the full result.
    pub fn calc(&mut self) -> Result<Stats, String> {
        let (stats, pending) = self.calc_xml(&self.xml.clone())?;
        if let Some(old) = std::mem::replace(&mut self.pending, pending) {
            self.discard(old);
        }
        Ok(stats)
    }

    /// Sets the buff mode the Calcs tab calculates in: `UNBUFFED`, `BUFFED`, `COMBAT` or `EFFECTIVE` (`misc_buffMode`);
    /// `None` goes back to the mode the build saved. Only the Calcs view reads it; the main calculation is always
    /// EFFECTIVE.
    pub fn set_calcs_buff_mode(&mut self, name: Option<&str>) {
        self.calcs_buff_mode = name.map(BuffMode::from_name);
    }

    /// The buff mode the Calcs view calculates in now: the one asked for, else the one the build saved.
    pub fn calcs_mode(&self) -> BuffMode {
        self.calcs_buff_mode.unwrap_or_else(|| crate::calcs_view::saved_buff_mode(&self.xml))
    }

    /// The Calcs tab's sections for the current XML, from the live calc: the same JSON `pom_breakdown::render::render_build`
    /// returns. Runs the calc again with the main skill's finished state kept, so ask for it only when the tab is
    /// shown; a click never pays for it. The result is kept until the build changes.
    pub fn calcs(&mut self) -> Result<serde_json::Value, String> {
        Ok(self.calcs_out()?.sections.clone())
    }

    /// `{name, flags: [...], skillTypes: [...]}` of the build's main skill after the calc (the sidebar's display-stat
    /// conditions): `skillFlags` as the main calculation left them, not the Calcs tab's own skill.
    pub fn main_skill(&mut self) -> Result<serde_json::Value, String> {
        if let Some((xml, v)) = &self.main_skill_cache {
            if *xml == self.xml {
                return Ok(v.clone());
            }
        }
        crate::offence::CAPTURED.with(|c| c.borrow_mut().clear());
        let xml = self.xml.clone();
        crate::offence::CAPTURE_ARMED.with(|c| c.set(true));
        let env = self.run_xml(&xml);
        crate::offence::CAPTURE_ARMED.with(|c| c.set(false));
        let env = env?;
        let caps = crate::offence::CAPTURED.with(|c| std::mem::take(&mut *c.borrow_mut()));
        let out = crate::calcs::main_skill_of(&env, &caps).ok_or_else(|| "the build has no main skill".to_string());
        drop(caps);
        self.discard(Box::new(env));
        let out = out?;
        self.main_skill_cache = Some((xml, out.clone()));
        Ok(out)
    }

    /// The `<ExportedBuffs>` blocks upstream writes into the build file while Export Support is on: `[[name, text], ...]` in
    /// the order `PartyTab:Save` writes them, empty when the switch is off.
    pub fn exported_buffs(&mut self) -> Result<serde_json::Value, String> {
        let xml = self.xml.clone();
        if !crate::buff_export::enabled(&xml) {
            return Ok(serde_json::json!([]));
        }
        // Upstream writes `buffExports` on every main-mode calculation and the Calcs tab's own run (`CALCS`) is the last
        // one of a load, so the saved blocks come from the Calcs tab's skill selection and buff mode.
        let view = crate::calcs_view::calcs_view_xml(&xml, self.game);
        let mut tmp = Session::new(view.clone(), self.game);
        let _mode_guard = pom_calc::setup::set_buff_mode(self.calcs_mode());
        let env = tmp.run_xml(&view)?;
        let out: Vec<serde_json::Value> = env.buff_exports.as_ref().map(|e| e.blocks().into_iter().map(|(n, t)| serde_json::json!([n, t])).collect()).unwrap_or_default();
        tmp.discard(Box::new(env));
        Ok(serde_json::Value::Array(out))
    }

    /// `main_skill`'s JSON for the skill the Calcs tab calculated (its own selection, see `calcs_view`).
    pub fn calcs_main_skill(&mut self) -> Result<serde_json::Value, String> {
        Ok(self.calcs_out()?.main_skill.clone())
    }

    /// The displayed actor's finished output as the Calcs tab read it (a check against upstream's recorded output).
    pub fn calcs_output(&mut self) -> Result<std::sync::Arc<serde_json::Value>, String> {
        Ok(self.calcs_out()?.output.clone())
    }

    /// The Calcs tab as the popup-aware view needs it: the sections rendered with each cell's popup entries and each
    /// sub-section's collapse state (`collapsed` overrides the build's saved state for the sub-sections it names, keyed
    /// by section id and sub-section index), the skill controls' state, and the main skill. Reuses the Calcs-mode run.
    pub fn calcs_view(&mut self, collapsed: &std::collections::HashMap<(String, usize), bool>) -> Result<serde_json::Value, String> {
        let out = self.calcs_out()?;
        let mut build = (*out.build).clone();
        for (k, v) in collapsed {
            build.collapsed.insert(k.clone(), *v);
        }
        let sections = pom_breakdown::render::render_build_with(&build, crate::calcs::sections(), true);
        Ok(serde_json::json!({ "sections": sections, "view": out.view, "mainSkill": out.main_skill }))
    }

    /// The modifier table of one popup entry (see `calcs_popup::mod_table`), `null` when the stat has no modifiers.
    pub fn calcs_mods(&mut self, detail: &serde_json::Value) -> Result<serde_json::Value, String> {
        let out = self.calcs_out()?;
        Ok(crate::calcs_popup::mod_table(&out.build, &out.list_rows, detail).unwrap_or(serde_json::Value::Null))
    }

    /// The Calcs-mode run's result, shared: a cache hit used to copy all of it (sections, view, main skill) for a caller
    /// that reads one part.
    fn calcs_out(&mut self) -> Result<std::rc::Rc<crate::calcs::CalcsOut>, String> {
        let mode = self.calcs_mode();
        if let Some(((xml, m), out)) = &self.calcs_cache {
            if *xml == self.xml && *m == mode {
                return Ok(out.clone());
            }
        }
        crate::calcs_popup::clear_minion_skills();
        crate::offence::CAPTURED.with(|c| c.borrow_mut().clear());
        let xml = self.xml.clone();
        // The Calcs tab calculates its own skill selection (see `calcs_view`): run that build in a throwaway session so
        // the real one keeps its caches.
        let view = crate::calcs_view::calcs_view_xml(&xml, self.game);
        crate::offence::CAPTURE_ARMED.with(|c| c.set(true));
        // ONE Calcs mode: the flag the CALCS-only outputs read is the one that turns the breakdown tables on.
        pom_offence::bd::set_calcs_mode(true);
        let mut tmp = Session::new(view.clone(), self.game);
        // The Calcs tab's own buff mode (`calcs.buildOutput(build, "CALCS")`, CalcSetup.lua:565-587) for this run only.
        let _mode_guard = pom_calc::setup::set_buff_mode(mode);
        let env = tmp.run_xml(&view);
        crate::offence::CAPTURE_ARMED.with(|c| c.set(false));
        let [bd_player, bd_minion] = pom_offence::bd::take();
        let env = env?;
        let caps = crate::offence::CAPTURED.with(|c| std::mem::take(&mut *c.borrow_mut()));
        let out = crate::calcs::calcs_of(&env, &caps).ok_or_else(|| "the build has no main skill".to_string());
        drop(caps);
        tmp.discard(Box::new(env));
        let out = std::rc::Rc::new(out?);
        self.breakdown_cache = Some(((xml.clone(), mode), serde_json::json!({ "player": bd_player, "minion": bd_minion })));
        self.calcs_cache = Some(((xml, mode), out.clone()));
        Ok(out)
    }

    /// The Calcs tab's breakdown tables (`actor.breakdown` of `calcs.buildOutput(build, "CALCS")`) for the current XML:
    /// `{"player": {...}, "minion": {...} | null}`. They come from the same Calcs-mode run as `calcs`, so asking for both
    /// costs one calculation; a click never pays for either.
    pub fn breakdowns(&mut self) -> Result<serde_json::Value, String> {
        let mode = self.calcs_mode();
        if let Some(((xml, m), v)) = &self.breakdown_cache {
            if *xml == self.xml && *m == mode {
                return Ok(v.clone());
            }
        }
        self.calcs_cache = None;
        self.calcs_out()?;
        self.breakdown_cache.as_ref().map(|(_, v)| v.clone()).ok_or_else(|| "no breakdown".to_string())
    }

    /// Stats of `xml` without changing the session, plus the pre-run env `finish` needs when FullDPS was deferred.
    fn calc_xml(&mut self, xml: &str) -> Result<(Stats, Option<Box<Env>>), String> {
        let t0 = std::time::Instant::now();
        let mut env = self.run_xml(xml)?;
        let t_calc = t0.elapsed().as_secs_f64() * 1000.0;
        let deferred = env.pristine.is_some();
        let stats = dump(&env);
        // POM_SESSION_PROF=1: prints how long the calc and the stat dump of one session run took.
        if pom_engine::env::var_os("POM_SESSION_PROF").is_some() {
            eprintln!("SESSION calc={t_calc:.2} dump={:.2}", t0.elapsed().as_secs_f64() * 1000.0 - t_calc);
        }
        let pending = if deferred { env.pristine.take() } else { None };
        self.discard(Box::new(env));
        Ok((Stats { stats, complete: !deferred }, pending))
    }

    /// Setup and calc of `xml`. When the build has FullDPS rows they are skipped and the pre-run env is left in
    /// `env.pristine` for `run_full_env`.
    fn run_xml(&mut self, xml: &str) -> Result<Env, String> {
        crate::reset_build_state();
        crate::XML_CHECKED.with(|c| c.set(self.checked));
        let env = build_env(xml, self.game);
        crate::XML_CHECKED.with(|c| c.set(false));
        let mut env = env?;
        self.checked = true;
        let deferred = env.fulldps_rows;
        crate::offence_dps::SKIP_FULL_DPS.with(|c| c.set(deferred));
        run(&mut env);
        crate::offence_dps::SKIP_FULL_DPS.with(|c| c.set(false));
        Ok(env)
    }

    /// Calculates the current build and hands the finished env to `f` (what the Configuration tab reads to decide
    /// which options apply). The env is freed afterwards; the session's own results are untouched.
    pub fn inspect<T>(&mut self, f: impl FnOnce(&Env) -> T) -> Result<T, String> {
        let xml = self.xml.clone();
        let env = self.run_xml(&xml)?;
        let out = f(&env);
        self.discard(Box::new(env));
        Ok(out)
    }

    /// Calculates `xml` (not the session's own) and hands the finished env to `f`. With `full` the FullDPS rows run too
    /// (only needed when FullDPS is the stat asked for). Nothing of the session changes: this is the what-if calculation
    /// the gem picker's DPS figures use.
    pub fn eval_xml<T>(&mut self, xml: &str, full: bool, f: impl FnOnce(&Env) -> T) -> Result<T, String> {
        let mut env = self.run_xml(xml)?;
        if let Some(pristine) = env.pristine.take() {
            if full {
                self.discard(Box::new(env));
                env = *self.run_full_env(pristine);
            } else {
                self.discard(pristine);
            }
        }
        let out = f(&env);
        self.discard(Box::new(env));
        Ok(out)
    }

    /// Like `inspect`, with the main skill's finished state (`skillFlags` as the calculation left them, its skill mod
    /// list and skill data) captured: what the Configuration tab's visibility rules read from `mainEnv.player.mainSkill`.
    pub fn inspect_main<T>(&mut self, f: impl FnOnce(&Env, Option<crate::tabdata_config::MainView>) -> T) -> Result<T, String> {
        crate::offence::CAPTURED.with(|c| c.borrow_mut().clear());
        let xml = self.xml.clone();
        crate::offence::CAPTURE_ARMED.with(|c| c.set(true));
        let env = self.run_xml(&xml);
        crate::offence::CAPTURE_ARMED.with(|c| c.set(false));
        let env = env?;
        let caps = crate::offence::CAPTURED.with(|c| std::mem::take(&mut *c.borrow_mut()));
        let view = caps.iter().find(|c| !c.minion).map(|cap| crate::tabdata_config::MainView {
            flags: {
                let mut f: pom_engine::fxhash::HashSet<String> = crate::calcs::skill_flags(&env, cap).into_iter().collect();
                // CalcActiveSkill.lua:706: a main skill that summons a minion has `skillFlags.haveMinion`.
                if env.minion_mods.is_some() {
                    f.insert("haveMinion".to_string());
                }
                f
            },
            skill_mod_list: cap.skill_mod_list.clone(),
            skill_data: cap.skill_data.iter().filter(|(_, v)| v.truthy()).map(|(k, _)| k.clone()).collect(),
        });
        drop(caps);
        let out = f(&env, view);
        self.discard(Box::new(env));
        Ok(out)
    }

    /// See .  when the candidate isn't one a patch can produce.
    fn eval_patched(&mut self, nodes: &[i64], names: &[&str], skip: bool, stop: usize, xml: &str) -> Option<Vec<Option<f64>>> {
        let base = self.base_setup.clone()?;
        self.eval_patched_from(base, true, nodes, names, skip, stop, xml)
    }

    /// The build's setup, captured with its allocated-passive facts (see `eval_patched`).
    fn capture_setup(&self, xml: &str) -> Option<Setup> {
        crate::reset_build_state();
        crate::CAPTURE_TREE_FACTS.with(|c| c.set(true));
        crate::SKIP_PRISTINE.with(|c| c.set(true));
        let setup = build_env(xml, self.game);
        crate::SKIP_PRISTINE.with(|c| c.set(false));
        crate::CAPTURE_TREE_FACTS.with(|c| c.set(false));
        let facts = crate::TREE_FACTS.with(|f| f.borrow_mut().take());
        match (setup, facts, nodes_in_xml(xml)) {
            (Ok(env), Some(facts), Ok(nodes)) => Some((Box::new(env), facts, nodes)),
            _ => None,
        }
    }

    /// The learned build with its active node list replaced by `nodes`, and that list's text.
    fn candidate_xml(&self, nodes: &[i64]) -> Result<(String, String), String> {
        let (_, _, list) = self.base_ranges.clone().ok_or("no <Tree>")?;
        let ids: Vec<String> = nodes.iter().map(|n| n.to_string()).collect();
        let joined = ids.join(",");
        Ok((format!("{}{}{}", &self.xml[..list.start], joined, &self.xml[list.end..]), joined))
    }

    /// Hints for a `candidate_xml` text, which differs from the learned build only in the node list.
    fn set_hints(&self, xml: &str, joined: &str) {
        // A candidate with an extra mastery choice changes more than the node list, so it is parsed whole.
        if self.eval_mastery.is_some() {
            return;
        }
        let Some((tree_start, tree_end, list)) = self.base_ranges.clone() else { return };
        let new_tree_end = tree_end + joined.len() - (list.end - list.start);
        // The build's keys for everything outside `<Tree>` are reused instead of hashing and searching the text again.
        if let Some(k) = &self.base_keys {
            pom_skills::xmlskills::scope_hint(k.clone());
        }
        pom_passives::xmlspec::set_tree_hint(xml, tree_start, new_tree_end);
        // The candidate's spec is the build's with its node list replaced (parsed the same way).
        if let Some(base) = &self.base_spec {
            let mut spec = base.clone();
            spec.hash_list = Some(pom_passives::xmlspec::parse_hash_list(joined));

            pom_passives::xmlspec::set_spec_hint(xml, spec);
        }
        pom_skills::xmlskills::set_tree_hint(xml, tree_start, new_tree_end);
    }

    /// The setup of the learned build with `x` taken away from `base_nodes`, built once.
    fn derived_setup(&mut self, x: i64, base_nodes: &[i64]) -> Option<std::rc::Rc<Setup>> {
        if let Some(d) = self.derived.get(&x) {
            return d.clone();
        }
        if self.derived.len() >= DERIVED_MAX {
            return None;
        }
        let nodes: Vec<i64> = base_nodes.iter().copied().filter(|&n| n != x).collect();
        let (xml, joined) = self.candidate_xml(&nodes).ok()?;
        self.set_hints(&xml, &joined);
        let d = self.capture_setup(&xml).map(std::rc::Rc::new);
        self.derived.insert(x, d.clone());
        d
    }

    /// `eval_patched` from setup `bs`; with `derive`, a candidate that also drops one node no patch can take away
    /// is patched from the setup without that node instead.
    #[allow(clippy::too_many_arguments)]
    fn eval_patched_from(&mut self, bs: std::rc::Rc<Setup>, derive: bool, nodes: &[i64], names: &[&str], skip: bool, stop: usize, xml: &str) -> Option<Vec<Option<f64>>> {
        let (base_env, facts, base_nodes) = &*bs;
        let cand: pom_engine::fxhash::HashSet<i64> = nodes.iter().copied().collect();
        let base: pom_engine::fxhash::HashSet<i64> = base_nodes.iter().copied().collect();
        if cand.iter().any(|n| !base.contains(n)) {
            return None;
        }
        let mut removed: Vec<i64> = base_nodes.iter().copied().filter(|n| !cand.contains(n)).collect();
        // A removed cluster socket takes its subgraph with it.
        for i in 0..removed.len() {
            if let Some(sub) = facts.cluster.get(&removed[i]) {
                for &s in sub {
                    if !removed.contains(&s) {
                        removed.push(s);
                    }
                }
            }
        }
        let mut notables = 0usize;
        let mut hard: Vec<i64> = Vec::new();
        for id in &removed {
            let Some(&(simple, notable)) = facts.simple.get(id) else {
                return None;
            };
            if !simple {
                hard.push(*id);
            }
            notables += notable as usize;
        }
        if !hard.is_empty() {
            if !derive || hard.len() != 1 || removed.len() < 2 {
                return None;
            }
            let d = self.derived_setup(hard[0], base_nodes)?;
            return self.eval_patched_from(d, false, nodes, names, skip, stop, xml);
        }
        // Nothing else is cut off when each connected group of removed nodes hangs off the kept ones by one link.
        let mut seen: Vec<i64> = Vec::new();
        for &start in &removed {
            if seen.contains(&start) {
                continue;
            }
            let (mut stack, mut links) = (vec![start], 0usize);
            seen.push(start);
            while let Some(n) = stack.pop() {
                for &l in facts.neighbours.get(&n).map_or(&[][..], |v| v.as_slice()) {
                    if !removed.contains(&l) {
                        links += 1;
                    } else if !seen.contains(&l) {
                        seen.push(l);
                        stack.push(l);
                    }
                }
            }
            if links != 1 {
                return None;
            }
        }
        // The allocated-count mods (`pom_calc::setup::allocated_count_mods`) for the candidate's counts.
        let (base_notable, keystone, base_mastery) = facts.counts;
        let removed_masteries: Vec<&String> = removed.iter().filter_map(|id| facts.mastery_type.get(id)).collect();
        let mut types: pom_engine::fxhash::HashMap<&str, usize> = Default::default();
        for t in facts.mastery_type.values() {
            *types.entry(t.as_str()).or_insert(0) += 1;
        }
        for t in &removed_masteries {
            *types.get_mut(t.as_str())? -= 1;
        }
        types.retain(|_, n| *n > 0);
        let life = types.get("Life Mastery").copied().unwrap_or(0);
        let removed_keystones: Vec<i64> = removed.iter().copied().filter(|id| facts.keystone.contains_key(id)).collect();
        let counts = pom_calc::setup::allocated_count_mods(base_notable.checked_sub(notables)?, keystone.checked_sub(removed_keystones.len())?, base_mastery.checked_sub(removed_masteries.len())?, types.len(), life);
        let count_names = ["Multiplier:AllocatedNotable", "Multiplier:AllocatedKeystone", "Multiplier:AllocatedMastery", "Multiplier:AllocatedMasteryType", "Multiplier:AllocatedLifeMastery"];
        let is_count = |m: &pom_engine::modifier::Mod| m.source.is_none() && count_names.contains(&m.name.as_str());
        let mut env = (**base_env).clone();
        // `keystone_mods`: one entry per distinct allocated keystone name, in id order; `keystones_added`: the names.
        if !removed_keystones.is_empty() {
            let mut ids: Vec<i64> = facts.keystone.keys().copied().collect();
            ids.sort_unstable();
            let mut names: Vec<&str> = Vec::new();
            for id in &ids {
                let n = facts.keystone[id].as_str();
                if !names.contains(&n) {
                    names.push(n);
                }
            }
            if names.len() != env.keystone_mods.len() {
                return None;
            }
            let kept: Vec<&str> = ids.iter().filter(|id| !removed_keystones.contains(id)).map(|id| facts.keystone[id].as_str()).collect();
            let mut i = 0;
            env.keystone_mods.retain(|_| {
                let keep = kept.contains(&names[i]);
                i += 1;
                keep
            });
            for id in &removed_keystones {
                let n = facts.keystone[id].as_str();
                if !kept.contains(&n) {
                    env.keystones_added.remove(n);
                }
            }
        }
        let sources: Vec<String> = removed.iter().map(|id| format!("Tree:{id}")).collect();
        // A removed socket's plain jewel: its block of mods (merged as one run, unscaled; sources aren't unique
        // per item, so the run itself is found, and it must occur once), item counts and item-actor slot come out.
        for id in &removed {
            let Some(item_id) = facts.jewel.get(id) else { continue };
            let item = env.items.get(item_id)?.clone();
            let slot = format!("Jewel {id}");
            let block = crate::item_mods_for_slot(&item, &slot);
            if !block.is_empty() {
                let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing else { return None };
                let k = block.len();
                let hits: Vec<usize> = (0..v.len().saturating_sub(k - 1)).filter(|&i| v[i..i + k] == *block).collect();
                if hits.len() != 1 {
                    return None;
                }
                std::sync::Arc::make_mut(v).drain(hits[0]..hits[0] + k);
            }
            let mut delta = pom_engine::modstore::store::ModStore::new_list(None, None);
            crate::item_setup_multipliers(&mut delta, env.game, &slot, &item);
            for (k, v) in delta.multipliers.iter() {
                let e = env.player.multipliers.get_mut(k)?;
                *e -= v;
                if *e == 0.0 {
                    env.player.multipliers.remove(k);
                }
            }
            for k in delta.conditions.keys() {
                env.player.conditions.remove(k);
            }
            env.item_actor_info.0.remove(slot.as_str());
            let lower = slot.to_lowercase();
            for per_slot in env.item_actor_info.1.values_mut() {
                per_slot.remove(lower.as_str());
            }
        }
        if let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing {
            // The build's count block is contiguous; the candidate's takes its place.
            let at: Vec<usize> = v.iter().enumerate().filter(|(_, m)| is_count(m)).map(|(i, _)| i).collect();
            if at.windows(2).any(|w| w[1] != w[0] + 1) || (at.is_empty() && !counts.is_empty()) {
                return None;
            }
            let list = std::sync::Arc::make_mut(v);
            if let Some(&first) = at.first() {
                let tail: Vec<pom_engine::modifier::Mod> = list.drain(first..).collect();
                list.extend(counts);
                list.extend(tail.into_iter().skip(at.len()));
            }
            pom_engine::modstore::store::retain_mods(v, |m| !m.source.as_deref().is_some_and(|s| sources.iter().any(|x| x == s)));
        } else {
            return None;
        }
        env.xml_text = xml.to_string();
        crate::reset_build_state();
        crate::SKIP_OPTIONAL.with(|c| c.set(skip));
        crate::STOP_AFTER.with(|c| c.set((stop < crate::RUN_STAGES.len()).then_some(stop)));
        crate::offence_dps::SKIP_FULL_DPS.with(|c| c.set(env.fulldps_rows));
        run(&mut env);
        crate::offence_dps::SKIP_FULL_DPS.with(|c| c.set(false));
        crate::SKIP_OPTIONAL.with(|c| c.set(false));
        crate::STOP_AFTER.with(|c| c.set(None));
        let out: Vec<Option<f64>> = names.iter().map(|n| crate::stat_value(&env, n)).collect();
        // POM_CHECK_PATCH=1: also runs the full calc and reports when the patched result differs from it.
        if pom_engine::env::var_os("POM_CHECK_PATCH").is_some() {
            crate::SKIP_OPTIONAL.with(|c| c.set(skip));
            crate::STOP_AFTER.with(|c| c.set((stop < crate::RUN_STAGES.len()).then_some(stop)));
            crate::SKIP_PRISTINE.with(|c| c.set(true));
            let full = self.run_xml(xml);
            crate::SKIP_PRISTINE.with(|c| c.set(false));
            crate::SKIP_OPTIONAL.with(|c| c.set(false));
            crate::STOP_AFTER.with(|c| c.set(None));
            if let Ok(full) = full {
                let (a, b) = (crate::dump(&env), crate::dump(&full));
                if a != b {
                    let (pa, pb) = (&a["player"], &b["player"]);
                    let keys: Vec<String> = pb.as_object().map(|o| o.keys().filter(|k| pa.get(*k) != pb.get(*k)).take(4).cloned().collect()).unwrap_or_default();
                    eprintln!("PATCH DIFF {} removed={removed:?} keys={keys:?}", pom_engine::env::var("POM_BUILD_NAME").unwrap_or_default());
                }
                self.discard(Box::new(full));
            }
        }
        self.discard(Box::new(env));
        Some(out)
    }

    fn discard(&mut self, env: Box<Env>) {
        if self.trash.len() >= TRASH_MAX {
            self.trash.remove(0);
        }
        self.trash.push(env);
    }

    /// Frees what the last calculations left behind. Call it after handing a result back, off the latency path.
    pub fn collect(&mut self) {
        self.trash.clear();
    }

    /// The complete stats of the last `calc`, including FullDPS, or `None` when `calc` was already complete.
    pub fn finish(&mut self) -> Option<serde_json::Value> {
        let pristine = self.pending.take()?;
        Some(self.run_full(pristine))
    }

    /// The complete stats of a pending env (its FullDPS rows included).
    fn run_full(&mut self, pristine: Box<Env>) -> serde_json::Value {
        let env = self.run_full_env(pristine);
        let out = dump(&env);
        self.discard(env);
        out
    }

    /// A pending env run with its FullDPS rows.
    fn run_full_env(&mut self, pristine: Box<Env>) -> Box<Env> {
        crate::reset_build_state();
        let mut env = (*pristine).clone();
        env.pristine = Some(pristine);
        run(&mut env);
        Box::new(env)
    }

    /// Allocates the node if the active spec doesn't list it, otherwise removes it, then recalculates.
    pub fn toggle_node(&mut self, node_id: i64) -> Result<Stats, String> {
        let xml = toggle_in_xml(&self.xml, node_id)?;
        if let Some((pxml, stats, pending)) = self.preview.take() {
            if pxml == xml {
                // Already computed while the node was hovered: the same XML through the same calc.
                self.xml = xml;
                if let Some(old) = std::mem::replace(&mut self.pending, pending) {
                    self.discard(old);
                }
                return Ok(stats);
            }
        }
        self.xml = xml;
        self.calc()
    }

    /// Allocated nodes that are plain (a patch can take them away): known once `eval_nodes` has run on the current text.
    pub fn simple_nodes(&self) -> pom_engine::fxhash::HashSet<i64> {
        self.base_setup.as_ref().map(|b| b.1.simple.iter().filter(|(_, v)| v.0).map(|(k, _)| *k).collect()).unwrap_or_default()
    }

    /// Nodes items grant, known once `eval_nodes` has run on the current text.
    pub fn granted_nodes(&self) -> Vec<i64> {
        self.base_setup.as_ref().map(|b| b.1.granted.clone()).unwrap_or_default()
    }

    /// Gives a build saved with only a tree URL its node list (same stats; see `treeclick::with_node_list`).
    pub fn ensure_node_list(&mut self) -> Result<(), String> {
        if nodes_range(&self.xml).is_ok() {
            return Ok(());
        }
        let paths = self.tree_paths()?;
        self.xml = crate::treeclick::with_node_list(&self.xml, &paths)?;
        self.paths = None;
        self.preview = None;
        Ok(())
    }

    /// The tree's paths for any build text (not kept).
    pub fn paths_for_xml(&self, xml: &str) -> Result<std::rc::Rc<crate::treeclick::TreePaths>, String> {
        crate::treeclick::tree_paths(xml, self.game).map(std::rc::Rc::new)
    }

    /// The tree's paths for the current build text, built once per text.
    pub fn paths(&mut self) -> Result<std::rc::Rc<crate::treeclick::TreePaths>, String> {
        self.tree_paths()
    }

    /// The tree's paths for the current build text, built once per text.
    fn tree_paths(&mut self) -> Result<std::rc::Rc<crate::treeclick::TreePaths>, String> {
        if let Some((x, p)) = &self.paths {
            if *x == self.xml {
                return Ok(p.clone());
            }
        }
        let p = std::rc::Rc::new(crate::treeclick::tree_paths(&self.xml, self.game)?);
        self.paths = Some((self.xml.clone(), p.clone()));
        Ok(p)
    }

    /// The build's tree for the tree view (see `crate::treeclick::tree_state`), built once per build text.
    pub fn tree_state(&mut self) -> Result<serde_json::Value, String> {
        Ok(self.tree_paths()?.state.clone())
    }

    /// Builds what the next click needs (the tree's paths for the current text). Call it after a reply, off the
    /// latency path, like `collect`.
    pub fn prepare(&mut self) -> Result<(), String> {
        self.tree_paths().map(|_| ())
    }

    /// The build text a click on `node_id` gives (the original tree view's left click), or what stops it.
    pub fn click_xml(&mut self, node_id: i64) -> Result<Result<String, crate::treeclick::Click>, String> {
        let paths = self.tree_paths()?;
        // A build saved with only a tree URL gets its node list first (same stats; see `with_node_list`).
        let base = crate::treeclick::with_node_list(&self.xml, &paths)?;
        match crate::treeclick::click(&paths, &nodes_in_xml(&base)?, node_id) {
            crate::treeclick::Click::Nodes(nodes) => Ok(Ok(set_nodes_in_xml(&base, &nodes)?)),
            other => Ok(Err(other)),
        }
    }

    /// A left click on a passive node: allocates its path, or removes it and the nodes that depend on it, then
    /// recalculates. `Err(click)` when the click needs a choice first (a mastery effect, another ascendancy) or
    /// does nothing.
    pub fn click_node(&mut self, node_id: i64) -> Result<Result<Stats, crate::treeclick::Click>, String> {
        match self.click_xml(node_id)? {
            Ok(xml) => Ok(Ok(self.apply_xml(xml)?)),
            Err(c) => Ok(Err(c)),
        }
    }

    /// The stats `click_node` would give, without changing the build (the hover tooltip); kept for the click.
    pub fn preview_click(&mut self, node_id: i64) -> Result<Result<Stats, crate::treeclick::Click>, String> {
        match self.click_xml(node_id)? {
            Ok(xml) => Ok(Ok(self.preview_xml(xml)?)),
            Err(c) => Ok(Err(c)),
        }
    }

    /// Makes `xml` the build text and recalculates, reusing a preview of the same text.
    pub fn apply_xml(&mut self, xml: String) -> Result<Stats, String> {
        if let Some((pxml, stats, pending)) = self.preview.take() {
            if pxml == xml {
                self.xml = xml;
                if let Some(old) = std::mem::replace(&mut self.pending, pending) {
                    self.discard(old);
                }
                return Ok(stats);
            }
        }
        self.xml = xml;
        self.calc()
    }

    /// The stats of `xml` without changing the build; kept so `apply_xml` of the same text is immediate.
    pub fn preview_xml(&mut self, xml: String) -> Result<Stats, String> {
        if let Some((pxml, stats, _)) = &self.preview {
            if *pxml == xml {
                return Ok(stats.clone());
            }
        }
        let (stats, pending) = self.calc_xml(&xml)?;
        self.preview = Some((xml, stats.clone(), pending));
        Ok(stats)
    }

    /// The stats an edit would give, without changing the build (what-if tooltips).
    pub fn preview_edit(&mut self, f: impl FnOnce(&str) -> Result<String, String>) -> Result<Stats, String> {
        let xml = f(&self.xml)?;
        self.preview_xml(xml)
    }

    /// Applies an edit to the XML (see `crate::edit`) and recalculates, like `toggle_node`.
    pub fn edit(&mut self, f: impl FnOnce(&str) -> Result<String, String>) -> Result<Stats, String> {
        let xml = f(&self.xml)?;
        self.preview = None;
        self.optional_keys = None;
        self.base_keys = None;
        self.xml = xml;
        self.calc()
    }

    /// Equips `item_text` in `slot` as a new item, or empties the slot when `None` (protocol `setItem`).
    pub fn set_item(&mut self, slot: &str, item_text: Option<&str>) -> Result<Stats, String> {
        self.edit(|x| crate::edit::set_item(x, slot, item_text))
    }

    /// Equips the build's existing item `item_id` (0 = nothing) in `slot`.
    pub fn set_slot_item(&mut self, slot: &str, item_id: i64) -> Result<Stats, String> {
        self.edit(|x| crate::edit::set_slot_item(x, slot, item_id))
    }

    /// Sets a config input of the active config set, or removes it when `None` (protocol `setConfig`).
    pub fn set_config(&mut self, key: &str, value: Option<crate::edit::ConfigValue>) -> Result<Stats, String> {
        self.edit(|x| crate::edit::set_config_input(x, key, value.as_ref()))
    }

    /// Sets an attribute (`level`, `quality`, `enabled`, ...) of gem `gem` in socket group `group` (both 1-based).
    pub fn set_gem(&mut self, group: usize, gem: usize, attr: &str, value: Option<&str>) -> Result<Stats, String> {
        self.edit(|x| crate::edit::set_gem_attr(x, group, gem, attr, value))
    }

    /// Sets an attribute (e.g. `enabled`) of socket group `group` (1-based).
    pub fn set_group(&mut self, group: usize, attr: &str, value: Option<&str>) -> Result<Stats, String> {
        self.edit(|x| crate::edit::set_group_attr(x, group, attr, value))
    }

    /// Runs `f` on the env of the current build text (a fresh calculation): what a tooltip reads from the player's
    /// modifiers and output, like the effective flask stats.
    pub fn with_env<R>(&mut self, f: impl FnOnce(&Env) -> R) -> Result<R, String> {
        let xml = self.xml.clone();
        let env = self.run_xml(&xml)?;
        let out = f(&env);
        self.discard(Box::new(env));
        Ok(out)
    }

    /// The stats `names` of `xml` without changing the session or its kept preview (item and modifier ranking).
    /// With `full` the FullDPS rows run too, so FullDPS, SkillDPS and FullDotDPS are the ones a fresh load gives.
    pub fn eval_xml_stats(&mut self, xml: &str, names: &[&str], full: bool) -> Result<Vec<Option<f64>>, String> {
        let (stats, pending) = self.calc_xml(xml)?;
        let value = match pending {
            Some(p) if full => self.run_full(p),
            Some(p) => {
                self.discard(p);
                stats.stats
            }
            None => stats.stats,
        };
        let player = value.get("player");
        Ok(names.iter().map(|n| player.and_then(|p| p.get(*n)).and_then(|v| v.as_f64())).collect())
    }

    /// The stats `names` of this build with its active spec's node list replaced by `nodes`, without changing the
    /// session: one candidate tree of an optimizer. Each value equals that stat in a fresh full calc of the edited XML
    /// (`None` when the build has no such stat). The FullDPS rows run only when a FullDPS stat is asked for.
    pub fn eval_nodes(&mut self, nodes: &[i64], names: &[&str]) -> Result<Vec<Option<f64>>, String> {
        self.eval_nodes_with(nodes, names, &[], None)
    }

    /// `eval_nodes` where the nodes in `pin` stay allocated although nothing connects them, and `mastery` is an
    /// extra mastery choice (node, effect): upstream's `addNodes` of a node power calculation.
    pub fn eval_nodes_with(&mut self, nodes: &[i64], names: &[&str], pin: &[i64], mastery: Option<(i64, i64)>) -> Result<Vec<Option<f64>>, String> {
        self.eval_mastery = mastery;
        let r = self.eval_nodes_inner(nodes, names, pin);
        pom_passives::spec::PIN_ALLOC.with(|p| p.borrow_mut().clear());
        self.eval_mastery = None;
        r
    }

    fn eval_nodes_inner(&mut self, nodes: &[i64], names: &[&str], pin: &[i64]) -> Result<Vec<Option<f64>>, String> {
        // Everything learned below belongs to the build text it was learned from.
        if self.learned_for.as_deref() != Some(self.xml.as_str()) {
            self.optional_keys = None;
            self.base_keys = None;
            self.stage_of = Default::default();
            let tree = pom_passives::xmlspec::tree_element(&self.xml).ok_or("missing <Tree>")?;
            let tree_start = tree.as_ptr() as usize - self.xml.as_ptr() as usize;
            self.base_ranges = Some((tree_start, tree_start + tree.len(), nodes_range(&self.xml)?));
            self.base_spec = pom_passives::xmlspec::parse_active_spec(&self.xml).ok();
            self.derived.clear();
            // The build's setup, kept for evaluations that only take ordinary nodes away (see below).
            self.base_setup = self.capture_setup(&self.xml.clone()).map(std::rc::Rc::new);
            self.learned_for = Some(self.xml.clone());
        }
        // The candidate is the build with only the active spec's node list replaced, so its `<Tree>` is where the
        // build's is (shifted by the list's change in length).
        let (mut xml, joined) = self.candidate_xml(nodes)?;
        if let Some((n, e)) = self.eval_mastery {
            let mut m: Vec<(i64, i64)> = self.base_spec.as_ref().map(|b| b.mastery_effects.clone()).unwrap_or_default();
            m.retain(|(x, _)| *x != n);
            m.push((n, e));
            xml = crate::treeedit::with_mastery_attr(&xml, &m)?;
        }
        let needs_full = names.iter().any(|n| matches!(*n, "SkillDPS" | "FullDPS" | "FullDotDPS"));
        // The estimations and cost warnings are skipped when none of `names` is among the stats they write
        // (learned once from a full calc of this build). POM_CHECK_REDUCED=1 also runs the full calc and reports
        // any requested stat that differs.
        // The calc also ends after the last stage that changed any requested stat in that full calc (a key changed
        // after every stage, or never seen, runs the calc to the end).
        if self.optional_keys.is_none() {
            crate::OPTIONAL_KEYS.with(|k| *k.borrow_mut() = Some(Default::default()));
            crate::LEARN_STAGES.with(|l| *l.borrow_mut() = Some(Default::default()));
            crate::SKIP_PRISTINE.with(|c| c.set(true));
            // (on a copy of the setup captured above when there is one, as a patched evaluation that removes nothing)
            let r = match self.base_setup.clone() {
                Some(bs) => {
                    let mut env = (*bs.0).clone();
                    crate::reset_build_state();
                    crate::offence_dps::SKIP_FULL_DPS.with(|c| c.set(env.fulldps_rows));
                    run(&mut env);
                    crate::offence_dps::SKIP_FULL_DPS.with(|c| c.set(false));
                    Ok(env)
                }
                None => self.run_xml(&self.xml.clone()),
            };
            crate::SKIP_PRISTINE.with(|c| c.set(false));
            let keys = crate::OPTIONAL_KEYS.with(|k| k.borrow_mut().take()).unwrap_or_default();
            let (_, mut last) = crate::LEARN_STAGES.with(|l| l.borrow_mut().take()).unwrap_or_default();
            if let Ok(mut e) = r {
                if let Some(p) = e.pristine.take() {
                    self.discard(p);
                }
                // Keys the calc changed after the last stage end run to the end.
                let learned: Vec<String> = last.keys().cloned().collect();
                for k in e.output.keys() {
                    if !learned.contains(k) {
                        last.insert(k.clone(), crate::RUN_STAGES.len());
                    }
                }
                self.discard(Box::new(e));
            }
            self.optional_keys = Some(keys);
            self.stage_of = last;
            self.base_keys = pom_skills::xmlskills::last_scope_keys();
        }
        self.set_hints(&xml, &joined);
        let skip = !needs_full && !names.iter().any(|n| self.optional_keys.as_ref().is_some_and(|k| k.contains(*n)));
        let stop = if needs_full { crate::RUN_STAGES.len() } else { names.iter().map(|n| self.stage_of.get(*n).copied().unwrap_or(crate::RUN_STAGES.len())).max().unwrap_or(0) };
        // Patched evaluation: when the candidate only drops ordinary allocated nodes, none next to another dropped
        // node and each with a single allocated neighbour (so nothing else is cut off), the fresh setup would equal
        // the build's with those nodes' mods left out of the player store and the notable count lowered. The calc
        // then runs on a copy of the build's setup. POM_CHECK_PATCH=1 also runs the full path and compares every
        // stat.
        if !needs_full {
            if let Some(stats) = self.eval_patched(nodes, names, skip, stop, &xml) {
                pom_passives::xmlspec::clear_tree_hint();
                pom_skills::xmlskills::clear_tree_hint();
                return Ok(stats);
            }
            // (a derived setup may have used the hints)
            self.set_hints(&xml, &joined);
        }
        crate::SKIP_OPTIONAL.with(|c| c.set(skip));
        crate::SKIP_PRISTINE.with(|c| c.set(!needs_full));
        crate::STOP_AFTER.with(|c| c.set((stop < crate::RUN_STAGES.len()).then_some(stop)));
        pom_passives::spec::PIN_ALLOC.with(|p| *p.borrow_mut() = pin.to_vec());
        let env = self.run_xml(&xml);
        pom_passives::spec::PIN_ALLOC.with(|p| p.borrow_mut().clear());
        crate::SKIP_OPTIONAL.with(|c| c.set(false));
        crate::SKIP_PRISTINE.with(|c| c.set(false));
        crate::STOP_AFTER.with(|c| c.set(None));
        let clear_hints = || {
            pom_passives::xmlspec::clear_tree_hint();
            pom_skills::xmlskills::clear_tree_hint();
        };
        let mut env = match env {
            Ok(e) => e,
            Err(e) => {
                clear_hints();
                return Err(e);
            }
        };
        // POM_CHECK_REDUCED=1: also runs the full calc and reports a requested stat the reduced run got differently.
        if (skip || stop < crate::RUN_STAGES.len()) && pom_engine::env::var_os("POM_CHECK_REDUCED").is_some() {
            let full = self.run_xml(&xml);
            let Ok(mut full) = full else {
                clear_hints();
                return Err(full.err().unwrap_or_default());
            };
            if let Some(p) = full.pristine.take() {
                self.discard(p);
            }
            for n in names {
                let (a, b) = (crate::stat_value(&env, n), crate::stat_value(&full, n));
                if a.map(f64::to_bits) != b.map(f64::to_bits) {
                    eprintln!("REDUCED DIFF {} {n}: {a:?} vs full {b:?}", pom_engine::env::var("POM_BUILD_NAME").unwrap_or_default());
                }
            }
            self.discard(Box::new(full));
        }
        clear_hints();
        if let Some(pristine) = env.pristine.take() {
            if needs_full {
                self.discard(Box::new(env));
                env = *self.run_full_env(pristine);
            } else {
                self.discard(pristine);
            }
        }
        let out = names.iter().map(|n| crate::stat_value(&env, n)).collect();
        self.discard(Box::new(env));
        Ok(out)
    }

    /// Stats with `nodes` counted as allocated for the calc only (CalcSetup's `override.addNodes`: a node's mods apply
    /// whether or not a path reaches it), without changing the build. Kept as the preview for `finish_preview`.
    pub fn preview_add_nodes(&mut self, nodes: &[i64], xml: Option<&str>) -> Result<Stats, String> {
        crate::EXTRA_NODES.with(|e| *e.borrow_mut() = nodes.to_vec());
        let xml = xml.map(|x| x.to_string()).unwrap_or_else(|| self.xml.clone());
        let r = self.calc_xml(&xml);
        crate::EXTRA_NODES.with(|e| e.borrow_mut().clear());
        let (stats, pending) = r?;
        self.preview = Some((format!("addNodes:{nodes:?}:{xml}"), stats.clone(), pending));
        Ok(stats)
    }

    /// Stats with `nodes` taken out of the allocated set for the calc only (CalcSetup's `override.removeNodes`, which the
    /// tree's hover tooltip uses for "Unallocating this node"): only those nodes stop counting, the spec keeps its
    /// conquered nodes, cluster nodes and radius jewel effects. The build is not changed.
    pub fn preview_remove_nodes(&mut self, nodes: &[i64]) -> Result<Stats, String> {
        crate::REMOVE_NODES.with(|e| *e.borrow_mut() = nodes.to_vec());
        let xml = self.xml.clone();
        let r = self.calc_xml(&xml);
        crate::REMOVE_NODES.with(|e| e.borrow_mut().clear());
        let (stats, pending) = r?;
        self.preview = Some((format!("removeNodes:{nodes:?}:{xml}"), stats.clone(), pending));
        Ok(stats)
    }

    /// The complete stats of the last preview (its FullDPS rows included), or `None` when it was already complete.
    pub fn finish_preview(&mut self) -> Option<serde_json::Value> {
        let (pxml, _, pending) = self.preview.as_ref()?;
        let pristine = pending.as_ref()?.clone();
        // The same preview asked again (a tooltip shown twice): its FullDPS result is kept, not calculated again.
        let rev = crate::data_rev();
        if let Some((x, r, v)) = &self.preview_full {
            if x == pxml && *r == rev {
                return Some(v.clone());
            }
        }
        let pxml = pxml.clone();
        let v = self.run_full(pristine);
        self.preview_full = Some((pxml, rev, v.clone()));
        Some(v)
    }

    /// Stats the build would have after `toggle_node(node_id)`, without changing it (the tree's hover tooltip).
    /// The result is kept, so clicking that node next returns it without recalculating.
    pub fn preview_node(&mut self, node_id: i64) -> Result<Stats, String> {
        let xml = toggle_in_xml(&self.xml, node_id)?;
        if let Some((pxml, stats, _)) = &self.preview {
            if *pxml == xml {
                return Ok(stats.clone());
            }
        }
        let (stats, pending) = self.calc_xml(&xml)?;
        self.preview = Some((xml, stats.clone(), pending));
        Ok(stats)
    }
}

impl Session {
    /// The allocated nodes of the active spec with exactly one allocated neighbour on the tree: the nodes a tree
    /// optimizer can drop without disconnecting anything (an optimizer only proposes connected trees).
    pub fn leaf_nodes(&self) -> Result<Vec<i64>, String> {
        let spec = pom_passives::xmlspec::parse_active_spec(&self.xml)?;
        let tree = crate::cached_tree(spec.tree_version.as_deref().unwrap_or("3_29"))?;
        let nodes = nodes_in_xml(&self.xml)?;
        let alloc: std::collections::HashSet<i64> = nodes.iter().copied().collect();
        let mut out = Vec::new();
        for &id in &nodes {
            let Some(n) = tree.node(id) else { continue };
            let kind = n.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if kind == "ClassStart" || kind == "AscendClassStart" {
                continue;
            }
            let linked = n.get("linkedId").and_then(|l| l.as_array()).map(|a| a.iter().filter_map(|x| x.as_i64()).filter(|l| alloc.contains(l)).count()).unwrap_or(0);
            if linked == 1 {
                out.push(id);
            }
        }
        Ok(out)
    }
}

/// Replaces the active `<Spec nodes="...">` list with `nodes`, leaving every other byte of the XML as is.
pub fn set_nodes_in_xml(xml: &str, nodes: &[i64]) -> Result<String, String> {
    let range = nodes_range(xml)?;
    let list: Vec<String> = nodes.iter().map(|n| n.to_string()).collect();
    Ok(format!("{}{}{}", &xml[..range.start], list.join(","), &xml[range.end..]))
}

/// The active spec's node list, in the order the XML lists it.
pub fn nodes_in_xml(xml: &str) -> Result<Vec<i64>, String> {
    Ok(xml[nodes_range(xml)?].split(',').filter_map(|s| s.parse().ok()).collect())
}

/// Byte range of the active `<Spec>`'s `nodes` attribute value.
fn nodes_range(xml: &str) -> Result<std::ops::Range<usize>, String> {
    let tree_text = pom_passives::xmlspec::tree_element(xml).ok_or("missing <Tree>")?;
    let base = tree_text.as_ptr() as usize - xml.as_ptr() as usize;
    let doc = roxmltree::Document::parse(tree_text).map_err(|e| format!("xml: {e}"))?;
    let tree = doc.root_element();
    let active = tree.attribute("activeSpec").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1);
    let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
    let spec = specs.get(active - 1).or_else(|| specs.first()).ok_or("missing <Spec>")?;
    let r = spec.attribute_node("nodes").ok_or("<Spec> has no nodes list")?.range_value();
    Ok((base + r.start)..(base + r.end))
}

/// Adds or removes `node_id` in the active `<Spec nodes="...">` list, leaving every other byte of the XML as is.
pub fn toggle_in_xml(xml: &str, node_id: i64) -> Result<String, String> {
    // Only the <Tree> element is parsed (a build's XML can be large); `base` maps its offsets back into `xml`.
    let tree_text = pom_passives::xmlspec::tree_element(xml).ok_or("missing <Tree>")?;
    let base = tree_text.as_ptr() as usize - xml.as_ptr() as usize;
    let doc = roxmltree::Document::parse(tree_text).map_err(|e| format!("xml: {e}"))?;
    let tree = doc.root_element();
    let active = tree.attribute("activeSpec").and_then(|v| v.parse::<usize>().ok()).unwrap_or(1).max(1);
    let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
    let spec = specs.get(active - 1).or_else(|| specs.first()).ok_or("missing <Spec>")?;
    let r = spec.attribute_node("nodes").ok_or("<Spec> has no nodes list")?.range_value();
    let range = (base + r.start)..(base + r.end);
    let current = &xml[range.clone()];
    let id = node_id.to_string();
    let mut ids: Vec<&str> = current.split(',').filter(|s| !s.is_empty()).collect();
    if ids.contains(&id.as_str()) {
        ids.retain(|s| *s != id);
    } else {
        ids.push(&id);
    }
    Ok(format!("{}{}{}", &xml[..range.start], ids.join(","), &xml[range.end..]))
}
