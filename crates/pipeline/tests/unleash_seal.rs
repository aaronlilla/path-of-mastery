//! Unleash "wait for max seals" cycle is the longer of the seal regain time and one cast time (seconds), not a mix with casts per second.
use pom_pipeline::session::Session;

fn calc(custom_mods: &str) -> serde_json::Value {
    let xml = std::fs::read_to_string(format!("{}/testdata/unleash-seal.xml", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let mut s = Session::new(xml.replace("CUSTOM_MODS", custom_mods), pom_calc::data::game_data());
    s.calc().unwrap().stats["player"].clone()
}

#[test]
fn unleash_max_seal_cycle_is_time() {
    for mods in ["", "100% increased Cast Speed"] {
        let p = calc(mods);
        let f = |k: &str| p[k].as_f64().unwrap();
        // Cast rate is well above 2/s, so one cast (<0.5 s) is shorter than regaining the seals: the cycle is TimeMaxSeals and must not grow with cast speed.
        assert!(f("Speed") > 2.0);
        assert_eq!(f("HitTime"), f("TimeMaxSeals"));
        // Per-second cost is cost per cycle: Cost / cycle seconds (Repeats is 1 here).
        assert_eq!(f("Repeats"), 1.0);
        assert!(f("ManaCost") > 0.0);
        assert!((f("ManaPerSecondCost") - f("ManaCost") / f("HitTime")).abs() < 1e-9, "ManaPerSecondCost {}", f("ManaPerSecondCost"));
    }
}

#[test]
fn unleash_seals_capped() {
    use pom_pipeline::offence::unleash_dps_multiplier;
    // Slow casting: 1/0.71/0.3 = 4.69 seals per cast would exceed the 3-seal maximum, so it is capped (upstream: 1 + 4.69 * 0.74 = 4.47).
    assert!((unleash_dps_multiplier(0.71, 0.3, 0.74, 3.0) - 3.22).abs() < 1e-9);
    // Fast casting: 1/0.71/2 = 0.70 seals per cast, below the cap, unchanged.
    assert!((unleash_dps_multiplier(0.71, 2.0, 0.74, 3.0) - (1.0 + 1.0 / 0.71 / 2.0 * 0.74)).abs() < 1e-12);
}

#[test]
fn unleash_burst_counts_every_seal() {
    // The burst is one cast plus one reoccurrence per seal lost, so AverageBurstHits = SealMax + 1 and AverageBurstDamage = AverageDamage * (1 + SealMax * penalty).
    let p = calc("");
    let f = |k: &str| p[k].as_f64().unwrap();
    assert_eq!(f("AverageBurstHits"), f("SealMax") + 1.0);
    // This fixture's Awakened Unleash (level 5) has SealMax 5 and penalty 0.67: 1 + 5 * 0.67 = 4.35 (upstream's burst read 3.68).
    assert!((f("AverageBurstDamage") / f("AverageDamage") - (1.0 + f("SealMax") * 0.67)).abs() < 1e-9);
}
