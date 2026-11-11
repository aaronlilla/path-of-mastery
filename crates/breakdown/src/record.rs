//! One recorded build as the breakdown renderer reads it (the loader for the recorder's JSONL is in the parity crate).
use crate::modmatch::store::ModStore;
use crate::modmatch::types::Cfg;
use serde_json::Value as J;
use std::collections::HashMap;
use std::sync::Arc;

/// One recorded build: the mod stores + cfgs + skillFlags needed to independently re-derive row
/// text, and `sections` (the ground truth `formatCalcStr` output to grade against).
#[derive(Clone)]
pub struct BreakdownBuild {
    pub name: String,
    pub player_store: Arc<ModStore>,
    pub skill_mod_list_store: Option<Arc<ModStore>>,
    pub enemy_store: Option<Arc<ModStore>>,
    pub cfgs: HashMap<String, Cfg>,
    pub skill_flags: HashMap<String, bool>,
    pub sections: J,
    /// The player actor's raw `output` JSON object (numbers *and* strings -- some entries, e.g.
    /// `DisplayDamage`, are pre-formatted strings computed by the unported Perform stage, not
    /// numbers; `format.rs`'s `{output:Key}` case (no leading `{p:...}`) passes such a value
    /// through untouched, exactly like `actor.output[c] or ""` does in CalcFormat.lua). Kept
    /// separate from `modmatch::Actor.output` (which `EvalMod`'s `GetStat` needs as numeric-only)
    /// since this crate's own CalcFormat port needs the raw shape instead.
    pub player_output: J,
    /// (section id, subsection index) -> `subSec.collapsed` *as actually loaded for this build*.
    /// `subSec.collapsed` starts at CalcSections.lua's `defaultCollapsed` but this build's own
    /// saved XML can override it per subsection (`CalcsTabClass:Load`'s `<Section collapsed=...>`
    /// restore) -- this crate treats that the same as any other recorded build fact (skillFlags,
    /// output), not something it re-derives, since re-parsing the saved-XML UI-state block is out
    /// of this crate's scope (CalcSections/CalcBreakdown/CalcFormat never read it themselves).
    pub collapsed: HashMap<(String, usize), bool>,
}
