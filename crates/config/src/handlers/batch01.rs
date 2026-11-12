use crate::ctx::ConfigCtx;
use crate::helpers::{b, map, n, new_mod, s, tag};
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::sym::Sym;

/// A `Mod` with no source, matching a `modLib.createMod(...)`/`modList:NewMod(...)` call that
/// omits the `source` argument entirely (so it stays Lua `nil`), as opposed to `new_mod` which
/// always sets one. Used only where upstream genuinely passes no source string.
fn mod_no_source(name: &str, ty: ModType, value: pom_engine::value::Value, tags: Vec<Tag>) -> Mod {
    Mod { name: Sym::new(name), ty, value, flags: 0, keyword_flags: 0, source: None, tags: (tags).into() }
}

// ConfigOptions.lua:155-157
fn detonate_dead_corpse_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("corpseLife")), ("value", n(val.as_f64()))]),
        "Config",
        vec![],
    ));
}

// ConfigOptions.lua:158-170
fn condition_stationary(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let sanitized = val.as_f64().max(0.0);
    ctx.mods.push(new_mod("Multiplier:StationarySeconds", ModType::Base, n(sanitized), "Config", vec![]));
    if sanitized > 0.0 {
        ctx.mods.push(new_mod("Condition:Stationary", ModType::Flag, b(true), "Config", vec![]));
    }
}

// ConfigOptions.lua:171-173
fn condition_moving(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Moving", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:174-176
fn condition_full_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:FullLife", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:177-179
fn condition_low_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LowLife", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:180-182
fn condition_full_mana(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:FullMana", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:183-185
fn condition_low_mana(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LowMana", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:186-188
fn condition_full_energy_shield(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:FullEnergyShield", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:189-191
fn condition_low_energy_shield(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LowEnergyShield", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:192-194
fn condition_have_energy_shield(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:HaveEnergyShield", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:195-197
fn condition_unbroken_ward(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:UnbrokenWard", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:198-200
fn minions_condition_full_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("Condition:FullLife", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", crate::helpers::mod_value(&inner))]), "Config", vec![]));
}

// ConfigOptions.lua:201-203
fn minions_condition_low_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("Condition:LowLife", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", crate::helpers::mod_value(&inner))]), "Config", vec![]));
}

// ConfigOptions.lua:204-206
fn minions_condition_full_energy_shield(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("Condition:FullEnergyShield", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(new_mod("MinionModifier", ModType::List, map(&[("mod", crate::helpers::mod_value(&inner))]), "Config", vec![]));
}

// ConfigOptions.lua:207-209
fn minions_condition_created_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:MinionsCreatedRecently", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:212-218
fn life_regen_mode(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let val = val.as_str();
    match val.as_ref() {
        "AVERAGE" => ctx.mods.push(new_mod("Condition:LifeRegenBurstAvg", ModType::Flag, b(true), "Config", vec![])),
        "FULL" => ctx.mods.push(new_mod("Condition:LifeRegenBurstFull", ModType::Flag, b(true), "Config", vec![])),
        _ => {}
    }
}

// ConfigOptions.lua:219-225
fn resource_gain_mode(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let val = val.as_str();
    match val.as_ref() {
        "AVERAGE" => ctx.mods.push(new_mod("Condition:AverageResourceGain", ModType::Flag, b(true), "Config", vec![])),
        "MAX" => ctx.mods.push(new_mod("Condition:MaxResourceGain", ModType::Flag, b(true), "Config", vec![])),
        _ => {}
    }
}

// ConfigOptions.lua:228-234
fn armour_calculation_mode(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let val = val.as_str();
    match val.as_ref() {
        "MAX" => ctx.mods.push(new_mod("Condition:ArmourMax", ModType::Flag, b(true), "Config", vec![])),
        "AVERAGE" => ctx.mods.push(new_mod("Condition:ArmourAvg", ModType::Flag, b(true), "Config", vec![])),
        _ => {}
    }
}

// ConfigOptions.lua:235-239
fn warcry_mode(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    if val.as_str().as_ref() == "MAX" {
        ctx.mods.push(new_mod("Condition:WarcryMaxHit", ModType::Flag, b(true), "Config", vec![]));
    }
}

// ConfigOptions.lua:240-244
fn pact_mode(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    if val.as_str().as_ref() == "MAX" {
        ctx.mods.push(new_mod("Condition:PactMaxHit", ModType::Flag, b(true), "Config", vec![]));
    }
}

// ConfigOptions.lua:245-247
fn ev_bypass(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:EVBypass", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:258-260
fn arcane_cloak_used_recently_check(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:ArcaneCloakUsedRecently", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:262-264
fn aspect_of_lunaris_lunar_protection(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:LunarProtection", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

// ConfigOptions.lua:265-267
fn aspect_of_lunaris_lunar_resistance(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:LunarResistance", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

// ConfigOptions.lua:269-271
fn aspect_of_solaris_sunscald_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:SunscaldStack",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Effective"))])],
    ));
}

// ConfigOptions.lua:273-275
fn aspect_of_the_avian_avians_might(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:AviansMightActive", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:276-278
fn aspect_of_the_avian_avians_flight(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:AviansFlightActive", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:280-282
fn aspect_of_the_cat_cats_stealth(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:CatsStealthActive", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:283-285
fn aspect_of_the_cat_cats_agility(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:CatsAgilityActive", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:287-289
fn override_crab_barriers(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "CrabBarriers",
        ModType::Override,
        n(val.as_f64()),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

// ConfigOptions.lua:291-296
fn aspect_of_the_spider_web_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    let inner = mod_no_source("Multiplier:SpiderWebApplyStack", ModType::Base, n(v), vec![]);
    ctx.mods.push(new_mod(
        "ExtraSkillMod",
        ModType::List,
        map(&[("mod", crate::helpers::mod_value(&inner))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Aspect of the Spider"))])],
    ));
    if v > 0.0 {
        ctx.mods.push(new_mod("Condition:AspectOfTheSpiderActive", ModType::Flag, b(true), "Config", vec![]));
    }
}

// ConfigOptions.lua:298-300
fn banner_planted(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:BannerPlanted", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:301-303
fn banner_valour(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Multiplier:ValourStacks",
        ModType::Base,
        n(val.as_f64()),
        "Config",
        vec![tag("IgnoreCond", &[]), tag("Condition", &[("var", s("Combat"))])],
    ));
}

// ConfigOptions.lua:305-308
fn barkskin_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod("Multiplier:BarkskinStacks", ModType::Base, n(v.min(10.0)), "Config", vec![]));
    ctx.mods.push(new_mod("Multiplier:MissingBarkskinStacks", ModType::Base, n((-v).max(-10.0)), "Config", vec![]));
}

// ConfigOptions.lua:310-312
fn unbound(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:Unbound", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:314-316
fn bladestorm_in_bloodstorm(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:BladestormInBloodstorm",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Bladestorm")), ("includeTransfigured", b(true))])],
    ));
}

// ConfigOptions.lua:317-319
fn bladestorm_in_sandstorm(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:BladestormInSandstorm",
        ModType::Flag,
        b(true),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Bladestorm")), ("includeTransfigured", b(true))])],
    ));
}

// ConfigOptions.lua:321-325
fn bloodsoaked_banner_stages(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod(
        "Multiplier:BloodsoakedBannerStageAfterFirst",
        ModType::Base,
        n((v - 1.0).min(9.0)),
        "Config",
        vec![tag("Condition", &[("var", s("Effective"))])],
    ));
}

// ConfigOptions.lua:327-329
fn blood_sacrament_reservation_ehp(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:BloodSacramentReservationEHP", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:331-333
fn active_brands(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:ConfigActiveBrands", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

// ConfigOptions.lua:334-336
fn brands_attached_to_enemy(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:ConfigBrandsAttachedToEnemy", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

// ConfigOptions.lua:337-339
fn target_branded_enemy(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:TargetingBrandedEnemy", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:340-343
fn brands_in_last_quarter(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:BrandLastQuarter", ModType::Flag, b(true), "Config", vec![]));
    ctx.mods.push(new_mod("Condition:BrandLastHalf", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:344-346
fn brands_in_last_half(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:BrandLastHalf", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:348-350
fn carrion_golem_nearby_minion(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:NearbyNonGolemMinion", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

// ConfigOptions.lua:351-353
fn carrion_golem_equals_chaos_golem(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:CarrionEqualChaosGolem", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:354-356
fn chaos_golem_equals_stone_golem(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:ChaosEqualStoneGolem", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:357-359
fn cinderflame_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:CinderflameStacks", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

// ConfigOptions.lua:360-362
fn stone_golem_equals_carrion_golem(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:StoneEqualCarrionGolem", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:364-366
fn close_combat_combat_rush(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:CombatRushActive", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:368-370
fn cold_snap_bypass_cd(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "CooldownRecovery",
        ModType::Override,
        n(0.0),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Cold Snap")), ("includeTransfigured", b(true))])],
    ));
}

// ConfigOptions.lua:372-374
fn conc_path_bypass_cd(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "CooldownRecovery",
        ModType::Override,
        n(0.0),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Consecrated Path of Endurance"))])],
    ));
}

// ConfigOptions.lua:376-380
fn condition_corrupting_cry_stages(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod(
        "Multiplier:CorruptingCryStageAfterFirst",
        ModType::Base,
        n((v - 1.0).min(9.0)),
        "Config",
        vec![tag("Condition", &[("var", s("Effective"))])],
    ));
}

// ConfigOptions.lua:382-384
fn override_cruelty(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Cruelty",
        ModType::Override,
        n(val.as_f64().min(40.0)),
        "Config",
        vec![tag("Condition", &[("var", s("Combat"))])],
    ));
}

// ConfigOptions.lua:386-388
fn channelling_cyclone_check(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:ChannellingCyclone", ModType::Flag, b(true), "Config", vec![]));
}

// ConfigOptions.lua:390-392
fn dark_pact_skeleton_life(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "SkillData",
        ModType::List,
        map(&[("key", s("skeletonLife")), ("value", n(val.as_f64()))]),
        "Config",
        vec![tag("SkillName", &[("skillName", s("Dark Bargain"))])],
    ));
}

// ConfigOptions.lua:394-397
fn divine_sentinel_phys_as_fire(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelPhysAsFire", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelPhysAsFire", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", crate::helpers::mod_value(&inner))]), vec![]));
}

// ConfigOptions.lua:398-401
fn divine_sentinel_phys_as_lightning(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelPhysAsLightning", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelPhysAsLightning", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", crate::helpers::mod_value(&inner))]), vec![]));
}

// ConfigOptions.lua:402-405
fn divine_sentinel_regen_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:DivineSentinelRegenLife", ModType::Flag, b(true), "Config", vec![]));
    let inner = new_mod("Condition:DivineSentinelRegenLife", ModType::Flag, b(true), "Config", vec![]);
    ctx.mods.push(mod_no_source("MinionModifier", ModType::List, map(&[("mod", crate::helpers::mod_value(&inner))]), vec![]));
}

pub fn register(map: &mut HandlerMap) {
    map.insert("detonateDeadCorpseLife", detonate_dead_corpse_life);
    map.insert("conditionStationary", condition_stationary);
    map.insert("conditionMoving", condition_moving);
    map.insert("conditionFullLife", condition_full_life);
    map.insert("conditionLowLife", condition_low_life);
    map.insert("conditionFullMana", condition_full_mana);
    map.insert("conditionLowMana", condition_low_mana);
    map.insert("conditionFullEnergyShield", condition_full_energy_shield);
    map.insert("conditionLowEnergyShield", condition_low_energy_shield);
    map.insert("conditionHaveEnergyShield", condition_have_energy_shield);
    map.insert("conditionUnbrokenWard", condition_unbroken_ward);
    map.insert("minionsConditionFullLife", minions_condition_full_life);
    map.insert("minionsConditionLowLife", minions_condition_low_life);
    map.insert("minionsConditionFullEnergyShield", minions_condition_full_energy_shield);
    map.insert("minionsConditionCreatedRecently", minions_condition_created_recently);
    map.insert("lifeRegenMode", life_regen_mode);
    map.insert("resourceGainMode", resource_gain_mode);
    map.insert("armourCalculationMode", armour_calculation_mode);
    map.insert("warcryMode", warcry_mode);
    map.insert("pactMode", pact_mode);
    map.insert("EVBypass", ev_bypass);
    map.insert("arcaneCloakUsedRecentlyCheck", arcane_cloak_used_recently_check);
    map.insert("aspectOfLunarisLunarProtection", aspect_of_lunaris_lunar_protection);
    map.insert("aspectOfLunarisLunarResistance", aspect_of_lunaris_lunar_resistance);
    map.insert("aspectOfSolarisSunscaldStacks", aspect_of_solaris_sunscald_stacks);
    map.insert("aspectOfTheAvianAviansMight", aspect_of_the_avian_avians_might);
    map.insert("aspectOfTheAvianAviansFlight", aspect_of_the_avian_avians_flight);
    map.insert("aspectOfTheCatCatsStealth", aspect_of_the_cat_cats_stealth);
    map.insert("aspectOfTheCatCatsAgility", aspect_of_the_cat_cats_agility);
    map.insert("overrideCrabBarriers", override_crab_barriers);
    map.insert("aspectOfTheSpiderWebStacks", aspect_of_the_spider_web_stacks);
    map.insert("bannerPlanted", banner_planted);
    map.insert("bannerValour", banner_valour);
    map.insert("barkskinStacks", barkskin_stacks);
    map.insert("Unbound", unbound);
    map.insert("bladestormInBloodstorm", bladestorm_in_bloodstorm);
    map.insert("bladestormInSandstorm", bladestorm_in_sandstorm);
    map.insert("bloodsoakedBannerStages", bloodsoaked_banner_stages);
    map.insert("bloodSacramentReservationEHP", blood_sacrament_reservation_ehp);
    map.insert("ActiveBrands", active_brands);
    map.insert("BrandsAttachedToEnemy", brands_attached_to_enemy);
    map.insert("targetBrandedEnemy", target_branded_enemy);
    map.insert("BrandsInLastQuarter", brands_in_last_quarter);
    map.insert("BrandsInLastHalf", brands_in_last_half);
    map.insert("carrionGolemNearbyMinion", carrion_golem_nearby_minion);
    map.insert("carrionGolemEqualsChaosGolem", carrion_golem_equals_chaos_golem);
    map.insert("chaosGolemEqualsStoneGolem", chaos_golem_equals_stone_golem);
    map.insert("cinderflameStacks", cinderflame_stacks);
    map.insert("stoneGolemEqualsCarrionGolem", stone_golem_equals_carrion_golem);
    map.insert("closeCombatCombatRush", close_combat_combat_rush);
    map.insert("ColdSnapBypassCD", cold_snap_bypass_cd);
    map.insert("ConcPathBypassCD", conc_path_bypass_cd);
    map.insert("conditionCorruptingCryStages", condition_corrupting_cry_stages);
    map.insert("overrideCruelty", override_cruelty);
    map.insert("channellingCycloneCheck", channelling_cyclone_check);
    map.insert("darkPactSkeletonLife", dark_pact_skeleton_life);
    map.insert("divineSentinelPhysAsFire", divine_sentinel_phys_as_fire);
    map.insert("divineSentinelPhysAsLightning", divine_sentinel_phys_as_lightning);
    map.insert("divineSentinelRegenLife", divine_sentinel_regen_life);
}
