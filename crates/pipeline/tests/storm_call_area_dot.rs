//! Storm Call of Trarthus' boiling blood pool DoT stops when you leave the area, so it is Area damage (dotIsArea).
//! Upstream strips ModFlag.Area from the DoT without it. Run with POM_STRICT_COMPAT unset.
use pom_engine::modifier::ModType;
use pom_engine::value::Value;

#[test]
fn storm_call_trarthus_dot_is_area() {
    let ge = pom_skills::data::granted_effect_by_skill_id("StormCallAltX").expect("StormCallAltX");
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    let has = mods.iter().any(|m| {
        m.name.as_str() == "SkillData"
            && m.ty == ModType::List
            && match &m.value {
                Value::Map(kv) => {
                    kv.iter().any(|(k, v)| k.as_str() == "key" && matches!(v, Value::Str(s) if &**s == "dotIsArea"))
                        && kv.iter().any(|(k, v)| k.as_str() == "value" && matches!(v, Value::Bool(true)))
                }
                _ => false,
            }
    });
    assert!(has, "no SkillData dotIsArea=true mod");
}
