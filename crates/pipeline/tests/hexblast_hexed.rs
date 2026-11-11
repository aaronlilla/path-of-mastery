//! Hexblast's "if Enemy is Hexed" MORE mods need a Hex curse; a Mark (also Cursed) does not trigger them.
use pom_pipeline::session::Session;

fn hexblast_hit(curse: Option<(&str, &str)>) -> f64 {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<SkillSet").unwrap(), xml.find("</SkillSet>").unwrap());
    let gem = |id: &str, name: &str| format!(r#"<Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="{id}" qualityId="Default" gemId="Metadata/Items/Gems/SkillGem{id}" quality="0" enabled="true" count="1" nameSpec="{name}"/>"#);
    let mut set = format!(r#"<SkillSet id="1"><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1">{}</Skill>"#, gem("Hexblast", "Hexblast"));
    if let Some((id, name)) = curse {
        set += &format!(r#"<Skill mainActiveSkillCalcs="nil" includeInFullDPS="nil" label="" enabled="true" slot="Helmet" mainActiveSkill="1">{}</Skill>"#, gem(id, name));
    }
    let xml = format!("{}{}{}", &xml[..i], set, &xml[j..]).replace("CUSTOM_MODS", "");
    let mut s = Session::new(xml, pom_calc::data::game_data());
    let hit = s.calc().unwrap().stats["player"]["AverageHit"].as_f64().unwrap();
    hit
}

#[test]
fn hexblast_more_needs_a_hex_not_a_mark() {
    let none = hexblast_hit(None);
    let mark = hexblast_hit(Some(("WarlordsMark", "Warlord's Mark")));
    let hex = hexblast_hit(Some(("Despair", "Despair")));
    assert!((mark - none).abs() < 1e-6 * none, "Warlord's Mark alone triggered Hexblast's hexed MORE: {mark} vs {none}");
    assert!(hex > none * 1.5, "Despair did not trigger it: {hex} vs {none}");
}
