//! calcLib.getGameIdFromGemName (Modules/CalcTools.lua:279): gem name -> gameId, used by SkillName tags
//! with includeTransfigured so a mod naming "Blink Arrow" also applies to "Blink Arrow of Prismatic Clones"
//! (transfigured gems share their base gem's gameId).
//!
//! The lookup is process-global. Call `set_gem_ids` once with GameData's tables; otherwise it is loaded
//! lazily from engine-data/data_gemForBaseName.json, data_gems.json and data_gemVaalGemIdForBaseGemId.json
//! (POM_ENGINE_DATA overrides the directory).
use crate::fxhash::HashMap;
use std::sync::OnceLock;

pub struct GemIds {
    /// lowercase gem base name -> gem id (data.gemForBaseName)
    pub gem_for_base_name: HashMap<String, String>,
    /// gem id -> (gameId, vaalGem)
    pub gems: HashMap<String, (String, bool)>,
    /// vaal gem id -> its base gem id (data.gemVaalGemIdForBaseGemId)
    pub vaal_base: HashMap<String, String>,
}

static GEM_IDS: OnceLock<GemIds> = OnceLock::new();

/// Supply the tables explicitly (e.g. from GameData). Returns false if they were already set or loaded.
pub fn set_gem_ids(ids: GemIds) -> bool { GEM_IDS.set(ids).is_ok() }

fn load_from_files() -> GemIds {
    let dir = crate::data::data_dir().to_string_lossy().into_owned();
    // The shared compact copies (`crate::cjson`): data_gems.json is also the typed gem table's source.
    let read = |name: &str| -> crate::cjson::J { crate::cjson::doc(std::path::Path::new(&format!("{dir}/{name}"))).unwrap_or(crate::cjson::J::NULL) };
    let str_map = |v: crate::cjson::J| -> HashMap<String, String> {
        v.as_object().map(|o| o.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.to_string(), s.to_string()))).collect()).unwrap_or_default()
    };
    let gems_json = read("data_gems.json");
    let gems = gems_json.as_object().map(|o| o.iter().filter_map(|(k, e)| {
        let game_id = e.get("gameId")?.as_str()?.to_string();
        let vaal = e.get("vaalGem").map(|v| !(v.is_null() || v.as_bool() == Some(false))).unwrap_or(false);
        Some((k.to_string(), (game_id, vaal)))
    }).collect()).unwrap_or_default();
    GemIds {
        gem_for_base_name: str_map(read("data_gemForBaseName.json")),
        gems,
        vaal_base: str_map(read("data_gemVaalGemIdForBaseGemId.json")),
    }
}

/// Port of calcLib.getGameIdFromGemName(gemName, dropVaal).
pub fn game_id_from_gem_name(gem_name: &str, drop_vaal: bool) -> Option<String> {
    let ids = GEM_IDS.get_or_init(load_from_files);
    let gem_id = ids.gem_for_base_name.get(&gem_name.to_lowercase())?;
    let (game_id, vaal) = ids.gems.get(gem_id)?;
    if drop_vaal && *vaal {
        // data.gems[data.gemVaalGemIdForBaseGemId[gemId]].gameId
        let base = ids.vaal_base.get(gem_id)?;
        return ids.gems.get(base).map(|(g, _)| g.clone());
    }
    Some(game_id.clone())
}

#[cfg(test)]
mod tests {
    use super::game_id_from_gem_name as id;
    #[test]
    fn transfigured_and_vaal_resolve_to_base_game_id() {
        let base = id("Blink Arrow", true).expect("Blink Arrow resolves");
        assert_eq!(id("Blink Arrow of Prismatic Clones", true).as_deref(), Some(base.as_str()));
        assert_eq!(id("blink arrow of bombarding clones", true).as_deref(), Some(base.as_str()));
        assert_ne!(id("Mirror Arrow", true).as_deref(), Some(base.as_str()));
        assert_eq!(id("Vaal Absolution", true), id("Absolution", true));
        assert_ne!(id("Vaal Absolution", false), id("Absolution", false));
        assert_eq!(id("not a gem", true), None);
    }
}
