//! Energy Blade only swaps in its blade when every equipped weapon is a sword (gem weaponTypes), not any non-bow weapon.
use pom_pipeline::session::Session;

fn calc(file: &str) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/{file}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut s = Session::new(xml, pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

#[test]
fn energy_blade_needs_swords() {
    let (sword, dagger) = (calc("eb-sword.xml"), calc("eb-dagger.xml"));
    let phys = |v: &serde_json::Value| v["MainHand"]["PhysicalMaxBase"].as_f64().unwrap();
    let es = |v: &serde_json::Value| v["EnergyShield"].as_f64().unwrap();
    // Sword: weapon 1 is the lightning-only blade and the buff halves ES.
    assert_eq!(phys(&sword), 0.0);
    // Dagger: keeps its own physical damage, no blade, no ES penalty.
    assert!(phys(&dagger) > 0.0, "dagger keeps its own damage");
    assert!(es(&dagger) > es(&sword) * 1.5, "ES penalty must be absent on a dagger");
}

/// The Energy Blade quality attack speed is increased (additive), not a MORE on the blade's base attack rate.
#[test]
fn energy_blade_quality_is_increased() {
    let xml = std::fs::read_to_string(format!("{}/testdata/eb-sword.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut s = Session::new(xml, pom_calc::data::game_data());
    let (name, rate, inc) = s
        .inspect_main(|env, view| {
            let name = env.weapon_data["Weapon 1"][0]["name"].as_str().unwrap().to_string();
            let inc: f64 = view
                .unwrap()
                .skill_mod_list
                .mods_named(pom_engine::sym!("Speed"))
                .filter(|m| m.ty == pom_engine::modifier::ModType::Inc && m.source.as_deref() == Some("Energy Blade"))
                .filter_map(|m| if let pom_engine::value::Value::Num(v) = m.value { Some(v) } else { None })
                .sum();
            (name, env.weapon_data["Weapon 1"][0]["AttackRate"].as_f64().unwrap(), inc)
        })
        .unwrap();
    let base = pom_skills::data::game_data().item_bases[&name].weapon.as_ref().unwrap()["AttackRateBase"];
    assert_eq!(rate, base, "no x1.10 on the blade's base rate");
    assert_eq!(inc, 10.0);
}
