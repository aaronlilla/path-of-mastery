//! Triggerbots (Perfect Crime) make every triggered spell trigger twice, including global triggers like Cast when Damage Taken; upstream doubles only the simulated ones.
use pom_pipeline::session::Session;

fn calc(custom_mods: &str) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<SkillSet").unwrap(), xml.find("</SkillSet>").unwrap());
    let gem = |id: &str, game: &str, nm: &str| format!(r#"<Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="{id}" qualityId="Default" gemId="Metadata/Items/Gems/{game}" quality="0" enabled="true" count="1" nameSpec="{nm}"/>"#);
    let set = format!(
        r#"<SkillSet id="1"><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1">{}{}</Skill>"#,
        gem("Fireball", "SkillGemFireball", "Fireball"),
        gem("SupportCastWhenDamageTaken", "SupportGemCastOnDamageTaken", "Cast when Damage Taken"),
    );
    let xml = format!("{}{}{}", &xml[..i], set, &xml[j..]);
    let mut s = Session::new(xml.replace("CUSTOM_MODS", custom_mods), pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

#[test]
fn triggerbots_double_global_triggers() {
    let plain = calc("");
    let bots = calc("Triggers Level 20 Summon Triggerbots when allocated");
    let f = |p: &serde_json::Value, k: &str| p[k].as_f64().unwrap();
    assert!(f(&plain, "SkillTriggerRate") > 0.0);
    assert!((f(&bots, "SkillTriggerRate") - 2.0 * f(&plain, "SkillTriggerRate")).abs() < 1e-9);
}
