// Port of ModParser.lua lines 6596-6607: `clusterJewelSkills`, a direct (non-pattern) lowercase
// whole-line lookup built from data.clusterJewels, checked right after jewelFuncList in
// parseMod (line 6653: `local clusterJewelSkill = clusterJewelSkills[lineLower]`).
use super::types::PMod;
use crate::data::GameData;
use serde::Deserialize;
use crate::fxhash::HashMap;
use std::path::Path;
use std::sync::OnceLock;

fn game_data() -> &'static GameData {
    crate::data::shared()
}

#[derive(Debug, Deserialize, Default)]
struct ClusterSkill {
    #[serde(default)]
    enchant: Vec<String>,
}
#[derive(Debug, Deserialize, Default)]
struct ClusterJewel {
    #[serde(default)]
    skills: HashMap<String, ClusterSkill>,
}
#[derive(Debug, Deserialize, Default)]
struct ClusterJewelsData {
    #[serde(default)]
    jewels: HashMap<String, ClusterJewel>,
    #[serde(default)]
    keystones: Vec<String>,
    /// A Lua *set* (string keys, sort-index values), not an array -- the JSON export keeps its
    /// original hash shape.
    #[serde(rename = "notableSortOrder", default)]
    notable_sort_order: HashMap<String, serde_json::Value>,
}

fn mod_val(name: &str, value: super::types::PVal) -> PMod {
    PMod { name: name.to_string(), ty: "LIST".to_string(), value, flags: 0, keyword_flags: 0, source: None, tags: vec![], unreachable_tags: vec![] }
}

pub fn build() -> HashMap<String, Vec<PMod>> {
    use super::types::PVal;
    let mut out: HashMap<String, Vec<PMod>> = HashMap::default();
    let v = game_data().extra.get("clusterJewels").ok().flatten().map(|j| j.to_value()).unwrap_or(serde_json::Value::Null);
    let data: ClusterJewelsData = serde_json::from_value(v).unwrap_or_default();

    for jewel in data.jewels.values() {
        for (skill_id, skill) in &jewel.skills {
            let key = skill.enchant.join(" ").to_lowercase();
            if key.is_empty() {
                continue;
            }
            out.insert(
                key,
                vec![mod_val(
                    "JewelData",
                    PVal::Map(vec![("key".to_string(), PVal::Str("clusterJewelSkill".to_string())), ("value".to_string(), PVal::Str(skill_id.clone()))]),
                )],
            );
        }
    }
    for notable in data.notable_sort_order.keys() {
        out.insert(format!("1 added passive skill is {}", notable.to_lowercase()), vec![mod_val("ClusterJewelNotable", PVal::Str(notable.clone()))]);
    }
    for keystone in &data.keystones {
        out.insert(
            format!("adds {}", keystone.to_lowercase()),
            vec![mod_val("JewelData", PVal::Map(vec![("key".to_string(), PVal::Str("clusterJewelKeystone".to_string())), ("value".to_string(), PVal::Str(keystone.clone()))]))],
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn debug_size() {
        let m = build();
        eprintln!("cluster_jewel_skills size = {}", m.len());
        assert!(m.contains_key("1 added passive skill is adrenaline"), "missing adrenaline key; sample keys: {:?}", m.keys().take(5).collect::<Vec<_>>());
    }
}
