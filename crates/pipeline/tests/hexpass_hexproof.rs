//! Hexpass (chance_to_ignore_hexproof_% = 100) makes its supported curse land on a Hexproof enemy.
use pom_pipeline::session::Session;

fn hexblast_hit(curse: Option<(&str, &str)>, hexpass: bool) -> f64 {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<SkillSet").unwrap(), xml.find("</SkillSet>").unwrap());
    let gem = |id: &str, name: &str| format!(r#"<Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="{id}" qualityId="Default" gemId="Metadata/Items/Gems/SkillGem{id}" quality="0" enabled="true" count="1" nameSpec="{name}"/>"#);
    let mut set = format!(r#"<SkillSet id="1"><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1">{}</Skill>"#, gem("Hexblast", "Hexblast"));
    if let Some((id, name)) = curse {
        let sup = if hexpass { gem("SupportHexpass", "Hexpass") } else { String::new() };
        set += &format!(r#"<Skill mainActiveSkillCalcs="nil" includeInFullDPS="nil" label="" enabled="true" slot="Helmet" mainActiveSkill="1">{}{sup}</Skill>"#, gem(id, name));
    }
    let xml = format!("{}{}{}", &xml[..i], set, &xml[j..]).replace("CUSTOM_MODS", "").replace("<Config>", r#"<Config><Input name="MapPrefix1" string="Hexproof"/>"#);
    let mut s = Session::new(xml, pom_calc::data::game_data());
    let hit = s.calc().unwrap().stats["player"]["AverageHit"].as_f64().unwrap();
    hit
}

#[test]
fn hexpass_curse_lands_on_hexproof_enemy() {
    let none = hexblast_hit(None, false);
    let plain = hexblast_hit(Some(("Despair", "Despair")), false);
    let pass = hexblast_hit(Some(("Despair", "Despair")), true);
    assert!((plain - none).abs() < 1e-6 * none, "Despair without Hexpass landed on a Hexproof enemy: {plain} vs {none}");
    assert!(pass > none * 1.5, "Hexpass Despair did not land on a Hexproof enemy: {pass} vs {none}");
}
