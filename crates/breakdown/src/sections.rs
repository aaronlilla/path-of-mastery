//! Typed model of `data/calc_sections.json`, a data dump of `Modules/CalcSections.lua`'s
//! returned table, dumped once from the Lua source. CalcSections.lua has zero embedded Lua functions (no
//! `= function` assignments anywhere in the file, confirmed by grep), so dumping it as data loses
//! nothing: every row/cell field it defines is a plain literal, and the file's *behavior* --
//! which rows are visible, and what text they render -- lives entirely in this crate's own
//! `checkflag.rs` / `format.rs`, ported from `Classes/CalcsTab.lua`'s `CheckFlag` and
//! `Modules/CalcFormat.lua`, which DO run as real Rust code here, not baked into the JSON.
use serde::Deserialize;

#[derive(Deserialize, Debug, Clone)]
pub struct Section {
    pub width: i32,
    pub id: String,
    pub group: i32,
    /// The section's colour code (`^xRRGGBB`).
    #[serde(default)]
    pub colour: Option<String>,
    #[serde(rename = "subSections")]
    pub sub_sections: Vec<SubSection>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct SubSection {
    pub label: String,
    #[serde(rename = "defaultCollapsed")]
    pub default_collapsed: bool,
    pub flag: Option<String>,
    #[serde(rename = "notFlag")]
    pub not_flag: Option<String>,
    pub extra: Option<String>,
    pub rows: Vec<Row>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Row {
    pub label: Option<String>,
    /// The row's background and text colour codes and its text size, when it sets them.
    #[serde(default, rename = "bgCol")]
    pub bg_col: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default, rename = "textSize")]
    pub text_size: Option<f64>,
    pub flag: Option<String>,
    #[serde(rename = "notFlag")]
    pub not_flag: Option<String>,
    #[serde(rename = "playerFlag")]
    pub player_flag: Option<String>,
    #[serde(rename = "haveOutput")]
    pub have_output: Option<String>,
    #[serde(rename = "flagList")]
    pub flag_list: Option<Vec<String>>,
    #[serde(rename = "notFlagList")]
    pub not_flag_list: Option<Vec<String>>,
    pub cells: Vec<Cell>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Cell {
    pub format: Option<String>,
    pub flag: Option<String>,
    #[serde(rename = "notFlag")]
    pub not_flag: Option<String>,
    #[serde(rename = "haveOutput")]
    pub have_output: Option<String>,
    pub details: Vec<Detail>,
}

/// One `CalcSectionEntry`: a `{p:mod:i,j,...}` placeholder in a cell's `format` string indexes
/// into this cell's `details` (1-based, Lua array convention).
#[derive(Deserialize, Debug, Clone)]
pub struct Detail {
    pub label: Option<String>,
    pub breakdown: Option<String>,
    #[serde(rename = "modType")]
    pub mod_type: Option<String>,
    pub cfg: Option<String>,
    pub enemy: bool,
    pub actor: Option<String>,
    #[serde(rename = "modSource")]
    pub mod_source: Option<String>,
    #[serde(rename = "modName")]
    pub mod_name: Option<Vec<String>>,
    /// The entry's own `CheckFlag` fields (`CalcBreakdownControl:SetBreakdownData` skips an entry that fails them).
    #[serde(default)]
    pub flag: Option<String>,
    #[serde(default, rename = "notFlag")]
    pub not_flag: Option<String>,
    #[serde(default, rename = "playerFlag")]
    pub player_flag: Option<String>,
    #[serde(default, rename = "haveOutput")]
    pub have_output: Option<String>,
    #[serde(default, rename = "flagList")]
    pub flag_list: Option<Vec<String>>,
    #[serde(default, rename = "notFlagList")]
    pub not_flag_list: Option<Vec<String>>,
    /// The slots table shows only gear sources (armour, evasion and energy shield breakdowns of the item rows).
    #[serde(default, rename = "gearOnly")]
    pub gear_only: bool,
}

pub fn load() -> Vec<Section> {
    const RAW: &str = include_str!("../data/calc_sections.json");
    serde_json::from_str(RAW).expect("crates/breakdown/data/calc_sections.json must parse")
}
