//! Calcs-mode breakdown tables of `calcs.defence` and `calcs.resistances` (Modules/CalcDefence.lua 512-1673).
//! Each function writes the table upstream writes at the same line, from the values the Rust code already has. The
//! writes go through `pom_offence::bd`: `bd::root` is `actor.breakdown` and is a no-op unless the Calcs mode is on.
use crate::tools::val;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_offence::bd::{self, ins_s, num, s, set};
use pom_offence::bdbuild::{self, Chain, Link};
use pom_offence::sf;
use serde_json::Value;

fn syms(names: &[&str]) -> Vec<Sym> {
    names.iter().map(|n| Sym::new(n)).collect()
}

/// `breakdown[key] = { lines }`.
pub fn put_lines(key: &str, lines: Vec<String>) {
    bd::root(|b| set(b, key, Value::Array(lines.into_iter().map(Value::String).collect())));
}

/// `breakdown[key] = nil-or-table` for the result of a breakdown function.
pub fn put_opt(key: &str, v: Option<Value>) {
    if let Some(v) = v {
        bd::root(|b| set(b, key, v));
    }
}

/// `breakdown[key] = { }` followed by `breakdown.multiChain(breakdown[key], chain)`.
pub fn put_chain(key: &str, chain: &Chain) {
    bd::root(|b| {
        let t = bd::reset(b, key);
        bdbuild::multi_chain(t, chain);
    });
}

/// `t_insert(breakdown[key], line)`.
pub fn push(key: &str, line: String) {
    bd::root(|b| {
        let t = bd::t(b, key);
        ins_s(t, line);
    });
}

/// calcs.resistances, lines 635-648.
pub fn resist(elem: &str, min: f64, max: f64, total: f64, totem_max: f64, totem_total: f64) {
    if !bd::on() {
        return;
    }
    put_lines(
        &format!("{elem}Resist"),
        vec![format!("Min: {}%", bd::tostr(min)), format!("Max: {}%", bd::tostr(max)), format!("Total: {}%", bd::tostr(total))],
    );
    put_lines(
        &format!("Totem{elem}Resist"),
        vec![format!("Min: {}%", bd::tostr(min)), format!("Max: {}%", bd::tostr(totem_max)), format!("Total: {}%", bd::tostr(totem_total))],
    );
}

/// Lines 736-747 (before the CannotBlock overrides).
pub fn block(base_block_chance: f64, max: f64, block: f64, over: f64, spell_max: f64, spell: f64, spell_over: f64) {
    if !bd::on() {
        return;
    }
    put_lines(
        "BlockChance",
        vec![format!("Base: {}%", bd::tostr(base_block_chance)), format!("Max: {}%", bd::tostr(max)), format!("Total: {}%", bd::tostr(block + over))],
    );
    put_lines("SpellBlockChance", vec![format!("Max: {}%", bd::tostr(spell_max)), format!("Total: {}%", bd::tostr(spell + spell_over))]);
}

/// Lines 851-856: `breakdown.Ward = { slots = { } }` and the three siblings.
pub fn slots_init() {
    bd::root(|b| {
        for k in ["Ward", "EnergyShield", "Armour", "Evasion"] {
            let mut m = serde_json::Map::new();
            m.insert("slots".into(), Value::Array(vec![]));
            set(b, k, Value::Object(m));
        }
    });
}

fn push_slot(key: &str, row: Value) {
    bd::root(|b| {
        let t = bd::t(b, key);
        let sl = bd::t(t, "slots");
        bd::ins(sl, row);
    });
}

fn inc_str(inc: f64) -> Value {
    if inc != 0.0 {
        s(sf!(" x %.2f", 1.0 + inc / 100.0))
    } else {
        Value::Bool(false)
    }
}
fn more_str(more: f64) -> Value {
    if more != 1.0 {
        s(sf!(" x %.2f", more))
    } else {
        Value::Bool(false)
    }
}

/// The hand-written `t_insert(breakdown[key].slots, { base, inc, more, total, source, item })` rows.
pub fn slot_row(key: &str, base: f64, inc: Option<f64>, more: f64, total: f64, source: &str, has_item: bool) {
    if !bd::on() {
        return;
    }
    let mut m = serde_json::Map::new();
    m.insert("base".into(), num(base));
    if let Some(inc) = inc {
        m.insert("inc".into(), inc_str(inc));
    }
    m.insert("more".into(), more_str(more));
    m.insert("total".into(), s(sf!("%.2f", total)));
    m.insert("source".into(), s(source));
    if has_item {
        m.insert("item".into(), s("<obj>"));
    }
    push_slot(key, Value::Object(m));
}

/// `breakdown.slot(source, sourceName, cfg, base, total, ...)` (CalcBreakdown.lua).
#[allow(clippy::too_many_arguments)]
pub fn slot(store: &ModStore, source: &str, source_name: Option<&str>, cfg: Option<&Cfg>, base: f64, total: Option<f64>, names: &[&str], has_item: bool) {
    if !bd::on() {
        return;
    }
    let sy = syms(names);
    let inc = store.sum(ModType::Inc, cfg, &sy);
    let more = store.more(cfg, &sy);
    let mut m = serde_json::Map::new();
    m.insert("base".into(), num(base));
    m.insert("inc".into(), inc_str(inc));
    m.insert("more".into(), more_str(more));
    m.insert("total".into(), s(sf!("%.2f", total.unwrap_or(base * (1.0 + inc / 100.0) * more))));
    m.insert("source".into(), s(source));
    if let Some(n) = source_name {
        m.insert("sourceName".into(), s(n));
    }
    if has_item {
        m.insert("item".into(), s("<obj>"));
    }
    push_slot(names[0], Value::Object(m));
}

fn level_lines(env_level: f64, overridden: bool, accuracy: f64) -> Vec<String> {
    vec![
        sf!("Enemy level: %d ^8(%s the Configuration tab)", env_level, if overridden { "overridden from" } else { "can be overridden in" }),
        sf!("Average enemy accuracy: %d", accuracy),
    ]
}

/// Lines 1115-1135.
#[allow(clippy::too_many_arguments)]
pub fn evade(env_level: f64, overridden: bool, accuracy: f64, evade: f64, melee_stat: f64, melee: f64, proj_stat: f64, proj: f64) {
    if !bd::on() {
        return;
    }
    let mut a = level_lines(env_level, overridden, accuracy);
    a.push(sf!("Approximate evade chance: %d%%", evade));
    put_lines("EvadeChance", a);
    let mut m = level_lines(env_level, overridden, accuracy);
    m.push(sf!("Effective Evasion: %d", melee_stat));
    m.push(sf!("Approximate melee evade chance: %d%%", melee));
    put_lines("MeleeEvadeChance", m);
    let mut p = level_lines(env_level, overridden, accuracy);
    p.push(sf!("Effective Evasion: %d", proj_stat));
    p.push(sf!("Approximate projectile evade chance: %d%%", proj));
    put_lines("ProjectileEvadeChance", p);
}

/// Lines 1198-1210.
pub fn dodge(attack_total: f64, attack_max: f64, attack: f64, attack_over: f64, spell_total: f64, spell_max: f64, spell: f64, spell_over: f64) {
    if !bd::on() {
        return;
    }
    put_lines(
        "AttackDodgeChance",
        vec![format!("Base: {}%", bd::tostr(attack_total)), format!("Max: {}%", bd::tostr(attack_max)), format!("Total: {}%", bd::tostr(attack + attack_over))],
    );
    put_lines(
        "SpellDodgeChance",
        vec![format!("Base: {}%", bd::tostr(spell_total)), format!("Max: {}%", bd::tostr(spell_max)), format!("Total: {}%", bd::tostr(spell + spell_over))],
    );
}

/// Lines 1228-1252.
pub fn leech_caps(store: &ModStore, life: f64, life_pct: f64, life_rate: f64, es: f64, es_rate: f64, mana: f64, mana_rate: f64) {
    if !bd::on() {
        return;
    }
    put_lines(
        "MaxLifeLeechRate",
        vec![sf!("%d ^8(maximum life)", life), sf!("x %d%% ^8(percentage of life to maximum leech rate)", life_pct), sf!("= %.1f", life_rate)],
    );
    put_lines(
        "MaxEnergyShieldLeechRate",
        vec![
            sf!("%d ^8(maximum energy shield)", es),
            sf!("x %d%% ^8(percentage of energy shield to maximum leech rate)", val(store, Sym::new("MaxEnergyShieldLeechRate"), None)),
            sf!("= %.1f", es_rate),
        ],
    );
    put_lines(
        "MaxManaLeechRate",
        vec![sf!("%d ^8(maximum mana)", mana), sf!("x %d%% ^8(percentage of mana to maximum leech rate)", val(store, Sym::new("MaxManaLeechRate"), None)), sf!("= %.1f", mana_rate)],
    );
}

/// Lines 1318-1339: `breakdown[resource.."RegenRecovery"]`.
#[allow(clippy::too_many_arguments)]
pub fn regen_recovery(store: &ModStore, resource: &str, resource_name: &str, base_regen: f64, inc: f64, more: f64, recovery_rate_mod: f64, regen_rate: f64, degen_rate: f64, recovery_rate: f64, regen_recovery: f64) {
    if !bd::on() {
        return;
    }
    let key = format!("{resource}RegenRecovery");
    let mut c = Chain::new();
    c.label = Some(format!("{resource_name} Regeneration:"));
    c.base = Some(Link::n("%.1f ^8(base)", base_regen));
    c.links = vec![Link::n("%.2f ^8(increased/reduced)", 1.0 + inc / 100.0), Link::n("%.2f ^8(more/less)", more), Link::n("%.2f ^8(recovery rate modifier)", recovery_rate_mod)];
    c.total = Some(sf!("= %.1f ^8per second", regen_rate));
    put_chain(&key, &c);
    let unaffected = store.flag(None, &[Sym::new(&format!("UnaffectedBy{resource}Regen"))]);
    if unaffected {
        push(&key, format!("Unaffected by {resource_name} Regen"));
    }
    if degen_rate != 0.0 {
        push(&key, sf!("- %.1f ^8(degen)", degen_rate));
        push(&key, sf!("= %.1f ^8per second", (if unaffected { 0.0 } else { regen_rate }) - degen_rate));
    }
    if recovery_rate != 0.0 {
        push(&key, sf!("+ %.1f ^8(recovery)", recovery_rate));
        push(&key, sf!("= %.1f ^8per second", regen_recovery));
    }
}

/// Lines 1353-1387 (`LifeRecharge` / `EnergyShieldRecharge`).
pub fn recharge(key: &str, pool: f64, base: f64, inc: f64, more: f64, recharge: f64, recovery_rate_mod: f64, final_: f64) {
    if !bd::on() {
        return;
    }
    let mut c = Chain::new();
    c.label = Some("Recharge rate:".into());
    c.base = Some(Link { fmt: "%.1f ^8(%d%% per second)", args: vec![(pool * base).into(), (base * 100.0).into()], value: Some(pool * base) });
    c.links = vec![Link::n("%.2f ^8(increased/reduced)", 1.0 + inc / 100.0), Link::n("%.2f ^8(more/less)", more)];
    c.total = Some(sf!("= %.1f ^8per second", recharge));
    bd::root(|b| {
        let t = bd::reset(b, key);
        bdbuild::multi_chain(t, &c);
        let mut c2 = Chain::new();
        c2.label = Some("Effective Recharge rate:".into());
        c2.base = Some(Link::n("%.1f", recharge));
        c2.links = vec![Link::n("%.2f ^8(recovery rate modifier)", recovery_rate_mod)];
        c2.total = Some(sf!("= %.1f ^8per second", final_));
        bdbuild::multi_chain(t, &c2);
    });
}

/// Lines 1390-1397 / 1524-1534 (`EnergyShieldRechargeDelay`, `WardRechargeDelay`).
pub fn recharge_delay(key: &str, base: f64, faster_inc: f64, delay: f64) {
    if !bd::on() {
        return;
    }
    if delay != base {
        put_lines(key, vec![sf!("%.2fs ^8(base)", base), sf!("/ %.2f ^8(faster start)", 1.0 + faster_inc / 100.0), sf!("= %.2fs", delay)]);
    }
}

/// Lines 1431-1444 / 1466-1478: one `<Type>Recoup` table. `base_only` is the first (all-damage) variant, which has its own
/// ending for an unmodified recovery rate.
#[allow(clippy::too_many_arguments)]
pub fn recoup(key: &str, base_recoup: f64, recoup_inc: f64, recoup_more: f64, recovery_rate_mod: f64, value: f64, three_sec: bool, plain_variant: bool) {
    if !bd::on() {
        return;
    }
    let secs = if three_sec { 3 } else { 4 };
    let mut l = vec![sf!("%d%% ^8(base)", base_recoup)];
    if recoup_inc != 1.0 {
        l.push(sf!("x %.2f (increased/reduced)", recoup_inc));
    }
    if recoup_more != 1.0 {
        l.push(sf!("x %.2f (more/less)", recoup_more));
    }
    if recovery_rate_mod != 1.0 {
        l.push(sf!("* %.2f ^8(recovery rate modifier)", recovery_rate_mod));
        l.push(sf!("= %.1f%% over %d seconds", value, secs));
    } else if plain_variant {
        l.push(sf!("%.1f%% over %d seconds", value, secs));
    } else {
        l.push(sf!("= %.1f%% over %d seconds", value, secs));
    }
    put_lines(key, l);
}

/// Lines 1504-1516.
pub fn pseudo_recoup(resource: &str, base: f64, inc: f64, more: f64, recovery_rate_mod: f64, value: f64, duration: f64) {
    if !bd::on() {
        return;
    }
    let key = format!("PhysicalDamageMitigated{resource}PseudoRecoup");
    let mut l: Vec<String> = vec![];
    if recovery_rate_mod != 1.0 || inc != 0.0 || more != 1.0 {
        l.push(sf!("%d%% ^8(base)", base));
        if inc != 0.0 || more != 1.0 {
            l.push(sf!("* %.2f ^8(regeneration rate modifier)", (1.0 + inc / 100.0) * more));
        }
        if recovery_rate_mod != 1.0 {
            l.push(sf!("* %.2f ^8(recovery rate modifier)", recovery_rate_mod));
        }
    }
    l.push(sf!("= %.1f%% over %d seconds", value, duration));
    put_lines(&key, l);
}

/// Lines 1548-1555.
pub fn effective_movement_speed(movement: f64, action: f64, effective: f64) {
    if !bd::on() {
        return;
    }
    let mut c = Chain::new();
    c.links = vec![Link::n("%.2f ^8(movement speed modifier)", movement), Link::n("%.2f ^8(action speed modifier)", action)];
    c.total = Some(sf!("= %.2f ^8(effective movement speed modifier)", effective));
    put_chain("EffectiveMovementSpeedMod", &c);
}

/// Line 1633.
pub fn light_radius(store: &ModStore) {
    if !bd::on() {
        return;
    }
    put_opt("LightRadiusMod", bdbuild::mod_(store, None, &["LightRadius"]));
}
