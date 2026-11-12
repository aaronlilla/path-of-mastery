//! Manabond's missing-mana lightning is base damage (BonusMin/Max), not added damage scaled by the gem's damage effectiveness.
use pom_pipeline::edit::ConfigValue;
use pom_pipeline::session::Session;

fn calc(missing_pct: f64) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<SkillSet").unwrap(), xml.find("</SkillSet>").unwrap());
    let set = r#"<SkillSet id="1"><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1"><Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="Manabond" qualityId="Default" gemId="Metadata/Items/Gems/SkillGemManabond" quality="0" enabled="true" count="1" nameSpec="Manabond"/></Skill>"#;
    let xml = format!("{}{}{}", &xml[..i], set, &xml[j..]).replace("CUSTOM_MODS", "");
    let mut s = Session::new(xml, pom_calc::data::game_data());
    s.set_config("manabondMissingUnreservedManaPercentage", Some(ConfigValue::Num(missing_pct))).unwrap().stats["player"].clone()
}

#[test]
fn manabond_missing_mana_is_base_damage() {
    let (none, all) = (calc(50.0), calc(100.0));
    let max = |v: &serde_json::Value| v["LightningMaxBase"].as_f64().unwrap();
    let mana = all["ManaUnreserved"].as_f64().unwrap();
    let gained = max(&all) - max(&none);
    // Level 20 Manabond: 44% of the missing unreserved mana, added to the base unscaled (not x1.6 effectiveness).
    let gain = |p: f64| ((44.0 / 100.0) * (p / 100.0) * mana).floor();
    let want = gain(100.0) - gain(50.0);
    assert!((gained - want).abs() < 1e-6, "gained {gained}, want {want} (upstream scales it by the 1.6 effectiveness)");
}
