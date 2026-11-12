//! A trap's cooldown limits how often it is thrown (as upstream does), so Time = max(throw time, TrapCooldown).
use pom_pipeline::session::Session;

fn calc(skill: &str, name: &str) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let (i, j) = (xml.find("<SkillSet").unwrap(), xml.find("</SkillSet>").unwrap());
    let gem = |id: &str, game: &str, nm: &str| format!(r#"<Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="{id}" qualityId="Default" gemId="Metadata/Items/Gems/{game}" quality="20" enabled="true" count="1" nameSpec="{nm}"/>"#);
    let set = format!(
        r#"<SkillSet id="1"><Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1">{}{}</Skill>"#,
        gem(skill, name, skill_name(skill)),
        gem("SupportTrap", "SupportGemTrap", "Trap"),
    );
    let mut s = Session::new(format!("{}{}{}", &xml[..i], set, &xml[j..]), pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

fn skill_name(id: &str) -> &str {
    if id == "FrostBomb" { "Frost Bomb" } else { "Fireball" }
}

#[test]
fn trap_cooldown_limits_speed() {
    // Frost Bomb has a cooldown that is longer than the trap throw time: the cooldown sets the throw rate.
    let p = calc("FrostBomb", "SkillGemFrostBomb");
    let f = |k: &str| p[k].as_f64().unwrap();
    let cd = f("TrapCooldown");
    assert!(cd > 1.0 / f("TrapThrowingSpeed"));
    assert!((f("Speed") - 1.0 / cd).abs() < 1e-9);
    assert!((f("TotalDPS") - f("AverageDamage") / cd).abs() < 1e-6 * f("TotalDPS"));
    // No cooldown: the throw speed still decides.
    let p = calc("Fireball", "SkillGemFireball");
    assert!((p["Speed"].as_f64().unwrap() - p["TrapThrowingSpeed"].as_f64().unwrap()).abs() < 1e-9);
}
