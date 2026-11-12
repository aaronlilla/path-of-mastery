//! Fire Trap of Blasting has trap_%_chance_to_trigger_twice = 50 ("Chance for Trap to Trigger an additional time"): +50% hit DPS per trap.
use pom_pipeline::session::Session;

#[test]
fn blasting_gem_has_trigger_twice_mod() {
    let ge = pom_skills::data::granted_effect_by_skill_id("FireTrapAltX").expect("FireTrapAltX");
    let mods = pom_skills::modlist::merge_skill_instance_mods(ge, 20.0, 0.0, None, &[], false);
    let m = mods.iter().find(|m| m.name.as_str() == "TrapTriggerTwiceChance").expect("no TrapTriggerTwiceChance mod");
    assert_eq!(m.value.num(), Some(50.0));
}

#[test]
fn blasting_trap_dps_is_one_and_a_half_hits() {
    let xml = std::fs::read_to_string(format!("{}/testdata/eb-sword.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<Skill ").unwrap(), xml.find("</Skills>").unwrap());
    let skill = r#"<Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1"><Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="FireTrapAltX" qualityId="Default" gemId="Metadata/Items/Gems/SkillGemFireTrapAltX" quality="0" enabled="true" count="1" nameSpec="Fire Trap of Blasting"/></Skill>"#;
    let xml = format!("{}{}{}", &xml[..i], skill, &xml[j..]).replace("<Config>", "<Config><CustomModifierBlock title=\"t\" enabled=\"true\">100% chance to Ignite</CustomModifierBlock>");
    let mut s = Session::new(xml, pom_calc::data::game_data());
    let p = s.calc().unwrap().stats["player"].clone();
    let f = |k: &str| p[k].as_f64().unwrap();
    let rate = p["HitSpeed"].as_f64().unwrap_or_else(|| f("Speed"));
    // Run with POM_STRICT_COMPAT unset: one hit plus a 50% chance of a second. (upstream: one.)
    assert!((f("TotalDPS") - 1.5 * f("AverageDamage") * rate).abs() < 1e-6 * f("TotalDPS"), "TotalDPS is not 1.5 hits per trap");
    // The extra trigger is hit DPS only: ignite stacks (which use dpsMultiplier) stay at one hit per trap.
    assert!((f("IgniteStackPotential") - f("HitChance") / 100.0 * f("IgniteChance") / 100.0 * rate * f("IgniteDuration")).abs() < 1e-6, "ignite stacks scaled by the second trigger");
}
