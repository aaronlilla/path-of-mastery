//! Ensnaring Arrow quality skill_buff_effect_+% (1 per 1%, scope debuff_skill_stat_descriptions) is "increased Debuff Effect" in game; upstream's
//! statMap makes it BuffEffect INC, which the Ensnare debuff ignores (it scales by DebuffEffect only). 20% quality = 20% more Ensnare effect.
use pom_engine::modifier::ModType;
use pom_engine::value::Value;

#[test]
fn ensnaring_arrow_quality_is_debuff_effect() {
    // Run with POM_STRICT_COMPAT unset. (upstream: BuffEffect INC 20, dropped by the debuff.)
    let ge = pom_skills::data::granted_effect_by_skill_id("EnsnaringArrow").expect("EnsnaringArrow");
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 20.0, None, &[], false);
    let m = mods.iter().find(|m| m.name.as_str() == "DebuffEffect").expect("DebuffEffect mod");
    assert_eq!(m.ty, ModType::Inc);
    match m.value {
        Value::Num(n) => assert!((n - 20.0).abs() < 1e-9, "{n}"),
        ref other => panic!("not numeric: {other:?}"),
    }
    assert!(!mods.iter().any(|m| m.name.as_str() == "BuffEffect"), "BuffEffect mod left");
}
