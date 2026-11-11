//! `buffExports` of CalcPerform.lua (Export Support): what the Import/Export tab's "Export Support" switch makes the
//! original write into the build file as `<ExportedBuffs>` (PartyTab.lua `setBuffExports` / `exportBuffs`).
//!
//! Upstream fills `buffExports` in the main calculation only (`env.mode ~= "CALCULATOR"`): the buff loop adds the
//! auras, curses, warcries and links of every active skill (CalcPerform.lua:2318-2760), the tail of `calcs.perform` adds
//! `CurseLimit`, `extraAura`, the enemy's conditions and modifiers and the player-side stats the party member needs
//! (3218, 3418, 3810-3931). `exportBuffs` then turns each table into text with `modLib.formatSourceMod` lines.
//!
//! Order: Lua tables here are string-keyed, and the real LuaJIT walks them in a hash order that changes from run to run
//! (the string hash is seeded per process), so upstream's own text is not reproducible line for line. This port
//! writes entries in the order the Lua code inserted them.
//!
//! The minion-skill branches of the buff loop (CalcPerform.lua:2777-2990) run for every player skill's minion, not only the
//! build's main one (`collect_minion_skill`); a non-main minion's own modDB is empty in upstream too (`calcs.perform` makes it
//! a fresh `ModDB` and only `env.minion` is initialised), so its `ExtraAuraEffect` and `SelfAuras...` flags read as unset.
//! Not ported: the "preStack Mine auras" fix-up.
use indexmap::IndexMap;
use pom_engine::modifier::{Mod, ModType, Tag};
use pom_engine::modstore::store::{Backing, ModStore};
use pom_engine::sym::Sym;
use pom_engine::value::Value;

thread_local! {
    /// Set by `run` for the main calculation of a build whose Export Support switch is on.
    pub(crate) static EXPORT_ON: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

#[derive(Clone, Debug, Default)]
pub struct ExportEntry {
    pub effect_mult: f64,
    pub is_mark: bool,
    pub mods: Vec<Mod>,
}

#[derive(Clone, Debug)]
pub enum AuraEntry {
    Buff(ExportEntry),
    /// `buffExports.Aura.otherEffects`: buffs that apply to allies, by buff name.
    Other(IndexMap<String, ExportEntry>),
}

#[derive(Clone, Debug, Default)]
pub struct BuffExports {
    pub aura: IndexMap<String, AuraEntry>,
    pub curse: IndexMap<String, ExportEntry>,
    pub warcry: IndexMap<String, ExportEntry>,
    pub link: IndexMap<String, ExportEntry>,
    pub enemy_mods: IndexMap<String, Vec<Mod>>,
    pub enemy_conditions: Vec<String>,
    pub player_mods: Vec<String>,
    pub curse_limit: f64,
}

// ---- modLib.formatSourceMod ------------------------------------------------------------------------------------------

const MOD_FLAGS: &[(&str, u64)] = &[
    ("Attack", 0x1), ("Spell", 0x2), ("Hit", 0x4), ("Dot", 0x8), ("Cast", 0x10), ("Melee", 0x100), ("Area", 0x200), ("Projectile", 0x400),
    ("SourceMask", 0x600), ("Ailment", 0x800), ("MeleeHit", 0x1000), ("Weapon", 0x2000), ("Axe", 0x10000), ("Bow", 0x20000), ("Claw", 0x40000),
    ("Dagger", 0x80000), ("Mace", 0x100000), ("Staff", 0x200000), ("Sword", 0x400000), ("Wand", 0x800000), ("Unarmed", 0x1000000),
    ("Fishing", 0x2000000), ("WeaponMelee", 0x4000000), ("WeaponRanged", 0x8000000), ("Weapon1H", 0x10000000), ("Weapon2H", 0x20000000),
    ("WeaponMask", 0x2FFF0000),
];

const KEYWORD_FLAGS: &[(&str, u64)] = &[
    ("Aura", 0x1), ("Curse", 0x2), ("Warcry", 0x4), ("Movement", 0x8), ("Physical", 0x10), ("Fire", 0x20), ("Cold", 0x40), ("Lightning", 0x80),
    ("Chaos", 0x100), ("Vaal", 0x200), ("Bow", 0x400), ("Arrow", 0x800), ("Trap", 0x1000), ("Mine", 0x2000), ("Totem", 0x4000), ("Minion", 0x8000),
    ("Attack", 0x10000), ("Spell", 0x20000), ("Hit", 0x40000), ("Ailment", 0x80000), ("Brand", 0x100000), ("Poison", 0x200000), ("Bleed", 0x400000),
    ("Ignite", 0x800000), ("PhysicalDot", 0x1000000), ("LightningDot", 0x2000000), ("ColdDot", 0x4000000), ("FireDot", 0x8000000),
    ("ChaosDot", 0x10000000), ("MatchAll", 0x40000000),
];

/// `modLib.formatFlags`.
fn format_flags(flags: u64, names: &[(&str, u64)]) -> String {
    let mut found: Vec<&str> = names.iter().filter(|(_, v)| flags & v == *v).map(|(n, _)| *n).collect();
    found.sort_unstable();
    if found.is_empty() { "-".to_string() } else { found.join(",") }
}

fn num_str(v: f64) -> String {
    pom_engine::luapat::numeric::fmtnum14g(v)
}

/// A tag or mod parameter as `tostring` / the nested-table forms of ModTools.lua:158-185.
fn format_param(v: &Value) -> String {
    match v {
        Value::Nil => "nil".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) => num_str(*n),
        Value::Str(s) => s.to_string(),
        Value::List(items) => {
            let inner = if items.first().is_some_and(|i| matches!(i, Value::Map(_))) {
                items.iter().map(format_param_tag_like).collect::<Vec<_>>().join(",")
            } else {
                items.iter().map(format_param).collect::<Vec<_>>().join(",")
            };
            format!("{{{inner}}}")
        }
        Value::Map(_) => format!("{{{}}}", format_param_tag_like(v)),
    }
}

/// `modLib.formatTag` on a table value: parameter names sorted, `type` first.
fn format_param_tag_like(v: &Value) -> String {
    let Value::Map(fields) = v else { return format_param(v) };
    let mut names: Vec<(String, &Value)> = Vec::new();
    let mut have_type = None;
    for (k, val) in fields.iter() {
        if k.as_str() == "type" {
            have_type = Some(val);
        } else {
            names.push((k.as_str().to_string(), val));
        }
    }
    names.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut parts: Vec<String> = Vec::new();
    if let Some(t) = have_type {
        parts.push(format!("type={}", format_param(t)));
    }
    for (k, val) in names {
        parts.push(format!("{k}={}", format_param(val)));
    }
    parts.join("/")
}

/// `modLib.formatTag` on a `Tag`.
fn format_tag(tag: &Tag) -> String {
    let mut names: Vec<(String, &Value)> = tag.fields.iter().map(|(k, v)| (k.as_str().to_string(), v)).collect();
    names.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut parts = vec![format!("type={}", tag.kind.as_str())];
    for (k, v) in names {
        parts.push(format!("{k}={}", format_param(v)));
    }
    parts.join("/")
}

fn format_tags(tags: &[Tag]) -> String {
    if tags.is_empty() { "-".to_string() } else { tags.iter().map(format_tag).collect::<Vec<_>>().join(",") }
}

/// `modLib.formatValue`.
fn format_value(v: &Value) -> String {
    match v {
        Value::Map(fields) => {
            let mut names: Vec<(String, &Value)> = Vec::new();
            let mut have_type = None;
            for (k, val) in fields.iter() {
                if k.as_str() == "type" {
                    have_type = Some(val);
                } else {
                    names.push((k.as_str().to_string(), val));
                }
            }
            names.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
            let mut parts: Vec<String> = Vec::new();
            if let Some(t) = have_type {
                parts.push(format!("type={}", format_value(t)));
            }
            for (k, val) in names {
                if k == "mod" {
                    if let Value::Map(inner) = val {
                        parts.push(format!("mod=[{}]", format_mod(&crate::actor_misc::map_to_mod(inner))));
                        continue;
                    }
                }
                parts.push(format!("{k}={}", format_value(val)));
            }
            format!("{{{}}}", parts.join("/"))
        }
        Value::List(items) => format!("{{{}}}", items.iter().map(format_value).collect::<Vec<_>>().join("/")),
        other => format_param(other),
    }
}

fn format_mod_params(m: &Mod) -> String {
    format!("{}|{}|{}|{}|{}", m.name.as_str(), m.ty.as_str(), format_flags(m.flags, MOD_FLAGS), format_flags(m.keyword_flags, KEYWORD_FLAGS), format_tags(&m.tags))
}

fn format_mod(m: &Mod) -> String {
    format!("{} = {}", format_value(&m.value), format_mod_params(m))
}

/// `modLib.formatSourceMod`.
pub fn format_source_mod(m: &Mod) -> String {
    format!("{}|{}|{}", format_value(&m.value), m.source.as_deref().unwrap_or("nil"), format_mod_params(m))
}

// ---- PartyTab.lua exportBuffs ----------------------------------------------------------------------------------------

fn join_lines(buf: &mut String, line: &str) {
    if !buf.is_empty() {
        buf.push('\n');
    }
    buf.push_str(line);
}

impl BuffExports {
    /// `PartyTab:exportBuffs(buffType)`: the text of one block, `""` when the table is empty.
    pub fn text(&self, block: &str) -> String {
        let mut buf = String::new();
        match block {
            "PlayerMods" => {
                for l in &self.player_mods {
                    join_lines(&mut buf, l);
                }
            }
            "EnemyConditions" => {
                for l in &self.enemy_conditions {
                    join_lines(&mut buf, l);
                }
            }
            "EnemyMods" => {
                for (name, mods) in &self.enemy_mods {
                    join_lines(&mut buf, name);
                    for m in mods {
                        buf.push('\n');
                        buf.push_str(&format_source_mod(m));
                    }
                }
            }
            "Aura" => {
                for (name, entry) in &self.aura {
                    match entry {
                        AuraEntry::Buff(e) => {
                            if name == "extraAura" && e.mods.is_empty() {
                                continue;
                            }
                            join_lines(&mut buf, name);
                            if name != "extraAura" {
                                buf.push('\n');
                                buf.push_str(&num_str(e.effect_mult * 100.0));
                            }
                            for m in &e.mods {
                                buf.push('\n');
                                buf.push_str(&format_source_mod(m));
                            }
                            buf.push_str("\n---");
                        }
                        AuraEntry::Other(inner) => {
                            join_lines(&mut buf, name);
                            for (inner_name, e) in inner {
                                for m in &e.mods {
                                    buf.push('\n');
                                    buf.push_str(&format!("{}|{}|{}", inner_name, num_str(e.effect_mult * 100.0), format_source_mod(m)));
                                }
                            }
                            buf.push_str("\n---");
                        }
                    }
                }
            }
            "Curse" => {
                buf = format!("--- Curse Limit ---\n{}", num_str(self.curse_limit));
                for (name, e) in &self.curse {
                    buf.push('\n');
                    buf.push_str(name);
                    buf.push('\n');
                    buf.push_str(&num_str(e.effect_mult * 100.0));
                    buf.push_str(if e.is_mark { "\ntrue" } else { "\nfalse" });
                    for m in &e.mods {
                        buf.push('\n');
                        buf.push_str(&format_source_mod(m));
                    }
                    buf.push_str("\n---");
                }
            }
            "Warcry" | "Link" => {
                let table = if block == "Warcry" { &self.warcry } else { &self.link };
                for (name, e) in table {
                    join_lines(&mut buf, name);
                    buf.push('\n');
                    buf.push_str(&num_str(e.effect_mult * 100.0));
                    for m in &e.mods {
                        buf.push('\n');
                        buf.push_str(&format_source_mod(m));
                    }
                    buf.push_str("\n---");
                }
            }
            _ => {}
        }
        buf
    }

    /// The `<ExportedBuffs name=...>` blocks in the order `PartyTab:Save` writes them, empty ones left out.
    pub fn blocks(&self) -> Vec<(&'static str, String)> {
        [("PartyMemberStats", "PlayerMods"), ("Aura", "Aura"), ("Curse", "Curse"), ("Warcry Skills", "Warcry"), ("Link Skills", "Link"), ("EnemyConditions", "EnemyConditions"), ("EnemyMods", "EnemyMods")]
            .into_iter()
            .map(|(name, key)| (name, self.text(key)))
            .filter(|(_, t)| !t.is_empty())
            .collect()
    }
}

/// The names `calcs.initModDB` (CalcSetup.lua:19-121) gives a fresh modDB, in the order it adds them; the enemy modDB then gets `Accuracy` and
/// `Condition:AgainstDamageOverTime` (CalcSetup.lua:677-678) before the config tab's mods. `pairs(enemyDB.mods)` meets the keys in this order.
const ENEMY_INIT_NAMES: &[&str] = &[
    "FireResistMax",
    "ColdResistMax",
    "LightningResistMax",
    "ChaosResistMax",
    "TotemFireResistMax",
    "TotemColdResistMax",
    "TotemLightningResistMax",
    "TotemChaosResistMax",
    "BlockChanceMax",
    "SpellBlockChanceMax",
    "SpellDodgeChanceMax",
    "ChargeDuration",
    "PowerChargesMax",
    "FrenzyChargesMax",
    "EnduranceChargesMax",
    "SiphoningChargesMax",
    "ChallengerChargesMax",
    "BlitzChargesMax",
    "InspirationChargesMax",
    "CrabBarriersMax",
    "BrutalChargesMax",
    "BrineChargesMax",
    "PhysicalDamageGainAsCold",
    "PhysicalDamageGainAsLightning",
    "AbsorptionChargesMax",
    "AfflictionChargesMax",
    "BloodChargesMax",
    "MaxLifeLeechRate",
    "MaxManaLeechRate",
    "ImpaleStacksMax",
    "SoulEaterMax",
    "BleedStacksMax",
    "MaxEnergyShieldLeechRate",
    "MaxLifeLeechInstance",
    "MaxManaLeechInstance",
    "MaxEnergyShieldLeechInstance",
    "TrapThrowingTime",
    "MineLayingTime",
    "WarcryCastTime",
    "TotemPlacementTime",
    "BallistaPlacementTime",
    "ActiveTotemLimit",
    "ShockStacksMax",
    "ScorchStacksMax",
    "MovementSpeed",
    "DamageTaken",
    "Damage",
    "ActionSpeed",
    "Condition:Burning",
    "Condition:Poisoned",
    "Blind",
    "Chill",
    "Freeze",
    "Fortify",
    "Fortified",
    "Excommunicated",
    "Fanaticism",
    "Onslaught",
    "UnholyMight",
    "ChaoticMight",
    "Tailwind",
    "Adrenaline",
    "AccelerationShrine",
    "BrutalShrine",
    "DiamondShrine",
    "DivineShrine",
    "EchoingShrine",
    "GloomShrine",
    "GreaterFreezingShrine",
    "GreaterShockingShrine",
    "GreaterSkeletalShrine",
    "ImpenetrableShrine",
    "MassiveShrine",
    "ReplenishingShrine",
    "ResistanceShrine",
    "ResonatingShrine",
    "LesserAccelerationShrine",
    "LesserBrutalShrine",
    "LesserImpenetrableShrine",
    "LesserMassiveShrine",
    "LesserReplenishingShrine",
    "LesserResistanceShrine",
    "BloodShrineOfRats",
    "BloodShrineOfLocusts",
    "BloodShrineOfToads",
    "BloodShrineOfCrows",
    "BloodShrineOfBats",
    "AlchemistsGenius",
    "LuckyHits",
    "Convergence",
    "PhysicalDamageReduction",
    "CritChanceCap",
    "Accuracy",
    "Condition:AgainstDamageOverTime",
];

/// Position of a slot in `itemsTab.orderedSlots` (ItemsTab.lua:153-196): the base slots in order, each Weapon slot followed by
/// its Swap slot and abyssal sockets, then the slot's own abyssal sockets; jewel sockets after those.
fn slot_order_key(name: &str) -> (u8, usize, usize, String) {
    const BASE: [&str; 18] = ["Weapon 1", "Weapon 2", "Helmet", "Body Armour", "Gloves", "Boots", "Amulet", "Ring 1", "Ring 2", "Ring 3", "Belt", "Graft 1", "Graft 2", "Flask 1", "Flask 2", "Flask 3", "Flask 4", "Flask 5"];
    let abyssal_n = |s: &str| s.rsplit(' ').next().and_then(|n| n.parse::<usize>().ok()).unwrap_or(0);
    if let Some(i) = BASE.iter().position(|b| *b == name) {
        return (0, i, 0, String::new());
    }
    for (i, b) in BASE.iter().enumerate() {
        if let Some(rest) = name.strip_prefix(b) {
            if rest == " Swap" {
                return (0, i, 1, String::new());
            }
            if rest.starts_with(" Swap Abyssal Socket ") {
                return (0, i, 10 + abyssal_n(rest), String::new());
            }
            if rest.starts_with(" Abyssal Socket ") {
                return (0, i, 20 + abyssal_n(rest), String::new());
            }
        }
    }
    if let Some(id) = name.strip_prefix("Jewel ").and_then(|n| n.parse::<usize>().ok()) {
        return (1, id, 0, String::new());
    }
    (2, 0, 0, name.to_string())
}

/// The config tab's custom mods go into upstream's modDB before the mods the tree, items and skills add; this engine lists
/// them after those, so they are moved back in front of the first such mod.
fn custom_before_game_mods(mods: &mut Vec<Mod>) {
    let game = |m: &Mod| m.source.as_deref().is_some_and(|x| x.starts_with("Tree:") || x.starts_with("Item:") || x.starts_with("Skill:"));
    let custom = |m: &Mod| m.source.as_deref().is_some_and(|x| x.starts_with("Custom:"));
    let Some(first) = mods.iter().position(game) else { return };
    let moved: Vec<Mod> = mods.iter().filter(|m| custom(m)).cloned().collect();
    if moved.is_empty() {
        return;
    }
    let mut out: Vec<Mod> = Vec::with_capacity(mods.len());
    for (i, m) in mods.iter().enumerate() {
        if i == first {
            out.extend(moved.iter().cloned());
        }
        if !custom(m) {
            out.push(m.clone());
        }
    }
    *mods = out;
}

// ---- collection ------------------------------------------------------------------------------------------------------

fn s(n: &str) -> Sym {
    Sym::new(n)
}

/// Mods merged by `modLib.compareModParams`, values added (the `extraAuraModList` loops).
fn merge_extra(values: Vec<Value>) -> Vec<Mod> {
    let mut out: Vec<Mod> = Vec::new();
    for v in values {
        let Value::Map(outer) = v else { continue };
        let Some((_, Value::Map(inner))) = outer.iter().find(|(k, _)| k.as_str() == "mod") else { continue };
        let m = crate::actor_misc::map_to_mod(inner);
        if let Some(existing) = out.iter_mut().find(|e| e.name == m.name && e.ty == m.ty && e.flags == m.flags && e.keyword_flags == m.keyword_flags && e.tags == m.tags) {
            if let (Value::Num(a), Value::Num(b)) = (&existing.value, &m.value) {
                existing.value = Value::Num(a + b);
            }
        } else {
            out.push(m);
        }
    }
    out
}

fn names(list: &[&str]) -> Vec<Sym> {
    list.iter().map(|n| s(n)).collect()
}

/// One of a player skill's minion's own skills with its buffs (`activeSkill.minion.activeSkillList`).
pub(crate) struct MinionSkill {
    /// Index of the player skill that owns the minion.
    pub owner: usize,
    pub minion_name: String,
    /// The owning player skill has the `spectre` flag (`setSpectreSource`).
    pub is_spectre: bool,
    /// The minion is the build's `env.minion`.
    pub is_main: bool,
    /// `activeMinionSkill.skillData.enable`.
    pub enable: bool,
    pub sb: pom_calc::perform::SkillBuffs,
    pub sml: ModStore,
    pub stack_count: Option<f64>,
}

/// The skill-driven part of `buffExports`: one pass over every active skill's buff list in `activeSkillList` order.
/// `warcry` maps `(skill index, buff index)` to the (power, uptime) the warcry pass computed.
pub(crate) fn collect_skills(
    player: &ModStore,
    enemy: &ModStore,
    pairs: &[(pom_calc::perform::SkillBuffs, ModStore)],
    skills: &[pom_skills::assemble::ComputedSkill],
    warcry: &pom_engine::fxhash::HashMap<(usize, usize), (f64, f64)>,
    config_input: &pom_engine::fxhash::HashMap<String, f64>,
    minion_skills: &[MinionSkill],
    minion: Option<&ModStore>,
    weapon1: &pom_engine::fxhash::HashMap<String, f64>,
    main_cfg: Option<&pom_engine::modstore::types::Cfg>,
) -> BuffExports {
    use pom_skills::skill_type as st;
    let mode = pom_calc::setup::buff_mode();
    let mut ex = BuffExports::default();
    // `enemyDB.conditions["AffectedBy<buff>"]` as the debuff branches of this loop set it.
    let mut enemy_affected: std::collections::HashSet<String> = std::collections::HashSet::new();
    let flag = |n: &str| player.flag(None, &[s(n)]);
    let aura_names = names(&["AuraEffect", "BuffEffect"]);
    let debuff_names = names(&["AuraEffect", "BuffEffect", "DebuffEffect"]);
    for (si, ((skill, sml), c)) in pairs.iter().zip(skills.iter()).enumerate() {
        let cfg = &skill.cfg;
        let sd = crate::offence::skill_data_map(player, c);
        for (bi, b) in skill.buff_list.iter().enumerate() {
            if !b.gate_ok {
                continue;
            }
            match b.ty.as_str() {
                "Buff" => {
                    if mode.buffs && (!skill.is_totem || b.allow_totem_buff) && (b.apply_allies || sml.flag(None, &[s("BuffAppliesToAllies")]) || sml.flag(None, &[s("BuffAppliesToPartyMembers")])) {
                        let scfg = b.active_skill_buff.then_some(cfg);
                        let store = if b.active_skill_buff { sml } else { player };
                        let inc = store.sum(ModType::Inc, scfg, &[s("BuffEffect")]) + sml.sum(ModType::Inc, scfg, &[s(&format!("{}Effect", b.name.replace(' ', "")))]);
                        let more = store.more(scfg, &[s("BuffEffect")]);
                        let entry = ExportEntry { effect_mult: (1.0 + inc / 100.0) * more, is_mark: false, mods: b.mod_list.clone() };
                        match ex.aura.entry("otherEffects".to_string()).or_insert_with(|| AuraEntry::Other(IndexMap::new())) {
                            AuraEntry::Other(m) => {
                                m.insert(b.name.clone(), entry);
                            }
                            AuraEntry::Buff(_) => {}
                        }
                    }
                }
                "Warcry" => {
                    if mode.buffs && !sml.flag(None, &[s("CannotShareWarcryBuffs")]) {
                        let Some(&(warcry_power, uptime)) = warcry.get(&(si, bi)) else { continue };
                        let inc = sml.sum(ModType::Inc, Some(cfg), &[s("BuffEffect")]);
                        let more = sml.more(Some(cfg), &[s("BuffEffect")]);
                        // `warcryBuff[1].warcryPowerBonus` is written onto the shared tag (CalcPerform.lua:2382).
                        let mut mods = b.mod_list.clone();
                        for m in mods.iter_mut() {
                            let bonus = m.tags.first().and_then(|t| {
                                let is_warcry = matches!(t.get(s("effectType")), Value::Str(x) if &**x == "Warcry");
                                match (is_warcry, t.get(s("div"))) {
                                    (true, Value::Num(div)) if *div != 0.0 => {
                                        let limit = if let Value::Num(l) = t.get(s("limit")) { Some(*l) } else { None };
                                        Some((limit.map_or(warcry_power, |l| warcry_power.min(l)) / div).floor())
                                    }
                                    _ => None,
                                }
                            });
                            if let Some(bonus) = bonus {
                                m.tags[0].fields.push((s("warcryPowerBonus"), Value::Num(bonus)));
                            }
                        }
                        // Rallying Cry's ally damage (CalcPerform.lua:2419-2437), built only while the build has a minion.
                        let is_rallying = pom_skills::data::all_skills().get(&c.granted_effect_id).and_then(|g| g.name.as_deref()) == Some("Rallying Cry");
                        if is_rallying && minion.is_some() {
                            let bonus = (warcry_power.min(30.0) / 5.0).floor();
                            let effect = (sml.sum(ModType::Base, main_cfg, &[s("RallyingCryAllyDamageBonusPer5Power")]) * bonus).floor();
                            for dt in ["Physical", "Lightning", "Cold", "Fire", "Chaos"] {
                                for end in ["Min", "Max"] {
                                    if let Some(w) = weapon1.get(&format!("{dt}{end}")) {
                                        mods.push(Mod {
                                            name: s(&format!("{dt}{end}")),
                                            ty: ModType::Base,
                                            value: Value::Num(w * effect / 100.0),
                                            flags: 0,
                                            keyword_flags: 0x10000,
                                            source: Some(std::sync::Arc::from("Rallying Cry")),
                                            tags: vec![Tag { kind: s("GlobalEffect"), fields: vec![(s("effectType"), Value::Str(std::sync::Arc::from("Warcry"))), (s("div"), Value::Num(5.0)), (s("limit"), Value::Num(30.0))] }].into(),
                                        });
                                    }
                                }
                            }
                        }
                        ex.warcry.insert(b.name.clone(), ExportEntry { effect_mult: (1.0 + inc / 100.0) * more * uptime, is_mark: false, mods });
                    }
                }
                "Aura" => {
                    if !mode.buffs {
                        continue;
                    }
                    if !(flag("SelfAurasCannotAffectAllies") || flag("SelfAurasOnlyAffectYou") || flag("SelfAuraSkillsCannotAffectAllies")) {
                        let inc = sml.sum(ModType::Inc, Some(cfg), &aura_names);
                        let more = sml.more(Some(cfg), &aura_names);
                        let mult = (1.0 + inc / 100.0) * more;
                        let mut mods = b.mod_list.clone();
                        mods.extend(b.extra_aura_mods.iter().cloned());
                        if let Some(prev) = ex.aura.get(&b.name).cloned() {
                            ex.aura.insert(format!("{}_Debuff", b.name), prev);
                        }
                        ex.aura.insert(b.name.clone(), AuraEntry::Buff(ExportEntry { effect_mult: mult, is_mark: false, mods: mods.clone() }));
                        if flag("AurasAffectEnemies") && !sml.flag(Some(cfg), &[s("SelfAurasAffectYouAndLinkedTarget")]) {
                            let key = format!("{}{}", b.name, if ex.aura.contains_key(&b.name) { "_Debuff" } else { "" });
                            ex.aura.insert(key, AuraEntry::Buff(ExportEntry { effect_mult: mult, is_mark: false, mods }));
                        }
                    }
                    // An aura with an extra debuff but no AuraDebuff of its own (CalcPerform.lua:2548-2577).
                    let extra_debuff = player.list(Some(cfg), &[s("ExtraAuraDebuffEffect")]);
                    if mode.effective && !extra_debuff.is_empty() && !(flag("SelfAurasOnlyAffectYou") || sml.flag(Some(cfg), &[s("SelfAurasAffectYouAndLinkedTarget")])) && !skill.buff_list.iter().any(|x| x.ty == "AuraDebuff") {
                        let list = merge_extra(extra_debuff);
                        let inc = sml.sum(ModType::Inc, Some(cfg), &debuff_names);
                        let more = sml.more(Some(cfg), &debuff_names);
                        let key = format!("{}{}", b.name, if ex.aura.contains_key(&b.name) { "_Debuff" } else { "" });
                        ex.aura.insert(key, AuraEntry::Buff(ExportEntry { effect_mult: (1.0 + inc / 100.0) * more, is_mark: false, mods: list }));
                    }
                }
                "Debuff" | "AuraDebuff" => {
                    let stack_count = if let Some(v) = &b.stack_var {
                        let mut n = sml.sum(ModType::Base, Some(cfg), &[s(&format!("Multiplier:{v}"))]);
                        if let Some(l) = b.stack_limit {
                            n = n.min(l);
                        } else if let Some(lv) = &b.stack_limit_var {
                            n = n.min(sml.sum(ModType::Base, Some(cfg), &[s(&format!("Multiplier:{lv}"))]));
                        }
                        n
                    } else {
                        match sd.get("stackCount") {
                            Some(pom_engine::modstore::types::ScalarValue::Num(n)) => *n,
                            _ => 1.0,
                        }
                    };
                    if mode.effective && stack_count > 0.0 {
                        enemy_affected.insert(b.name.replace(' ', ""));
                        if b.ty == "AuraDebuff" && !flag("SelfAurasOnlyAffectYou") {
                            let extra = merge_extra(player.list(Some(cfg), &[s("ExtraAuraDebuffEffect")]));
                            let inc = sml.sum(ModType::Inc, Some(cfg), &debuff_names);
                            let more = sml.more(Some(cfg), &debuff_names);
                            let mut mods = b.mod_list.clone();
                            mods.extend(extra);
                            let key = format!("{}{}", b.name, if ex.aura.contains_key(&b.name) { "_Debuff" } else { "" });
                            ex.aura.insert(key, AuraEntry::Buff(ExportEntry { effect_mult: (1.0 + inc / 100.0) * more, is_mark: false, mods }));
                        }
                    }
                }
                "Curse" => {
                    let mark = c.skill_types.contains(&st::MARK);
                    let self_cast_cfg = format!("balanceOfTerrorSelfCast{}", b.name.replace(' ', ""));
                    let skip = config_input.get(&self_cast_cfg).is_some_and(|v| *v != 0.0) && !mark;
                    let truthy = |k: &str| matches!(sd.get(k), Some(pom_engine::modstore::types::ScalarValue::Bool(true)));
                    let allowed = (mode.effective && (!enemy.flag(None, &[s("Hexproof")]) || flag("CursesIgnoreHexproof") || truthy("ignoreHexLimit") || truthy("ignoreHexproof"))) || mark;
                    if !skip && allowed {
                        let mut inc = sml.sum(ModType::Inc, Some(cfg), &[s("CurseEffect")]) + enemy.sum(ModType::Inc, None, &[s("CurseEffectOnSelf")]);
                        if c.skill_types.contains(&st::AURA) && !c.skill_types.contains(&st::REMOTE_MINED) {
                            inc += sml.sum(ModType::Inc, Some(cfg), &[s("AuraEffect")]);
                        }
                        let more = sml.more(Some(cfg), &[s("CurseEffect")]);
                        let more_mark = more;
                        let more = if mark { more } else { more * enemy.more(None, &[s("CurseEffectOnSelf")]) };
                        let aura_only_you = (flag("SelfAurasOnlyAffectYou") || sml.flag(Some(cfg), &[s("SelfAurasAffectYouAndLinkedTarget")])) && c.skill_types.contains(&st::AURA);
                        let mult = if aura_only_you { 0.0 } else { (1.0 + inc / 100.0) * more };
                        ex.curse.insert(b.name.clone(), ExportEntry { effect_mult: if mark { mult } else { (1.0 + inc / 100.0) * more_mark }, is_mark: mark, mods: b.mod_list.clone() });
                    }
                }
                "Link" => {
                    if mode.buffs {
                        let extra = merge_extra(player.list(Some(cfg), &[s("ExtraLinkEffect")]));
                        let link_names = names(&["LinkEffect", "BuffEffect"]);
                        let inc = sml.sum(ModType::Inc, Some(cfg), &link_names);
                        let more = sml.more(Some(cfg), &link_names);
                        let mut mods = b.mod_list.clone();
                        mods.extend(extra);
                        ex.link.insert(b.name.clone(), ExportEntry { effect_mult: (1.0 + inc / 100.0) * more, is_mark: false, mods });
                    }
                }
                _ => {}
            }
        }
        for ms in minion_skills.iter().filter(|m| m.owner == si) {
            collect_minion_skill(&mut ex, ms, minion, player, enemy, &mut enemy_affected);
        }
    }
    ex
}

/// `activeMinionSkill.buffList` of CalcPerform.lua:2777-2990: the Buff (`applyAllies`), Aura and AuraDebuff branches' exports.
fn collect_minion_skill(ex: &mut BuffExports, ms: &MinionSkill, minion: Option<&ModStore>, player: &ModStore, enemy: &ModStore, enemy_affected: &mut std::collections::HashSet<String>) {
    let mode = pom_calc::setup::buff_mode();
    let cfg = &ms.sb.cfg;
    let sml = &ms.sml;
    // `castingMinion.modDB` / `activeSkill.minion.modDB`: only the build's own minion is modelled.
    let casting: Option<&ModStore> = if ms.is_main { minion } else { None };
    let empty = ModStore::new_list(None, None);
    let casting_store: &ModStore = casting.unwrap_or(&empty);
    let _ = player;
    let aura_names = names(&["AuraEffect", "BuffEffect"]);
    let debuff_names = names(&["AuraEffect", "BuffEffect", "DebuffEffect"]);
    let set_source = |mods: &mut Vec<Mod>, buff: &str| {
        if ms.is_spectre {
            let src: std::sync::Arc<str> = std::sync::Arc::from(format!("Spectre:{} - {}", buff, ms.minion_name).as_str());
            for m in mods.iter_mut() {
                m.source = Some(src.clone());
            }
        }
    };
    for b in &ms.sb.buff_list {
        match b.ty.as_str() {
            "Buff" => {
                if mode.buffs && ms.enable && b.apply_allies {
                    let scfg = b.active_skill_buff.then_some(cfg);
                    let store = if b.active_skill_buff { sml } else { casting_store };
                    let inc = store.sum(ModType::Inc, scfg, &[s("BuffEffect")]);
                    let more = store.more(scfg, &[s("BuffEffect")]);
                    let entry = ExportEntry { effect_mult: (1.0 + inc / 100.0) * more, is_mark: false, mods: b.mod_list.clone() };
                    match ex.aura.entry("otherEffects".to_string()).or_insert_with(|| AuraEntry::Other(IndexMap::new())) {
                        AuraEntry::Other(m) => {
                            m.insert(b.name.clone(), entry);
                        }
                        AuraEntry::Buff(_) => {}
                    }
                }
            }
            "Aura" => {
                if mode.buffs && ms.enable {
                    let cflag = |n: &str| casting_store.flag(None, &[s(n)]);
                    if !(cflag("SelfAurasCannotAffectAllies") || cflag("SelfAurasOnlyAffectYou") || cflag("SelfAuraSkillsCannotAffectAllies") || sml.flag(Some(cfg), &[s("SelfAurasAffectYouAndLinkedTarget")])) {
                        let extra = merge_extra(casting_store.list(Some(cfg), &[s("ExtraAuraEffect")]));
                        let inc = sml.sum(ModType::Inc, Some(cfg), &aura_names);
                        let more = sml.more(Some(cfg), &aura_names);
                        let mut mods = b.mod_list.clone();
                        mods.extend(extra);
                        set_source(&mut mods, &b.name);
                        if let Some(prev) = ex.aura.get(&b.name).cloned() {
                            ex.aura.insert(format!("{}_Debuff", b.name), prev);
                        }
                        ex.aura.insert(b.name.clone(), AuraEntry::Buff(ExportEntry { effect_mult: (1.0 + inc / 100.0) * more, is_mark: false, mods }));
                    }
                }
            }
            "Debuff" | "AuraDebuff" => {
                let stack_count = if let Some(v) = &b.stack_var {
                    let mut n = sml.sum(ModType::Base, Some(cfg), &[s(&format!("Multiplier:{v}"))]);
                    if let Some(l) = b.stack_limit {
                        n = n.min(l);
                    } else if let Some(lv) = &b.stack_limit_var {
                        n = n.min(sml.sum(ModType::Base, Some(cfg), &[s(&format!("Multiplier:{lv}"))]));
                    }
                    n
                } else {
                    ms.stack_count.unwrap_or(1.0)
                };
                if mode.effective && stack_count > 0.0 {
                    if b.ty == "AuraDebuff" && (!sml.flag(None, &[s("SelfAurasOnlyAffectYou")]) || sml.flag(Some(cfg), &[s("SelfAurasAffectYouAndLinkedTarget")])) {
                        let inc = sml.sum(ModType::Inc, Some(cfg), &debuff_names);
                        let more = sml.more(Some(cfg), &debuff_names);
                        if !enemy_affected.contains(&b.name.replace(' ', "")) && !enemy.conditions.get(&s(&format!("AffectedBy{}", b.name.replace(' ', "")))).copied().unwrap_or(false) {
                            let key = format!("{}{}", b.name, if ex.aura.contains_key(&b.name) { "_Debuff" } else { "" });
                            ex.aura.insert(key, AuraEntry::Buff(ExportEntry { effect_mult: (1.0 + inc / 100.0) * more, is_mark: false, mods: b.mod_list.clone() }));
                        }
                    }
                    enemy_affected.insert(b.name.replace(' ', ""));
                }
            }
            _ => {}
        }
    }
}

/// The tail of `calcs.perform` (CalcPerform.lua:3218, 3418-3435, 3810-3931): the curse limit, `extraAura`, the enemy's
/// conditions and modifiers and the player-side numbers a party member copies. `output` is the player's finished output.
pub(crate) fn finish(
    ex: &mut BuffExports,
    player: &ModStore,
    enemy: &ModStore,
    output: &pom_engine::fxhash::HashMap<String, f64>,
    weapon1_crit: Option<f64>,
    slot_items: &pom_engine::fxhash::HashMap<String, i64>,
) {
    ex.curse_limit = output.get("EnemyCurseLimit").copied().unwrap_or(0.0);
    // extraAura: created after the skill loop, so it sits last among the Aura keys.
    let mut extra_mods: Vec<Mod> = Vec::new();
    for value in player.list(None, &[s("ExtraAura")]) {
        let Value::Map(fields) = &value else { continue };
        let Some(Value::Map(inner)) = fields.iter().find(|(k, _)| k.as_str() == "mod").map(|(_, v)| v.clone()) else { continue };
        let from_allies = value.get(s("fromAllies")).truthy();
        if from_allies || !player.flag(None, &[s("SelfAurasCannotAffectAllies")]) {
            extra_mods.push(crate::actor_misc::map_to_mod(&inner));
        }
    }
    // Upstream adds item mods in `itemsTab.orderedSlots` order (CalcSetup.lua:803); this engine's player store lists them in
    // another order, so the item-sourced mods are put back in slot order among the places item mods occupy.
    {
        let item_id = |m: &Mod| -> Option<i64> { m.source.as_deref()?.strip_prefix("Item:")?.split(':').next()?.parse().ok() };
        let slot_key = |id: i64| -> (u8, usize, usize, String) {
            let name = slot_items.iter().find(|(_, v)| **v == id).map(|(k, _)| k.as_str()).unwrap_or("");
            slot_order_key(name)
        };
        let positions: Vec<usize> = extra_mods.iter().enumerate().filter(|(_, m)| item_id(m).is_some()).map(|(i, _)| i).collect();
        let mut item_mods: Vec<Mod> = positions.iter().map(|i| extra_mods[*i].clone()).collect();
        item_mods.sort_by_key(|m| slot_key(item_id(m).unwrap_or(0)));
        for (pos, m) in positions.into_iter().zip(item_mods) {
            extra_mods[pos] = m;
        }
        // The config tab's mods are in the modDB before everything else (CalcSetup.lua:681).
        custom_before_game_mods(&mut extra_mods);
    }
    ex.aura.insert("extraAura".to_string(), AuraEntry::Buff(ExportEntry { effect_mult: 1.0, is_mark: false, mods: extra_mods.clone() }));

    // The enemy's mods by name in the order the names first appeared.
    let mut by_name: IndexMap<String, Vec<Mod>> = IndexMap::new();
    match &enemy.backing {
        Backing::List(l) => {
            for m in l.iter() {
                by_name.entry(m.name.as_str().to_string()).or_default().push(m.clone());
            }
        }
        Backing::Db(map) => {
            let mut keys: Vec<&Sym> = map.keys().collect();
            keys.sort_by(|a, b| a.as_str().cmp(b.as_str()));
            for k in keys {
                by_name.insert(k.as_str().to_string(), map[k].clone());
            }
        }
    }
    let first_truthy = |name: &str| by_name.get(name).and_then(|v| v.first()).is_some_and(|m| m.value.truthy());
    // `pairs(enemyDB.mods)` meets the keys `initModDB` created first.
    let mut ordered: Vec<&String> = Vec::with_capacity(by_name.len());
    for n in ENEMY_INIT_NAMES {
        if let Some((k, _)) = by_name.get_key_value(*n) {
            ordered.push(k);
        }
    }
    for k in by_name.keys() {
        if !ENEMY_INIT_NAMES.contains(&k.as_str()) {
            ordered.push(k);
        }
    }
    for k in ordered {
        // The config tab's own enemy mods precede the ones the player's tree and items add.
        let mut sorted = by_name[k].clone();
        custom_before_game_mods(&mut sorted);
        let mods = &sorted;
        if k.contains("Condition") && !k.contains("Party") {
            ex.enemy_conditions.push(k.clone());
        } else if (k.contains("Resist") && !k.contains("Totem") && !k.contains("Max")) || k.contains("Damage") || k.contains("ActionSpeed") || k.contains("SelfCrit") || (k.contains("Multiplier") && !k.contains("Max") && !k.contains("Impale")) {
            for v in mods {
                let src = v.source.as_deref().unwrap_or("");
                if matches!(v.value, Value::Num(n) if n == 0.0) || src == "EnemyConfig" || src == "Base" || src.contains("Delirious") || src.starts_with("Party") {
                    continue;
                }
                let skip_value = v.tags.iter().any(|t| matches!(t.get(s("effectType")), Value::Str(x) if &**x == "Curse" || &**x == "AuraDebuff"));
                if skip_value {
                    continue;
                }
                let ok = match v.tags.first() {
                    None => true,
                    Some(t) => {
                        let ty = t.kind.as_str();
                        let cond_ok = ty != "Condition" || {
                            let var = t.get(s("var"));
                            let var_list = t.get(s("varList"));
                            (matches!(var, Value::Str(x) if first_truthy(&format!("Condition:{x}"))))
                                || (matches!(var_list, Value::List(l) if matches!(l.first(), Some(Value::Str(x)) if first_truthy(&format!("Condition:{x}")))))
                        };
                        let mult_ok = ty != "Multiplier" || matches!(t.get(s("var")), Value::Str(x) if first_truthy(&format!("Multiplier:{x}")));
                        cond_ok && mult_ok
                    }
                };
                if ok {
                    ex.enemy_mods.entry(k.clone()).or_default().push(v.clone());
                }
            }
        }
    }

    let tostr = |n: f64| num_str(n);
    for dt in ["Physical", "Lightning", "Cold", "Fire", "Chaos"] {
        if player.flag(None, &[s(&format!("Enemy{dt}ResistEqualToYours"))]) {
            if let Some(v) = output.get(&format!("{dt}Resist")) {
                ex.player_mods.push(format!("Enemy{dt}ResistEqualToYours"));
                ex.player_mods.push(format!("{dt}Resist={}", tostr(*v)));
            }
        }
    }
    if player.flag(None, &[s("PartyMemberMaximumEnduranceChargesEqualToYours")]) {
        if let Some(v) = output.get("EnduranceChargesMax") {
            ex.player_mods.push("PartyMemberMaximumEnduranceChargesEqualToYours".to_string());
            ex.player_mods.push(format!("EnduranceChargesMax={}", tostr(*v)));
        }
    }
    ex.player_mods.push(format!("MovementSpeedMod|percent|max={}", tostr(output.get("MovementSpeedMod").copied().unwrap_or(0.0) * 100.0)));
    if extra_mods.iter().any(|m| m.name.as_str() == "YourFortifyEqualToParent") {
        ex.player_mods.push("PartyMemberFortifyEqualToYours".to_string());
        ex.player_mods.push(format!("FortificationStacks={}", tostr(output.get("FortificationStacks").copied().unwrap_or(0.0))));
    }
    let links: Vec<(String, ExportEntry)> = ex.link.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    for (name, link) in links {
        if name == "Flame Link" {
            ex.player_mods.push(format!("Life={}", tostr(output.get("Life").copied().unwrap_or(0.0))));
        }
        for m in &link.mods {
            let n = m.name.as_str();
            if !n.contains("Parent") {
                continue;
            }
            match n {
                "MaximumBlockAttackChanceIsEqualToParent" => ex.player_mods.push(format!("BlockChanceMax={}", tostr(output.get("BlockChanceMax").copied().unwrap_or(0.0)))),
                "BlockAttackChanceIsEqualToParent" => ex.player_mods.push(format!("BlockChance={}", tostr(output.get("BlockChance").copied().unwrap_or(0.0)))),
                "MaximumLifeLeechIsEqualToPartyMember" => ex.player_mods.push(format!("MaxLifeLeechRatePercent={}", tostr(output.get("MaxLifeLeechRatePercent").copied().unwrap_or(0.0)))),
                "TakenFromParentESBeforeYou" => ex.player_mods.push(format!("EnergyShieldRecoveryCap={}", tostr(output.get("EnergyShieldRecoveryCap").copied().unwrap_or(0.0)))),
                "MainHandCritIsEqualToParent" => {
                    if let Some(v) = output.get("MainHand.CritChance") {
                        ex.player_mods.push(format!("MainHand.CritChance={}", tostr(*v)));
                    } else if let Some(v) = weapon1_crit {
                        ex.player_mods.push(format!("MainHand.CritChance={}", tostr(v)));
                    }
                }
                _ => {}
            }
        }
    }
    // "preStack Mine auras" (CalcPerform.lua:3866-3905).
    let aura_names: Vec<String> = ex.aura.keys().cloned().collect();
    for name in aura_names {
        if !name.contains("Mine") || name.contains(" Limit") {
            continue;
        }
        let stack_key = format!("Multiplier:{name}Stack");
        let stack_count = ex.enemy_mods.get(&stack_key).and_then(|v| v.first()).and_then(|m| m.value.num()).unwrap_or(0.0);
        ex.enemy_mods.shift_remove(&stack_key);
        let limit_name = format!("{name} Limit");
        for key in [name.clone(), limit_name] {
            let Some(AuraEntry::Buff(e)) = ex.aura.get_mut(&key) else { continue };
            if stack_count == 0.0 {
                ex.aura.shift_remove(&key);
            } else {
                for m in e.mods.iter_mut() {
                    let at = m.tags.iter().position(|t| matches!(t.get(s("effectStackVar")), Value::Str(x) if &**x == "ActiveMineCount"));
                    if let Some(i) = at {
                        m.tags[i].fields.retain(|(k, _)| k.as_str() != "effectStackVar");
                        if let Value::Num(v) = m.value {
                            m.value = Value::Num(v * stack_count);
                        }
                    }
                }
            }
        }
    }
    // PlayerMods is a set in upstream: a repeated key stays at its first position.
    let mut seen = std::collections::HashSet::new();
    ex.player_mods.retain(|l| seen.insert(l.clone()));
}

/// Whether the build's Export Support switch (`<Import exportParty="true">`) is on.
pub fn enabled(xml_text: &str) -> bool {
    xml_text.contains("exportParty=\"true\"")
}
