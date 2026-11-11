//! ModStore/ModList/ModDB query engine (Sum/More/Flag/Override/List/Combine + EvalMod's tag
//! matching), mirrored from `crates/engine/src/modstore` rather than depended on: this crate is
//! a leaf (serde/serde_json only) that still needs the
//! *same* live modDB queries `CalcFormat.lua`'s `{p:mod:...}` placeholder and
//! `CalcBreakdown.lua`'s `breakdown.simple`/`breakdown.mod` functions make at render time.
//!
//! `eval.rs`, `store.rs` and `types.rs` are copies of `crates/engine/src/modstore/{eval,store,
//! types}.rs` (only `crate::modstore::*` paths rewritten to `crate::modmatch::*`), because that
//! module is already a faithful port of `Classes/ModStore.lua`'s `EvalMod`/`Sum`/`More`/etc, and
//! re-deriving the same ~1000 lines from the Lua would risk reintroducing bugs that file already
//! fixed. Keep both copies in sync by hand if `crates/engine`'s modstore changes; do not import
//! `pom-engine` here (this crate must stay a leaf).
pub mod eval;
pub mod store;
pub mod types;

pub use eval::eval_mod;
pub use store::{match_keyword_flags, ModStore, StatSyms};
pub use types::{Actor, Cfg, GemInfo, ItemInfo};
