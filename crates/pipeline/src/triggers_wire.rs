//! Live wiring of `calcs.triggers` (CalcTriggers.lua) into the pipeline: builds `pom_triggers`' plain-fact
//! `Skill` records from every active skill, builds the `GlobalCache` entries `findTriggerSkill` asks for on
//! demand (each source skill is run through `compute_offence_for`, the `calcs.buildActiveSkill` stand-in that
//! FullDPS already uses), runs `calcs_triggers` for the main skill and keeps the result for the offence pass.
use crate::Env;
use pom_engine::modstore::types::ScalarValue;
use pom_engine::sym::Sym;
use pom_skills::assemble::ComputedSkill;
use pom_triggers::{GcEntry, GlobalCache, ScalarMap, Skill};
use serde_json::{json, Value as J};
use pom_engine::fxhash::HashMap;

/// What `calcs.triggers` wrote for the main skill, applied to `skillData`/`output` by the offence pass.
#[derive(Clone)]
pub struct TrigApply {
    pub main_idx: usize,
    pub source_idx: Option<usize>,
    pub result: pom_triggers::engine::TriggerResult,
    /// `min(Multiplier:SnipeStage, Multiplier:SnipeStagesMax)` and how many skills in the main's slot are Snipe-triggered.
    pub snipe_stages: f64,
    pub snipe_triggered_n: usize,
    /// `GlobalCache...[skillData.triggerSourceUUID].Env.player.output.TotemLife` when a trigger source was found (Avenging Flame's hook).
    pub source_totem_life: Option<f64>,
}

thread_local! {
    /// Set while a nested (cache-building) offence pass runs, so it never runs triggers itself.
    pub(crate) static NESTED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    /// `skill.skillData.hitTimeMultiplier = stages - 0.5` written onto a Snipe before it is cache-built (CalcTriggers.lua:1461).
    pub(crate) static SNIPE_STAGES: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
    pub(crate) static SNIPE_HTM: std::cell::Cell<Option<f64>> = const { std::cell::Cell::new(None) };
}

fn jnum(v: f64) -> J {
    if v.is_nan() {
        J::String("NaN".into())
    } else if v == f64::INFINITY {
        J::String("Inf".into())
    } else if v == f64::NEG_INFINITY {
        J::String("-Inf".into())
    } else {
        json!(v)
    }
}

pub(crate) fn scalar_to_json(v: &ScalarValue) -> J {
    match v {
        ScalarValue::Num(n) => jnum(*n),
        ScalarValue::Str(s) => J::String(s.to_string()),
        ScalarValue::Bool(b) => J::Bool(*b),
    }
}

fn ge_name(c: &ComputedSkill) -> String {
    pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|g| g.name.clone()).unwrap_or_else(|| c.name.clone())
}

fn group_id(c: &ComputedSkill) -> i64 {
    if let Some(i) = c.group_xml_index {
        return i as i64;
    }
    // Synthetic (item-granted) group: identity is its slot + source.
    let mut h: i64 = 1_000_000;
    for b in format!("{:?}|{:?}", c.group_slot, c.group_source).bytes() {
        h = h.wrapping_mul(31).wrapping_add(b as i64) & 0x7fff_ffff;
    }
    h + 1_000_000
}

/// Level cooldown of a granted effect at `level` (`ge.levels[level].cooldown`).
fn level_cooldown(ge_id: &str, level: f64) -> Option<f64> {
    crate::offence::level_field_pub(ge_id, level, "cooldown")
}

/// `cacheSkillUUID(skill, env)` (Common.lua:897): the granted effect's name without spaces, the group's slot in upper case
/// without spaces ("NO_SLOT" for none), the gem's place in its group and the group's place in the build.
fn lua_skill_uuid(c: &ComputedSkill) -> String {
    let name: String = ge_name(c).split_whitespace().collect();
    let slot: String = c.group_slot.as_deref().map(|s| s.to_uppercase().split_whitespace().collect()).unwrap_or_else(|| "NO_SLOT".to_string());
    let gem_idx = c.gem_index.map(|i| i + 1).unwrap_or(1);
    // the group's place in the build's socket group list (1-based); a skill without a slot shows it in the Calcs tab's SimData rows
    let group_idx = c.group_xml_index.map(|i| i as i64 + 1).unwrap_or_else(|| group_id(c));
    format!("{}_{}_{}_{}", name, slot, gem_idx, group_idx)
}

fn skill_uuid(idx: usize, c: &ComputedSkill) -> String {
    format!("{}_{}_{}", c.name, c.slot_name.clone().unwrap_or_default(), idx)
}

fn build_one(env: &Env, idx: usize, c: &ComputedSkill) -> Skill {
    let ge = pom_skills::data::all_skills().get(&c.granted_effect_id);
    let (store, cfg) = crate::offence::skill_store_pub(env, c);
    let sd = crate::offence::skill_data_map(&env.player, c);
    let mut skill_data: ScalarMap = HashMap::default();
    for (k, v) in &sd {
        skill_data.insert(k.clone(), scalar_to_json(v));
    }
    let skill_flags: ScalarMap = c.skill_flags.iter().map(|f| (f.clone(), J::Bool(true))).collect();
    let skill_types = c.skill_types.iter().map(|t| (t.to_string(), true)).collect();
    let from_item_group = c.group_source.as_deref().is_some_and(|s| s.starts_with("Item:"));
    let ge_from_item = ge.is_some_and(pom_skills::data::from_item);
    let mut supports = Vec::new();
    for &(sge, _, _) in &c.support_list {
        supports.push(pom_triggers::SupportInfo { name: sge.name.clone().unwrap_or_default(), from_item: pom_skills::data::from_item(sge), support: pom_skills::data::is_support(sge) });
    }
    // `activeSkill.triggeredBy` (CalcActiveSkill.lua:530-538): the first applied support that is a trigger with addSkillTypes.
    let mut triggered_by = None;
    for &i in &c.effect_list {
        let Some(&(sge, slevel, _)) = c.support_list.get(i) else { continue };
        if pom_skills::data::is_trigger(sge) && sge.extra.get("addSkillTypes").is_some() {
            if triggered_by.is_none() {
                triggered_by = Some(pom_triggers::TriggeredByInfo {
                    name: sge.name.clone(),
                    id: sge.id.clone(),
                    from_item: pom_skills::data::from_item(sge),
                    support: pom_skills::data::is_support(sge),
                    level_cooldown: sge.id.as_deref().and_then(|id| level_cooldown(id, slevel)),
                });
            }
        }
    }
    let sym = |n: &str| [Sym::new(n)];
    let icdr = pom_offence::tools::calc_lib_mod_s(&store, Some(&cfg), &[pom_engine::sym!("CooldownRecovery")]);
    let core = pom_triggers::CoreCalc {
        icdr: if icdr == 0.0 { 1.0 } else { icdr },
        added_cooldown_base: store.sum(pom_engine::modifier::ModType::Base, Some(&cfg), &sym("CooldownRecovery")),
        cooldown_override: store.override_(Some(&cfg), &sym("CooldownRecovery")).and_then(|v| if let pom_engine::value::Value::Num(n) = v { Some(n) } else { None }),
        flag_adds_cast_time_to_cd: store.flag(Some(&cfg), &sym("SpellCastTimeAddedToCooldownIfTriggered")),
        inc_speed: store.sum(pom_engine::modifier::ModType::Inc, Some(&cfg), &sym("Speed")),
        more_speed: store.more(Some(&cfg), &sym("Speed")),
        flag_has_seals: store.flag(None, &sym("HasSeals")),
        sum_repeat_count_base: store.sum(pom_engine::modifier::ModType::Base, None, &sym("RepeatCount")),
        cwdt_mod: Some(pom_offence::tools::calc_lib_mod_s(&store, None, &[pom_engine::sym!("CWDTThreshold")])),
        focus_icdr: Some(pom_offence::tools::calc_lib_mod_s(&store, Some(&cfg), &[pom_engine::sym!("FocusCooldownRecovery")])),
    };
    // `activeSkill.skillPart`/`skillPartName` (CalcActiveSkill.lua:248-266): multi-part skills only.
    let parts = ge.and_then(pom_skills::data::parts).filter(|p| p.len() > 1);
    let (skill_part, skill_part_name) = match parts {
        Some(p) => {
            let n = (c.gem_skill_part.unwrap_or(1).max(1) as usize).min(p.len());
            (Some(n as f64), p.get(n - 1).and_then(|v| v.get("name")).and_then(|v| v.as_str()).map(|s| s.to_string()))
        }
        None => (None, None),
    };
    Skill {
        uuid: Some(skill_uuid(idx, c)),
        skill_data,
        skill_flags,
        skill_types,
        skill_cfg_flags: c.flags,
        skill_cfg_keyword_flags: c.keyword_flags,
        skill_cond: HashMap::default(),
        slot_name: c.slot_name.clone(),
        ge: pom_triggers::GrantedEffectInfo {
            id: Some(c.granted_effect_id.clone()),
            name: Some(ge_name(c)),
            triggered: ge.and_then(|g| g.extra.get("triggered")).and_then(|v| v.as_bool()).unwrap_or(false),
            from_item: ge_from_item,
            support: false,
            cast_time: ge.and_then(|g| g.cast_time),
            level_cooldown: level_cooldown(&c.granted_effect_id, c.level),
            base_flags: ge.map(|g| pom_skills::data::base_flags(g).into_iter().map(|k| (k, true)).collect()).unwrap_or_default(),
        },
        src_instance: Some(pom_triggers::SrcInstanceInfo { from_item: from_item_group, triggered: c.group_source.as_ref().is_some_and(|s| env.granted_triggered.iter().any(|(src, id)| src == s && *id == c.granted_effect_id)), trigger_chance: c.group_source.as_ref().and_then(|s| env.granted_trigger_chance.iter().find(|(src, id, _)| src == s && *id == c.granted_effect_id).map(|t| t.2)) }),
        ae_level: Some(c.level),
        triggered_by,
        socket_group: Some(pom_triggers::SocketGroupInfo { slot: c.group_slot.clone(), source: c.group_source.clone(), group_id: Some(group_id(c)) }),
        skill_part_name,
        skill_part,
        has_minion: !c.minion_list.is_empty() || c.is_spectre,
        support_list: supports,
        core_calc: core,
        can_support_by_main_trigger: false,
        brand_activation_freq_inc: if ge_name(c) == "Arcanist Brand" {
            (100.0 + store.sum(pom_engine::modifier::ModType::Inc, Some(&cfg), &[pom_engine::sym!("Speed"), pom_engine::sym!("BrandActivationFrequency")])) / 100.0
        } else { 0.0 },
        brand_activation_freq_more: if ge_name(c) == "Arcanist Brand" { store.more(Some(&cfg), &[pom_engine::sym!("BrandActivationFrequency")]) } else { 0.0 },
        gem_tags: pom_skills::data::gem_for_skill(&c.granted_effect_id)
            .and_then(|gid| pom_skills::data::game_data().gems.get(gid))
            .map(|g| g.tags.clone())
            .unwrap_or_default(),
        lua_uuid: if crate::bd_perform::trigger_tables_on() { lua_skill_uuid(c) } else { String::new() },
    }
}

pub(crate) fn build_skills(env: &Env, skills: &[ComputedSkill], main_idx: usize) -> Vec<Skill> {
    let mut out: Vec<Skill> = skills.iter().enumerate().map(|(i, c)| build_one(env, i, c)).collect();
    // `calcLib.canGrantedEffectSupportActiveSkill(main.triggeredBy.gemData.grantedEffect, skill)` for every skill.
    let main_c = &skills[main_idx];
    let mut trig_ge = None;
    for &i in &main_c.effect_list {
        if let Some(&(sge, _, _)) = main_c.support_list.get(i) {
            if pom_skills::data::is_trigger(sge) && sge.extra.get("addSkillTypes").is_some() {
                trig_ge = Some(sge);
                break;
            }
        }
    }
    if let Some(sge) = trig_ge {
        // `triggeredBy.gemData.grantedEffect`: the owning gem's primary effect (e.g. the Cast while Channelling
        // gem's own support, not the "...Triggered" support granted to the triggered skill).
        let sge = sge
            .id
            .as_deref()
            .and_then(pom_skills::data::gem_for_skill)
            .and_then(|gid| pom_skills::data::game_data().gems.get(gid))
            .and_then(pom_skills::data::gem_primary_effect)
            .unwrap_or(sge);
        let exclude = pom_skills::data::skill_type_expr(sge, "excludeSkillTypes");
        let require = pom_skills::data::skill_type_expr(sge, "requireSkillTypes");
        for (t, c) in out.iter_mut().zip(skills.iter()) {
            let ge = pom_skills::data::all_skills().get(&c.granted_effect_id);
            let blocked = pom_skills::data::is_unsupported(sge) || ge.is_some_and(pom_skills::data::cannot_be_supported);
            let excl = !exclude.is_empty() && pom_skills::active_skill::does_type_expression_match(&exclude, &c.skill_types, None);
            let req = require.is_empty() || pom_skills::active_skill::does_type_expression_match(&require, &c.skill_types, None);
            t.can_support_by_main_trigger = !blocked && !excl && req;
        }
    }
    out
}

/// A cache entry from a finished offence pass's output (the fields `dumpGlobalCache` reads).
fn entry_from_output(o: &HashMap<String, f64>, ctc: Option<f64>) -> GcEntry {
    let g = |k: &str| o.get(k).copied();
    GcEntry {
        hit_speed: g("HitSpeed"),
        speed: g("Speed"),
        crit_chance: g("CritChance"),
        hit_chance: g("HitChance"),
        total_dps: g("TotalDPS"),
        mana_cost: g("ManaCost"),
        life_cost: g("LifeCost"),
        mana_cost_raw: g("ManaCostRaw"),
        projectile_count: g("ProjectileCount"),
        battle_cry_exerts_count: g("BattleCryExertsCount"),
        battle_mage_cry_duration: g("BattleMageCryDuration"),
        battle_mage_cry_cast_time: g("BattleMageCryCastTime"),
        battle_mage_cry_cooldown: g("BattleMageCryCooldown"),
        infernal_exerts_count: g("InfernalExertsCount"),
        infernal_cry_duration: g("InfernalCryDuration"),
        infernal_cry_cast_time: g("InfernalCryCastTime"),
        infernal_cry_cooldown: g("InfernalCryCooldown"),
        duration: g("Duration"),
        main_hand_hit_chance: g("MainHand.HitChance"),
        off_hand_hit_chance: g("OffHand.HitChance"),
        main_hand_crit_chance: g("MainHand.CritChance"),
        off_hand_crit_chance: g("OffHand.CritChance"),
        battlemage_up_time_ratio: g("BattlemageUpTimeRatio"),
        infernal_up_time_ratio: g("InfernalUpTimeRatio"),
        totem_life: g("TotemLife"),
        hit_time: g("HitTime"),
        time: g("Time"),
        main_skill_chance_to_trigger_on_crit: ctc,
        ..Default::default()
    }
}

/// `calcs.buildActiveSkill` stand-in: offence pass for `sk` as the main skill on the pre-offence state.
thread_local! {
    /// Set while `build_cache_entry` runs a skill's own trigger step, so that step does not recurse.
    static CACHE_TRIGGER_DEPTH: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
}

pub(crate) fn build_cache_entry(env: &mut Env, xml_text: &str, skills: &[ComputedSkill], si: usize, baseline: &HashMap<String, f64>, parent_level: &std::sync::Arc<Vec<pom_engine::modifier::Mod>>) -> GcEntry {
    let sk = &skills[si];
    // `calcs.buildActiveSkill` runs `calcs.perform` for the skill, trigger step included, so a skill that is itself triggered
    // (Tempest Shield, a socketed spell triggered by a craft) is cached at the rate it triggers at, not its own speed. One
    // level only: the sources that run scans are plain skills.
    let mut own_trigger_rate: Option<f64> = None;
    if CACHE_TRIGGER_DEPTH.with(|d| d.get()) == 0 {
        let ts = build_skills(env, skills, si);
        if ts.get(si).is_some_and(|t| t.skill_data.keys().any(|k| k.to_lowercase().contains("trigger"))) {
            CACHE_TRIGGER_DEPTH.with(|d| d.set(1));
            let keep = env.output.clone();
            let a = run_for(env, xml_text, skills, si);
            env.output = keep;
            CACHE_TRIGGER_DEPTH.with(|d| d.set(0));
            own_trigger_rate = a.and_then(|a| if a.result.triggered == Some(true) { a.result.skill_trigger_rate } else { None });
        }
    }
    let saved = std::mem::replace(&mut env.output, baseline.clone());
    let saved_str = env.output_str.clone();
    let prev_split = crate::buffs::FULLDPS_PARENT.with(|p| p.borrow_mut().replace((&env.player as *const _ as usize, parent_level.clone())));
    NESTED.with(|n| n.set(true));
    if let Some(st) = SNIPE_STAGES.with(|c| c.get()) {
        if ge_name(sk) == "Snipe" { SNIPE_HTM.with(|c| c.set(Some(st - 0.5))); }
    }
    let part = sk.gem_skill_part.unwrap_or(1).max(1);
    // A totem source is its own perform run: it sees the totem aura copies even if the real main skill is no totem.
    let main_is_totem = crate::offence::select_main_skill(xml_text, skills).is_some_and(|m| m.skill_flags.contains("totem"));
    let mut added_totem_mods = false;
    if sk.skill_flags.contains("totem") && !main_is_totem {
        for mut m in crate::actor_misc::totem_cache_mods(&env.player) {
            m.source = Some(std::sync::Arc::from(format!("{}{}", crate::actor_misc::TOTEM_CACHE_SOURCE, m.source.as_deref().unwrap_or(""))));
            env.player.add_mod(m);
            added_totem_mods = true;
        }
    }
    let bd_was = pom_offence::bd::set_active(false);
    crate::offence::compute_offence_for(env, xml_text, sk, skills, part);
    pom_offence::bd::set_active(bd_was);
    if added_totem_mods {
        if let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing {
            pom_engine::modstore::store::retain_mods(v, |m| !m.source.as_deref().is_some_and(|s| s.starts_with(crate::actor_misc::TOTEM_CACHE_SOURCE)));
        }
    }
    NESTED.with(|n| n.set(false));
    SNIPE_HTM.with(|c| c.set(None));
    crate::buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = prev_split);
    if let pom_engine::modstore::store::Backing::List(v) = &mut env.player.backing {
        pom_engine::modstore::store::retain_mods(v, |m| !(m.name.as_str() == "Condition:OneSecondAttackTime" && m.source.is_none()));
    }
    let out = std::mem::replace(&mut env.output, saved);
    env.output_str = saved_str;
    let ctc = crate::offence::skill_data_map(&env.player, sk).get("chanceToTriggerOnCrit").and_then(|v| if let ScalarValue::Num(n) = v { Some(*n) } else { None });
    let mut out = out;
    if let Some(r) = own_trigger_rate {
        out.insert("Speed".to_string(), r);
    }
    let mut e = entry_from_output(&out, ctc);
    e.dps_multiplier = crate::offence::UNLEASH_DPSMULT.with(|c| c.get());
    e
}

/// `calcs.triggers(env, env.player)` for the main skill. Returns `None` when there is no live main skill.
pub(crate) fn run(env: &mut Env, xml_text: &str) -> Option<TrigApply> {
    let skills = std::mem::take(&mut env.active_skills);
    let res = run_inner(env, xml_text, &skills);
    env.active_skills = skills;
    res
}

fn run_inner(env: &mut Env, xml_text: &str, skills: &[ComputedSkill]) -> Option<TrigApply> {
    let main = crate::offence::select_main_skill(xml_text, skills)?;
    let main_idx = skills.iter().position(|s| std::ptr::eq(s, main))?;
    run_for(env, xml_text, skills, main_idx)
}

/// `calcs.triggers` with `skills[main_idx]` as the actor's main skill (also used per FullDPS skill).
pub(crate) fn run_for(env: &mut Env, xml_text: &str, skills: &[ComputedSkill], main_idx: usize) -> Option<TrigApply> {
    let main = skills.get(main_idx)?;
    if main.skill_flags.contains("disable") {
        return None;
    }
    let tskills = build_skills(env, skills, main_idx);
    run_common(env, xml_text, skills, tskills, Some(main_idx), None)
}

/// `calcs.triggers(env, env.minion)`: the actor is the minion's main skill (`minion_skill`, built with the minion's
/// store); the trigger sources are scanned over the PLAYER's active skills (`env.active_skills` must be the player's).
pub(crate) fn run_minion(env: &mut Env, xml_text: &str, minion_skill: Skill) -> Option<TrigApply> {
    if minion_skill.skill_flags.contains_key("disable") {
        return None;
    }
    let skills = std::mem::take(&mut env.active_skills);
    let tskills: Vec<Skill> = skills.iter().enumerate().map(|(i, c)| build_one(env, i, c)).collect();
    let r = run_common(env, xml_text, &skills, tskills, None, Some(minion_skill));
    env.active_skills = skills;
    r
}

/// The trigger-side record of a skill (the minion pass builds it under the minion's store).
pub(crate) fn build_skill_record(env: &Env, c: &ComputedSkill) -> Skill {
    build_one(env, 0, c)
}

fn run_common(env: &mut Env, xml_text: &str, skills: &[ComputedSkill], tskills: Vec<Skill>, main_idx: Option<usize>, minion_skill: Option<Skill>) -> Option<TrigApply> {
    let w1_item = env.weapon_data.get("Weapon 1");
    let counts_as_dual = w1_item.and_then(|w| w.first()).and_then(|v| v.get("countsAsDualWielding")).and_then(|v| v.as_bool()).unwrap_or(false);
    let has_type = |v: Option<&serde_json::Value>| v.and_then(|x| x.get("type")).is_some();
    let weapon2_present = if counts_as_dual {
        has_type(w1_item.and_then(|w| w.get(1)))
    } else if !env.weapon_data.contains_key("Weapon 2") {
        !env.weapon_data.contains_key("Weapon 1") && !env.item_armour.contains_key("Gloves") && env.keystones_added.contains("Hollow Palm Technique")
    } else {
        has_type(env.weapon_data.get("Weapon 2").and_then(|w| w.get(1)))
    };
    let enemy_ignited = env.enemy.flag(None, &[pom_engine::sym!("Condition:Ignited")]);
    let have_trigger_bots = env.player.flag(None, &[pom_engine::sym!("HaveTriggerBots")]);
    let snipe_stages = {
        let a = env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("Multiplier:SnipeStage")]);
        let b = env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("Multiplier:SnipeStagesMax")]);
        a.min(b)
    };
    SNIPE_STAGES.with(|c| c.set(Some(snipe_stages)));
    let mut call = pom_triggers::TrigCall {
        snipe_stages,
        intuitive_link_rate: env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("IntuitiveLinkSourceRate")]),
        actor: if minion_skill.is_some() { "minion".into() } else { "player".into() },
        mode: "MAIN".into(),
        main_skill_idx: main_idx,
        minion_skill_before: minion_skill,
        enemy_ignited,
        doom_blast_source: env.config_str.get("doomBlastSource").cloned(),
        gloves_title_has_vixen: env.slot_items.get("Gloves").and_then(|id| env.items.get(id)).and_then(|i| i.title.as_deref()).map_or(false, |t| t.contains("Vixen's Entrapment")),
        have_trigger_bots,
        phasing: env.player.flag(None, &[pom_engine::sym!("Condition:Phasing")]),
        killed_recently: env.player.flag(None, &[pom_engine::sym!("Condition:KilledRecently")]),
        blood_shrine_toad_chance: env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("BloodShrineExplodingToadTriggerChance")]),
        focus_duration: pom_skills::data::all_skills().get("Focus").and_then(|g| g.extra.get("constantStats")).and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|c| c.as_array()).and_then(|c| c.get(1)).and_then(|v| v.as_f64()).map(|v| v / 1000.0),
        focus_base_cooldown: level_cooldown("Focus", 1.0),
        vixens_base_cooldown: level_cooldown("SupportUniqueCastCurseOnCurse", 1.0),
        curse_overlaps: {
            let n = [pom_engine::sym!("Multiplier:CurseOverlaps")];
            if env.player.tabulate(Some(pom_engine::modifier::ModType::Base), None, &n).is_empty() { None } else { Some(env.player.sum(pom_engine::modifier::ModType::Base, None, &n).max(1.0)) }
        },
        kitava_required_mana_cost: env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("KitavaRequiredManaCost")]),
        kitava_trigger_chance: env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("KitavaTriggerChance")]),
        foulborn_kitava_required_life_cost: env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("FoulbornKitavaRequiredLifeCost")]),
        foulborn_kitava_trigger_chance: env.player.sum(pom_engine::modifier::ModType::Base, None, &[pom_engine::sym!("FoulbornKitavaTriggerChance")]),
        weapon1_present: true,
        weapon2_present,
        main_slot_item_name: main_idx.and_then(|i| skills.get(i)).and_then(|main| main.slot_name.as_ref()).and_then(|sn| env.slot_items.get(sn)).and_then(|id| env.items.get(id)).map(|it| it.name.clone()),
        ok: true,
        ..Default::default()
    };
    let baseline = env.output.clone();
    let parent_level = std::sync::Arc::new(env.parent_level_mods.clone());
    let mut gc: GlobalCache = HashMap::default();
    let mut cache_tried: pom_engine::fxhash::HashSet<String> = pom_engine::fxhash::HashSet::default();
    let uuid_idx: HashMap<String, usize> = tskills.iter().enumerate().filter_map(|(i, s)| s.uuid.clone().map(|u| (u, i))).collect();
    let mut result;
    let mut rounds = 0;
    loop {
        call.global_cache = gc.clone();
        pom_triggers::take_gc_misses();
        let bd_was = pom_triggers::set_breakdown(crate::bd_perform::trigger_tables_on());
        result = pom_triggers::triggers::calcs_triggers(&tskills, &call);
        pom_triggers::set_breakdown(bd_was);
        let misses = pom_triggers::take_gc_misses();
        let mut added = false;
        for u in misses {
            if cache_tried.insert(u.clone()) {
                if let Some(&si) = uuid_idx.get(&u) {
                    let e = build_cache_entry(env, xml_text, skills, si, &baseline, &parent_level);
                    gc.insert(u, e);
                    added = true;
                }
            }
        }
        rounds += 1;
        if !added || rounds > 8 {
            break;
        }
    }
    let source_idx = result.source_uuid.as_ref().and_then(|u| uuid_idx.get(u).copied());
    SNIPE_STAGES.with(|c| c.set(None));
    let snipe_triggered_n = main_idx.map_or(0, |mi| {
        let mslot = tskills[mi].socket_group.as_ref().and_then(|g| g.slot.clone());
        tskills.iter().filter(|t| t.skill_data.get("triggeredBySnipe").map_or(false, |v| v.as_bool().unwrap_or(false) || v.as_f64().map_or(false, |x| x != 0.0)) && t.socket_group.as_ref().map_or(false, |g| g.slot == mslot)).count()
    });
    let source_totem_life = result.source_uuid.as_ref().filter(|_| main_idx.is_some()).map(|u| gc.get(u).and_then(|e| e.totem_life).unwrap_or(0.0));
    Some(TrigApply { main_idx: main_idx.unwrap_or(0), source_idx: if main_idx.is_some() { source_idx } else { None }, result, snipe_stages, snipe_triggered_n, source_totem_life })
}

/// Apply the outputs `calcs.triggers` writes straight to `player.output`.
pub(crate) fn apply_outputs(env: &mut Env, a: &TrigApply) {
    let r = &a.result;
    let mut put = |k: &str, v: Option<f64>| {
        if let Some(v) = v {
            env.output.insert(k.to_string(), v);
        }
    };
    put("TriggerRateCap", r.trigger_rate_cap);
    put("SkillTriggerRate", r.skill_trigger_rate);
    put("EffectiveSourceRate", r.effective_source_rate);
    put("ChannelTimeToTrigger", r.channel_time_to_trigger);
    put("CWDTThreshold", r.cwdt_threshold);
    put("addsCastTime", r.adds_cast_time);
    put("VixenModeNoVixenGlovesWarn", r.vixen_mode_no_vixen_gloves_warn.map(|b| if b { 1.0 } else { 0.0 }));
    put("VixensTooMuchCastSpeedWarn", r.vixens_too_much_cast_speed_warn.map(|b| if b { 1.0 } else { 0.0 }));
}

/// Apply the `skillData` writes `calcs.triggers` made to the main skill.
pub(crate) fn apply_skill_data(a: &TrigApply, skill_data: &mut HashMap<String, ScalarValue>) {
    let r = &a.result;
    match r.triggered {
        Some(true) => {
            skill_data.insert("triggered".into(), ScalarValue::Bool(true));
        }
        Some(false) => {
            skill_data.remove("triggered");
        }
        None => {}
    }
    if r.no_trigger_found {
        skill_data.remove("triggered");
    }
    if let Some(v) = r.skill_data_cooldown {
        skill_data.insert("cooldown".into(), ScalarValue::Num(v));
    }
    if let Some(v) = r.skill_trigger_rate {
        skill_data.insert("triggerRate".into(), ScalarValue::Num(v));
    }
    if let Some(v) = a.source_totem_life {
        // stands in for skillData.triggerSourceUUID (CalcTriggers.lua:387/887); only the Avenging Flame hook reads it
        skill_data.insert("triggerSourceTotemLife".into(), ScalarValue::Num(v));
    }
}
