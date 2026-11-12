//! Reave and Reave of Refraction have display_reave_base_maximum_stacks = 4 ("4 Maximum Stages"); upstream's baseMod says 8.
//! Quality adds reave_additional_max_stacks (0.1 per point, truncated) on top.
use pom_engine::value::Value;

fn max_stages(id: &str, name: &str, quality: f64) -> f64 {
    let ge = pom_skills::data::granted_effect_by_skill_id(id).unwrap_or_else(|| panic!("{id}"));
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, quality, None, &[], false);
    mods.iter()
        .filter(|m| m.name.as_str() == name && m.ty == pom_engine::modifier::ModType::Base)
        .map(|m| match m.value {
            Value::Num(n) => n,
            ref other => panic!("not numeric: {other:?}"),
        })
        .sum()
}

#[test]
fn reave_base_max_stages_is_4() {
    // Run with POM_STRICT_COMPAT unset. (upstream: 8 at quality 0, 10 at quality 20.)
    for (id, name) in [("Reave", "Multiplier:ReaveMaxStages"), ("ReaveAltX", "Multiplier:ReaveofRefractionMaxStages")] {
        assert_eq!(max_stages(id, name, 0.0), 4.0, "{id} quality 0");
        assert_eq!(max_stages(id, name, 20.0), 6.0, "{id} quality 20");
    }
}

#[test]
fn vaal_reave_uses_its_own_stage_names() {
    // CalcActiveSkill reads Multiplier:<gem name without spaces>MaxStages = VaalReaveMaxStages; upstream's Vaal Reave data says Reave.
    // Run with POM_STRICT_COMPAT unset. baseMod 4 + reave_additional_max_stacks 4 = 8.
    let ge = pom_skills::data::granted_effect_by_skill_id("VaalReave").unwrap();
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    assert_eq!(max_stages("VaalReave", "Multiplier:VaalReaveMaxStages", 0.0), 8.0);
    assert!(!mods.iter().any(|m| m.name.as_str() == "Multiplier:ReaveMaxStages"));
    let stage_var = |m: &pom_engine::modifier::Mod| m.tags.iter().any(|t| t.kind.as_str() == "Multiplier" && matches!(t.get(pom_engine::sym!("var")), Value::Str(s) if &**s == "VaalReaveStage"));
    assert!(mods.iter().any(|m| m.name.as_str() == "AreaOfEffect" && m.ty == pom_engine::modifier::ModType::More && stage_var(m)));
}
