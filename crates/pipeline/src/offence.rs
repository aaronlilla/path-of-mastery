//! Orchestration of `calcs.offence(env, env.player, env.player.mainSkill)` (`Modules/CalcOffence.lua`) for the
//! player's main skill, built on the `pom_offence` functions with inputs taken from the live state.
//!
//! Order, as in `CalcOffence.lua`: base-damage assignment (`basedamage::assign_base_damage`), the conversion and
//! combine kernel (`conversion::build_conversion_table` + `calc_damage`, one call per damage type), hit chance
//! (`hit::calc_hit_chance`), crit (`crit::calc_crit`), cooldown (`cooldown::calc_skill_cooldown`), speed
//! (`speed::calc_speed`), then the self-contained fields in `misc_fields` (area, duration, repeats, trap and mine
//! limits, totem, brand, corpse).
//!
//! `activeSkill.skillData` is built by `skill_data_map`. `CalcActiveSkill.lua`:660-666 fills it from the
//! `SkillData`-named `LIST` mods on the skill's mod list, and `pom_skills::modlist::merge_skill_instance_mods` already
//! emits those mods, so the map is read off `ComputedSkill.skill_mod_list`. `damageEffectiveness` and `baseMultiplier`
//! are per-level gem fields (`CalcOffence.lua`:3350-3351 reads `grantedEffectLevel.<field> or skillData.<field> or 1`),
//! so they come straight from the `levels` table of the skill data.
use crate::buffs::skill_cfg as build_skill_cfg;
use crate::Env;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::{Backing, ModStore};
use pom_engine::modstore::types::ScalarValue;
use pom_engine::sym::Sym;
use pom_engine::value::Value;
use pom_skills::assemble::ComputedSkill;
use pom_skills::skill_type;
use pom_engine::fxhash::HashMap;
use std::sync::OnceLock;

/// `grantedEffect.levels[level_num].<field>` - same dense-array/sparse-object handling as
/// `pom_skills::modlist::raw_level_map` (see that function's own doc comment for why a plain `Vec`
/// index doesn't work for a sparse item/tree-granted skill).
fn level_field(ge_id: &str, level_num: f64, field: &str) -> Option<f64> {
    pom_skills::data::skill_level_obj(ge_id, level_num)?.get(field)?.as_f64()
}

pub(crate) fn level_field_pub(ge_id: &str, level_num: f64, field: &str) -> Option<f64> {
    level_field(ge_id, level_num, field)
}

/// `activeSkill.skillModList` (parented to the player's modDB) plus the skill's cfg, for queries made outside the offence pass.
pub(crate) fn skill_store_pub(env: &Env, main: &ComputedSkill) -> (ModStore, pom_engine::modstore::types::Cfg) {
    let cfg = build_skill_cfg(main);
    let player_snap = crate::buffs::player_snapshot(&env.player);
    let own_mods: Vec<Mod> = main.skill_mod_list.iter().filter(|m| !m.tags.iter().any(|t| t.kind.as_str() == "GlobalEffect" && matches!(t.get(pom_engine::sym!("effectType")), pom_engine::value::Value::Str(_)))).cloned().collect();
    let store = ModStore::new_list(Some(player_snap), env.player.actor.clone()).tap_add(&own_mods);
    (store, cfg)
}

/// Scans a mod list for `SkillData`-named `LIST` mods, folding each `{key, value}` pair into `map`
/// (later entries win, matching `activeSkill.skillData[value.key] = value.value`'s plain
/// overwrite). Mirrors `CalcActiveSkill.lua`:660-666's loop shape.
fn fold_skill_data_values(vals: &[Value], map: &mut HashMap<String, ScalarValue>) {
    for value in vals {
        let Value::Map(fields) = value else { continue };
        let Some(key) = fields.iter().find_map(|(k, v)| if k.as_str() == "key" { if let Value::Str(s) = v { Some(s.to_string()) } else { None } } else { None }) else { continue };
        let Some(val) = fields.iter().find(|(k, _)| k.as_str() == "value").map(|(_, v)| v) else { continue };
        let sv = match val {
            Value::Num(n) => ScalarValue::Num(*n),
            Value::Str(s) => ScalarValue::Str(s.clone()),
            Value::Bool(b) => ScalarValue::Bool(*b),
            _ => continue,
        };
        map.insert(key, sv);
    }
}

fn fold_skill_data_mods(mods: &[Mod], map: &mut HashMap<String, ScalarValue>) {
    let vals: Vec<Value> = mods.iter().filter(|m| m.name.as_str() == "SkillData" && m.ty == ModType::List).map(|m| m.value.clone()).collect();
    fold_skill_data_values(&vals, map);
}

/// `CalcOffence.lua`:527-534: `for _, value in ipairs(skillModList:List(skillCfg, "SkillData"))` - evaluated against the
/// skill's cfg (so `Multiplier`/`SkillPart`/`Condition` tags on `skill("radiusExtra", ...)` mods apply), `merge = "MAX"` keeps the larger.
fn apply_skill_data_list(sml: &ModStore, cfg: &pom_engine::modstore::types::Cfg, map: &mut HashMap<String, ScalarValue>) {
    for v in sml.list(Some(cfg), &[pom_engine::sym!("SkillData")]) {
        let Value::Map(fields) = &v else { continue };
        let get = |k: &str| fields.iter().find(|(f, _)| f.as_str() == k).map(|(_, v)| v);
        let Some(Value::Str(key)) = get("key") else { continue };
        let Some(val) = get("value") else { continue };
        let sv = match val {
            Value::Num(n) => ScalarValue::Num(*n),
            Value::Str(s) => ScalarValue::Str(s.clone()),
            Value::Bool(b) => ScalarValue::Bool(*b),
            _ => continue,
        };
        let is_max = matches!(get("merge"), Some(Value::Str(m)) if m.as_ref() == "MAX");
        match (is_max, &sv, map.get(key.as_ref())) {
            (true, ScalarValue::Num(n), prev) => {
                let p = if let Some(ScalarValue::Num(p)) = prev { *p } else { 0.0 };
                map.insert(key.to_string(), ScalarValue::Num(n.max(p)));
            }
            _ => {
                map.insert(key.to_string(), sv);
            }
        }
    }
}

fn player_mods(player: &ModStore) -> Vec<Mod> {
    match &player.backing {
        Backing::List(v) => v.to_vec(),
        Backing::Db(m) => m.values().flatten().cloned().collect(),
    }
}

/// `activeSkill.skillData`, live-built - see this module's doc comment for exactly what this
/// covers and the one named exception (`damageEffectiveness`/`baseMultiplier`).
pub(crate) fn skill_data_map(player: &ModStore, c: &ComputedSkill) -> HashMap<String, ScalarValue> {
    let mut map = HashMap::default();
    // Written before the `SkillData` loops below (CalcActiveSkill.lua:526, 581-607 precede 660-666), so a `SkillData`
    // mod ("has no reservation if cast as an aura" -> manaReservationPercent 0) overrides them.
    // The 8 `SkillDataOut` fields `pom_skills::modlist` already resolves from real gem-level data
    // (CalcActiveSkill.lua:581-607's direct `activeSkill.skillData.<field> = level.<field>`
    // assignments, not a mod) - folded in under their real Lua key names.
    let d = &c.skill_data;
    if let Some(v) = d.crit_chance {
        map.insert("critChance".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = d.attack_time {
        map.insert("attackTime".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = d.attack_speed_multiplier {
        map.insert("attackSpeedMultiplier".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = d.cooldown {
        map.insert("cooldown".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = d.stored_uses {
        map.insert("storedUses".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = d.soul_prevention_duration {
        map.insert("soulPreventionDuration".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = d.attached_brand_count {
        map.insert("attachedBrandCount".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = d.mana_reservation_percent {
        map.insert("manaReservationPercent".to_string(), ScalarValue::Num(v));
    }
    // `env.modDB:List(skillCfg, "SkillData")` first (item/tree-granted global SkillData mods),
    // then `skillModList:List(skillCfg, "SkillData")` (the skill's own - overrides on key clash),
    // matching CalcActiveSkill.lua:660-666's two-loop order exactly.
    // `List(skillCfg, "SkillData")`: tags (slot / skill type / conditions) are evaluated against the skill's cfg.
    let cfg = crate::buffs::skill_cfg(c);
    let names = [pom_engine::sym!("SkillData")];
    fold_skill_data_values(&player.list(Some(&cfg), &names), &mut map);
    let mut skill_store = ModStore::new_list(None, player.actor.clone());
    for m in &c.skill_mod_list {
        skill_store.add_mod(m.clone());
    }
    skill_store.conditions = player.conditions.clone();
    skill_store.multipliers = player.multipliers.clone();
    // `GetCondition` falls back to `self:Flag(cfg, "Condition:<var>")`, which sees the player's mods through the parent: a condition a
    // `SkillData` mod is tagged with (`skill("triggeredByMeleeKill", ...)` needs KilledRecently) can be a Config tab flag, not a condition entry.
    for m in &c.skill_mod_list {
        if m.name.as_str() != "SkillData" {
            continue;
        }
        for t in m.tags.iter() {
            if t.kind.as_str() != "Condition" {
                continue;
            }
            if let pom_engine::value::Value::Str(var) = t.get(pom_engine::sym!("var")) {
                let var: &str = var;
                if !skill_store.conditions.get(&Sym::new(var)).copied().unwrap_or(false) && player.flag(Some(&cfg), &[Sym::new(&format!("Condition:{var}"))]) {
                    skill_store.conditions.insert(Sym::new(var), true);
                }
            }
        }
    }
    fold_skill_data_values(&skill_store.list(Some(&cfg), &names), &mut map);

    // CalcPerform.lua:1359-1362: `activeSkill.skillData.attachedBrandCount` for every brand skill.
    if c.skill_types.contains(&pom_skills::skill_type::BRAND) {
        // `skillModList` is parented to the player modDB (`ActiveBrandLimit` BASE 3 lives there).
        let mut parented = ModStore::new_list(Some(crate::buffs::player_snapshot(player)), player.actor.clone());
        for m in &c.skill_mod_list {
            parented.add_mod(m.clone());
        }
        let sum = |st: &ModStore, name: &str| st.sum(ModType::Base, Some(&cfg), &[Sym::new(name)]);
        let attach_limit = sum(&parented, "BrandsAttachedLimit").min(sum(&parented, "ActiveBrandLimit"));
        let configured = player.sum(ModType::Base, None, &[pom_engine::sym!("Multiplier:ConfigBrandsAttachedToEnemy")]);
        let attached = if configured > 0.0 { configured.min(attach_limit) } else { attach_limit };
        map.insert("attachedBrandCount".to_string(), ScalarValue::Num(attached));
    }

    if let Some(v) = d.totem_level {
        // CalcActiveSkill.lua:618 sets the level requirement first; the SkillData loops (661-666) override it.
        map.entry("totemLevel".to_string()).or_insert(ScalarValue::Num(v));
    }
    // damageEffectiveness/baseMultiplier - see this module's doc comment.
    if let Some(v) = level_field(&c.granted_effect_id, c.level, "damageEffectiveness") {
        map.insert("damageEffectiveness".to_string(), ScalarValue::Num(v));
    }
    if let Some(v) = level_field(&c.granted_effect_id, c.level, "baseMultiplier") {
        map.insert("baseMultiplier".to_string(), ScalarValue::Num(v));
    }
    // `minionSkill.skillData.damageEffectiveness` (CalcActiveSkill.lua:920) only matters when the level has none (CalcOffence.lua:3351).
    if let Some(v) = c.damage_effectiveness_override.filter(|_| level_field(&c.granted_effect_id, c.level, "damageEffectiveness").is_none()) {
        map.insert("damageEffectiveness".to_string(), ScalarValue::Num(v));
    }
    map
}

/// `CalcSetup.lua`:1610/1738's `slotName` formula, duplicated from `pom_skills::assemble`'s private
/// `group_slot_name` (see this module's doc comment on `select_main_skill` for why this crate needs
/// its own copy).
fn group_slot_name(slot: &Option<String>, source: &Option<String>) -> Option<String> {
    if let Some(s) = slot {
        Some(s.replace(" Swap", ""))
    } else if source.as_ref().is_some_and(|s| s.to_lowercase().contains("tree")) {
        Some("Passive Tree".to_string())
    } else {
        None
    }
}

/// `env.player.mainSkill` (`CalcSetup.lua`:1879-1892): the main socket group's own
/// `mainActiveSkill`-th (1-based) active skill. `pom_skills::assemble::build_all_skills` doesn't
/// expose per-group boundaries on its flat `Vec<ComputedSkill>` result, so this re-parses the same
/// `<Skills>` XML `build_all_skills` itself reads (`pom_skills::xmlskills::parse_active_socket_
/// groups`/`parse_build_meta`, both public) to find the main group's own `slot`/`main_active_skill`,
/// then matches by `slot_name` against `active_skills` in order - a real, if approximate, stand-in
/// for "the Nth computed skill this specific group produced" (exact when a slot has exactly one
/// group, which is the overwhelmingly common case; two groups sharing the same `slot_name`, e.g.
/// two different tree-sourced groups both reporting "Passive Tree", could pick the wrong one).
pub fn select_main_skill<'a>(xml_text: &str, active_skills: &'a [ComputedSkill]) -> Option<&'a ComputedSkill> {
    // CalcSetup.lua:1929-1938: no main skill from the main group -> the default "Melee" skill.
    let melee = || active_skills.iter().find(|c| c.granted_effect_id == "Melee").or_else(|| active_skills.first());
    let _ = xml_text;
    // The main group is resolved by `pom_skills::assemble` (after unmatched saved item groups are dropped from the list).
    if let Some(i) = crate::offence_dps::MAIN_OVERRIDE.with(|c| c.get()) {
        if let Some(c) = active_skills.get(i) {
            return Some(c);
        }
    }
    let candidates: Vec<&ComputedSkill> = active_skills.iter().filter(|c| c.in_main_group).collect();
    if candidates.is_empty() {
        return melee();
    }
    let sel = (candidates[0].group_main_active_skill.max(1) as usize).min(candidates.len());
    candidates.get(sel - 1).copied()
}

/// `repeatSkillTypesCheck`'s type half (`CalcOffence.lua`:808-813) - the `CannotRepeat` flag check
/// itself is `misc_fields::repeats`'s own job (see that function's doc comment).
fn eligible_for_repeats(skill_types: &pom_engine::fxhash::HashSet<i64>) -> bool {
    let excluded = [skill_type::INSTANT, skill_type::CHANNEL, skill_type::TRIGGERED, skill_type::RETALIATION, skill_type::NON_REPEATABLE];
    if excluded.iter().any(|t| skill_types.contains(t)) {
        return false;
    }
    skill_types.contains(&skill_type::ATTACK) || skill_types.contains(&skill_type::SPELL)
}

/// `calcs.offence(env, env.player, env.player.mainSkill)`, non-attack scope only - see this
/// module's doc comment. Writes straight into `env.output`; produces nothing (not even a partial
/// write) when there's no live main skill or it's an attack skill, matching "leave the field
/// unproduced" rather than guessing.
pub fn compute_offence(env: &mut Env, xml_text: &str) {
    // `ComputedSkill` isn't `Clone`: lift the list out of `env` for the call so `main` can borrow it
    // while the body writes `env.output`.
    let mut skills = std::mem::take(&mut env.active_skills);
    // Test hook: `POM_OFFENCE_INPUT` swaps in a recorded upstream state (see `recorded_input`).
    if pom_engine::env::var("POM_OFFENCE_INPUT").is_ok() {
        if let Some(name) = select_main_skill(xml_text, &skills).map(|m| m.name.clone()) {
            env.recorded_override = crate::recorded_input::apply(env, &name);
            if let Some(j) = &env.recorded_override {
                if let Some(idx) = skills.iter().position(|c| c.name == name) {
                    skills[idx].skill_flags = j.skill_flags.clone();
                    skills[idx].skill_types = j.skill_types.clone();
                    skills[idx].flags = j.cfg_flags;
                    skills[idx].keyword_flags = j.cfg_keyword_flags;
                    skills[idx].skill_mod_list = j.skill_mods.clone();
                }
                crate::refresh_actors(env);
            }
        }
    }
    if let Some(main) = select_main_skill(xml_text, &skills) {
        let part = main_skill_part(xml_text, main);
        MIRAGE_MAIN_NEW.with(|m| *m.borrow_mut() = None);
        let top = CAPTURE_ARMED.with(|c| c.get());
        CAPTURE_TOP.with(|c| c.set(top));
        // a FullDPS sub-run (`crate::run` on a copied env, FULLDPS_PARENT set) is a CALCULATOR-mode run: no breakdown.
        let bd_was = pom_offence::bd::set_active(crate::buffs::FULLDPS_PARENT.with(|p| p.borrow().is_none()) && pom_offence::bd::run_depth() <= 1);
        compute_offence_for(env, xml_text, main, &skills, part);
        pom_offence::bd::set_active(bd_was);
        CAPTURE_TOP.with(|c| c.set(false));
        if let Some(c) = MIRAGE_MAIN_NEW.with(|m| m.borrow_mut().take()) {
            MIRAGE_MAIN.with(|m| *m.borrow_mut() = Some(c));
        }
    }
    env.active_skills = skills;
}

#[derive(Clone)]
pub(crate) struct MirageRun {
    pub extras: Vec<Mod>,
    pub uses: f64,
    /// General's Cry supported main skill (CalcMirages.lua:346-424): the scaling applied to the skill itself.
    pub gc: Option<GcRun>,
    /// Tawhoa's Chosen (CalcMirages.lua:216-222): `skillData.triggerRate` and `triggered` of the copy.
    pub trigger_rate: Option<f64>,
    /// The message lines the copy's `postCalcFunc` writes (Saviour, Tawhoa's Chosen) or the General's Cry branch writes:
    /// `infoMessage` and, when given, `infoMessage2`.
    pub info: Option<(String, Option<String>)>,
}

/// Lua's `tostring` of a number (the mirage messages print counts and times that way).
fn lua_num(v: f64) -> String {
    if v == v.trunc() && v.abs() < 1e15 { format!("{}", v as i64) } else { format!("{v}") }
}
#[derive(Clone)]
pub(crate) struct GcRun {
    /// `QuantityMultiplier` mods copied from the General's Cry gem's `GeneralsCryDoubleMaxCount`.
    pub qty_mods: Vec<Mod>,
    /// `skillData.hitTimeOverride = 1` (only for a non-channelled skill).
    pub hit_time_override: bool,
}
pub(crate) struct MirageResult {
    pub name: String,
    pub count: f64,
    pub output: HashMap<String, f64>,
    pub skill_part: Option<String>,
}
thread_local! {
    /// While a copied mirage skill runs (`calcs.copyActiveSkill`), its skillModList's actor is still the ORIGINAL
    /// player, whose `output` is the pre-offence table at the time `calcs.mirages` ran (ModStore:GetStat reads it).
    pub(crate) static MIRAGE_ACTOR_OUT: std::cell::RefCell<Option<HashMap<String, f64>>> = const { std::cell::RefCell::new(None) };
    /// `activeSkill.skillData.summonSpeed` of the last skill run through `compute_offence_for` (CalcOffence.lua:4097).
    pub(crate) static SUMMON_SPEED: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
    /// Set while the nested `calcs.perform(newEnv)` of `calculateMirage` (CalcMirages.lua:39) runs.
    pub(crate) static MIRAGE_RUN: std::cell::RefCell<Option<MirageRun>> = const { std::cell::RefCell::new(None) };
    /// `activeSkill.mirage` of the skill last run through `compute_offence_for`.
    pub(crate) static MIRAGE_RESULT: std::cell::RefCell<Option<MirageResult>> = const { std::cell::RefCell::new(None) };
    /// The copy that became `env.player.mainSkill` after a Saviour / Tawhoa's Chosen mirage (CalcMirages.lua:151, 207).
    pub(crate) static MIRAGE_MAIN: std::cell::RefCell<Option<ComputedSkill>> = const { std::cell::RefCell::new(None) };
    /// Skills (`granted_effect_id`, `group_xml_index`, `gem_index`) a Saviour / Tawhoa's Chosen mirage ran: the copy's
    /// `cacheData` overwrites the skill's GlobalCache entry with a HasNoCost output (CalcPerform.lua:3987).
    /// Skills whose Mirage Archer run (calculateMirage: a CALCULATOR-mode perform of the copy) already overwrote their own
    /// CALCULATOR GlobalCache entry with a no-cost output.
    pub(crate) static MIRAGE_ARCHER_SEEN: std::cell::RefCell<Vec<(String, Option<usize>, Option<usize>)>> = const { std::cell::RefCell::new(Vec::new()) };
    pub(crate) static MIRAGE_CHOSEN: std::cell::RefCell<Vec<(String, Option<usize>, Option<usize>)>> = const { std::cell::RefCell::new(Vec::new()) };
    /// Set by `saviour_tawhoa`, moved into `MIRAGE_MAIN` by the top-level `compute_offence`.
    static MIRAGE_MAIN_NEW: std::cell::RefCell<Option<ComputedSkill>> = const { std::cell::RefCell::new(None) };
    /// Set by `Session::calcs`: the next top-level offence runs keep their finished skill state in `CAPTURED` (the Calcs
    /// tab's inputs). Never set on the click path.
    pub(crate) static CAPTURE_ARMED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// What `CAPTURE_ARMED` collected: the player's main skill, then (when it has a minion) the minion's.
    /// True only while a top-level `compute_offence` (player or minion main skill) runs with capture armed.
    pub(crate) static CAPTURE_TOP: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub(crate) static CAPTURED:std::cell::RefCell<Vec<Captured>> = const { std::cell::RefCell::new(Vec::new()) };
    /// `skillData.dpsMultiplier` written by the Unleash (Seals) block of the skill last run through `compute_offence_for`.
    pub(crate) static UNLEASH_DPSMULT: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
}

/// Hits in an Unleash burst (display only: AverageBurstDamage, ShowBurst).
fn seal_burst_hits(seal_max: f64) -> f64 {
    if pom_offence::data::pom_fixes_on() {
        // One cast plus one reoccurrence per seal lost (differs from upstream).
        seal_max + 1.0
    } else {
        seal_max
    }
}

/// `skillData.dpsMultiplier` of an Unleash cast in the default mode: 1 + seals released per cast * repeat penalty (CalcOffence.lua:964).
pub fn unleash_dps_multiplier(seal_cooldown: f64, cast_rate: f64, penalty: f64, seal_max: f64) -> f64 {
    let seals = 1.0 / seal_cooldown / cast_rate;
    // A cast releases at most SealMax seals (differs from upstream).
    let seals = if pom_offence::data::pom_fixes_on() { seals.min(seal_max) } else { seals };
    1.0 + seals * penalty
}

/// The main skill's finished offence state (`activeSkill` after `calcs.offence`): what the Calcs tab's rows read.
pub(crate) struct Captured {
    /// The pass ran with the minion swapped into `env.player`.
    pub minion: bool,
    pub main: ComputedSkill,
    pub skill_mod_list: ModStore,
    /// `env.player` when the pass finished (the minion's store for a minion pass).
    pub player: ModStore,
    pub skill_cfg: pom_engine::modstore::types::Cfg,
    /// Each damage pass's cfg by label (`MainHand`, `OffHand`, `Skill`): `weapon1Cfg`, `weapon2Cfg` and the ailment cfgs' `cfg`.
    pub pass_cfgs: Vec<(&'static str, pom_engine::modstore::types::Cfg)>,
    pub skill_data: HashMap<String, ScalarValue>,
    /// `env.output` when the pass finished (the minion's output; the player's is read from the finished env instead).
    pub output: HashMap<String, f64>,
    /// `skillFlags.showAverage` (its negation is `notAverage`), when the leech block was reached.
    pub show_average: Option<bool>,
    /// The sidebar's message lines for the skill (`mainSkill.infoMessage` split as `RefreshStatList` does, then `infoMessage2`).
    pub info: Vec<String>,
    /// `mainSkill.infoMessage2` (drawn grey under the message), shown only with a message.
    pub info2: Option<String>,
}

/// `RefreshStatList`'s message lines (Build.lua:2081-2092): a message over 40 bytes is split at its colons.
pub(crate) fn info_lines(msg: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(m) = msg {
        if m.len() > 40 {
            out.extend(m.split(':').filter(|p| !p.is_empty()).map(|p| p.to_string()));
        } else {
            out.push(m.to_string());
        }
    }
    out
}

pub(crate) fn compute_offence_for(env: &mut Env, xml_text: &str, main0: &ComputedSkill, skills: &[ComputedSkill], skill_part: i64) {
    let _ = xml_text;
    // CalcMirages.lua:346-357: a skill supported by General's Cry is marked Triggered / OtherThingUsesSkill and
    // `usedByMirage` on the real main skill (no copy is made), before its offence runs.
    let gc_run = !main0.skill_flags.contains("disable") && MIRAGE_RUN.with(|m| m.borrow().is_none()) && truthy(&skill_data_map(&env.player, main0), "triggeredByGeneralsCry");
    let gc_owned: ComputedSkill;
    let main: &ComputedSkill = if gc_run {
        gc_owned = {
            let mut m = main0.clone();
            m.skill_types.insert(skill_type::TRIGGERED);
            m.skill_types.insert(skill_type::OTHER_THING_USES_SKILL);
            m
        };
        &gc_owned
    } else {
        main0
    };
    // `calcs.triggers` can disable the main skill itself (The Hidden Blade without Phasing) just before offence runs.
    let trigger_disabled = !crate::triggers_wire::NESTED.with(|n| n.get())
        && env.trigger_apply.as_ref().is_some_and(|a| a.result.disable_reason.is_some() && skills.get(a.main_idx).is_some_and(|s| std::ptr::eq(s, main0)));
    // CalcMirages.lua:160-162, 279-281: a Saviour / Tawhoa's Chosen main skill with no skill to copy is disabled.
    let mirage_not_found = !main.skill_flags.contains("disable")
        && !trigger_disabled
        && env.parent_snapshot.is_none()
        && MIRAGE_RUN.with(|m| m.borrow().is_none())
        && matches!(pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.as_deref()), Some("Reflection") | Some("Tawhoa's Chosen"))
        && saviour_tawhoa_best(env, xml_text, main, main0, skills).is_none();
    if main.skill_flags.contains("disable") || trigger_disabled || mirage_not_found {
        // CalcOffence.lua:370's `output.CombinedDPS = 0` early-return.
        env.output.insert("CombinedDPS".to_string(), 0.0);
        if CAPTURE_TOP.with(|c| c.get()) && !crate::triggers_wire::NESTED.with(|n| n.get()) {
            let sml = ModStore::new_list(Some(crate::buffs::player_snapshot(&env.player)), env.player.actor.clone());
            let mut disabled_main = main.clone();
            if mirage_not_found {
                disabled_main.skill_flags.insert("disable".to_string());
                let is_saviour = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.as_deref()) == Some("Reflection");
                disabled_main.disable_reason = Some(if is_saviour { "No Saviour active skill found" } else { "No Tawhoa's Chosen active skill found" }.to_string());
            }
            let c = Captured { minion: env.parent_snapshot.is_some(), main: disabled_main, skill_mod_list: sml, player: env.player.clone(), skill_cfg: build_skill_cfg(main), pass_cfgs: Vec::new(), skill_data: HashMap::default(), output: env.output.clone(), show_average: Some(false), info: Vec::new(), info2: None };
            CAPTURED.with(|v| {
                let mut v = v.borrow_mut();
                v.retain(|o| o.minion != c.minion);
                v.push(c);
            });
        }
        return;
    }
    let is_attack = main.skill_flags.contains("attack");
    let mut cap_show_average: Option<bool> = None;
    let mut cap_show_data: Option<bool> = None;
    // calcs.mirages, General's Cry branch (CalcMirages.lua:346-424): a General's Cry supported main skill is rerun as a
    // triggered, mirage-used skill (`usedByMirage`, Triggered / OtherThingUsesSkill types) scaled by the gem's Mirage
    // Warrior count and by the cooldown; that rerun is its own output, there is no separate mirage row.
    if MIRAGE_RUN.with(|m| m.borrow().is_none()) && truthy(&skill_data_map(&env.player, main), "triggeredByGeneralsCry") {
        let gc_name = |c: &ComputedSkill| pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|ge| ge.name.clone()).as_deref() == Some("General's Cry");
        if let Some(gc) = skills.iter().find(|c| gc_name(c) && c.slot_name == main.slot_name) {
            let mut ms = main.clone();
            ms.skill_types.insert(skill_type::TRIGGERED);
            ms.skill_types.insert(skill_type::OTHER_THING_USES_SKILL);
            // `calcs.buildActiveSkill` of the main skill under those types: only its HitTime / Time is read back.
            let saved = env.output.clone();
            MIRAGE_RUN.with(|m| *m.borrow_mut() = Some(MirageRun { extras: Vec::new(), uses: 0.0, gc: None, trigger_rate: None, info: None }));
            let bd_was = pom_offence::bd::set_active(false);
            compute_offence_for(env, xml_text, &ms, skills, skill_part);
            pom_offence::bd::set_active(bd_was);
            MIRAGE_RUN.with(|m| *m.borrow_mut() = None);
            if let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing {
                pom_engine::modstore::store::retain_mods(v, |m| !(m.name.as_str() == "Condition:OneSecondAttackTime" && m.source.is_none()));
            }
            let cache_out = std::mem::replace(&mut env.output, saved);
            let hit_time = cache_out.get("HitTime").or_else(|| cache_out.get("Time")).copied().unwrap_or(0.0);
            let snap = crate::buffs::player_snapshot(&env.player);
            let gc_store = crate::ailments::skill_store(&snap, gc);
            let gc_cfg = crate::buffs::skill_cfg(gc);
            let gc_sd = skill_data_map(&env.player, gc);
            let gc_cooldown = pom_offence::cooldown::calc_skill_cooldown(&gc_store, Some(&gc_cfg), num(&gc_sd, "cooldown"), num(&gc_sd, "storedUses"), num(&gc_sd, "vaalStoredUses")).0;
            let mut qty_mods: Vec<Mod> = Vec::new();
            for (_, mp) in gc_store.tabulate(Some(ModType::Base), Some(&gc_cfg), &[pom_engine::sym!("GeneralsCryDoubleMaxCount")]) {
                let m = unsafe { &*mp };
                qty_mods.push(Mod { name: pom_engine::sym!("QuantityMultiplier"), ty: m.ty, value: m.value.clone(), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (vec![]).into() });
            }
            let cooldown = gc_cooldown.max(hit_time);
            let mk = |n: &str, ty: ModType, v: Value, src: &str| Mod { name: Sym::new(n), ty, value: v, flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from(src)), tags: (vec![]).into() };
            let extras = vec![
                mk("DPS", ModType::More, Value::Num((1.0 / cooldown - 1.0) * 100.0), "General's Cry Cooldown"),
                mk("HasNoCost", ModType::Flag, Value::Bool(true), "Used by mirage"),
            ];
            let gc_run = GcRun { qty_mods, hit_time_override: !main.skill_types.contains(&skill_type::CHANNEL) };
            let gc_max: f64 = gc_run.qty_mods.iter().map(|m| match &m.value { Value::Num(n) => *n, _ => 0.0 }).sum();
            // CalcMirages.lua:362-396: 0.3s for the first mirage and 0.2s for each more (+1s when channelled), rounded to 2 places.
            let spawn = ((0.3 + 0.2 * gc_max + if main.skill_types.contains(&skill_type::CHANNEL) { 1.0 } else { 0.0 }) * 100.0).round() / 100.0;
            let skill_name = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| main.name.clone());
            let info = Some((format!("{} GC Mirages using {}", lua_num(gc_max), skill_name), Some(format!("{}s for {} Mirages to finish Attacking", lua_num(spawn), lua_num(gc_max)))));
            MIRAGE_RUN.with(|m| *m.borrow_mut() = Some(MirageRun { extras, uses: 0.0, gc: Some(gc_run), trigger_rate: None, info }));
            let bd_was = pom_offence::bd::set_active(false);
            compute_offence_for(env, xml_text, &ms, skills, skill_part);
            pom_offence::bd::set_active(bd_was);
            MIRAGE_RUN.with(|m| *m.borrow_mut() = None);
            return;
        }
    }
    let mirage_run = MIRAGE_RUN.with(|m| m.borrow().clone());
    if mirage_run.is_none() {
        MIRAGE_RESULT.with(|m| *m.borrow_mut() = None);
    }
    let mut skill_cfg = build_skill_cfg(main);
    if mirage_run.is_some() || gc_run {
        skill_cfg.skill_cond.insert(std::sync::Arc::from("usedByMirage"), true);
    }
    let mut cfg = skill_cfg.clone();
    // `skillCfg.skillPart` (CalcActiveSkill.lua:248-266): only multipart skills have one.
    if pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(pom_skills::data::parts).is_some_and(|p| p.len() > 1) {
        let idx = (skill_part.max(1) as usize).min(pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(pom_skills::data::parts).map_or(1, |p| p.len()));
        cfg.skill_part = Some(idx as f64);
    }
    // `skillCfg.skillDist = env.mode_effective and effectiveRange` (CalcActiveSkill.lua:451-474).
    {
        let key = if main.skill_flags.contains("melee") { "meleeDistance" } else { "projectileDistance" };
        cfg.skill_dist = env.config_input.get(key).or_else(|| env.config_placeholder.get(key)).copied().filter(|_| pom_calc::setup::buff_mode().effective);
    }
    let mut skill_data = skill_data_map(&env.player, main);
    if let Some(j) = &env.recorded_override {
        cfg.skill_types = j.skill_types.iter().map(|t| (*t, true)).collect();
        cfg.skill_cond = j.cfg_cond.iter().map(|(k, v)| (std::sync::Arc::from(k.as_str()), *v)).collect();
        cfg.skill_part = j.cfg_skill_part;
        cfg.skill_dist = j.cfg_skill_dist;
        skill_data = j.skill_data.clone();
        fold_skill_data_mods(&player_mods(&env.player), &mut skill_data);
        fold_skill_data_mods(&j.skill_mods, &mut skill_data);
        // `grantedEffectLevel.damageEffectiveness`/`baseMultiplier` are gem-level fields, not skillData.
        for k in ["damageEffectiveness", "baseMultiplier"] {
            if let Some(v) = level_field(&main.granted_effect_id, main.level, k) {
                skill_data.insert(k.to_string(), ScalarValue::Num(v));
            }
        }
    }
    // `ModList(activeSkill.actor.modDB)` (CalcActiveSkill.lua:492): the skill's own mod list is
    // parented to the player's modDB for real, so a query that finds nothing on the skill's own
    // mods (Accuracy from Dexterity, CritChance from an item, ...) still falls through to the
    // player's - same fix `crate::buffs::player_snapshot` needed for the same reason.
    // CalcOffence.lua:1037-1050 "momentum stacks": a skill supported by Momentum writes the stack Multiplier into the
    // player's modDB (persistent across skills; `ReplaceMod` swaps a mod with identical name/type/flags/source/tags).
    // The support's own mods carry no condition, so they are read straight off the skill's list before the snapshot.
    if main.skill_mod_list.iter().any(|m| m.name.as_str() == "SupportedByMomentum") {
        let base_sum = |n: &str| -> f64 { main.skill_mod_list.iter().filter(|m| m.name.as_str() == n && m.ty == ModType::Base).filter_map(|m| if let Value::Num(v) = &m.value { Some(*v) } else { None }).sum() };
        let (max_stacks, extra_stacks) = (base_sum("MomentumStacksMax"), base_sum("MomentumStacksExtra"));
        let stacks_name = pom_engine::sym!("Multiplier:MomentumStacks");
        let has = env.player.has_mod(ModType::Base, None, &[stacks_name]);
        let mk = |v: f64| Mod { name: stacks_name, ty: ModType::Base, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Config")), tags: (vec![pom_engine::modifier::Tag { kind: pom_engine::sym!("Condition"), fields: vec![(pom_engine::sym!("var"), Value::Str(std::sync::Arc::from("Combat")))] }]).into() };
        let mut replace_with: Option<f64> = None;
        if max_stacks > 0.0 {
            if !has {
                env.player.add_mod(mk(((max_stacks + extra_stacks) / 2.0).min(max_stacks)));
            } else if env.player.sum(ModType::Base, None, &[stacks_name]) > max_stacks {
                replace_with = Some(max_stacks);
            }
        } else if has {
            replace_with = Some(0.0);
        }
        if let Some(v) = replace_with {
            let new_mod = mk(v);
            if let pom_engine::modstore::store::Backing::List(list) = &mut env.player.backing {
                let key = |m: &Mod| format!("{:?}|{:?}|{}|{}|{:?}|{:?}", m.name, m.ty, m.flags, m.keyword_flags, m.source, m.tags);
                let nk = key(&new_mod);
                if let Some(i) = list.iter().position(|m| m.name == stacks_name && key(m) == nk) {
                    std::sync::Arc::make_mut(list)[i] = new_mod;
                } else {
                    env.player.add_mod(new_mod);
                }
            } else if let pom_engine::modstore::store::Backing::Db(map) = &mut env.player.backing {
                let key = |m: &Mod| format!("{:?}|{:?}|{}|{}|{:?}|{:?}", m.name, m.ty, m.flags, m.keyword_flags, m.source, m.tags);
                let nk = key(&new_mod);
                let list = map.entry(stacks_name).or_default();
                if let Some(slot) = list.iter_mut().find(|m| key(m) == nk) {
                    *slot = new_mod;
                } else {
                    list.push(new_mod);
                }
            }
        }
    }
    let player_snap = crate::buffs::player_snapshot(&env.player);
    // The skill's ModList chain: `activeSkill.skillModList` (mods added during offence) ->
    // `baseSkillModList` (the gem/support mods) -> the actor's modDB. Kept as separate levels since
    // `More` rounds per list level.
    // CalcActiveSkill.lua:806-866: every `GlobalEffect` mod is pulled out of `skillModList` into its buff (the buff
    // reaches this skill through the player's modDB instead), so the skill's own list no longer carries it.
    let own_mods: Vec<Mod> = main.skill_mod_list.iter().filter(|m| !m.tags.iter().any(|t| t.kind.as_str() == "GlobalEffect" && matches!(t.get(pom_engine::sym!("effectType")), pom_engine::value::Value::Str(_)))).cloned().collect();
    let mut skill_mod_list = {
        let level_mods: Vec<&[Mod]> = match &env.recorded_override {
            Some(j) if !j.levels.is_empty() => j.levels.iter().map(|l| l.as_slice()).collect(),
            // A minion's skill is never re-wrapped (CalcPerform.lua:1296 only walks the player's list): its
            // `skillModList` IS `baseSkillModList`, a single ModList level (`More` rounds once, not twice).
            _ if env.parent_snapshot.is_some() => vec![own_mods.as_slice()],
            _ => vec![&[][..], own_mods.as_slice()],
        };
        let mut parent = player_snap.clone();
        for mods in level_mods[1..].iter().rev() {
            parent = std::sync::Arc::new(ModStore::new_list(Some(parent), env.player.actor.clone()).tap_add(mods));
        }
        let mut top = ModStore::new_list(Some(parent), env.player.actor.clone()).tap_add(level_mods[0]);
        if let Some(r) = &mirage_run {
            for m in &r.extras {
                top.add_mod(m.clone());
            }
            if let Some(gc) = &r.gc {
                for m in &gc.qty_mods {
                    top.add_mod(m.clone());
                }
                // "Supported Attacks Count as Exerted" (CalcMirages.lua:394-416): exert mods become plain Damage mods.
                let mut conv: Vec<Mod> = Vec::new();
                for (names, ty, to) in [
                    ("ExertIncrease", ModType::Inc, "Damage"),
                    ("ExertIncrease", ModType::More, "Damage"),
                    ("ExertAttackIncrease", ModType::More, "Damage"),
                    ("OverexertionExertAverageIncrease", ModType::More, "Damage"),
                    ("ExertDoubleDamageChance", ModType::Base, "DoubleDamageChance"),
                ] {
                    for (_, mp) in top.tabulate(Some(ty), Some(&cfg), &[Sym::new(names)]) {
                        let m = unsafe { &*mp };
                        conv.push(Mod { name: Sym::new(to), ty: m.ty, value: m.value.clone(), flags: m.flags, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: (vec![]).into() });
                    }
                }
                for m in conv {
                    top.add_mod(m);
                }
            }
        }
        top
    };
    if let Some(j) = &env.recorded_override {
        skill_mod_list.conditions = j.skill_conditions.iter().map(|(k, v)| (Sym::new(k), *v)).collect();
        skill_mod_list.multipliers = j.skill_multipliers.iter().map(|(k, v)| (Sym::new(k), *v)).collect();
    }
    refresh_actor(&mut skill_mod_list, &env.output, None);

    // Stage multipliers (CalcActiveSkill.lua:646-656): `Multiplier:<Name>Stage` / `...StageAfterFirst` from the skill's
    // `Multiplier:<Name>MaxStages` limit and the gem's saved stage count (MAIN mode: `skillStageCount`).
    let mut active_stage_count = 0.0;
    {
        let name: String = pom_skills::data::granted_effect_by_skill_id(&main.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| main.name.clone()).split_whitespace().collect();
        // Scorching Ray part 2's MaxStages/StageAfterFirst are added later, by CalcPerform (2293-2297); at CalcActiveSkill time
        // its limit is 0 (the statMap mod is gated to skillPart 1), so no stage mods come from here.
        let sr_part2 = matches!(name.as_str(), "ScorchingRay" | "ScorchingRayofImmolation") && cfg.skill_part == Some(2.0);
        let limit = if sr_part2 { 0.0 } else { skill_mod_list.sum(ModType::Base, Some(&cfg), &[Sym::new(&format!("Multiplier:{name}MaxStages"))]) };
        if limit > 0.0 {
            skill_data.insert("stagesMax".to_string(), ScalarValue::Num(limit));
            let min_stage = skill_mod_list.sum(ModType::Base, Some(&cfg), &[Sym::new(&format!("Multiplier:{name}MinimumStage"))]);
            let count = main.stage_count.unwrap_or(limit).max(1.0 + min_stage);
            if count > 0.0 {
                active_stage_count = count - 1.0;
                let mk = |n: String, v: f64| Mod { name: Sym::new(&n), ty: ModType::Base, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Base")), tags: (vec![]).into() };
                skill_mod_list.add_mod(mk(format!("Multiplier:{name}Stage"), limit.min(count)));
                skill_mod_list.add_mod(mk(format!("Multiplier:{name}StageAfterFirst"), (limit - 1.0).min(count - 1.0)));
            }
        }
    }

    // `calcs.perform`'s per-skill loop (CalcPerform.lua:1473-1483) and then `calcs.triggers` ran before offence on
    // the real main skill: their `skillData`/`output` writes (offence re-applies the SkillData LIST right after).
    let mut info_msg: Option<String> = None;
    let mut info_msg2: Option<String> = None;
    if !crate::triggers_wire::NESTED.with(|n| n.get()) {
        if !main.skill_flags.contains("minion") && truthy(&skill_data, "triggeredOnDeath") {
            skill_data.insert("triggered".to_string(), ScalarValue::Bool(true));
            skill_data.insert("triggerTime".to_string(), ScalarValue::Num(60000.0));
            add_triggered_damage(&mut skill_mod_list, &cfg);
        }
        if let Some(a) = env.trigger_apply.take() {
            if skills.get(a.main_idx).is_some_and(|s| std::ptr::eq(s, main0)) {
                crate::triggers_wire::apply_outputs(env, &a);
                info_msg = a.result.info_message.clone();
                info_msg2 = a.result.info_message2.clone();
                crate::triggers_wire::apply_skill_data(&a, &mut skill_data);
                // `env.player.modDB:NewMod("UsesCurseOverlaps", "FLAG", true, "Config")` (CalcTriggers.lua:598, 710, 1390): the
                // Configuration tab's `Curse overlaps` option lists on it (ifFlag reads the skill mod list, which sees the modDB).
                if a.result.uses_curse_overlaps {
                    skill_mod_list.add_mod(Mod { name: Sym::new("UsesCurseOverlaps"), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Config")), tags: (vec![]).into() });
                }
                if a.result.triggered == Some(true) && a.result.skill_trigger_rate.is_some() {
                    let src_cfg = a.source_idx.and_then(|i| skills.get(i)).map(build_skill_cfg);
                    add_triggered_damage(&mut skill_mod_list, src_cfg.as_ref().unwrap_or(&cfg));
                }
                snipe_main_effects(&a, main0, &mut skill_mod_list, &cfg, &mut skill_data);
            }
            env.trigger_apply = Some(a);
        }
    }
    // The copy of a Saviour / Tawhoa's Chosen / General's Cry mirage carries the message its postCalcFunc wrote.
    if let Some((m, m2)) = mirage_run.as_ref().and_then(|r| r.info.clone()) {
        info_msg = Some(m);
        if m2.is_some() {
            info_msg2 = m2;
        }
    }
    apply_skill_data_list(&skill_mod_list, &cfg, &mut skill_data);
    if let Some(h) = crate::triggers_wire::SNIPE_HTM.with(|c| c.get()) {
        skill_data.insert("hitTimeMultiplier".to_string(), ScalarValue::Num(h));
    }
    // CalcMirages.lua:346-424: General's Cry Mirage Warriors reuse the main skill in place.
    let mut gc_state: Option<(Option<f64>, f64)> = None;
    if gc_run {
        let mk = |n: &str, ty: ModType, v: Value, src: Option<std::sync::Arc<str>>, flags: u64, kw: u64| Mod { name: Sym::new(n), ty, value: v, flags: flags as _, keyword_flags: kw as _, source: src, tags: (vec![]).into() };
        let gc_name = |c: &ComputedSkill| pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| c.name.clone());
        if let Some(gc) = skills.iter().find(|c| gc_name(c) == "General's Cry" && c.slot_name == main.slot_name) {
            let snap = crate::buffs::player_snapshot(&env.player);
            let store = crate::ailments::skill_store(&snap, gc);
            let gcfg = crate::buffs::skill_cfg(gc);
            let gsd = skill_data_map(&env.player, gc);
            let gc_cd = pom_offence::cooldown::calc_skill_cooldown(&store, Some(&gcfg), num(&gsd, "cooldown"), num(&gsd, "storedUses"), num(&gsd, "vaalStoredUses")).0;
            for (v, mp) in store.tabulate(Some(ModType::Base), Some(&gcfg), &[pom_engine::sym!("GeneralsCryDoubleMaxCount")]) {
                let m = unsafe { &*mp };
                skill_mod_list.add_mod(mk("QuantityMultiplier", m.ty, v, m.source.clone(), m.flags as u64, m.keyword_flags as u64));
            }
            let orig_hto = num(&skill_data, "hitTimeOverride");
            if !main.skill_types.contains(&skill_type::CHANNEL) {
                skill_data.insert("hitTimeOverride".to_string(), ScalarValue::Num(1.0));
            }
            skill_mod_list.add_mod(mk("HasNoCost", ModType::Flag, Value::Bool(true), Some(std::sync::Arc::from("Used by mirage")), 0, 0));
            let copies: [(ModType, &str, &str); 4] = [
                (ModType::Inc, "ExertIncrease", "Damage"),
                (ModType::More, "ExertIncrease", "Damage"),
                (ModType::More, "ExertAttackIncrease", "Damage"),
                (ModType::More, "OverexertionExertAverageIncrease", "Damage"),
            ];
            for (ty, src_name, dst) in copies {
                for (v, mp) in skill_mod_list.tabulate(Some(ty), Some(&cfg), &[Sym::new(src_name)]) {
                    let m = unsafe { &*mp };
                    let nm = mk(dst, m.ty, v, m.source.clone(), m.flags as u64, m.keyword_flags as u64);
                    skill_mod_list.add_mod(nm);
                }
            }
            for (v, mp) in skill_mod_list.tabulate(Some(ModType::Base), Some(&cfg), &[pom_engine::sym!("ExertDoubleDamageChance")]) {
                let m = unsafe { &*mp };
                let nm = mk("DoubleDamageChance", m.ty, v, m.source.clone(), m.flags as u64, m.keyword_flags as u64);
                skill_mod_list.add_mod(nm);
            }
            gc_state = Some((orig_hto, gc_cd));
        }
    }
    if let Some(r) = &mirage_run {
        if r.gc.as_ref().is_some_and(|g| g.hit_time_override) {
            skill_data.insert("hitTimeOverride".to_string(), ScalarValue::Num(1.0));
        }
        skill_data.insert("mirageUses".to_string(), ScalarValue::Num(r.uses));
        if let Some(tr) = r.trigger_rate {
            skill_data.insert("triggerRate".to_string(), ScalarValue::Num(tr));
            skill_data.insert("triggered".to_string(), ScalarValue::Bool(true));
        }
    } else if matches!(pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.as_deref()), Some("Reflection") | Some("Tawhoa's Chosen")) {
        if saviour_tawhoa(env, xml_text, main, main0, skills, skill_part, &skill_mod_list, &cfg, &skill_data) {
            return;
        }
    } else if truthy(&skill_data, "triggeredByMirageArcher") || truthy(&skill_data, "triggeredBySacredWisps") {
        // calcs.mirages, Mirage Archer branch (CalcMirages.lua:67-121) and Sacred Wisps branch (:264-330): the main
        // skill is copied, given the less damage / speed and no cost, and run as its own `calcs.perform`.
        let sum = |n: &str| skill_mod_list.sum(ModType::Base, Some(&cfg), &[Sym::new(n)]);
        let mk = |n: &str, ty: ModType, v: Value, src: &str| Mod { name: Sym::new(n), ty, value: v, flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from(src)), tags: (vec![]).into() };
        let (extras, count) = if truthy(&skill_data, "triggeredByMirageArcher") {
            let more_damage = sum("MirageArcherLessDamage");
            let more_speed = sum("MirageArcherLessAttackSpeed");
            let count = sum("MirageArcherMaxCount");
            (vec![
                mk("Damage", ModType::More, Value::Num(more_damage), "Mirage Archer"),
                mk("Speed", ModType::More, Value::Num(more_speed), "Mirage Archer"),
                mk("HasNoCost", ModType::Flag, Value::Bool(true), "Used by mirage"),
            ], count)
        } else {
            let less_damage = sum("SacredWispsLessDamage");
            let mut wisps: Option<(f64, f64)> = None;
            for c in skills.iter() {
                let nm = pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| c.name.clone());
                if nm == "Summon Sacred Wisps" {
                    let mut store = ModStore::new_list(Some(crate::buffs::player_snapshot(&env.player)), env.player.actor.clone());
                    for m in &c.skill_mod_list { store.add_mod(m.clone()); }
                    let sm = |n: &str| store.sum(ModType::Base, Some(&cfg), &[Sym::new(n)]);
                    wisps = Some((sm("SacredWispsChance"), sm("SacredWispsMaxCount")));
                    break;
                }
            }
            let (chance, max_count) = wisps.unwrap_or((0.0, 0.0));
            (vec![
                mk("Damage", ModType::More, Value::Num(less_damage), "Used by Sacred Wisps"),
                mk("Speed", ModType::More, Value::Num(chance - 100.0), "Sacred Wisps cast chance"),
                mk("HasNoCost", ModType::Flag, Value::Bool(true), "Used by Sacred Wisps"),
            ], max_count)
        };
        let mut ms = env.raw_skills.iter().find(|r| r.granted_effect_id == main.granted_effect_id && r.group_xml_index == main.group_xml_index && r.gem_index == main.gem_index).unwrap_or(main).clone();
        ms.skill_flags.remove("multiPart");
        ms.skill_flags.remove("haveMinion");
        ms.skill_types.insert(skill_type::OTHER_THING_USES_SKILL);
        // The copy has no gemCfg, so its skillCfg.slotName is nil (CalcActiveSkill.lua:475): SocketedIn mods stop applying.
        ms.slot_name = None;
        let saved = env.output.clone();
        let saved_str = env.output_str.clone();
        if truthy(&skill_data, "triggeredByMirageArcher") {
            let key = (main.granted_effect_id.clone(), main.group_xml_index, main.gem_index);
            MIRAGE_ARCHER_SEEN.with(|m| { let mut m = m.borrow_mut(); if !m.contains(&key) { m.push(key); } });
        }
        MIRAGE_RUN.with(|m| *m.borrow_mut() = Some(MirageRun { extras, uses: num(&skill_data, "storedUses").unwrap_or(0.0), gc: None, trigger_rate: None, info: None }));
        MIRAGE_ACTOR_OUT.with(|m| *m.borrow_mut() = Some(saved.clone()));
        let bd_was = pom_offence::bd::set_active(false);
        compute_offence_for(env, xml_text, &ms, skills, skill_part);
        pom_offence::bd::set_active(bd_was);
        MIRAGE_RUN.with(|m| *m.borrow_mut() = None);
        MIRAGE_ACTOR_OUT.with(|m| *m.borrow_mut() = None);
        if let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing {
            pom_engine::modstore::store::retain_mods(v, |m| !(m.name.as_str() == "Condition:OneSecondAttackTime" && m.source.is_none()));
        }
        let mout = std::mem::replace(&mut env.output, saved);
        env.output_str = saved_str;
        let name = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| main.name.clone());
        let mirage_part = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(pom_skills::data::parts).filter(|p| p.len() > 1).and_then(|p| p.get((skill_part.max(1) as usize).min(p.len()) - 1)).and_then(|v| v.get("name")).and_then(|v| v.as_str()).map(|s| s.to_string());
        if info_msg.is_none() {
            let what = if truthy(&skill_data, "triggeredByMirageArcher") { "Mirage Archers" } else { "Sacred Wisps" };
            info_msg = Some(format!("{} {what} using {name}", lua_num(count)));
        }
        MIRAGE_RESULT.with(|m| *m.borrow_mut() = Some(MirageResult { name, count, output: mout, skill_part: mirage_part }));
    }
    add_costs(&env.player, &mut env.output, main, &cfg, &skill_data, &skill_mod_list);
    add_aura_reservation_mods(&mut env.output, main, &cfg, &skill_data, &skill_mod_list);
    crate::bd_b::effect_mods(env, main, &cfg, &skill_data, &skill_mod_list);

    let is_totem = main.skill_flags.contains("totem");
    let is_ballista = main.skill_flags.contains("ballista");
    let has_brand = main.skill_types.contains(&skill_type::BRAND);
    let has_corpse = main.skill_flags.contains("corpse");
    let flag = |n: &str| main.skill_flags.contains(n);

    // `calcs.actionSpeedMod(actor)` (CalcPerform.lua:1141-1151); `output.ActionSpeedMod` is set by
    // `calcs.defence` (CalcDefence.lua:663), which the pipeline's defence stage doesn't write.
    let action_speed_mod = {
        let minimum_action_speed = env.player.max(None, &[pom_engine::sym!("MinimumActionSpeed")]).unwrap_or(0.0);
        let maximum_reduction = env.player.max(None, &[pom_engine::sym!("MaximumActionSpeedReduction")]);
        pom_offence::tools::action_speed_mod(
            env.player.sum(ModType::Inc, None, &[pom_engine::sym!("TemporalChainsActionSpeed")]),
            env.player.sum(ModType::Inc, None, &[pom_engine::sym!("ActionSpeed")]),
            pom_offence::data::misc("TemporalChainsEffectCap"),
            minimum_action_speed,
            maximum_reduction,
        )
    };
    env.output.insert("ActionSpeedMod".to_string(), action_speed_mod);
    // calcWarcryCastTime (CalcOffence.lua:311-320, 1468-1470) and WarcryEffectMod (1219-1236).
    if main.skill_flags.contains("warcry") {
        let base_speed = 1.0 / skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("WarcryCastTime")]);
        let rate = (base_speed * pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("WarcrySpeed")]) * action_speed_mod).min(pom_offence::data::misc("ServerTickRate"));
        let mut t = 1.0 / rate;
        if skill_mod_list.flag(Some(&cfg), &[pom_engine::sym!("InstantWarcry")]) || truthy(&skill_data, "triggeredByAutoexertion") {
            t = 0.0;
        }
        env.output.insert("WarcryCastTime".to_string(), t);
    }
    if main.skill_types.contains(&skill_type::WARCRY) {
        let names: Vec<&str> = if truthy(&skill_data, "mineDurationAppliesToSkill") { vec!["Duration", "PrimaryDuration", "MineDuration"] } else { vec!["Duration", "PrimaryDuration"] };
        let duration_mod = pom_offence::tools::calc_lib_mod(&skill_mod_list, Some(&cfg), &names).max(0.0);
        let duration_base = num(&skill_data, "duration").unwrap_or(0.0) + skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("Duration"), pom_engine::sym!("PrimaryDuration")]);
        let mut full_duration = duration_base * duration_mod;
        if truthy(&skill_data, "debuff") && pom_calc::setup::buff_mode().effective {
            full_duration *= 1.0 / pom_offence::data::misc("BuffExpirationSlowCap").max(pom_offence::tools::calc_lib_mod_s(&env.enemy, Some(&cfg), &[pom_engine::sym!("BuffExpireFaster")]));
        }
        let cd_override = skill_mod_list.override_(Some(&cfg), &[pom_engine::sym!("CooldownRecovery")]).and_then(|v| v.num());
        let actual_cooldown = cd_override.unwrap_or_else(|| (num(&skill_data, "cooldown").unwrap_or(0.0) + skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("CooldownRecovery")])) / pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("CooldownRecovery")]));
        let uptime = if env.player.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]) { 1.0 } else { (full_duration / actual_cooldown).min(1.0) };
        let unscaled = pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("WarcryEffect"), pom_engine::sym!("BuffEffect")]);
        env.output.insert("WarcryEffectMod".to_string(), unscaled * uptime);
        crate::bd_b::warcry_effect(env, unscaled, uptime, unscaled * uptime);
    }

    // ---- weapon data (CalcSetup.lua:1566-1581)
    let unarmed = |class_id: i64| -> pom_offence::weapon::WeaponSource {
        let phys_max = [6.0, 8.0, 5.0, 5.0, 6.0, 6.0, 5.0][class_id.clamp(0, 6) as usize];
        let mut w = pom_offence::weapon::WeaponSource::default();
        w.weapon_type = Some("None".to_string());
        w.set("AttackRate", 1.2);
        w.set("CritChance", 0.0);
        w.set("PhysicalMin", 2.0);
        w.set("PhysicalMax", phys_max);
        w
    };
    let from_json = |v: &serde_json::Value| -> pom_offence::weapon::WeaponSource {
        let mut w = pom_offence::weapon::WeaponSource::default();
        if let Some(o) = v.as_object() {
            for (k, x) in o {
                if let Some(n) = x.as_f64() {
                    w.set(k, n);
                } else if k == "type" {
                    w.weapon_type = x.as_str().map(|s| s.to_string());
                } else if k == "countsAsAll1H" {
                    w.counts_as_all_1h = x.as_bool().unwrap_or(false);
                }
            }
        }
        w
    };
    let w1_item = env.weapon_data.get("Weapon 1");
    // CalcPerform.lua:3473-3475: `DisableWeapons` (The Dancing Dervish) replaces `weaponData1` with the unarmed table.
    let weapon1 = match w1_item.and_then(|w| w.first()) {
        Some(v) if !env.weapons_disabled => from_json(v),
        _ => unarmed(env.class_id),
    };
    let counts_as_dual = w1_item.and_then(|w| w.first()).and_then(|v| v.get("countsAsDualWielding")).and_then(|v| v.as_bool()).unwrap_or(false);
    let has_item = |slot: &str| env.weapon_data.contains_key(slot);
    let weapon2 = if counts_as_dual {
        w1_item.and_then(|w| w.get(1)).map(from_json).unwrap_or_default()
    } else if !has_item("Weapon 2") {
        // Hollow Palm Technique (no Weapon 1, no Gloves)
        if !has_item("Weapon 1") && !env.item_armour.contains_key("Gloves") && env.keystones_added.contains("Hollow Palm Technique") {
            unarmed(env.class_id)
        } else {
            pom_offence::weapon::WeaponSource::default()
        }
    } else {
        env.weapon_data.get("Weapon 2").and_then(|w| w.get(1)).map(from_json).unwrap_or_default()
    };

    let (mut weapon1, mut weapon2) = match &env.recorded_override {
        Some(j) => (j.weapon1.clone(), j.weapon2.clone().unwrap_or_default()),
        None => (weapon1, weapon2),
    };
    // CalcOffence.lua:568-583: Energy Blade rewrites the equipped weapons' crit, attack rate, range and damage.
    if env.player.conditions.get(&pom_engine::sym!("AffectedByEnergyBlade")).copied().unwrap_or(false) && env.recorded_override.is_none() {
        let dmg_mod = pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("EnergyBladeDamage")]);
        let speed_mod = if pom_offence::data::pom_fixes_on() {
            // The gem quality's attack speed is increased, so it joins the other Speed INC instead of multiplying the blade's base rate (differs from upstream).
            let (inc, more) = pom_offence::tools::calc_lib_mods_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("EnergyBladeAttackSpeed")]);
            let quality = ((more - 1.0) * 100.0 * 1e6).round() / 1e6;
            if quality != 0.0 {
                skill_mod_list.add_mod(Mod { name: Sym::new("Speed"), ty: ModType::Inc, value: Value::Num(quality), flags: 1, keyword_flags: 0, source: Some(std::sync::Arc::from("Energy Blade")), tags: (vec![]).into() });
            }
            inc
        } else {
            pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("EnergyBladeAttackSpeed")])
        };
        let game = pom_skills::data::game_data();
        for slot in ["Weapon 1", "Weapon 2"] {
            let Some(wd) = env.weapon_data.get(slot) else { continue };
            if wd.is_empty() {
                continue;
            }
            let actor_entry = if slot == "Weapon 1" { wd.first() } else { wd.get(1) };
            let Some(name) = actor_entry.and_then(|v| v.get("name")).and_then(|n| n.as_str()) else { continue };
            let Some(base) = game.item_bases.get(name).and_then(|b| b.weapon.as_ref()) else { continue };
            let w = if slot == "Weapon 1" { &mut weapon1 } else { &mut weapon2 };
            let slot_owned = slot.to_string();
            w.num.insert("CritChance".into(), base.get("CritChanceBase").copied().unwrap_or(0.0));
            w.num.insert("AttackRate".into(), base.get("AttackRateBase").copied().unwrap_or(0.0) * speed_mod);
            w.num.insert("Range".into(), base.get("Range").copied().unwrap_or(0.0));
            for t in pom_offence::conversion::DMG_TYPES {
                let mn = skill_mod_list.sum(ModType::Base, Some(&cfg), &[Sym::new(&format!("EnergyBladeMin{t}"))]);
                let mx = skill_mod_list.sum(ModType::Base, Some(&cfg), &[Sym::new(&format!("EnergyBladeMax{t}"))]);
                w.num.insert(format!("{t}Min"), base.get(&format!("{t}Min")).copied().unwrap_or(0.0) + (mn * dmg_mod).floor());
                w.num.insert(format!("{t}Max"), base.get(&format!("{t}Max")).copied().unwrap_or(0.0) + (mx * dmg_mod).floor());
            }
            // `actor.weaponData1` is one shared table: the minion (Animate Weapon) reads the rewritten values later.
            let updates: Vec<(String, f64)> = w.num.iter().map(|(k, v)| (k.clone(), *v)).collect();
            if let Some(entry) = env.weapon_data.get_mut(&slot_owned).and_then(|l| l.get_mut(if slot_owned == "Weapon 1" { 0 } else { 1 })) {
                if let Some(o) = entry.as_object_mut() {
                    for (k, v) in updates {
                        o.insert(k, serde_json::json!(v));
                    }
                }
            }
        }
    }

    // ---- The mod-injection chain (CalcOffence.lua:516-1050), with `Repeats` (808-819) computed first
    // since the chain's repeat block reads it.
    {
        let repeat_eligible = eligible_for_repeats(&main.skill_types);
        let repeats = {
            let sv0 = pom_offence::input::SkillView { skill_mod_list: &skill_mod_list, skill_cfg: Some(&cfg), skill_data: &skill_data, skill_flags: &main.skill_flags, skill_types: &main.skill_types, skill_totem_id: 0 };
            pom_offence::misc_fields::repeats(&sv0, repeat_eligible).0
        };
        let weapon2_opt = if weapon2.weapon_type.is_some() { Some(weapon2.clone()) } else { None };
        crate::offence_prep::prepare_skill_mods(
            &mut skill_mod_list,
            &mut cfg,
            &mut skill_data,
            &crate::offence_prep::PrepInput {
                skill_flags: &main.skill_flags,
                player: &env.player,
                output: &env.output,
                weapon1: &weapon1,
                weapon2: &weapon2_opt,
                weapon1_flags: main.weapon1_flags,
                weapon2_flags: main.weapon2_flags,
                has_weapon1_item: env.weapon_data.contains_key("Weapon 1") || env.recorded_override.as_ref().is_some_and(|j| j.weapon1.weapon_type.as_deref().is_some_and(|t| t != "None")),
                config_str: &env.config_str,
                repeats,
                skill_types: &main.skill_types,
            },
        );
    }

    // ---- Seals (Unleash) (CalcOffence.lua:944-966, the `UseMaxUnleash` branch is bailed on in `offence_dps::unsupported`).
    UNLEASH_DPSMULT.with(|c| c.set(None));
    let mut seal_max: Option<f64> = None;
    if skill_mod_list.flag(None, &[pom_engine::sym!("HasSeals")]) && main.skill_types.contains(&skill_type::CAN_RAPID_FIRE) && !skill_mod_list.flag(None, &[pom_engine::sym!("NoRepeatBonuses")]) {
        let seal_cooldown = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("SealGainFrequency")]) / pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("SealGainFrequency")]);
        let max = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("SealCount")]);
        env.output.insert("SealCooldown".to_string(), seal_cooldown);
        env.output.insert("SealMax".to_string(), max);
        env.output.insert("AverageBurstHits".to_string(), seal_burst_hits(max));
        env.output.insert("TimeMaxSeals".to_string(), seal_cooldown * max);
        seal_max = Some(max);
        if !skill_data.contains_key("hitTimeOverride") && skill_mod_list.flag(None, &[pom_engine::sym!("UseMaxUnleash")]) {
            // CalcOffence.lua:952-961: full-unleash branch.
            let empty = pom_engine::modstore::types::Cfg::default();
            let crit: Vec<Mod> = skill_mod_list.tabulate(Some(ModType::Inc), Some(&empty), &[pom_engine::sym!("MaxSealCrit")]).into_iter().map(|(_, m)| unsafe { (*m).clone() }).collect();
            for m in crit {
                skill_mod_list.add_mod(Mod { name: pom_engine::sym!("CritChance"), ..m });
            }
            let dmg: Vec<Mod> = skill_mod_list.tabulate(Some(ModType::More), Some(&empty), &[pom_engine::sym!("MaxSealDamage")]).into_iter().map(|(_, m)| unsafe { (*m).clone() }).collect();
            for m in dmg {
                let v = m.value.num().unwrap_or(0.0) * max;
                skill_mod_list.add_mod(Mod { name: pom_engine::sym!("Damage"), value: Value::Num(v), ..m });
            }
            let cast_time = pom_offence::data::skill_cast_time(&main.granted_effect_id).unwrap_or(0.0);
            let asm = env.output.get("ActionSpeedMod").copied().unwrap_or(1.0);
            let penalty = pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("SealRepeatPenalty")]);
            UNLEASH_DPSMULT.with(|c| c.set(Some(1.0 + max * penalty)));
            skill_data.insert("dpsMultiplier".to_string(), ScalarValue::Num(1.0 + max * penalty));
            let time_max = seal_cooldown * max;
            let alt = 1.0 / cast_time * 1.1 * pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("Speed")]) * asm;
            // `alt` is casts per second, so the cycle is max(TimeMaxSeals, 1/alt) seconds (differs from upstream).
            let cycle = if pom_offence::data::pom_fixes_on() { time_max.max(1.0 / alt) } else { time_max.max(alt) };
            skill_data.insert("hitTimeOverride".to_string(), ScalarValue::Num(cycle));
        } else if !skill_data.contains_key("hitTimeOverride") {
            let cast_time = pom_offence::data::skill_cast_time(&main.granted_effect_id).unwrap_or(0.0);
            let asm = env.output.get("ActionSpeedMod").copied().unwrap_or(1.0);
            let cast_rate = 1.0 / cast_time * 1.1 * pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("Speed")]) * asm;
            let penalty = pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("SealRepeatPenalty")]);
            let dps_mult = unleash_dps_multiplier(seal_cooldown, cast_rate, penalty, max);
            UNLEASH_DPSMULT.with(|c| c.set(Some(dps_mult)));
            skill_data.insert("dpsMultiplier".to_string(), ScalarValue::Num(dps_mult));
        }
        if pom_offence::bd::on() {
            // CalcOffence.lua:968-976
            let mut out = serde_json::Value::Array(vec![]);
            let mut c = pom_offence::bdbuild::Chain::new();
            c.label = Some("Gain frequency:".into());
            c.base = Some(pom_offence::bdbuild::Link::n("%.2fs ^8(base gain frequency)", skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("SealGainFrequency")])));
            c.links = vec![
                pom_offence::bdbuild::Link::n("%.2f ^8(increased/reduced gain frequency)", 1.0 + skill_mod_list.sum(ModType::Inc, Some(&cfg), &[pom_engine::sym!("SealGainFrequency")]) / 100.0),
                pom_offence::bdbuild::Link::n("%.2f ^8(action speed modifier)", env.output.get("ActionSpeedMod").copied().unwrap_or(0.0)),
            ];
            c.total = Some(pom_offence::sf!("= %.2fs ^8per Seal", seal_cooldown));
            pom_offence::bdbuild::multi_chain(&mut out, &c);
            pom_offence::bd::root(|b| pom_offence::bd::set(b, "SealGainTime", out));
        }
    }

    // ---- Trap / mine throwing speed (CalcOffence.lua:1257-1370): sets `skillData.timeOverride`,
    // which the speed block below then consumes.
    let mut trap_mine_outputs: Vec<(&str, f64)> = Vec::new();
    // `output.ProjectileCount` (CalcOffence.lua:1085-1096) is already set when the trap/mine throwing time reads it
    // through a `PerStat` tag (Barrage's throwing-time penalty); `skill_geometry` below only runs after this block.
    if (main.skill_flags.contains("mine") || main.skill_flags.contains("trap")) && main.skill_flags.contains("projectile") {
        let proj = if skill_mod_list.flag(Some(&cfg), &[pom_engine::sym!("NoAdditionalProjectiles")]) || skill_mod_list.flag(Some(&cfg), &[pom_engine::sym!("SingleProjectile")]) {
            1.0
        } else {
            let pmin = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ProjectileCountMinimum")]);
            let pmax = skill_mod_list.override_(Some(&cfg), &[pom_engine::sym!("ProjectileCountMaximum")]).and_then(|v| v.num()).unwrap_or(f64::INFINITY);
            let p = (skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ProjectileCount")]) * skill_mod_list.more(Some(&cfg), &[pom_engine::sym!("ProjectileCount")])).floor();
            p.min(pmax).max(pmin)
        };
        env.output.insert("ProjectileCount".into(), proj);
        refresh_actor(&mut skill_mod_list, &env.output, None);
    }
    {
        let sv0 = pom_offence::input::SkillView { skill_mod_list: &skill_mod_list, skill_cfg: Some(&cfg), skill_data: &skill_data, skill_flags: &main.skill_flags, skill_types: &main.skill_types, skill_totem_id: 0 };
        let has_cd = truthy(&skill_data, "trapCooldown") || truthy(&skill_data, "cooldown");
        let tick = pom_offence::data::misc("ServerTickRate");
        let mut trap_count = 1.0;
        let mut time_override: Option<f64> = None;
        if main.skill_flags.contains("trap") {
            let over = env.player.override_(None, &[pom_engine::sym!("TrapThrowCount")]).and_then(|v| v.num());
            let tf = pom_offence::misc_fields::trap_throwing(&sv0, action_speed_mod, over, has_cd);
            trap_mine_outputs.push(("TrapThrowingSpeed", tf.throwing_speed));
            trap_mine_outputs.push(("TrapThrowingTime", tf.throwing_time));
            trap_mine_outputs.push(("TrapThrowCount", tf.throw_count));
            trap_count = tf.throw_count;
            time_override = Some(tf.throwing_time / tf.throw_count);
            let base_cd = num(&skill_data, "trapCooldown").or_else(|| num(&skill_data, "cooldown"));
            if base_cd.is_some() || skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("CooldownRecovery")]) != 0.0 {
                let tc = match base_cd {
                    Some(bc) => pom_offence::misc_fields::trap_cooldown(&sv0, bc),
                    None => pom_offence::cooldown::calc_skill_cooldown(&skill_mod_list, Some(&cfg), num(&skill_data, "cooldown"), num(&skill_data, "storedUses"), num(&skill_data, "vaalStoredUses")).0,
                };
                trap_mine_outputs.push(("TrapCooldown", tc));
            }
        }
        if main.skill_flags.contains("mine") {
            let mut base_speed = 1.0 / skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("MineLayingTime")]);
            let time_mod = pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("SkillMineThrowingTime")]);
            if time_mod > 0.0 {
                base_speed *= 1.0 / time_mod;
            }
            let mut speed = base_speed * pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("MineLayingSpeed")]) * action_speed_mod;
            let mut mine_count = pom_offence::tools::calc_lib_val(&skill_mod_list, "MineThrowCount", Some(&cfg));
            if has_cd {
                mine_count = 1.0;
            }
            if let Some(o) = env.player.override_(None, &[pom_engine::sym!("MineThrowCount")]).and_then(|v| v.num()) {
                mine_count = o;
            }
            if mine_count >= 1.0 {
                speed /= 1.0 + (mine_count - 1.0) * 0.1;
            }
            speed = speed.min(tick);
            let laying_time = 1.0 / speed;
            trap_mine_outputs.push(("MineThrowCount", mine_count));
            trap_mine_outputs.push(("MineLayingSpeed", speed));
            trap_mine_outputs.push(("MineLayingTime", laying_time));
            time_override = Some(if main.skill_flags.contains("trap") { laying_time / mine_count / trap_count } else { laying_time / mine_count });
        }
        if let Some(t) = time_override {
            skill_data.insert("timeOverride".to_string(), ScalarValue::Num(t));
        }
    }
    for (k, v) in &trap_mine_outputs {
        env.output.insert(k.to_string(), *v);
    }
    // Trap trigger / mine detonation radius (CalcOffence.lua:1311-1314, 1394-1398).
    for (flag, mod_name, base_key, out_key) in [("trap", "TrapTriggerAreaOfEffect", "TrapTriggerRadiusBase", "TrapTriggerRadius"), ("mine", "MineDetonationAreaOfEffect", "MineDetonationRadiusBase", "MineDetonationRadius")] {
        if main.skill_flags.contains(flag) {
            let (inc, more) = pom_offence::tools::calc_lib_mods(&skill_mod_list, Some(&cfg), &[mod_name]);
            let area_mod = pom_offence::area::calc_area_mod(inc, more);
            let radius = pom_offence::area::calc_radius(pom_offence::data::misc(base_key), area_mod, None);
            env.output.insert(out_key.to_string(), radius);
            env.output.insert(format!("{out_key}Metre"), radius / 10.0);
        }
    }

    // CalcOffence.lua:561-562 set `output.ActiveTrapLimit/ActiveMineLimit` before the area calc reads them (`PerStat` tags).
    for k in ["ActiveTrapLimit", "ActiveMineLimit"] {
        let v = skill_mod_list.sum(ModType::Base, Some(&cfg), &[Sym::new(k)]);
        env.output.insert(k.to_string(), v);
    }
    refresh_actor(&mut skill_mod_list, &env.output, None);
    // `runSkillFunc("initialFunc")` (CalcOffence.lua:516) precedes `calcAreaOfEffect`: Cyclone's melee-range multiplier feeds its AoE.
    if matches!(main.granted_effect_id.as_str(), "Cyclone" | "CycloneAltX" | "VaalCyclone") {
        let hand_cfg = |src: &pom_offence::weapon::WeaponSource, pre: Option<u64>, cond: &str| pre.or_else(|| src.weapon_type.as_deref().and_then(|ty| pom_offence::weapon::weapon_flags(ty, src.counts_as_all_1h))).map(|wf| pom_offence::weapon::weapon_cfg(&cfg, wf, cond));
        let (w1_cfg, w2_cfg) = (hand_cfg(&weapon1, main.weapon1_flags, "MainHandAttack"), hand_cfg(&weapon2, main.weapon2_flags, "OffHandAttack"));
        let ctx = crate::skill_funcs::HookCtx {
            id: &main.granted_effect_id,
            skill_part: cfg.skill_part.map(|p| p as i64).unwrap_or(1),
            is_totem,
            out: &env.output,
            cfg: &cfg,
            skill_types: &main.skill_types,
            skill_flags: &main.skill_flags,
            weapon1: &weapon1,
            weapon2: &weapon2,
            weapon1_cfg: w1_cfg,
            weapon2_cfg: w2_cfg,
            explode_source: main.explode_source.as_deref(),
            enemy: &env.enemy,
            tertiary_occ: &env.tertiary_occ,
            parent_out: env.parent_output.as_ref(),
        };
        crate::skill_funcs::cyclone_initial(&ctx, &mut skill_mod_list);
    }
    // Blood Sacrament `initialFunc` (other.lua:659): the per-stage reservation the reservation loop stored in skillData.
    if main.granted_effect_id == "BloodSacramentUnique" && env.output.get("LifeReservedPercent").copied().unwrap_or(0.0) < 100.0 {
        let res = crate::reservation_with(env, skills);
        let idx = skills.iter().position(|c| c.granted_effect_id == main.granted_effect_id && c.name == main.name);
        let find = |v: &[(usize, &'static str, f64)]| idx.and_then(|i| v.iter().find(|(k, p, _)| *k == i && *p == "Life").map(|(_, _, x)| *x));
        let pct = find(&res.per_skill).unwrap_or(3.0);
        let base = find(&res.per_skill_base).unwrap_or(f64::INFINITY);
        for (n, v) in [("Multiplier:ChannelledLifeReservedPercentPerStage", pct), ("Multiplier:ChannelledLifeReservedPerStage", base)] {
            skill_mod_list.add_mod(Mod { name: Sym::new(n), ty: ModType::Base, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Blood Sacrament")), tags: (vec![]).into() });
        }
    }
    apply_skill_data_list(&skill_mod_list, &cfg, &mut skill_data);
    // Rage Vortex `preSkillTypeFunc` (act_str.lua:9082, run at CalcOffence.lua:1054, before the area calc).
    if main.granted_effect_id == "RageVortex" && cfg.skill_part.map(|p| p as i64).unwrap_or(1) == 2 {
        let max_rage = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("MaximumRage")]);
        let sacrifice = num(&skill_data, "MaxRageVortexSacrificePercentage").unwrap_or(0.0) / 100.0;
        let config_override = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("Multiplier:RageSacrificedStacks")]);
        let max_sacrificed = (sacrifice * max_rage).floor();
        let stacks = (if config_override > 0.0 { config_override } else { max_sacrificed }).min(max_sacrificed);
        skill_mod_list.add_mod(Mod { name: pom_engine::sym!("Multiplier:RageSacrificed"), ty: ModType::Base, value: Value::Num(stacks), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Skill:RageVortex")), tags: (vec![]).into() });
    }
    // Bane / Bane of Condemnation `preSkillTypeFunc` (act_int.lua:1470, run at CalcOffence.lua:1054): count the
    // curses of this socket group that Bane applies (`Condition:AppliedByBane`), up to the enemy curse limit.
    if main.granted_effect_id == "Bane" || main.granted_effect_id == "BaneAltX" {
        let limit = env.output.get("EnemyCurseLimit").copied();
        let mut curse_count = 0.0;
        for sk in skills {
            let by_bane = sk.skill_mod_list.iter().any(|m| m.name.as_str() == "Condition:AppliedByBane" && m.ty == ModType::Flag && m.tags.is_empty() && m.value.truthy());
            if sk.group_index == main.group_index && by_bane {
                curse_count += 1.0;
                if Some(curse_count) == limit {
                    break;
                }
            }
        }
        skill_mod_list.add_mod(Mod { name: pom_engine::sym!("Multiplier:CurseApplied"), ty: ModType::Base, value: Value::Num(curse_count), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Base")), tags: (vec![]).into() });
    }
    // CalcPerform.lua:2287-2292: Penance Brand of Dissipation part 2 sits at the pulse count its own activation
    // frequency and duration sustain (upstream reads HitSpeed and Duration from the skill's cached output;
    // neither depends on the stage multipliers), so the stage mods exist before the area calc.
    if main.granted_effect_id == "PenanceBrandAltX" && cfg.skill_part.map(|p| p as i64).unwrap_or(1) == 2 {
        if let Some(rf) = num(&skill_data, "repeatFrequency") {
            let hto = rf / (1.0 + skill_mod_list.sum(ModType::Inc, Some(&cfg), &[pom_engine::sym!("Speed"), pom_engine::sym!("BrandActivationFrequency")]) / 100.0) / skill_mod_list.more(Some(&cfg), &[pom_engine::sym!("BrandActivationFrequency")]);
            let dd = pom_offence::cooldown::DurationSkillData {
                duration: num(&skill_data, "duration").unwrap_or(0.0),
                duration_secondary: num(&skill_data, "durationSecondary").unwrap_or(0.0),
                duration_tertiary: num(&skill_data, "durationTertiary").unwrap_or(0.0),
                aura_duration: num(&skill_data, "auraDuration").unwrap_or(0.0),
                debuff: truthy(&skill_data, "debuff"),
                debuff_secondary: truthy(&skill_data, "debuffSecondary"),
                debuff_tertiary: truthy(&skill_data, "debuffTertiary"),
                mine_duration_applies_to_skill: truthy(&skill_data, "mineDurationAppliesToSkill"),
                minion_permanent_duration: false,
            };
            let duration = pom_offence::cooldown::calc_duration_output(&skill_mod_list, Some(&cfg), &dd, true, &env.enemy).duration.unwrap_or(0.0);
            let ticks = (((1.0 / hto) * duration).floor() - 1.0).min(19.0).max(0.0);
            for k in ["MaxStages", "StageAfterFirst"] {
                skill_mod_list.add_mod(Mod { name: Sym::new(&format!("Multiplier:PenanceBrandofDissipation{k}")), ty: ModType::Base, value: Value::Num(ticks), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Base")), tags: (vec![]).into() });
            }
            // `skillData.radiusExtra` carries a Multiplier tag on the stage count (act_int.lua:13921).
            apply_skill_data_list(&skill_mod_list, &cfg, &mut skill_data);
        }
    }
    let sv = pom_offence::input::SkillView { skill_mod_list: &skill_mod_list, skill_cfg: Some(&cfg), skill_data: &skill_data, skill_flags: &main.skill_flags, skill_types: &main.skill_types, skill_totem_id: 0 };
    // ---- Old tranche: area/duration/repeats-limits/totem/brand/corpse (self-contained fields)
    crate::skillgeo::skill_geometry(env, main, &skill_mod_list, &cfg, &skill_data);
    crate::skillgeo::warcry_outputs(env, main, skills, &skill_mod_list, &cfg);
    // CalcOffence.lua:1403-1406: mine aura radius reads AreaOfEffectMod set by calcAreaOfEffect.
    if main.skill_flags.contains("mine") && main.skill_types.contains(&pom_skills::skill_type::AURA) {
        let am = env.output.get("AreaOfEffectMod").copied().unwrap_or(0.0);
        let r = pom_offence::area::calc_radius(pom_offence::data::misc("MineAuraRadiusBase"), am, None);
        env.output.insert("MineAuraRadius".to_string(), r);
        env.output.insert("MineAuraRadiusMetre".to_string(), r / 10.0);
    }

    let dur_data = pom_offence::cooldown::DurationSkillData {
        duration: num(&skill_data, "duration").unwrap_or(0.0),
        duration_secondary: num(&skill_data, "durationSecondary").unwrap_or(0.0),
        duration_tertiary: num(&skill_data, "durationTertiary").unwrap_or(0.0),
        aura_duration: num(&skill_data, "auraDuration").unwrap_or(0.0),
        debuff: truthy(&skill_data, "debuff"),
        debuff_secondary: truthy(&skill_data, "debuffSecondary"),
        debuff_tertiary: truthy(&skill_data, "debuffTertiary"),
        mine_duration_applies_to_skill: truthy(&skill_data, "mineDurationAppliesToSkill"),
        minion_permanent_duration: false, // no live minion actor - see module doc comment
    };
    let dur = pom_offence::cooldown::calc_duration_output(&skill_mod_list, Some(&cfg), &dur_data, true, &env.enemy);
    env.output.insert("DurationMod".to_string(), dur.duration_mod);
    if let Some(d) = dur.duration {
        env.output.insert("Duration".to_string(), d);
    }
    if let Some(d) = dur.duration_secondary {
        env.output.insert("DurationSecondary".to_string(), d);
    }
    if let Some(d) = dur.duration_tertiary {
        env.output.insert("DurationTertiary".to_string(), d);
    }
    if let Some(d) = dur.aura_duration {
        env.output.insert("AuraDuration".to_string(), d);
    }
    // `output.ImpaleDurationMod`/`ImpaleDuration` (CalcOffence.lua:1639-1642).
    {
        let mode = pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("ImpaleDuration")]).max(0.0);
        let tick = pom_offence::data::misc("ServerTickRate");
        let debuff_expire_faster = pom_offence::tools::calc_lib_mod_s(&env.enemy, Some(&cfg), &[pom_engine::sym!("BuffExpireFaster")]);
        let debuff_duration_mult = if pom_calc::setup::buff_mode().effective { 1.0 / pom_offence::data::misc("BuffExpirationSlowCap").max(debuff_expire_faster) } else { 1.0 };
        let base = pom_offence::data::character_constant("impaled_debuff_base_duration_ms") / 1000.0;
        env.output.insert("ImpaleDurationMod".to_string(), mode);
        env.output.insert("ImpaleDuration".to_string(), (base * mode * tick * debuff_duration_mult).ceil() / tick);
    }
    if is_totem {
        let totems_summoned_override = env.player.override_(None, &[pom_engine::sym!("TotemsSummoned")]).and_then(|v| v.num());
        let totem = pom_offence::misc_fields::totem_limits(&sv, totems_summoned_override);
        env.output.insert("ActiveTotemLimit".to_string(), totem.active_totem_limit);
        env.output.insert("TotemsSummoned".to_string(), totem.totems_summoned);
        env.output.insert("TotemEnergyShield".to_string(), totem.totem_energy_shield);
        env.output.insert("TotemBlockChance".to_string(), totem.totem_block_chance);
        env.output.insert("TotemArmour".to_string(), totem.totem_armour);
        // CalcOffence.lua:1440: `calcs.calcTotemLife` (skillTotemId from CalcActiveSkill.lua:443-451)
        if let (Some(level), Some(ge)) = (num(&skill_data, "totemLevel"), pom_skills::data::granted_effect_by_skill_id(&main.granted_effect_id)) {
            let id = match ge.extra.get("skillTotemId").and_then(|v| v.as_i64()) {
                Some(i) => i,
                None => match ge.color {
                    Some(2) => 2,
                    Some(3) => 3,
                    _ => 1,
                },
            };
            let (life, life_mod) = pom_offence::cooldown::calc_totem_life(&skill_mod_list, Some(&cfg), level as i64, id);
            env.output.insert("TotemLife".to_string(), life);
            env.output.insert("TotemLifeMod".to_string(), life_mod);
        }
        // CalcOffence.lua:1414-1421
        let base_speed = 1.0 / skill_mod_list.sum(ModType::Base, Some(&cfg), &[Sym::new(if is_ballista { "BallistaPlacementTime" } else { "TotemPlacementTime" })]);
        let placement_speed = base_speed * pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("TotemPlacementSpeed")]) * env.output.get("ActionSpeedMod").copied().unwrap_or(1.0);
        env.output.insert("TotemPlacementSpeed".to_string(), placement_speed);
        env.output.insert("TotemPlacementTime".to_string(), 1.0 / placement_speed);
    }

    if has_brand {
        let brand = pom_offence::misc_fields::brand_fields(&sv);
        env.output.insert("BrandAttachmentRange".to_string(), brand.attachment_range);
        env.output.insert("BrandAttachmentRangeMetre".to_string(), brand.attachment_range_metre);
        env.output.insert("ActiveBrandLimit".to_string(), brand.active_brand_limit);
        if let Some(v) = brand.attached_brand_count {
            env.output.insert("AttachedBrandCount".to_string(), v);
        }
        // CalcOffence.lua:1910-1912.
        {
            let n = env.output.get("AttachedBrandCount").copied().unwrap_or(0.0);
            let label = if truthy(&skill_data, "countsAttachedBrandsInDamage") { "Average Damage" } else { "DPS" };
            info_msg = Some(format!("{} for {} attached Brand{}", label, n as i64, if n == 1.0 { "" } else { "s" }));
        }
    }

    if has_corpse {
        let corpse = pom_offence::misc_fields::corpse_fields(&sv, env.enemy_level as i64);
        env.output.insert("CorpseLevel".to_string(), corpse.corpse_level);
        env.output.insert("BaseCorpseLife".to_string(), corpse.base_corpse_life);
        env.output.insert("CorpseLifeInc".to_string(), corpse.corpse_life_inc);
        env.output.insert("CorpseLife".to_string(), corpse.corpse_life);
    }
    let damage_effectiveness = pom_offence::basedamage::damage_effectiveness(num(&skill_data, "damageEffectiveness"));
    let base_multiplier = pom_offence::basedamage::base_multiplier(num(&skill_data, "baseMultiplier"));

    // ---- Repeats (needed by crit/speed below) (CalcOffence.lua:808-819)
    let repeat_eligible = eligible_for_repeats(&main.skill_types);
    let (repeats, repeat_count) = pom_offence::misc_fields::repeats(&sv, repeat_eligible);
    env.output.insert("Repeats".to_string(), repeats);
    if let Some(rc) = repeat_count {
        env.output.insert("RepeatCount".to_string(), rc);
    }

    // ---- Cooldown (CalcOffence.lua:296-309), needed by speed below.
    let (cooldown, cooldown_rounded) = pom_offence::cooldown::calc_skill_cooldown(&skill_mod_list, Some(&cfg), num(&skill_data, "cooldown"), num(&skill_data, "storedUses"), num(&skill_data, "vaalStoredUses"));
    // Lua only runs this block (`elseif skillData.cooldown or Sum("BASE","CooldownRecovery") ~= 0`, 1319) for
    // non-trap skills, and a computed 0 is still a set (truthy) `output.Cooldown`.
    let has_cd_out = !main.skill_flags.contains("trap")
        && (num(&skill_data, "cooldown").is_some() || skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("CooldownRecovery")]) != 0.0);
    if has_cd_out {
        env.output.insert("Cooldown".to_string(), cooldown);
        let _ = cooldown_rounded;
    }
    // ---- Skill uptime (CalcOffence.lua:1662-1690); "reserveDuration" is never an output key.
    if !main.skill_types.contains(&skill_type::VAAL) {
        let cd = env.output.get("Cooldown").copied().unwrap_or(0.0);
        let no_rec = skill_mod_list.flag(Some(&cfg), &[pom_engine::sym!("NoCooldownRecoveryInDuration")]);
        for dt in ["Duration", "DurationSecondary", "DurationTertiary", "AuraDuration"] {
            let d = env.output.get(dt).copied().unwrap_or(0.0);
            if d != 0.0 && cd != 0.0 {
                let up = if no_rec { d / (cd + d) } else { d / cd };
                env.output.insert(format!("{dt}Uptime"), up.min(1.0) * 100.0);
            }
        }
    }

    crate::bd_b::skill_blocks(env, main, &cfg, &skill_data, &skill_mod_list, cooldown_rounded);

    // ---- runSkillFunc("preDamageFunc") (CalcOffence.lua:1908): a skill's own hook may rewrite
    // `skillData`/`skillModList`. One that is not ported (or needs an unproduced output) makes the
    // damage/DPS stage unavailable for this skill.
    let mut hook_ok = true;
    if crate::skill_hooks::has_hook(&main.granted_effect_id) {
        let hand_cfg = |src: &pom_offence::weapon::WeaponSource, pre: Option<u64>, cond: &str| pre.or_else(|| src.weapon_type.as_deref().and_then(|ty| pom_offence::weapon::weapon_flags(ty, src.counts_as_all_1h))).map(|wf| pom_offence::weapon::weapon_cfg(&cfg, wf, cond));
        let (w1_cfg, w2_cfg) = (hand_cfg(&weapon1, main.weapon1_flags, "MainHandAttack"), hand_cfg(&weapon2, main.weapon2_flags, "OffHandAttack"));
        let ctx = crate::skill_funcs::HookCtx {
            id: &main.granted_effect_id,
            skill_part: cfg.skill_part.map(|p| p as i64).unwrap_or(1),
            is_totem,
            out: &env.output,
            cfg: &cfg,
            skill_types: &main.skill_types,
            skill_flags: &main.skill_flags,
            weapon1: &weapon1,
            weapon2: &weapon2,
            weapon1_cfg: w1_cfg,
            weapon2_cfg: w2_cfg,
            explode_source: main.explode_source.as_deref(),
            enemy: &env.enemy,
            tertiary_occ: &env.tertiary_occ,
            parent_out: env.parent_output.as_ref(),
        };
        let mut hook_out: HashMap<String, f64> = HashMap::default();
        match crate::skill_funcs::apply(&ctx, &mut skill_mod_list, &mut skill_data, &mut hook_out) {
            Ok(()) => {
                for (k, v) in hook_out {
                    env.output.insert(k, v);
                }
            }
            Err(()) => {
                hook_ok = false;
            }
        }
    }

    // Not in upstream: overlapping explosions of a shotgun skill (crate::proj_overlap), as a dpsMultiplier like Shrapnel Ballista's.
    let sequential = skill_mod_list.flag(None, &[pom_engine::sym!("SequentialProjectiles")]);
    if let Some(ov) = crate::proj_overlap::overlap(&main.granted_effect_id, &main.skill_types, sequential, env.output.get("ProjectileCount").copied().unwrap_or(1.0), &env.config_input) {
        skill_data.insert("dpsMultiplier".to_string(), ScalarValue::Num(num(&skill_data, "dpsMultiplier").unwrap_or(1.0) * ov));
    }

    // ---- Handle corpse and enemy explosions (CalcOffence.lua:1915-1928)
    {
        let corpse_life = num(&skill_data, "corpseLife");
        let monster_life = corpse_life.unwrap_or_else(|| if env.enemy_level > 0.0 { pom_offence::data::monster_life_table(env.enemy_level as i64) } else { 100.0 });
        if truthy(&skill_data, "explodeCorpse") && (corpse_life.is_some() || env.enemy_level > 0.0) {
            let damage_type = match skill_data.get("corpseExplosionDamageType") {
                Some(ScalarValue::Str(t)) => t.to_string(),
                _ => "Fire".to_string(),
            };
            if let Some(mult) = num(&skill_data, "corpseExplosionLifeMultiplier").or_else(|| num(&skill_data, "selfFireExplosionLifeMultiplier")) {
                skill_data.insert(format!("{damage_type}BonusMin"), ScalarValue::Num(monster_life * mult));
                skill_data.insert(format!("{damage_type}BonusMax"), ScalarValue::Num(monster_life * mult));
            }
        }
        if flag("monsterExplode") {
            for damage_type in ["Physical", "Lightning", "Cold", "Fire", "Chaos"] {
                let base = num(&skill_data, &format!("{damage_type}EffectiveExplodePercentage")).unwrap_or(0.0) * monster_life / 100.0;
                skill_data.insert(format!("{damage_type}Min"), ScalarValue::Num(base));
                skill_data.insert(format!("{damage_type}Max"), ScalarValue::Num(base));
            }
        }
    }

    // ---- Configure damage passes (CalcOffence.lua:1997-2065)
    struct Pass {
        label: &'static str,
        prefix: &'static str,
        source: pom_offence::weapon::WeaponSource,
        cfg: pom_engine::modstore::types::Cfg,
        out: HashMap<String, f64>,
        conv: pom_offence::conversion::ConversionTable,
    }
    let mut passes: Vec<Pass> = Vec::new();
    // `output.Chain` and friends were written after the last actor snapshot; a `StatThreshold`/`PerStat` mod read
    // while building the conversion tables (Gloomfang's chain-gated gain-as-chaos) reads the live output.
    refresh_actor(&mut skill_mod_list, &env.output, None);
    if is_attack {
        if env.keystones_added.contains("Precise Technique") {
            env.output.insert("PreciseTechnique".to_string(), 1.0);
        }
        let crit_override = skill_mod_list.override_(Some(&cfg), &[pom_engine::sym!("WeaponBaseCritChance")]).and_then(|v| v.num());
        if flag("weapon1Attack") {
            pom_offence::bd::begin_pass("MainHand");
            let mut source = weapon1.clone();
            if let Some(co) = crit_override {
                if source.weapon_type.as_deref().is_some_and(|t| t != "None") {
                    source.set("CritChance", co);
                }
            }
            if let Some(wf) = main.weapon1_flags.or_else(|| source.weapon_type.as_deref().and_then(|t| pom_offence::weapon::weapon_flags(t, source.counts_as_all_1h))) {
                let wcfg = pom_offence::weapon::weapon_cfg(&cfg, wf, "MainHandAttack");
                let conv = pom_offence::conversion::build_conversion_table(&skill_mod_list, Some(&wcfg));
                passes.push(Pass { label: "MainHand", prefix: "MainHand.", source, cfg: wcfg, out: HashMap::default(), conv });
            }
        }
        if flag("weapon2Attack") {
            pom_offence::bd::begin_pass("OffHand");
            let mut source = weapon2.clone();
            if let Some(co) = crit_override {
                if source.weapon_type.as_deref().is_some_and(|t| t != "None") {
                    source.set("CritChance", co);
                }
            }
            if let Some(cc) = num(&skill_data, "critChance") {
                source.set("CritChance", cc);
            }
            if let (Some(mn), Some(mx)) = (num(&skill_data, "setOffHandPhysicalMin"), num(&skill_data, "setOffHandPhysicalMax")) {
                source.set("PhysicalMin", mn);
                source.set("PhysicalMax", mx);
            }
            if let (Some(mn), Some(mx)) = (num(&skill_data, "setOffHandFireMin"), num(&skill_data, "setOffHandFireMax")) {
                source.set("FireMin", mn);
                source.set("FireMax", mx);
            }
            if let (Some(mn), Some(mx)) = (num(&skill_data, "setOffHandColdMin"), num(&skill_data, "setOffHandColdMax")) {
                source.set("ColdMin", mn);
                source.set("ColdMax", mx);
            }
            if let Some(at) = num(&skill_data, "attackTime") {
                source.set("AttackRate", 1000.0 / at);
            }
            // shieldAttack (Spectral Shield Throw, Shield Charge): `weapon2Flags = 0` whatever the shield's own weaponData is.
            let wf2 = if flag("shieldAttack") { Some(0) } else { main.weapon2_flags.or_else(|| source.weapon_type.as_deref().and_then(|t| pom_offence::weapon::weapon_flags(t, source.counts_as_all_1h))) };
            if let Some(wf) = wf2 {
                let wcfg = pom_offence::weapon::weapon_cfg(&cfg, wf, "OffHandAttack");
                let conv = pom_offence::conversion::build_conversion_table(&skill_mod_list, Some(&wcfg));
                passes.push(Pass { label: "OffHand", prefix: "OffHand.", source, cfg: wcfg, out: HashMap::default(), conv });
            }
        }
    } else {
        let mut source = pom_offence::weapon::WeaponSource::from_skill_data(&skill_data);
        if let Some(cc) = num(&skill_data, "critChance") {
            source.set("CritChance", cc);
        }
        let conv = pom_offence::conversion::build_conversion_table(&skill_mod_list, Some(&cfg));
        passes.push(Pass { label: "Skill", prefix: "", source, cfg: cfg.clone(), out: HashMap::default(), conv });
    }
    pom_offence::bd::set_pass(None);
    let both_weapon_attack = flag("bothWeaponAttack");

    // ---- how often you hit: hit chance + speed per pass (CalcOffence.lua:2175-2488)
    let grant_cast_time = pom_offence::data::skill_cast_time(&main.granted_effect_id).unwrap_or(1.0); // nil castTime reads as 1 (`castTime or 1`, CalcOffence.lua:2311); only a literal 0 takes the 2273 branch
    let self_cast = flag("selfCast");
    let is_channel = main.skill_types.contains(&skill_type::CHANNEL);
    let player_out = env.output.clone();
    let mut stored_mh_accuracy: Option<(f64, f64)> = None;
    // `storedSustainedTraumaBreakdown` (CalcOffence.lua:2173): one table shared by every pass of the loop.
    let mut stored_trauma_bd = serde_json::Value::Array(vec![]);
    for p in passes.iter_mut() {
        pom_offence::bd::set_pass(pom_offence::bd::pass_scope(p.label));
        if let (Some(m), false) = (seal_max, is_attack) {
            p.out.insert("AverageBurstHits".to_string(), seal_burst_hits(m));
        }
        if let Some(v) = num(&skill_data, "averageBurstHits") {
            p.out.insert("AverageBurstHits".to_string(), v);
        } else if repeats > 1.0 && !is_attack {
            // `output.Repeats` of an attack's *pass* output is only assigned later in the same
            // iteration (CalcOffence.lua:2333), so it is still nil here for a hand pass.
            p.out.insert("AverageBurstHits".to_string(), repeats);
        }
        // hit chance
        let cannot_be_evaded = skill_mod_list.flag(Some(&p.cfg), &[pom_engine::sym!("CannotBeEvaded")]) || truthy(&skill_data, "cannotBeEvaded") || (pom_calc::setup::buff_mode().effective && env.enemy.flag(None, &[pom_engine::sym!("CannotEvade")]));
        let off_is_main = skill_mod_list.flag(None, &[pom_engine::sym!("Condition:OffHandAccuracyIsMainHandAccuracy")]);
        let ov = if off_is_main && p.label == "OffHand" { stored_mh_accuracy } else { None };
        let hit = pom_offence::hit::calc_hit_chance_ov(&skill_mod_list, &env.enemy, Some(&p.cfg), is_attack, cannot_be_evaded, ov);
        if off_is_main && p.label == "MainHand" {
            stored_mh_accuracy = Some((hit.accuracy, hit.accuracy_vs_enemy));
        }
        p.out.insert("Accuracy".to_string(), hit.accuracy);
        p.out.insert("AccuracyHitChance".to_string(), hit.accuracy_hit_chance);
        p.out.insert("enemyBlockChance".to_string(), hit.enemy_block_chance);
        p.out.insert("HitChance".to_string(), hit.hit_chance);
        if pom_offence::bd::on() {
            pom_offence::bd_c::pass_hit(&hit, !(!is_attack || cannot_be_evaded), ov.is_some(), env.enemy_level, env.config_input.contains_key("enemyLevel"));
        }
        sync_pass_stats(&mut skill_mod_list, &mut p.cfg, is_attack, &env.output, &p.out);
        // Precise Technique per-pass condition (CalcOffence.lua:2268-2270)
        skill_mod_list.conditions.insert(Sym::new(&format!("{}AccRatingHigherThanMaxLife", p.label)), hit.accuracy > player_out.get("Life").copied().unwrap_or(0.0));
        // Trauma (CalcOffence.lua:2317-2396), only reached by the general (non-override) speed branch.
        {
            let general_branch = !(grant_cast_time == 0.0 && num(&skill_data, "castTimeOverride").is_none() && !truthy(&skill_data, "triggered"))
                && num(&skill_data, "timeOverride").is_none()
                && !truthy(&skill_data, "fixedCastTime")
                && !(num(&skill_data, "triggerTime").is_some() && truthy(&skill_data, "triggered"))
                && !(num(&skill_data, "triggerRate").is_some() && truthy(&skill_data, "triggered"));
            if general_branch {
                let base_time = pom_offence::speed::base_time(&skill_mod_list, Some(&p.cfg), Some(&cfg), is_attack, grant_cast_time, num(&skill_data, "castTimeOverride"), p.source.get_opt("AttackRate"), p.source.get_opt("AttackSpeedInc").unwrap_or(0.0), num(&skill_data, "attackSpeedMultiplier"), truthy(&skill_data, "castTimeOverridesAttackTime"));
                let sum = |sml: &ModStore, c: &pom_engine::modstore::types::Cfg, ty: ModType, n: &str| sml.sum(ty, Some(c), &[Sym::new(n)]);
                if skill_mod_list.flag(None, &[pom_engine::sym!("HasTrauma")]) {
                    let more = skill_mod_list.more(Some(&p.cfg), &[pom_engine::sym!("Speed")]);
                    let effective_attack_rate_cap = pom_offence::data::misc("ServerTickRate") * repeats;
                    let duration = sum(&skill_mod_list, &p.cfg, ModType::Base, "TraumaDuration") * pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("Duration")]);
                    let trauma_per_attack = 1.0 + sum(&skill_mod_list, &p.cfg, ModType::Base, "ExtraTrauma").min(100.0) / 100.0;
                    let inc_per_trauma = sum(&skill_mod_list, &cfg, ModType::Inc, "SpeedPerTrauma");
                    let config_trauma = sum(&skill_mod_list, &cfg, ModType::Base, "Multiplier:TraumaStacks");
                    let inc = sum(&skill_mod_list, &p.cfg, ModType::Inc, "Speed") - inc_per_trauma * config_trauma;
                    let before_inc = 1.0 / base_time * action_speed_mod * more;
                    let inc_cap = (effective_attack_rate_cap - before_inc * (1.0 + inc / 100.0)) / before_inc * 100.0;
                    let hit_chance = p.out.get("HitChance").copied().unwrap_or(0.0);
                    let rate_before_inc = trauma_per_attack * (hit_chance / 100.0) * before_inc / repeats;
                    let mut trauma = rate_before_inc * (1.0 + inc / 100.0) / (1.0 / duration - rate_before_inc * inc_per_trauma / 100.0);
                    let trauma_breakdown = trauma;
                    let mut invalid = false;
                    if trauma < 0.0 || inc_per_trauma * trauma > inc_cap {
                        trauma = trauma_per_attack * (hit_chance / 100.0) * effective_attack_rate_cap / repeats * duration;
                        invalid = true;
                    }
                    if both_weapon_attack {
                        trauma /= 2.0;
                    }
                    skill_mod_list.add_mod(Mod { name: pom_engine::sym!("Multiplier:SustainableTraumaStacks"), ty: ModType::Base, value: Value::Num(trauma), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Maximum Sustainable Trauma Stacks")), tags: (vec![]).into() });
                    if pom_offence::bd::on() {
                        stored_trauma_bd = serde_json::Value::Array(vec![]);
                        pom_offence::bd_d::trauma(&mut stored_trauma_bd, &pom_offence::bd_d::Trauma {
                            inc_attack_speed_per_trauma: inc_per_trauma,
                            attack_speed_before_inc: before_inc,
                            inc,
                            trauma_per_attack,
                            hit_chance: hit_chance / 100.0,
                            duration,
                            repeats,
                            base_time,
                            more,
                            action_speed_mod,
                            trauma_rate_before_inc: rate_before_inc,
                            trauma_breakdown,
                            invalid,
                            effective_attack_rate_cap,
                            trauma,
                        });
                    }
                }
                if sum(&skill_mod_list, &cfg, ModType::Base, "Multiplier:TraumaStacks") == 0.0 {
                    let v = sum(&skill_mod_list, &cfg, ModType::Base, "Multiplier:SustainableTraumaStacks");
                    skill_mod_list.add_mod(Mod { name: pom_engine::sym!("Multiplier:TraumaStacks"), ty: ModType::Base, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Maximum Sustainable Trauma Stacks")), tags: (vec![]).into() });
                }
            }
        }
        // speed
        let speed = pom_offence::speed::calc_speed(
            &skill_mod_list,
            Some(&p.cfg),
            Some(&cfg),
            is_attack,
            is_channel,
            self_cast,
            grant_cast_time,
            num(&skill_data, "castTimeOverride"),
            truthy(&skill_data, "triggered"),
            // A trap/mine cooldown limits the throw rate (differs from upstream).
            match (num(&skill_data, "timeOverride"), env.output.get("TrapCooldown").or(env.output.get("Cooldown"))) {
                (Some(t), Some(&cd)) if pom_offence::data::pom_fixes_on() => Some(t.max(cd)),
                (t, _) => t,
            },
            truthy(&skill_data, "fixedCastTime"),
            num(&skill_data, "triggerTime"),
            num(&skill_data, "triggerRate"),
            p.source.get_opt("AttackRate"),
            p.source.get_opt("AttackSpeedInc").unwrap_or(0.0),
            num(&skill_data, "attackSpeedMultiplier"),
            truthy(&skill_data, "castTimeOverridesAttackTime"),
            action_speed_mod,
            if has_cd_out { Some(cooldown) } else { None },
            repeats,
            pom_offence::data::misc("ServerTickRate"),
            if flag("totem") { Some(1.0 + env.player.sum(ModType::Inc, None, &[pom_engine::sym!("TotemActionSpeed")]) / 100.0) } else { None },
            if flag("warcry") { env.output.get("WarcryCastTime").copied() } else { None },
        );
        p.out.insert("Speed".to_string(), speed.speed);
        p.out.insert("Time".to_string(), speed.time);
        if speed.has_cast_rate && flag("totem") {
            p.out.insert("TotemActionSpeed".to_string(), 1.0 + env.player.sum(ModType::Inc, None, &[pom_engine::sym!("TotemActionSpeed")]) / 100.0);
        }
        if speed.has_cast_rate {
            p.out.insert("CastRate".to_string(), speed.cast_rate);
            p.out.insert("Repeats".to_string(), repeats);
            if has_cd_out {
                p.out.insert("Cooldown".to_string(), cooldown);
            }
        }
        if let Some(t) = speed.trigger_time {
            p.out.insert("TriggerTime".to_string(), t);
        }
        // Calcs breakdown of the general speed branch (CalcOffence.lua:2427-2460): `breakdown.Speed`, `breakdown.Time`.
        if pom_offence::bd::on() {
            let general_branch = !(grant_cast_time == 0.0 && num(&skill_data, "castTimeOverride").is_none() && !truthy(&skill_data, "triggered"))
                && num(&skill_data, "timeOverride").is_none()
                && !truthy(&skill_data, "fixedCastTime")
                && !(num(&skill_data, "triggerTime").is_some() && truthy(&skill_data, "triggered"))
                && !(num(&skill_data, "triggerRate").is_some() && truthy(&skill_data, "triggered"));
            if general_branch {
                pom_offence::bd::set_pass(pom_offence::bd::pass_scope(p.label));
                let base_time = pom_offence::speed::base_time(&skill_mod_list, Some(&p.cfg), Some(&cfg), is_attack, grant_cast_time, num(&skill_data, "castTimeOverride"), p.source.get_opt("AttackRate"), p.source.get_opt("AttackSpeedInc").unwrap_or(0.0), num(&skill_data, "attackSpeedMultiplier"), truthy(&skill_data, "castTimeOverridesAttackTime"));
                let more = skill_mod_list.more(Some(&p.cfg), &[pom_engine::sym!("Speed")]);
                let inc = skill_mod_list.sum(ModType::Inc, Some(&p.cfg), &[pom_engine::sym!("Speed")]);
                let totem_speed = p.out.get("TotemActionSpeed").copied();
                let action_link = if flag("totem") { totem_speed.unwrap_or(1.0) } else if self_cast { action_speed_mod } else { 1.0 };
                pom_offence::bd_d::speed(base_time, inc, more, action_link, speed.cast_rate, if has_cd_out { Some(cooldown) } else { None }, repeats, speed.speed);
                let sat = pom_offence::tools::calc_lib_mod_s(&skill_mod_list, Some(&cfg), &[pom_engine::sym!("SkillAttackTime")]);
                if sat > 0.0 {
                    pom_offence::bd_d::time(speed.speed, sat, speed.time);
                }
            }
        }
        // HitTime/HitSpeed (CalcOffence.lua:2467-2488), the in-pass version used by non-attacks.
        {
            // The pass `output.Cooldown` (2426) is only ever set in the spell/cast branch.
            let pass_cd = p.out.get("Cooldown").copied();
            let triggered_on_death = truthy(&skill_data, "triggeredOnDeath");
            if let (Some(hto), false) = (num(&skill_data, "hitTimeOverride"), triggered_on_death) {
                p.out.insert("HitTime".to_string(), hto);
                p.out.insert("HitSpeed".to_string(), 1.0 / hto);
                // Brands always have hitTimeOverride (CalcOffence.lua:2474-2476).
                if has_brand && !skill_mod_list.flag(None, &[pom_engine::sym!("UnlimitedBrandDuration")]) {
                    p.out.insert("BrandTicks".to_string(), (env.output.get("Duration").copied().unwrap_or(0.0) * (1.0 / hto)).floor());
                }
            } else if let (Some(htm), false) = (num(&skill_data, "hitTimeMultiplier"), triggered_on_death) {
                let hit_time = speed.time * htm;
                p.out.insert("HitTime".to_string(), hit_time);
                let hs = match pass_cd {
                    Some(cd) if truthy(&skill_data, "triggered") => 1.0 / hit_time.max(cd),
                    Some(cd) => 1.0 / (hit_time + cd),
                    None => 1.0 / hit_time,
                };
                p.out.insert("HitSpeed".to_string(), hs);
            }
        }
    }
    pom_offence::bd::set_pass(None);
    // `breakdown.SustainableTrauma = storedSustainedTraumaBreakdown` (CalcOffence.lua:2503): `{ }` unless a pass filled it.
    pom_offence::bd::root(|b| pom_offence::bd::set(b, "SustainableTrauma", stored_trauma_bd.clone()));

    if let Some((orig_hto, gc_cd)) = gc_state {
        // `mainSkillOutputCache.HitTime or Time` of the un-mirage'd skill (CalcMirages.lua:398-401).
        let time = passes.first().and_then(|p| p.out.get("Time").copied()).unwrap_or(0.0);
        let cached = if let Some(h) = orig_hto { h } else if let Some(htm) = num(&skill_data, "hitTimeMultiplier") { time * htm } else { time };
        let cd = gc_cd.max(cached);
        skill_mod_list.add_mod(Mod { name: pom_engine::sym!("DPS"), ty: ModType::More, value: Value::Num((1.0 / cd - 1.0) * 100.0), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("General's Cry Cooldown")), tags: (vec![]).into() });
    }
    // `skillData.dpsMultiplier` (CalcOffence.lua:2490-2497)
    let mut dps_multiplier = skill_data_dps_multiplier(&skill_data) * (1.0 + skill_mod_list.sum(ModType::Inc, Some(&cfg), &[pom_engine::sym!("DPS")]) / 100.0) * skill_mod_list.more(Some(&cfg), &[pom_engine::sym!("DPS")]);
    // A trap's "chance to Trigger an additional time" adds that share of a second trigger per trap, to hit TotalDPS only (not ailments, DoT, impale or leech); upstream has no consumer.
    let trap_trigger_twice = if pom_offence::data::pom_fixes_on() && main.skill_flags.contains("trap") { 1.0 + skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("TrapTriggerTwiceChance")]) / 100.0 } else { 1.0 };
    if has_brand && !truthy(&skill_data, "countsAttachedBrandsInDamage") {
        let sv = pom_offence::input::SkillView { skill_mod_list: &skill_mod_list, skill_cfg: Some(&cfg), skill_data: &skill_data, skill_flags: &main.skill_flags, skill_types: &main.skill_types, skill_totem_id: 0 };
        let bc = pom_offence::misc_fields::brand_fields(&sv).attached_brand_count.unwrap_or(1.0);
        dps_multiplier *= bc;
        env.output.insert("SkillDPSMultiplier".to_string(), bc);
    }
    if env.config_str.get("repeatMode").map(|s| s.as_str()) == Some("FINAL") || skill_mod_list.flag(None, &[pom_engine::sym!("OnlyFinalRepeat")]) {
        dps_multiplier /= repeats;
    }
    pom_offence::bd::set_pass(None);
    if skill_mod_list.flag(None, &[pom_engine::sym!("HasTrauma")]) {
        // CalcOffence.lua:2504 (after the pass loop, so on the global output)
        let v = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("Multiplier:SustainableTraumaStacks")]);
        env.output.insert("SustainableTrauma".to_string(), v);
    }

    // ---- combine hit chance and attack speed (CalcOffence.lua:2508-2540), then quantity multiplier
    let combine = |passes: &[Pass], stat: &str, mode: &str, chance_stat: Option<&str>, skill_data: &HashMap<String, ScalarValue>| -> Option<f64> {
        let mh = passes.iter().find(|p| p.label == "MainHand").and_then(|p| p.out.get(stat).copied());
        let oh = passes.iter().find(|p| p.label == "OffHand").and_then(|p| p.out.get(stat).copied());
        if mode == "OR" || !both_weapon_attack {
            return mh.or(oh);
        }
        match mode {
            "AVERAGE" => Some((mh.unwrap_or(0.0) + oh.unwrap_or(0.0)) / 2.0),
            "HARMONICMEAN" => {
                let (m, o) = (mh?, oh?);
                Some(if m == 0.0 || o == 0.0 { 0.0 } else { 2.0 / (1.0 / m + 1.0 / o) })
            }
            "DPS" => {
                let v = mh.unwrap_or(0.0) + oh.unwrap_or(0.0);
                Some(if truthy(skill_data, "doubleHitsWhenDualWielding") { v } else { v / 2.0 })
            }
            "CHANCE" => match (mh, oh) {
                (Some(m), Some(o)) => {
                    let cs = chance_stat.unwrap_or(stat);
                    let mh_chance = passes.iter().find(|p| p.label == "MainHand").and_then(|p| p.out.get(cs).copied()).unwrap_or(0.0) * passes.iter().find(|p| p.label == "MainHand").map_or(0.0, |p| p.out.get("HitChance").copied().unwrap_or(0.0));
                    let oh_chance = passes.iter().find(|p| p.label == "OffHand").and_then(|p| p.out.get(cs).copied()).unwrap_or(0.0) * passes.iter().find(|p| p.label == "OffHand").map_or(0.0, |p| p.out.get("HitChance").copied().unwrap_or(0.0));
                    if truthy(skill_data, "doubleHitsWhenDualWielding") {
                        Some(m * mh_chance / 10000.0 + o * oh_chance / 10000.0)
                    } else {
                        let (mp, op) = (mh_chance / (mh_chance + oh_chance), oh_chance / (mh_chance + oh_chance));
                        Some(m * mp + o * op)
                    }
                }
                _ => mh.or(oh),
            },
            _ => mh.or(oh),
        }
    };

    if is_attack {
        for (stat, mode) in [("AccuracyHitChance", "AVERAGE"), ("HitChance", "AVERAGE"), ("Speed", "HARMONICMEAN"), ("HitSpeed", "OR"), ("HitTime", "OR")] {
            if let Some(v) = combine(&passes, stat, mode, None, &skill_data) {
                env.output.insert(stat.to_string(), v);
            }
        }
        let speed = env.output.get("Speed").copied().unwrap_or(0.0);
        let mut time = if speed == 0.0 { 0.0 } else { 1.0 / speed };
        let mut speed = speed;
        if skill_mod_list.flag(None, &[pom_engine::sym!("UseOffhandAttackSpeed")]) && !flag("forceMainHand") {
            if let Some(oh) = passes.iter().find(|p| p.label == "OffHand") {
                speed = oh.out.get("Speed").copied().unwrap_or(0.0);
                time = oh.out.get("Time").copied().unwrap_or(0.0);
            }
        }
        env.output.insert("Speed".to_string(), speed);
        env.output.insert("Time".to_string(), time);
        if pom_offence::bd::on() {
            // CalcOffence.lua:2530-2557: the hands' Speed / HitChance tables folded into the actor's own.
            let hand = |label: &str, k: &str| passes.iter().find(|p| p.label == label).and_then(|p| p.out.get(k).copied()).unwrap_or(0.0);
            let use_off = skill_mod_list.flag(None, &[pom_engine::sym!("UseOffhandAttackSpeed")]) && !flag("forceMainHand");
            pom_offence::bd_d::combine_attack(use_off, both_weapon_attack, flag("weapon1Attack"), speed, hand("MainHand", "Speed"), hand("OffHand", "Speed"), hand("MainHand", "HitChance"), hand("OffHand", "HitChance"), env.output.get("HitChance").copied().unwrap_or(0.0));
        }
        let triggered_on_death = truthy(&skill_data, "triggeredOnDeath");
        if let (Some(hto), false) = (num(&skill_data, "hitTimeOverride"), triggered_on_death) {
            env.output.insert("HitTime".to_string(), hto);
            env.output.insert("HitSpeed".to_string(), 1.0 / hto);
            if has_brand && !skill_mod_list.flag(None, &[pom_engine::sym!("UnlimitedBrandDuration")]) {
                env.output.insert("BrandTicks".to_string(), (env.output.get("Duration").copied().unwrap_or(0.0) * (1.0 / hto)).floor());
            }
        } else if let (Some(htm), false) = (num(&skill_data, "hitTimeMultiplier"), triggered_on_death) {
            let hit_time = time * htm;
            env.output.insert("HitTime".to_string(), hit_time);
            let hs = if has_cd_out && truthy(&skill_data, "triggered") { 1.0 / hit_time.max(cooldown) } else if has_cd_out { 1.0 / (hit_time + cooldown) } else { (1.0 / hit_time).min(pom_offence::data::misc("ServerTickRate")) };
            env.output.insert("HitSpeed".to_string(), hs);
        }
        if time > 1.0 {
            env.player.add_mod(Mod { name: pom_engine::sym!("Condition:OneSecondAttackTime"), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() });
            // The skill's mod list reads modDB live in upstream; here its parent is a snapshot, so add the flag to it too.
            skill_mod_list.add_mod(Mod { name: pom_engine::sym!("Condition:OneSecondAttackTime"), ty: ModType::Flag, value: Value::Bool(true), flags: 0, keyword_flags: 0, source: None, tags: (vec![]).into() });
        }
    } else if let Some(p) = passes.first() {
        for k in ["Speed", "Time", "CastRate", "HitTime", "HitSpeed", "TriggerTime", "AccuracyHitChance", "HitChance"] {
            if let Some(v) = p.out.get(k) {
                env.output.insert(k.to_string(), *v);
            }
        }
    }
    if pom_offence::bd::on() {
        // CalcOffence.lua:2562-2590: `breakdown.HitSpeed` / `breakdown.HitTime`.
        let g = |k: &str| env.output.get(k).copied();
        pom_offence::bd_d::hit_time(num(&skill_data, "hitTimeOverride").is_some(), num(&skill_data, "hitTimeMultiplier"), truthy(&skill_data, "triggeredOnDeath"), truthy(&skill_data, "triggered"), g("Time"), is_attack, g("HitTime").unwrap_or(0.0), g("HitSpeed").unwrap_or(0.0), if has_cd_out { Some(cooldown) } else { None });
    }
    // CalcPerform.lua:2280-2286: Blight part 2 sits at the stage count its own Speed and Duration sustain
    // (upstream reads them from the skill's cached output; they do not depend on the stage multipliers).
    {
        let ge_name = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| main.name.clone());
        if matches!(ge_name.as_str(), "Blight" | "Blight of Contagion" | "Blight of Atrophy") && skill_part == 2 {
            let rate = env.output.get("Speed").copied().unwrap_or(0.0);
            let duration = env.output.get("Duration").copied().unwrap_or(0.0);
            let base_max = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("BlightBaseMaxStages")]);
            let maximum = ((rate * duration).floor() - 1.0).min(base_max - 1.0);
            let nm: String = ge_name.split_whitespace().collect();
            for k in ["MaxStages", "StageAfterFirst"] {
                skill_mod_list.add_mod(Mod { name: Sym::new(&format!("Multiplier:{nm}{k}")), ty: ModType::Base, value: Value::Num(maximum), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Base")), tags: (vec![]).into() });
            }
        }
    }
    let quantity_multiplier = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("QuantityMultiplier")]).max(1.0);
    if quantity_multiplier > 1.0 {
        env.output.insert("QuantityMultiplier".to_string(), quantity_multiplier);
    }

    // ---- damage (exerts, crits, ruthless, DPS, ...) per pass (CalcOffence.lua:2606-3960)
    let mode_buffs = pom_calc::setup::buff_mode().buffs;
    let mode_combat = pom_calc::setup::buff_mode().combat;
    let global_speed = env.output.get("Speed").copied().unwrap_or(0.0);
    let global_hit_speed = env.output.get("HitSpeed").copied();
    let can_deal: [bool; 5] = {
        let mut a = [true; 5];
        for (i, dt) in pom_offence::conversion::DMG_TYPES.iter().enumerate() {
            a[i] = !skill_mod_list.flag(Some(&cfg), &[Sym::new(&format!("DealNo{dt}")), pom_engine::sym!("DealNoDamage")]);
        }
        a
    };
    // ---- Pacts (CalcOffence.lua:2891-2946): the Pact skills' uptime-scaled damage/coverage bonuses.
    if mode_buffs && main.skill_types.contains(&skill_type::SPELL) && !main.skill_types.contains(&skill_type::BRAND) {
        apply_pacts(env, main, skills, &mut skill_mod_list, global_speed);
    }
    let repeat_mode = env.config_str.get("repeatMode").map(|s| s.as_str()).map(|s| s.to_string());
    let mut global_out: HashMap<String, f64> = HashMap::default();
    let ruthless_mode = env.config_str.get("ruthlessSupportMode").cloned().unwrap_or_else(|| "AVERAGE".to_string());
    // The damage/DPS keys are only produced when nothing unported (skill hooks, warcry/pact uptime,
    // the mod-injection chain, ...) can change them - see `offence_dps::unsupported`.
    let stage_ok = hook_ok && crate::offence_dps::unsupported(skills, &skill_mod_list, &cfg).is_none();
    let not_exertable = main.skill_types.contains(&skill_type::NEVER_EXERTABLE) || main.skill_types.contains(&skill_type::TRIGGERED) || main.skill_types.contains(&skill_type::CHANNEL) || main.skill_types.contains(&skill_type::OTHER_THING_USES_SKILL) || main.skill_types.contains(&skill_type::RETALIATION) || main.skill_types.contains(&skill_type::SUMMONS_TOTEM);
    let mut kf_ratio_applied = false;
    for p in passes.iter_mut() {
        // Exerted-attack warcries (CalcOffence.lua:2606-2838), per pass: the reset below runs every
        // pass but each warcry's `<Name>CryCalculated` gate keeps its factors from being re-applied.
        for k in ["OffensiveWarcryEffect", "MaxOffensiveWarcryEffect", "TheoreticalOffensiveWarcryEffect", "TheoreticalMaxOffensiveWarcryEffect", "RallyingHitEffect", "AilmentWarcryEffect"] {
            env.output.insert(k.to_string(), 1.0);
        }
        env.output.insert("GlobalWarcryUptimeRatio".to_string(), 0.0);
        if mode_buffs && !not_exertable {
            apply_warcries(env, main, skills, &mut skill_mod_list, &cfg, &p.cfg, global_speed, &skill_data);
        }
        // Ruthless Blow / Fist of War (CalcOffence.lua:2954-3021)
        p.out.insert("RuthlessBlowHitEffect".to_string(), 1.0);
        p.out.insert("RuthlessBlowAilmentEffect".to_string(), 1.0);
        p.out.insert("FistOfWarDamageEffect".to_string(), 1.0);
        if mode_combat {
            let c = Some(&p.cfg);
            let max_count = skill_mod_list.sum(ModType::Base, c, &[pom_engine::sym!("RuthlessBlowMaxCount")]);
            p.out.insert("RuthlessBlowMaxCount".to_string(), max_count);
            let chance = if max_count > 0.0 && (!p.cfg.skill_cond.get("usedByMirage").copied().unwrap_or(false) || num(&skill_data, "mirageUses").unwrap_or(0.0) > max_count) {
                if ruthless_mode == "MAX" {
                    dps_multiplier /= max_count;
                    100.0
                } else {
                    pom_offence::area::round(100.0 / max_count)
                }
            } else {
                0.0
            };
            p.out.insert("RuthlessBlowChance".to_string(), chance);
            let hit_mult = 1.0 + skill_mod_list.sum(ModType::Base, c, &[pom_engine::sym!("RuthlessBlowHitMultiplier")]) / 100.0;
            let ail_mult = 1.0 + skill_mod_list.sum(ModType::Base, c, &[pom_engine::sym!("RuthlessBlowAilmentMultiplier")]) / 100.0;
            p.out.insert("RuthlessBlowHitMultiplier".to_string(), hit_mult);
            p.out.insert("RuthlessBlowAilmentMultiplier".to_string(), ail_mult);
            p.out.insert("RuthlessBlowHitEffect".to_string(), 1.0 - chance / 100.0 + chance / 100.0 * hit_mult);
            p.out.insert("RuthlessBlowAilmentEffect".to_string(), 1.0 - chance / 100.0 + chance / 100.0 * ail_mult);
            let fow_cd = skill_mod_list.sum(ModType::Base, c, &[pom_engine::sym!("FistOfWarCooldown")]);
            env.output.insert("FistOfWarCooldown".to_string(), fow_cd);
            if fow_cd != 0.0 && main.skill_types.contains(&skill_type::SLAM) && !main.skill_types.contains(&skill_type::VAAL) && !main.skill_types.contains(&skill_type::OTHER_THING_USES_SKILL) {
                let mult = skill_mod_list.sum(ModType::Base, None, &[pom_engine::sym!("FistOfWarDamageMultiplier")]) / 100.0;
                let uptime = ((1.0 / global_speed) / fow_cd).min(1.0) * 100.0;
                let avg_effect = 1.0 + mult * (uptime / 100.0);
                let max_effect = 1.0 + mult;
                env.output.insert("FistOfWarDamageMultiplier".to_string(), mult);
                env.output.insert("FistOfWarUptimeRatio".to_string(), uptime);
                env.output.insert("AvgFistOfWarDamage".to_string(), mult);
                env.output.insert("AvgFistOfWarDamageEffect".to_string(), avg_effect);
                if pom_offence::bd::on() {
                    pom_offence::bd_d::fist_of_war_uptime(global_speed, fow_cd, uptime);
                    pom_offence::bd_d::fist_of_war_effect(mult, uptime, avg_effect);
                }
                env.output.insert("MaxFistOfWarDamageEffect".to_string(), max_effect);
                let effect = if skill_mod_list.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]) { max_effect } else { avg_effect };
                p.out.insert("FistOfWarDamageEffect".to_string(), effect);
                let inc_aoe = skill_mod_list.sum(ModType::Base, None, &[pom_engine::sym!("FistOfWarIncAoE")]);
                let (aoe_v, aoe_src) = if skill_mod_list.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]) { (inc_aoe, "Max Fist of War Boosted AoE") } else { ((inc_aoe / 100.0 * uptime).floor(), "Avg Fist Of War Boosted AoE") };
                skill_mod_list.add_mod(Mod { name: pom_engine::sym!("AreaOfEffect"), ty: ModType::Inc, value: Value::Num(aoe_v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from(aoe_src)), tags: (vec![]).into() });
                pom_offence::bd::with_root_scope(|| crate::skillgeo::recalc_area(env, main, &skill_mod_list, &cfg, &skill_data));
                let t = env.output["TheoreticalOffensiveWarcryEffect"] * avg_effect;
                env.output.insert("TheoreticalOffensiveWarcryEffect".to_string(), t);
                let t = env.output["TheoreticalMaxOffensiveWarcryEffect"] * max_effect;
                env.output.insert("TheoreticalMaxOffensiveWarcryEffect".to_string(), t);
            }
        }

        // Explosive Arrow's `explosiveArrowFunc` (CalcOffence.lua:3036-3039, Data/Skills/act_dex.lua:6699-6750).
        if main.name == "Explosive Arrow" && matches!(cfg.skill_part.map(|p| p as i64), Some(1) | Some(2)) {
            let part = cfg.skill_part.map(|p| p as i64).unwrap_or(0);
            let duration = pom_offence::cooldown::calc_skill_duration_helper(&skill_mod_list, Some(&cfg), num(&skill_data, "duration"), truthy(&skill_data, "mineDurationAppliesToSkill"), truthy(&skill_data, "debuff"), true, &env.enemy);
            let fuse_limit = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ExplosiveArrowMaxFuseCount")]);
            let active_totems = if is_totem {
                env.player.override_(None, &[pom_engine::sym!("TotemsSummoned")]).and_then(|v| v.num()).unwrap_or_else(|| skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ActiveTotemLimit"), pom_engine::sym!("ActiveBallistaLimit")]))
            } else {
                0.0
            };
            let mut barrage_projectiles = None;
            if skill_mod_list.flag(None, &[pom_engine::sym!("SequentialProjectiles")]) && !skill_mod_list.flag(None, &[pom_engine::sym!("OneShotProj")]) && !skill_mod_list.flag(None, &[pom_engine::sym!("NoAdditionalProjectiles")]) && !skill_mod_list.flag(None, &[pom_engine::sym!("TriggeredBySnipe")]) {
                let bp = skill_mod_list.sum(ModType::Base, Some(&cfg), &[pom_engine::sym!("ProjectileCount")]);
                dps_multiplier /= bp;
                barrage_projectiles = Some(bp);
            }
            let mut fuse_rate = p.out.get("HitChance").copied().unwrap_or(0.0) / 100.0 * global_speed * dps_multiplier * barrage_projectiles.unwrap_or(1.0);
            if is_totem {
                fuse_rate *= active_totems;
            }
            if part == 2 {
                let maximum = ((fuse_rate * duration).floor() + 1.0).min(fuse_limit);
                let mk = |n: &str, v: f64| Mod { name: Sym::new(n), ty: ModType::Base, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from("Base")), tags: (vec![]).into() };
                skill_mod_list.add_mod(mk("Multiplier:ExplosiveArrowStage", maximum));
                skill_mod_list.add_mod(mk("Multiplier:ExplosiveArrowStageAfterFirst", maximum - 1.0));
                env.output.insert("MaxExplosiveArrowFuseCalculated".to_string(), maximum);
            } else {
                env.output.remove("MaxExplosiveArrowFuseCalculated");
            }
            let time_to_max_fuses = fuse_limit / fuse_rate;
            let hit_time = if part == 2 || (part == 1 && active_stage_count + 1.0 >= fuse_limit) { lua_min(duration, time_to_max_fuses) } else { duration };
            env.output.insert("HitTime".to_string(), hit_time);
            env.output.insert("HitSpeed".to_string(), 1.0 / hit_time);
        }

        // crit (CalcOffence.lua:3041-3272)
        sync_pass_stats(&mut skill_mod_list, &mut p.cfg, is_attack, &env.output, &p.out);
        let hc = p.out.get("AccuracyHitChance").copied().unwrap_or(100.0);
        let crit_input = pom_offence::crit::CritInput {
            skill_mod_list: &skill_mod_list,
            enemy_db: &env.enemy,
            actor_db: &env.player,
            cfg: Some(&p.cfg),
            skill_cfg: Some(&cfg),
            source_crit_chance: p.source.get("CritChance"),
            weapon1_crit_chance: weapon1.get("CritChance"),
            parent_weapon1_crit_chance: env.parent_weapon1_crit,
            party_main_hand_crit: crate::party::current().member_output.get("MainHand.CritChance").copied().unwrap_or(0.0),
            mode_effective: pom_calc::setup::buff_mode().effective,
            repeats,
            repeat_mode: repeat_mode.as_deref(),
            accuracy_hit_chance: hc,
        };
        let crit = pom_offence::crit::calc_crit(&crit_input);
        if pom_offence::bd::on() {
            pom_offence::bd::set_pass(pom_offence::bd::pass_scope(p.label));
            pom_offence::crit::write_breakdown(&crit_input, &crit);
        }
        p.out.insert("CritChance".to_string(), crit.crit_chance);
        p.out.insert("PreEffectiveCritChance".to_string(), crit.pre_effective_crit_chance);
        p.out.insert("PreBifurcateCritChance".to_string(), crit.pre_bifurcate_crit_chance);
        p.out.insert("CritMultiplier".to_string(), crit.crit_multiplier);
        p.out.insert("CritEffect".to_string(), crit.crit_effect);
        if let Some(b) = crit.crit_bifurcates {
            p.out.insert("CritBifurcates".to_string(), b);
        }
        p.out.insert("BonusCritDotMultiplier".to_string(), crit.bonus_crit_dot_multiplier);

        let hit_rate_dps_multiplier = dps_multiplier;
        // runSkillFunc("postCritFunc") (CalcOffence.lua:3315): Kinetic Fusillade's maximum effective attack rate.
        if matches!(main.granted_effect_id.as_str(), "KineticFusillade" | "KineticFusilladeAltX") {
            let part = cfg.skill_part.map(|v| v as i64).unwrap_or(1);
            let delay = num(&skill_data, "delayPerProjectile").unwrap_or(0.0);
            let count = if part == 1 { env.output.get("ProjectileCount").copied().unwrap_or(1.0) } else { 1.0 };
            let effective_delay = (num(&skill_data, "duration").unwrap_or(0.0) + delay * (count - 1.0)) * env.output.get("DurationMod").copied().unwrap_or(1.0);
            let tick_time = 0.033; // data.misc.ServerTickTime (Data.lua:237)
            let max_aps = 1.0 / ((effective_delay / tick_time).ceil() * tick_time);
            env.output.insert("KineticFusilladeMaxEffectiveAPS".to_string(), max_aps);
            if pom_offence::bd::on() {
                // `breakdown.KineticFusilladeMaxEffectiveAPS` (Data/Skills/act_int.lua:11097-11135, same in the Zenith variant).
                use pom_offence::bd::{ins_s, set};
                use pom_offence::sf;
                let hover_delay = num(&skill_data, "duration").unwrap_or(0.0);
                let duration_mod = env.output.get("DurationMod").copied().unwrap_or(1.0);
                let base_time = delay * (count - 1.0);
                let effective_delay_rounded = (effective_delay / tick_time).ceil() * tick_time;
                let max_predictive_aps = 1.0 / effective_delay;
                let mut t = serde_json::Value::Array(vec![]);
                ins_s(&mut t, sf!("^8Base hover delay:^7 %.1fs", hover_delay));
                ins_s(&mut t, sf!("^8Base delay between projectiles:^7 %.2fs", delay));
                ins_s(&mut t, sf!("^8Base time for^7 %d added ^8projectiles:^7 %.2fs x %d = %.1fs", count - 1.0, delay, count - 1.0, base_time));
                ins_s(&mut t, sf!("^8Duration modifier:^7 %.4f", duration_mod));
                ins_s(&mut t, "");
                ins_s(&mut t, "^6Lockstep");
                ins_s(&mut t, sf!("^8Effective delay:^7 (%.1f + %.2f) x %.4f = %.4fs", hover_delay, base_time, duration_mod, effective_delay));
                ins_s(&mut t, sf!("^8Rounded up to nearest server tick^7 = %.4fs", effective_delay_rounded));
                ins_s(&mut t, sf!("^8Max effective attack rate:^7 1 / %.4f = %.2f", effective_delay_rounded, max_aps));
                if let Some(current) = env.output.get("Speed").copied() {
                    let current_inc = skill_mod_list.sum(ModType::Inc, Some(&cfg), &[pom_engine::sym!("Speed")]);
                    let needed_inc = ((max_aps / current) * (1.0 + current_inc / 100.0) - 1.0) * 100.0;
                    let additional_inc = needed_inc - current_inc;
                    let needed_predictive_inc = ((max_predictive_aps / current) * (1.0 + current_inc / 100.0) - 1.0) * 100.0;
                    let additional_predictive_inc = needed_predictive_inc - current_inc;
                    if current > max_aps {
                        ins_s(&mut t, sf!("^1Current attack rate (%.2f) exceeds max effective rate!", current));
                        ins_s(&mut t, sf!("^1Reduce attack speed by at least^7 %d%% ^1", (-additional_inc).ceil()));
                        ins_s(&mut t, sf!("^1DPS is reduced by %.1f%%", (1.0 - max_aps / current) * 100.0));
                    } else {
                        ins_s(&mut t, sf!("^2Current attack rate (%.2f) is within effective limits", current));
                        ins_s(&mut t, sf!("^2You can add up to^7 %d%% ^2increased attack speed", additional_inc.floor()));
                    }
                    ins_s(&mut t, "");
                    ins_s(&mut t, "^6Predictive");
                    ins_s(&mut t, sf!("^8Effective delay:^7 (%.1f + %.2f) x %.4f = %.4fs", hover_delay, base_time, duration_mod, effective_delay));
                    ins_s(&mut t, sf!("^8Max effective attack rate:^7 1 / %.4f = %.2f", effective_delay, max_predictive_aps));
                    if current > max_predictive_aps {
                        ins_s(&mut t, sf!("^1Current attack rate (%.2f) exceeds max effective rate!", current));
                        ins_s(&mut t, sf!("^1Reduce attack speed by at least^7 %d%% ^1", (-additional_predictive_inc).ceil()));
                        ins_s(&mut t, sf!("^1DPS is reduced by %.1f%%", (1.0 - max_predictive_aps / current) * 100.0));
                    } else {
                        ins_s(&mut t, sf!("^2Current attack rate (%.2f) is within effective limits", current));
                        ins_s(&mut t, sf!("^2You can add up to^7 %d%% ^2increased attack speed", additional_predictive_inc.floor()));
                    }
                }
                pom_offence::bd::root(|b| set(b, "KineticFusilladeMaxEffectiveAPS", t));
            }
            if part == 1 {
                // `runSkillFunc` closes over the top-level `output` (globalOutput), so `currentAPS` is the combined Speed, not the hand's.
                if let Some(current) = env.output.get("Speed").copied() {
                    // Upstream multiplies the shared dpsMultiplier in every hand pass, so the off hand got the ratio twice; once is the rule.
                    if current > max_aps && !(kf_ratio_applied && pom_offence::data::pom_fixes_on()) {
                        dps_multiplier *= max_aps / current;
                        kf_ratio_applied = true;
                    }
                }
            }
        }

        // runSkillFunc("postCritFunc") for Lightning Tendrils of Eccentricity (Data/Skills/act_int.lua): the 500% more damage on
        // every Nth pulse, folded into an average "more" for the average-DPS part.
        if main.granted_effect_id == "LightningTendrilsAltX" && cfg.skill_part.map(|v| v as i64).unwrap_or(1) == 1 {
            if let (Some(interval), Some(pulse_damage)) = (num(&skill_data, "pulseInterval"), num(&skill_data, "pulseDamage")) {
                let pulse_damage = pulse_damage / 100.0;
                let crit_chance = p.out.get("PreEffectiveCritChance").copied().unwrap_or(0.0) / 100.0;
                let effective_crit_chance = p.out.get("CritChance").copied().unwrap_or(0.0) / 100.0;
                let crit_multi = p.out.get("CritMultiplier").copied().unwrap_or(0.0);
                let average_more = 100.0 * (((interval - 1.0) * (1.0 + crit_chance * (crit_multi - 1.0)) + (1.0 + pulse_damage) * crit_multi) / (interval * ((1.0 - effective_crit_chance) + crit_multi * effective_crit_chance)) - 1.0);
                let tag = pom_engine::modifier::Tag { kind: pom_engine::sym!("SkillPart"), fields: vec![(pom_engine::sym!("skillPart"), Value::Num(1.0))] };
                skill_mod_list.add_mod(Mod { name: pom_engine::sym!("Damage"), ty: ModType::More, value: Value::Num(average_more), flags: 0, keyword_flags: pom_engine::modparser::flags::keyword_flag::Hit | pom_engine::modparser::flags::keyword_flag::Ailment, source: Some(std::sync::Arc::from("Average Pulse Damage")), tags: (vec![tag]).into() });
            }
        }

        if stage_ok {
            let monster_life_h = num(&skill_data, "corpseLife").unwrap_or_else(|| if env.enemy_level > 0.0 { pom_offence::data::monster_life_table(env.enemy_level as i64) } else { 100.0 });
            let party_data = crate::party::current();
            let hd = pom_offence::hitdmg::HitDmgInput {
                monster_life: monster_life_h,
                explode_chance: env.output.get("ExplodeChance").copied(),
                party_flags: &party_data.member_flags,
                party_output: &party_data.member_output,
                enemy_db: &env.enemy,
                mod_db: &env.player,
                real_mod_db: env.parent_snapshot.as_deref().unwrap_or(&env.player),
                real_player_output: env.parent_output.as_ref().unwrap_or(&player_out),
                skill_cfg: &cfg,
                player_output: &player_out,
                config_num: &env.config_input,
                config_str: &env.config_str,
                mode_effective: pom_calc::setup::buff_mode().effective,
                mode_combat,
                can_deal,
                skill_flags: &main.skill_flags,
                skill_types: &main.skill_types,
                skill_data: &skill_data,
                base_multiplier,
                damage_effectiveness,
                source: &p.source,
                hit_speed: env.output.get("HitSpeed").copied(),
                speed: global_speed,
                dps_multiplier,
                hit_rate_dps_multiplier,
                total_dps_multiplier: trap_trigger_twice,
                quantity_multiplier,
                offensive_warcry_effect: env.output.get("OffensiveWarcryEffect").copied().unwrap_or(1.0),
                max_offensive_warcry_effect: env.output.get("MaxOffensiveWarcryEffect").copied().unwrap_or(1.0),
                intimidating_up_time_ratio: env.output.get("IntimidatingUpTimeRatio").copied(),
                average_burst_hits: p.out.get("AverageBurstHits").copied(),
                can_rapid_fire: main.skill_types.contains(&skill_type::CAN_RAPID_FIRE),
                pass_label: match p.label { "MainHand" => "Main Hand", "OffHand" => "Off Hand", l => l },
            };
            let mut pcfg = p.cfg.clone();
            pom_offence::bd::set_pass(pom_offence::bd::pass_scope(p.label));
            pom_offence::hitdmg::calc_hit_damage(&hd, &mut skill_mod_list, &mut pcfg, &p.conv, &mut p.out, &mut global_out);
            // Elemental Equilibrium (CalcOffence.lua:3694): the hit updates the enemy's hit-by-damage-type conditions,
            // which persist into the ailment section and later passes.
            let hit_avg = |k: &str| p.out.get(k).copied().unwrap_or(0.0);
            let (fire, cold, lightning) = (hit_avg("FireHitAverage"), hit_avg("ColdHitAverage"), hit_avg("LightningHitAverage"));
            if skill_mod_list.flag(Some(&cfg), &[pom_engine::sym!("ElementalEquilibrium")]) && !env.config_flags.get("EEIgnoreHitDamage").copied().unwrap_or(false) && fire + cold + lightning > 0.0 {
                env.enemy.conditions.insert(pom_engine::sym!("HitByFireDamage"), fire > 0.0);
                env.enemy.conditions.insert(pom_engine::sym!("HitByColdDamage"), cold > 0.0);
                env.enemy.conditions.insert(pom_engine::sym!("HitByLightningDamage"), lightning > 0.0);
            }
        }
    }
    pom_offence::bd::set_pass(None);
    for (k, v) in &global_out {
        env.output.insert(k.clone(), *v);
    }
    if let Some(v) = global_out.get("AverageBurstHits") {
        env.output.insert("ShowBurst".to_string(), if *v > 1.0 { 1.0 } else { 0.0 });
    }

    pom_offence::bd::set_pass(None);
    // ---- write the pass outputs; combine the two hands for attacks (CalcOffence.lua:3958-3990)
    for p in &passes {
        for (k, v) in &p.out {
            env.output.insert(format!("{}{k}", p.prefix), *v);
        }
    }
    if is_attack {
        for (stat, mode) in [("PreEffectiveCritChance", "AVERAGE"), ("CritChance", "AVERAGE"), ("CritMultiplier", "AVERAGE"), ("AverageDamage", "DPS"), ("PvpAverageDamage", "DPS"), ("TotalDPS", "DPS"), ("PvpTotalDPS", "DPS")] {
            if let Some(v) = combine(&passes, stat, mode, None, &skill_data) {
                env.output.insert(stat.to_string(), v);
            }
        }
        for stat in ["LifeLeechDuration", "LifeLeechInstances", "LifeLeechInstant", "LifeLeechInstantRate", "LifeLeechInstantProportion", "EnergyShieldLeechDuration", "EnergyShieldLeechInstances", "EnergyShieldLeechInstant", "EnergyShieldLeechInstantRate", "EnergyShieldLeechInstantProportion", "ManaLeechDuration", "ManaLeechInstances", "ManaLeechInstant", "ManaLeechInstantRate", "ManaLeechInstantProportion", "LifeOnHit", "LifeOnHitRate", "LifeOnKill", "EnergyShieldOnHit", "EnergyShieldOnHitRate", "EnergyShieldOnKill", "ManaOnHit", "ManaOnHitRate", "ManaOnKill", "impaleStoredHitAvg"] {
            if let Some(v) = combine(&passes, stat, "DPS", None, &skill_data) {
                env.output.insert(stat.to_string(), v);
            }
        }
    }
    // ---- Calculate leech rates (CalcOffence.lua:4100-4141)
    {
        let o = |k: &str| env.output.get(k).copied().unwrap_or(0.0);
        let leech_rate_base = pom_offence::data::misc("LeechRateBase");
        let mut vals: Vec<(String, f64)> = Vec::new();
        let mut rate = [0.0f64; 3];
        let mut per_hit = [0.0f64; 3];
        let pools = ["Life", "EnergyShield", "Mana"];
        for (i, name) in pools.iter().enumerate() {
            let inst_rate = o(name) * leech_rate_base * pom_offence::tools::calc_lib_mod(&skill_mod_list, Some(&skill_cfg), &[&format!("{name}LeechRate")]);
            vals.push((format!("{name}LeechInstanceRate"), inst_rate));
            rate[i] = o(&format!("{name}LeechInstances")) * inst_rate;
            per_hit[i] = inst_rate;
        }
        if skill_mod_list.flag(None, &[pom_engine::sym!("ImmortalAmbition")]) {
            rate[1] += rate[0];
            per_hit[1] += per_hit[0];
            rate[0] = 0.0;
            per_hit[0] = 0.0;
        }
        if skill_mod_list.flag(None, &[pom_engine::sym!("UnaffectedByNonInstantLifeLeech")]) {
            rate[0] = 0.0;
            per_hit[0] = 0.0;
            vals.push(("LifeLeechInstances".to_string(), 0.0));
        }
        // The triggerRate speed branch writes `skillData.showAverage = false` (CalcOffence.lua:2295).
        let trigger_rate_branch = num(&skill_data, "timeOverride").is_none()
            && !truthy(&skill_data, "fixedCastTime")
            && !(num(&skill_data, "triggerTime").is_some() && truthy(&skill_data, "triggered"))
            && (num(&skill_data, "triggerRate").is_some() && truthy(&skill_data, "triggered"));
        let (show_average_flag, show_average_data) = if stage_ok {
            use crate::offence_dps::Stage1;
            let st = Stage1 { main, all_skills: skills, cfg: &cfg, skill_data: &skill_data, repeats, grant_cast_time, has_cooldown: has_cd_out };
            (crate::offence_dps::show_average_for(&skill_mod_list, &st, &env.output, &skill_data, true), crate::offence_dps::show_average(&skill_mod_list, &st, &env.output, &skill_data))
        } else {
            (truthy(&skill_data, "showAverage"), truthy(&skill_data, "showAverage"))
        };
        let show_average = show_average_data && !trigger_rate_branch;
        // `skillFlags.showAverage` is not cleared by the trigger-rate branch (only `skillData.showAverage` is, 2295).
        cap_show_average = Some(show_average_flag);
        cap_show_data = Some(show_average);
        let mut gain: Vec<(String, f64)> = Vec::new();
        for (i, name) in pools.iter().enumerate() {
            let recovery = o(&format!("{name}RecoveryRateMod"));
            let max_rate = o(&format!("Max{name}LeechRate"));
            let r = o(&format!("{name}LeechInstantRate")) + rate[i].min(max_rate) * recovery;
            let ph = o(&format!("{name}LeechInstant")) + per_hit[i].min(max_rate) * o(&format!("{name}LeechDuration")) * recovery;
            vals.push((format!("{name}LeechRate"), r));
            vals.push((format!("{name}LeechPerHit"), ph));
            if show_average {
                gain.push((format!("{name}LeechGainPerHit"), ph + o(&format!("{name}OnHit"))));
            } else {
                gain.push((format!("{name}LeechGainRate"), r + o(&format!("{name}OnHitRate"))));
            }
        }
        for (k, v) in vals.into_iter().chain(gain) {
            env.output.insert(k, v);
        }
        if pom_offence::bd::on() {
            // CalcOffence.lua:4004-4076 (crit source, both-hands average, TotalDPS) and 4121-4141 (leech tables).
            let go = |k: &str| env.output.get(k).copied();
            let o0 = |k: &str| go(k).unwrap_or(0.0);
            if is_attack {
                let hands: Vec<(&'static str, f64, f64)> = passes.iter().map(|p| (p.label, p.out.get("PreEffectiveCritChance").copied().unwrap_or(0.0), p.out.get("CritChance").copied().unwrap_or(0.0))).collect();
                pom_offence::bdail::crit_source(both_weapon_attack, flag("weapon1Attack"), &hands, (o0("PreEffectiveCritChance"), o0("CritChance")));
                if both_weapon_attack {
                    pom_offence::bdail::both_weapons_average_damage(truthy(&skill_data, "doubleHitsWhenDualWielding"), o0("MainHand.AverageDamage"), o0("OffHand.AverageDamage"), o0("AverageDamage"));
                }
            }
            pom_offence::bdail::total_dps(is_attack, truthy(&skill_data, "triggered"), o0("AverageDamage"), go("HitSpeed"), o0("Speed"), dps_multiplier, quantity_multiplier, o0("TotalDPS"));
            let hit_rate = o0("HitChance") / 100.0 * go("HitSpeed").or(go("Speed")).unwrap_or(0.0) * dps_multiplier;
            for (flag_name, key, name) in [("Life", "LifeLeech", "Life"), ("EnergyShield", "EnergyShieldLeech", "EnergyShield"), ("Mana", "ManaLeech", "Mana")] {
                if o0(&format!("{key}Rate")) > 0.0 {
                    let v = pom_offence::bdbuild::leech(&env.player, show_average, o0(&format!("{key}Instant")), o0(&format!("{key}InstantRate")), o0(&format!("{key}Instances")), o0(flag_name), &format!("{key}Rate"), o0(&format!("Max{name}LeechRate")), o0(&format!("{key}Duration")), o0(&format!("{key}InstantProportion")), hit_rate, leech_rate_base);
                    pom_offence::bd::root(|b| pom_offence::bd::set(b, key, v));
                }
            }
        }
    }

    // CalcOffence.lua:4096-4098: `if activeSkill.minion then skillData.summonSpeed = ...`.
    SUMMON_SPEED.with(|c| c.set(env.output.get("SummonedMinionsPerCast").map(|spm| spm * env.output.get("HitSpeed").or_else(|| env.output.get("Speed")).copied().unwrap_or(0.0) * dps_multiplier)));
    add_costs_per_second(&env.player, &mut env.output, main, &cfg, &skill_mod_list, &skill_data);
    // ---- Ailments / DoT / Impale per pass (CalcOffence.lua:4160-5914) and the combined-DPS tail
    // (6106-6262) - see `crate::offence_dps`. Runs on the (already hand-combined) global output.
    if stage_ok {
        use crate::offence_dps::{AilmentFlags, PassCtx, Prep, Stage1};
        let stage = Stage1 { main, all_skills: skills, cfg: &cfg, skill_data: &skill_data, repeats, grant_cast_time, has_cooldown: has_cd_out };
        let mut go: HashMap<String, f64> = env.output.clone();
        let show_average = crate::offence_dps::show_average(&skill_mod_list, &stage, &go, &skill_data);
        let prep = Prep { dps_multiplier, quantity_multiplier, show_average };
        let mut flags = AilmentFlags::default();
        let mut ok = true;
        for p in passes.iter_mut() {
            let pctx = PassCtx { label: p.label, cfg: &p.cfg, is_attack };
            let mut gpo: HashMap<String, f64> = HashMap::default();
            // `breakdown = pass.breakdown` (CalcOffence.lua:4171).
            pom_offence::bd::set_pass(pom_offence::bd::pass_scope(p.label));
            pom_offence::bdail::enter_pass(p.label);
            let r = crate::offence_dps::pass_ailments(&*env, &mut skill_mod_list, &stage, &prep, &pctx, &mut p.out, &mut gpo, &go);
            pom_offence::bd::set_pass(None);
            go.extend(gpo);
            match r {
                Some(f) => {
                    flags.flag_dot |= f.flag_dot;
                    flags.flag_ignite |= f.flag_ignite;
                    flags.flag_bleed |= f.flag_bleed;
                    flags.flag_impale |= f.flag_impale;
                }
                None => ok = false,
            }
        }
        pom_offence::bdail::leave_pass();
        if ok {
            let double_hits = truthy(&skill_data, "doubleHitsWhenDualWielding");
            let mh = passes.iter().find(|p| p.label == "MainHand").map(|p| &p.out);
            let oh = passes.iter().find(|p| p.label == "OffHand").map(|p| &p.out);
            if is_attack {
                let h = crate::offence_dps::Hands { mh, oh, both: both_weapon_attack, double_hits };
                crate::offence_dps::combine_attack_ailment_stats(&mut go, &h, show_average, skill_mod_list.flag(Some(&cfg), &[pom_engine::sym!("IgniteCanStack")]));
            } else if let Some(p) = passes.first() {
                for (k, v) in &p.out {
                    go.insert(k.clone(), *v);
                }
            }
            flags.flag_dot |= crate::offence_dps::total_dot_global(&*env, &skill_mod_list, &stage, &prep, &mut go);
            let hands = if is_attack { mh.zip(oh) } else { None };
            crate::offence_dps::finish(&*env, &skill_mod_list, &stage, &prep, &mut go, flags, hands);
            for p in &passes {
                for (k, v) in &p.out {
                    go.insert(format!("{}{k}", p.prefix), *v);
                }
            }
            env.output = go;
        }
    } else {
        // The damage stage is unsupported for this skill: still produce the ailment chances, knockback and stun
        // values, which read no hit damage (`offence_dps::pass_chances_only`).
        use crate::offence_dps::{PassCtx, Stage1};
        let stage = Stage1 { main, all_skills: skills, cfg: &cfg, skill_data: &skill_data, repeats, grant_cast_time, has_cooldown: has_cd_out };
        for p in passes.iter_mut() {
            let pctx = PassCtx { label: p.label, cfg: &p.cfg, is_attack };
            crate::offence_dps::pass_chances_only(&*env, &skill_mod_list, &stage, &pctx, &mut p.out);
        }
        let mut go: HashMap<String, f64> = HashMap::default();
        if is_attack {
            let double_hits = truthy(&skill_data, "doubleHitsWhenDualWielding");
            let mh = passes.iter().find(|p| p.label == "MainHand").map(|p| &p.out);
            let oh = passes.iter().find(|p| p.label == "OffHand").map(|p| &p.out);
            let h = crate::offence_dps::Hands { mh, oh, both: both_weapon_attack, double_hits };
            crate::offence_dps::combine_attack_ailment_stats(&mut go, &h, false, false);
        } else if let Some(p) = passes.first() {
            go.extend(p.out.iter().map(|(k, v)| (k.clone(), *v)));
        }
        for p in &passes {
            for (k, v) in &p.out {
                go.insert(format!("{}{k}", p.prefix), *v);
            }
        }
        for (k, v) in go {
            env.output.entry(k).or_insert(v);
        }
    }
    // Self hit dmg calcs (CalcOffence.lua:5959): after the ignite pass, which sets `skillFlags.ignite`.
    let ignited = main.skill_flags.contains("ignite") || env.output.contains_key("IgniteDPS");
    if let Some(v) = crate::self_hit::self_hit_damage(&skill_mod_list, &env.player, &env.output, &main.name, ignited, &cfg) {
        env.output.insert("SelfHitDamage".to_string(), v);
    }
    if CAPTURE_TOP.with(|c| c.get()) && !crate::triggers_wire::NESTED.with(|n| n.get()) && mirage_run.as_ref().map_or(true, |r| r.gc.is_some() || r.info.is_some()) {
        // (A Saviour / Tawhoa's Chosen copy is the main skill from here on, so it is captured like one; an Archer / Wisps copy is not.)
        // CalcOffence.lua:4044-4050 (the Calcs tab's calculation only).
        {
            let fmt = |v: f64| pom_breakdown::format::format_num_sep(&format!("{v:.1}"));
            let text = if cap_show_data == Some(true) {
                format!("{} average damage", fmt(env.output.get("AverageDamage").copied().unwrap_or(0.0)))
            } else {
                format!("{} DPS", fmt(env.output.get("TotalDPS").copied().unwrap_or(0.0)))
            };
            env.output_str.insert("DisplayDamage".to_string(), text);
        }
        let c = Captured { minion: env.parent_snapshot.is_some(), main: main.clone(), skill_mod_list: skill_mod_list.clone(), player: env.player.clone(), skill_cfg: cfg.clone(), pass_cfgs: passes.iter().map(|p| (p.label, p.cfg.clone())).collect(), skill_data: skill_data.clone(), output: env.output.clone(), show_average: cap_show_average, info: info_lines(info_msg.as_deref()), info2: info_msg.as_ref().and(info_msg2.clone()) };
        CAPTURED.with(|v| {
            let mut v = v.borrow_mut();
            v.retain(|o| o.minion != c.minion);
            v.push(c);
        });
    }
}

fn skill_data_dps_multiplier(m: &HashMap<String, ScalarValue>) -> f64 {
    num(m, "dpsMultiplier").unwrap_or(1.0)
}

fn num(m: &HashMap<String, ScalarValue>, key: &str) -> Option<f64> {
    match m.get(key) {
        Some(ScalarValue::Num(n)) => Some(*n),
        _ => None,
    }
}
/// The Saviour / Tawhoa's Chosen mirage source (CalcMirages.lua:123-262): the best eligible other skill as
/// `(index, TotalDPS, Speed)`, or `None` when there is none (upstream then disables the main skill).
fn saviour_tawhoa_best(env: &mut Env, xml_text: &str, main: &ComputedSkill, main0: &ComputedSkill, skills: &[ComputedSkill]) -> Option<(usize, f64, f64)> {
    let same = |a: &ComputedSkill, b: &ComputedSkill| a.granted_effect_id == b.granted_effect_id && a.group_xml_index == b.group_xml_index && a.gem_index == b.gem_index && a.slot_name == b.slot_name;
    let is_saviour = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.as_deref()) == Some("Reflection");
    let main_idx = skills.iter().position(|s| same(s, main0)).unwrap_or(usize::MAX);
    let tskills = if main_idx < skills.len() { crate::triggers_wire::build_skills(env, skills, main_idx) } else { Vec::new() };
    let baseline = env.output.clone();
    let parent_level = std::sync::Arc::new(env.parent_level_mods.clone());
    let mut best: Option<(usize, f64, f64)> = None; // (index, TotalDPS, Speed)
    for (i, sk) in skills.iter().enumerate() {
        if same(sk, main0) || sk.skill_flags.contains("disable") {
            continue;
        }
        if is_saviour {
            let ok = sk.skill_types.contains(&skill_type::ATTACK)
                && !sk.skill_types.contains(&skill_type::SUMMONS_TOTEM)
                && (sk.flags & (pom_triggers::constants::MF_SWORD | pom_triggers::constants::MF_WEAPON1H)) == (pom_triggers::constants::MF_SWORD | pom_triggers::constants::MF_WEAPON1H);
            if !ok {
                continue;
            }
            let e = crate::triggers_wire::build_cache_entry(env, xml_text, skills, i, &baseline, &parent_level);
            if e.crit_chance.unwrap_or(0.0) > 0.0 {
                let dps = e.total_dps.unwrap_or(0.0);
                if best.is_none() || dps > best.unwrap().1 {
                    best = Some((i, dps, e.speed.unwrap_or(0.0)));
                }
            }
        } else {
            let triggered = tskills.get(i).map_or(false, pom_triggers::is_triggered);
            let type_match = (sk.skill_types.contains(&skill_type::SLAM) || sk.skill_types.contains(&skill_type::MELEE)) && sk.skill_types.contains(&skill_type::ATTACK);
            let excluded = sk.skill_types.contains(&skill_type::VAAL) || sk.skill_types.contains(&skill_type::SUMMONS_TOTEM);
            if triggered || !type_match || excluded {
                continue;
            }
            let e = crate::triggers_wire::build_cache_entry(env, xml_text, skills, i, &baseline, &parent_level);
            let dps = e.total_dps.unwrap_or(0.0);
            if best.is_none() || dps > best.unwrap().1 {
                best = Some((i, dps, e.speed.unwrap_or(0.0)));
            }
        }
    }
    env.output = baseline;
    best
}

/// `calcs.mirages`, Saviour ("Reflection", CalcMirages.lua:123-162) and Tawhoa's Chosen (:164-262) branches. The best
/// eligible other skill is copied and run as its own `calcs.perform`; that run's output IS the main output (the
/// original skips the main skill's own offence, `calculateMirage` returns true). With no eligible skill the main
/// skill is disabled and nothing is written.
#[allow(clippy::too_many_arguments)]
fn saviour_tawhoa(env: &mut Env, xml_text: &str, main: &ComputedSkill, main0: &ComputedSkill, skills: &[ComputedSkill], skill_part: i64, skill_mod_list: &ModStore, cfg: &pom_engine::modstore::types::Cfg, skill_data: &HashMap<String, ScalarValue>) -> bool {
    let is_saviour = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.as_deref()) == Some("Reflection");
    let best = saviour_tawhoa_best(env, xml_text, main, main0, skills);
    let Some((ci, _, source_rate)) = best else {
        return true;
    };
    let chosen = &skills[ci];
    MIRAGE_CHOSEN.with(|m| m.borrow_mut().push((chosen.granted_effect_id.clone(), chosen.group_xml_index, chosen.gem_index)));
    let mk =|n: &str, ty: ModType, v: Value, src: &str| Mod { name: Sym::new(n), ty, value: v, flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from(src)), tags: (vec![]).into() };
    let sum = |n: &str| skill_mod_list.sum(ModType::Base, Some(cfg), &[Sym::new(n)]);
    let mut ms = env.raw_skills.iter().find(|r| r.granted_effect_id == chosen.granted_effect_id && r.group_xml_index == chosen.group_xml_index && r.gem_index == chosen.gem_index).unwrap_or(chosen).clone();
    ms.skill_flags.remove("multiPart");
    ms.skill_flags.remove("haveMinion");
    ms.skill_types.insert(skill_type::OTHER_THING_USES_SKILL);
    ms.slot_name = None;
    let mut extras: Vec<Mod> = Vec::new();
    let mut trigger_rate: Option<f64> = None;
    let mut tawhoa_out: Option<(f64, f64)> = None; // (TriggerRateCap, SkillTriggerRate)
    let mut warriors_shown = 0.0;
    if is_saviour {
        let less = sum("SaviourMirageWarriorLessDamage");
        let mut warriors = sum("SaviourMirageWarriorMaxCount");
        let name_of = |slot: &str| env.slot_items.get(slot).and_then(|id| env.items.get(id)).map(|it| it.name.clone());
        if let (Some(a), Some(b)) = (name_of("Weapon 1"), name_of("Weapon 2")) {
            if a == b {
                warriors /= 2.0;
            }
        }
        warriors_shown = warriors;
        extras.push(mk("Damage", ModType::More, Value::Num(less), "The Saviour"));
        extras.push(mk("QuantityMultiplier", ModType::Base, Value::Num(warriors), "The Saviour Mirage Warriors"));
        extras.push(mk("HasNoCost", ModType::Flag, Value::Bool(true), "Used by mirage"));
    } else {
        let snap = crate::buffs::player_snapshot(&env.player);
        let store = crate::ailments::skill_store(&snap, &ms);
        let scfg = crate::buffs::skill_cfg(&ms);
        let icdr = pom_offence::tools::calc_lib_mod_s(&store, Some(&scfg), &[pom_engine::sym!("CooldownRecovery")]);
        let tick = pom_offence::data::misc("ServerTickRate");
        let sd_chosen = skill_data_map(&env.player, &ms);
        let triggered_cd = num(&sd_chosen, "cooldown").unwrap_or(0.0);
        let triggered_cd_tick = (triggered_cd / icdr * tick).ceil() / tick;
        let trigger_cd = num(skill_data, "cooldown").unwrap_or(0.0);
        let trigger_cd_tick = (trigger_cd / icdr * tick).ceil() / tick;
        let action_cd = triggered_cd_tick.max(trigger_cd_tick);
        let cap = if action_cd != 0.0 { 1.0 / action_cd } else { f64::INFINITY };
        let rate = if source_rate != 0.0 {
            let rotation = vec![pom_triggers::engine::SimSkill { uuid: "main".into(), cd: triggered_cd, cd_override: None, adds_cast_time: None, icdr, added_cooldown: 0.0 }];
            pom_triggers::engine::calc_multi_spell_rotation_impact(&rotation, source_rate, trigger_cd, None, "main").0
        } else {
            0.0
        };
        trigger_rate = Some(rate);
        tawhoa_out = Some((cap, rate));
        ms.skill_flags.insert("triggered".to_string());
        extras.push(mk("HasNoCost", ModType::Flag, Value::Bool(true), "Used by Tawhoa's Chosen"));
        extras.push(mk("Damage", ModType::More, Value::Num(sum("ChieftainMirageChieftainMoreDamage")), "Tawhoa's Chosen"));
    }
    let uses = num(skill_data, "storedUses").unwrap_or(0.0);
    let copy_name = pom_skills::data::all_skills().get(&ms.granted_effect_id).and_then(|ge| ge.name.clone()).unwrap_or_else(|| ms.name.clone());
    let info = Some((if is_saviour { format!("{} Mirage Warriors using {copy_name}", lua_num(warriors_shown)) } else { format!("Tawhoa's Chosen using {copy_name}") }, None));
    MIRAGE_RUN.with(|m| *m.borrow_mut() = Some(MirageRun { extras, uses, gc: None, trigger_rate, info }));
    let prev_nb = pom_offence::dot::NO_BREAKDOWN.with(|n| n.replace(true));
    MIRAGE_ACTOR_OUT.with(|m| *m.borrow_mut() = Some(env.output.clone()));
    // `calcs.copyActiveSkill` builds its env with a plain `initEnv` (no cachedPlayerDB): no parent/child modDB level split.
    // Saviour's mirage keeps the level split (verified against upstream); only Tawhoa's copy is unsplit.
    let prev_split = if is_saviour { None } else { crate::buffs::FULLDPS_PARENT.with(|p| p.borrow_mut().take()) };
    let bd_was = pom_offence::bd::set_active(false);
    compute_offence_for(env, xml_text, &ms, skills, skill_part);
    pom_offence::bd::set_active(bd_was);
    if !is_saviour { crate::buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = prev_split); }
    pom_offence::dot::NO_BREAKDOWN.with(|n| n.set(prev_nb));
    MIRAGE_RUN.with(|m| *m.borrow_mut() = None);
    MIRAGE_ACTOR_OUT.with(|m| *m.borrow_mut() = None);
    if let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing {
        pom_engine::modstore::store::retain_mods(v, |m| !(m.name.as_str() == "Condition:OneSecondAttackTime" && m.source.is_none()));
    }
    // `env.player.output = newEnv.player.output`: the copy's perform ran in CALCULATOR mode, which has no breakdown, so
    // CalcPerform.lua:2157's colour-coded requirement strings are plain numbers there.
    for a in ["Omni", "Str", "Dex", "Int"] {
        let k = format!("Req{a}String");
        if let Some(n) = env.output_extra.get(&k).and_then(|v| v.as_str()).and_then(|s| s.strip_prefix("^xDD0022")).and_then(|s| s.parse::<f64>().ok()) {
            env.output_extra.remove(&k);
            env.output.insert(k, n);
        }
    }
    MIRAGE_MAIN_NEW.with(|m| *m.borrow_mut() = Some(ms.clone()));
    if let Some((cap, rate)) = tawhoa_out {
        env.output.insert("Speed".to_string(), rate);
        env.output.insert("TriggerRateCap".to_string(), cap);
        env.output.insert("EffectiveSourceRate".to_string(), source_rate);
        env.output.insert("SkillTriggerRate".to_string(), rate);
    }
    true
}

fn truthy(m: &HashMap<String, ScalarValue>, key: &str) -> bool {
    match m.get(key) {
        Some(ScalarValue::Bool(b)) => *b,
        Some(_) => true,
        None => false,
    }
}

/// `addTriggerIncMoreMods` (CalcTriggers.lua:24): `TriggeredDamage` INC/MORE mods (evaluated against the source
/// skill's cfg) become `Damage` INC/MORE mods of the triggered skill.
/// CalcTriggers.lua ["snipe"] side effects on the real main skill (a standalone Snipe, or a Snipe-triggered skill with enough stages).
fn snipe_main_effects(a: &crate::triggers_wire::TrigApply, main: &ComputedSkill, sml: &mut ModStore, cfg: &pom_engine::modstore::types::Cfg, skill_data: &mut HashMap<String, ScalarValue>) {
    let mk = |n: &str, ty: ModType, v: Value, flags: u64, tags: Vec<pom_engine::modifier::Tag>| Mod { name: Sym::new(n), ty, value: v, flags, keyword_flags: 0, source: Some(std::sync::Arc::from("Snipe")), tags: (tags).into() };
    let stages = a.snipe_stages;
    let hit_multi = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("snipeHitMulti")]);
    let ail_multi = sml.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("snipeAilmentMulti")]);
    let mult_tag = || pom_engine::modifier::Tag { kind: pom_engine::sym!("Multiplier"), fields: vec![(pom_engine::sym!("var"), Value::Str(std::sync::Arc::from("SnipeStages")))] };
    let is_snipe = pom_skills::data::all_skills().get(&main.granted_effect_id).and_then(|ge| ge.name.as_deref()) == Some("Snipe");
    if is_snipe {
        skill_data.insert("hitTimeMultiplier".to_string(), ScalarValue::Num(stages.max(1.0) - 0.5));
        if a.snipe_triggered_n < 1 {
            sml.add_mod(mk("Multiplier:SnipeStages", ModType::Base, Value::Num(stages), 0, vec![]));
            sml.add_mod(mk("Damage", ModType::More, Value::Num(hit_multi), 0x4, vec![mult_tag()]));
            sml.add_mod(mk("Damage", ModType::More, Value::Num(ail_multi), 0x800, vec![mult_tag()]));
        } else {
            let tag = pom_engine::modifier::Tag { kind: pom_engine::sym!("SkillName"), fields: vec![(pom_engine::sym!("skillName"), Value::Str(std::sync::Arc::from("Snipe"))), (pom_engine::sym!("includeTransfigured"), Value::Bool(true))] };
            for t in ["Lightning", "Cold", "Fire", "Chaos", "Physical"] {
                sml.add_mod(mk(&format!("DealNo{t}"), ModType::Flag, Value::Bool(true), 0, vec![tag.clone()]));
            }
        }
    } else if a.result.snipe_mods {
        sml.add_mod(mk("Multiplier:SnipeStages", ModType::Base, Value::Num(stages), 0, vec![]));
        sml.add_mod(mk("Damage", ModType::More, Value::Num(ail_multi), 0x800, vec![mult_tag()]));
        sml.add_mod(mk("Damage", ModType::More, Value::Num(hit_multi), 0x4, vec![mult_tag()]));
    }
}

fn add_triggered_damage(sml: &mut ModStore, source_cfg: &pom_engine::modstore::types::Cfg) {
    let mut new: Vec<Mod> = Vec::new();
    for ty in [ModType::Inc, ModType::More] {
        for (_, p) in sml.tabulate(Some(ty), Some(source_cfg), &[pom_engine::sym!("TriggeredDamage")]) {
            // SAFETY: the pointer refers to a mod owned by `sml` (or its parent chain), alive for this call.
            let m = unsafe { &*p };
            // Arcanist Brand's "more Damage with Hits against Branded Enemy" is Hit-only in game; the TriggeredDamage mod
            // keeps flags 0 so it matches the source brand's cfg (no Hit bit), and only the Damage copy is scoped to Hit.
            let branded_hit = ty == ModType::More && pom_offence::data::pom_fixes_on() && m.tags.iter().any(|t| t.kind.as_str() == "Condition" && t.fields.iter().any(|(k, v)| k.as_str() == "var" && matches!(v, Value::Str(s) if &**s == "TargetingBrandedEnemy")));
            new.push(Mod { name: pom_engine::sym!("Damage"), ty, value: m.value.clone(), flags: if branded_hit { 0x4 } else { m.flags }, keyword_flags: m.keyword_flags, source: m.source.clone(), tags: m.tags.clone() });
        }
    }
    for m in new {
        sml.add_mod(m);
    }
}

pub(crate) trait TapAdd {
    fn tap_add(self, mods: &[Mod]) -> Self;
}
impl TapAdd for ModStore {
    fn tap_add(mut self, mods: &[Mod]) -> Self {
        for m in mods {
            self.add_mod(m.clone());
        }
        self
    }
}

/// `activeSkill.skillPart` of the main skill: the `skillPart` attribute of the gem the main socket
/// group's `mainActiveSkill` resolves to (1 when unset / single-part).
fn main_skill_part(_xml_text: &str, main: &ComputedSkill) -> i64 {
    // A FullDPS row re-run carries its own gem's saved `skillPart` (`srcInstance.skillPart`), which a Vaal gem's
    // secondary effect does not expose through `gem_skill_part`.
    if let Some(p) = crate::offence_dps::PART_OVERRIDE.with(|c| c.get()) {
        return p;
    }
    main.gem_skill_part.unwrap_or(1).max(1)
}

/// `CalcOffence.lua`:1667-1898's cost block (`pom_offence::costs`), for any main skill. The
/// per-second cost of upfront costs (5917-5950) needs the final Speed/Cooldown, which only the
/// non-attack path produces, so it runs only when `Speed` is in `env.output`.
fn skill_costs(player: &ModStore, output: &HashMap<String, f64>, main: &ComputedSkill, cfg: &pom_engine::modstore::types::Cfg, skill_data: &HashMap<String, ScalarValue>, skill_mod_list: &ModStore) -> Vec<(String, f64)> {
    let ge = main.granted_effect_id.clone();
    let level = main.level;
    // `activeEffect.grantedEffectLevel.<key>` (a bare per-level field such as `manaReservationPercent`).
    let level_obj = pom_skills::data::skill_level_obj(&ge, level);
    let level_field = |key: &str| -> Option<f64> { level_obj?.get(key)?.as_f64() };
    let level_reserve_flat = level_field("manaReservationFlat");
    let level_reserve_percent = level_field("manaReservationPercent");
    let ge = main.granted_effect_id.clone();
    let triggered_zero = player.flag(None, &[Sym::new(&format!("TriggeredZeroCost:{}:{}", ge, level.round() as i64))]);
    let level_cost = move |res: &str| -> Option<f64> {
        if triggered_zero {
            return None;
        }
        level_obj?.get("cost")?.get(res)?.as_f64()
    };
    let input = pom_offence::costs::CostInput {
        mods: skill_mod_list,
        cfg,
        level_cost: &level_cost,
        reservation_becomes_cost: main.skill_types.contains(&skill_type::RESERVATION_BECOMES_COST),
        mana_reservation_flat: num(skill_data, "manaReservationFlat").or(level_reserve_flat).unwrap_or(0.0),
        mana_reservation_percent: num(skill_data, "manaReservationPercent").or(level_reserve_percent).unwrap_or(0.0),
        output_mana: output.get("Mana").copied().unwrap_or(0.0),
        output_mana_unreserved: output.get("ManaUnreserved").copied(),
        output_energy_shield: output.get("EnergyShield").copied(),
        es_protects_mana: player.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]),
    };
    pom_offence::costs::calc_costs(&input)
}

/// `AuraEffectMod` and `<Pool>ReservedMod` (CalcOffence.lua:1187-1211).
fn add_aura_reservation_mods(output: &mut HashMap<String, f64>, main: &ComputedSkill, cfg: &pom_engine::modstore::types::Cfg, skill_data: &HashMap<String, ScalarValue>, skill_mod_list: &ModStore) {
    use pom_offence::tools::calc_lib_mod;
use pom_offence::tools::calc_lib_mod_s;
    if main.skill_types.contains(&skill_type::AURA) {
        let on_self = !(truthy(skill_data, "auraCannotAffectSelf") || main.skill_types.contains(&skill_type::AURA_AFFECTS_ENEMIES));
        let names: Vec<&str> = if on_self { vec!["AuraEffect", "SkillAuraEffectOnSelf"] } else { vec!["AuraEffect"] };
        output.insert("AuraEffectMod".to_string(), calc_lib_mod(skill_mod_list, Some(cfg), &names));
    }
    if main.skill_types.contains(&skill_type::LINK) {
        output.insert("LinkEffectMod".to_string(), calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("LinkEffect"), pom_engine::sym!("BuffEffect")]));
    }
    if main.skill_types.contains(&skill_type::HEX) || main.skill_types.contains(&skill_type::MARK) {
        output.insert("CurseEffectMod".to_string(), calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("CurseEffect")]));
    }
    if main.skill_types.contains(&skill_type::BUFF) && main.skill_types.contains(&skill_type::HERALD) {
        output.insert("HeraldBuffEffectMod".to_string(), calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("BuffEffect"), pom_engine::sym!("BuffEffectOnSelf")]));
    }
    if main.skill_types.contains(&skill_type::HAS_RESERVATION) && !main.skill_types.contains(&skill_type::RESERVATION_BECOMES_COST) {
        let support_mult = calc_lib_mod_s(skill_mod_list, Some(cfg), &[pom_engine::sym!("SupportManaMultiplier")]);
        for pool in ["Life", "Mana"] {
            let reserved = calc_lib_mod(skill_mod_list, Some(cfg), &[&format!("{pool}Reserved"), "Reserved"]);
            let mut v = 0.0;
            if support_mult > 0.0 && reserved > 0.0 {
                let eff = calc_lib_mod(skill_mod_list, Some(cfg), &[&format!("{pool}ReservationEfficiency"), "ReservationEfficiency"]);
                v = reserved * pom_offence::costs::floor_dec(support_mult, 4) / eff.max(0.0);
            }
            output.insert(format!("{pool}ReservedMod"), v);
        }
    }
}

fn add_costs(player: &ModStore, output: &mut HashMap<String, f64>, main: &ComputedSkill, cfg: &pom_engine::modstore::types::Cfg, skill_data: &HashMap<String, ScalarValue>, skill_mod_list: &ModStore) {
    let out = skill_costs(player, output, main, cfg, skill_data, skill_mod_list);
    // The per-second cost of upfront costs (5917-5950) needs Speed/Cooldown, so it runs at the end
    // of `compute_offence` (`add_costs_per_second`). Trap/mine/totem skills don't have
    // their placement/throw speeds produced yet, so their per-second keys are left
    // unproduced for a resource whose upfront cost would feed them - never guessed.
    for (k, v) in out {
        output.insert(k, v);
    }
}

/// Chance-to-inflict, `<Ailment>Chance`, and the Chill/Shock/Scorch/Brittle/Sap/Freeze effect and
/// duration outputs, for a non-attack main skill. The `damage > 0` gate (5432) needs
/// `output[<Type>HitAverage]/[<Type>CritAverage]`, which the live pipeline doesn't produce yet
/// (final hit damage is unported): the post-conversion `(min + max) / 2` stands in for them. Only the
/// sign of the source damage is observable through the outputs written here (chance and effect/
/// duration mods never scale with it), so this is exact unless a hit-time modifier zeroes an otherwise
/// positive damage type (e.g. an enemy with -100% damage taken).
#[allow(clippy::too_many_arguments, dead_code)]
fn add_ailments(player: &ModStore, enemy: &ModStore, config_str: &HashMap<String, String>, output: &mut HashMap<String, f64>, main: &ComputedSkill, cfg: &pom_engine::modstore::types::Cfg, skill_mod_list: &ModStore, crit_chance: f64) {
    use pom_offence::ailments as ail;
    let ctx = ail::ChanceCtx { skill_flags_attack: main.skill_flags.contains("attack"), skill_flags_hit: main.skill_flags.contains("hit"), mode_effective: pom_calc::setup::buff_mode().effective, env_mod_db: &player };
    let mut chances = ail::calc_ailment_chances(skill_mod_list, enemy, Some(cfg), &ctx);
    chances.remove(ail::IGNITE_SCORCH_MOD_KEY);
    ail::apply_ailment_mode(&mut chances, &player, config_str.get("ailmentMode").map(|m| m == "CRIT").unwrap_or(false));
    for (k, v) in &chances {
        output.insert(k.clone(), *v);
    }
    let mut hit_avg: HashMap<&str, f64> = HashMap::default();
    for dt in pom_offence::conversion::DMG_TYPES {
        let (min, max) = (output.get(&format!("{dt}Min")).copied().unwrap_or(0.0), output.get(&format!("{dt}Max")).copied().unwrap_or(0.0));
        hit_avg.insert(dt, (min + max) / 2.0);
    }
    let crit_avg = hit_avg.clone();
    let get = |k: &str| chances.get(k).copied().unwrap_or(0.0);
    let ailment_mode_crit = config_str.get("ailmentMode").map(|m| m == "CRIT").unwrap_or(false);
    let never_from_crit = player.flag(None, &[pom_engine::sym!("AilmentsAreNeverFromCrit")]);
    let debuff_mult = if pom_calc::setup::buff_mode().effective { 1.0 / pom_offence::data::misc("BuffExpirationSlowCap").max(pom_offence::tools::calc_lib_mod_s(enemy, Some(cfg), &[pom_engine::sym!("BuffExpireFaster")])) } else { 1.0 };

    if main.skill_types.contains(&skill_type::CHILLING_AREA) || main.skill_types.contains(&skill_type::NON_HIT_CHILL) {
        let c = ail::calc_chilling_area(skill_mod_list, enemy, Some(cfg));
        output.insert("ChillEffectMod".into(), c.chill_effect_mod);
        output.insert("ChillDurationMod".into(), c.chill_duration_mod);
        output.insert("ChillSourceEffect".into(), c.chill_source_effect);
    }
    // Freeze (5399-5414).
    let (fh, fc) = (get("FreezeChanceOnHit"), get("FreezeChanceOnCrit"));
    if fh + fc > 0.0 {
        let (sh, sc) = ail::calc_average_source_damage(skill_mod_list, Some(cfg), "Freeze", &hit_avg, &crit_avg);
        let (chance, _) = ail::calc_ailment_damage(fh, fc, crit_chance, sh, sc);
        output.insert("FreezeChance".into(), chance);
        if let Some(d) = ail::calc_freeze_duration_mod(skill_mod_list, enemy, Some(cfg), fh, fc, crit_chance, sh, sc) {
            output.insert("FreezeDurationMod".into(), d);
        }
    }
    for ailment in ["Chill", "Shock", "Scorch", "Brittle", "Sap"] {
        let (h, c) = (get(&format!("{ailment}ChanceOnHit")), get(&format!("{ailment}ChanceOnCrit")));
        if h + c <= 0.0 {
            continue;
        }
        let acfg = ail::with_crit_cond(Some(cfg), ailment_mode_crit && !never_from_crit);
        let acfg = acfg.as_ref();
        let (sh, sc) = ail::calc_average_source_damage(skill_mod_list, acfg, ailment, &hit_avg, &crit_avg);
        let (chance, _) = ail::calc_ailment_damage(h, c, crit_chance, sh, sc);
        output.insert(format!("{ailment}Chance"), chance);
        let out = ail::calc_non_damaging_ailment(skill_mod_list, enemy, acfg, ailment, &ail::NonDamagingAilmentCtx { chance_on_hit: h, chance_on_crit: c, crit_chance, source_hit_dmg: sh, source_crit_dmg: sc, debuff_duration_mult: debuff_mult });
        if let (Some(d), Some(e)) = (out.duration, out.effect_mod) {
            output.insert(format!("{ailment}Duration"), d);
            output.insert(format!("{ailment}EffectMod"), e);
        }
    }
}

/// Second half of the cost block, once Speed/Cooldown/Repeats are in `output`.
fn add_costs_per_second(player: &ModStore, output: &mut HashMap<String, f64>, main: &ComputedSkill, cfg: &pom_engine::modstore::types::Cfg, skill_mod_list: &ModStore, skill_data: &HashMap<String, ScalarValue>) {
    pom_offence::bd::set_pass(None);
    let mut out: Vec<(String, f64)> = output.iter().filter(|(k, _)| k.ends_with("Cost") || k.ends_with("HasCost")).map(|(k, v)| (k.clone(), *v)).collect();
    let speed = output.get("Speed").copied().unwrap_or(0.0);
    let cooldown = output.get("Cooldown").copied();
    let repeats = output.get("Repeats").copied().unwrap_or(1.0);
    let f = &main.skill_flags;
    let trap_mine = f.contains("trap") || f.contains("mine");
    let totem = f.contains("totem");
    let pre_speed = output.get("TrapThrowingSpeed").or(output.get("MineLayingSpeed")).copied();
    let trap_cd = output.get("TrapCooldown").copied().or(cooldown);
    let tps = output.get("TotemPlacementSpeed").copied().unwrap_or(0.0);
    let unleash = skill_mod_list.flag(None, &[pom_engine::sym!("HasSeals")]) && skill_mod_list.flag(None, &[pom_engine::sym!("UseMaxUnleash")]);
    let hto = num(skill_data, "hitTimeOverride");
    let use_speed = move || {
        if trap_mine {
            return match trap_cd { Some(c) if c > 0.0 => 1.0 / c, _ => pre_speed.unwrap_or(0.0) };
        }
        if totem {
            return (match cooldown { Some(c) if c > 0.0 => if tps > 0.0 { tps } else { 1.0 / c }, _ => tps }) / repeats;
        }
        if let (true, Some(h)) = (unleash, hto) {
            // hitTimeOverride is seconds, so the use rate is its inverse (differs from upstream).
            if pom_offence::data::pom_fixes_on() && h > 0.0 {
                return 1.0 / h / repeats;
            }
            return h / repeats;
        }
        (match cooldown { Some(c) if c > 0.0 => if speed > 0.0 { speed } else { 1.0 / c }, _ => speed }) / repeats
    };
    let es_conv = skill_mod_list.sum(ModType::Base, Some(cfg), &[pom_engine::sym!("ManaCostAsEnergyShieldCost")]);
    // CalcOffence.lua:5921-5941 `timeType` (only the breakdown line reads it).
    let time_type = if trap_mine {
        if f.contains("trap") { "trap throwing" } else { "mine laying" }
    } else if totem {
        "totem placement"
    } else if unleash && hto.is_some() {
        "full unleash"
    } else if truthy(skill_data, "triggered") {
        "trigger"
    } else if f.contains("attack") {
        "attack"
    } else {
        "cast"
    };
    pom_offence::costs::add_upfront_per_second(&mut out, player.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]), es_conv, speed > 0.0 || cooldown.is_some(), use_speed, time_type);
    for (k, v) in out {
        output.insert(k, v);
    }
}

/// `calcs.buildOutput`'s cost warnings (Calcs.lua:404-433): every active skill's own cost (as if it
/// were the main skill) against the player's pools. Lists are `player.output.<Res>CostWarningList`
/// (skill names), `<Res>CostWarning` is set when the main skill itself is among them. Skills'
/// `<Pool>ReservedPercent` is not available here (`skillData` never gets it live), so a skill that
/// both costs and reserves is treated as having no reservation.
pub fn cost_warnings(env: &mut Env, xml_text: &str) {
    // `grantedEffect.name` as-is (`ComputedSkill::name` has the "Vaal " prefix stripped for `skillCfg.skillName`).
    let raw_name = |c: &pom_skills::assemble::ComputedSkill| pom_calc::skills::granted_effect_by_id(&c.granted_effect_id).and_then(|g| g.name.clone()).unwrap_or_else(|| c.name.clone());
    let main_name = select_main_skill(xml_text, &env.active_skills).map(|m| raw_name(m));
    let player_snap = crate::buffs::player_snapshot(&env.player);
    let eb = env.player.flag(None, &[pom_engine::sym!("EnergyShieldProtectsMana")]);
    let mut lists: Vec<(String, Vec<String>)> = Vec::new();
    let mut push = |key: String, name: &str| {
        if let Some(e) = lists.iter_mut().find(|(k, _)| *k == key) {
            e.1.push(name.to_string());
        } else {
            lists.push((key, vec![name.to_string()]));
        }
    };
    let mut warned_main: Vec<String> = Vec::new();
    let reserved_pct = crate::reservation(env).per_skill;
    for (idx, c) in env.active_skills.iter().enumerate() {
        if c.skill_flags.contains("disable") {
            continue;
        }
        if MIRAGE_CHOSEN.with(|m| m.borrow().iter().any(|(g, a, b)| *g == c.granted_effect_id && *a == c.group_xml_index && *b == c.gem_index)) {
            continue;
        }
        let cfg = build_skill_cfg(c);
        let skill_data = skill_data_map(&env.player, c);
        // CalcMirages.lua (triggeredByGeneralsCry branch): the skill's own cached run adds HasNoCost, so its cached output has no *Cost keys.
        if truthy(&skill_data, "triggeredByGeneralsCry") {
            continue;
        }
        // CalcActiveSkill.lua:530-538: two trigger supports disable the skill (its cached output has no *Cost keys).
        if c.effect_list.iter().filter(|&&i| c.support_list.get(i).is_some_and(|&(sge, _, _)| pom_skills::data::is_trigger(sge) && sge.extra.get("addSkillTypes").is_some())).count() > 1 {
            continue;
        }
        let mods = ModStore::new_list(Some(player_snap.clone()), env.player.actor.clone()).tap_add(&c.skill_mod_list);
        let costs = skill_costs(&env.player, &env.output, c, &cfg, &skill_data, &mods);
        let cost = |k: &str| costs.iter().find(|(n, _)| n == k).map(|(_, v)| *v);
        for (pool, res) in [("LifeUnreserved", "LifeCost"), ("ManaUnreserved", "ManaCost"), ("Rage", "RageCost"), ("EnergyShield", "ESCost")] {
            let Some(cached) = cost(res) else { continue };
            let total_pool = if eb && res == "ManaCost" { env.output.get("EnergyShield").copied().unwrap_or(0.0) } else { 0.0 } + env.output.get(pool).copied().unwrap_or(0.0);
            if total_pool < cached {
                // Skill has both cost and reservation: only warn if the pool can't cover the raw cost before reservation (Calcs.lua:411-414).
                let raw_pool = pool.trim_end_matches("Unreserved");
                let reservation = reserved_pct.iter().find(|(i, n, _)| *i == idx && *n == raw_pool).map(|(_, _, v)| *v);
                if let Some(r) = reservation {
                    if !(total_pool + (env.output.get(raw_pool).copied().unwrap_or(0.0) * r / 100.0).ceil() < cached) {
                        continue;
                    }
                }
                if main_name.as_deref() == Some(raw_name(c).as_str()) {
                    warned_main.push(format!("{res}Warning"));
                }
                push(format!("{res}WarningList"), &raw_name(c));
            }
        }
        for (pool, res) in [("LifeUnreservedPercent", "LifePercentCost"), ("ManaUnreservedPercent", "ManaPercentCost")] {
            let Some(cached) = cost(res) else { continue };
            if env.output.get(pool).copied().unwrap_or(0.0) < cached {
                push(format!("{res}PercentCostWarningList"), &raw_name(c));
            }
        }
    }
    if eb && env.active_skills.iter().any(|c| !c.skill_flags.contains("disable")) {
        env.output.insert("EnergyShieldProtectsMana".into(), 1.0);
    }
    for k in warned_main {
        env.output.insert(k, 1.0);
    }
    for (k, v) in lists {
        env.output_lists.insert(k, v);
    }
}

/// `skillModList`'s actor `output` (`ModStore:GetStat`'s `self.actor.output[stat]`, read by every
/// `PerStat`/`GetStat`-tagged mod): the actor's output table as it stands *now*, plus (for a
/// non-attack pass, whose output table IS the actor's) the pass's own keys. `env.player.actor` is a
/// snapshot from before the defence/offence stages, so it has to be refreshed.
fn refresh_actor(sml: &mut ModStore, global: &HashMap<String, f64>, pass_out: Option<&HashMap<String, f64>>) {
    let output = match MIRAGE_ACTOR_OUT.with(|m| m.borrow().clone()) {
        Some(old) => old.iter().map(|(k, v)| (Sym::new(k), *v)).collect(),
        None => global.iter().chain(pass_out.into_iter().flatten()).map(|(k, v)| (Sym::new(k), *v)).collect(),
    };
    sml.actor = Some(std::sync::Arc::new(crate::actor_with_output(sml.actor.as_deref(), output)));
}

/// `weapon1Cfg.skillStats = output.MainHand` (CalcOffence.lua:2013-2051): an attack hand's cfg reads
/// `PerStat` stats from that hand's own output table first (`ModStore.lua:379`).
fn sync_pass_stats(sml: &mut ModStore, cfg: &mut pom_engine::modstore::types::Cfg, is_attack: bool, global: &HashMap<String, f64>, pass_out: &HashMap<String, f64>) {
    if is_attack {
        cfg.skill_stats = pass_out.iter().map(|(k, v)| (Sym::new(k), *v)).collect();
        // the global `output` (e.g. `ActiveTotemLimit`, written as offence runs) is read after `skillStats`
        refresh_actor(sml, global, None);
    } else {
        refresh_actor(sml, global, Some(pass_out));
    }
}


/// The Pact block of the per-pass damage loop (CalcOffence.lua:2891-2946). Every Pact shares the
/// uptime calculation, each applies to different spell types; a Pact is applied at most once
/// (`globalOutput["PactOf<key>Calculated"]`).
fn apply_pacts(env: &mut Env, main: &ComputedSkill, skills: &[ComputedSkill], sml: &mut ModStore, speed: f64) {
    use pom_skills::skill_type as st;
    let snap = crate::buffs::player_snapshot(&env.player);
    let tick = pom_offence::data::misc("ServerTickRate");
    let is_vaal = main.skill_types.contains(&st::VAAL);
    let has_flag = |f: &str| main.skill_flags.contains(f);
    for value in skills {
        let Some(rest) = value.name.strip_prefix("Pact of ") else { continue };
        let key = if rest == "K'Tash" { "Ktash" } else { rest };
        let applies = match key {
            "Beidat" => !is_vaal && !main.skill_types.contains(&st::CHANNEL) && (has_flag("projectile") || main.skill_types.contains(&st::CASCADABLE) || (has_flag("chaining") && !has_flag("projectile"))),
            "Ghorr" => !is_vaal && main.skill_types.contains(&st::DAMAGE_OVER_TIME),
            "Ktash" => is_vaal && (main.skill_types.contains(&st::DAMAGE) || main.skill_types.contains(&st::DAMAGE_OVER_TIME)),
            "Lycia" => !is_vaal && main.skill_types.contains(&st::CHANNEL) && has_flag("selfCast"),
            _ => false,
        };
        let calculated = format!("PactOf{key}Calculated");
        if !applies || env.output.contains_key(&calculated) || value.skill_flags.contains("disable") {
            continue;
        }
        let store = crate::ailments::skill_store(&snap, value);
        let vcfg = crate::buffs::skill_cfg(value);
        let sd = skill_data_map(&env.player, value);
        let cooldown = pom_offence::cooldown::calc_skill_cooldown(&store, Some(&vcfg), num(&sd, "cooldown"), num(&sd, "storedUses"), num(&sd, "vaalStoredUses")).0;
        let asm = env.output.get("ActionSpeedMod").copied().unwrap_or(1.0);
        let cast_time_base = pom_offence::data::skill_cast_time(&value.granted_effect_id).unwrap_or(0.0);
        let cast_rate = 1.0 / cast_time_base * pom_offence::tools::calc_lib_mod_s(&store, Some(&vcfg), &[pom_engine::sym!("Speed")]) * asm;
        let cast_time = 1.0 / cast_rate.min(tick);
        let count = store.sum(ModType::Base, Some(&vcfg), &[Sym::new(&format!("{key}EmpoweredSpells"))]);
        let stored_uses = num(&sd, "storedUses").unwrap_or(0.0) + store.sum(ModType::Base, Some(&vcfg), &[pom_engine::sym!("AdditionalCooldownUses")]);
        let mut uptime = if speed == 0.0 { 100.0 } else { ((count / speed) / (cooldown + cast_time)).min(1.0) * 100.0 };
        uptime = (uptime * stored_uses).min(100.0);
        let effect = if sml.flag(None, &[pom_engine::sym!("Condition:PactMaxHit")]) { 100.0 } else { uptime };
        let effect_mult = effect / 100.0;
        env.output.insert("CreatePactOffensiveCalcSection".to_string(), 1.0);
        env.output.insert(format!("PactOf{key}Cooldown"), cooldown);
        env.output.insert(format!("PactOf{key}CastTime"), cast_time);
        env.output.insert(format!("{key}EmpoweredCount"), count);
        env.output.insert(format!("{key}UpTimeRatio"), uptime);
        if pom_offence::bd::on() {
            pom_offence::bd_d::pact_uptime(key, count, speed, cooldown, cast_time, stored_uses, uptime);
        }
        if let Some(Value::Map(entry)) = store.list(Some(&vcfg), &[Sym::new(&format!("{key}PactDamage"))]).into_iter().next() {
            if let Some((_, Value::Map(inner))) = entry.iter().find(|(k, _)| k.as_str() == "mod") {
                let mut m = crate::actor_misc::map_to_mod(inner);
                m.value = Value::Num(m.value.num().unwrap_or(0.0) * effect_mult);
                m.source = Some(std::sync::Arc::from(format!("Uptime Scaled {}", value.name)));
                sml.add_mod(m);
            }
        }
        let sum_v = |name: &str| store.sum(ModType::Base, Some(&vcfg), &[Sym::new(name)]);
        if key == "Beidat" {
            if has_flag("projectile") && !sml.flag(None, &[pom_engine::sym!("NoAdditionalProjectiles")]) && !sml.flag(None, &[pom_engine::sym!("SingleProjectile")]) {
                let add = sum_v("BeidatAdditionalProjectiles") * effect_mult;
                env.output.insert("BeidatAdditionalProjectiles".to_string(), add);
                *env.output.entry("ProjectileCount".to_string()).or_insert(0.0) += add;
            }
            if has_flag("chaining") && !has_flag("projectile") && !sml.flag(None, &[pom_engine::sym!("CannotChain")]) && !sml.flag(None, &[pom_engine::sym!("NoAdditionalChains")]) {
                let add = sum_v("BeidatAdditionalBeamChains") * effect_mult;
                env.output.insert("BeidatAdditionalBeamChains".to_string(), add);
                let chain_max = env.output.get("ChainMax").copied().unwrap_or(0.0) + add;
                env.output.insert("ChainMax".to_string(), chain_max);
                env.output.insert("ChainMaxString".to_string(), chain_max);
                let chain = env.output.get("Chain").copied().unwrap_or(0.0);
                env.output.insert("ChainRemaining".to_string(), (chain_max - chain).max(0.0));
            }
            if main.skill_types.contains(&st::CASCADABLE) {
                env.output.insert("BeidatAdditionalCascades".to_string(), sum_v("BeidatAdditionalCascades") * effect_mult);
            }
        } else if key == "Ktash" {
            env.output.insert("KtashSoulRefundChance".to_string(), sum_v("KtashPactSoulRefundChance") * effect_mult);
            if let Some(duration) = env.output.get("SoulGainPreventionDuration").copied() {
                let duration_mod = 1.0 + sum_v("KtashPactSoulGainPrevention") * effect_mult / 100.0;
                env.output.insert("SoulGainPreventionDuration".to_string(), ((duration * duration_mod * tick).ceil()).max(1.0) / tick);
                if pom_offence::bd::on() {
                    pom_offence::bd_d::soul_gain_prevention(duration, duration_mod, env.output["SoulGainPreventionDuration"]);
                }
            }
        }
        env.output.insert(calculated, 1.0);
    }
}


fn lua_min(a: f64, b: f64) -> f64 {
    if b < a { b } else { a }
}

/// The exerted-attack warcry block of the per-pass damage loop (CalcOffence.lua:2612-2838): each
/// enabled warcry's uptime ratio against this attack, Intimidating/Rallying hit effects, Seismic's
/// AoE, then the aggregated exerted-attack damage mods. `skill_cfg` is `skillCfg`, `pass_cfg` the
/// pass's own `cfg` (per-hand for attacks).
#[allow(clippy::too_many_arguments)]
fn apply_warcries(env: &mut Env, main: &ComputedSkill, skills: &[ComputedSkill], sml: &mut ModStore, skill_cfg: &pom_engine::modstore::types::Cfg, pass_cfg: &pom_engine::modstore::types::Cfg, speed: f64, skill_data: &HashMap<String, ScalarValue>) {
    use pom_skills::skill_type as st;
    let snap = crate::buffs::player_snapshot(&env.player);
    let tick = pom_offence::data::misc("ServerTickRate");
    let t = |ty: i64| main.skill_types.contains(&ty);
    let max_hit = sml.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]);
    let exerted_double_damage = env.player.sum(ModType::Base, Some(pass_cfg), &[pom_engine::sym!("ExertDoubleDamageChance")]);
    let exerting_warcry_count = env.player.sum(ModType::Base, None, &[pom_engine::sym!("Multiplier:ExertingWarcryCount")]);
    for value in skills {
        if value.skill_flags.contains("disable") {
            continue;
        }
        // (name, calculated key, key prefix used by the Duration/Cooldown/CastTime outputs, exert-count mod, exerts-count output, uptime output, applies)
        let (prefix, exerts_mod, exerts_out, uptime_out, applies_uptime, extra_gate) = match value.name.as_str() {
            "Ancestral Cry" => ("Ancestral", "NumAncestralExerts", "AncestralExertsCount", "AncestralUpTimeRatio", true, t(st::MELEE_SINGLE_TARGET)),
            "Infernal Cry" => ("Infernal", "NumInfernalExerts", "InfernalExertsCount", "InfernalUpTimeRatio", t(st::MELEE), true),
            "Intimidating Cry" => ("Intimidating", "NumIntimidatingExerts", "IntimidatingExertsCount", "IntimidatingUpTimeRatio", true, t(st::MELEE)),
            "Rallying Cry" => ("Rallying", "NumRallyingExerts", "RallyingExertsCount", "RallyingUpTimeRatio", true, t(st::MELEE)),
            "Seismic Cry" => ("Seismic", "NumSeismicExerts", "SeismicExertsCount", "SeismicUpTimeRatio", true, t(st::SLAM)),
            "Battlemage's Cry" => ("BattleMage", "NumBattlemageExerts", "BattleCryExertsCount", "BattlemageUpTimeRatio", t(st::MELEE), true),
            _ => continue,
        };
        let calc_key = format!("{prefix}CryCalculated");
        if !extra_gate || env.output.contains_key(&calc_key) {
            continue;
        }
        let store = crate::ailments::skill_store(&snap, value);
        let vcfg = crate::buffs::skill_cfg(value);
        let sd = skill_data_map(&env.player, value);
        let mine_applies = truthy(&sd, "mineDurationAppliesToSkill");
        let duration = pom_offence::cooldown::calc_skill_duration_helper(&store, Some(&vcfg), num(&sd, "duration"), mine_applies, truthy(&sd, "debuff"), true, &env.enemy);
        let cooldown = pom_offence::cooldown::calc_skill_cooldown(&store, Some(&vcfg), num(&sd, "cooldown"), num(&sd, "storedUses"), num(&sd, "vaalStoredUses")).0;
        // calcWarcryCastTime (CalcOffence.lua:311-320)
        let asm = env.output.get("ActionSpeedMod").copied().unwrap_or(1.0);
        let base_speed = 1.0 / store.sum(ModType::Base, Some(&vcfg), &[pom_engine::sym!("WarcryCastTime")]);
        let cast_speed = lua_min(base_speed * pom_offence::tools::calc_lib_mod_s(&store, Some(&vcfg), &[pom_engine::sym!("WarcrySpeed")]) * asm, tick);
        let cast_time = if store.flag(Some(&vcfg), &[pom_engine::sym!("InstantWarcry")]) || truthy(&sd, "triggeredByAutoexertion") { 0.0 } else { 1.0 / cast_speed };
        env.output.insert(format!("{prefix}CryDuration"), duration);
        env.output.insert(format!("{prefix}CryCooldown"), cooldown);
        env.output.insert(format!("{prefix}CryCastTime"), cast_time);
        if matches!(prefix, "Intimidating" | "Rallying" | "Seismic") {
            env.output.insert("CreateWarcryOffensiveCalcSection".to_string(), 1.0);
        }
        let mut uptime = 0.0;
        if applies_uptime {
            let count = env.player.sum(ModType::Base, None, &[Sym::new(exerts_mod)]);
            env.output.insert(exerts_out.to_string(), count);
            let base_uptime = lua_min((count / speed) / (cooldown + cast_time), 1.0) * 100.0;
            let stored_uses = num(&sd, "storedUses").unwrap_or(0.0) + store.sum(ModType::Base, Some(&vcfg), &[pom_engine::sym!("AdditionalCooldownUses")]);
            uptime = lua_min(100.0, base_uptime * stored_uses);
            env.output.insert(uptime_out.to_string(), uptime);
            *env.output.entry("GlobalWarcryUptimeRatio".to_string()).or_insert(0.0) += uptime;
            if pom_offence::bd::on() {
                pom_offence::bd_d::warcry_uptime(uptime_out, count, speed, cast_time, cooldown, stored_uses, uptime);
            }
        }
        let mul = |out: &mut HashMap<String, f64>, k: &str, f: f64| {
            let v = out.get(k).copied().unwrap_or(1.0) * f;
            out.insert(k.to_string(), v);
        };
        match prefix {
            "Intimidating" => {
                let dd_chance = lua_min(sml.sum(ModType::Base, Some(pass_cfg), &[pom_engine::sym!("DoubleDamageChance")]) + env.enemy.sum(ModType::Base, Some(pass_cfg), &[pom_engine::sym!("SelfDoubleDamageChance")]) + exerted_double_damage, 100.0);
                let avg = 2.0 * (1.0 - dd_chance / 100.0);
                let hit_effect = 1.0 + avg * uptime / 100.0;
                let max_hit_effect = 1.0 + avg;
                env.output.insert("IntimidatingAvgDmg".to_string(), avg);
                env.output.insert("IntimidatingHitEffect".to_string(), hit_effect);
                env.output.insert("IntimidatingMaxHitEffect".to_string(), max_hit_effect);
                mul(&mut env.output, "TheoreticalOffensiveWarcryEffect", hit_effect);
                mul(&mut env.output, "TheoreticalMaxOffensiveWarcryEffect", max_hit_effect);
                if pom_offence::bd::on() {
                    pom_offence::bd_d::intimidating(dd_chance, avg, uptime, hit_effect);
                }
            }
            "Rallying" => {
                let per_ally = env.player.sum(ModType::Base, None, &[pom_engine::sym!("RallyingExertMoreDamagePerAlly")]) / 100.0;
                let allies = lua_min(env.player.sum(ModType::Base, Some(pass_cfg), &[pom_engine::sym!("Multiplier:NearbyAlly")]), 5.0);
                let avg = allies * per_ally;
                let hit_effect = 1.0 + avg * uptime / 100.0;
                let max_hit_effect = 1.0 + avg;
                env.output.insert("RallyingAvgDmg".to_string(), avg);
                env.output.insert("RallyingHitEffect".to_string(), hit_effect);
                env.output.insert("RallyingMaxHitEffect".to_string(), max_hit_effect);
                mul(&mut env.output, "OffensiveWarcryEffect", hit_effect);
                mul(&mut env.output, "MaxOffensiveWarcryEffect", max_hit_effect);
                mul(&mut env.output, "TheoreticalOffensiveWarcryEffect", hit_effect);
                mul(&mut env.output, "TheoreticalMaxOffensiveWarcryEffect", max_hit_effect);
                if pom_offence::bd::on() {
                    pom_offence::bd_d::rallying(per_ally, allies, avg, uptime, hit_effect);
                }
            }
            "Seismic" => {
                let more_aoe = env.player.sum(ModType::Base, None, &[pom_engine::sym!("SeismicMoreAoE")]);
                let (v, src) = if sml.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]) { (more_aoe, "Max Seismic Exert AoE") } else { ((more_aoe / 100.0 * uptime).floor(), "Avg Seismic Exert AoE") };
                sml.add_mod(Mod { name: pom_engine::sym!("AreaOfEffect"), ty: ModType::More, value: Value::Num(v), flags: 0, keyword_flags: 0, source: Some(std::sync::Arc::from(src)), tags: (vec![]).into() });
                // `calcAreaOfEffect(..., globalOutput, globalBreakdown)`: the area table goes to the actor's own table.
                pom_offence::bd::with_root_scope(|| crate::skillgeo::recalc_area(env, main, sml, skill_cfg, skill_data));
            }
            _ => {}
        }
        env.output.insert(calc_key, 1.0);
    }

    env.output.insert("AilmentWarcryEffect".to_string(), env.output[if max_hit { "MaxOffensiveWarcryEffect" } else { "OffensiveWarcryEffect" }]);

    // Exerted attack uptime: the maximum uptime of any enabled exerting warcry.
    for k in ["AncestralUpTimeRatio", "InfernalUpTimeRatio", "IntimidatingUpTimeRatio", "RallyingUpTimeRatio", "SeismicUpTimeRatio", "BattlemageUpTimeRatio"] {
        let cur = env.output.get("ExertedAttackUptimeRatio").copied().unwrap_or(0.0);
        let v = env.output.get(k).copied().unwrap_or(0.0);
        env.output.insert("ExertedAttackUptimeRatio".to_string(), if v > cur { v } else { cur });
    }
    let uptime = env.output["ExertedAttackUptimeRatio"];
    if pom_offence::bd::on() {
        let keys = ["AncestralUpTimeRatio", "InfernalUpTimeRatio", "IntimidatingUpTimeRatio", "RallyingUpTimeRatio", "SeismicUpTimeRatio", "BattlemageUpTimeRatio"];
        let ratios: Vec<(&str, Option<f64>)> = keys.iter().map(|k| (*k, env.output.get(*k).copied())).collect();
        pom_offence::bd_d::exerted_uptime(&ratios, uptime);
    }
    if uptime > 0.0 && !env.output.contains_key("ExertedAttackUptimeRatioCalculated") {
        let c = Some(pass_cfg);
        let inc = sml.sum(ModType::Inc, c, &[pom_engine::sym!("ExertIncrease")]);
        let more = sml.sum(ModType::More, c, &[pom_engine::sym!("ExertIncrease")]);
        let more_dmg = sml.sum(ModType::More, c, &[pom_engine::sym!("ExertAttackIncrease")]);
        let overexertion = sml.sum(ModType::More, c, &[pom_engine::sym!("OverexertionExertAverageIncrease")]);
        let echoes = sml.sum(ModType::More, c, &[pom_engine::sym!("EchoesExertAverageIncrease")]);
        let add = |sml: &mut ModStore, ty: ModType, v: f64, src: &str, flags: u64| sml.add_mod(Mod { name: pom_engine::sym!("Damage"), ty, value: Value::Num(v), flags, keyword_flags: 0, source: Some(std::sync::Arc::from(src)), tags: (vec![]).into() });
        if max_hit {
            add(sml, ModType::Inc, inc, "Exerted Attacks", 0);
            add(sml, ModType::More, more, "Exerted Attacks", 0);
            add(sml, ModType::More, more_dmg, "Exerted Attack Damage", 1);
            add(sml, ModType::More, overexertion * exerting_warcry_count, "Max Autoexertion Support", 0);
            add(sml, ModType::More, echoes * exerting_warcry_count, "Max Echoes of Creation", 0);
        } else {
            let global = env.output["GlobalWarcryUptimeRatio"];
            add(sml, ModType::Inc, inc * uptime / 100.0, "Uptime Scaled Exerted Attacks", 0);
            add(sml, ModType::More, more * uptime / 100.0, "Uptime Scaled Exerted Attacks", 0);
            add(sml, ModType::More, more_dmg * uptime / 100.0, "Uptime Scaled Exerted Attack Damage", 1);
            add(sml, ModType::More, overexertion * global / 100.0, "Uptime Scaled Autoexertion Support", 0);
            add(sml, ModType::More, echoes * global / 100.0, "Uptime Scaled Echoes of Creation", 0);
        }
        let mut avg = pom_offence::tools::calc_lib_mod_s(sml, Some(skill_cfg), &[pom_engine::sym!("ExertIncrease")]);
        avg *= pom_offence::tools::calc_lib_mod_s(sml, Some(skill_cfg), &[pom_engine::sym!("ExertAttackIncrease"), pom_engine::sym!("OverexertionExertAverageIncrease"), pom_engine::sym!("EchoesExertAverageIncrease")]);
        env.output.insert("ExertedAttackAvgDmg".to_string(), avg);
        env.output.insert("ExertedAttackHitEffect".to_string(), avg * uptime / 100.0);
        env.output.insert("ExertedAttackMaxHitEffect".to_string(), avg);
        if pom_offence::bd::on() {
            pom_offence::bd_d::exerted_hit_effect(avg, uptime, avg * uptime / 100.0);
        }
        env.output.insert("ExertedAttackUptimeRatioCalculated".to_string(), 1.0);
    }
}
