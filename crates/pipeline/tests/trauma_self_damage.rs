//! Boneshatter of Complex Trauma self-damage is scaled by at most the reset count (lose_all_trauma_at_X_trauma = 10).
use pom_pipeline::self_hit::trauma_self_stacks;

#[test]
fn trauma_self_damage_stops_at_the_reset_count() {
    // Run with POM_STRICT_COMPAT unset.
    assert_eq!(trauma_self_stacks(30.0, 10.0), 10.0);
    assert_eq!(trauma_self_stacks(6.0, 10.0), 6.0);
    // No max stat (vanilla Boneshatter, Carnage): uncapped.
    assert_eq!(trauma_self_stacks(30.0, 0.0), 30.0);
}

#[test]
fn complex_trauma_carries_the_max_stat() {
    let ge = pom_skills::data::granted_effect_by_skill_id("BoneshatterAltX").expect("BoneshatterAltX");
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    let m = mods.iter().find(|m| m.name.as_str() == "Multiplier:TraumaStacksMax").expect("Multiplier:TraumaStacksMax");
    assert!(matches!(m.value, pom_engine::value::Value::Num(n) if n == 10.0), "{:?}", m.value);
}
