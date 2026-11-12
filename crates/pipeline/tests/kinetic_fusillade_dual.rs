//! Kinetic Fusillade (and of Detonation) dual wielding: the over-the-effective-maximum attack rate penalty (max_aps / Speed)
//! is applied once, so identical wands deal identical hits. Upstream multiplies the shared dpsMultiplier once per hand pass, so the
//! off hand gets the ratio twice. Run with POM_STRICT_COMPAT unset.
use pom_pipeline::session::Session;

const WAND: &str = "Rarity: RARE\nNew Wand\nDriftwood Wand\nQuality: 20\nSockets: R-R-R\nImplicits: 0\nSkills fire 4 additional Projectiles\n100% increased Attack Speed\n";

fn calc(skill_id: &str) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/eb-sword.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (a, b) = (xml.find("<Item id=\"1\">").unwrap(), xml.find("<Item id=\"2\">").unwrap());
    let (c, d) = (xml.find("<Item id=\"5\">").unwrap(), xml.find("<Item id=\"3\">").unwrap());
    let wand = |id: u32| format!("<Item id=\"{id}\">\n{WAND}\t\t</Item>\n\t\t");
    let xml = format!("{}{}{}{}{}", &xml[..a], wand(1), &xml[b..c], wand(5), &xml[d..]);
    let (i, j) = (xml.find("<Skill ").unwrap(), xml.find("</Skills>").unwrap());
    let skill = format!(r#"<Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1"><Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="{skill_id}" qualityId="Default" gemId="Metadata/Items/Gems/SkillGemKineticFusillade" quality="0" enabled="true" count="1" nameSpec="Kinetic Fusillade"/></Skill>"#);
    let xml = format!("{}{}{}", &xml[..i], skill, &xml[j..]);
    let mut s = Session::new(xml, pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

#[test]
fn kf_dual_wield_penalty_applied_once() {
    for id in ["KineticFusillade", "KineticFusilladeAltX"] {
        let p = calc(id);
        let f = |k: &str| p[k].as_f64().unwrap();
        let (mh, oh) = (p["MainHand"]["TotalDPS"].as_f64().unwrap(), p["OffHand"]["TotalDPS"].as_f64().unwrap());
        assert!(f("Speed") > f("KineticFusilladeMaxEffectiveAPS"), "{id}: not over the cap");
        assert!((mh - oh).abs() < 1e-9 * mh.abs(), "{id}: identical wands, MH {mh} != OH {oh}");
    }
}
