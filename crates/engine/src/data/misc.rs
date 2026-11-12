//! Typed shape of `data_misc.json` (Lua `data.misc`): a flat table of numeric constants
//! (resist caps, base regen rates, and the like). All 60 current keys are numbers, so this loads
//! straight into a map instead of a fixed struct; add named accessors here if particular
//! constants need compile-time checked names later.

use serde::Deserialize;
use crate::fxhash::HashMap;
use std::ops::Deref;

#[derive(Debug, Clone, Deserialize)]
#[serde(transparent)]
pub struct MiscConstants(pub HashMap<String, f64>);

impl Deref for MiscConstants {
    type Target = HashMap<String, f64>;
    fn deref(&self) -> &HashMap<String, f64> {
        &self.0
    }
}

impl MiscConstants {
    pub fn get(&self, key: &str) -> Option<f64> {
        self.0.get(key).copied()
    }
}
