//! Hand-written baseMod SkillData radius (added last, CalcActiveSkill.lua:78) overrides the radius generated from the game-data stat and is stale.
//! Orb of Storms of Squalls: stat 38 (base 3.8 m), baseMod 28. Holy Sweep: level stat 24..28 (28 at level 20), baseMod 24 at every level.
//! Voltaxic Burst: 3.27.0 made the base radius 2.6 m (26), baseMod 22. Run with POM_STRICT_COMPAT unset.
use pom_engine::modifier::ModType;
use pom_engine::value::Value;

fn last_radius(skill_id: &str) -> f64 {
    let ge = pom_skills::data::granted_effect_by_skill_id(skill_id).expect(skill_id);
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    let m = mods
        .iter()
        .filter(|m| m.name.as_str() == "SkillData" && m.ty == ModType::List)
        .filter_map(|m| match &m.value {
            Value::Map(kv) if kv.iter().any(|(k, v)| k.as_str() == "key" && matches!(v, Value::Str(s) if &**s == "radius")) => {
                kv.iter().find(|(k, _)| k.as_str() == "value").and_then(|(_, v)| if let Value::Num(n) = v { Some(*n) } else { None })
            }
            _ => None,
        })
        .last();
    m.unwrap_or_else(|| panic!("{skill_id}: no radius SkillData mod"))
}

#[test]
fn stale_radius_basemods_follow_game_data() {
    assert_eq!(last_radius("OrbOfStormsAltX"), 38.0);
    assert_eq!(last_radius("Sweep"), 28.0);
    assert_eq!(last_radius("VoltaxicBurst"), 26.0);
}
