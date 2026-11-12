//! Boneshatter of Complex Trauma "more Damage per Trauma, up to 200%": the stack limit is min(10, 200 / per-trauma).
use pom_engine::value::Value;

fn limit(quality: f64) -> f64 {
    let ge = pom_skills::data::granted_effect_by_skill_id("BoneshatterAltX").expect("BoneshatterAltX");
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, quality, None, &[], false);
    let m = mods.iter().find(|m| m.name.as_str() == "Damage" && m.tags.iter().any(|t| t.kind.as_str() == "Multiplier")).expect("trauma Damage MORE");
    let t = m.tags.iter().find(|t| t.kind.as_str() == "Multiplier").unwrap();
    match t.get(pom_engine::sym!("limit")) {
        Value::Num(n) => *n,
        other => panic!("no numeric limit: {other:?}"),
    }
}

#[test]
fn trauma_more_is_capped_at_200() {
    // Run with POM_STRICT_COMPAT unset. Level 20: 15 per trauma at 0 quality, 25 at 40 quality.
    assert_eq!(limit(0.0), 10.0);
    assert_eq!(limit(40.0), 8.0);
}
