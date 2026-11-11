// Port of Modules/CalcTools.lua's calcLib.mod/mods/val: tiny (2-6 line) helpers used constantly
// by CalcOffence.lua. Duplicated here rather than depending on the `calc` crate's own copy
// (crates/calc/src/tools.rs), so this crate stays buildable and gradable on its own.
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

pub fn syms(names: &[&str]) -> Vec<Sym> {
    names.iter().map(|n| Sym::new(n)).collect()
}

/// `calcLib.mod(modStore, cfg, ...)` = `(1 + Sum("INC",...)/100) * More(...)`.
pub fn calc_lib_mod(store: &ModStore, cfg: Option<&Cfg>, names: &[&str]) -> f64 {
    let s = syms(names);
    (1.0 + store.sum(pom_engine::modifier::ModType::Inc, cfg, &s) / 100.0) * store.more(cfg, &s)
}

/// `calc_lib_mod` with the names already interned (call sites with literal names pass `sym!`s).
pub fn calc_lib_mod_s(store: &ModStore, cfg: Option<&Cfg>, names: &[Sym]) -> f64 {
    (1.0 + store.sum(pom_engine::modifier::ModType::Inc, cfg, names) / 100.0) * store.more(cfg, names)
}

/// `calc_lib_mods` with the names already interned.
pub fn calc_lib_mods_s(store: &ModStore, cfg: Option<&Cfg>, names: &[Sym]) -> (f64, f64) {
    let inc = 1.0 + store.sum(pom_engine::modifier::ModType::Inc, cfg, names) / 100.0;
    let more = store.more(cfg, names);
    (inc, more)
}

/// `calcLib.mods(modStore, cfg, ...)` -> (increased, more), computed separately.
pub fn calc_lib_mods(store: &ModStore, cfg: Option<&Cfg>, names: &[&str]) -> (f64, f64) {
    let s = syms(names);
    let inc = 1.0 + store.sum(pom_engine::modifier::ModType::Inc, cfg, &s) / 100.0;
    let more = store.more(cfg, &s);
    (inc, more)
}

/// `calcLib.val(modStore, name, cfg)`: 0 when the BASE sum is 0 (skips INC/MORE entirely, unlike
/// `mod`, matching the Lua exactly - a skill with no base value for `name` must return 0, not
/// `0 * calc_lib_mod(...)` which could be nonzero if `more` includes an additive-only override
/// path; kept as a literal short-circuit to match).
pub fn calc_lib_val(store: &ModStore, name: &str, cfg: Option<&Cfg>) -> f64 {
    let s = [Sym::new(name)];
    let base = store.sum(pom_engine::modifier::ModType::Base, cfg, &s);
    if base != 0.0 {
        base * calc_lib_mod(store, cfg, &[name])
    } else {
        0.0
    }
}

/// `calcs.actionSpeedMod` (CalcPerform.lua:1141-1151). `tc_inc` = TemporalChainsActionSpeed INC sum, `cap` = TemporalChainsEffectCap (positive),
/// `min`/`max_red` = MinimumActionSpeed / MaximumActionSpeedReduction in percent.
pub fn action_speed_mod(tc_inc: f64, other_inc: f64, cap: f64, min: f64, max_red: Option<f64>) -> f64 {
    let tc = (-cap).max(tc_inc);
    let mut m = if crate::data::pom_fixes_on() {
        // Temporal Chains slow is its own _final multiplier; upstream adds it to the other action speed modifiers.
        (1.0 + other_inc / 100.0) * (1.0 + tc / 100.0)
    } else {
        1.0 + (tc + other_inc) / 100.0
    };
    m = m.max(min / 100.0);
    if let Some(r) = max_red {
        m = m.min((100.0 - r) / 100.0);
    }
    m
}

#[cfg(test)]
mod action_speed_tests {
    use super::action_speed_mod;

    #[test]
    fn tc_action_speed_is_final() {
        assert!((action_speed_mod(-29.0, -30.0, 75.0, 0.0, None) - 0.71 * 0.70).abs() < 1e-9);
        assert!((action_speed_mod(0.0, -30.0, 75.0, 0.0, None) - 0.70).abs() < 1e-9);
    }
}
