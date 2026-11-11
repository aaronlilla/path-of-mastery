//! Top-level port of `calcs.triggers` (CalcTriggers.lua lines 1602-1627): resolves the
//! configTable entry for the actor's main skill and runs `defaultTriggerHandler` against it.

use crate::config::{self, TrigFacts};
use crate::*;

pub fn calcs_triggers(skills: &[Skill], call: &TrigCall) -> TriggerResult {
    let main: &Skill = match call.main_skill_idx {
        Some(i) => &skills[i],
        None => call
            .minion_skill_before
            .as_ref()
            .expect("a minion-actor trig record must carry minionSkillBefore"),
    };
    let mut result = TriggerResult::default();
    // `calcs.triggers`'s own top-level guard (CalcTriggers.lua:1602): `not actor.mainSkill.
    // skillFlags.disable and not (env.limitedSkills and env.limitedSkills[uuid])`. When the main
    // skill's own uuid is in env.limitedSkills (recursion guard, e.g. a mirage-copied skill
    // recalculating itself), calcs.triggers does nothing at all - skillData.triggered is left at
    // its prior (falsy) value.
    let limited = main.uuid.as_deref().map(|u| call.limited_skills_before.iter().any(|s| s == u)).unwrap_or(false);
    if main.disabled() || limited {
        result.no_trigger_found = true;
        return result;
    }

    let skill_id_lower = main.ge.id.as_ref().map(|s| s.to_lowercase());
    let skill_name_lower = main.ge.name.as_ref().map(|_| main.name_lower());
    let trigger_name_lower = main
        .triggered_by
        .as_ref()
        .and_then(|tb| tb.name.as_deref())
        .map(|n| n.to_lowercase());
    let awakened_lower = trigger_name_lower
        .as_deref()
        .map(|n| n.strip_prefix("awakened ").unwrap_or(n).to_string());
    let unique_name_lower = if is_triggered(main) {
        config::get_unique_item_trigger_name(main).map(|n| n.to_lowercase())
    } else {
        None
    };

    let facts = TrigFacts {
        gc: &call.global_cache,
        enemy_ignited: call.enemy_ignited,
        doom_blast_source: call.doom_blast_source.clone(),
        gloves_title_has_vixen: call.gloves_title_has_vixen,
        main_slot_item_name: call.main_slot_item_name.clone(),
        curse_overlaps: call.curse_overlaps,
        vixens_base_cooldown: call.vixens_base_cooldown,
        kitava_required_mana_cost: call.kitava_required_mana_cost,
        kitava_trigger_chance: call.kitava_trigger_chance,
        foulborn_kitava_required_life_cost: call.foulborn_kitava_required_life_cost,
        foulborn_kitava_trigger_chance: call.foulborn_kitava_trigger_chance,
        snipe_stages: call.snipe_stages,
        intuitive_link_rate: call.intuitive_link_rate,
        phasing: call.phasing,
        killed_recently: call.killed_recently,
        blood_shrine_toad_chance: call.blood_shrine_toad_chance,
    };

    // The key order of calcs.triggers (CalcTriggers.lua:1612-1616): the first key whose configTable entry returns a config wins.
    // Each entry runs in turn and keeps the side effects it wrote on the main skill even when it returns nothing.
    let cand: Vec<&str> = [skill_id_lower.as_deref(), skill_name_lower.as_deref(), trigger_name_lower.as_deref(), awakened_lower.as_deref(), unique_name_lower.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    let mut fx = config::SetupEffects::default();
    let mut resolved = None;
    let mut resolved_key = "";
    for k in &cand {
        if let Some(r) = config::resolve_config(k, main, skills, &facts, &mut fx) {
            resolved = Some(r);
            resolved_key = k;
            break;
        }
    }
    if pom_engine::env::var("POM_TRIG_KEYS").is_ok() {
        let existing: Vec<&str> = cand.iter().copied().filter(|k| config::is_config_key(k)).collect();
        if !existing.is_empty() {
            eprintln!("TRIGKEY\t{}\t{}\t{}\t{}", resolved_key, existing.join("|"), main.name(), if call.actor == "minion" { "minion" } else { "player" });
        }
    }
    if fx.disable {
        result.disable_reason = fx.disable_reason.clone();
    }
    result.uses_curse_overlaps = fx.uses_curse_overlaps;

    match resolved {
        None => {
            result.no_trigger_found = true;
            // a step that wrote `globalTrigger` or a table before returning nothing still leaves it behind
            if fx.global_trigger { result.global_trigger = Some(true); }
            result.tables.extend(fx.preset_tables.iter().cloned());
            // The configTable steps write the player's main skill; a minion actor's call leaves it alone here.
            if call.actor != "minion" {
                result.info_message = fx.info_message.clone();
                result.info_message2 = fx.info_message2.clone();
                if fx.info_trigger_empty { result.info_trigger = Some(String::new()); }
            }
            result
        }
        Some(mut cfg) => {
            // calcs.triggers itself, not any configTable entry (CalcTriggers.lua:1616): config.
            // triggerChance = config.triggerChance or (main's srcInstance's own triggerChance) -
            // the flat "X% chance to Trigger ..." stat some unique items carry directly on the
            // granted skill instance (e.g. Ashcaller's 10%), independent of any per-key setup.
            if cfg.trigger_chance.is_none() {
                cfg.trigger_chance = main.src_instance.as_ref().and_then(|si| si.trigger_chance);
            }
            if cfg.custom_handler == Some(CustomHandler::Cwc) {
                return cwc_handler(skills, main, call.have_trigger_bots);
            }
            if cfg.custom_handler == Some(CustomHandler::Focus) {
                let mut r = focus_handler(main, call.focus_duration.unwrap_or(4.0), call.focus_base_cooldown.unwrap_or(8.0));
                r.disable_reason = result.disable_reason.clone();
                return r;
            }
            // `config.triggerName = config.triggerName or triggerName or skillName or uniqueName` (CalcTriggers.lua:1612):
            // the name the trigger tables use for the trigger.
            if cfg.trigger_name.is_none() {
                cfg.trigger_name = main
                    .triggered_by
                    .as_ref()
                    .and_then(|tb| tb.name.clone())
                    .or_else(|| main.ge.name.clone())
                    .or_else(|| if is_triggered(main) { config::get_unique_item_trigger_name(main) } else { None });
            }
            cfg.source_rate_is_final = fx.source_rate_is_final;
            // the configTable step's own writes to `mainSkill.skillData`, read by the handler below
            let main_cd_owned;
            let main = if fx.skill_data_cooldown.is_some() || fx.trigger_rate_cap_override.is_some() {
                let mut m2 = main.clone();
                if let Some(cd) = fx.skill_data_cooldown { m2.skill_data.insert("cooldown".to_string(), serde_json::json!(cd)); }
                if let Some(o) = fx.trigger_rate_cap_override { m2.skill_data.insert("triggerRateCapOverride".to_string(), serde_json::json!(o)); }
                main_cd_owned = m2;
                &main_cd_owned
            } else {
                main
            };
            let mut out = default_trigger_handler(
                skills,
                main,
                &call.global_cache,
                &cfg,
                fx.global_trigger,
                call.weapon1_present,
                call.weapon2_present,
                call.have_trigger_bots,
                match cfg.comparer {
                    Some(ComparerKind::Kitava) => call.kitava_required_mana_cost,
                    Some(ComparerKind::FoulbornKitava) => call.foulborn_kitava_required_life_cost,
                    _ => 0.0,
                },
                fx.ignores_tick_rate,
                fx.skip_effective_rate,
                &fx.preset_tables,
            );
            out.disable_reason = result.disable_reason.clone();
            out.uses_curse_overlaps = fx.uses_curse_overlaps;
            out.skill_data_cooldown = fx.skill_data_cooldown;
            if fx.channel_time.is_some() { out.channel_time_to_trigger = fx.channel_time; }
            out.snipe_mods = fx.snipe_mods;
            if out.triggered == Some(true) {
                // `config.triggerName = config.triggerName or triggerName or skillName or uniqueName` (CalcTriggers.lua:1612)
                out.info_trigger = cfg
                    .trigger_name
                    .clone()
                    .or_else(|| main.triggered_by.as_ref().and_then(|tb| tb.name.clone()))
                    .or_else(|| main.ge.name.clone())
                    .or_else(|| if is_triggered(main) { config::get_unique_item_trigger_name(main) } else { None });
            }
            if fx.cwdt {
                let base = num_or(&main.skill_data, "triggeredByDamageTaken", 0.0);
                let threshold_mod = main.core_calc.cwdt_mod.unwrap_or(1.0);
                out.cwdt_threshold = Some(base * threshold_mod);
                // `breakdown.CWDTThreshold` (CalcTriggers.lua:1184-1190)
                if breakdown_on() && base * threshold_mod != base {
                    out.tables.push((
                        "CWDTThreshold".into(),
                        J::Array(vec![
                            J::String(pom_offence::sf!("%.2f ^8(base threshold)", base)),
                            J::String(pom_offence::sf!("x %.2f ^8(threshold modifier)", threshold_mod)),
                            J::String(pom_offence::sf!("= %.2f", base * threshold_mod)),
                        ]),
                    ));
                }
            }
            out
        }
    }
}
