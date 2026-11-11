//! Blade Blast of Dagger Detonation with a dagger in each hand: since 3.26.0 each of two daggers contributes 60% as much
//! Added Damage (gem text), upstream uses 0.5. Run with POM_STRICT_COMPAT unset.
use pom_engine::modifier::ModType;
use pom_engine::value::Value;
use pom_pipeline::session::Session;

#[test]
fn dagger_detonation_dual_is_60_percent() {
    let xml = std::fs::read_to_string(format!("{}/testdata/eb-dagger.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    // A copy of the dagger (item 1) replaces the shield (item 5) in the off hand.
    let (a, b) = (xml.find("<Item id=\"1\">").unwrap(), xml.find("<Item id=\"2\">").unwrap());
    let (c, d) = (xml.find("<Item id=\"5\">").unwrap(), xml.find("<Item id=\"3\">").unwrap());
    let dagger = &xml[a..b];
    let xml = format!("{}{}{}{}", &xml[..c], dagger.replacen("id=\"1\"", "id=\"5\"", 1), "		", &xml[d..]);
    let (i, j) = (xml.find("<Skill ").unwrap(), xml.find("</Skills>").unwrap());
    let skill = r#"<Skill mainActiveSkillCalcs="1" includeInFullDPS="nil" label="" enabled="true" slot="Body Armour" mainActiveSkill="1"><Gem enableGlobal2="true" level="20" enableGlobal1="true" skillId="BladeBlastAltY" qualityId="Default" gemId="Metadata/Items/Gems/SkillGemBladeBlastAltY" quality="0" enabled="true" count="1" nameSpec="Blade Blast of Dagger Detonation"/></Skill>"#;
    let xml = format!("{}{}{}", &xml[..i], skill, &xml[j..]);
    let ge = pom_skills::data::granted_effect_by_skill_id("BladeBlastAltY").unwrap();
    let stats = pom_skills::modlist::build_skill_instance_stats(ge, 20.0, 0.0, None);
    let pct = stats.iter().find(|(n, _)| n == "gain_%_of_base_dagger_damage_as_added_spell_damage").unwrap().1;
    let mut s = Session::new(xml, pom_calc::data::game_data());
    let (dmax, got) = s
        .inspect_main(|env, view| {
            let dmax = env.weapon_data["Weapon 1"][0]["PhysicalMax"].as_f64().unwrap();
            let got: f64 = view
                .unwrap()
                .skill_mod_list
                .mods_named(pom_engine::sym!("PhysicalMax"))
                .filter(|m| m.ty == ModType::Base && m.source.as_deref() == Some("Blade Blast of Dagger Detonation"))
                .filter_map(|m| if let Value::Num(v) = m.value { Some(v) } else { None })
                .sum();
            (dmax, got)
        })
        .unwrap();
    let want = (2.0 * dmax * pct / 100.0 * 0.6).floor();
    assert_eq!(got, want);
}
