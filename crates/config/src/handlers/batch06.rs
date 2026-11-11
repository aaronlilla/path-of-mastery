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

fn multiplier_totems_killed_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:EnemyKilledByTotemsRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:TotemsKilledRecently");
}
fn condition_minions_killed_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:MinionsKilledRecently");
}
fn condition_minions_died_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:MinionsDiedRecently");
}
fn multiplier_minions_killed_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:EnemyKilledByMinionsRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:MinionsKilledRecently");
}
fn condition_killed_affected_by_dot(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:KilledAffectedByDotRecently");
}
fn multiplier_shocked_enemy_killed_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:ShockedEnemyKilledRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_shocked_non_shocked_enemy_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:ShockedNonShockedEnemyRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_frozen_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:FrozenEnemyRecently");
}
fn condition_chilled_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:ChilledEnemyRecently");
}
fn condition_shattered_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:ShatteredEnemyRecently");
}
fn condition_ignited_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:IgnitedEnemyRecently");
}
fn multiplier_ignite_applied_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:IgniteAppliedRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_shocked_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:ShockedEnemyRecently");
}
fn condition_stunned_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:StunnedEnemyRecently");
}
fn condition_stunned_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:StunnedRecently");
}
fn condition_poisoned_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:PoisonedEnemyRecently");
}
fn multiplier_poison_applied_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:PoisonAppliedRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_life_spent_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:LifeSpentRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_mana_spent_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:ManaSpentRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_ward_broken_past2_seconds(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:WardBrokenPast2Seconds");
}
fn condition_been_hit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BeenHitRecently");
}
fn multiplier_been_hit_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod("Multiplier:BeenHitRecently", ModType::Base, n(v), "Config", vec![combat()]));
    ctx.mods.push(new_mod("Condition:BeenHitRecently", ModType::Flag, b(1.0 <= v), "Config", vec![combat()]));
}
fn condition_been_hit_by_attack_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BeenHitByAttackRecently");
}
fn condition_been_crit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BeenCritRecently");
}
fn condition_consumed12_steel_shards_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Consumed12SteelShardsRecently");
}
fn condition_gained_power_charge_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:GainedPowerChargeRecently");
}
fn condition_gained_frenzy_charge_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:GainedFrenzyChargeRecently");
}
fn condition_been_savage_hit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BeenSavageHitRecently");
    flag_combat(ctx, "Condition:BeenHitRecently");
}
fn condition_hit_by_fire_damage_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HitByFireDamageRecently");
    flag_combat(ctx, "Condition:BeenHitRecently");
}
fn condition_hit_by_cold_damage_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HitByColdDamageRecently");
    flag_combat(ctx, "Condition:BeenHitRecently");
}
fn condition_hit_by_lightning_damage_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HitByLightningDamageRecently");
    flag_combat(ctx, "Condition:BeenHitRecently");
}
fn condition_hit_by_spell_damage_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HitBySpellDamageRecently");
    flag_combat(ctx, "Condition:BeenHitRecently");
}
fn condition_taken_fire_damage_from_enemy_hit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:TakenFireDamageFromEnemyHitRecently");
    flag_combat(ctx, "Condition:BeenHitRecently");
}
fn condition_blocked_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BlockedRecently");
}
fn condition_blocked_attack_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BlockedAttackRecently");
    flag_combat(ctx, "Condition:BlockedRecently");
}
fn condition_blocked_spell_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BlockedSpellRecently");
    flag_combat(ctx, "Condition:BlockedRecently");
}
fn condition_energy_shield_recharge_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:EnergyShieldRechargeRecently");
}
fn condition_energy_shield_recharge_past_two_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:EnergyShieldRechargePastTwoSec");
}
fn condition_stopped_taking_damage_over_time_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:StoppedTakingDamageOverTimeRecently");
}
fn condition_convergence(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "Condition:Convergence",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat(), tag("Condition", &[("var", s("CanGainConvergence"))])],
    ));
}
fn buff_pendulum(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    match val.as_str().as_ref() {
        "AREA" => flag_combat(ctx, "Condition:PendulumOfDestructionAreaOfEffect"),
        "DAMAGE" => flag_combat(ctx, "Condition:PendulumOfDestructionElementalDamage"),
        _ => {}
    }
}
fn buff_conflux(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_str();
    if v.as_ref() == "CHILLING" || v.as_ref() == "ALL" {
        flag_combat(ctx, "Condition:ChillingConflux");
    }
    if v.as_ref() == "SHOCKING" || v.as_ref() == "ALL" {
        flag_combat(ctx, "Condition:ShockingConflux");
    }
    if v.as_ref() == "IGNITING" || v.as_ref() == "ALL" {
        flag_combat(ctx, "Condition:IgnitingConflux");
    }
}
fn highest_damage_type(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_str();
    if v.as_ref() != "NONE" {
        ctx.mods.push(new_mod(&format!("Condition:{v}IsHighestDamageType"), ModType::Flag, b(true), "Config", vec![]));
        ctx.mods.push(new_mod("IsHighestDamageTypeOVERRIDE", ModType::Flag, b(true), "Config", vec![]));
    }
}
fn buff_heartstopper(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    match val.as_str().as_ref() {
        "HIT" => flag_combat(ctx, "Condition:HeartstopperHIT"),
        "DOT" => flag_combat(ctx, "Condition:HeartstopperDOT"),
        "AVERAGE" => flag_combat(ctx, "Condition:HeartstopperAVERAGE"),
        _ => {}
    }
}
fn buff_bastion_of_hope(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:BastionOfHopeActive");
}
fn buff_ngamahu_flames_advance(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:NgamahuFlamesAdvance");
}
fn buff_her_embrace(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "HerEmbrace",
        ModType::Flag,
        b(true),
        "Config",
        vec![combat(), tag("Condition", &[("var", s("CanGainHerEmbrace"))])],
    ));
}
fn condition_champion_intimidate(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:ChampionIntimidate", ModType::Flag, b(true), "Config", vec![combat()]));
}
fn condition_used_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn multiplier_skill_used_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SkillUsedRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_attacked_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:AttackedRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn condition_cast_spell_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:CastSpellRecently");
    flag_combat(ctx, "Condition:UsedSkillRecently");
}
fn multiplier_non_instant_spell_cast_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:NonInstantSpellCastRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_applied_ailments_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:AppliedAilmentsRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_linked_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:LinkedRecently", ModType::Flag, b(true), "Config", vec![]));
}
fn condition_stunned_while_casting_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:StunnedWhileCastingRecently");
}
fn condition_cast_last1_seconds(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:CastLast1Seconds");
}
fn multiplier_cast_last8_seconds(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:CastLast8Seconds", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_suppressed_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SuppressedRecently");
}

pub fn register(map: &mut HandlerMap) {
    map.insert("multiplierTotemsKilledRecently", multiplier_totems_killed_recently);
    map.insert("conditionMinionsKilledRecently", condition_minions_killed_recently);
    map.insert("conditionMinionsDiedRecently", condition_minions_died_recently);
    map.insert("multiplierMinionsKilledRecently", multiplier_minions_killed_recently);
    map.insert("conditionKilledAffectedByDoT", condition_killed_affected_by_dot);
    map.insert("multiplierShockedEnemyKilledRecently", multiplier_shocked_enemy_killed_recently);
    map.insert("multiplierShockedNonShockedEnemyRecently", multiplier_shocked_non_shocked_enemy_recently);
    map.insert("conditionFrozenEnemyRecently", condition_frozen_enemy_recently);
    map.insert("conditionChilledEnemyRecently", condition_chilled_enemy_recently);
    map.insert("conditionShatteredEnemyRecently", condition_shattered_enemy_recently);
    map.insert("conditionIgnitedEnemyRecently", condition_ignited_enemy_recently);
    map.insert("multiplierIgniteAppliedRecently", multiplier_ignite_applied_recently);
    map.insert("conditionShockedEnemyRecently", condition_shocked_enemy_recently);
    map.insert("conditionStunnedEnemyRecently", condition_stunned_enemy_recently);
    map.insert("conditionStunnedRecently", condition_stunned_recently);
    map.insert("conditionPoisonedEnemyRecently", condition_poisoned_enemy_recently);
    map.insert("multiplierPoisonAppliedRecently", multiplier_poison_applied_recently);
    map.insert("multiplierLifeSpentRecently", multiplier_life_spent_recently);
    map.insert("multiplierManaSpentRecently", multiplier_mana_spent_recently);
    map.insert("conditionWardBrokenPast2Seconds", condition_ward_broken_past2_seconds);
    map.insert("conditionBeenHitRecently", condition_been_hit_recently);
    map.insert("multiplierBeenHitRecently", multiplier_been_hit_recently);
    map.insert("conditionBeenHitByAttackRecently", condition_been_hit_by_attack_recently);
    map.insert("conditionBeenCritRecently", condition_been_crit_recently);
    map.insert("conditionConsumed12SteelShardsRecently", condition_consumed12_steel_shards_recently);
    map.insert("conditionGainedPowerChargeRecently", condition_gained_power_charge_recently);
    map.insert("conditionGainedFrenzyChargeRecently", condition_gained_frenzy_charge_recently);
    map.insert("conditionBeenSavageHitRecently", condition_been_savage_hit_recently);
    map.insert("conditionHitByFireDamageRecently", condition_hit_by_fire_damage_recently);
    map.insert("conditionHitByColdDamageRecently", condition_hit_by_cold_damage_recently);
    map.insert("conditionHitByLightningDamageRecently", condition_hit_by_lightning_damage_recently);
    map.insert("conditionHitBySpellDamageRecently", condition_hit_by_spell_damage_recently);
    map.insert("conditionTakenFireDamageFromEnemyHitRecently", condition_taken_fire_damage_from_enemy_hit_recently);
    map.insert("conditionBlockedRecently", condition_blocked_recently);
    map.insert("conditionBlockedAttackRecently", condition_blocked_attack_recently);
    map.insert("conditionBlockedSpellRecently", condition_blocked_spell_recently);
    map.insert("conditionEnergyShieldRechargeRecently", condition_energy_shield_recharge_recently);
    map.insert("conditionEnergyShieldRechargePastTwoSec", condition_energy_shield_recharge_past_two_sec);
    map.insert("conditionStoppedTakingDamageOverTimeRecently", condition_stopped_taking_damage_over_time_recently);
    map.insert("conditionConvergence", condition_convergence);
    map.insert("buffPendulum", buff_pendulum);
    map.insert("buffConflux", buff_conflux);
    map.insert("highestDamageType", highest_damage_type);
    map.insert("buffHeartstopper", buff_heartstopper);
    map.insert("buffBastionOfHope", buff_bastion_of_hope);
    map.insert("buffNgamahuFlamesAdvance", buff_ngamahu_flames_advance);
    map.insert("buffHerEmbrace", buff_her_embrace);
    map.insert("conditionChampionIntimidate", condition_champion_intimidate);
    map.insert("conditionUsedSkillRecently", condition_used_skill_recently);
    map.insert("multiplierSkillUsedRecently", multiplier_skill_used_recently);
    map.insert("conditionAttackedRecently", condition_attacked_recently);
    map.insert("conditionCastSpellRecently", condition_cast_spell_recently);
    map.insert("multiplierNonInstantSpellCastRecently", multiplier_non_instant_spell_cast_recently);
    map.insert("multiplierAppliedAilmentsRecently", multiplier_applied_ailments_recently);
    map.insert("conditionLinkedRecently", condition_linked_recently);
    map.insert("conditionStunnedWhileCastingRecently", condition_stunned_while_casting_recently);
    map.insert("conditionCastLast1Seconds", condition_cast_last1_seconds);
    map.insert("multiplierCastLast8Seconds", multiplier_cast_last8_seconds);
    map.insert("conditionSuppressedRecently", condition_suppressed_recently);
}
