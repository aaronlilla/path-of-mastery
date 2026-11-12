//! A Mirage Archer copy keeps the supported gem's item/tree +level, like the game; upstream rebuilds it from the raw gem level.
use pom_pipeline::session::Session;

fn calc(xml: String) -> serde_json::Value {
    Session::new(xml, pom_calc::data::game_data()).calc().unwrap().stats["player"].clone()
}

#[test]
fn mirage_keeps_gem_level() {
    // The item gives "+3 to Level of all Toxic Rain Gems" to a level 21 Toxic Rain (effective 24).
    let bonus = std::fs::read_to_string(format!("{}/testdata/mirage-plus-level.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    // Same build with that level written into the gem and the item line removed: the copy's raw level is already 24.
    let raw = bonus.lines().filter(|l| l.trim() != "+3 to Level of all Toxic Rain Gems").collect::<Vec<_>>().join("\n").replace("nameSpec=\"Toxic Rain\" level=\"21\"", "nameSpec=\"Toxic Rain\" level=\"24\"");
    assert_ne!(bonus, raw);
    let (a, b) = (calc(bonus), calc(raw));
    let f = |v: &serde_json::Value, k: &str| v[k].as_f64().unwrap();
    assert_eq!(f(&a, "TotalDPS"), f(&b, "TotalDPS"), "main skill is the same in both builds");
    let (ma, mb) = (f(&a, "MirageDPS"), f(&b, "MirageDPS"));
    assert!((ma - mb).abs() <= mb * 1e-9, "mirage must use the effective level: {ma} vs {mb}");
}

#[test]
fn mirage_without_bonus_is_unchanged() {
    // No item/tree +level or +quality: the copy must equal upstream's raw copy (slot-bound extras and socket-colour quality stay out of it).
    let xml = std::fs::read_to_string(format!("{}/testdata/mirage-plus-level.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let xml = xml.lines().filter(|l| l.trim() != "+3 to Level of all Toxic Rain Gems").collect::<Vec<_>>().join("\n");
    let m = calc(xml)["MirageDPS"].as_f64().unwrap();
    assert!((m - 2409370.708610813).abs() <= 1e-3, "MirageDPS {m}"); // value with POM_STRICT_COMPAT=1
}
