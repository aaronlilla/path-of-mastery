//! Calcs-mode breakdown tables written by CalcPerform.lua / Calcs.lua (the Perform stage): attributes, Life and Mana
//! pools, reservations, attribute requirements, main-skill gem level and quality, the buff / debuff lists.
//! Same idea as the offence tables (`pom_offence::bd`): every function is a no-op unless the Calcs mode is on, and each one
//! copies upstream's lines, including the text of every line and its number format.
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;
use pom_offence::bd::{self, ins_s, s};
use pom_offence::sf;
use serde_json::Value;

fn sy(n: &str) -> Sym {
    Sym::new(n)
}

thread_local! {
    /// The Perform-stage tables are written: the Calcs mode is on and this `run` is the real actor's own (depth 1, not a
    /// FullDPS copy). Unlike `bd::on()` it stays true between the offence passes, so the code after them can still write.
    static PERFORM_ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub fn perform_on() -> bool {
    PERFORM_ON.with(|c| c.get())
}

/// `bd::root` for the Perform tables: turns the offence writes' gate on for the duration of the call.
fn root<R>(f: impl FnOnce(&mut Value) -> R) -> Option<R> {
    if !perform_on() {
        return None;
    }
    let was = bd::set_active(true);
    let r = bd::root(f);
    bd::set_active(was);
    r
}

/// The trigger tables are written: the real actor's own `calcs.triggers`, not a FullDPS copy's or a cache-building pass's.
pub fn trigger_tables_on() -> bool {
    perform_on() && crate::buffs::FULLDPS_PARENT.with(|p| p.borrow().is_none()) && !crate::triggers_wire::NESTED.with(|n| n.get())
}

/// The tables `calcs.triggers` wrote (CalcTriggers.lua), into the player's or the minion's table.
pub fn trigger_tables(a: &crate::triggers_wire::TrigApply, minion: bool) {
    if !trigger_tables_on() || a.result.tables.is_empty() {
        return;
    }
    if minion {
        bd::select_actor(1);
    }
    for (k, v) in &a.result.tables {
        root(|b| bd::set(b, k, v.clone()));
    }
    if minion {
        bd::select_actor(0);
    }
}

/// Marks the real actor's `run` for the whole of the function.
pub struct PerformScope(Option<bool>);

impl PerformScope {
    pub fn enter() -> PerformScope {
        let on = bd::calcs_mode() && crate::buffs::FULLDPS_PARENT.with(|p| p.borrow().is_none()) && bd::run_depth() <= 1;
        if on {
            cap_reset();
        }
        PerformScope(Some(PERFORM_ON.with(|c| c.replace(on))))
    }
}

impl Drop for PerformScope {
    fn drop(&mut self) {
        if let Some(was) = self.0 {
            PERFORM_ON.with(|c| c.set(was));
        }
    }
}

/// `breakdown[stat] = breakdown.simple(nil, nil, output[stat], stat)` for Str, Dex and Int (CalcPerform.lua:415-416),
/// written to the table of the actor `store` belongs to (the caller picked it with `bd::select_actor`).
pub fn attribute_tables(store: &ModStore, str_: f64, dex: f64, int_: f64) {
    for (stat, total) in [("Str", str_), ("Dex", dex), ("Int", int_)] {
        attribute_table(store, stat, total);
    }
}

/// One `breakdown[stat] = breakdown.simple(nil, nil, output[stat], stat)` (also "Omni", CalcPerform.lua:481).
pub fn attribute_table(store: &ModStore, stat: &str, total: f64) {
    if !perform_on() {
        return;
    }
    // `breakdown[stat] = <nil>` leaves the key out of the table
    match pom_offence::bdbuild::simple(store, None, None, total, &[stat]) {
        Some(v) => {
            root(|b| bd::set(b, stat, v));
        }
        None => {
            root(|b| {
                if let Value::Object(m) = b {
                    m.remove(stat);
                }
            });
        }
    }
}

/// `doActorLifeMana`'s Life and Mana tables (CalcPerform.lua:94-130). `life` / `mana` are the outputs just computed.
pub fn life_mana_tables(store: &ModStore, life: f64, mana: f64) {
    if !perform_on() {
        return;
    }
    let lf = [sy("Life")];
    if !store.flag(None, &[sy("ChaosInoculation")]) {
        let base = store.sum(ModType::Base, None, &lf);
        let inc = store.sum(ModType::Inc, None, &lf);
        let more = store.more(None, &lf);
        let override_ = store.override_(None, &lf).and_then(|v| v.num());
        let conv = store.sum(ModType::Base, None, &[sy("LifeConvertToEnergyShield")]);
        if inc != 0.0 || more != 1.0 || conv != 0.0 || override_.is_some() {
            let mut t = Value::Array(vec![]);
            ins_s(&mut t, sf!("%g ^8(base)", base));
            if inc != 0.0 {
                ins_s(&mut t, sf!("x %.2f ^8(increased/reduced)", 1.0 + inc / 100.0));
            }
            if more != 1.0 {
                ins_s(&mut t, sf!("x %.2f ^8(more/less)", more));
            }
            if let Some(o) = override_ {
                ins_s(&mut t, sf!("= %g ^8(life override)", o));
            }
            ins_s(&mut t, sf!("= %g", life));
            root(|b| bd::set(b, "Life", t));
        }
    }
    let mana_conv = store.sum(ModType::Base, None, &[sy("ManaConvertToArmour")]);
    let mn = [sy("Mana")];
    let base = store.sum(ModType::Base, None, &mn);
    let inc = store.sum(ModType::Inc, None, &mn);
    let more = store.more(None, &mn);
    if inc != 0.0 || more != 1.0 || mana_conv != 0.0 {
        let mut t = Value::Array(vec![]);
        ins_s(&mut t, sf!("%g ^8(base)", base));
        if inc != 0.0 {
            ins_s(&mut t, sf!("x %.2f ^8(increased/reduced)", 1.0 + inc / 100.0));
        }
        if more != 1.0 {
            ins_s(&mut t, sf!("x %.2f ^8(more/less)", more));
        }
        if mana_conv != 0.0 {
            ins_s(&mut t, sf!("x %.2f ^8(converted to Armour)", 1.0 - mana_conv / 100.0));
        }
        ins_s(&mut t, sf!("= %g", mana));
        root(|b| bd::set(b, "Mana", t));
    }
}

/// The main skill's GemLevel and GemQuality tables (CalcPerform.lua:3948-3984). `store` is the main skill's mod list.
pub fn gem_tables(store: &ModStore, cfg: &Cfg, level: f64, quality: f64) {
    if !perform_on() {
        return;
    }
    let sum = |n: &str| store.sum(ModType::Base, Some(cfg), &[sy(n)]);
    let mut t = Value::Array(vec![]);
    let (base, item, support) = (sum("GemLevel"), sum("GemItemLevel"), sum("GemSupportLevel"));
    ins_s(&mut t, sf!("%d ^8(level from gem)", base));
    if support > 0.0 {
        ins_s(&mut t, sf!("+ %d ^8(level from support)", support));
    }
    if item > 0.0 {
        ins_s(&mut t, sf!("+ %d ^8(level from items)", item));
    }
    ins_s(&mut t, sf!("= %d", level));
    root(|b| bd::set(b, "GemLevel", t));
    let mut t = Value::Array(vec![]);
    let (base, item, support, socket) = (sum("GemQuality"), sum("GemItemQuality"), sum("GemSupportQuality"), sum("GemSocketQuality"));
    ins_s(&mut t, sf!("%d ^8(quality from gem)", base));
    if support > 0.0 {
        ins_s(&mut t, sf!("+ %d ^8(quality from support)", support));
    }
    if item > 0.0 {
        ins_s(&mut t, sf!("+ %d ^8(quality from items)", item));
    }
    if socket > 0.0 {
        ins_s(&mut t, sf!("+ %d ^8(quality from socket)", socket));
    }
    ins_s(&mut t, sf!("= %d", quality));
    root(|b| bd::set(b, "GemQuality", t));
}

// ---------------------------------------------------------------------------------------------------------------------
// Calcs.lua:762-860: breakdown.SkillBuffs / SkillDebuffs, built from `env.buffs`, `env.minionBuffs`, `env.debuffs` and
// `env.curseSlots` once the whole calculation is done.
// ---------------------------------------------------------------------------------------------------------------------

use pom_engine::modifier::Mod;
use std::cell::RefCell;

#[derive(Default)]
struct Cap {
    buffs: Vec<(String, Vec<Mod>)>,
    minion: Vec<(String, Vec<Mod>)>,
    debuffs: Vec<(String, Vec<Mod>)>,
    curse_slot_mods: Vec<Vec<Mod>>,
    curse_slot_names: Vec<String>,
}

thread_local! {
    static CAP: RefCell<Cap> = RefCell::new(Cap::default());
}

fn cap_reset() {
    CAP.with(|c| *c.borrow_mut() = Cap::default());
}

/// `env.buffs` (the player's buffs by name) as the buff loop leaves it.
pub fn cap_buffs<'a>(it: impl Iterator<Item = (&'a String, &'a Vec<Mod>)>) {
    if !perform_on() {
        return;
    }
    let v: Vec<(String, Vec<Mod>)> = it.map(|(k, m)| (k.clone(), m.clone())).collect();
    CAP.with(|c| c.borrow_mut().buffs = v);
}

/// `mergeBuff(src, minionBuffs, name)`: adds `mods` to `env.minionBuffs[name]`.
pub fn cap_minion(name: &str, mods: &[Mod]) {
    if !perform_on() {
        return;
    }
    CAP.with(|c| {
        let mut c = c.borrow_mut();
        let idx = c.minion.iter().position(|(n, _)| n == name).unwrap_or_else(|| {
            c.minion.push((name.to_string(), Vec::new()));
            c.minion.len() - 1
        });
        pom_calc::perform::merge_buff(&mut c.minion[idx].1, mods);
    });
}

/// `env.debuffs` (the enemy's debuffs by name).
pub fn cap_debuffs<'a>(it: impl Iterator<Item = (&'a String, &'a Vec<Mod>)>) {
    if !perform_on() {
        return;
    }
    let v: Vec<(String, Vec<Mod>)> = it.map(|(k, m)| (k.clone(), m.clone())).collect();
    CAP.with(|c| c.borrow_mut().debuffs = v);
}

/// `env.curseSlots[].modList`, in slot order.
pub fn cap_curse_slots(slots: &[pom_calc::perform_curses::CurseSlot]) {
    if !perform_on() {
        return;
    }
    CAP.with(|c| {
        let mut c = c.borrow_mut();
        c.curse_slot_mods = slots.iter().map(|s| s.mod_list.clone()).collect();
        c.curse_slot_names = slots.iter().map(|s| s.name.clone()).collect();
    });
}

fn value_json(v: &pom_engine::value::Value) -> Value {
    use pom_engine::value::Value as V;
    match v {
        V::Nil => Value::Null,
        V::Bool(b) => Value::Bool(*b),
        V::Num(n) => bd::num(*n),
        V::Str(x) => Value::String(x.to_string()),
        V::List(l) => Value::Array(l.iter().map(value_json).collect()),
        V::Map(m) => {
            let mut o = serde_json::Map::new();
            for (k, x) in m.iter() {
                if !matches!(x, V::Nil) {
                    o.insert(k.as_str().to_string(), value_json(x));
                }
            }
            Value::Object(o)
        }
    }
}

/// A mod as the recorder writes the Lua mod table: `{ name, type, value, flags, keywordFlags, source, [1..n] = tags }`.
pub fn mod_json(m: &Mod) -> Value {
    let mut o = serde_json::Map::new();
    o.insert("name".into(), Value::String(m.name.as_str().to_string()));
    o.insert("type".into(), Value::String(m.ty.as_str().to_string()));
    o.insert("value".into(), value_json(&m.value));
    o.insert("flags".into(), bd::num(m.flags as f64));
    o.insert("keywordFlags".into(), bd::num(m.keyword_flags as f64));
    if let Some(src) = &m.source {
        o.insert("source".into(), Value::String(src.to_string()));
    }
    for (i, t) in m.tags.iter().enumerate() {
        let mut to = serde_json::Map::new();
        to.insert("type".into(), Value::String(t.kind.as_str().to_string()));
        for (k, v) in &t.fields {
            if !matches!(v, pom_engine::value::Value::Nil) {
                to.insert(k.as_str().to_string(), value_json(v));
            }
        }
        o.insert((i + 1).to_string(), Value::Object(to));
    }
    Value::Object(o)
}

/// One `{ mod = mod, value = value }` entry when `store:EvalMod(mod)` is neither nil nor 0.
fn eval_entry(store: &ModStore, m: &Mod) -> Option<Value> {
    let v = pom_engine::modstore::eval::eval_mod(store, m, None, None)?;
    if matches!(v, pom_engine::value::Value::Num(n) if n == 0.0) {
        return None;
    }
    Some(bd::row(vec![("mod", mod_json(m)), ("value", value_json(&v))]))
}

/// The same entry as `eval_entry`, for the popup's modifier table.
fn eval_row(store: &ModStore, m: &Mod) -> Option<(pom_breakdown::value::Value, pom_breakdown::modifier::Mod)> {
    let v = pom_engine::modstore::eval::eval_mod(store, m, None, None)?;
    if matches!(v, pom_engine::value::Value::Num(n) if n == 0.0) {
        return None;
    }
    Some((crate::calcs::conv_value(&v), crate::calcs::conv_mod(m)))
}

/// `breakdown.SkillBuffs` / `SkillDebuffs` of the player and of the minion (Calcs.lua:762-860).
pub fn buff_tables(player: &ModStore, enemy: &ModStore, minion: Option<&ModStore>) {
    if !perform_on() {
        return;
    }
    // Calcs.lua:762-810: `output.BuffList`, `output.CurseList` and the minion's `BuffList`, as text.
    CAP.with(|c| {
        let c = c.borrow();
        let mut buff: Vec<String> = c.buffs.iter().map(|(n, _)| n.clone()).collect();
        buff.sort();
        let mut minion_buff: Vec<String> = c.minion.iter().map(|(n, _)| n.clone()).collect();
        minion_buff.sort();
        let mut debuff: Vec<&(String, Vec<Mod>)> = c.debuffs.iter().collect();
        debuff.sort_by(|a, z| a.0.cmp(&z.0));
        let stack_name = |n: &str| Sym::new(&format!("Multiplier:{n}Stack"));
        let mut curse: Vec<String> = debuff
            .iter()
            .map(|(name, mods)| {
                let stacks: f64 = mods.iter().filter(|m| m.ty == ModType::Base && m.name == stack_name(name)).filter_map(|m| m.value.num()).sum();
                if stacks > 0.0 {
                    format!("{name} ({} stack{})", crate::calcs_popup::lua_num(stacks), if stacks > 1.0 { "s" } else { "" })
                } else {
                    name.clone()
                }
            })
            .collect();
        curse.extend(c.curse_slot_names.iter().cloned());
        crate::calcs_popup::set_lists(crate::calcs_popup::Lists { buff: buff.join(", "), curse: curse.join(", "), minion_buff: minion_buff.join(", ") });
    });
    let (buffs, minion_buffs, debuffs, slots) = CAP.with(|c| {
        let c = c.borrow();
        let mut b = c.buffs.clone();
        b.sort_by(|a, z| a.0.cmp(&z.0));
        let mut mb = c.minion.clone();
        mb.sort_by(|a, z| a.0.cmp(&z.0));
        let mut d = c.debuffs.clone();
        d.sort_by(|a, z| a.0.cmp(&z.0));
        (b, mb, d, c.curse_slot_mods.clone())
    });
    let mut sb = Value::Array(vec![]);
    let mut rows = crate::calcs_popup::ListRows::default();
    for (_, list) in &buffs {
        for m in list {
            if let Some(e) = eval_entry(player, m) {
                bd::ins(bd::t(&mut sb, "modList"), e);
            }
            rows.buffs.extend(eval_row(player, m));
        }
    }
    bd::t(&mut sb, "modList");
    root(|b| bd::set(b, "SkillBuffs", sb));
    let mut sd = Value::Array(vec![]);
    bd::t(&mut sd, "modList");
    for (_, list) in &debuffs {
        for m in list {
            if let Some(e) = eval_entry(enemy, m) {
                bd::ins(bd::t(&mut sd, "modList"), e);
            }
            rows.debuffs.extend(eval_row(enemy, m));
        }
    }
    for list in &slots {
        for m in list {
            if let Some(e) = eval_entry(enemy, m) {
                bd::ins(bd::t(&mut sd, "modList"), e);
            }
            rows.debuffs.extend(eval_row(enemy, m));
        }
    }
    root(|b| bd::set(b, "SkillDebuffs", sd.clone()));
    if let Some(mstore) = minion {
        let mut msb = Value::Array(vec![]);
        bd::t(&mut msb, "modList");
        for (_, list) in &minion_buffs {
            for m in list {
                if let Some(e) = eval_entry(mstore, m) {
                    bd::ins(bd::t(&mut msb, "modList"), e);
                }
                rows.minion_buffs.extend(eval_row(mstore, m));
            }
        }
        bd::select_actor(1);
        root(|b| {
            bd::set(b, "SkillBuffs", msb);
            bd::set(b, "SkillDebuffs", sd);
        });
        bd::select_actor(0);
    }
    crate::calcs_popup::set_list_rows(rows);
}

/// Where a slot sits in `build.itemsTab.orderedSlots` (ItemsTab.lua:37, 148-200): the base slots in order, each followed by its
/// swap slot, the swap slot's abyssal sockets and its own abyssal sockets; the jewel sockets come last, by node id.
pub fn slot_order(name: &str) -> (usize, u8, usize) {
    const BASE: [&str; 18] = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt", "Graft 1", "Graft 2", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"];
    if let Some(id) = name.strip_prefix("Jewel ") {
        return (1000, 0, id.parse().unwrap_or(0));
    }
    for (i, b) in BASE.iter().enumerate() {
        if name == *b {
            return (i, 0, 0);
        }
        if let Some(rest) = name.strip_prefix(b) {
            if rest == " Swap" {
                return (i, 1, 0);
            }
            if let Some(n) = rest.strip_prefix(" Swap Abyssal Socket ") {
                return (i, 2, n.parse().unwrap_or(0));
            }
            if let Some(n) = rest.strip_prefix(" Abyssal Socket ") {
                return (i, 3, n.parse().unwrap_or(0));
            }
        }
    }
    (999, 0, 0)
}

/// The source of one `env.requirementsTable` row (CalcSetup.lua:1072, 1845): what the Req tables name in their rows.
#[derive(Clone, Debug)]
pub enum ReqSrc {
    /// An equipped item: `item.rarity` and `item.name`; `order` is its slot's place in `orderedSlots`.
    Item { rarity: String, name: String, order: (usize, u8, usize) },
    /// A socketed gem: `gem.color`, `gem.nameSpec`, `gem.level`, `gem.quality`.
    Gem { color: &'static str, name: String, level: f64, quality: f64 },
}

/// `gemInstance.color` (SkillsTab.lua:1212-1220) from the granted effect's `color`.
pub fn gem_color(color: Option<i64>) -> &'static str {
    match color {
        Some(1) => "^xE05030",
        Some(2) => "^x70FF70",
        Some(3) => "^x7070FF",
        _ => "^xC8C8C8",
    }
}

fn rarity_color(rarity: &str) -> &'static str {
    match rarity.to_ascii_uppercase().as_str() {
        "NORMAL" => "^xC8C8C8",
        "MAGIC" => "^x8888FF",
        "RARE" => "^xFFFF77",
        "UNIQUE" => "^xAF6025",
        "RELIC" => "^x60C060",
        _ => "",
    }
}

/// `breakdown["Req"..attr] = { source = "", rowList = { }, colList = { ... } }` (CalcPerform.lua:2107).
pub fn req_table_begin(attr: &str) {
    if !perform_on() {
        return;
    }
    let col = |label: &str, key: &str| bd::row(vec![("label", s(label)), ("key", s(key))]);
    let t = bd::row(vec![
        ("source", s("")),
        ("rowList", Value::Array(vec![])),
        ("colList", Value::Array(vec![col(attr, "req"), col("Source", "source"), col("Source Name", "sourceName")])),
    ]);
    root(|b| bd::set(b, &format!("Req{attr}"), t));
}

/// One row of `breakdown["Req"..breakdownAttr].rowList` (CalcPerform.lua:2130-2145). `have` is `output[breakdownAttr]`.
pub fn req_row(breakdown_attr: &str, req: f64, have: f64, src: &ReqSrc) {
    if !perform_on() {
        return;
    }
    let mut row = vec![("req", if req > have { s(format!("^xDD0022{}", bd::tostr(req))) } else { bd::num(req) }), ("reqNum", bd::num(req))];
    match src {
        ReqSrc::Item { rarity, name, .. } => {
            row.push(("source", s("Item")));
            row.push(("sourceName", s(format!("{}{}", rarity_color(rarity), name))));
            row.push(("sourceNameTooltip", s("<fn>")));
        }
        ReqSrc::Gem { color, name, level, quality } => {
            row.push(("source", s("Gem")));
            row.push(("sourceName", s(sf!("%s%s ^7%d/%d", *color, name.as_str(), *level, *quality))));
        }
    }
    let r = bd::row(row);
    root(|b| {
        if let Some(t) = bd::get(b, &format!("Req{breakdown_attr}")) {
            bd::ins(bd::t(t, "rowList"), r);
        }
    });
}

/// `breakdown.LifeReserved` / `breakdown.ManaReserved` (CalcPerform.lua:1974-1976, 2050-2078): both start as
/// `{ reservations = { } }`, then one row per skill and pool with a non-zero flat or percent reservation.
/// `name_of(idx)` is the skill's granted effect name.
pub fn reservation_tables(rows: &[pom_calc::perform_reserve::ReservationRow], name_of: &dyn Fn(usize) -> String) {
    if !perform_on() {
        return;
    }
    let mut tables = [("Life", Value::Array(vec![])), ("Mana", Value::Array(vec![]))];
    for t in tables.iter_mut() {
        bd::set(&mut t.1, "reservations", Value::Array(vec![]));
    }
    for row in rows {
        let t = if row.pool == "Life" { &mut tables[0].1 } else { &mut tables[1].1 };
        let x = |c: bool, v: f64| bd::opt_s(if c { Some(format!("x {}", bd::tostr(v))) } else { None });
        let r = bd::row(vec![
            ("skillName", s(name_of(row.skill_idx))),
            ("base", if row.percent { s(format!("{}%", bd::tostr(row.base))) } else { bd::num(row.base) }),
            ("mult", x(row.mult != 1.0, row.mult)),
            ("more", x(row.more != 1.0, row.more)),
            ("inc", x(row.inc != 0.0, 1.0 + row.inc / 100.0)),
            ("efficiency", x(row.efficiency != 0.0, bd::round(100.0 / (100.0 + row.efficiency), 4))),
            ("efficiencyMore", x(row.efficiency_more != 1.0, row.efficiency_more)),
            ("total", if row.percent { s(format!("{}%", bd::tostr(row.total))) } else { bd::num(row.total) }),
        ]);
        bd::ins(bd::t(t, "reservations"), r);
    }
    for (pool, t) in tables {
        root(|b| bd::set(b, &format!("{pool}Reserved"), t.clone()));
    }
}
