//! Spectral Shield Throw and Spectral Shield Throw of Shattering throw "a projectile which cannot pierce" (part 1 'Shield');
//! Upstream has no CannotPierce on them. Shield Trarthus (AltY) is the exception. Run with POM_STRICT_COMPAT unset.
use pom_engine::modifier::ModType;
use pom_engine::value::Value;

fn cannot_pierce_parts(id: &str) -> Vec<f64> {
    let ge = pom_skills::data::granted_effect_by_skill_id(id).expect(id);
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    mods.iter()
        .filter(|m| m.name.as_str() == "CannotPierce" && m.ty == ModType::Flag && matches!(m.value, Value::Bool(true)))
        .flat_map(|m| m.tags.iter().filter(|t| t.kind.as_str() == "SkillPart"))
        .filter_map(|t| if let Value::Num(n) = t.get(pom_engine::sym!("skillPart")) { Some(*n) } else { None })
        .collect()
}

#[test]
fn shield_throw_primary_cannot_pierce() {
    assert_eq!(cannot_pierce_parts("SpectralShieldThrow"), vec![1.0]);
    assert_eq!(cannot_pierce_parts("SpectralShieldThrowAltX"), vec![1.0]);
    assert!(cannot_pierce_parts("SpectralShieldThrowAltY").is_empty());
}
