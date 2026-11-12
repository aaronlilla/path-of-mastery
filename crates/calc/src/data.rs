//! Loads `pom_engine::data::GameData` once per process and exposes the flat lookups
//! `setup.rs` needs out of it: `data.characterConstants` (Modules/CalcSetup.lua reads this as
//! `data.characterConstants["key"]`) and `data.monsterAccuracyTable` (`data.monsterAccuracyTable[level]`).
use pom_engine::data::GameData;
use pom_engine::modifier::Mod;
use pom_engine::fxhash::HashMap;
use std::path::Path;
use std::sync::OnceLock;

pub fn game_data() -> &'static GameData {
    pom_engine::data::shared()
}

/// `data.characterConstants`: a flat string -> number map (`data_characterConstants.json`).
/// Loaded once (the export never changes at runtime) into a plain map, so a `cc()` lookup is a
/// hash lookup, not a JSON walk, on every recalculation.
pub struct CharacterConstants(HashMap<String, f64>);

impl CharacterConstants {
    /// The constants, read once per process.
    pub fn shared() -> &'static CharacterConstants {
        static CC: std::sync::OnceLock<CharacterConstants> = std::sync::OnceLock::new();
        CC.get_or_init(CharacterConstants::load)
    }

    pub fn load() -> CharacterConstants {
        let v = game_data()
            .extra
            .get("characterConstants")
            .expect("characterConstants section missing from data_index.json")
            .expect("characterConstants section failed to parse");
        let obj = v.as_object().expect("characterConstants is not a JSON object");
        let mut m = pom_engine::fxhash::map_with_capacity(obj.len());
        for (k, val) in obj {
            if let Some(n) = val.as_f64() {
                m.insert(k.to_string(), n);
            }
        }
        CharacterConstants(m)
    }

    /// `data.characterConstants["key"]`. Panics on an unknown key: every key this crate reads is
    /// a fixed literal taken straight from CalcSetup.lua, so a miss means the export or the port
    /// drifted, not a normal missing-value case.
    pub fn get(&self, key: &str) -> f64 {
        *self.0.get(key).unwrap_or_else(|| panic!("characterConstants missing key {key:?}"))
    }
}

/// `data.monsterAccuracyTable[level]` (`data_monsterAccuracyTable.json`, a plain array). The
/// export serializes Lua's 1-based `monsterAccuracyTable[1]` as JSON index 0, so `level` (1-based,
/// matching `env.enemyLevel`) maps to `level - 1`.
pub fn monster_accuracy(level: i64) -> f64 {
    let v = game_data()
        .extra
        .get("monsterAccuracyTable")
        .expect("monsterAccuracyTable section missing from data_index.json")
        .expect("monsterAccuracyTable section failed to parse");
    let arr = v.as_array().expect("monsterAccuracyTable is not a JSON array");
    let idx = (level - 1).clamp(0, arr.len() as i64 - 1) as usize;
    arr.get(idx).unwrap().as_f64().unwrap_or(0.0)
}

/// `env.spec.tree.characterData and env.spec.tree.characterData[classId] or
/// env.spec.tree.classes[classId]`'s `base_str`/`base_dex`/`base_int` fields
/// (Modules/CalcSetup.lua line 588, 592-593), read straight out of `tree_<version>.json`'s
/// `classes` section rather than through a typed `PassiveTree` field (not modeled there yet;
/// see `crates/engine/src/data/tree.rs`'s `extra` catch-all).
#[derive(Clone, Copy)]
pub struct ClassBaseStats {
    pub str_: f64,
    pub dex: f64,
    pub int_: f64,
}

/// `class_id` is `spec.curClassId` (0 = Scion, 1-6 = the other six base classes).
/// `tree_version` is `spec.treeVersion`, e.g. `"3_29"`; the file is `tree_<version>.json`
/// (dots already come through as underscores per `engine-data`'s existing naming).
pub fn class_base_stats(tree_version: &str, class_id: i64) -> ClassBaseStats {
    // One partial parse per tree version (only `characterData`/`classes`, everything else skipped)
    // fills every class id; a miss or a parse failure falls back to the full-file path.
    type PerVersion = HashMap<String, HashMap<i64, ClassBaseStats>>;
    static CACHE: OnceLock<std::sync::Mutex<PerVersion>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(v) = cache.lock().unwrap().get(tree_version).and_then(|m| m.get(&class_id)) {
        return *v;
    }
    let all = class_base_stats_all(tree_version).unwrap_or_default();
    let hit = all.get(&class_id).copied();
    cache.lock().unwrap().insert(tree_version.to_string(), all);
    hit.unwrap_or_else(|| class_base_stats_uncached(tree_version, class_id))
}

fn class_base_stats_all(tree_version: &str) -> Option<HashMap<i64, ClassBaseStats>> {
    // The tree's shared compact copy (`pom_engine::cjson`), the same one `pom_passives` reads.
    let path = game_data_dir().join(format!("tree_{}.json", tree_version.replace('.', "_")));
    let root = pom_engine::cjson::doc(&path).ok()?;
    let mut out = HashMap::default();
    for m in [root.get("classes"), root.get("characterData")].into_iter().flatten().filter_map(|m| m.as_object()) {
        for (k, node) in m.iter() {
            let Ok(id) = k.parse::<i64>() else { continue };
            let g = |k: &str| node.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
            out.insert(id, ClassBaseStats { str_: g("base_str"), dex: g("base_dex"), int_: g("base_int") });
        }
    }
    Some(out)
}

fn class_base_stats_uncached(tree_version: &str, class_id: i64) -> ClassBaseStats {
    let file = format!("tree_{}.json", tree_version.replace('.', "_"));
    let dir = game_data_dir();
    let path = dir.join(&file);
    let v = pom_engine::cjson::doc(&path).unwrap_or_else(|e| panic!("{e}"));
    let key = class_id.to_string();
    // `characterData` (where the export has it) takes priority over `classes`, same as the Lua.
    let node = v
        .get("characterData")
        .and_then(|cd| cd.get(&key))
        .or_else(|| v.get("classes").and_then(|c| c.get(&key)))
        .unwrap_or_else(|| panic!("{}: class {} not found", path.display(), class_id));
    let f = |k: &str| node.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0);
    ClassBaseStats { str_: f("base_str"), dex: f("base_dex"), int_: f("base_int") }
}

/// `env.data.weaponTypeInfo[weaponType].melee` (`data_weaponTypeInfo.json`, keyed by the item's
/// own `type` string, e.g. `"Bow"`, `"One Handed Sword"`, `"None"` for unarmed). Unknown types
/// (a non-weapon item, or no item at all) fall back to `true`, matching unarmed's own `melee:
/// true` entry (CalcActiveSkill.lua's `getWeaponFlags` only ever calls this with a real
/// `weaponData.type`, and `weaponData1`/`weaponData2` default to the `"None"` entry when no
/// weapon is equipped).
pub fn weapon_is_melee(weapon_type: Option<&str>) -> bool {
    let v = game_data().extra.get("weaponTypeInfo").expect("weaponTypeInfo section missing from data_index.json").expect("weaponTypeInfo section failed to parse");
    let ty = weapon_type.unwrap_or("None");
    v.get(ty).and_then(|info| info.get("melee")).and_then(|m| m.as_bool()).unwrap_or(true)
}

/// `data.misc.AccuracyPerDexBase` (`data_misc.json`): the flat accuracy-per-Dexterity constant
/// `CalcPerform.lua`'s attribute-bonus section falls back to when no `DexAccBonusOverride` mod
/// is present.
pub fn accuracy_per_dex_base() -> f64 {
    game_data().misc.get("AccuracyPerDexBase").unwrap_or(0.0)
}

/// `self.base.flask.buff` (`data_itemBases.json`'s `<baseName>.flask.buff`, a plain array of
/// mod-line strings every item on this base grants as its `buffModList` - `Item.lua:1053-1059`
/// parses these once per item, tagged with that item's own `modSource`; they're a property of the
/// flask's *base type*, not its individual rolls, e.g. every Quicksilver Flask grants the same
/// "40% increased Movement Speed" line regardless of rarity/quality) plus whether this base is a
/// life/mana (recovery) flask (`self.base.flask.life`/`.mana`'s presence - CalcPerform.lua's
/// `isUtilityFlask = not (item.base.flask.life or item.base.flask.mana)` check). `None` if
/// `base_name` isn't a flask base (or isn't a base at all) - a tincture base has its own separate
/// `.tincture.buff` list, not modeled here since this port's flask work doesn't cover tinctures.
pub struct FlaskBaseInfo {
    pub buff_lines: Vec<String>,
    pub is_life_or_mana: bool,
    pub is_life: bool,
    pub is_mana: bool,
}

pub fn flask_base_info(base_name: &str) -> Option<FlaskBaseInfo> {
    let base = game_data().item_bases.get(base_name)?;
    let flask = base.extra.get("flask")?;
    let buff_lines = flask.get("buff").and_then(|b| b.as_array()).map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
    let is_life_or_mana = flask.get("life").is_some() || flask.get("mana").is_some();
    Some(FlaskBaseInfo { buff_lines, is_life_or_mana, is_life: flask.get("life").is_some(), is_mana: flask.get("mana").is_some() })
}

/// `data.monsterConstants["key"]` (`data_monsterConstants.json`, a flat string -> number map),
/// read straight from `Extra` per call rather than cached in a plain map like
/// `CharacterConstants` - `initMinionModDB` only reads a handful of fixed keys once per minion
/// setup, so the JSON-walk cost is not worth a second cache structure.
pub fn monster_constant(key: &str) -> f64 {
    let v = game_data().extra.get("monsterConstants").expect("monsterConstants section missing from data_index.json").expect("monsterConstants section failed to parse");
    v.get(key).and_then(|x| x.as_f64()).unwrap_or_else(|| panic!("monsterConstants missing key {key:?}"))
}

/// One of the flat monster-scaling arrays keyed by the export's own field name
/// (`data_monsterLifeTable.json`, `data_monsterLifeTable2.json`, `data_monsterLifeTable3.json`,
/// `data_monsterAllyLifeTable.json`, `data_monsterArmourTable.json`,
/// `data_monsterEvasionTable.json`): Lua's 1-based `table[level]` is JSON index `level - 1`,
/// clamped into range like `monster_accuracy` above.
fn monster_table_at(section: &str, level: f64) -> f64 {
    let v = game_data().extra.get(section).unwrap_or_else(|_| panic!("{section} section failed to parse")).unwrap_or_else(|| panic!("{section} section missing from data_index.json"));
    let arr = v.as_array().unwrap_or_else(|| panic!("{section} is not a JSON array"));
    let idx = (level as i64 - 1).clamp(0, arr.len() as i64 - 1) as usize;
    arr.get(idx).unwrap().as_f64().unwrap_or(0.0)
}
pub fn monster_life_table(level: f64) -> f64 {
    monster_table_at("monsterLifeTable", level)
}
pub fn monster_life_table2(level: f64) -> f64 {
    monster_table_at("monsterLifeTable2", level)
}
pub fn monster_life_table3(level: f64) -> f64 {
    monster_table_at("monsterLifeTable3", level)
}
pub fn monster_ally_life_table(level: f64) -> f64 {
    monster_table_at("monsterAllyLifeTable", level)
}
pub fn monster_armour_table(level: f64) -> f64 {
    monster_table_at("monsterArmourTable", level)
}
pub fn monster_evasion_table(level: f64) -> f64 {
    monster_table_at("monsterEvasionTable", level)
}
pub fn monster_damage_table(level: f64) -> f64 {
    monster_table_at("monsterDamageTable", level)
}
pub fn monster_ally_damage_table(level: f64) -> f64 {
    monster_table_at("monsterAllyDamageTable", level)
}
/// `data.minions[type]` as raw JSON (attackTime, damage, damageSpread, weaponType1, skillList, ...).
pub fn minion_raw(minion_type: &str) -> Option<pom_engine::cjson::J> {
    static M: OnceLock<pom_engine::cjson::J> = OnceLock::new();
    let v = M.get_or_init(|| pom_engine::cjson::doc(&game_data_dir().join("data_minions.json")).unwrap_or_else(|e| panic!("{e}")));
    v.get(minion_type)
}
pub fn map_level_life_mult(level: f64) -> f64 {
    let v = game_data().extra.get("mapLevelLifeMult").unwrap_or_else(|_| panic!("mapLevelLifeMult section failed to parse")).unwrap_or_else(|| panic!("mapLevelLifeMult section missing from data_index.json"));
    // `env.data.mapLevelLifeMult[env.enemyLevel] or 1`: unlike the dense, level-1-indexed arrays
    // `monster_table_at` reads, this table is genuinely sparse in upstream (only populated
    // for map-tier monster levels), so the export represents it as a JSON object keyed by the
    // stringified level rather than a padded array - a missing key means "no override" (level
    // below map tier, or simply absent), not "out of range", and always falls back to 1.
    let key = (level as i64).to_string();
    v.get(&key).and_then(|x| x.as_f64()).unwrap_or(1.0)
}

/// `env.data.minions[minionType]` (`data_minions.json`): one minion type's static base stats and
/// innate `modList`. Loaded once into a plain map since `initMinionModDB` looks one up per
/// minion-having active skill on every Perform pass.
pub struct MinionData {
    pub life: f64,
    pub energy_shield: Option<f64>,
    pub armour: Option<f64>,
    pub evasion: Option<f64>,
    pub fire_resist: f64,
    pub cold_resist: f64,
    pub lightning_resist: f64,
    pub chaos_resist: f64,
    pub hostile: bool,
    pub life_scaling: Option<String>,
    pub mod_list: Vec<Mod>,
}

pub fn minion_data(minion_type: &str) -> &'static MinionData {
    static M: OnceLock<HashMap<String, MinionData>> = OnceLock::new();
    let map = M.get_or_init(|| {
        let dir = game_data_dir();
        let path = dir.join("data_minions.json");
        let v = pom_engine::cjson::doc(&path).unwrap_or_else(|e| panic!("{e}"));
        let obj = v.as_object().expect("data_minions.json is not a JSON object");
        let mut m = pom_engine::fxhash::map_with_capacity(obj.len());
        for (k, node) in obj {
            let f = |key: &str| node.get(key).and_then(|x| x.as_f64());
            m.insert(
                k.to_string(),
                MinionData {
                    life: f("life").unwrap_or(0.0),
                    energy_shield: f("energyShield"),
                    armour: f("armour"),
                    evasion: f("evasion"),
                    fire_resist: f("fireResist").unwrap_or(0.0),
                    cold_resist: f("coldResist").unwrap_or(0.0),
                    lightning_resist: f("lightningResist").unwrap_or(0.0),
                    chaos_resist: f("chaosResist").unwrap_or(0.0),
                    hostile: node.get("hostile").and_then(|x| x.as_bool()).unwrap_or(false),
                    life_scaling: node.get("lifeScaling").and_then(|x| x.as_str()).map(|s| s.to_string()),
                    mod_list: node.get("modList").map(|v| crate::rawlua::parse_raw_mod_list(&v.to_value())).unwrap_or_default(),
                },
            );
        }
        m
    });
    map.get(minion_type).unwrap_or_else(|| panic!("data_minions.json: unknown minion type {minion_type:?}"))
}

/// `ModStore:ScaleAddMod`'s precision selection (Classes/ModStore.lua:76-77): `data.highPrecisionMods[name][type]`
/// if present, else `data.defaultHighPrecision` when `value` is itself already fractional, else
/// `None` (the caller then takes the `math.modf`-truncates-to-integer branch - see
/// `perform_minions.rs`'s `scale_add_mod`, the one call site this crate ports that needs it).
pub fn mod_precision(name: &str, ty: &str, value: f64) -> Option<i32> {
    let hp = game_data().extra.get("highPrecisionMods").expect("highPrecisionMods section missing from data_index.json").expect("highPrecisionMods section failed to parse");
    if let Some(p) = hp.get(name).and_then(|byname| byname.get(ty)).and_then(|x| x.as_i64()) {
        return Some(p as i32);
    }
    if value.floor() != value {
        let default_hp = game_data().extra.get("defaultHighPrecision").expect("defaultHighPrecision section missing from data_index.json").expect("defaultHighPrecision section failed to parse");
        if let Some(n) = default_hp.as_i64() {
            if n != 0 {
                return Some(n as i32);
            }
        }
    }
    None
}

/// Resolved once per process (it checks the file system).
fn game_data_dir() -> std::path::PathBuf {
    static DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    DIR.get_or_init(game_data_dir_live).clone()
}

fn game_data_dir_live() -> std::path::PathBuf {
    // The data folder the host or tool named. The working-directory copies below are for running from a checkout
    // (cargo tests, the golden binaries); the app always sets the variable, so it never reaches them.
    for var in ["POM_ENGINE_DATA"] {
        if let Some(d) = std::env::var_os(var).filter(|d| !d.is_empty()) {
            return std::path::PathBuf::from(d);
        }
    }
    for dir in ["../../engine-data", "engine-data"] {
        let p = Path::new(dir);
        if p.exists() {
            return p.to_path_buf();
        }
    }
    panic!("could not locate engine-data directory");
}
