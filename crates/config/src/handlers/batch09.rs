use crate::ctx::ConfigCtx;
use crate::helpers::{b, n, new_mod, s, tag};
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::ModType;

fn combat_tag() -> pom_engine::modifier::Tag {
    tag("Condition", &[("var", s("Combat"))])
}
fn effective_tag() -> pom_engine::modifier::Tag {
    tag("Condition", &[("var", s("Effective"))])
}

// NOTE: `multiplierBarnacleStacks` is implemented in batch08.rs (the source line range for these
// two batches overlaps by one entry at the boundary); it is not repeated here.

fn condition_enemy_frozen(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Frozen", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn multiplier_frozen_by_you_seconds(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:FrozenByYouSeconds", ModType::Base, n(val.as_f64()), "Config", vec![combat_tag()]));
    ctx.enemy.push(new_mod("Condition:FrozenByYou", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_brittle(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Brittle", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:BrittleConfig", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_brittle_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.enemy.push(new_mod("BrittleVal", ModType::Base, n(v), "Config", vec![tag("Condition", &[("var", s("BrittleConfig"))])]));
    ctx.enemy.push(new_mod(
        "DesiredBrittleVal", ModType::Base, n(v), "Brittle",
        vec![tag("Condition", &[("var", s("BrittleConfig")), ("neg", b(true))])],
    ));
}
fn condition_enemy_on_brittle_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Brittle", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:OnBrittleGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_shocked(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Shocked", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:ShockedConfig", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_shock_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.enemy.push(new_mod("ShockVal", ModType::Base, n(v), "Shock", vec![tag("Condition", &[("var", s("ShockedConfig"))])]));
    ctx.enemy.push(new_mod(
        "DesiredShockVal", ModType::Base, n(v), "Shock",
        vec![tag("Condition", &[("var", s("ShockedConfig")), ("neg", b(true))])],
    ));
}
fn shock_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:ShockStacks", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_enemy_on_shocked_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Shocked", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:OnShockedGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_sapped(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Sapped", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:SappedConfig", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_sap_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.enemy.push(new_mod("SapVal", ModType::Base, n(v), "Sap", vec![tag("Condition", &[("var", s("SappedConfig"))])]));
    ctx.enemy.push(new_mod(
        "DesiredSapVal", ModType::Base, n(v), "Sap",
        vec![tag("Condition", &[("var", s("SappedConfig")), ("neg", b(true))])],
    ));
}
fn condition_enemy_on_sapped_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Sapped", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:OnSappedGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn multiplier_freeze_shock_ignite_on_enemy(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:FreezeShockIgniteOnEnemy", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_enemy_fire_exposure(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "FireExposure", ModType::Base, n(-10.0), "Config",
        vec![effective_tag(), tag("ActorCondition", &[("actor", s("enemy")), ("var", s("CanApplyFireExposure"))])],
    ));
}
fn condition_enemy_cold_exposure(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "ColdExposure", ModType::Base, n(-10.0), "Config",
        vec![effective_tag(), tag("ActorCondition", &[("actor", s("enemy")), ("var", s("CanApplyColdExposure"))])],
    ));
}
fn condition_enemy_lightning_exposure(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "LightningExposure", ModType::Base, n(-10.0), "Config",
        vec![effective_tag(), tag("ActorCondition", &[("actor", s("enemy")), ("var", s("CanApplyLightningExposure"))])],
    ));
}
fn condition_enemy_intimidated(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Intimidated", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_crushed(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Crushed", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_hallowing_flame(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:HallowingFlame", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn multiplier_enemy_hallowing_flame(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:HallowingFlame", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn multiplier_hallowing_flame_stacks_removed_by_ally(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:HallowingFlameStacksRemovedByAlly", ModType::Base, n(val.as_f64()), "Config", vec![]));
}
fn condition_hallowing_flame_magnitude(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("HallowingFlameMagnitude", ModType::Override, n(val.as_f64()), "Config", vec![]));
}
fn condition_near_linked_target(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:NearLinkedTarget", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_unnerved(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Unnerved", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_covered_in_ash(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("CoveredInAshEffect", ModType::Base, n(20.0), "Covered in Ash", vec![]));
}
fn condition_enemy_covered_in_frost(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("CoveredInFrostEffect", ModType::Base, n(20.0), "Covered in Frost", vec![]));
}
fn condition_enemy_on_consecrated_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:OnConsecratedGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_have_energy_shield(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:HaveEnergyShield", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_on_profane_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:OnProfaneGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    let on_profane = tag("Condition", &[("var", s("OnProfaneGround"))]);
    ctx.enemy.push(new_mod("CurseEffectOnSelf", ModType::Inc, n(10.0), "Config", vec![on_profane.clone()]));
    ctx.enemy.push(new_mod("SelfCritChance", ModType::Inc, n(100.0), "Config", vec![on_profane]));
}
fn multiplier_enemy_affected_by_grasping_vines(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:GraspingVinesAffectingEnemy", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_enemy_on_fungal_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:OnFungalGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_on_brine_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:OnBrineGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    let on_brine = tag("Condition", &[("var", s("OnBrineGround"))]);
    ctx.enemy.push(new_mod("SelfChillEffect", ModType::Inc, n(30.0), "Config", vec![on_brine.clone()]));
    ctx.enemy.push(new_mod("SelfBrittleEffect", ModType::Inc, n(30.0), "Config", vec![on_brine.clone()]));
    ctx.enemy.push(new_mod("SelfShockEffect", ModType::Inc, n(30.0), "Config", vec![on_brine.clone()]));
    ctx.enemy.push(new_mod("SelfSapEffect", ModType::Inc, n(30.0), "Config", vec![on_brine.clone()]));
    ctx.enemy.push(new_mod("Armour", ModType::Inc, n(-25.0), "Config", vec![on_brine.clone()]));
    ctx.enemy.push(new_mod("Evasion", ModType::Inc, n(-25.0), "Config", vec![on_brine]));
}
fn condition_enemy_in_chilling_area(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:InChillingArea", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_in_frost_globe(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:EnemyInFrostGlobe", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_life_higher_than_player(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:HigherLifePercentThanPlayer", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn enemy_condition_hit_by_fire_damage(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:HitByFireDamage", ModType::Flag, b(true), "Config", vec![]));
}
fn enemy_condition_hit_by_cold_damage(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:HitByColdDamage", ModType::Flag, b(true), "Config", vec![]));
}
fn enemy_condition_hit_by_lightning_damage(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:HitByLightningDamage", ModType::Flag, b(true), "Config", vec![]));
}
fn enemy_in_rf_or_scorching_ray(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:InRFOrScorchingRay", ModType::Flag, b(true), "Config", vec![]));
}
fn condition_between_you_and_linked_target(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:BetweenYouAndLinkedTarget", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_fire_res_zero(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "FireResist", ModType::Override, n(0.0), "Config",
        vec![effective_tag(), tag("ActorCondition", &[("actor", s("enemy")), ("var", s("HaveTrickstersSmile"))])],
    ));
}
fn condition_enemy_cold_res_zero(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "ColdResist", ModType::Override, n(0.0), "Config",
        vec![effective_tag(), tag("ActorCondition", &[("actor", s("enemy")), ("var", s("HaveTrickstersSmile"))])],
    ));
}
fn condition_enemy_lightning_res_zero(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "LightningResist", ModType::Override, n(0.0), "Config",
        vec![effective_tag(), tag("ActorCondition", &[("actor", s("enemy")), ("var", s("HaveTrickstersSmile"))])],
    ));
}
fn mania_debuffs_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64().min(15.0);
    let debuff = tag("GlobalEffect", &[("effectType", s("Debuff"))]);
    let cond = tag("Condition", &[("var", s("AfflictedByMania"))]);
    let src = format!("{v} Mania Stacks");
    ctx.enemy.push(new_mod("DamageTaken", ModType::Inc, n(v * 4.0), &src, vec![debuff.clone(), cond.clone()]));
    ctx.enemy.push(new_mod("ActionSpeed", ModType::Inc, n(-v * 2.0), &src, vec![debuff.clone(), cond.clone()]));
    ctx.enemy.push(new_mod("LifeRecoveryRate", ModType::Inc, n(-v * 10.0), &src, vec![debuff.clone(), cond.clone()]));
    ctx.enemy.push(new_mod("EnergyShieldRecoveryRate", ModType::Inc, n(-v * 10.0), &src, vec![debuff, cond]));
}
fn condition_enemy_rare_or_unique(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:RareOrUnique", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn delirious_percentage(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let (more, inc, src): (f64, f64, &str) = match val.as_str().as_ref() {
        "20Percent" => (-16.0, 6.0, "20% Delirious"),
        "40Percent" => (-32.0, 12.0, "40% Delirious"),
        "60Percent" => (-48.0, 18.0, "60% Delirious"),
        "80Percent" => (-64.0, 24.0, "80% Delirious"),
        "100Percent" => (-80.0, 30.0, "100% Delirious"),
        _ => return,
    };
    ctx.enemy.push(new_mod("DamageTaken", ModType::More, n(more), src, vec![]));
    ctx.enemy.push(new_mod("Damage", ModType::Inc, n(inc), src, vec![]));
}
fn enemy_physical_reduction(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("PhysicalDamageReduction", ModType::Base, n(val.as_f64()), "EnemyConfig", vec![]));
}
fn enemy_lightning_resist(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("LightningResist", ModType::Base, n(val.as_f64()), "EnemyConfig", vec![]));
}
fn enemy_cold_resist(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("ColdResist", ModType::Base, n(val.as_f64()), "EnemyConfig", vec![]));
}
fn enemy_fire_resist(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("FireResist", ModType::Base, n(val.as_f64()), "EnemyConfig", vec![]));
}
fn enemy_chaos_resist(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("ChaosResist", ModType::Base, n(val.as_f64()), "EnemyConfig", vec![]));
}
fn enemy_max_resist(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("DoNotChangeMaxResFromConfig", ModType::Flag, b(true), "EnemyConfig", vec![]));
}
fn enemy_block_chance(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("BlockChance", ModType::Base, n(val.as_f64()), "Config", vec![]));
}
fn enemy_evasion(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Evasion", ModType::Base, n(val.as_f64()), "Config", vec![]));
}
fn enemy_armour(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Armour", ModType::Base, n(val.as_f64()), "Config", vec![]));
}
fn enemy_multiplier_pvp_damage(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("MultiplierPvpDamage", ModType::Base, n(val.as_f64()), "Config", vec![]));
}

pub fn register(map: &mut HandlerMap) {
    map.insert("conditionEnemyFrozen", condition_enemy_frozen);
    map.insert("multiplierFrozenByYouSeconds", multiplier_frozen_by_you_seconds);
    map.insert("conditionEnemyBrittle", condition_enemy_brittle);
    map.insert("conditionBrittleEffect", condition_brittle_effect);
    map.insert("conditionEnemyOnBrittleGround", condition_enemy_on_brittle_ground);
    map.insert("conditionEnemyShocked", condition_enemy_shocked);
    map.insert("conditionShockEffect", condition_shock_effect);
    map.insert("ShockStacks", shock_stacks);
    map.insert("conditionEnemyOnShockedGround", condition_enemy_on_shocked_ground);
    map.insert("conditionEnemySapped", condition_enemy_sapped);
    map.insert("conditionSapEffect", condition_sap_effect);
    map.insert("conditionEnemyOnSappedGround", condition_enemy_on_sapped_ground);
    map.insert("multiplierFreezeShockIgniteOnEnemy", multiplier_freeze_shock_ignite_on_enemy);
    map.insert("conditionEnemyFireExposure", condition_enemy_fire_exposure);
    map.insert("conditionEnemyColdExposure", condition_enemy_cold_exposure);
    map.insert("conditionEnemyLightningExposure", condition_enemy_lightning_exposure);
    map.insert("conditionEnemyIntimidated", condition_enemy_intimidated);
    map.insert("conditionEnemyCrushed", condition_enemy_crushed);
    map.insert("conditionEnemyHallowingFlame", condition_enemy_hallowing_flame);
    map.insert("multiplierEnemyHallowingFlame", multiplier_enemy_hallowing_flame);
    map.insert("multiplierHallowingFlameStacksRemovedByAlly", multiplier_hallowing_flame_stacks_removed_by_ally);
    map.insert("conditionHallowingFlameMagnitude", condition_hallowing_flame_magnitude);
    map.insert("conditionNearLinkedTarget", condition_near_linked_target);
    map.insert("conditionEnemyUnnerved", condition_enemy_unnerved);
    map.insert("conditionEnemyCoveredInAsh", condition_enemy_covered_in_ash);
    map.insert("conditionEnemyCoveredInFrost", condition_enemy_covered_in_frost);
    map.insert("conditionEnemyOnConsecratedGround", condition_enemy_on_consecrated_ground);
    map.insert("conditionEnemyHaveEnergyShield", condition_enemy_have_energy_shield);
    map.insert("conditionEnemyOnProfaneGround", condition_enemy_on_profane_ground);
    map.insert("multiplierEnemyAffectedByGraspingVines", multiplier_enemy_affected_by_grasping_vines);
    map.insert("conditionEnemyOnFungalGround", condition_enemy_on_fungal_ground);
    map.insert("conditionEnemyOnBrineGround", condition_enemy_on_brine_ground);
    map.insert("conditionEnemyInChillingArea", condition_enemy_in_chilling_area);
    map.insert("conditionEnemyInFrostGlobe", condition_enemy_in_frost_globe);
    map.insert("conditionEnemyLifeHigherThanPlayer", condition_enemy_life_higher_than_player);
    map.insert("enemyConditionHitByFireDamage", enemy_condition_hit_by_fire_damage);
    map.insert("enemyConditionHitByColdDamage", enemy_condition_hit_by_cold_damage);
    map.insert("enemyConditionHitByLightningDamage", enemy_condition_hit_by_lightning_damage);
    map.insert("enemyInRFOrScorchingRay", enemy_in_rf_or_scorching_ray);
    map.insert("conditionBetweenYouAndLinkedTarget", condition_between_you_and_linked_target);
    map.insert("conditionEnemyFireResZero", condition_enemy_fire_res_zero);
    map.insert("conditionEnemyColdResZero", condition_enemy_cold_res_zero);
    map.insert("conditionEnemyLightningResZero", condition_enemy_lightning_res_zero);
    map.insert("maniaDebuffsCount", mania_debuffs_count);
    map.insert("conditionEnemyRareOrUnique", condition_enemy_rare_or_unique);
    map.insert("deliriousPercentage", delirious_percentage);
    map.insert("enemyPhysicalReduction", enemy_physical_reduction);
    map.insert("enemyLightningResist", enemy_lightning_resist);
    map.insert("enemyColdResist", enemy_cold_resist);
    map.insert("enemyFireResist", enemy_fire_resist);
    map.insert("enemyChaosResist", enemy_chaos_resist);
    map.insert("enemyMaxResist", enemy_max_resist);
    map.insert("enemyBlockChance", enemy_block_chance);
    map.insert("enemyEvasion", enemy_evasion);
    map.insert("enemyArmour", enemy_armour);
    map.insert("enemyMultiplierPvpDamage", enemy_multiplier_pvp_damage);
}
