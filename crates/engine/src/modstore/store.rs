//! Port of Classes/ModStore.lua, Classes/ModList.lua and Classes/ModDB.lua.
//!
//! ModList and ModDB differ only in how mods are indexed: ModList is a flat vector scanned
//! linearly by name (matching the Lua `for i=1,#self do if mod.name==modName`), ModDB buckets
//! mods into a map keyed by interned name so a lookup by name is O(1) instead of O(n). Since
//! every other method (Sum, More, Flag, Override, List, Tabulate, HasMod, GetCondition,
//! GetMultiplier, GetStat, EvalMod) is identical between the two in the original, both are one
//! `ModStore` struct here with a `Backing` enum, instead of two near-duplicate types.
use crate::modifier::{Mod, ModType};
use crate::modstore::types::{Actor, Cfg};
use crate::sym::Sym;
use crate::fxhash::HashMap;
use std::sync::Arc;

#[derive(Clone)]
pub enum Backing {
    /// Shared copy-on-write: copies of a store (snapshots, env clones) share the list until one of them is changed.
    List(Arc<ModList>),
    Db(HashMap<Sym, Vec<Mod>>),
}

/// A ModList's mods in insertion order, plus an index of positions by name built on the first lookup. Any
/// mutable access to the mods goes through `DerefMut`, which drops the index, so it can never be stale;
/// `push_mod` keeps it up to date instead. Lookups visit a name's mods in the same order as a full scan.
#[derive(Clone, Default)]
pub struct ModList {
    mods: Vec<Mod>,
    index: std::sync::OnceLock<HashMap<Sym, Vec<u32>>>,
}

impl std::ops::Deref for ModList {
    type Target = Vec<Mod>;
    fn deref(&self) -> &Vec<Mod> { &self.mods }
}

impl std::ops::DerefMut for ModList {
    fn deref_mut(&mut self) -> &mut Vec<Mod> {
        self.index = std::sync::OnceLock::new();
        &mut self.mods
    }
}

impl From<Vec<Mod>> for ModList {
    fn from(mods: Vec<Mod>) -> ModList { ModList { mods, index: std::sync::OnceLock::new() } }
}

impl ModList {
    /// Below this many mods a linear scan beats building the index.
    const INDEX_MIN: usize = 32;

    pub fn push_mod(&mut self, m: Mod) {
        if let Some(ix) = self.index.get_mut() {
            ix.entry(m.name).or_default().push(self.mods.len() as u32);
        }
        self.mods.push(m);
    }

    fn positions(&self, name: Sym) -> Option<&[u32]> {
        if self.mods.len() < Self::INDEX_MIN { return None; }
        let ix = self.index.get_or_init(|| {
            let mut ix: HashMap<Sym, Vec<u32>> = HashMap::default();
            for (i, m) in self.mods.iter().enumerate() {
                ix.entry(m.name).or_default().push(i as u32);
            }
            ix
        });
        Some(ix.get(&name).map(|v| v.as_slice()).unwrap_or(&[]))
    }
}

/// `Vec::retain` on a shared list: copies it only when some mod is actually removed.
pub fn retain_mods(v: &mut Arc<ModList>, keep: impl Fn(&Mod) -> bool) {
    if !v.iter().all(&keep) {
        Arc::make_mut(v).retain(|m| keep(m));
    }
}

pub struct ModStore {
    pub parent: Option<Arc<ModStore>>,
    pub actor: Option<Arc<Actor>>,
    pub conditions: HashMap<Sym, bool>,
    pub multipliers: HashMap<Sym, f64>,
    pub backing: Backing,
}

/// Iterates the mods with a given name in one store (no parent recursion), without allocating.
pub enum ModIter<'a> {
    List { mods: &'a [Mod], name: Sym, i: usize },
    Indexed { mods: &'a [Mod], pos: std::slice::Iter<'a, u32> },
    Db(std::slice::Iter<'a, Mod>),
    Empty,
}

/// A deep copy: the actor is copied too, since its `related` map is a `RefCell` that the copy must not share.
/// Parent stores stay shared; they are behind an `Arc` and never mutated.
impl Clone for ModStore {
    fn clone(&self) -> ModStore {
        ModStore {
            parent: self.parent.clone(),
            actor: self.actor.as_ref().map(|a| Arc::new((**a).clone())),
            conditions: self.conditions.clone(),
            multipliers: self.multipliers.clone(),
            backing: self.backing.clone(),
        }
    }
}

impl<'a> Iterator for ModIter<'a> {
    type Item = &'a Mod;
    fn next(&mut self) -> Option<&'a Mod> {
        match self {
            ModIter::List { mods, name, i } => {
                while *i < mods.len() {
                    let m = &mods[*i];
                    *i += 1;
                    if m.name == *name { return Some(m); }
                }
                None
            }
            ModIter::Indexed { mods, pos } => pos.next().map(|&i| &mods[i as usize]),
            ModIter::Db(it) => it.next(),
            ModIter::Empty => None,
        }
    }
}

impl ModStore {
    pub fn new_list(parent: Option<Arc<ModStore>>, actor: Option<Arc<Actor>>) -> ModStore {
        ModStore { parent, actor, conditions: HashMap::default(), multipliers: HashMap::default(), backing: Backing::List(Arc::new(ModList::default())) }
    }
    pub fn new_db(parent: Option<Arc<ModStore>>, actor: Option<Arc<Actor>>) -> ModStore {
        ModStore { parent, actor, conditions: HashMap::default(), multipliers: HashMap::default(), backing: Backing::Db(HashMap::default()) }
    }

    pub fn add_mod(&mut self, m: Mod) {
        match &mut self.backing {
            Backing::List(v) => Arc::make_mut(v).push_mod(m),
            Backing::Db(map) => map.entry(m.name).or_default().push(m),
        }
    }

    pub fn mods_named(&self, name: Sym) -> ModIter<'_> {
        match &self.backing {
            Backing::List(v) => match v.positions(name) {
                Some(pos) => ModIter::Indexed { mods: v, pos: pos.iter() },
                None => ModIter::List { mods: v, name, i: 0 },
            },
            Backing::Db(map) => match map.get(&name) {
                Some(v) => ModIter::Db(v.iter()),
                None => ModIter::Empty,
            },
        }
    }

    // ===== Sum/More/Flag/Override/List/Tabulate/HasMod: shared aggregate logic =====
    // These mirror the *Internal methods, which only differ in the flat-vs-bucketed lookup
    // captured by `mods_named` above; the accumulation logic itself is identical for
    // ModList and ModDB in the original.

    fn passes(m: &Mod, flags: u64, keyword_flags: u64, source: Option<&str>) -> bool {
        if flags & m.flags != m.flags { return false; }
        if !match_keyword_flags(keyword_flags, m.keyword_flags) { return false; }
        if let Some(src) = source {
            match &m.source {
                Some(s) => {
                    let first = s.split(':').next().unwrap_or(s);
                    if first != src { return false; }
                }
                None => return false,
            }
        }
        true
    }

    pub fn sum(&self, mod_type: ModType, cfg: Option<&Cfg>, names: &[Sym]) -> f64 {
        let (flags, kw, source) = cfg_triple(cfg);
        self.sum_internal(self, mod_type, cfg, flags, kw, source, names)
    }
    fn sum_internal(&self, ctx: &ModStore, mod_type: ModType, cfg: Option<&Cfg>, flags: u64, kw: u64, source: Option<&str>, names: &[Sym]) -> f64 {
        let mut result = 0.0;
        let mut global_limits: Option<HashMap<Sym, f64>> = None;
        for &name in names {
            for m in self.mods_named(name) {
                if m.ty == mod_type && Self::passes(m, flags, kw, source) {
                    if !m.tags.is_empty() {
                        let gl = global_limits.get_or_insert_with(HashMap::default);
                        result += crate::modstore::eval::eval_mod(ctx, m, cfg, Some(gl)).and_then(|v| v.lua_num()).unwrap_or(0.0);
                    } else {
                        result += m.value.lua_num().unwrap_or(0.0);
                    }
                }
            }
        }
        if let Some(parent) = &self.parent {
            result += parent.sum_internal(ctx, mod_type, cfg, flags, kw, source, names);
        }
        result
    }

    pub fn more(&self, cfg: Option<&Cfg>, names: &[Sym]) -> f64 {
        let (flags, kw, source) = cfg_triple(cfg);
        self.more_internal(self, cfg, flags, kw, source, names)
    }
    fn more_internal(&self, ctx: &ModStore, cfg: Option<&Cfg>, flags: u64, kw: u64, source: Option<&str>, names: &[Sym]) -> f64 {
        let mut result = 1.0f64;
        let mut mod_precision: Option<i32> = None;
        let mut global_limits: Option<HashMap<Sym, f64>> = None;
        for &name in names {
            let mut mod_result = 1.0f64;
            for m in self.mods_named(name) {
                if m.ty == ModType::More && Self::passes(m, flags, kw, source) {
                    let value = if !m.tags.is_empty() {
                        let gl = global_limits.get_or_insert_with(HashMap::default);
                        crate::modstore::eval::eval_mod(ctx, m, cfg, Some(gl)).and_then(|v| v.lua_num()).unwrap_or(0.0)
                    } else {
                        m.value.lua_num().unwrap_or(0.0)
                    };
                    mod_result *= 1.0 + value / 100.0;
                    if let Some(p) = high_precision_more(m.name) {
                        mod_precision = Some(mod_precision.map(|cur: i32| cur.max(p)).unwrap_or(p));
                    }
                }
            }
            if let Some(p) = mod_precision {
                let power = 10f64.powi(p);
                result = (result * mod_result * power).floor() / power;
            } else {
                result *= round2(mod_result);
            }
        }
        if let Some(parent) = &self.parent {
            result *= parent.more_internal(ctx, cfg, flags, kw, source, names);
        }
        result
    }

    pub fn flag(&self, cfg: Option<&Cfg>, names: &[Sym]) -> bool {
        let (flags, kw, source) = cfg_triple(cfg);
        self.flag_internal(self, cfg, flags, kw, source, names)
    }
    fn flag_internal(&self, ctx: &ModStore, cfg: Option<&Cfg>, flags: u64, kw: u64, source: Option<&str>, names: &[Sym]) -> bool {
        for &name in names {
            for m in self.mods_named(name) {
                if m.ty == ModType::Flag && Self::passes(m, flags, kw, source) {
                    if !m.tags.is_empty() {
                        if crate::modstore::eval::eval_mod(ctx, m, cfg, None).map(|v| v.truthy()).unwrap_or(false) { return true; }
                    } else if m.value.truthy() {
                        return true;
                    }
                }
            }
        }
        if let Some(parent) = &self.parent {
            return parent.flag_internal(ctx, cfg, flags, kw, source, names);
        }
        false
    }

    pub fn override_(&self, cfg: Option<&Cfg>, names: &[Sym]) -> Option<crate::value::Value> {
        let (flags, kw, source) = cfg_triple(cfg);
        self.override_internal(self, cfg, flags, kw, source, names)
    }
    fn override_internal(&self, ctx: &ModStore, cfg: Option<&Cfg>, flags: u64, kw: u64, source: Option<&str>, names: &[Sym]) -> Option<crate::value::Value> {
        for &name in names {
            for m in self.mods_named(name) {
                if m.ty == ModType::Override && Self::passes(m, flags, kw, source) {
                    if !m.tags.is_empty() {
                        if let Some(v) = crate::modstore::eval::eval_mod(ctx, m, cfg, None) { return Some(v); }
                    } else if !matches!(m.value, crate::value::Value::Nil) {
                        return Some(m.value.clone());
                    }
                }
            }
        }
        self.parent.as_ref().and_then(|p| p.override_internal(ctx, cfg, flags, kw, source, names))
    }

    pub fn list(&self, cfg: Option<&Cfg>, names: &[Sym]) -> Vec<crate::value::Value> {
        let (flags, kw, source) = cfg_triple(cfg);
        let mut result = Vec::new();
        self.list_internal(self, &mut result, cfg, flags, kw, source, names);
        result
    }
    fn list_internal(&self, ctx: &ModStore, result: &mut Vec<crate::value::Value>, cfg: Option<&Cfg>, flags: u64, kw: u64, source: Option<&str>, names: &[Sym]) {
        for &name in names {
            for m in self.mods_named(name) {
                if m.ty == ModType::List && Self::passes(m, flags, kw, source) {
                    if !m.tags.is_empty() {
                        if let Some(v) = crate::modstore::eval::eval_mod(ctx, m, cfg, None) { result.push(v); }
                    } else if !matches!(m.value, crate::value::Value::Nil) {
                        result.push(m.value.clone());
                    }
                }
            }
        }
        if let Some(parent) = &self.parent {
            parent.list_internal(ctx, result, cfg, flags, kw, source, names);
        }
    }

    pub fn tabulate(&self, mod_type: Option<ModType>, cfg: Option<&Cfg>, names: &[Sym]) -> Vec<(crate::value::Value, *const Mod)> {
        let (flags, kw, source) = cfg_triple(cfg);
        let mut result = Vec::new();
        let mut global_limits: Option<HashMap<Sym, f64>> = None;
        self.tabulate_internal(self, &mut result, mod_type, cfg, flags, kw, source, names, &mut global_limits);
        result
    }
    #[allow(clippy::too_many_arguments)]
    fn tabulate_internal(&self, ctx: &ModStore, result: &mut Vec<(crate::value::Value, *const Mod)>, mod_type: Option<ModType>, cfg: Option<&Cfg>, flags: u64, kw: u64, source: Option<&str>, names: &[Sym], global_limits: &mut Option<HashMap<Sym, f64>>) {
        for &name in names {
            for m in self.mods_named(name) {
                if (mod_type.is_none() || mod_type == Some(m.ty)) && Self::passes(m, flags, kw, source) {
                    let value = if !m.tags.is_empty() {
                        let gl = global_limits.get_or_insert_with(HashMap::default);
                        crate::modstore::eval::eval_mod(ctx, m, cfg, Some(gl))
                    } else {
                        Some(m.value.clone())
                    };
                    if let Some(v) = value {
                        let nonzero = v.num().map(|n| n != 0.0).unwrap_or(true);
                        if nonzero || m.ty == ModType::Override {
                            result.push((v, m as *const Mod));
                        }
                    }
                }
            }
        }
        if let Some(parent) = &self.parent {
            parent.tabulate_internal(ctx, result, mod_type, cfg, flags, kw, source, names, global_limits);
        }
    }

    pub fn max(&self, cfg: Option<&Cfg>, names: &[Sym]) -> Option<f64> {
        let mut max = None;
        for (v, _) in self.tabulate(Some(ModType::Max), cfg, names) {
            if let Some(n) = v.num() {
                if n > max.unwrap_or(0.0) { max = Some(n); }
            }
        }
        max
    }
    pub fn min(&self, cfg: Option<&Cfg>, names: &[Sym]) -> Option<f64> {
        let mut min = None;
        for (v, _) in self.tabulate(Some(ModType::Min), cfg, names) {
            if let Some(n) = v.num() {
                if min.is_none() || n < min.unwrap() { min = Some(n); }
            }
        }
        min
    }

    pub fn has_mod(&self, mod_type: ModType, cfg: Option<&Cfg>, names: &[Sym]) -> bool {
        let (flags, kw, source) = cfg_triple(cfg);
        self.has_mod_internal(mod_type, flags, kw, source, names)
    }
    fn has_mod_internal(&self, mod_type: ModType, flags: u64, kw: u64, source: Option<&str>, names: &[Sym]) -> bool {
        for &name in names {
            for m in self.mods_named(name) {
                if m.ty == mod_type && Self::passes(m, flags, kw, source) { return true; }
            }
        }
        if let Some(parent) = &self.parent {
            if parent.has_mod_internal(mod_type, flags, kw, source, names) { return true; }
        }
        false
    }

    // ===== GetCondition / GetMultiplier / GetStat: defined once, shared by ModList and ModDB =====

    pub fn get_condition(&self, var: Sym, cfg: Option<&Cfg>, no_mod: bool) -> bool {
        if let Some(&v) = self.conditions.get(&var) { if v { return true; } }
        if let Some(parent) = &self.parent {
            if parent.get_condition(var, cfg, true) { return true; }
        }
        if !no_mod {
            return self.flag(cfg, &[condition_name(var)]);
        }
        false
    }

    pub fn get_multiplier(&self, var: Sym, cfg: Option<&Cfg>, no_mod: bool) -> f64 {
        if !no_mod {
            if let Some(v) = self.override_(cfg, &[multiplier_name(var)]) {
                if let Some(n) = v.num() { return n; }
            }
        }
        let mut total = self.multipliers.get(&var).copied().unwrap_or(0.0);
        if let Some(parent) = &self.parent {
            total += parent.get_multiplier(var, cfg, true);
        }
        if !no_mod {
            total += self.sum(ModType::Base, cfg, &[multiplier_name(var)]);
        }
        total
    }

    /// Port of ModStoreClass:GetStat. The `ManaReservedPercent`/`LifeReservedPercent`/
    /// `ManaUnreserved` special cases read the actor's active-skill reservation list, which the
    /// calc engine (not yet ported) normally supplies; here it comes from the actor snapshot.
    pub fn get_stat(&self, stat: Sym, cfg: Option<&Cfg>, syms: &StatSyms) -> f64 {
        let actor = self.actor.as_deref();
        if stat == syms.mana_reserved_percent {
            let total_mana = actor.and_then(|a| a.output.get(&syms.mana).copied()).unwrap_or(0.0);
            if total_mana == 0.0 { return 0.0; }
            if let Some(a) = actor {
                for r in &a.reservations {
                    if let Some(skill_name) = cfg.and_then(|c| c.skill_name.as_deref()) {
                        if r.buff_names.iter().any(|n| n.as_ref() == skill_name) {
                            let base = r.mana_reserved_base.unwrap_or(0.0);
                            return (base / total_mana * 100.0).floor().min(100.0);
                        }
                    }
                    if let Some(summon_name) = cfg.and_then(|c| c.summon_skill_name.as_deref()) {
                        if r.buff_names.iter().any(|n| n.as_ref() == summon_name) {
                            let base = r.mana_reserved_base.unwrap_or(0.0);
                            return (base / total_mana * 100.0).floor().min(100.0);
                        }
                    }
                }
            }
            return 0.0;
        }
        if stat == syms.life_reserved_percent {
            let total_life = actor.and_then(|a| a.output.get(&syms.life).copied()).unwrap_or(0.0);
            if total_life == 0.0 { return 0.0; }
            if let Some(a) = actor {
                for r in &a.reservations {
                    let matches = cfg.and_then(|c| c.skill_name.as_deref()).map(|n| r.buff_names.iter().any(|b| b.as_ref() == n)).unwrap_or(false)
                        || cfg.and_then(|c| c.summon_skill_name.as_deref()).map(|n| r.buff_names.iter().any(|b| b.as_ref() == n)).unwrap_or(false);
                    if matches {
                        let base = r.life_reserved_base.unwrap_or(0.0);
                        return (base / total_life * 100.0).floor().min(100.0);
                    }
                }
            }
            return 0.0;
        }
        if stat == syms.mana_unreserved {
            let v = actor.and_then(|a| a.output.get(&stat).copied());
            match v {
                Some(n) if n.is_nan() => return actor.and_then(|a| a.output.get(&syms.mana).copied()).unwrap_or(0.0),
                Some(n) if n < 0.0 => {
                    let unreserved_pct = actor.and_then(|a| a.output.get(&syms.mana_unreserved_percent).copied()).unwrap_or(0.0);
                    let mana_eff = actor.and_then(|a| a.mana_efficiency).unwrap_or(0.0);
                    let reserved_before_eff = (unreserved_pct.abs() + 100.0) * ((100.0 + mana_eff) / 100.0);
                    let mana = actor.and_then(|a| a.output.get(&syms.mana).copied()).unwrap_or(0.0);
                    return mana * (reserved_before_eff.ceil() / 100.0);
                }
                _ => {}
            }
        }
        if let Some(a) = actor {
            if let Some(v) = a.output.get(&stat) { return *v; }
        }
        if let Some(c) = cfg {
            if let Some(v) = c.skill_stats.get(&stat) { return *v; }
        }
        0.0
    }
}

fn cfg_triple(cfg: Option<&Cfg>) -> (u64, u64, Option<&str>) {
    match cfg {
        Some(c) => (c.flags, c.keyword_flags, c.source.as_deref()),
        None => (0, 0, None),
    }
}

fn round2(v: f64) -> f64 {
    (v * 100.0 + 0.5).floor() / 100.0
}

/// Port of `data.highPrecisionMods[name]["MORE"]` (Modules/Data.lua): the whole table has
/// exactly one MORE-type entry, `SupportManaMultiplier` at 4 decimal places. Every other entry
/// is BASE-type, used only by `ScaleAddMod` (item/gem scaling), not by `MoreInternal`.
fn high_precision_more(name: Sym) -> Option<i32> {
    if name.as_str() == "SupportManaMultiplier" { Some(4) } else { None }
}

/// Port of Data/Global.lua's MatchKeywordFlags. LuaJIT's `bit` library is 32-bit two's
/// complement, so `KeywordFlag.MatchAll`'s bnot mask only clears the low 32 bits.
pub const MATCH_ALL: u64 = 0x4000_0000;
const MATCH_ALL_MASK: u64 = (!MATCH_ALL) & 0xFFFF_FFFF;

pub fn match_keyword_flags(keyword_flags: u64, mod_keyword_flags: u64) -> bool {
    let match_all = mod_keyword_flags & MATCH_ALL != 0;
    let mod_masked = mod_keyword_flags & MATCH_ALL_MASK;
    let keyword_masked = keyword_flags & MATCH_ALL_MASK;
    if match_all {
        keyword_masked & mod_masked == mod_masked
    } else {
        mod_masked == 0 || keyword_masked & mod_masked != 0
    }
}

pub fn multiplier_name(var: Sym) -> Sym {
    Sym::new(&format!("Multiplier:{}", var.as_str()))
}
pub fn condition_name(var: Sym) -> Sym {
    Sym::new(&format!("Condition:{}", var.as_str()))
}

/// Interned syms GetStat's hardcoded branches compare against, resolved once by the caller.
pub struct StatSyms {
    pub mana_reserved_percent: Sym,
    pub life_reserved_percent: Sym,
    pub mana_unreserved: Sym,
    pub mana_unreserved_percent: Sym,
    pub mana: Sym,
    pub life: Sym,
}
impl StatSyms {
    pub fn new() -> StatSyms {
        StatSyms {
            mana_reserved_percent: crate::sym!("ManaReservedPercent"),
            life_reserved_percent: crate::sym!("LifeReservedPercent"),
            mana_unreserved: crate::sym!("ManaUnreserved"),
            mana_unreserved_percent: crate::sym!("ManaUnreservedPercent"),
            mana: crate::sym!("Mana"),
            life: crate::sym!("Life"),
        }
    }
}
impl Default for StatSyms {
    fn default() -> Self { StatSyms::new() }
}
