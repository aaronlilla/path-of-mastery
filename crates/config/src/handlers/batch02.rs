use crate::ctx::ConfigCtx;
use crate::helpers::{b, fmt_num, map, mod_value, n, new_mod, s, tag};
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::sym::Sym;

/// A `Mod` with no source, matching a `modList:NewMod(name, type, value)` call that omits the
/// `source` argument (stays Lua `nil`).
fn mod_no_source(name: &str, ty: ModType, value: pom_engine::value::Value, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value, flags: 0, keyword_flags: 0, source: None, tags: (tags).into() }
}

// SkillType.Buff / .Hex / .Mark (Data/Global.lua).
const SKILL_TYPE_BUFF: f64 = 5.0;
const SKILL_TYPE_HEX: f64 = 97.0;
const SKILL_TYPE_MARK: f64 = 98.0;

fn divine_sentinel_phys_as_fire(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelPhysAsFire", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelPhysAsFire", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), vec![]));
}
fn divine_sentinel_phys_as_lightning(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelPhysAsLightning", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelPhysAsLightning", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), vec![]));
}
fn divine_sentinel_regen_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelRegenLife", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelRegenLife", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), vec![]));
}
fn divine_sentinel_regen_mana(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelRegenMana", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelRegenMana", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), vec![]));
}
fn divine_sentinel_chaos_resistance(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelChaosResistance", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelChaosResistance", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), vec![]));
}
fn divine_sentinel_self_curse_effect(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelSelfCurseEffect", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelSelfCurseEffect", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", mod_value(&inner))]), vec![]));
}

fn curse_overlaps(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:CurseOverlaps",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Effective"))])],
    ));
}

fn elemental_army_exposure_type(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    match val.as_str().as_ref() {
        "Fire" => ctx.mods.push(new_mod("FireExposureChance", ModType::Base, n(100.0), "Config", vec![])),
        "Cold" => ctx.mods.push(new_mod("ColdExposureChance", ModType::Base, n(100.0), "Config", vec![])),
        "Lightning" => ctx.mods.push(new_mod("LightningExposureChance", ModType::Base, n(100.0), "Config", vec![])),
        _ => {}
    }
}

fn embrace_madness_active(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:AffectedByGloriousMadness", ModType::Flag, b(true), "Config", vec![]));
}

fn touched_debuffs_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64().min(10.0);
    let debuff_tags = |extra: Tag| vec![tag("GlobalEffect", &[("effectType", s("Debuff"))]), extra];
    let cond = || tag("Condition", &[("var", s("AffectedByGloriousMadness"))]);
    ctx.mods.push(new_mod("DamageTaken", ModType::Inc, n(v * 6.0), &format!("{} Eroding Touch Stacks", fmt_num(v)), debuff_tags(cond())));
    ctx.mods.push(new_mod("ActionSpeed", ModType::Inc, n(-v * 6.0), &format!("{} Paralysing Touch Stacks", fmt_num(v)), debuff_tags(cond())));
    ctx.mods.push(new_mod("FlaskChargesGained", ModType::Inc, n(-v * 9.0), &format!("{} Diluting Touch Stacks", fmt_num(v)), debuff_tags(cond())));
    ctx.mods.push(new_mod("FlaskEffect", ModType::Inc, n(-v * 9.0), &format!("{} Diluting Touch Stacks", fmt_num(v)), debuff_tags(cond())));
    ctx.mods.push(new_mod("LifeRecoveryRate", ModType::Inc, n(-v * 9.0), &format!("{} Wasting Touch Stacks", fmt_num(v)), debuff_tags(cond())));
    ctx.mods.push(new_mod("EnergyShieldRecoveryRate", ModType::Inc, n(-v * 9.0), &format!("{} Wasting Touch Stacks", fmt_num(v)), debuff_tags(cond())));
}

fn feeding_frenzy_feeding_frenzy_active(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:FeedingFrenzyActive", ModType::Flag, b(true), "Config", vec![]));
    let m1 = new_mod("Damage", ModType::More, n(10.0), "Feeding Frenzy", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&m1))]), "Config", vec![]));
    let m2 = new_mod("MovementSpeed", ModType::Inc, n(10.0), "Feeding Frenzy", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&m2))]), "Config", vec![]));
    let m3 = new_mod("Speed", ModType::Inc, n(10.0), "Feeding Frenzy", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", mod_value(&m3))]), "Config", vec![]));
}

fn flame_wall_added_damage(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:FlameWallAddedDamage", ModType::Flag, b(true), "Config", vec![]));
}

fn flicker_strike_bypass_cd(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "CooldownRecovery",
        ModType::Override,
        n(0.0),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Flicker Strike")), ("includeTransfigured", b(true))])],
    ));
}

fn fresh_meat_buffs(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:FreshMeatActive", ModType::Flag, b(true), "Config", vec![]));
}

fn frost_shield_stages(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:FrostShieldStage", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn disgorged(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Disgorged", ModType::Flag, b(true), "Config", vec![]));
}

fn greater_harbinger_of_time_slipstream(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:GreaterHarbingerOfTime", ModType::Flag, b(true), "Config", vec![]));
}

fn harbinger_of_time_slipstream(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:HarbingerOfTime", ModType::Flag, b(true), "Config", vec![]));
}

fn multiplier_hex_doom(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:HexDoomStack", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn herald_of_agony_virulence_stack(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:VirulenceStack", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn hoa_overkill(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("hoaOverkill")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Herald of Ash"))])],
    ));
}

fn herald_of_the_hive_pressure(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:OtherworldlyPressure", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn invention_mine_trap_placed_duration(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:PlacedDuration", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn ice_nova_cast_on_frostbolt(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:CastOnFrostbolt",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Ice Nova of Frostbolts"))])],
    ));
}

fn infused_channelling_infusion(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:InfusionActive", ModType::Flag, b(true), "Config", vec![]));
}

fn innervate_innervation(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:InnervationActive", ModType::Flag, b(true), "Config", vec![]));
}

fn intensify_intensity(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:Intensity", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn overloaded_intensity(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:OverloadedIntensity", ModType::Base, n(val.as_f64().min(3.0)), "Config", vec![]));
}

fn multiplier_linked_targets(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:LinkedTargets", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn linked_to_minion(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LinkedToMinion", ModType::Flag, b(true), "Config", vec![]));
}

fn linked_source_rate(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("IntuitiveLinkSourceRate", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn manabond_missing_unreserved_mana_percentage(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let clamped = val.as_f64().min(100.0).max(0.0);
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("ManabondMissingUnreservedManaPercentage")), ("value", n(clamped))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Manabond"))])],
    ));
}

fn minion_pact_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:MinionLife", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn condition_enemy_malignant_madness(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:MalignantMadness", ModType::Flag, b(true), "Config", vec![]));
}

fn meat_shield_enemy_near_you(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:MeatShieldEnemyNearYou", ModType::Flag, b(true), "Config", vec![]));
}

fn enemy_hit_misty_reflection(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:MistyReflection", ModType::Flag, b(true), "Config", vec![]));
}

fn momentum_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:MomentumStacks",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn momentum_swiftness_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:MomentumStacksRemoved", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn plague_bearer_state(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    match val.as_str().as_ref() {
        "INC" => ctx.mods.push(new_mod("Condition:PlagueBearerIncubating", ModType::Flag, b(true), "Config", vec![])),
        "INF" => ctx.mods.push(new_mod("Condition:PlagueBearerInfecting", ModType::Flag, b(true), "Config", vec![])),
        _ => {}
    }
}

fn perforate_spike_overlap(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:PerforateSpikeOverlap",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Perforate")), ("includeTransfigured", b(true))])],
    ));
}

fn physical_aegis_depleted(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:PhysicalAegisDepleted", ModType::Flag, b(true), "Config", vec![]));
}

fn deathmark_deathmark_active(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:EnemyHasDeathmark", ModType::Flag, b(true), "Config", vec![]));
}

fn pride_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    if val.as_str().as_ref() == "MAX" {
        ctx.mods.push(new_mod("Condition:PrideMaxEffect", ModType::Flag, b(true), "Config", vec![]));
    }
}

fn sacrificed_rage_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:RageSacrificedStacks", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn raise_spectre_enable_buffs(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![
            tag("SkillType", &[("skillType", n(SKILL_TYPE_BUFF))]),
            tag("SkillName", &[("skillName", s("Raise Spectre")), ("includeTransfigured", b(true)), ("summonSkill", b(true))]),
        ],
    ));
}

fn raise_spectre_enable_curses(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let skill_name_tag = || tag("SkillName", &[("skillName", s("Raise Spectre")), ("includeTransfigured", b(true)), ("summonSkill", b(true))]);
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![tag("SkillType", &[("skillType", n(SKILL_TYPE_HEX))]), skill_name_tag()],
    ));
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![tag("SkillType", &[("skillType", n(SKILL_TYPE_MARK))]), skill_name_tag()],
    ));
}

fn condition_summoned_spectre_in_past8_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:SummonedSpectreInPast8Sec",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn raise_spectre_blade_vortex_blade_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("dpsMultiplier")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillId", &[("skillId", s("DemonModularBladeVortexSpectre"))])],
    ));
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("dpsMultiplier")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillId", &[("skillId", s("GhostPirateBladeVortexSpectre"))])],
    ));
}

fn raise_spectre_kaom_fire_beam_totem_stage(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:KaomFireBeamTotemStage", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn raise_spectre_enable_summoned_ursa_rallying_cry(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(true))]),
        "Config",
        vec![tag("SkillId", &[("skillId", s("DropBearSummonedRallyingCry"))])],
    ));
}

fn raise_spectre_enable_slashing_horror_enrage(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(false))]),
        "Config",
        vec![tag("SkillId", &[("skillId", s("AzmeriDualStrikeDemonFireEnrage"))])],
    ));
}

fn raise_spectre_enable_sanguimancer_demon_low_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("enable")), ("value", b(false))]),
        "Config",
        vec![tag("SkillId", &[("skillId", s("ABTTAzmeriShepherdSpellDamage"))])],
    ));
}

fn raise_spiders_spider_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:RaisedSpiderConfig", ModType::Base, n(val.as_f64()), "Config", vec![]));
    ctx.mods.push(new_mod(
        "Multiplier:RaisedSpider",
        ModType::Base,
        n(1.0),
        "Config",
        vec![tag("Multiplier", &[("var", s("RaisedSpiderConfig")), ("limitStat", s("ActiveSpiderLimit"))])],
    ));
}

fn condition_summoned_zombie_in_past8_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:SummonedZombieInPast8Sec",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

fn animate_weapon_lingering_blade(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:AnimatingLingeringBlades", ModType::Flag, b(true), "Config", vec![]));
}

fn shrapnel_ballista_projectile_overlap(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("ShrapnelBallistaProjectileOverlap")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Shrapnel Ballista")), ("includeTransfigured", b(true))])],
    ));
}

fn sigil_of_power_stages(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SigilOfPowerStage", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn siphoning_trap_affected_enemies(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:EnemyAffectedBySiphoningTrap", ModType::Base, n(val.as_f64()), "Config", vec![]));
    ctx.mods.push(new_mod("Condition:SiphoningTrapSiphoning", ModType::Flag, b(true), "Config", vec![]));
}

fn config_snipe_stages(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SnipeStage", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

fn config_spectral_tiger_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SpectralTigerConfig", ModType::Base, n(val.as_f64()), "Config", vec![]));
    ctx.mods.push(new_mod(
        "Multiplier:SpectralTigerCount",
        ModType::Base,
        n(1.0),
        "Config",
        vec![tag("Multiplier", &[("var", s("SpectralTigerConfig")), ("limitStat", s("ActiveTigerLimit"))])],
    ));
}

fn config_spectral_wolf_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SpectralWolfConfig", ModType::Base, n(val.as_f64()), "Config", vec![]));
    ctx.mods.push(new_mod(
        "Multiplier:SpectralWolfCount",
        ModType::Base,
        n(1.0),
        "Config",
        vec![tag("Multiplier", &[("var", s("SpectralWolfConfig")), ("limitStat", s("ActiveWolfLimit"))])],
    ));
}

fn blood_sand_stance(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    if val.as_str().as_ref() == "SAND" {
        ctx.mods.push(new_mod("Condition:SandStance", ModType::Flag, b(true), "Config", vec![]));
    }
}

pub fn register(map: &mut HandlerMap) {
    map.insert("divineSentinelPhysAsFire", divine_sentinel_phys_as_fire);
    map.insert("divineSentinelPhysAsLightning", divine_sentinel_phys_as_lightning);
    map.insert("divineSentinelRegenLife", divine_sentinel_regen_life);
    map.insert("divineSentinelRegenMana", divine_sentinel_regen_mana);
    map.insert("divineSentinelChaosResistance", divine_sentinel_chaos_resistance);
    map.insert("divineSentinelSelfCurseEffect", divine_sentinel_self_curse_effect);
    map.insert("curseOverlaps", curse_overlaps);
    map.insert("elementalArmyExposureType", elemental_army_exposure_type);
    map.insert("embraceMadnessActive", embrace_madness_active);
    map.insert("touchedDebuffsCount", touched_debuffs_count);
    map.insert("feedingFrenzyFeedingFrenzyActive", feeding_frenzy_feeding_frenzy_active);
    map.insert("flameWallAddedDamage", flame_wall_added_damage);
    map.insert("FlickerStrikeBypassCD", flicker_strike_bypass_cd);
    map.insert("freshMeatBuffs", fresh_meat_buffs);
    map.insert("frostShieldStages", frost_shield_stages);
    map.insert("Disgorged", disgorged);
    map.insert("greaterHarbingerOfTimeSlipstream", greater_harbinger_of_time_slipstream);
    map.insert("harbingerOfTimeSlipstream", harbinger_of_time_slipstream);
    map.insert("multiplierHexDoom", multiplier_hex_doom);
    map.insert("heraldOfAgonyVirulenceStack", herald_of_agony_virulence_stack);
    map.insert("hoaOverkill", hoa_overkill);
    map.insert("heraldOfTheHivePressure", herald_of_the_hive_pressure);
    map.insert("inventionMineTrapPlacedDuration", invention_mine_trap_placed_duration);
    map.insert("iceNovaCastOnFrostbolt", ice_nova_cast_on_frostbolt);
    map.insert("infusedChannellingInfusion", infused_channelling_infusion);
    map.insert("innervateInnervation", innervate_innervation);
    map.insert("intensifyIntensity", intensify_intensity);
    map.insert("OverloadedIntensity", overloaded_intensity);
    map.insert("multiplierLinkedTargets", multiplier_linked_targets);
    map.insert("linkedToMinion", linked_to_minion);
    map.insert("linkedSourceRate", linked_source_rate);
    map.insert("manabondMissingUnreservedManaPercentage", manabond_missing_unreserved_mana_percentage);
    map.insert("minionPactLife", minion_pact_life);
    map.insert("conditionEnemyMalignantMadness", condition_enemy_malignant_madness);
    map.insert("meatShieldEnemyNearYou", meat_shield_enemy_near_you);
    map.insert("enemyHitMistyReflection", enemy_hit_misty_reflection);
    map.insert("MomentumStacks", momentum_stacks);
    map.insert("MomentumSwiftnessStacks", momentum_swiftness_stacks);
    map.insert("plagueBearerState", plague_bearer_state);
    map.insert("perforateSpikeOverlap", perforate_spike_overlap);
    map.insert("physicalAegisDepleted", physical_aegis_depleted);
    map.insert("deathmarkDeathmarkActive", deathmark_deathmark_active);
    map.insert("prideEffect", pride_effect);
    map.insert("sacrificedRageCount", sacrificed_rage_count);
    map.insert("raiseSpectreEnableBuffs", raise_spectre_enable_buffs);
    map.insert("raiseSpectreEnableCurses", raise_spectre_enable_curses);
    map.insert("conditionSummonedSpectreInPast8Sec", condition_summoned_spectre_in_past8_sec);
    map.insert("raiseSpectreBladeVortexBladeCount", raise_spectre_blade_vortex_blade_count);
    map.insert("raiseSpectreKaomFireBeamTotemStage", raise_spectre_kaom_fire_beam_totem_stage);
    map.insert("raiseSpectreEnableSummonedUrsaRallyingCry", raise_spectre_enable_summoned_ursa_rallying_cry);
    map.insert("raiseSpectreEnableSlashingHorrorEnrage", raise_spectre_enable_slashing_horror_enrage);
    map.insert("raiseSpectreEnableSanguimancerDemonLowLife", raise_spectre_enable_sanguimancer_demon_low_life);
    map.insert("raiseSpidersSpiderCount", raise_spiders_spider_count);
    map.insert("conditionSummonedZombieInPast8Sec", condition_summoned_zombie_in_past8_sec);
    map.insert("animateWeaponLingeringBlade", animate_weapon_lingering_blade);
    map.insert("ShrapnelBallistaProjectileOverlap", shrapnel_ballista_projectile_overlap);
    map.insert("sigilOfPowerStages", sigil_of_power_stages);
    map.insert("siphoningTrapAffectedEnemies", siphoning_trap_affected_enemies);
    map.insert("configSnipeStages", config_snipe_stages);
    map.insert("configSpectralTigerCount", config_spectral_tiger_count);
    map.insert("configSpectralWolfCount", config_spectral_wolf_count);
    map.insert("bloodSandStance", blood_sand_stance);
}
