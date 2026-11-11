//! Typed shape of `tree_<version>.json`, the processed `PassiveTree` object (post
//! `Classes/PassiveTree.lua`) for the current default tree version, plus `data_jewelRadii.json`.

use crate::data::flex::de_flex_vec;
use serde::Deserialize;
use crate::cjson::J;
use crate::fxhash::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct JewelRadiusBand {
    pub label: Option<String>,
    pub col: Option<String>,
    pub inner: f64,
    pub outer: f64,
    #[serde(rename = "innerSquared")]
    pub inner_squared: Option<f64>,
    #[serde(rename = "outerSquared")]
    pub outer_squared: Option<f64>,
}

/// A passive tree group: a cluster point nodes are laid out around on concentric orbits.
/// `nodes` holds the node ids placed in this group (as strings, matching `PassiveTree.nodes` keys).
#[derive(Debug, Clone, Deserialize)]
pub struct TreeGroup {
    pub x: Option<f64>,
    pub y: Option<f64>,
    #[serde(default, deserialize_with = "de_flex_vec")]
    pub orbits: Vec<i64>,
    #[serde(default, deserialize_with = "de_flex_vec")]
    pub nodes: Vec<String>,
    #[serde(rename = "isProxy", default)]
    pub is_proxy: bool,
    #[serde(flatten)]
    pub extra: crate::fxhash::HashMap<String, J>,
}

/// A passive tree node, keyed by id (as a string) in `PassiveTree.nodes`. The special key
/// `"root"` is the tree's start node and has no `id`/`dn`/`icon`.
#[derive(Debug, Clone, Deserialize)]
pub struct TreeNode {
    pub id: Option<i64>,
    /// Display name (Lua `dn`).
    pub dn: Option<String>,
    pub icon: Option<String>,
    /// Group id; look the group up in `PassiveTree.groups` (Lua field `g`; the node's own
    /// `group` field is the same object already inlined there, kept out of this struct as a
    /// duplicate and left in `extra` as a `$ref`).
    #[serde(rename = "g")]
    pub group_id: Option<i64>,
    #[serde(rename = "o")]
    pub orbit: Option<i64>,
    #[serde(rename = "oidx")]
    pub orbit_index: Option<i64>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub angle: Option<f64>,
    /// Node ids this node connects to (Lua `out`).
    #[serde(rename = "out", default, deserialize_with = "de_flex_vec")]
    pub out_ids: Vec<String>,
    /// Node ids that connect to this node (Lua `in`).
    #[serde(rename = "in", default, deserialize_with = "de_flex_vec")]
    pub in_ids: Vec<String>,
    /// Stat description lines (Lua `sd`; `stats` is the same list under a second name).
    #[serde(default, deserialize_with = "de_flex_vec")]
    pub sd: Vec<String>,
    #[serde(rename = "isNotable", default)]
    pub is_notable: bool,
    #[serde(rename = "isKeystone", default)]
    pub is_keystone: bool,
    #[serde(rename = "isMastery", default)]
    pub is_mastery: bool,
    #[serde(rename = "isJewelSocket", default)]
    pub is_jewel_socket: bool,
    #[serde(rename = "isAscendancyStart", default)]
    pub is_ascendancy_start: bool,
    #[serde(rename = "ascendancyName")]
    pub ascendancy_name: Option<String>,
    /// `mods`, `modKey`, `masteryEffects` (for mastery nodes), `linkedId`, sprite/overlay data,
    /// and everything else that varies by node type.
    #[serde(flatten)]
    pub extra: crate::fxhash::HashMap<String, J>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PassiveTree {
    pub groups: HashMap<String, TreeGroup>,
    pub nodes: HashMap<String, TreeNode>,
    #[serde(rename = "orbitRadii", default, deserialize_with = "de_flex_vec")]
    pub orbit_radii: Vec<f64>,
    #[serde(rename = "skillsPerOrbit", default, deserialize_with = "de_flex_vec")]
    pub skills_per_orbit: Vec<f64>,
    pub min_x: Option<f64>,
    pub max_x: Option<f64>,
    pub min_y: Option<f64>,
    pub max_y: Option<f64>,
    #[serde(rename = "treeVersion")]
    pub tree_version: Option<String>,
    /// `classes`, `points`, `masteryEffects`, `constants`, sprite sheets, and ascendancy/keystone
    /// name lookup maps (the latter are `$ref`s into `nodes` once loaded elsewhere as `Value`).
    #[serde(flatten)]
    pub extra: crate::fxhash::HashMap<String, J>,
}
