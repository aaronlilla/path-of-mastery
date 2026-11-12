//! pom-triggers: Rust port of Modules/CalcTriggers.lua + Modules/CalcMirages.lua, graded in
//! isolation against recordings from upstream (the triggers answer keys).
//!
//! Isolation boundary: ModStore query
//! results and GlobalCache.cachedData entries (populated by calcs.buildActiveSkill, a full skill
//! calculation owned by the calc/offence/defence crates) are not recomputed here - they are
//! read from the recording as plain facts, exactly as upstream produced them at the moment
//! calcs.triggers/calcs.mirages ran. This crate's own logic is the trigger-rate/cooldown math,
//! the mirage skill-selection and setup logic, and the config dispatch table, ported faithfully
//! including float quirks and upstream's own bugs (see e.g. `skill_type_totem`).

use serde::Deserialize;
use serde_json::Value as J;
use pom_engine::fxhash::HashMap;

pub mod constants {
    // Data/Global.lua SkillType (stable enum ids for this pinned data version).
    pub const ATTACK: i64 = 1;
    pub const SPELL: i64 = 2;
    pub const DAMAGE: i64 = 7;
    pub const HAS_RESERVATION: i64 = 12;
    pub const PROJECTILE: i64 = 3;
    pub const MELEE: i64 = 20;
    pub const SUMMONS_TOTEM: i64 = 26;
    pub const TRAPPED: i64 = 33;
    pub const TRIGGERED: i64 = 37;
    pub const VAAL: i64 = 38;
    pub const RANGED_ATTACK: i64 = 41;
    pub const CHANNEL: i64 = 48;
    pub const INBUILT_TRIGGER: i64 = 50;
    pub const WARCRY: i64 = 63;
    pub const CAN_RAPID_FIRE: i64 = 70;
    pub const RAIN: i64 = 89;
    pub const SLAM: i64 = 92;
    pub const OTHER_THING_USES_SKILL: i64 = 95;
    pub const HEX: i64 = 97;
    // SkillType.Totem does not exist in Data/Global.lua. Upstream reads
    // `skill.skillTypes[SkillType.Totem]`, indexing with a nil key, which always yields nil/false
    // in Lua. Genuine dead-code quirk in upstream (Saviour's compareFunc); preserved as-is:
    // see `has_skill_type_totem_bug`.

    // Data/Global.lua ModFlag (damage-source/weapon bits).
    pub const MF_ATTACK: u64 = 0x00000001;
    pub const MF_SPELL: u64 = 0x00000002;
    pub const MF_MELEE: u64 = 0x00000100;
    pub const MF_PROJECTILE: u64 = 0x00000400;
    pub const MF_BOW: u64 = 0x00020000;
    pub const MF_CLAW: u64 = 0x00040000;
    pub const MF_MACE: u64 = 0x00100000;
    pub const MF_SWORD: u64 = 0x00400000;
    pub const MF_WAND: u64 = 0x00800000;
    pub const MF_UNARMED: u64 = 0x01000000;
    pub const MF_WEAPON1H: u64 = 0x10000000;

    // Modules/Data.lua data.misc
    pub const SERVER_TICK_TIME: f64 = 0.033;
    pub const SERVER_TICK_RATE: f64 = 1.0 / 0.033;
}
use constants::*;

// ===== small numeric helpers matching Modules/Common.lua =====
pub fn round0(v: f64) -> f64 { (v + 0.5).floor() }
pub fn ceil_b(x: f64, base: f64) -> f64 { base * (x / base).ceil() }
pub fn floor_b(x: f64, base: f64) -> f64 { base * (x / base).floor() }

// ===== recorded-input types =====

pub type ScalarMap = HashMap<String, J>;

/// `m[k]` as a float, understanding the recorder's `"NaN"`/`"Inf"`/`"-Inf"` string encoding for
/// values plain JSON can't represent (see `jnum_special`) - not just plain JSON numbers, since
/// e.g. `TriggerRateCap`/`cooldown` legitimately go to infinity for a zero-cooldown skill.
pub fn num(m: &ScalarMap, k: &str) -> Option<f64> { m.get(k).and_then(jnum_special) }
pub fn num_or(m: &ScalarMap, k: &str, d: f64) -> f64 { num(m, k).unwrap_or(d) }
/// Lua truthiness of `m[k]` (`if m[k] then ...` in upstream): everything but nil/false is
/// true, including `0` and any other number. This matters because SkillStatMap.lua's `skill(name,
/// true, ...)` convention - used for most of the "triggeredByX" skillData flags this crate reads -
/// does not actually store a literal Lua `true` by the time it reaches skillData: the recorder
/// shows these come through as the matched stat's own numeric value (e.g. `triggeredByCoc: 1`,
/// `triggeredBySpellSlinger: 100`), not a JSON boolean, so a strict "is this JSON `true`" check
/// (as a naive port of a boolean-looking field might use) silently reads false for every real
/// build. A minority (e.g. `triggeredByBrand`) do come through as a real JSON boolean; Lua
/// truthiness treats both the same way, so one helper serves every skillData/skillFlags check.
pub fn flag(m: &ScalarMap, k: &str) -> bool { matches!(m.get(k), Some(v) if !v.is_null() && v.as_bool() != Some(false)) }
pub fn s(m: &ScalarMap, k: &str) -> Option<String> { m.get(k).and_then(|v| v.as_str()).map(|s| s.to_string()) }

/// jnum()'s float encoding round-tripped: the recorder writes NaN/Inf/-Inf as JSON strings
/// (plain JSON has no such literals), everything else as a normal JSON number.
fn jnum_special(v: &J) -> Option<f64> {
    match v {
        J::Number(n) => n.as_f64(),
        J::String(s) => match s.as_str() {
            "NaN" => Some(f64::NAN),
            "Inf" => Some(f64::INFINITY),
            "-Inf" => Some(f64::NEG_INFINITY),
            _ => None,
        },
        _ => None,
    }
}
fn de_f64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v: J = serde::Deserialize::deserialize(d)?;
    Ok(jnum_special(&v).unwrap_or(0.0))
}
fn de_opt_f64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    let v: Option<J> = serde::Deserialize::deserialize(d)?;
    Ok(v.and_then(|x| jnum_special(&x)))
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CoreCalc {
    #[serde(deserialize_with = "de_f64")] pub icdr: f64,
    #[serde(rename = "addedCooldownBase", deserialize_with = "de_f64")] pub added_cooldown_base: f64,
    #[serde(rename = "cooldownOverride", deserialize_with = "de_opt_f64")] pub cooldown_override: Option<f64>,
    #[serde(rename = "flagAddsCastTimeToCD")] pub flag_adds_cast_time_to_cd: bool,
    #[serde(rename = "incSpeed", deserialize_with = "de_f64")] pub inc_speed: f64,
    #[serde(rename = "moreSpeed", deserialize_with = "de_f64")] pub more_speed: f64,
    #[serde(rename = "flagHasSeals")] pub flag_has_seals: bool,
    #[serde(rename = "sumRepeatCountBase", deserialize_with = "de_f64")] pub sum_repeat_count_base: f64,
    /// `calcLib.mod(skillModList, nil, "CWDTThreshold")` (live callers only).
    #[serde(rename = "cwdtMod", default)] pub cwdt_mod: Option<f64>,
    /// `calcLib.mod(skillModList, skillCfg, "FocusCooldownRecovery")` (live callers only; `helmetFocusHandler`).
    #[serde(rename = "focusIcdr", default)] pub focus_icdr: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GrantedEffectInfo {
    pub id: Option<String>,
    pub name: Option<String>,
    #[serde(default)] pub triggered: bool,
    #[serde(default, rename = "fromItem")] pub from_item: bool,
    #[serde(default)] pub support: bool,
    #[serde(rename = "castTime", deserialize_with = "de_opt_f64")] pub cast_time: Option<f64>,
    #[serde(rename = "levelCooldown", deserialize_with = "de_opt_f64")] pub level_cooldown: Option<f64>,
    #[serde(rename = "baseFlags", default)] pub base_flags: HashMap<String, bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SrcInstanceInfo {
    #[serde(rename = "fromItem", default)] pub from_item: bool,
    #[serde(default)] pub triggered: bool,
    #[serde(rename = "triggerChance", deserialize_with = "de_opt_f64")] pub trigger_chance: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct TriggeredByInfo {
    pub name: Option<String>,
    pub id: Option<String>,
    #[serde(rename = "fromItem", default)] pub from_item: bool,
    #[serde(default)] pub support: bool,
    #[serde(rename = "levelCooldown", deserialize_with = "de_opt_f64")] pub level_cooldown: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SocketGroupInfo {
    pub slot: Option<String>,
    pub source: Option<String>,
    /// Exact identity of the physical socket group (`skill.socketGroup` table identity in upstream); set by live callers only.
    #[serde(rename = "groupId", default)] pub group_id: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SupportInfo {
    pub name: String,
    #[serde(rename = "fromItem", default)] pub from_item: bool,
    #[serde(default)] pub support: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Skill {
    pub uuid: Option<String>,
    #[serde(rename = "skillData", default)] pub skill_data: ScalarMap,
    #[serde(rename = "skillFlags", default)] pub skill_flags: ScalarMap,
    #[serde(rename = "skillTypes", default)] pub skill_types: HashMap<String, bool>,
    #[serde(rename = "skillCfgFlags", default)] pub skill_cfg_flags: u64,
    #[serde(rename = "skillCfgKeywordFlags", default)] pub skill_cfg_keyword_flags: u64,
    #[serde(rename = "skillCond", default)] pub skill_cond: HashMap<String, bool>,
    #[serde(rename = "slotName")] pub slot_name: Option<String>,
    pub ge: GrantedEffectInfo,
    #[serde(rename = "srcInstance")] pub src_instance: Option<SrcInstanceInfo>,
    #[serde(rename = "aeLevel", deserialize_with = "de_opt_f64")] pub ae_level: Option<f64>,
    #[serde(rename = "triggeredBy")] pub triggered_by: Option<TriggeredByInfo>,
    #[serde(rename = "socketGroup")] pub socket_group: Option<SocketGroupInfo>,
    #[serde(rename = "skillPartName")] pub skill_part_name: Option<String>,
    #[serde(rename = "skillPart", deserialize_with = "de_opt_f64")] pub skill_part: Option<f64>,
    #[serde(rename = "hasMinion", default)] pub has_minion: bool,
    #[serde(rename = "supportList", default)] pub support_list: Vec<SupportInfo>,
    #[serde(rename = "coreCalc")] pub core_calc: CoreCalc,
    /// `calcLib.canGrantedEffectSupportActiveSkill(mainSkill.triggeredBy.gemData.grantedEffect, this skill)` (live callers only).
    #[serde(rename = "canSupportByMainTrigger", default)] pub can_support_by_main_trigger: bool,
    /// Arcanist Brand: `(100 + Sum("INC", cfg, "Speed", "BrandActivationFrequency")) / 100` and `More(cfg, "BrandActivationFrequency")`
    /// of this skill's own modList (live callers set them for Arcanist Brand only).
    #[serde(rename = "brandActivationFreqInc", default)] pub brand_activation_freq_inc: f64,
    #[serde(rename = "brandActivationFreqMore", default)] pub brand_activation_freq_more: f64,
    /// `cacheSkillUUID(skill, env)` as upstream builds it ("Name_SLOT_gemIndex_groupIndex"): the Calcs tab splits it on "_" for its SimData rows.
    #[serde(rename = "luaUuid", default)] pub lua_uuid: String,
    /// The owning gem's game-data `tags` (data_gems.json, e.g. "strike"); empty for item-only skills.
    #[serde(rename = "gemTags", default)] pub gem_tags: HashMap<String, bool>,
}

impl Skill {
    pub fn has_skill_type(&self, id: i64) -> bool { self.skill_types.get(&id.to_string()).copied().unwrap_or(false) }
    pub fn disabled(&self) -> bool { flag(&self.skill_flags, "disable") }
    pub fn used_by_mirage(&self) -> bool { self.skill_cond.get("usedByMirage").copied().unwrap_or(false) }
    pub fn name(&self) -> &str { self.ge.name.as_deref().unwrap_or("") }
    pub fn name_lower(&self) -> String { self.name().to_lowercase() }
    pub fn mod_flags(&self, f: u64) -> bool { self.skill_cfg_flags & f != 0 }
}

/// Port of `isTriggered(skill)` (CalcTriggers.lua:41).
pub fn is_triggered(skill: &Skill) -> bool {
    flag(&skill.skill_data, "triggeredByUnique")
        || flag(&skill.skill_data, "triggered")
        || skill.has_skill_type(INBUILT_TRIGGER)
        || skill.has_skill_type(TRIGGERED)
        || skill.ge.triggered
        || skill.src_instance.as_ref().map(|s| s.triggered).unwrap_or(false)
}

/// Port of `slotMatch(env, skill)` (CalcTriggers.lua:33). `main` is env.player.mainSkill.
///
/// `match2` is `skill.socketGroup == env.player.mainSkill.socketGroup` in upstream - literal
/// Lua table identity, true for two different skills exactly when they're gems in the same
/// physical link group. The recorder only captures a group's
/// `slot`/`source` strings, not an identity token, and both are nil for the common case of a
/// manually-added skill group (no item slot, no XML `source` attribute).
/// `skill` and `main` being the very same skill is always provably the
/// same group. Short of that, when slot/source are both nil on both sides, this falls back to
/// comparing `supportList`: upstream computes each active skill's supportList from the support gems
/// actually linked in its own socket group, so two different skills with an identical *non-empty*
/// supportList are, in every corpus case checked, gems in the same physical group (e.g. a CoC
/// attack skill and its triggered spells all show the same `[...,"Cast On Critical Strike",...]`
/// list). Two empty supportLists are not treated as a match - too common and unrelated (e.g. two
/// separate unsupported auras) to serve as an identity proxy.
pub fn slot_match(main: &Skill, skill: &Skill) -> bool {
    if std::ptr::eq(main, skill) { return true; }
    let from_item = main.ge.from_item
        || skill.ge.from_item
        || main.src_instance.as_ref().map(|s| s.from_item).unwrap_or(false)
        || skill.src_instance.as_ref().map(|s| s.from_item).unwrap_or(false);
    let match1 = from_item
        && skill.socket_group.as_ref().and_then(|s| s.slot.as_deref()).is_some()
        && skill.socket_group.as_ref().and_then(|s| s.slot.as_deref())
            == main.socket_group.as_ref().and_then(|s| s.slot.as_deref());
    let exact = match (skill.socket_group.as_ref().and_then(|g| g.group_id), main.socket_group.as_ref().and_then(|g| g.group_id)) {
        (Some(a), Some(b)) => Some(a == b),
        _ => None,
    };
    let match2 = !main.ge.from_item
        && match exact {
            Some(e) => e,
            None => slot_group_eq(&skill.socket_group, &main.socket_group) || support_list_eq(&skill.support_list, &main.support_list),
        };
    match1 || match2
}
fn slot_group_eq(a: &Option<SocketGroupInfo>, b: &Option<SocketGroupInfo>) -> bool {
    match (a, b) {
        (Some(x), Some(y)) if x.slot.is_some() || x.source.is_some() || y.slot.is_some() || y.source.is_some() => {
            x.slot == y.slot && x.source == y.source
        }
        _ => false,
    }
}
fn support_list_eq(a: &[SupportInfo], b: &[SupportInfo]) -> bool {
    if a.is_empty() || b.is_empty() || a.len() != b.len() { return false; }
    let mut a: Vec<(&str, bool, bool)> = a.iter().map(|s| (s.name.as_str(), s.from_item, s.support)).collect();
    let mut b: Vec<(&str, bool, bool)> = b.iter().map(|s| (s.name.as_str(), s.from_item, s.support)).collect();
    a.sort_unstable();
    b.sort_unstable();
    a == b
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GcEntry {
    #[serde(rename = "hitSpeed", deserialize_with = "de_opt_f64")] pub hit_speed: Option<f64>,
    #[serde(deserialize_with = "de_opt_f64")] pub speed: Option<f64>,
    #[serde(rename = "critChance", deserialize_with = "de_opt_f64")] pub crit_chance: Option<f64>,
    #[serde(rename = "hitChance", deserialize_with = "de_opt_f64")] pub hit_chance: Option<f64>,
    #[serde(rename = "totalDPS", deserialize_with = "de_opt_f64")] pub total_dps: Option<f64>,
    #[serde(rename = "manaCost", deserialize_with = "de_opt_f64")] pub mana_cost: Option<f64>,
    #[serde(rename = "lifeCost", deserialize_with = "de_opt_f64")] pub life_cost: Option<f64>,
    #[serde(rename = "dpsMultiplier", deserialize_with = "de_opt_f64")] pub dps_multiplier: Option<f64>,
    #[serde(rename = "manaCostRaw", deserialize_with = "de_opt_f64")] pub mana_cost_raw: Option<f64>,
    #[serde(rename = "projectileCount", deserialize_with = "de_opt_f64")] pub projectile_count: Option<f64>,
    #[serde(rename = "battleCryExertsCount", deserialize_with = "de_opt_f64")] pub battle_cry_exerts_count: Option<f64>,
    #[serde(rename = "battleMageCryDuration", deserialize_with = "de_opt_f64")] pub battle_mage_cry_duration: Option<f64>,
    #[serde(rename = "battleMageCryCastTime", deserialize_with = "de_opt_f64")] pub battle_mage_cry_cast_time: Option<f64>,
    #[serde(rename = "battleMageCryCooldown", deserialize_with = "de_opt_f64")] pub battle_mage_cry_cooldown: Option<f64>,
    #[serde(rename = "infernalExertsCount", deserialize_with = "de_opt_f64")] pub infernal_exerts_count: Option<f64>,
    #[serde(rename = "infernalCryDuration", deserialize_with = "de_opt_f64")] pub infernal_cry_duration: Option<f64>,
    #[serde(rename = "infernalCryCastTime", deserialize_with = "de_opt_f64")] pub infernal_cry_cast_time: Option<f64>,
    #[serde(rename = "infernalCryCooldown", deserialize_with = "de_opt_f64")] pub infernal_cry_cooldown: Option<f64>,
    #[serde(deserialize_with = "de_opt_f64")] pub duration: Option<f64>,
    #[serde(rename = "mainHandHitChance", deserialize_with = "de_opt_f64")] pub main_hand_hit_chance: Option<f64>,
    #[serde(rename = "offHandHitChance", deserialize_with = "de_opt_f64")] pub off_hand_hit_chance: Option<f64>,
    #[serde(rename = "mainHandCritChance", deserialize_with = "de_opt_f64")] pub main_hand_crit_chance: Option<f64>,
    #[serde(rename = "offHandCritChance", deserialize_with = "de_opt_f64")] pub off_hand_crit_chance: Option<f64>,
    #[serde(rename = "battlemageUpTimeRatio", deserialize_with = "de_opt_f64")] pub battlemage_up_time_ratio: Option<f64>,
    #[serde(rename = "infernalUpTimeRatio", deserialize_with = "de_opt_f64")] pub infernal_up_time_ratio: Option<f64>,
    #[serde(rename = "totemLife", deserialize_with = "de_opt_f64")] pub totem_life: Option<f64>,
    #[serde(rename = "hitTime", deserialize_with = "de_opt_f64")] pub hit_time: Option<f64>,
    #[serde(deserialize_with = "de_opt_f64")] pub time: Option<f64>,
    #[serde(rename = "mainSkillChanceToTriggerOnCrit", deserialize_with = "de_opt_f64")] pub main_skill_chance_to_trigger_on_crit: Option<f64>,
}
impl GcEntry {
    pub fn cached_speed(&self) -> Option<f64> { self.hit_speed.or(self.speed) }
}

pub type GlobalCache = HashMap<String, GcEntry>;

thread_local! {
    /// uuids `findTriggerSkill` looked up that were not in the cache (upstream would `buildActiveSkill` them).
    /// FullDPS (CALCULATOR) replay of a skill whose own cache entry was last written by a Mirage Archer run (no cost output).
    pub static SELF_CACHE_STALE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    pub static GC_MISSES: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}
pub fn take_gc_misses() -> Vec<String> { GC_MISSES.with(|m| std::mem::take(&mut *m.borrow_mut())) }

thread_local! {
    /// The Calcs mode asks for the breakdown tables (`actor.breakdown` exists): the handlers then fill `TriggerResult::tables`.
    static BD_ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
/// Turns the breakdown tables of `calcs.triggers` on or off; returns the previous setting.
pub fn set_breakdown(on: bool) -> bool { BD_ON.with(|c| c.replace(on)) }
pub fn breakdown_on() -> bool { BD_ON.with(|c| c.get()) }


#[derive(Debug, Clone, Deserialize, Default)]
pub struct TrigCall {
    #[serde(default)] pub snipe_stages: f64,
    #[serde(rename = "intuitiveLinkRate", default)] pub intuitive_link_rate: f64,
    pub actor: String, // "player" | "minion"
    pub mode: String,
    #[serde(rename = "mainSkillIdx")] pub main_skill_idx: Option<usize>,
    #[serde(rename = "minionSkillBefore")] pub minion_skill_before: Option<Skill>,
    #[serde(rename = "limitedSkillsBefore", default)] pub limited_skills_before: Vec<String>,
    #[serde(rename = "outputBefore", default)] pub output_before: ScalarMap,
    #[serde(rename = "enemyIgnited", default)] pub enemy_ignited: bool,
    #[serde(rename = "doomBlastSource")] pub doom_blast_source: Option<String>,
    #[serde(rename = "haveTriggerBots", default)] pub have_trigger_bots: bool,
    #[serde(rename = "weapon1Present", default)] pub weapon1_present: bool,
    #[serde(rename = "weapon2Present", default)] pub weapon2_present: bool,
    #[serde(rename = "vixensBaseCooldown", deserialize_with = "de_opt_f64")] pub vixens_base_cooldown: Option<f64>,
    /// `env.player.modDB:Flag(nil, "Condition:Phasing")` (The Hidden Blade).
    #[serde(default)] pub phasing: bool,
    /// `env.player.modDB:Flag(nil, "Condition:KilledRecently")` (Squirming Terror, Cast on Melee Kill).
    #[serde(rename = "killedRecently", default)] pub killed_recently: bool,
    /// `env.player.modDB:Sum("BASE", nil, "BloodShrineExplodingToadTriggerChance")`.
    #[serde(rename = "bloodShrineToadChance", default)] pub blood_shrine_toad_chance: f64,
    #[serde(rename = "focusDuration", default, deserialize_with = "de_opt_f64")] pub focus_duration: Option<f64>,
    #[serde(rename = "focusBaseCooldown", default, deserialize_with = "de_opt_f64")] pub focus_base_cooldown: Option<f64>,
    #[serde(rename = "glovesTitleHasVixen", default)] pub gloves_title_has_vixen: bool,
    /// `env.player.itemList[mainSkill.skillCfg.slotName].name` (the item `modSource` is `Item:<id>:<name>`).
    #[serde(rename = "mainSlotItemName", default)] pub main_slot_item_name: Option<String>,
    #[serde(rename = "curseOverlaps", default)] pub curse_overlaps: Option<f64>,
    /// `env.player.modDB:Sum("BASE", nil, "KitavaRequiredManaCost" | "KitavaTriggerChance" | "FoulbornKitavaRequiredLifeCost" | "FoulbornKitavaTriggerChance")`.
    #[serde(rename = "kitavaMana", default)] pub kitava_required_mana_cost: f64,
    #[serde(rename = "kitavaChance", default)] pub kitava_trigger_chance: f64,
    #[serde(rename = "foulbornKitavaLife", default)] pub foulborn_kitava_required_life_cost: f64,
    #[serde(rename = "foulbornKitavaChance", default)] pub foulborn_kitava_trigger_chance: f64,
    #[serde(rename = "globalCache", default)] pub global_cache: GlobalCache,
    pub ok: bool,
    pub err: Option<String>,
    #[serde(rename = "mainSkillDataAfter", default)] pub main_skill_data_after: ScalarMap,
    #[serde(rename = "mainSkillFlagsAfter", default)] pub main_skill_flags_after: ScalarMap,
    #[serde(rename = "outputAfter", default)] pub output_after: ScalarMap,
    #[serde(rename = "infoMessage")] pub info_message: Option<String>,
    #[serde(rename = "infoMessage2")] pub info_message2: Option<String>,
    #[serde(rename = "infoTrigger")] pub info_trigger: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct ResourceCounts { pub found: Option<bool>, #[serde(rename = "skillIdx")] pub skill_idx: Option<usize>,
    #[serde(rename = "tabDouble", default)] pub tab_double: Vec<f64>,
    #[serde(rename = "tabExertInc", default)] pub tab_exert_inc: Vec<f64>,
    #[serde(rename = "tabExertMore", default)] pub tab_exert_more: Vec<f64>,
    #[serde(rename = "tabExertAttackMore", default)] pub tab_exert_attack_more: Vec<f64>,
    #[serde(rename = "tabOverexertMore", default)] pub tab_overexert_more: Vec<f64>,
    #[serde(rename = "tabDoubleDmgChance", default)] pub tab_double_dmg_chance: Vec<f64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MirageArcherFacts { #[serde(rename = "lessDamage")] pub less_damage: f64, #[serde(rename = "lessAttackSpeed")] pub less_attack_speed: f64, #[serde(rename = "maxCount")] pub max_count: f64 }
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SaviourFacts { #[serde(rename = "lessDamage")] pub less_damage: f64, #[serde(rename = "maxCount")] pub max_count: f64 }
#[derive(Debug, Clone, Deserialize, Default)]
pub struct TawhoaFacts { #[serde(rename = "moreDamage")] pub more_damage: f64 }
#[derive(Debug, Clone, Deserialize, Default)]
pub struct SacredWispsFacts { #[serde(rename = "lessDamage")] pub less_damage: f64, #[serde(rename = "wispsCastChance")] pub wisps_cast_chance: Option<f64>, #[serde(rename = "wispsMaxCount")] pub wisps_max_count: Option<f64> }

#[derive(Debug, Clone, Deserialize, Default)]
pub struct SkillDataFlags {
    #[serde(rename = "triggeredByMirageArcher", default)] pub triggered_by_mirage_archer: bool,
    #[serde(rename = "triggeredBySacredWisps", default)] pub triggered_by_sacred_wisps: bool,
    #[serde(rename = "triggeredByGeneralsCry", default)] pub triggered_by_generals_cry: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MirageCall {
    pub mode: String,
    #[serde(rename = "mainSkillIdx")] pub main_skill_idx: Option<usize>,
    #[serde(rename = "usedByMirage")] pub used_by_mirage: bool,
    pub disabled: bool,
    #[serde(rename = "skillDataFlags")] pub skill_data_flags: SkillDataFlags,
    #[serde(rename = "aeName")] pub ae_name: Option<String>,
    #[serde(rename = "limitedSkillsBefore", default)] pub limited_skills_before: Vec<String>,
    #[serde(rename = "weapon1Name")] pub weapon1_name: Option<String>,
    #[serde(rename = "weapon2Name")] pub weapon2_name: Option<String>,
    #[serde(rename = "mirageArcher")] pub mirage_archer: MirageArcherFacts,
    pub saviour: SaviourFacts,
    pub tawhoa: TawhoaFacts,
    #[serde(rename = "sacredWisps")] pub sacred_wisps: SacredWispsFacts,
    #[serde(rename = "generalsCry")] pub generals_cry: Option<ResourceCounts>,
    #[serde(rename = "globalCache", default)] pub global_cache: GlobalCache,
    pub ok: bool,
    pub err: Option<String>,
    #[serde(rename = "retFalseMeansOffenceRanBySelf")] pub ret_false_means_offence_ran_by_self: Option<bool>,
    #[serde(rename = "aeNameAfter")] pub ae_name_after: Option<String>,
    #[serde(rename = "mainSkillFlagsAfter", default)] pub main_skill_flags_after: ScalarMap,
    #[serde(rename = "mainSkillDataAfter", default)] pub main_skill_data_after: ScalarMap,
    #[serde(rename = "outputAfter", default)] pub output_after: ScalarMap,
    pub mirage: Option<J>,
    #[serde(rename = "infoMessage")] pub info_message: Option<String>,
    #[serde(rename = "infoMessage2")] pub info_message2: Option<String>,
    #[serde(rename = "disableReason")] pub disable_reason: Option<String>,
}

pub mod engine;
pub mod config;
pub mod triggers;
pub mod mirages;

pub use engine::*;
pub use triggers::calcs_triggers;
pub use mirages::calcs_mirages;
