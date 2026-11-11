//! Vaal Double Strike performs two strikes (base_skill_number_of_additional_hits = 1, as Double Strike), so dpsMultiplier is 2.
use pom_pipeline::session::Session;

fn calc() -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/eb-sword.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<Skill ").unwrap(), xml.find("</Skills>").unwrap());
    let skill = r#"<Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1"><Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="VaalDoubleStrike" qualityId="Default" gemId="Metadata/Items/Gems/SkillGemVaalDoubleStrike" quality="0" enabled="true" count="1" nameSpec="Vaal Double Strike"/></Skill>"#;
    let xml = format!("{}{}{}", &xml[..i], skill, &xml[j..]);
    let mut s = Session::new(xml, pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

#[test]
fn vaal_double_strike_hits_twice() {
    let p = calc();
    let f = |k: &str| p[k].as_f64().unwrap();
    // Run with POM_STRICT_COMPAT unset: two strikes per use. (upstream: one.)
    assert!((f("TotalDPS") - 2.0 * f("AverageDamage") * f("Speed")).abs() < 1e-6 * f("TotalDPS"), "TotalDPS is not 2 strikes per use");
}
