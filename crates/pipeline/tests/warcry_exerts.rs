//! The Warcry mastery's "10% chance to Exert 3 additional Attacks" is 0.3 expected exerts; upstream floors it away.
use pom_pipeline::session::Session;

fn calc(custom_mods: &str) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<SkillSet").unwrap(), xml.find("</SkillSet>").unwrap());
    let gem = |id: &str, game: &str, nm: &str| format!(r#"<Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="{id}" qualityId="Default" gemId="Metadata/Items/Gems/{game}" quality="0" enabled="true" count="1" nameSpec="{nm}"/>"#);
    let set = format!(
        r#"<SkillSet id="1"><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1">{}</Skill><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Helmet" mainActiveSkill="1">{}</Skill>"#,
        gem("Earthquake", "SkillGemEarthquake", "Earthquake"),
        gem("IntimidatingCry", "SkillGemIntimidatingCry", "Intimidating Cry"),
    );
    let xml = format!("{}{}{}", &xml[..i], set, &xml[j..]).replace(r#"name="Weapon 1" itemId="2""#, r#"name="Weapon 1" itemId="0""#).replace(r#"name="Weapon 2" itemId="2""#, r#"name="Weapon 2" itemId="0""#); // unarmed so Earthquake is usable
    let mut s = Session::new(xml.replace("CUSTOM_MODS", custom_mods), pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

#[test]
fn warcry_mastery_chance_counts() {
    let base = calc("")["IntimidatingExertsCount"].as_f64().unwrap();
    let mastery = calc("Warcries have 10% chance to Exert 3 additional Attacks")["IntimidatingExertsCount"].as_f64().unwrap();
    assert!(base >= 1.0);
    assert!((mastery - (base + 0.3)).abs() < 1e-9);
}
