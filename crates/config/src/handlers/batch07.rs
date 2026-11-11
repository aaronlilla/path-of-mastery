use crate::ctx::ConfigCtx;
use crate::helpers::{b, n, new_mod, s, tag};
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::ModType;

fn combat() -> pom_engine::modifier::Tag {
    tag("Condition", &[("var", s("Combat"))])
}
fn flag_combat(ctx: &mut ConfigCtx, name: &str) {
    ctx.mods.push(new_mod(name, ModType::Flag, b(true), "Config", vec![combat()]));
}

fn multiplier_hits_suppressed_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:HitsSuppressedRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:SuppressedRecently");
}
fn condition_used_fire_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedFireSkillRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_used_cold_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedColdSkillRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_used_minion_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedMinionSkillRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_used_travel_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedTravelSkillRecently");
    flag_combat(ctx, "Condition:UsedMovementSkillRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_used_dash_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:CastDashRecently");
    flag_combat(ctx, "Condition:UsedTravelSkillRecently");
    flag_combat(ctx, "Condition:UsedMovementSkillRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_used_movement_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedMovementSkillRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_used_vaal_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedVaalSkillRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn multiplier_used_vaal_skill_in_past8_seconds(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:VaalSkillsUsedInPast8Seconds", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_soul_gain_prevention(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SoulGainPrevention");
}
fn condition_sacrifice_minion(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SacrificeMinionOnAttack");
}
fn condition_used_warcry_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedWarcryRecently");
    flag_combat(ctx, "Condition:UsedWarcryInPast8Seconds");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_used_warcry_in_past8_seconds(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedWarcryInPast8Seconds");
}
fn multiplier_affected_by_warcry_buff_duration(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:AffectedByWarcryBuffDuration", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn detonated_mines_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:DetonatedMinesRecently");
}
fn multiplier_mine_detonated_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:MineDetonatedRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn mines_per_throw(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("MineThrowCount", ModType::Override, n(val.as_f64()), "Config", vec![combat()]));
}
fn triggered_traps_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:TriggeredTrapsRecently");
}
fn multiplier_trap_triggered_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:TrapTriggeredRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_thrown_trap_or_mine_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:TrapOrMineThrownRecently");
}
fn traps_per_throw(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("TrapThrowCount", ModType::Override, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_cursed_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:CursedEnemyRecently", ModType::Flag, b(true), "Config", vec![tag("Condition", &[("var", s("Effective"))])]));
}
fn condition_cast_mark_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:CastMarkRecently");
}
fn condition_spawned_corpse_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SpawnedCorpseRecently");
}
fn condition_consumed_corpse_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:ConsumedCorpseRecently");
}
fn condition_consumed_corpse_in_past2_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:ConsumedCorpseInPast2Sec");
}
fn multiplier_corpse_consumed_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:CorpseConsumedRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:ConsumedCorpseRecently");
}
fn condition_ravenous_corpse_consumed(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:RavenousCorpseConsumed");
}
fn multiplier_warcry_used_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:WarcryUsedRecently", ModType::Base, n(val.as_f64().min(100.0)), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:UsedWarcryRecently");
    flag_combat(ctx, "Condition:UsedWarcryInPast8Seconds");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_taunted_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:TauntedEnemyRecently");
}
fn condition_lost_endurance_charge_in_past8_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:LostEnduranceChargeInPast8Sec");
}
fn multiplier_endurance_charges_lost_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:EnduranceChargesLostRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:LostEnduranceChargeInPast8Sec");
}
fn condition_blocked_hit_from_unique_enemy_in_past10_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BlockedHitFromUniqueEnemyInPast10Sec");
}
fn condition_killed_unique_enemy(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:KilledUniqueEnemy");
}
fn blocked_past10_sec(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:BlockedPast10Sec", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_impaled_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:ImpaledRecently");
}
fn multiplier_impales_on_enemy(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:ImpaleStacks", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_caused_bleeding_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:CausedBleedingRecently");
}
fn multiplier_bleeds_on_enemy(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:BleedStacks", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    ctx.enemy.push(new_mod("Condition:Bleeding", ModType::Flag, b(true), "Config", vec![tag("Condition", &[("var", s("Effective"))])]));
}
fn multiplier_fragile_regrowth(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:FragileRegrowthCount", ModType::Base, n(val.as_f64().min(10.0)), "Config", vec![combat()]));
}
fn condition_have_arborix(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HaveIronReflexes");
    ctx.mods.push(new_mod("Keystone", ModType::List, s("Iron Reflexes"), "Config", vec![]));
}
fn condition_have_augyre(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    match val.as_str().as_ref() {
        "EleOverload" => {
            flag_combat(ctx, "Condition:HaveElementalOverload");
            ctx.mods.push(new_mod("Keystone", ModType::List, s("Elemental Overload"), "Config", vec![]));
        }
        "ResTechnique" => {
            flag_combat(ctx, "Condition:HaveResoluteTechnique");
            ctx.mods.push(new_mod("Keystone", ModType::List, s("Resolute Technique"), "Config", vec![]));
        }
        _ => {}
    }
}
fn condition_have_vulconus(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HaveAvatarOfFire");
    ctx.mods.push(new_mod("Keystone", ModType::List, s("Avatar of Fire"), "Config", vec![]));
}
fn condition_have_mana_storm(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SacrificeManaForLightning");
}
fn gamblesprint_movement_speed(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "MovementSpeed",
        ModType::Inc,
        n(val.as_f64()),
        "Config",
        vec![combat(), tag("Condition", &[("var", s("HaveGamblesprint"))])],
    ));
}
fn everlasting_sacrifice(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let tags = || vec![combat(), tag("Condition", &[("var", s("EverlastingSacrifice"))])];
    ctx.mods.push(new_mod("ElementalResistMax", ModType::Base, n(5.0), "Config", tags()));
    ctx.mods.push(new_mod("ChaosResistMax", ModType::Base, n(5.0), "Config", tags()));
}
fn buff_fanaticism(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:Fanaticism",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat(), tag("Condition", &[("var", s("CanGainFanaticism"))])],
    ));
}
fn condition_hits_always_stun(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "CullPercent",
        ModType::Max,
        n(10.0),
        "Config",
        vec![combat(), tag("Condition", &[("var", s("maceMasteryStunCullSpecced"))])],
    ));
}
fn multiplier_pvp_tvalue_override(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("MultiplierPvpTvalueOverride", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_pvp_damage(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("PvpDamageMultiplier", ModType::More, n(val.as_f64() - 100.0), "Config", vec![]));
}
fn buff_acceleration_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:AccelerationShrine");
}
fn buff_brutal_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BrutalShrine");
}
fn buff_diamond_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:DiamondShrine");
}
fn buff_divine_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:DivineShrine");
}
fn buff_echoing_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:EchoingShrine");
}
fn buff_gloom_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:GloomShrine");
}
fn buff_greater_freezing_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:GreaterFreezingShrine");
}
fn buff_greater_shocking_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:GreaterShockingShrine");
}
fn buff_greater_skeletal_shrine(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:GreaterSkeletalShrine");
}

pub fn register(map: &mut HandlerMap) {
    map.insert("multiplierHitsSuppressedRecently", multiplier_hits_suppressed_recently);
    map.insert("conditionUsedFireSkillRecently", condition_used_fire_skill_recently);
    map.insert("conditionUsedColdSkillRecently", condition_used_cold_skill_recently);
    map.insert("conditionUsedMinionSkillRecently", condition_used_minion_skill_recently);
    map.insert("conditionUsedTravelSkillRecently", condition_used_travel_skill_recently);
    map.insert("conditionUsedDashRecently", condition_used_dash_recently);
    map.insert("conditionUsedMovementSkillRecently", condition_used_movement_skill_recently);
    map.insert("conditionUsedVaalSkillRecently", condition_used_vaal_skill_recently);
    map.insert("multiplierUsedVaalSkillInPast8Seconds", multiplier_used_vaal_skill_in_past8_seconds);
    map.insert("conditionSoulGainPrevention", condition_soul_gain_prevention);
    map.insert("conditionSacrificeMinion", condition_sacrifice_minion);
    map.insert("conditionUsedWarcryRecently", condition_used_warcry_recently);
    map.insert("conditionUsedWarcryInPast8Seconds", condition_used_warcry_in_past8_seconds);
    map.insert("multiplierAffectedByWarcryBuffDuration", multiplier_affected_by_warcry_buff_duration);
    map.insert("DetonatedMinesRecently", detonated_mines_recently);
    map.insert("multiplierMineDetonatedRecently", multiplier_mine_detonated_recently);
    map.insert("minesPerThrow", mines_per_throw);
    map.insert("TriggeredTrapsRecently", triggered_traps_recently);
    map.insert("multiplierTrapTriggeredRecently", multiplier_trap_triggered_recently);
    map.insert("conditionThrownTrapOrMineRecently", condition_thrown_trap_or_mine_recently);
    map.insert("trapsPerThrow", traps_per_throw);
    map.insert("conditionCursedEnemyRecently", condition_cursed_enemy_recently);
    map.insert("conditionCastMarkRecently", condition_cast_mark_recently);
    map.insert("conditionSpawnedCorpseRecently", condition_spawned_corpse_recently);
    map.insert("conditionConsumedCorpseRecently", condition_consumed_corpse_recently);
    map.insert("conditionConsumedCorpseInPast2Sec", condition_consumed_corpse_in_past2_sec);
    map.insert("multiplierCorpseConsumedRecently", multiplier_corpse_consumed_recently);
    map.insert("conditionRavenousCorpseConsumed", condition_ravenous_corpse_consumed);
    map.insert("multiplierWarcryUsedRecently", multiplier_warcry_used_recently);
    map.insert("conditionTauntedEnemyRecently", condition_taunted_enemy_recently);
    map.insert("conditionLostEnduranceChargeInPast8Sec", condition_lost_endurance_charge_in_past8_sec);
    map.insert("multiplierEnduranceChargesLostRecently", multiplier_endurance_charges_lost_recently);
    map.insert("conditionBlockedHitFromUniqueEnemyInPast10Sec", condition_blocked_hit_from_unique_enemy_in_past10_sec);
    map.insert("conditionKilledUniqueEnemy", condition_killed_unique_enemy);
    map.insert("BlockedPast10Sec", blocked_past10_sec);
    map.insert("conditionImpaledRecently", condition_impaled_recently);
    map.insert("multiplierImpalesOnEnemy", multiplier_impales_on_enemy);
    map.insert("conditionCausedBleedingRecently", condition_caused_bleeding_recently);
    map.insert("multiplierBleedsOnEnemy", multiplier_bleeds_on_enemy);
    map.insert("multiplierFragileRegrowth", multiplier_fragile_regrowth);
    map.insert("conditionHaveArborix", condition_have_arborix);
    map.insert("conditionHaveAugyre", condition_have_augyre);
    map.insert("conditionHaveVulconus", condition_have_vulconus);
    map.insert("conditionHaveManaStorm", condition_have_mana_storm);
    map.insert("GamblesprintMovementSpeed", gamblesprint_movement_speed);
    map.insert("EverlastingSacrifice", everlasting_sacrifice);
    map.insert("buffFanaticism", buff_fanaticism);
    map.insert("conditionHitsAlwaysStun", condition_hits_always_stun);
    map.insert("multiplierPvpTvalueOverride", multiplier_pvp_tvalue_override);
    map.insert("multiplierPvpDamage", multiplier_pvp_damage);
    map.insert("buffAccelerationShrine", buff_acceleration_shrine);
    map.insert("buffBrutalShrine", buff_brutal_shrine);
    map.insert("buffDiamondShrine", buff_diamond_shrine);
    map.insert("buffDivineShrine", buff_divine_shrine);
    map.insert("buffEchoingShrine", buff_echoing_shrine);
    map.insert("buffGloomShrine", buff_gloom_shrine);
    map.insert("buffGreaterFreezingShrine", buff_greater_freezing_shrine);
    map.insert("buffGreaterShockingShrine", buff_greater_shocking_shrine);
    map.insert("buffGreaterSkeletalShrine", buff_greater_skeletal_shrine);
}
