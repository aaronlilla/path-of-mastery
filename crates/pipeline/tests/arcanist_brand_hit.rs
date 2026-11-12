//! Arcanist Brand's "more Damage with Hits vs Branded Enemy" (TriggeredDamage MORE) scales the triggered spell's hit, not its DoT.
use pom_pipeline::session::Session;

fn calc(branded: bool) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<SkillSet").unwrap(), xml.find("</SkillSet>").unwrap());
    let gem = |id: &str, game: &str, nm: &str| format!(r#"<Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="{id}" qualityId="Default" gemId="Metadata/Items/Gems/{game}" quality="0" enabled="true" count="1" nameSpec="{nm}"/>"#);
    let set = format!(
        r#"<SkillSet id="1"><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="2">{}{}</Skill>"#,
        gem("BrandSupport", "SkillGemBrandSupport", "Arcanist Brand"),
        gem("EssenceDrain", "SkillGemEssenceDrain", "Essence Drain"),
    );
    let cfg = format!(r#"<Config><Input name="targetBrandedEnemy" boolean="{branded}"/>"#); // defaults to true
    let xml = format!("{}{}{}", &xml[..i], set, &xml[j..]).replace("<Config>", &cfg).replace("CUSTOM_MODS", "");
    let mut s = Session::new(xml, pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

#[test]
fn branded_enemy_more_scales_hit_not_dot() {
    let (off, on) = (calc(false), calc(true));
    let f = |p: &serde_json::Value, k: &str| p[k].as_f64().unwrap_or(0.0);
    assert!(f(&off, "SkillTriggerRate") > 0.0 && f(&off, "TotalDot") > 0.0, "Essence Drain is not triggered or has no DoT");
    assert!(f(&on, "AverageHit") > f(&off, "AverageHit") * 1.01, "branded-enemy MORE did not reach the hit");
    assert!((f(&on, "TotalDot") - f(&off, "TotalDot")).abs() < 1e-6 * f(&off, "TotalDot"), "branded-enemy MORE scaled the DoT");
}
