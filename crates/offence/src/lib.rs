//! Rust port of Modules/CalcOffence.lua (`calcs.offence`, `calcs.calcTotemLife`), graded in
//! isolation against recordings from upstream (the offence answer keys). Named gaps are noted
//! at the code they affect.
//!
//! Isolation layer: everything here reads its skill/actor/env state through the small structs in
//! `input.rs` (`SkillView`, plus `pom_engine::modstore::store::ModStore` directly for modDBs),
//! never through a concrete `Env`/`Actor`/`ActiveSkill` from the still-in-progress `calc` crate.
//! When `calc` is ready to drive this crate for real, it only needs to build a `SkillView` and
//! pass its own `ModStore`s - nothing in `tools`/`area`/`conversion`/`cooldown`/`misc_fields`
//! changes.

pub mod ailments;
pub mod area;
pub mod bd;
pub mod bd_c;
pub mod bd_d;
pub mod bdail;
pub mod bdbuild;
pub mod bdg;
pub mod basedamage;
pub mod conversion;
pub mod cooldown;
pub mod costs;
pub mod crit;
pub mod data;
pub mod dot;
pub mod hit;
pub mod hitdmg;
pub mod impale;
pub mod input;
pub mod leech;
pub mod misc_fields;
pub mod speed;
pub mod tools;
pub mod weapon;

thread_local! {
    /// True while the Calcs tab's calculation runs (`env.mode == "CALCS"` in upstream): the outputs CalcOffence writes
    /// only for that mode (`<Type>EffMult`, `<Type>Min`, `<Type>Max`, `DisplayDamage`) are produced too. Off for every
    /// other calculation, so the main stats are unchanged.
    pub static CALCS_MODE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
