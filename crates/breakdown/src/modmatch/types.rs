//! Typed equivalents of the Lua `cfg` (skillCfg) table and the actor-side data that
//! `ModStoreClass:EvalMod` / `GetStat` / `GetCondition` read directly off `self.actor`.
//!
//! Actor data (output table, weapon data, item list, active skill reservations, monster tags)
//! is not computed by this crate. It is produced by the rest of the calc engine, which hasn't
//! been ported yet. For the answer-key replay tests this data comes straight from the recorded
//! snapshot; production callers build an `Actor` from their own calc state.
use crate::sym::Sym;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
pub struct ItemInfo {
    pub name: Option<Arc<str>>,
    pub rarity: Option<Arc<str>>,
    pub corrupted: Option<bool>,
    pub shaper: Option<bool>,
    pub elder: Option<bool>,
    pub item_type: Option<Arc<str>>,
}

#[derive(Clone, Debug, Default)]
pub struct GemInfo {
    /// `gem.name:lower()`
    pub name: Arc<str>,
    /// `gem.tags` (a Lua set: tagName -> true)
    pub tags: HashMap<Arc<str>, bool>,
}

impl GemInfo {
    /// Port of `calcLib.gemIsType` (Modules/CalcTools.lua). `includeTransfigured` support is
    /// stubbed out (always false) - none of the ModStore corpus data exercises it through
    /// SocketedIn's `keyword` tag, which never sets `includeTransfigured`.
    pub fn is_type(&self, ty: &str) -> bool {
        let ty_lower = ty;
        ty_lower == "all"
            || (ty_lower == "elemental" && (self.tags.get("fire").copied().unwrap_or(false) || self.tags.get("cold").copied().unwrap_or(false) || self.tags.get("lightning").copied().unwrap_or(false)))
            || (ty_lower == "aoe" && self.tags.get("area").copied().unwrap_or(false))
            || (ty_lower == "trap or mine" && (self.tags.get("trap").copied().unwrap_or(false) || self.tags.get("mine").copied().unwrap_or(false)))
            || (matches!(ty_lower, "active skill" | "grants_active_skill" | "skill") && self.tags.get("grants_active_skill").copied().unwrap_or(false) && !self.tags.get("support").copied().unwrap_or(false))
            || (ty_lower == "non-vaal" && !self.tags.get("vaal").copied().unwrap_or(false))
            || (ty_lower == "non-exceptional" && !self.tags.get("exceptional").copied().unwrap_or(false))
            || (ty_lower == self.name.as_ref())
            || (ty_lower == self.name.strip_prefix("vaal ").unwrap_or(&self.name))
            || (!matches!(ty_lower, "active skill" | "grants_active_skill" | "skill") && self.tags.get(ty_lower).copied().unwrap_or(false))
    }
}

/// Port of `ModCfg` (the `skillCfg` table built in Modules/CalcActiveSkill.lua).
#[derive(Clone, Debug, Default)]
pub struct Cfg {
    pub flags: u64,
    pub keyword_flags: u64,
    pub source: Option<Arc<str>>,
    pub skill_name: Option<Arc<str>>,
    pub summon_skill_name: Option<Arc<str>>,
    /// Set of SkillType numeric ids, e.g. `{[SkillType.Attack]=true}`.
    pub skill_types: HashMap<i64, bool>,
    pub skill_cond: HashMap<Arc<str>, bool>,
    pub slot_name: Option<Arc<str>>,
    pub skill_gem: Option<GemInfo>,
    pub skill_part: Option<f64>,
    pub skill_dist: Option<f64>,
    pub skill_granted_effect_id: Option<Arc<str>>,
    pub skill_granted_effect_base_flags: HashMap<Arc<str>, bool>,
    pub base_flags: HashMap<Arc<str>, bool>,
    pub socket_color: Option<Arc<str>>,
    pub socket_num: Option<f64>,
    pub intelligence_gems: Option<f64>,
    pub dexterity_gems: Option<f64>,
    pub strength_gems: Option<f64>,
    pub item: Option<ItemInfo>,
    /// `cfg.actor` (a role string like "enemy"), used only by ActorCondition's no-target branch.
    pub actor_tag: Option<Arc<str>>,
    pub skill_stats: HashMap<Sym, f64>,
}

#[derive(Clone, Debug)]
pub struct Reservation {
    pub buff_names: Vec<Arc<str>>,
    pub mana_reserved_base: Option<f64>,
    pub life_reserved_base: Option<f64>,
}

/// The subset of a Lua `actor` table (env.player / env.minion / env.enemy) that ModStore reads
/// directly, rather than through `GetStat`'s normal `output[stat]` path.
#[derive(Clone, Default)]
pub struct Actor {
    pub output: HashMap<Sym, f64>,
    pub mana_efficiency: Option<f64>,
    pub weapon1: HashMap<Arc<str>, ScalarValue>,
    pub weapon2: HashMap<Arc<str>, ScalarValue>,
    pub minion_monster_tags: Option<Vec<Arc<str>>>,
    pub reservations: Vec<Reservation>,
    /// keyed by the exact-case item slot name (e.g. "Weapon 1", "Body Armour")
    pub items: HashMap<Arc<str>, ItemInfo>,
    /// FindModifierSubstring is not ported (full item mod-line text search); its results are
    /// pre-baked at record time: searchCond.lower() -> slot.lower() -> bool.
    pub item_search: HashMap<Arc<str>, HashMap<Arc<str>, bool>>,
    /// Cross-actor links (mirrors ModStore.lua's local getActor): role ("player"/"enemy"/
    /// "parent"/"minion") -> that actor's ModStore. A `RefCell` because an actor and the
    /// ModStore that owns it are built as a cycle: the store needs `Arc<Actor>` at
    /// construction, so a related actor's store can only be wired in afterward.
    pub related: RefCell<HashMap<Arc<str>, Arc<crate::modmatch::store::ModStore>>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ScalarValue {
    Num(f64),
    Str(Arc<str>),
    Bool(bool),
}

impl ScalarValue {
    pub fn truthy(&self) -> bool {
        !matches!(self, ScalarValue::Bool(false))
    }
    pub fn as_bool(&self) -> Option<bool> {
        if let ScalarValue::Bool(b) = self { Some(*b) } else { None }
    }
}
