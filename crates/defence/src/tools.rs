//! Small pure helpers `Modules/CalcDefence.lua` calls into from `Modules/CalcTools.lua` and
//! `Modules/Common.lua`. Re-implemented here (not imported from `crates/calc`) since this crate
//! depends only on `pom-engine`.
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

/// `calcLib.mod(modStore, cfg, ...)`: combined INC/MORE multiplier.
pub fn mod_(store: &ModStore, cfg: Option<&Cfg>, names: &[Sym]) -> f64 {
    (1.0 + store.sum(pom_engine::modifier::ModType::Inc, cfg, names) / 100.0) * store.more(cfg, names)
}

/// `calcLib.val(modStore, name, cfg)`.
pub fn val(store: &ModStore, name: Sym, cfg: Option<&Cfg>) -> f64 {
    let base = store.sum(pom_engine::modifier::ModType::Base, cfg, &[name]);
    if base != 0.0 {
        base * mod_(store, cfg, &[name])
    } else {
        0.0
    }
}

/// Lua global `round(val)`: `math.floor(val + 0.5)`, unconditionally (not symmetric).
pub fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}
/// Lua global `round(val, dec)`.
pub fn round_dec(v: f64, dec: i32) -> f64 {
    let mult = 10f64.powi(dec);
    (v * mult + 0.5).floor() / mult
}
/// Lua global `floor(val, dec)`.
pub fn floor_dec(v: f64, dec: i32) -> f64 {
    let mult = 10f64.powi(dec);
    (v * mult + 0.0001).floor() / mult
}
/// Lua `math.modf`, integral part only (truncation toward zero) - used by `calcs.resistances` to
/// truncate fractional resistances.
pub fn modf_int(v: f64) -> f64 {
    v.trunc()
}
