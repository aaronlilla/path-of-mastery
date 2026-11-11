//! Lightning Tendrils releases a Stronger Pulse every 3rd pulse (lightning_tendrils_channelled_larger_pulse_interval = 3),
//! so Normal pulses are 2/3 of pulses (DPS MORE -100/3 on part 2) and Stronger 1/3 (-200/3 on part 3). Upstream has the two swapped.
use pom_engine::value::Value;

fn part_value(part: f64) -> f64 {
    let ge = pom_skills::data::granted_effect_by_skill_id("LightningTendrils").expect("LightningTendrils");
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    let m = mods
        .iter()
        .find(|m| {
            m.name.as_str() == "DPS"
                && m.ty == pom_engine::modifier::ModType::More
                && m.tags.iter().any(|t| t.kind.as_str() == "SkillPart" && matches!(t.get(pom_engine::sym!("skillPart")), Value::Num(n) if *n == part))
        })
        .unwrap_or_else(|| panic!("no DPS MORE on skill part {part}"));
    match m.value {
        Value::Num(n) => n,
        ref other => panic!("not numeric: {other:?}"),
    }
}

// The always-crit stat sits past the 3 values in each level row, so its value defaulted to 1 and the CritChance
// OVERRIDE (base 100) came out 101, which crit.rs does not treat as a guaranteed crit (it checks == 100).
#[test]
fn tendrils_always_crit_override_is_100() {
    for id in ["LightningTendrils", "LightningTendrilsAltX"] {
        let ge = pom_skills::data::granted_effect_by_skill_id(id).unwrap_or_else(|| panic!("{id}"));
        let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
        let crit: Vec<&pom_engine::modifier::Mod> = mods.iter().filter(|m| m.name.as_str() == "CritChance" && m.ty == pom_engine::modifier::ModType::Override).collect();
        assert!(!crit.is_empty(), "{id}: no CritChance override");
        for m in crit {
            assert!(matches!(m.value, Value::Num(n) if n == 100.0), "{id}: {:?}", m.value);
        }
    }
}

#[test]
fn tendrils_normal_pulse_is_two_thirds() {
    // Run with POM_STRICT_COMPAT unset. Same as upstream's own Tendrils of Eccentricity code (act_int.lua:12646/12648).
    assert!((part_value(2.0) - (-100.0 / 3.0)).abs() < 1e-9, "part 2: {}", part_value(2.0));
    assert!((part_value(3.0) - (-200.0 / 3.0)).abs() < 1e-9, "part 3: {}", part_value(3.0));
}
