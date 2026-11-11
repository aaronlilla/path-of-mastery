use crate::ctx::ConfigCtx;
use crate::helpers::{b, mod_no_source_minion, n, new_mod, s, tag};
use crate::types::OwnedOptionValue;
use crate::HandlerMap;
use pom_engine::modifier::ModType;

fn combat() -> pom_engine::modifier::Tag {
    tag("Condition", &[("var", s("Combat"))])
}
fn effective() -> pom_engine::modifier::Tag {
    tag("Condition", &[("var", s("Effective"))])
}
fn flag_combat(ctx: &mut ConfigCtx, name: &str) {
    ctx.mods.push(new_mod(name, ModType::Flag, b(true), "Config", vec![combat()]));
}

fn condition_have_totem(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HaveTotem");
}
fn condition_summoned_totem_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SummonedTotemRecently");
}
fn totems_summoned(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod("TotemsSummoned", ModType::Override, n(v), "Config", vec![combat()]));
    ctx.mods.push(new_mod("Condition:HaveTotem", ModType::Flag, b(v >= 1.0), "Config", vec![combat()]));
}
fn condition_summoned_golem_in_past8_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SummonedGolemInPast8Sec");
}
fn condition_summoned_golem_in_past10_sec(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SummonedGolemInPast10Sec");
}
fn multiplier_nearby_ally(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:NearbyAlly", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_nearby_corpse(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:NearbyCorpse", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_summoned_minion(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:SummonedMinion", ModType::Override, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_non_vaal_summoned_minion(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:NonVaalSummonedMinion", ModType::Override, n(val.as_f64()), "Config", vec![combat()]));
}
fn multiplier_permanent_minion(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:PermanentMinion", ModType::Override, n(val.as_f64()), "Config", vec![combat()]));
}
fn condition_on_consecrated_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnConsecratedGround");
    let inner = new_mod("Condition:OnConsecratedGround", ModType::Flag, b(true), "Config", vec![combat()]);
    ctx.mods.push(mod_no_source_minion(inner));
}
fn condition_on_profane_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnProfaneGround");
}
fn minion_condition_on_profane_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let inner = new_mod("Condition:OnProfaneGround", ModType::Flag, b(true), "Config", vec![combat()]);
    ctx.mods.push(mod_no_source_minion(inner));
}
fn condition_on_brine_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnBrineGround");
    let brine = || tag("Condition", &[("var", s("OnBrineGround"))]);
    ctx.mods.push(new_mod("PhysicalDamageGainAsCold", ModType::Base, n(10.0), "Config", vec![brine()]));
    ctx.mods.push(new_mod("PhysicalDamageGainAsLightning", ModType::Base, n(10.0), "Config", vec![brine()]));
}
fn minion_condition_on_brine_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let brine = || tag("Condition", &[("var", s("OnBrineGround"))]);
    let inner1 = new_mod("Condition:OnBrineGround", ModType::Flag, b(true), "Config", vec![combat()]);
    ctx.mods.push(mod_no_source_minion(inner1));
    let inner2 = new_mod("PhysicalDamageGainAsCold", ModType::Base, n(10.0), "Config", vec![brine()]);
    ctx.mods.push(mod_no_source_minion(inner2));
    let inner3 = new_mod("PhysicalDamageGainAsLightning", ModType::Base, n(10.0), "Config", vec![brine()]);
    ctx.mods.push(mod_no_source_minion(inner3));
}
fn condition_on_caustic_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnCausticGround");
}
fn condition_on_fungal_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnFungalGround");
}
fn condition_on_burning_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnBurningGround");
    flag_combat(ctx, "Condition:Burning");
}
fn condition_on_chilled_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnChilledGround");
    flag_combat(ctx, "Condition:Chilled");
}
fn condition_on_shocked_ground(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:OnShockedGround");
    flag_combat(ctx, "Condition:Shocked");
}
fn condition_blinded(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Blinded");
}
fn condition_burning(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Burning");
}
fn condition_ignited(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Ignited");
}
fn condition_scorched(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Scorched");
}
fn condition_chilled(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Chilled");
}
fn condition_chilled_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("ChillVal", ModType::Override, n(val.as_f64()), "Chill", vec![tag("Condition", &[("var", s("Chilled"))])]));
}
fn condition_frozen(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Frozen");
}
fn condition_brittle(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Brittle");
}
fn condition_shocked(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Shocked");
}
fn condition_player_shock_effect(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("ShockVal", ModType::Override, n(val.as_f64()), "Shock", vec![tag("Condition", &[("var", s("Shocked"))])]));
}
fn condition_sapped(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Sapped");
}
fn condition_bleeding(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Bleeding");
}
fn condition_poisoned(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Poisoned");
}
fn condition_can_be_curse_immune(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod(
        "AvoidCurse",
        ModType::Base,
        n(100.0),
        "Config",
        vec![combat(), tag("GlobalEffect", &[("effectType", s("Global")), ("unscalable", b(true))])],
    ));
}
fn multiplier_poison_on_self(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:PoisonStack", ModType::Base, n(val.as_f64()), "Config", vec![effective()]));
}
fn multiplier_withered_stack_count_self(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:WitheredStack", ModType::Base, n(val.as_f64()), "Config", vec![effective()]));
}
fn multiplier_nearby_enemies(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod("Multiplier:NearbyEnemies", ModType::Base, n(v), "Config", vec![combat()]));
    ctx.mods.push(new_mod("Condition:OnlyOneNearbyEnemy", ModType::Flag, b(v == 1.0), "Config", vec![combat()]));
}
fn multiplier_nearby_rare_or_unique_enemies(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod("Multiplier:NearbyRareOrUniqueEnemies", ModType::Base, n(v), "Config", vec![combat()]));
    ctx.mods.push(new_mod("Multiplier:NearbyEnemies", ModType::Base, n(v), "Config", vec![combat()]));
    ctx.mods.push(new_mod("Condition:AtMostOneNearbyRareOrUniqueEnemy", ModType::Flag, b(v <= 1.0), "Config", vec![combat()]));
    ctx.enemy.push(new_mod("Condition:NearbyRareOrUniqueEnemy", ModType::Flag, b(v >= 1.0), "Config", vec![combat()]));
}
fn condition_hit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HitRecently");
}
fn condition_hit_spell_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HitSpellRecently");
    flag_combat(ctx, "Condition:HitRecently");
}
fn condition_crit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:CritRecently");
    flag_combat(ctx, "Condition:SkillCritRecently");
}
fn condition_skill_crit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:SkillCritRecently");
}
fn condition_crit_with_herald_skill_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:CritWithHeraldSkillRecently");
}
fn multiplier_crit_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    let v = val.as_f64();
    ctx.mods.push(new_mod("Multiplier:CritRecently", ModType::Base, n(v), "Config", vec![combat()]));
    ctx.mods.push(new_mod("Condition:SkillCritRecently", ModType::Flag, b(1.0 <= v), "Config", vec![combat()]));
}
fn lost_non_vaal_buff_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:LostNonVaalBuffRecently");
}
fn condition_non_crit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:NonCritRecently");
}
fn condition_channelling(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:Channelling");
}
fn multiplier_channelling(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:ChannellingTime", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:Channelling");
}
fn condition_hit_recently_with_weapon(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:HitRecentlyWithWeapon");
}
fn condition_killed_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:KilledRecently");
}
fn multiplier_killed_recently(val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    ctx.mods.push(new_mod("Multiplier:EnemyKilledRecently", ModType::Base, n(val.as_f64()), "Config", vec![combat()]));
    flag_combat(ctx, "Condition:KilledRecently");
}
fn condition_killed_last3_seconds(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:KilledLast3Seconds");
}
fn condition_killed_poisoned_last2_seconds(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:KilledPoisonedLast2Seconds");
}
fn condition_killed_taunted_enemy_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:KilledTauntedEnemyRecently");
}
fn condition_totems_not_summoned_in_past_two_seconds(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:NoSummonedTotemsInPastTwoSeconds");
}
fn condition_totems_killed_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:TotemsKilledRecently");
}
fn condition_totems_hit_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:TotemsHitRecently");
}
fn condition_totems_hit_spell_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:TotemsHitSpellRecently");
    flag_combat(ctx, "Condition:TotemsHitRecently");
}
fn condition_used_brand_recently(_val: &OwnedOptionValue, ctx: &mut ConfigCtx) {
    flag_combat(ctx, "Condition:UsedBrandRecently");
}

pub fn register(map: &mut HandlerMap) {
    map.insert("conditionHaveTotem", condition_have_totem);
    map.insert("conditionSummonedTotemRecently", condition_summoned_totem_recently);
    map.insert("TotemsSummoned", totems_summoned);
    map.insert("conditionSummonedGolemInPast8Sec", condition_summoned_golem_in_past8_sec);
    map.insert("conditionSummonedGolemInPast10Sec", condition_summoned_golem_in_past10_sec);
    map.insert("multiplierNearbyAlly", multiplier_nearby_ally);
    map.insert("multiplierNearbyCorpse", multiplier_nearby_corpse);
    map.insert("multiplierSummonedMinion", multiplier_summoned_minion);
    map.insert("multiplierNonVaalSummonedMinion", multiplier_non_vaal_summoned_minion);
    map.insert("multiplierPermanentMinion", multiplier_permanent_minion);
    map.insert("conditionOnConsecratedGround", condition_on_consecrated_ground);
    map.insert("conditionOnProfaneGround", condition_on_profane_ground);
    map.insert("minionConditionOnProfaneGround", minion_condition_on_profane_ground);
    map.insert("conditionOnBrineGround", condition_on_brine_ground);
    map.insert("minionConditionOnBrineGround", minion_condition_on_brine_ground);
    map.insert("conditionOnCausticGround", condition_on_caustic_ground);
    map.insert("conditionOnFungalGround", condition_on_fungal_ground);
    map.insert("conditionOnBurningGround", condition_on_burning_ground);
    map.insert("conditionOnChilledGround", condition_on_chilled_ground);
    map.insert("conditionOnShockedGround", condition_on_shocked_ground);
    map.insert("conditionBlinded", condition_blinded);
    map.insert("conditionBurning", condition_burning);
    map.insert("conditionIgnited", condition_ignited);
    map.insert("conditionScorched", condition_scorched);
    map.insert("conditionChilled", condition_chilled);
    map.insert("conditionChilledEffect", condition_chilled_effect);
    map.insert("conditionFrozen", condition_frozen);
    map.insert("conditionBrittle", condition_brittle);
    map.insert("conditionShocked", condition_shocked);
    map.insert("conditionPlayerShockEffect", condition_player_shock_effect);
    map.insert("conditionSapped", condition_sapped);
    map.insert("conditionBleeding", condition_bleeding);
    map.insert("conditionPoisoned", condition_poisoned);
    map.insert("conditionCanBeCurseImmune", condition_can_be_curse_immune);
    map.insert("multiplierPoisonOnSelf", multiplier_poison_on_self);
    map.insert("multiplierWitheredStackCountSelf", multiplier_withered_stack_count_self);
    map.insert("multiplierNearbyEnemies", multiplier_nearby_enemies);
    map.insert("multiplierNearbyRareOrUniqueEnemies", multiplier_nearby_rare_or_unique_enemies);
    map.insert("conditionHitRecently", condition_hit_recently);
    map.insert("conditionHitSpellRecently", condition_hit_spell_recently);
    map.insert("conditionCritRecently", condition_crit_recently);
    map.insert("conditionSkillCritRecently", condition_skill_crit_recently);
    map.insert("conditionCritWithHeraldSkillRecently", condition_crit_with_herald_skill_recently);
    map.insert("multiplierCritRecently", multiplier_crit_recently);
    map.insert("LostNonVaalBuffRecently", lost_non_vaal_buff_recently);
    map.insert("conditionNonCritRecently", condition_non_crit_recently);
    map.insert("conditionChannelling", condition_channelling);
    map.insert("multiplierChannelling", multiplier_channelling);
    map.insert("conditionHitRecentlyWithWeapon", condition_hit_recently_with_weapon);
    map.insert("conditionKilledRecently", condition_killed_recently);
    map.insert("multiplierKilledRecently", multiplier_killed_recently);
    map.insert("conditionKilledLast3Seconds", condition_killed_last3_seconds);
    map.insert("conditionKilledPoisonedLast2Seconds", condition_killed_poisoned_last2_seconds);
    map.insert("conditionKilledTauntedEnemyRecently", condition_killed_taunted_enemy_recently);
    map.insert("conditionTotemsNotSummonedInPastTwoSeconds", condition_totems_not_summoned_in_past_two_seconds);
    map.insert("conditionTotemsKilledRecently", condition_totems_killed_recently);
    map.insert("conditionTotemsHitRecently", condition_totems_hit_recently);
    map.insert("conditionTotemsHitSpellRecently", condition_totems_hit_spell_recently);
    map.insert("conditionUsedBrandRecently", condition_used_brand_recently);
}
