//! Loads engine-data/ and spot-checks it against the Lua export: counts of gems, item bases,
//! tree nodes/groups, and a handful of known values. Also prints load time so it stays visible
//! in `cargo test -- --nocapture`.

use pom_engine::data::GameData;
use std::path::PathBuf;

fn engine_data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../engine-data")
}

#[test]
fn loads_and_spot_checks() {
    let dir = engine_data_dir();

    // Two calls back to back, to see the load time is stable rather than a one-off fast run.
    let first = GameData::load(&dir).expect("GameData::load failed (1st call)");
    println!("GameData::load took {:.4}s", first.load_secs);
    let data = GameData::load(&dir).expect("GameData::load failed (2nd call)");
    println!("GameData::load took {:.4}s", data.load_secs);

    // Counts, checked against the same JSON files with a plain jq/python read.
    assert!(data.gems.len() > 800, "expected 800+ gems, got {}", data.gems.len());
    assert!(
        data.item_bases.len() > 1000,
        "expected 1000+ item bases, got {}",
        data.item_bases.len()
    );
    assert!(data.tree().nodes.len() > 3000, "expected 3000+ tree nodes, got {}", data.tree().nodes.len());
    assert!(data.tree().groups.len() > 700, "expected 700+ tree groups, got {}", data.tree().groups.len());

    let uniques = data.extra.get("uniques").expect("failed to load \"uniques\"").expect("no \"uniques\" section");
    assert!(uniques.is_object(), "uniques should be a map of category -> item text list");
    assert!(uniques.as_object().unwrap().len() > 10, "expected several unique item categories");

    // Known values.
    let fireball = data
        .gems
        .get("Metadata/Items/Gems/SkillGemFireball")
        .expect("missing Fireball gem");
    assert_eq!(fireball.name.as_deref(), Some("Fireball"));

    let rusted_sword = data.item_bases.get("Rusted Sword").expect("missing Rusted Sword base");
    assert_eq!(rusted_sword.base_type.as_deref(), Some("One Handed Sword"));
    assert_eq!(rusted_sword.weapon.as_ref().unwrap().get("PhysicalMin"), Some(&4.0));

    let resist_cap = data.misc.get("MaxResistCap").expect("missing MaxResistCap");
    assert_eq!(resist_cap, 90.0);

    assert_eq!(data.tree_version, "3_29");
    // `PassiveTree.lua` deletes the synthetic "root" node for tree versions >= 3.10 (see its
    // `self.nodes.root = nil`), so the current tree (3_29) has none; check an ordinary node
    // instead.
    let executioner = data.tree().nodes.get("10016").expect("missing node 10016 (Executioner)");
    assert_eq!(executioner.dn.as_deref(), Some("Executioner"));
    assert!(executioner.is_notable);

    assert!(
        data.load_secs < 1.0,
        "load took {:.3}s, target is well under 1s",
        data.load_secs
    );
}

/// Regression: the tree export once left 2,314 of 3,352 canonical `nodes` entries as bare
/// {"$ref": ...} stubs (jewel sockets' nodesInRadius copies were walked first), so typed node
/// fields were silently empty for most of the tree. Every canonical node must carry real data.
#[test]
fn tree_nodes_are_not_ref_stubs() {
    // every exported tree version (the corpus spans 29 of them); nodes is a map in modern trees
    // and a plain list in the oldest ones
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../engine-data");
    let mut checked = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !(name.starts_with("tree_") && name.ends_with(".json")) { continue; }
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let nodes: Vec<&serde_json::Value> = match &raw["nodes"] {
            serde_json::Value::Object(m) => m.values().collect(),
            serde_json::Value::Array(a) => a.iter().filter(|v| !v.is_null()).collect(),
            _ => panic!("{name}: no nodes"),
        };
        assert!(!nodes.is_empty(), "{name}: empty nodes");
        let stubs = nodes.iter().filter(|v| v.get("$ref").is_some()).count();
        assert_eq!(stubs, 0, "{name}: {stubs} of {} tree nodes are $ref stubs", nodes.len());
        checked += 1;
    }
    assert!(checked >= 40, "only {checked} tree files found");
}
