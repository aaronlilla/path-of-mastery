//! Loaders for the JSON data that the Lua data exporter writes from the original Lua
//! into `engine-data/`. Gems, item bases, misc constants, jewel radii, and the passive tree
//! get typed structs and load eagerly. Everything else (uniques, skills, minions, item mod pools,
//! and about 90 other sections) stays as `serde_json::Value`, loaded lazily through `GameData::extra`
//! and keyed by the same top-level name the Lua `data` table used: most callers only need one or
//! two of those sections, and parsing all of them upfront (they add up to most of the ~70MB export)
//! was the actual cost behind the original over-budget load time, not JSON's text format as such.
//! `Extra::get` parses a section's file on first request and is not memoized; a caller that reuses
//! a section should hold onto the returned `Value` itself.
//!
//! Lua function values the export could not serialize come through as `{"$fn": "file:line"}`.
//! Shared or cyclic tables come through as `{"$ref": "<path>"}`, resolved only within the same
//! file (see `functions.json` and `data_index.json` for the full manifest). This module does not
//! resolve either one.
//!
//! A `bincode` cache for the typed sections was tried and dropped: bincode cannot serialize
//! `#[serde(flatten)]` fields (every typed struct here has one, to hold its irregular tail), so it
//! silently failed to write on every run and every load fell through to plain JSON anyway. The
//! lazy `extra` above is what actually brought load time in budget, so the cache added complexity
//! without a working effect and is gone.

mod flex;
pub mod gems;
pub mod bases;
pub mod misc;
pub mod tree;

use serde::Deserialize;
use serde_json::Value;
use crate::fxhash::HashMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

pub use gems::GemData;
pub use bases::ItemBase;
pub use misc::MiscConstants;
pub use tree::{JewelRadiusBand, PassiveTree};

const TYPED_KEYS: &[&str] = &["gems", "itemBases", "misc", "jewelRadii"];

#[derive(Debug, Deserialize)]
struct IndexFile {
    #[serde(flatten)]
    entries: HashMap<String, Value>,
}

/// The untyped `data.*` sections: everything besides gems/item_bases/misc/jewel_radii/tree.
/// Parses a section's JSON file on demand instead of upfront; see the module docs for why.
pub struct Extra {
    dir: PathBuf,
    /// section name -> file name, e.g. "uniques" -> "data_uniques.json"
    files: HashMap<String, String>,
}

impl Extra {
    /// Parses and returns the named section (e.g. "uniques", "skills", "itemMods", "minions",
    /// "spectres"). `Ok(None)` means the name isn't a known section; `Err` means its file is
    /// missing, unreadable, or the export recorded an error for it.
    ///
    /// Each section is parsed once per process and kept for its lifetime, like the original's
    /// `data.*` tables: re-reading a section on every call cost a full JSON parse each time
    /// (6 MB for "skills").
    pub fn get(&self, key: &str) -> Result<Option<crate::cjson::J>, String> {
        self.get_j(key)
    }

    /// The named section as a compact document (`crate::cjson`), shared with every other reader of its file.
    /// Same `Ok(None)`/`Err` cases as `get`.
    pub fn get_j(&self, key: &str) -> Result<Option<crate::cjson::J>, String> {
        let Some(file_name) = self.files.get(key) else { return Ok(None) };
        if let Some(rest) = file_name.strip_prefix("$error") {
            return Err(format!("export error for \"{key}\":{rest}"));
        }
        crate::cjson::doc(&self.dir.join(file_name)).map(Some)
    }

    /// The section names available (excludes the typed fields on `GameData`).
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.files.keys().map(|s| s.as_str())
    }
}

/// The process-wide game data, loaded once from the first `engine-data` directory found.
/// Every crate reads this one instance instead of loading its own copy.
pub fn shared() -> &'static GameData {
    static G: std::sync::OnceLock<GameData> = std::sync::OnceLock::new();
    G.get_or_init(|| GameData::load(data_dir()).unwrap_or_else(|e| panic!("GameData::load({}) failed: {e}", data_dir().display())))
}

/// The `engine-data` directory every loader reads: `$POM_ENGINE_DATA`, else the first of `../../engine-data`,
/// `engine-data` that exists. Resolved once per process.
pub fn data_dir() -> &'static Path {
    static D: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    D.get_or_init(|| {
        if let Ok(d) = crate::env::var("POM_ENGINE_DATA") {
            return PathBuf::from(d);
        }
        ["../../engine-data", "engine-data"]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.exists())
            .unwrap_or_else(|| panic!("could not locate engine-data directory"))
    })
}

/// Everything loaded from `engine-data/`. See `Extra` for the untyped sections.
pub struct GameData {
    pub gems: HashMap<String, GemData>,
    pub item_bases: HashMap<String, ItemBase>,
    pub misc: MiscConstants,
    pub jewel_radii: HashMap<String, Vec<JewelRadiusBand>>,
    /// The default tree version's typed tree, parsed on first use (see `tree`): the calc reads trees through
    /// `pom_passives`, so loading it upfront cost startup time and memory for nothing.
    tree: std::sync::OnceLock<PassiveTree>,
    tree_file: PathBuf,
    pub tree_version: String,
    pub extra: Extra,
    /// Wall-clock time `load()` took, in seconds. Untyped sections are not included, since
    /// `extra` loads them lazily on request rather than during `load()`.
    pub load_secs: f64,
}

impl GameData {
    /// The default tree version's typed tree (`tree_<treeVersion>.json`), parsed on first call.
    pub fn tree(&self) -> &PassiveTree {
        self.tree.get_or_init(|| {
            let dir = self.tree_file.parent().unwrap_or(Path::new("."));
            let name = self.tree_file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            read_typed(dir, &name).unwrap_or_else(|e| panic!("load {name}: {e}"))
        })
    }
}

fn read_json(dir: &Path, file_name: &str) -> Result<Value, String> {
    let path = dir.join(file_name);
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {}", path.display(), e))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {}", path.display(), e))
}

/// A typed section, read from the shared compact copy of its file (`crate::cjson`) instead of the JSON text.
fn read_typed<T: serde::de::DeserializeOwned>(dir: &Path, file_name: &str) -> Result<T, String> {
    crate::cjson::read_typed(&dir.join(file_name))
}

/// Builds the `Extra` section map from the index: every entry except the typed keys, "tree", and
/// "treeVersion".
fn build_extra(dir: &Path, index: &IndexFile) -> Extra {
    let mut files = HashMap::default();
    for (key, file_val) in index.entries.iter() {
        if key == "tree" || key == "treeVersion" || TYPED_KEYS.contains(&key.as_str()) {
            continue;
        }
        if let Some(file_name) = file_val.as_str() {
            files.insert(key.clone(), file_name.to_string());
        }
    }
    Extra { dir: dir.to_path_buf(), files }
}

impl GameData {
    /// Loads the typed sections and the tree from `dir` (normally `<repo>/engine-data`).
    /// Untyped sections load lazily through `extra` and are not part of this timing.
    pub fn load(dir: &Path) -> Result<GameData, String> {
        let start = Instant::now();
        let index: IndexFile = read_typed(dir, "data_index.json")?;
        let extra = build_extra(dir, &index);
        let tree_version = index
            .entries
            .get("treeVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let gems: HashMap<String, GemData> = read_typed(dir, "data_gems.json")?;
        let item_bases: HashMap<String, ItemBase> = read_typed(dir, "data_itemBases.json")?;
        let misc: MiscConstants = read_typed(dir, "data_misc.json")?;
        let jewel_radii: HashMap<String, Vec<JewelRadiusBand>> =
            read_typed(dir, "data_jewelRadii.json")?;

        let tree_file = index
            .entries
            .get("tree")
            .and_then(|v| v.as_str())
            .ok_or("data_index.json missing \"tree\" entry")?;

        Ok(GameData {
            gems,
            item_bases,
            misc,
            jewel_radii,
            tree: std::sync::OnceLock::new(),
            tree_file: dir.join(tree_file),
            tree_version,
            extra,
            load_secs: start.elapsed().as_secs_f64(),
        })
    }
}
