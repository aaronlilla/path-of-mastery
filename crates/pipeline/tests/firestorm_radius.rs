//! Vaal Firestorm "Impacts have 20% more Area of Effect" and Firestorm "First Impact has 100% more Area of Effect" are impact-radius
//! mods in game; upstream maps them to AreaOfEffectSecondary / plain AreaOfEffect, which feed the fall-area radius. Run with POM_STRICT_COMPAT unset.
use pom_engine::modifier::ModType;
use pom_engine::value::Value;

fn more(mods: &[pom_engine::modifier::Mod], name: &str) -> Vec<f64> {
    mods.iter().filter(|m| m.name.as_str() == name && m.ty == ModType::More).filter_map(|m| if let Value::Num(n) = m.value { Some(n) } else { None }).collect()
}

#[test]
fn firestorm_area_goes_to_impact_radius() {
    let vaal = pom_skills::data::granted_effect_by_skill_id("VaalFirestorm").expect("VaalFirestorm");
    let mods = pom_skills::modlist::merge_skill_instance_mods(vaal, 20.0, 0.0, None, &[], false);
    assert_eq!(more(&mods, "AreaOfEffectPrimary"), vec![20.0]);
    assert!(more(&mods, "AreaOfEffectSecondary").is_empty());

    let fs = pom_skills::data::granted_effect_by_skill_id("Firestorm").expect("Firestorm");
    let mods = pom_skills::modlist::merge_skill_instance_mods(fs, 20.0, 0.0, None, &[], false);
    let primary: Vec<_> = mods.iter().filter(|m| m.name.as_str() == "AreaOfEffectPrimary" && m.ty == ModType::More).collect();
    assert_eq!(primary.len(), 1);
    assert!(matches!(primary[0].value, Value::Num(n) if n == 100.0));
    assert!(primary[0].tags.iter().any(|t| t.kind.as_str() == "SkillPart"));
    assert!(more(&mods, "AreaOfEffect").is_empty());
}
