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

macro_rules! simple_shrine {
    ($fn_name:ident, $mod_name:literal) => {
        fn $fn_name(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
            ctx.mods.push(new_mod($mod_name, ModType::Flag, b(true), "Config", vec![combat_tag()]));
        }
    };
}
simple_shrine!(buff_impenetrable_shrine, "Condition:ImpenetrableShrine");
simple_shrine!(buff_massive_shrine, "Condition:MassiveShrine");
simple_shrine!(buff_replenishing_shrine, "Condition:ReplenishingShrine");
simple_shrine!(buff_resistance_shrine, "Condition:ResistanceShrine");
simple_shrine!(buff_resonating_shrine, "Condition:ResonatingShrine");
simple_shrine!(buff_lesser_acceleration_shrine, "Condition:LesserAccelerationShrine");
simple_shrine!(buff_lesser_brutal_shrine, "Condition:LesserBrutalShrine");
simple_shrine!(buff_lesser_impenetrable_shrine, "Condition:LesserImpenetrableShrine");
simple_shrine!(buff_lesser_massive_shrine, "Condition:LesserMassiveShrine");
simple_shrine!(buff_lesser_replenishing_shrine, "Condition:LesserReplenishingShrine");
simple_shrine!(buff_lesser_resistance_shrine, "Condition:LesserResistanceShrine");
simple_shrine!(buff_blood_shrine_of_rats, "Condition:BloodShrineOfRats");
simple_shrine!(buff_blood_shrine_of_locusts, "Condition:BloodShrineOfLocusts");
simple_shrine!(buff_blood_shrine_of_toads, "Condition:BloodShrineOfToads");
simple_shrine!(buff_blood_shrine_of_crows, "Condition:BloodShrineOfCrows");
simple_shrine!(buff_blood_shrine_of_bats, "Condition:BloodShrineOfBats");

fn skill_fork_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("ForkedCount", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn skill_chain_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("ChainCount", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn skill_pierce_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("PiercedCount", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_at_close_range(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:AtCloseRange", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn enemy_multiplier_enemy_presence_seconds(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:EnemyPresenceSeconds", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_enemy_moving(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Moving", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_full_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:FullLife", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_low_life(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:LowLife", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_cursed(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Cursed", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    // The manual tick is the user's assertion, so it also counts as Hexed (Hexblast's hexed MORE needs it).
    // The game-data fixes in this crate run unless POM_STRICT_COMPAT=1, which restores the upstream behaviour.
    if !pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        ctx.enemy.push(new_mod("Condition:Hexed", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    }
}
fn condition_enemy_stunned(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Stunned", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_bleeding(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Bleeding", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn override_bleed_stack_potential(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("BleedStackPotentialOverride", ModType::Override, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_single_bleed(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:SingleBleed", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn multiplier_rupture_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:RuptureStack", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_enemy_poisoned(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Poisoned", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn multiplier_poison_on_enemy(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:PoisonStack", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_non_poisoned_only(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Condition:NonPoisonedOnly", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn multiplier_curse_expired_on_enemy(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:CurseExpired", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn multiplier_curse_duration_expired_on_enemy(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:CurseDurationExpired", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn multiplier_withered_stack_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:WitheredStack", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn multiplier_corrosion_stack_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:CorrosionStack", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
    let corrosion_tag = tag("Multiplier", &[("var", s("CorrosionStack"))]);
    let can_corrode = tag("ActorCondition", &[("actor", s("enemy")), ("var", s("CanCorrode"))]);
    ctx.enemy.push(new_mod("Armour", ModType::Base, n(-5000.0), "Corrosion", vec![corrosion_tag.clone(), can_corrode.clone()]));
    ctx.enemy.push(new_mod("Evasion", ModType::Base, n(-1000.0), "Corrosion", vec![corrosion_tag, can_corrode]));
}
fn multiplier_ensnared_stack_count(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:EnsnareStackCount", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
    // Game 3.25.0: "Ensnared Enemies no longer always count as moving". Upstream still forces Condition:Moving.
    if pom_engine::env::var("POM_STRICT_COMPAT").is_ok_and(|v| v == "1") {
        ctx.enemy.push(new_mod(
            "Condition:Moving", ModType::Flag, b(true), "Config",
            vec![tag("MultiplierThreshold", &[("actor", s("enemy")), ("var", s("EnsnareStackCount")), ("threshold", n(1.0))])],
        ));
    }
}
fn condition_enemy_maimed(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Maimed", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_hindered(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Hindered", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_excommunicated(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "Condition:Excommunicated", ModType::Flag, b(true), "Config",
        vec![tag("ActorCondition", &[("actor", s("enemy")), ("var", s("CanExcommunicate"))])],
    ));
}
fn condition_enemy_blinded(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Blinded", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn override_buff_blinded(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod(
        "BlindEffect", ModType::Override, n(val.as_f64()), "Config",
        vec![tag("GlobalEffect", &[("effectType", s("Buff"))])],
    ));
}
fn condition_enemy_taunted(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Taunted", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_debilitated(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Debilitated", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_pacified(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Pacified", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_burning(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Burning", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_ignited(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Ignited", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn override_ignite_stack_potential(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("IgniteStackPotentialOverride", ModType::Override, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_enemy_scorched(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Scorched", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:ScorchedConfig", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_scorched_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.enemy.push(new_mod("ScorchVal", ModType::Base, n(v), "Config", vec![tag("Condition", &[("var", s("ScorchedConfig"))])]));
    ctx.enemy.push(new_mod(
        "DesiredScorchVal", ModType::Base, n(v), "Scorch",
        vec![tag("Condition", &[("var", s("ScorchedConfig")), ("neg", b(true))])],
    ));
}
fn scorch_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:ScorchStacks", ModType::Base, n(val.as_f64()), "Config", vec![effective_tag()]));
}
fn condition_enemy_on_scorched_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Scorched", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:OnScorchedGround", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_chilled(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Chilled", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:ChilledConfig", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn multiplier_chilled_by_you_seconds(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Multiplier:ChilledByYouSeconds", ModType::Base, n(val.as_f64()), "Config", vec![combat_tag()]));
    ctx.enemy.push(new_mod("Condition:ChilledByYou", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn condition_enemy_chilled_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.enemy.push(new_mod("ChillVal", ModType::Base, n(v), "Chill", vec![tag("Condition", &[("var", s("ChilledConfig"))])]));
    ctx.enemy.push(new_mod(
        "DesiredChillVal", ModType::Base, n(v), "Chill",
        vec![tag("Condition", &[("var", s("ChilledConfig")), ("neg", b(true))])],
    ));
}
fn condition_enemy_chilled_by_your_hits(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("Condition:Chilled", ModType::Flag, b(true), "Config", vec![effective_tag()]));
    ctx.enemy.push(new_mod("Condition:ChilledByYourHits", ModType::Flag, b(true), "Config", vec![effective_tag()]));
}
fn hoarfrost_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.enemy.push(new_mod("HoarfrostFreezeDuration", ModType::Inc, n(val.as_f64() * 20.0), "Config", vec![effective_tag()]));
}
fn multiplier_barnacle_stacks(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64().min(10.0);
    ctx.enemy.push(new_mod("Multiplier:BarnacleStack", ModType::Base, n(v), "Config", vec![effective_tag()]));
    let barnacle_tag = tag("Multiplier", &[("var", s("BarnacleStack"))]);
    ctx.enemy.push(new_mod("SelfFreezeDuration", ModType::Inc, n(5.0), "Config", vec![barnacle_tag.clone(), effective_tag()]));
    ctx.enemy.push(new_mod("SelfChillDuration", ModType::Inc, n(5.0), "Config", vec![barnacle_tag.clone(), effective_tag()]));
    ctx.enemy.push(new_mod("PhysicalDamageConvertToCold", ModType::Base, n(5.0), "Config", vec![barnacle_tag, effective_tag()]));
}

pub fn register(map: &mut HandlerMap) {
    map.insert("buffImpenetrableShrine", buff_impenetrable_shrine);
    map.insert("buffMassiveShrine", buff_massive_shrine);
    map.insert("buffReplenishingShrine", buff_replenishing_shrine);
    map.insert("buffResistanceShrine", buff_resistance_shrine);
    map.insert("buffResonatingShrine", buff_resonating_shrine);
    map.insert("buffLesserAccelerationShrine", buff_lesser_acceleration_shrine);
    map.insert("buffLesserBrutalShrine", buff_lesser_brutal_shrine);
    map.insert("buffLesserImpenetrableShrine", buff_lesser_impenetrable_shrine);
    map.insert("buffLesserMassiveShrine", buff_lesser_massive_shrine);
    map.insert("buffLesserReplenishingShrine", buff_lesser_replenishing_shrine);
    map.insert("buffLesserResistanceShrine", buff_lesser_resistance_shrine);
    map.insert("buffBloodShrineOfRats", buff_blood_shrine_of_rats);
    map.insert("buffBloodShrineOfLocusts", buff_blood_shrine_of_locusts);
    map.insert("buffBloodShrineOfToads", buff_blood_shrine_of_toads);
    map.insert("buffBloodShrineOfCrows", buff_blood_shrine_of_crows);
    map.insert("buffBloodShrineOfBats", buff_blood_shrine_of_bats);
    map.insert("skillForkCount", skill_fork_count);
    map.insert("skillChainCount", skill_chain_count);
    map.insert("skillPierceCount", skill_pierce_count);
    map.insert("conditionAtCloseRange", condition_at_close_range);
    map.insert("enemyMultiplierEnemyPresenceSeconds", enemy_multiplier_enemy_presence_seconds);
    map.insert("conditionEnemyMoving", condition_enemy_moving);
    map.insert("conditionEnemyFullLife", condition_enemy_full_life);
    map.insert("conditionEnemyLowLife", condition_enemy_low_life);
    map.insert("conditionEnemyCursed", condition_enemy_cursed);
    map.insert("conditionEnemyStunned", condition_enemy_stunned);
    map.insert("conditionEnemyBleeding", condition_enemy_bleeding);
    map.insert("overrideBleedStackPotential", override_bleed_stack_potential);
    map.insert("conditionSingleBleed", condition_single_bleed);
    map.insert("multiplierRuptureStacks", multiplier_rupture_stacks);
    map.insert("conditionEnemyPoisoned", condition_enemy_poisoned);
    map.insert("multiplierPoisonOnEnemy", multiplier_poison_on_enemy);
    map.insert("conditionNonPoisonedOnly", condition_non_poisoned_only);
    map.insert("multiplierCurseExpiredOnEnemy", multiplier_curse_expired_on_enemy);
    map.insert("multiplierCurseDurationExpiredOnEnemy", multiplier_curse_duration_expired_on_enemy);
    map.insert("multiplierWitheredStackCount", multiplier_withered_stack_count);
    map.insert("multiplierCorrosionStackCount", multiplier_corrosion_stack_count);
    map.insert("multiplierEnsnaredStackCount", multiplier_ensnared_stack_count);
    map.insert("conditionEnemyMaimed", condition_enemy_maimed);
    map.insert("conditionEnemyHindered", condition_enemy_hindered);
    map.insert("conditionEnemyExcommunicated", condition_enemy_excommunicated);
    map.insert("conditionEnemyBlinded", condition_enemy_blinded);
    map.insert("overrideBuffBlinded", override_buff_blinded);
    map.insert("conditionEnemyTaunted", condition_enemy_taunted);
    map.insert("conditionEnemyDebilitated", condition_enemy_debilitated);
    map.insert("conditionEnemyPacified", condition_enemy_pacified);
    map.insert("conditionEnemyBurning", condition_enemy_burning);
    map.insert("conditionEnemyIgnited", condition_enemy_ignited);
    map.insert("overrideIgniteStackPotential", override_ignite_stack_potential);
    map.insert("conditionEnemyScorched", condition_enemy_scorched);
    map.insert("conditionScorchedEffect", condition_scorched_effect);
    map.insert("ScorchStacks", scorch_stacks);
    map.insert("conditionEnemyOnScorchedGround", condition_enemy_on_scorched_ground);
    map.insert("conditionEnemyChilled", condition_enemy_chilled);
    map.insert("multiplierChilledByYouSeconds", multiplier_chilled_by_you_seconds);
    map.insert("conditionEnemyChilledEffect", condition_enemy_chilled_effect);
    map.insert("conditionEnemyChilledByYourHits", condition_enemy_chilled_by_your_hits);
    map.insert("HoarfrostStacks", hoarfrost_stacks);
    map.insert("multiplierBarnacleStacks", multiplier_barnacle_stacks);
}

#[cfg(test)]
mod tests {
    use super::*;
    use pom_engine::fxhash::HashMap;

    // Tests run with POM_STRICT_COMPAT unset and assert the fixed behaviour (the manual "enemy is cursed" tick also counts as Hexed).
    #[test]
    fn enemy_cursed_tick_also_sets_hexed() {
        let input = HashMap::default();
        let mut ctx = ConfigCtx::new(&input, HashMap::default(), pom_engine::data::shared(), 100);
        condition_enemy_cursed(&OwnedOptionValue::Bool(true), &mut ctx);
        for c in ["Condition:Cursed", "Condition:Hexed"] {
            assert!(ctx.enemy.iter().any(|m| m.name.as_str() == c), "{c} not pushed");
        }
    }

    #[test]
    fn ensnare_stacks_do_not_force_enemy_moving() {
        let input = HashMap::default();
        let mut ctx = ConfigCtx::new(&input, HashMap::default(), pom_engine::data::shared(), 100);
        multiplier_ensnared_stack_count(&OwnedOptionValue::Num(1.0), &mut ctx);
        assert!(ctx.mods.iter().any(|m| m.name.as_str() == "Multiplier:EnsnareStackCount"), "stack multiplier kept");
        assert!(!ctx.enemy.iter().any(|m| m.name.as_str() == "Condition:Moving"), "Condition:Moving pushed");
    }
}
