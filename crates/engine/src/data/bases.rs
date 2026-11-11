//! Typed shape of `data_itemBases.json` (Lua `data.itemBases`, keyed by base name, e.g.
//! "Rusted Sword").

use crate::data::flex::de_flex_vec;
use serde::Deserialize;
use crate::cjson::J;
use crate::fxhash::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct ItemBase {
    #[serde(rename = "type")]
    pub base_type: Option<String>,
    #[serde(rename = "socketLimit")]
    pub socket_limit: Option<i64>,
    #[serde(default)]
    pub tags: HashMap<String, bool>,
    pub implicit: Option<String>,
    #[serde(rename = "implicitIds", default, deserialize_with = "de_flex_vec")]
    pub implicit_ids: Vec<String>,
    pub req: Option<HashMap<String, f64>>,
    /// Present on weapon bases: PhysicalMin/Max, CritChanceBase, AttackRateBase, Range, ...
    pub weapon: Option<HashMap<String, f64>>,
    /// Present on armour bases: Armour/Evasion/EnergyShield, ...
    pub armour: Option<HashMap<String, f64>>,
    /// `influenceTags`, `implicitModTypes`, flask/socket data, and other fields that vary by
    /// item type.
    #[serde(flatten)]
    pub extra: crate::fxhash::HashMap<String, J>,
}
