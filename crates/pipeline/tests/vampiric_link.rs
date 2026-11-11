//! Vampiric Link's remora_link_grants_maximum_life_leech_rate_%_per_minute is "+X% to Maximum total Life Recovery per second from Leech" (same
//! wording as the base 20% cap, which is BASE); upstream's statMap makes it INC. Level 20 value is 348 per minute = 5.8 per second.
use pom_engine::modifier::ModType;
use pom_engine::value::Value;

#[test]
fn vampiric_link_cap_is_added_points() {
    // Run with POM_STRICT_COMPAT unset. (upstream: INC 5.8, cap 20 x 1.058 = 21.16.)
    let ge = pom_skills::data::granted_effect_by_skill_id("VampiricLink").expect("VampiricLink");
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    let m = mods.iter().find(|m| m.name.as_str() == "MaxLifeLeechRate").expect("MaxLifeLeechRate mod");
    assert_eq!(m.ty, ModType::Base);
    match m.value {
        Value::Num(n) => assert!((n - 348.0 / 60.0).abs() < 1e-9, "{n}"),
        ref other => panic!("not numeric: {other:?}"),
    }
}
