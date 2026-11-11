//! Batch 03: ConfigOptions.lua lines ~651-917 (changedStance .. overrideEnduranceCharges).
use crate::ctx::ConfigCtx;
use crate::helpers::{b, map, n, new_mod, s, tag};
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::sym::Sym;
use pom_engine::value::Value;

/// A handful of `ExtraCurse` mods pass only 3 args to `NewMod` (name, type, value) with no
/// source string at all, unlike every other mod in this batch. Matches
/// `modLib.createMod`'s `source = nil` when the 4th vararg isn't a string.
fn new_mod_no_source(name: &str, ty: ModType, value: Value, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value, flags: 0, keyword_flags: 0, source: None, tags: (tags).into() }
}

fn changed_stance(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:ChangedStanceRecently", ModType::Flag, b(true), "Config", vec![]));
}

fn shards_consumed(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SteelShardConsumed", ModType::Base, n(val.as_f64().min(12.0)), "Config", vec![]));
}

fn steel_wards(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SteelWardCount", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn storm_rain_beam_overlap(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("beamOverlapMultiplier")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Storm Rain"))])],
    ));
}

fn storm_rain_active_arrows(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("activeArrowMultiplier")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Storm Rain of the Conduit"))])],
    ));
}

fn summon_elemental_relic_enable_anger_aura(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![
            tag("SkillId", &[("skillId", s("Anger"))]),
            tag("SkillName", &[("skillName", s("Summon Elemental Relic")), ("summonSkill", b(true))]),
        ],
    ));
}

fn summon_elemental_relic_enable_hatred_aura(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![
            tag("SkillId", &[("skillId", s("Hatred"))]),
            tag("SkillName", &[("skillName", s("Summon Elemental Relic")), ("summonSkill", b(true))]),
        ],
    ));
}

fn summon_elemental_relic_enable_wrath_aura(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![
            tag("SkillId", &[("skillId", s("Wrath"))]),
            tag("SkillName", &[("skillName", s("Summon Elemental Relic")), ("summonSkill", b(true))]),
        ],
    ));
}

fn summon_holy_relic_enable_holy_relic_boon(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:HolyRelicBoonActive", ModType::Flag, b(true), "Config", vec![]));
}

fn summon_lightning_golem_enable_wrath(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![tag("SkillId", &[("skillId", s("LightningGolemWrath"))])],
    ));
}

fn summon_reaper_consume_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![tag("SkillId", &[("skillId", s("ReaperConsumeMinionForBuff"))])],
    ));
}

fn weeping_black_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:WeepingBlackStacks", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn nearby_bleeding_enemies(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:NearbyBleedingEnemies", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn tornado_shot_secondary_hit_chance(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("tornadoShotSecondaryHitChance")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Tornado Shot"))])],
    ));
}

fn toxic_rain_pod_overlap(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("podOverlapMultiplier")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Toxic Rain")), ("includeTransfigured", b(true))])],
    ));
}

fn trauma_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:TraumaStacks",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn config_resonance_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:ResonanceCount", ModType::Base, n(val.as_f64().min(50.0).max(0.0)), "Config", vec![]));
}

fn config_unholy_resonance_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:UnholyResonanceCount", ModType::Base, n(val.as_f64().min(50.0).max(0.0)), "Config", vec![]));
}

fn condition_insane(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Insane", ModType::Flag, b(true), "Config", vec![]));
}

fn vigilant_strike_bypass_cd(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "CooldownRecovery",
        ModType::Override,
        n(0.0),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Vigilant Strike"))])],
    ));
}

fn voltaxic_burst_spells_queued(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:VoltaxicWaitingStages", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn vortex_cast_on_frostbolt(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:CastOnFrostbolt",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Vortex of Projection"))])],
    ));
}

fn multiplier_warcry_power(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("WarcryPower", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn wave_of_conviction_exposure_type(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let name = match val.as_str().as_ref() {
        "Fire" => "Condition:WaveOfConvictionFireExposureActive",
        "Cold" => "Condition:WaveOfConvictionColdExposureActive",
        "Lightning" => "Condition:WaveOfConvictionLightningExposureActive",
        _ => return,
    };
    ctx.mods.push(new_mod(name, ModType::Flag, b(true), "Config", vec![]));
}

fn multiplier_wo_c_expired_duration(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:WoCDurationExpired",
        ModType::Base,
        n(val.as_f64().min(100.0)),
        "Config",
        vec![tag("Condition", &[("var", s("Effective"))])],
    ));
}

fn absolution_skill_damage_counted_once(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:AbsolutionSkillDamageCountedOnce",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn dominating_blow_skill_damage_counted_once(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:DominatingBlowSkillDamageCountedOnce",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn holy_strike_skill_damage_counted_once(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:HolyStrikeSkillDamageCountedOnce",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn molten_shell_damage_mitigated(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("MoltenShellDamageMitigated")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Molten Shell"))])],
    ));
}

fn vaal_molten_shell_damage_mitigated(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("VaalMoltenShellDamageMitigated")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Molten Shell"))])],
    ));
}

fn enemy_radius(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("EnemyRadius", ModType::Override, n(val.as_f64().max(1.0)), "Config", vec![]));
}

fn total_minion_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TotalMinionLife", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn total_spectre_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TotalSpectreLife", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn total_totem_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TotalTotemLife", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn total_radiance_sentinel_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TotalRadianceSentinelLife", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn total_void_spawn_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TotalVoidSpawnLife", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn total_stone_golem_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TotalStoneGolemLife", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn total_vaal_rejuvenation_totem_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TotalVaalRejuvenationTotemLife", ModType::Override, n(val.as_f64()), "Config", vec![]));
}

fn multiplier_sextant(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:Sextant", ModType::Base, n(val.as_f64().min(5.0)), "Config", vec![]));
}

fn pvp_scaling(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("HasPvpScaling", ModType::Flag, b(true), "Config", vec![]));
}

/// Shared body for the 13 `playerCursedWith*` options: `NewMod("ExtraCurse", "LIST", { skillId =
/// <id>, level = val, applyToPlayer = true })`. Note there is no `source` arg at all in the Lua.
fn player_cursed_with(skill_id: &str, val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod_no_source(
        "ExtraCurse",
        ModType::List,
        map(&[("skillId", s(skill_id)), ("level", n(val.as_f64())), ("applyToPlayer", b(true))]),
        vec![],
    ));
}

fn player_cursed_with_assassins_mark(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("AssassinsMark", val, ctx);
}
fn player_cursed_with_conductivity(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("Conductivity", val, ctx);
}
fn player_cursed_with_despair(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("Despair", val, ctx);
}
fn player_cursed_with_elemental_weakness(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("ElementalWeakness", val, ctx);
}
fn player_cursed_with_enfeeble(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("Enfeeble", val, ctx);
}
fn player_cursed_with_flammability(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("Flammability", val, ctx);
}
fn player_cursed_with_frostbite(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("Frostbite", val, ctx);
}
fn player_cursed_with_poachers_mark(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("PoachersMark", val, ctx);
}
fn player_cursed_with_projectile_weakness(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("ProjectileWeakness", val, ctx);
}
fn player_cursed_with_punishment(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("Punishment", val, ctx);
}
fn player_cursed_with_temporal_chains(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("TemporalChains", val, ctx);
}
fn player_cursed_with_vulnerability(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("Vulnerability", val, ctx);
}
fn player_cursed_with_warlords_mark(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    player_cursed_with("WarlordsMark", val, ctx);
}

fn use_power_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "UsePowerCharges",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn override_power_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "PowerCharges",
        ModType::Override,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn use_frenzy_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "UseFrenzyCharges",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn override_frenzy_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "FrenzyCharges",
        ModType::Override,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn use_endurance_charges(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "UseEnduranceCharges",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn override_endurance_charges(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "EnduranceCharges",
        ModType::Override,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

pub fn register(map: &mut HandlerMap) {
    map.insert("changedStance", changed_stance);
    map.insert("shardsConsumed", shards_consumed);
    map.insert("steelWards", steel_wards);
    map.insert("stormRainBeamOverlap", storm_rain_beam_overlap);
    map.insert("stormRainActiveArrows", storm_rain_active_arrows);
    map.insert("summonElementalRelicEnableAngerAura", summon_elemental_relic_enable_anger_aura);
    map.insert("summonElementalRelicEnableHatredAura", summon_elemental_relic_enable_hatred_aura);
    map.insert("summonElementalRelicEnableWrathAura", summon_elemental_relic_enable_wrath_aura);
    map.insert("summonHolyRelicEnableHolyRelicBoon", summon_holy_relic_enable_holy_relic_boon);
    map.insert("summonLightningGolemEnableWrath", summon_lightning_golem_enable_wrath);
    map.insert("summonReaperConsumeRecently", summon_reaper_consume_recently);
    map.insert("weepingBlackStacks", weeping_black_stacks);
    map.insert("nearbyBleedingEnemies", nearby_bleeding_enemies);
    map.insert("tornadoShotSecondaryHitChance", tornado_shot_secondary_hit_chance);
    map.insert("toxicRainPodOverlap", toxic_rain_pod_overlap);
    map.insert("traumaStacks", trauma_stacks);
    map.insert("configResonanceCount", config_resonance_count);
    map.insert("configUnholyResonanceCount", config_unholy_resonance_count);
    map.insert("conditionInsane", condition_insane);
    map.insert("VigilantStrikeBypassCD", vigilant_strike_bypass_cd);
    map.insert("voltaxicBurstSpellsQueued", voltaxic_burst_spells_queued);
    map.insert("vortexCastOnFrostbolt", vortex_cast_on_frostbolt);
    map.insert("multiplierWarcryPower", multiplier_warcry_power);
    map.insert("waveOfConvictionExposureType", wave_of_conviction_exposure_type);
    map.insert("multiplierWoCExpiredDuration", multiplier_wo_c_expired_duration);
    map.insert("absolutionSkillDamageCountedOnce", absolution_skill_damage_counted_once);
    map.insert("dominatingBlowSkillDamageCountedOnce", dominating_blow_skill_damage_counted_once);
    map.insert("holyStrikeSkillDamageCountedOnce", holy_strike_skill_damage_counted_once);
    map.insert("MoltenShellDamageMitigated", molten_shell_damage_mitigated);
    map.insert("VaalMoltenShellDamageMitigated", vaal_molten_shell_damage_mitigated);
    map.insert("enemyRadius", enemy_radius);
    map.insert("TotalMinionLife", total_minion_life);
    map.insert("TotalSpectreLife", total_spectre_life);
    map.insert("TotalTotemLife", total_totem_life);
    map.insert("TotalRadianceSentinelLife", total_radiance_sentinel_life);
    map.insert("TotalVoidSpawnLife", total_void_spawn_life);
    map.insert("TotalStoneGolemLife", total_stone_golem_life);
    map.insert("TotalVaalRejuvenationTotemLife", total_vaal_rejuvenation_totem_life);
    map.insert("multiplierSextant", multiplier_sextant);
    map.insert("PvpScaling", pvp_scaling);
    map.insert("playerCursedWithAssassinsMark", player_cursed_with_assassins_mark);
    map.insert("playerCursedWithConductivity", player_cursed_with_conductivity);
    map.insert("playerCursedWithDespair", player_cursed_with_despair);
    map.insert("playerCursedWithElementalWeakness", player_cursed_with_elemental_weakness);
    map.insert("playerCursedWithEnfeeble", player_cursed_with_enfeeble);
    map.insert("playerCursedWithFlammability", player_cursed_with_flammability);
    map.insert("playerCursedWithFrostbite", player_cursed_with_frostbite);
    map.insert("playerCursedWithPoachersMark", player_cursed_with_poachers_mark);
    map.insert("playerCursedWithProjectileWeakness", player_cursed_with_projectile_weakness);
    map.insert("playerCursedWithPunishment", player_cursed_with_punishment);
    map.insert("playerCursedWithTemporalChains", player_cursed_with_temporal_chains);
    map.insert("playerCursedWithVulnerability", player_cursed_with_vulnerability);
    map.insert("playerCursedWithWarlordsMark", player_cursed_with_warlords_mark);
    map.insert("usePowerCharges", use_power_charges);
    map.insert("overridePowerCharges", override_power_charges);
    map.insert("useFrenzyCharges", use_frenzy_charges);
    map.insert("overrideFrenzyCharges", override_frenzy_charges);
    map.insert("useEnduranceCharges", use_endurance_charges);
    map.insert("overrideEnduranceCharges", override_endurance_charges);
}
