//! The build solver's items layer: every equipment slot, five flasks, the passive tree's jewel and the
//! amulet's anoint. Rare and magic items are made only of modifiers that can roll on their base at the character's item
//! level (`pom_item::modpool`): one modifier per group, at most the base's prefixes and suffixes, the best tier the item
//! level allows, rolled at its maximum, with the item's level requirement at most the character's. Uniques come from the
//! unique data when the goal's item rules allow them; locked slots keep the player's item.

use super::*;
use pom_item::modpool::{mod_pool, PoolOptions};

#[path = "solver_craft.rs"]
pub(super) mod craft;
pub(super) use craft::CraftRules;

// ---------------------------------------------------------------------------------------------------------------
// Item rules (goal `items`)

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ItemRules {
    /// "rare", "unique" (default both). Rares are always allowed.
    pub rarities: Option<Vec<String>>,
    /// Rarities allowed per slot name ("Weapon 1": ["unique"]); a slot listed here takes only those (a crafted item counts as "rare").
    pub slot_rarities: HashMap<String, Vec<String>>,
    /// When given, the only uniques the solver may use.
    pub uniques: Option<Vec<String>>,
    /// Uniques the build must use (each takes the first slot it fits, then stays).
    #[serde(alias = "must", alias = "mustUseUniques")]
    pub must_use: Vec<String>,
    /// Uniques the build must never use.
    #[serde(alias = "neverUse")]
    pub never: Vec<String>,
    /// Slots that keep the player's item ("Weapon 1", "Body Armour", "Jewel 26725", ...).
    #[serde(alias = "lock", alias = "locked", alias = "lockSlots")]
    pub locks: Vec<String>,
    /// Anoint the amulet (default true).
    pub anoint: Option<bool>,
    /// "top" (default): crafted items may use every source a real top item uses (see `CraftRules`) and are item level 86.
    /// "basic": normal modifiers only at the character's level.
    pub craft: Option<String>,
}

impl ItemRules {
    pub fn from_value(v: &Value) -> Result<ItemRules, String> {
        if v.is_null() {
            return Ok(ItemRules::default());
        }
        let r: ItemRules = serde_json::from_value(v.clone()).map_err(|e| format!("goal items: {e}"))?;
        if let Some(c) = &r.craft {
            if !["top", "basic"].iter().any(|x| c.eq_ignore_ascii_case(x)) {
                return Err(format!("goal items: craft must be \"top\" or \"basic\", not {c:?}"));
            }
        }
        Ok(r)
    }
    pub fn craft_top(&self) -> bool {
        !self.craft.as_deref().is_some_and(|c| c.eq_ignore_ascii_case("basic"))
    }
    pub fn uniques_allowed(&self) -> bool {
        (!self.must_use.is_empty()) || self.slot_rarities.values().any(|r| r.iter().any(|x| x.eq_ignore_ascii_case("unique"))) || self.rarities.as_ref().is_none_or(|r| r.iter().any(|x| x.eq_ignore_ascii_case("unique") || x.eq_ignore_ascii_case("uniques")))
    }
    /// Whether `piece` may sit in the slot `slot` under `slot_rarities`.
    pub(super) fn slot_allows(&self, slot: &str, piece: &Piece) -> bool {
        let Some(allowed) = self.slot_rarities.iter().find(|(k, _)| k.eq_ignore_ascii_case(slot)).map(|(_, v)| v) else { return true };
        let rarity = match &piece.design {
            Design::Unique(_) => "unique",
            Design::Craft { .. } => "rare",
            Design::Player if piece.xml.contains("Rarity: UNIQUE") => "unique",
            Design::Player => "rare",
        };
        allowed.iter().any(|x| x.eq_ignore_ascii_case(rarity))
    }
    fn unique_ok(&self, name: &str) -> bool {
        let m = |l: &[String]| l.iter().any(|x| x.eq_ignore_ascii_case(name));
        if m(&self.never) {
            return false;
        }
        if m(&self.must_use) {
            return true;
        }
        self.uniques_allowed() && self.uniques.as_ref().is_none_or(|l| m(l))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Slots

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) enum SlotKind {
    Weapon1,
    Weapon2,
    Helmet,
    Body,
    Gloves,
    Boots,
    Amulet,
    Ring,
    Belt,
    Flask,
    /// The rare jewel in every passive tree socket the tree allocates.
    TreeJewel,
    /// An abyss jewel in socket `n` (1-based) of the item in slot `parent`, when that item has the socket.
    Abyss,
}

pub(super) struct SlotDef {
    pub name: String,
    pub kind: SlotKind,
    pub locked: bool,
    /// Abyss sockets: the item's slot and the socket number.
    pub parent: Option<(usize, usize)>,
}

/// Abyssal sockets of an item's text ("Has 1 Abyssal Socket", "Has 2 Abyssal Sockets").
pub(super) fn abyss_sockets(xml: &str) -> usize {
    xml.lines()
        .filter_map(|l| {
            let i = l.find("Has ")?;
            let rest = &l[i + 4..];
            if !rest.contains("Abyssal Socket") {
                return None;
            }
            rest.chars().find(|c| c.is_ascii_digit()).and_then(|c| c.to_digit(10)).map(|d| d as usize)
        })
        .max()
        .unwrap_or(0)
}

/// The armour and belt slots every build wears.
const REQUIRED: [SlotKind; 5] = [SlotKind::Helmet, SlotKind::Body, SlotKind::Gloves, SlotKind::Boots, SlotKind::Belt];

/// A utility flask's effect class: the elemental and chaos resist flasks are one, armour/evasion/physical reduction another.
fn flask_class(base: &str) -> &str {
    match base.split(' ').next().unwrap_or(base) {
        "Ruby" | "Sapphire" | "Topaz" | "Amethyst" => "resist",
        "Granite" | "Jade" | "Basalt" => "defence",
        w => w,
    }
}

/// A flask base's buff lines (game data `flask.buff`).
fn flask_buff(base: &str) -> Vec<&'static str> {
    let buff = pom_calc::data::game_data().item_bases.get(base).and_then(|b| b.extra.get("flask")).and_then(|f| f.get("buff")).and_then(|b| b.as_array());
    buff.map(|a| a.iter().filter_map(|l| l.as_str()).collect()).unwrap_or_default()
}

/// The defence a flask's buff raises: 0 armour, 1 evasion, 2 ward.
fn flask_defence(base: &str) -> Option<usize> {
    flask_buff(base).into_iter().find_map(|l| if l.contains("Ward") { Some(2) } else if l.contains("Evasion") { Some(1) } else if l.contains("Armour") { Some(0) } else { None })
}

/// The modifier sets that put family `f` on `base` holding `mods`: added when it fits, else (`swap`) in place of each
/// explicit it may replace.
pub(super) fn with_family(base: &BaseInfo, mods: &[usize], f: usize, swap: bool) -> Vec<Vec<usize>> {
    if mods.contains(&f) {
        return Vec::new();
    }
    if addable(base, mods, f) {
        return vec![[mods, &[f]].concat()];
    }
    if !swap {
        return Vec::new();
    }
    (0..mods.len())
        .filter(|&j| !base.fams[mods[j]].implicit)
        .filter_map(|j| {
            let mut m = mods.to_vec();
            m.remove(j);
            addable(base, &m, f).then(|| {
                m.insert(j, f);
                m
            })
        })
        .collect()
}

pub(super) fn slot_defs(rules: &ItemRules) -> Vec<SlotDef> {
    let mut v: Vec<(String, SlotKind)> = vec![
        ("Weapon 1".into(), SlotKind::Weapon1),
        ("Weapon 2".into(), SlotKind::Weapon2),
        ("Helmet".into(), SlotKind::Helmet),
        ("Body Armour".into(), SlotKind::Body),
        ("Gloves".into(), SlotKind::Gloves),
        ("Boots".into(), SlotKind::Boots),
        ("Amulet".into(), SlotKind::Amulet),
        ("Ring 1".into(), SlotKind::Ring),
        ("Ring 2".into(), SlotKind::Ring),
        ("Belt".into(), SlotKind::Belt),
    ];
    for i in 1..=5 {
        v.push((format!("Flask {i}"), SlotKind::Flask));
    }
    v.push(("Tree jewel".into(), SlotKind::TreeJewel));
    let mut defs: Vec<SlotDef> = v.into_iter().map(|(name, kind)| SlotDef { locked: rules.locks.iter().any(|l| l.eq_ignore_ascii_case(&name)), name, kind, parent: None }).collect();
    for parent in ["Helmet", "Body Armour", "Gloves", "Boots", "Belt"] {
        let pi = defs.iter().position(|d| d.name == parent).unwrap_or(0);
        for n in 1..=2 {
            let name = format!("{parent} Abyssal Socket {n}");
            defs.push(SlotDef { locked: rules.locks.iter().any(|l| l.eq_ignore_ascii_case(&name)) || defs[pi].locked, name, kind: SlotKind::Abyss, parent: Some((pi, n)) });
        }
    }
    defs
}

pub(super) const WEAPON_TYPES: [&str; 12] = ["One Handed Axe", "Two Handed Axe", "Bow", "Claw", "Dagger", "One Handed Mace", "Sceptre", "Staff", "One Handed Sword", "Two Handed Sword", "Wand", "Two Handed Mace"];

pub(super) fn slot_types(kind: SlotKind) -> &'static [&'static str] {
    match kind {
        SlotKind::Weapon1 => &WEAPON_TYPES,
        SlotKind::Weapon2 => &["Shield", "Quiver", "One Handed Axe", "Claw", "Dagger", "One Handed Mace", "Sceptre", "One Handed Sword", "Wand"],
        SlotKind::Helmet => &["Helmet"],
        SlotKind::Body => &["Body Armour"],
        SlotKind::Gloves => &["Gloves"],
        SlotKind::Boots => &["Boots"],
        SlotKind::Amulet => &["Amulet"],
        SlotKind::Ring => &["Ring"],
        SlotKind::Belt => &["Belt"],
        SlotKind::Flask => &["Flask"],
        SlotKind::TreeJewel | SlotKind::Abyss => &["Jewel"],
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Bases and their modifier families

/// One modifier the solver can put on an item: the best tier of a modifier family (same group and wording) the item
/// level allows, rolled at its maximum.
#[derive(Clone, Debug)]
pub(super) struct Fam {
    pub key: String,
    pub group: String,
    /// The groups this mod competes in (`modpool::group_keys`), computed once so `same_group` does not allocate.
    pub keys: [String; 2],
    pub prefix: bool,
    pub lines: Vec<String>,
    pub req: u32,
    /// normal, influence, elevated, bench, essence, veiled, delve, exarch, eater, corrupted (`PoolMod::source`).
    pub source: &'static str,
    pub influence: Option<String>,
    /// An implicit (eldritch or corruption): does not use an affix slot.
    pub implicit: bool,
    /// The modifier's game tags (catalyst scaling).
    pub tags: Vec<String>,
    /// Acts only on its own item (weapon damage, armour defences: `Local*` ids) or its socketed gems: valued by real
    /// item evaluations, never as a custom line on the character.
    pub local: bool,
    /// The modifier's tier on its base (`PoolMod::tier`, 1 = best); 0 when it has none (enchant, catalyst). Prices it.
    pub tier: u32,
    /// Expected rolls to land this exact modifier: an eldritch implicit is one of many its orb can give (the base's
    /// spawn weights at that tier); 1 for everything else. Prices it.
    pub tries: f64,
    /// The next tiers down of the same modifier (mod data), best first: (tier, rolled lines, level requirement). A
    /// craft over the wealth budget steps its lines down them (`Fam::stepped`).
    pub lower: Vec<(u32, Vec<String>, u32)>,
}

/// Lower tiers a family keeps for budget steps.
const LOWER_TIERS: usize = 3;

impl Fam {
    /// This family one tier down (`lower[0]`), when it has one.
    pub(super) fn stepped(&self) -> Option<Fam> {
        let (tier, lines, req) = self.lower.first()?.clone();
        Some(Fam { tier, lines, req, lower: self.lower[1..].to_vec(), ..self.clone() })
    }
}

/// `Fam::keys` for a group: both entries equal unless the mod is elevated.
pub(super) fn group_pair(group: &str, source: &str) -> [String; 2] {
    let mut k = pom_item::modpool::group_keys(group, source == "elevated");
    let b = k.pop().unwrap_or_default();
    [k.pop().unwrap_or_else(|| b.clone()), b]
}

#[derive(Clone)]
pub(super) struct BaseInfo {
    pub name: String,
    pub item_type: String,
    pub sub_type: String,
    pub req_level: u32,
    pub implicit: Vec<String>,
    pub fams: Vec<Fam>,
    pub prefix_limit: usize,
    pub suffix_limit: usize,
    pub magic: bool,
    pub two_hand: bool,
    pub anoints: Vec<(i64, String)>,
    /// Lines written after the base name (a cluster jewel's skill and node count).
    pub header: Vec<String>,
    /// The influences this base was built for (at most two, from the base's own); influenced families need them.
    pub influences: Vec<String>,
    pub perfect: bool,
    /// Corruption implicits the item may hold (2 with perfect rolls, else 1; the goal's wealth can lower it).
    pub corrupt_cap: usize,
    /// Built for `craft: "top"`: its text carries influence, bench, eldritch, corruption and catalyst lines.
    pub top: bool,
}

/// The `(a-b)` ranges of a modifier line, in order.
fn ranges(text: &str) -> Vec<(f64, f64)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(o) = rest.find('(') {
        let Some(c) = rest[o..].find(')') else { break };
        let inner = &rest[o + 1..o + c];
        let ib = inner.as_bytes();
        if let Some(k) = (1..ib.len()).find(|&k| ib[k] == b'-' && ib[k - 1].is_ascii_digit()) {
            if let (Ok(lo), Ok(hi)) = (inner[..k].parse::<f64>(), inner[k + 1..].parse::<f64>()) {
                out.push((lo, hi));
            }
        }
        rest = &rest[o + c + 1..];
    }
    out
}

/// A typical roll: each `(a-b)` range of `best` replaced by the middle of the span from the tier below's low end
/// (`second`: the same line one tier down) to the best tier's high end; without a tier below, the middle of its own
/// range. "+(110-119) to maximum Life" with "+(100-109)" below -> "+110 to maximum Life" (whole numbers unless the
/// range has decimals).
pub(super) fn typical_roll(best: &str, second: Option<&str>) -> String {
    let lows = second.map(ranges).unwrap_or_default();
    let mut out = String::with_capacity(best.len());
    let (mut i, mut n) = (0usize, 0usize);
    let b = best.as_bytes();
    while i < b.len() {
        if b[i] == b'(' {
            if let Some(close) = best[i..].find(')') {
                let inner = &best[i + 1..i + close];
                let ib = inner.as_bytes();
                if let Some(k) = (1..ib.len()).find(|&k| ib[k] == b'-' && ib[k - 1].is_ascii_digit()) {
                    if let (Ok(lo), Ok(hi)) = (inner[..k].parse::<f64>(), inner[k + 1..].parse::<f64>()) {
                        // (a range written high-to-low counts downward)
                        let low = lows.get(n).map(|r| if hi >= lo { r.0.min(lo) } else { r.0.max(lo) }).unwrap_or(lo);
                        let mid = (low + hi) / 2.0;
                        out.push_str(&if inner.contains('.') { format!("{:.1}", mid) } else { format!("{}", mid.round() as i64) });
                        n += 1;
                        i += close + 1;
                        continue;
                    }
                }
            }
        }
        let ch = best[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// `text` with every `(a-b)` range at its top and lone numbers kept: "+(91-100) to maximum Life" -> "+100 to maximum Life".
pub(super) fn max_roll(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let b = text.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'(' {
            if let Some(close) = text[i..].find(')') {
                let inner = &text[i + 1..i + close];
                // split at a '-' that follows a digit
                let ib = inner.as_bytes();
                let cut = (1..ib.len()).find(|&k| ib[k] == b'-' && ib[k - 1].is_ascii_digit());
                if let Some(k) = cut {
                    let (lo, hi) = (&inner[..k], &inner[k + 1..]);
                    if lo.parse::<f64>().is_ok() && hi.parse::<f64>().is_ok() {
                        out.push_str(hi);
                        i += close + 1;
                        continue;
                    }
                }
            }
        }
        let ch = text[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// The family key of a line: its words without numbers.
fn family_text(lines: &[String]) -> String {
    lines.iter().map(|l| l.chars().filter(|c| !c.is_ascii_digit() && *c != '.' && *c != '(' && *c != ')' && *c != '-' && *c != '+').collect::<String>()).collect::<Vec<_>>().join("/")
}

pub(super) fn base_info(name: &str, item_level: u32, char_level: u32, perfect: bool) -> Result<BaseInfo, String> {
    base_info_tagged(name, item_level, char_level, &[], perfect)
}

/// `base_info` with extra spawn tags (a cluster jewel's skill tag).
/// `perfect`: every modifier at its best tier's top roll; otherwise typical: the middle of the top two tiers' span.
pub(super) fn base_info_tagged(name: &str, item_level: u32, char_level: u32, tags: &[String], perfect: bool) -> Result<BaseInfo, String> {
    base_info_impl(name, item_level, char_level, tags, perfect, None, 1)
}

/// The base for `craft: "top"`: also the influenced, elevated, bench, essence, veiled and fossil families, the
/// eldritch and corruption implicits. `influences` (0-2, from the base's own) is the item's influence set; the legality
/// rules are `CraftRules`.
#[allow(dead_code)]
/// `eldritch_floor`: the best eldritch implicit tier allowed (1 = any, the goal's wealth raises it).
pub(super) fn base_info_craft(name: &str, item_level: u32, char_level: u32, tags: &[String], perfect: bool, influences: &[String], eldritch_floor: u8) -> Result<BaseInfo, String> {
    let inf = craft::check_influences(name, influences)?;
    base_info_impl(name, item_level, char_level, tags, perfect, Some(&inf), eldritch_floor)
}

/// `craft`: the influence set of a top-craft base, `None` for the basic one.
fn base_info_impl(name: &str, item_level: u32, char_level: u32, tags: &[String], perfect: bool, craft: Option<&[String]>, eldritch_floor: u8) -> Result<BaseInfo, String> {
    let game = pom_calc::data::game_data();
    let b = game.item_bases.get(name).ok_or_else(|| format!("unknown base {name}"))?;
    let item_type = b.base_type.clone().unwrap_or_default();
    let sub_type = b.extra.get("subType").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let req_level = b.req.as_ref().and_then(|r| r.get("level")).copied().unwrap_or(0.0) as u32;
    let implicit: Vec<String> = b.implicit.as_deref().map(|s| s.split('\n').map(|l| if perfect { max_roll(l) } else { typical_roll(l, None) }).collect()).unwrap_or_default();
    let pool = mod_pool(game, name, item_level, &PoolOptions { extra_tags: tags.to_vec(), influences: craft.map(|c| c.to_vec()).unwrap_or_default() })?;
    // per family: (level, lines, req, tier) of every tier the item level allows
    type Tier = (u32, Vec<String>, u32, u32);
    let mut tiers: HashMap<String, (String, bool, Vec<Tier>, &'static str, Option<String>, Vec<String>, bool)> = HashMap::default();
    for (list, prefix) in [(&pool.prefixes, true), (&pool.suffixes, false)] {
        for m in list.iter() {
            if !craft::wanted(m, char_level, perfect, craft.is_some()) {
                continue;
            }
            let lines: Vec<String> = m.stats.iter().map(|s| s.text.clone()).collect();
            if lines.is_empty() {
                continue;
            }
            let key = craft::fam_key(prefix, m, &family_text(&lines));
            let t: Tier = (m.level, lines, m.req_level, m.tier);
            tiers.entry(key).or_insert_with(|| (m.group.clone(), prefix, Vec::new(), m.source, m.influence.clone(), m.tags.clone(), craft::is_local(m))).2.push(t);
        }
    }
    let mut fams: Vec<Fam> = tiers
        .into_iter()
        .map(|(key, (group, prefix, mut ladder, source, influence, tags, local))| {
            ladder.sort_by(|a, b| b.0.cmp(&a.0));
            ladder.dedup_by_key(|t| t.0);
            // tier k rolled against the one below it (perfect: its top)
            let rolled = |k: usize| craft::roll(&ladder[k].1, ladder.get(k + 1).map(|s| s.1.as_slice()), perfect);
            let lower = if matches!(source, "normal" | "influence") { (1..ladder.len().min(LOWER_TIERS + 1)).map(|k| (ladder[k].3, rolled(k), ladder[k].2)).collect() } else { Vec::new() };
            Fam { key, keys: group_pair(&group, source), group, prefix, lines: rolled(0), req: ladder[0].2, source, influence, implicit: false, tags, local, tier: ladder[0].3, tries: 1.0, lower }
        })
        .collect();
    if let Some(inf) = craft {
        fams.extend(craft::implicit_fams(&pool, char_level, perfect, inf, eldritch_floor));
    }
    fams.sort_by(|a, b| a.key.cmp(&b.key));
    // (a flask enchant "Used when you use a Travel Skill" fires only then, never always up)
    if item_type == "Flask" {
        fams.retain(|f| !f.lines.iter().any(|l| l.to_ascii_lowercase().contains("travel skill")));
    }
    let tags = &b.tags;
    Ok(BaseInfo {
        name: name.to_string(),
        two_hand: tags.get("twohand").copied().unwrap_or(false),
        magic: item_type == "Flask",
        item_type,
        sub_type,
        req_level,
        implicit,
        fams,
        prefix_limit: pool.prefix_limit as usize,
        suffix_limit: pool.suffix_limit as usize,
        anoints: pool.anoints.iter().map(|a| (a.node_id, a.name.clone())).collect(),
        header: Vec::new(),
        influences: craft.map(|c| c.to_vec()).unwrap_or_default(),
        perfect,
        corrupt_cap: if perfect { 2 } else { 1 },
        top: craft.is_some(),
    })
}

/// The bases the solver tries in a slot: every base of the slot's types a level `char_level` character can wear, but
/// only the two highest-level bases of each weapon kind and the highest of each armour kind (the others are the same
/// item with less of it).
/// The modifier lines an item's text (escaped or not) has on, tags off: enchants, implicits and explicits of its
/// selected variant and alt variants (upstream's `CheckModLineVariant`), not the lines of the variants it is not.
/// The item grants a curse aura on enemies: a parsed `ExtraCurse` mod not applied to the player.
pub(super) fn grants_curse_aura(xml: &str) -> bool {
    use pom_engine::modparser::types::PVal;
    let on_player = |v: &PVal| matches!(v, PVal::Map(f) if f.iter().any(|(k, x)| k == "applyToPlayer" && matches!(x, PVal::Bool(true))));
    active_lines(xml).iter().filter_map(|l| pom_engine::modparser::parse_mod(l).0).flatten().any(|m| m.name == "ExtraCurse" && !on_player(&m.value))
}

pub(super) fn active_lines(text: &str) -> Vec<String> {
    let raw = text.replace("&apos;", "'").replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
    let item = pom_item::parse::parse_raw(&raw, false, pom_calc::data::game_data());
    let sel = item.selected_variant.unwrap_or(item.variant_count);
    let on = |v: &Option<Vec<i64>>| v.as_ref().is_none_or(|v| item.variant_count == 0 || v.contains(&sel) || item.alt_variants.iter().any(|a| v.contains(a)));
    item.enchant_mod_lines.iter().chain(&item.implicit_mod_lines).chain(&item.explicit_mod_lines).filter(|m| !m.disabled && on(&m.variant_list)).map(|m| m.line.clone()).collect()
}

/// "... if there are no Defence Modifiers on other Equipped Items" (Foulborn Utula's Hunger) on one of `texts` (the
/// equipped items, jewels and flasks left out) while another has an armour, evasion, energy shield or ward line. Upstream
/// looks for the word "defence" in the other items, so "58% increased Armour and Evasion" does not switch it off; the
/// game does. Such gear is not worn.
pub(super) fn fake_no_defence(texts: &[&str]) -> bool {
    static DEF: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let def = DEF.get_or_init(|| regex::Regex::new(r"(?i)\b(armour|evasion|energy shield|defences?|ward)\b").unwrap());
    let lines: Vec<Vec<String>> = texts.iter().map(|t| active_lines(t)).collect();
    let needs = |l: &String| l.to_ascii_lowercase().contains("no defence modifiers on other equipped items");
    lines.iter().enumerate().any(|(i, ls)| ls.iter().any(needs) && lines.iter().enumerate().any(|(k, o)| k != i && o.iter().any(|l| def.is_match(l))))
}

/// Ailments and debuffs a monster can put on the player, by the word stems item and pantheon text uses for them.
pub(super) const SELF_AILMENTS: [(&str, &[&str]); 9] = [
    ("freeze", &["freez", "frozen"]),
    ("chill", &["chill"]),
    ("shock", &["shock"]),
    ("ignite", &["ignit"]),
    ("poison", &["poison"]),
    ("bleed", &["bleed"]),
    ("blind", &["blind"]),
    ("maim", &["maim"]),
    ("curse", &["curse", "hex"]),
];

/// Whether a word of lowercase `l` names ailment `a` (a `SELF_AILMENTS` key): a word starting with one of its stems,
/// not a "-proof" word ("Hexproof" is no curse).
fn names_ailment(l: &str, a: &str) -> bool {
    let Some((_, stems)) = SELF_AILMENTS.iter().find(|(k, _)| *k == a) else { return false };
    l.split(|c: char| !c.is_ascii_alphabetic()).any(|w| !w.ends_with("proof") && stems.iter().any(|s| w.starts_with(s)))
}

/// Whether `line` fully protects the player from ailment `a`: immune, cannot be, unaffected, or a 100% avoid chance
/// (a partial avoid chance or reduced effect is not cover). `always`: only lines with no "during Effect" / "if used
/// while" / "recently" window.
pub(super) fn line_covers(line: &str, a: &str, always: bool) -> bool {
    let l = line.to_lowercase();
    let guard = ["immun", "cannot be", "unaffected by", "100% chance to avoid being"].iter().any(|w| l.contains(w));
    let timed = l.contains("during effect") || l.contains("if used while") || l.contains("recently");
    !l.contains("enem") && guard && names_ailment(&l, a) && !(always && timed)
}

/// Whether `line` lessens ailment `a` on the player at all: full cover, an avoid chance, or less effect or duration.
pub(super) fn line_eases(line: &str, a: &str) -> bool {
    let l = line.to_lowercase();
    let guard = ["avoid being", "reduced effect of", "reduced duration of", "less duration of", "reflect hexes"].iter().any(|w| l.contains(w));
    line_covers(line, a, false) || (!l.contains("enem") && guard && names_ailment(&l, a))
}

/// The charge kinds `line` spends, lowercase ("Consumes Frenzy Charges on use": frenzy); none for "chance to not
/// consume" lines.
pub(super) fn spent_charges(line: &str) -> Vec<String> {
    static KIND: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let l = line.to_lowercase();
    if !l.contains("consume") || l.contains("not consume") {
        return Vec::new();
    }
    let mut out: Vec<String> = KIND.get_or_init(|| regex::Regex::new(r"\b([a-z]+) charges?\b").unwrap()).captures_iter(&l).map(|c| c[1].to_string()).collect();
    out.dedup();
    out
}

/// The flask slots (1-5) a worn line rules out ("Can't use Flask in Fifth Slot").
pub(super) fn blocked_flask_slots(g: &Gear) -> Vec<usize> {
    const ORD: [&str; 5] = ["first", "second", "third", "fourth", "fifth"];
    let mut out = Vec::new();
    for p in g.pieces.iter().flatten().filter(|p| p.xml.contains("Flask in ")) {
        for l in active_lines(&p.xml) {
            let l = l.to_lowercase();
            if let Some(rest) = l.split("use flask in ").nth(1) {
                if let Some(n) = ORD.iter().position(|o| rest.starts_with(o)) {
                    out.push(n + 1);
                }
            }
        }
    }
    out
}

/// The ailments `line` puts on the player itself ("You are Chilled while you are Bleeding"): a drawback the engine does
/// not count, so the item is worn only when the rest of the build already makes the player immune to it.
pub(super) fn self_ailments(line: &str) -> Vec<&'static str> {
    let l = line.to_lowercase();
    if !l.starts_with("you are ") {
        return Vec::new();
    }
    // (only the state the line gives: "You are Chilled when you are Poisoned" chills, its condition does not)
    let given = [" while ", " when ", " if "].iter().fold(l.as_str(), |g, w| g.split(w).next().unwrap_or(g));
    SELF_AILMENTS.iter().filter(|(a, _)| names_ailment(given, a) && !line_covers(given, a, false)).map(|(a, _)| *a).collect()
}

pub(super) fn base_candidates(kind: SlotKind, char_level: u32, weapon_ok: &dyn Fn(&str) -> bool) -> Vec<String> {
    let game = pom_calc::data::game_data();
    let types = slot_types(kind);
    let mut groups: HashMap<String, Vec<(u32, String)>> = HashMap::default();
    for (name, b) in &game.item_bases {
        let t = b.base_type.as_deref().unwrap_or("");
        if !types.contains(&t) {
            continue;
        }
        let tag = |k: &str| b.tags.get(k).copied().unwrap_or(false);
        let hidden = b.extra.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
        if hidden || tag("demigods") || tag("not_rollable") || tag("graft") {
            continue;
        }
        let sub = b.extra.get("subType").and_then(|v| v.as_str()).unwrap_or("");
        let jewel_ok = if kind == SlotKind::Abyss { sub == "Abyss" && !name.contains("Assembled") } else { sub.is_empty() };
        if (t == "Amulet" && sub == "Talisman") || (t == "Jewel" && !jewel_ok) || name.contains("Prismatic") {
            continue;
        }
        // Unique-only armour and shield bases have no sub type.
        if matches!(t, "Helmet" | "Body Armour" | "Gloves" | "Boots" | "Shield") && (sub.is_empty() || sub == "Ward" || sub.contains("Armour/Evasion/Energy")) {
            continue;
        }
        if WEAPON_TYPES.contains(&t) && !weapon_ok(t) {
            continue;
        }
        let req = b.req.as_ref().and_then(|r| r.get("level")).copied().unwrap_or(0.0) as u32;
        if req > char_level {
            continue;
        }
        let per_kind = matches!(t, "Helmet" | "Body Armour" | "Gloves" | "Boots" | "Shield") || WEAPON_TYPES.contains(&t);
        let gk = if per_kind { format!("{t}|{sub}") } else { name.clone() };
        groups.entry(gk).or_default().push((req, name.clone()));
    }
    let mut out = Vec::new();
    for (k, mut v) in groups {
        v.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        let take = if WEAPON_TYPES.iter().any(|w| k.starts_with(w)) { 2 } else { 1 };
        out.extend(v.into_iter().take(take).map(|(_, n)| n));
    }
    out.sort();
    out
}

// ---------------------------------------------------------------------------------------------------------------
// Pieces and gear

#[derive(Clone)]
pub(super) enum Design {
    /// The player's own item (locked slot).
    Player,
    Unique(String),
    Craft { base: Arc<BaseInfo>, mods: Vec<usize>, anoint: Option<String> },
}

#[derive(Clone)]
pub(super) struct Piece {
    pub design: Design,
    pub item_type: String,
    pub two_hand: bool,
    /// The item's text as `<Item>` content (escaped).
    pub xml: Arc<String>,
    pub label: String,
}

impl Piece {
    pub fn base(&self) -> Option<&Arc<BaseInfo>> {
        match &self.design {
            Design::Craft { base, .. } => Some(base),
            _ => None,
        }
    }
    pub fn unique_name(&self) -> Option<&str> {
        match &self.design {
            Design::Unique(n) => Some(n),
            _ => None,
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct Gear {
    /// The solver has chosen bases for the open slots.
    pub ready: bool,
    /// Per slot definition.
    pub pieces: Vec<Option<Piece>>,
    /// Jewels in particular tree sockets: the player's kept jewels, cluster jewels and unique jewels the solver chose.
    pub sockets: Vec<SocketItem>,
    /// The flask slots written active (bit n-1 = "Flask n"): all when the goal says flasks are always on, none when
    /// flasks are off, else the ones the last evaluation found sustained.
    pub flask_mask: u8,
    /// What the build's gems cost to buy, in divine orbs: awakened and exceptional gems and the main skill's links
    /// (`Solver::price_gems`; counted in `gear_cost`, so the budget covers them).
    pub gems: f64,
    /// Gem sockets those gems need: (every gem, the main skill's link), set with `gems`.
    pub sockets_need: (usize, usize),
    /// The gem groups the sockets are priced for (main skill first), set with `gems`.
    pub groups: Vec<Vec<&'static str>>,
    /// Slots a lead holds (its weapon, solver_leads.rs): the item there keeps its identity (the unique, or the rare's
    /// base); only a rare's modifiers may change. `with_piece` is the one gate.
    pub held: Vec<usize>,
}

#[derive(Clone)]
pub(super) struct SocketItem {
    pub node: i64,
    /// The item's text as `<Item>` content (escaped).
    pub xml: Arc<String>,
    pub label: String,
    /// The player's jewel (kept as it is).
    pub kept: bool,
    /// A cluster jewel's passives the build allocates with it (while its socket is allocated); a jewel socket among
    /// them holds a smaller cluster jewel.
    pub nodes: Vec<i64>,
    pub unique: Option<String>,
    /// A large cluster jewel's own jewel sockets (for medium and small cluster jewels).
    pub subs: Vec<i64>,
    /// Estimated price in divine orbs (`Solver::piece_cost`); 0 for the player's own jewel.
    pub cost: f64,
}

impl SocketItem {
    /// A rare tree jewel the solver designed for this socket (not the player's, cluster or unique).
    pub fn is_design(&self) -> bool {
        !self.kept && self.nodes.is_empty() && self.unique.is_none() && self.subs.is_empty()
    }
}

impl Gear {
    /// The cluster passives of every socket item whose socket is in `nodes`, or among the passives (jewel sockets) of
    /// a cluster jewel already counted.
    pub fn cluster_nodes(&self, nodes: &[i64]) -> Vec<i64> {
        let mut out: Vec<i64> = Vec::new();
        let mut taken = vec![false; self.sockets.len()];
        loop {
            let mut more = false;
            for (k, s) in self.sockets.iter().enumerate() {
                if !taken[k] && !s.nodes.is_empty() && (nodes.contains(&s.node) || out.contains(&s.node)) {
                    taken[k] = true;
                    out.extend(s.nodes.iter().copied());
                    more = true;
                }
            }
            if !more {
                return out;
            }
        }
    }
    fn has_unique(&self, name: &str) -> bool {
        self.pieces.iter().flatten().any(|p| p.unique_name() == Some(name)) || self.sockets.iter().any(|s| s.unique.as_deref() == Some(name))
    }
}

pub(super) fn craft_piece(base: &Arc<BaseInfo>, mods: Vec<usize>, anoint: Option<String>, item_level: u32) -> Piece {
    let fams: Vec<&Fam> = mods.iter().filter_map(|&i| base.fams.get(i)).collect();
    let req = fams.iter().map(|f| f.req).max().unwrap_or(0).max(base.req_level);
    let mut t = String::new();
    if base.magic {
        t.push_str(&format!("Rarity: MAGIC\n{}\n", base.name));
    } else if fams.is_empty() && anoint.is_none() {
        t.push_str(&format!("Rarity: NORMAL\n{}\n", base.name));
    } else {
        t.push_str(&format!("Rarity: RARE\nSolver {}\n{}\n", base.item_type, base.name));
    }
    for l in &base.header {
        t.push_str(l);
        t.push('\n');
    }
    t.push_str(&format!("Item Level: {item_level}\n"));
    if base.magic || WEAPON_TYPES.contains(&base.item_type.as_str()) || matches!(base.item_type.as_str(), "Helmet" | "Body Armour" | "Gloves" | "Boots" | "Shield" | "Quiver") {
        t.push_str("Quality: 20\n");
    }
    t.push_str(&format!("LevelReq: {req}\n"));
    let top = base.top;
    if top {
        for l in craft::influence_lines(&base.influences, &fams) {
            t.push_str(l);
            t.push('\n');
        }
    }
    // (a planned catalyst is a family of its own; otherwise the one that scales the most lines)
    let cat = if top { fams.iter().find_map(|f| craft::catalyst_of(f)).or_else(|| craft::pick_catalyst(&base.item_type, &fams)) } else { None };
    if let Some(c) = cat {
        t.push_str(&format!("Catalyst: {c}\nCatalystQuality: 20\n"));
    }
    let line = |f: &Fam, l: &str| -> String { format!("{}{l}", craft::line_flags(f, cat.is_some())) };
    let enchants: Vec<&&Fam> = fams.iter().filter(|f| f.source == "enchant").collect();
    let others: Vec<&&Fam> = fams.iter().filter(|f| f.implicit && !matches!(f.source, "enchant" | "catalyst")).collect();
    // Corrupting wipes the base implicit (upstream ItemsTab.lua 3324); enchants and the anoint stay.
    let base_impl: &[String] = if fams.iter().any(|f| f.source == "corrupted") { &[] } else { &base.implicit };
    let n_impl = enchants.iter().chain(&others).map(|f| f.lines.len()).sum::<usize>() + base_impl.len() + anoint.is_some() as usize;
    t.push_str(&format!("Implicits: {n_impl}\n"));
    for f in &enchants {
        for l in &f.lines {
            t.push_str(&line(f, l));
            t.push('\n');
        }
    }
    if let Some(a) = &anoint {
        t.push_str(&format!("{{crafted}}Allocates {a}\n"));
    }
    for l in base_impl {
        t.push_str(l);
        t.push('\n');
    }
    for f in &others {
        for l in &f.lines {
            t.push_str(&line(f, l));
            t.push('\n');
        }
    }
    for f in fams.iter().filter(|f| !f.implicit) {
        for l in &f.lines {
            t.push_str(&line(f, l));
            t.push('\n');
        }
    }
    if fams.iter().any(|f| f.source == "corrupted") {
        t.push_str("Corrupted\n");
    }
    let mut label = base.name.clone();
    if !fams.is_empty() {
        label = format!("{label}: {}", fams.iter().filter(|f| !f.lines.is_empty()).map(|f| f.lines.join(", ")).collect::<Vec<_>>().join("; "));
    }
    if let Some(a) = &anoint {
        label = format!("{label} (anointed: {a})");
    }
    Piece { item_type: base.item_type.clone(), two_hand: base.two_hand, design: Design::Craft { base: base.clone(), mods, anoint }, xml: Arc::new(crate::edit::esc_text(&t)), label }
}

/// The `Solver::ranks` key of a base: a top-craft base of the same name has other families.
pub(super) fn rank_key(b: &BaseInfo) -> String {
    if b.top {
        format!("{}|top|{}", b.name, b.influences.join(","))
    } else {
        b.name.clone()
    }
}

/// Whether family `f` can join `mods` on `base`: affix room left, its group not taken, not there already, and the
/// item stays legal (`CraftRules`).
pub(super) fn addable(base: &BaseInfo, mods: &[usize], f: usize) -> bool {
    CraftRules::legal(base, mods, f)
}

// ---------------------------------------------------------------------------------------------------------------
// Uniques

pub(super) struct UniqueInfo {
    pub name: String,
    pub item_type: String,
    /// The base's name and sub type ("Abyss" for abyss jewels).
    pub base: String,
    pub sub_type: String,
    pub two_hand: bool,
    pub xml: Arc<String>,
    /// What the piece is called (the name, with the variant when one was selected).
    pub label: String,
    /// Watcher's Eye, Forbidden Flame/Flesh, Impossible Escape: the item is made per build (`special_jewel_pass`), `xml` is
    /// only the unique's template.
    pub special: Option<craft::Special>,
    /// The other variants of a variant unique, each with `Selected Variant` set (the plain entry is the default one).
    pub variants: Vec<Arc<UniqueInfo>>,
}

/// The uniques of the unique data a level `char_level` character can wear, by base type, filtered by the rules.
/// `skill`: the main skill's name; a generated unique with a skill list (Replica Dragonfang's Flight) is made for it.
/// `affordable`: whether a unique (by name, "Foulborn <name>" for its Foulborn forms) is within the goal's wealth; a
/// must-use unique always is.
pub(super) fn unique_list(rules: &ItemRules, char_level: u32, skill: Option<&str>, affordable: &dyn Fn(&str, bool) -> bool) -> Vec<Arc<UniqueInfo>> {
    let game = pom_calc::data::game_data();
    let mut out = Vec::new();
    let Some(groups) = game.extra.get("uniques").ok().flatten().and_then(|u| u.as_object()) else { return out };
    let mut seen: HashSet<String> = HashSet::default();
    // (an item whose socketed support makes the asked skill a trap, mine, totem or trigger changes how it is used: only
    // a skill that is already delivered that way wears it)
    let own: Vec<i64> = skill.and_then(find_gem).and_then(|id| gd::game_data().gems.get(id)).and_then(gd::gem_primary_effect).map(|ge| gd::skill_types(ge).into_iter().collect()).unwrap_or_default();
    let moves_delivery = |text: &str| skill.is_some() && active_lines(text).iter().any(|l| super::socketed_delivery(l).iter().any(|t| !own.contains(t)));
    for (group, list) in groups.iter() {
        // (race rewards and not-yet-released uniques cannot be had; of the generated ones only the choice-of-mods
        // uniques the solver makes itself are kept)
        if group == "race" || group == "new" {
            continue;
        }
        let Some(list) = list.as_array() else { continue };
        for raw in list.iter() {
            let Some(raw) = raw.as_str() else { continue };
            let raw = if group == "generated" { raw.strip_prefix("Rarity: UNIQUE\n").unwrap_or(raw) } else { raw };
            // a generated unique with a per-skill alt variant list: the variant for the main skill
            let skilled = if group == "generated" && raw.contains("Has Alt Variant:") { skill.and_then(|k| craft::skill_variant(raw, k)) } else { None };
            let raw = skilled.as_deref().unwrap_or(raw);
            let lines: Vec<&str> = raw.lines().collect();
            let (Some(name), Some(base_name)) = (lines.first(), lines.get(1)) else { continue };
            let special = craft::Special::of(name);
            if group == "generated" && special.is_none() && skilled.is_none() {
                continue;
            }
            let Some(b) = game.item_bases.get(*base_name) else { continue };
            // A unique with a second variant list (Eyes of the Greatwolf's random implicits, Replica Dragonfang's Flight's
            // skill) is used at one roll the market does not price (its listing is the cheapest roll): made to order.
            let chosen = raw.contains("Has Alt Variant");
            if !rules.unique_ok(name) || !(affordable(name, chosen) || rules.must_use.iter().any(|m| m.eq_ignore_ascii_case(name))) || !seen.insert(name.to_string()) {
                continue;
            }
            // (Bound Fate: "Every 5 seconds, gain one of the following": upstream counts all six at once, so its numbers
            // are never what the item gives)
            if raw.contains("one of the following") {
                continue;
            }
            let mut req = b.req.as_ref().and_then(|r| r.get("level")).copied().unwrap_or(0.0);
            for l in &lines {
                if let Some(v) = l.strip_prefix("Requires Level ").or_else(|| l.strip_prefix("LevelReq: ")) {
                    if let Ok(x) = v.trim().split(',').next().unwrap_or("").trim().parse::<f64>() {
                        req = x;
                    }
                }
            }
            if req > char_level as f64 {
                continue;
            }
            let item_type = b.base_type.clone().unwrap_or_default();
            let sub_type = b.extra.get("subType").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let two_hand = b.tags.get("twohand").copied().unwrap_or(false);
            let mk = |text: &str, label: String, special: Option<craft::Special>, variants: Vec<Arc<UniqueInfo>>| {
                let xml = Arc::new(crate::edit::esc_text(&format!("Rarity: UNIQUE\n{text}")));
                Arc::new(UniqueInfo { name: name.to_string(), item_type: item_type.clone(), base: base_name.to_string(), sub_type: sub_type.clone(), two_hand, xml, label, special, variants })
            };
            // Every current variant is tried (`Selected Variant`); the plain entry keeps the item's own default.
            let mut variants: Vec<Arc<UniqueInfo>> = if special.is_some() { Vec::new() } else { craft::variants_to_try(raw).into_iter().map(|(n, v)| mk(&craft::select_variant(raw, n), format!("{name} [{v}] (unique)"), None, Vec::new())).collect() };
            if special.is_none() {
                if affordable(&format!("Foulborn {name}"), false) {
                    variants.extend(foulborn(raw, name).into_iter().map(|(t, l)| mk(&t, l, None, Vec::new())));
                }
            }
            // (a line the engine reads in part whose dropped half is a cost is free in every score: never worn)
            // shortcut: a unique whose default roll has such a line goes with all its variants; split them if one matters
            let free_cost = |u: &UniqueInfo| active_lines(&u.xml).iter().any(|l| super::unpriced_downside(l));
            variants.retain(|v| !free_cost(v));
            variants.retain(|v| !moves_delivery(&v.xml));
            let u = mk(raw, format!("{name} (unique)"), special, variants);
            if free_cost(&u) || moves_delivery(&u.xml) {
                continue;
            }
            out.push(u);
        }
    }
    out
}

/// A unique's Foulborn forms (`data.foulbornMap`, `ItemClass:MutateMod`): one per mutable modifier, its lines (as the
/// item's default variant has them) swapped for the mutated ones. Labels start with "Foulborn ".
fn foulborn(raw: &str, name: &str) -> Vec<(String, String)> {
    let game = pom_calc::data::game_data();
    let Some(pairs) = game.extra.get("foulbornMap").ok().flatten().and_then(|m| m.get(name)) else { return Vec::new() };
    let Some(mods) = game.extra.get("itemMods").ok().flatten() else { return Vec::new() };
    let lines_of = |table: &str, id: &str| -> Vec<String> {
        let Some(mut e) = mods.get(table).and_then(|t| t.get(id)) else { return Vec::new() };
        if let Some(k) = e.get("$ref").and_then(|r| r.as_str().map(|r| r.rsplit('.').next().unwrap_or("").to_string())) {
            match mods.get("Item").and_then(|t| t.get(k.as_str())) {
                Some(x) => e = x,
                None => return Vec::new(),
            }
        }
        (1..).map_while(|i: usize| e.get(i.to_string().as_str()).and_then(|l| l.as_str().map(String::from))).collect()
    };
    let tags = |l: &str| -> usize {
        let mut s = l;
        while s.starts_with('{') {
            let Some(e) = s.find('}') else { break };
            s = &s[e + 1..];
        }
        l.len() - s.len()
    };
    // (the default variant is the last one: a line is on when it has no variant tag or names it)
    let last = raw.lines().filter(|l| l.starts_with("Variant:")).count();
    let on = |l: &str| !l.contains("{variant:") || l.split("{variant:").nth(1).and_then(|v| v.split('}').next()).is_some_and(|v| v.split(',').any(|x| x.trim().parse::<usize>().ok() == Some(last)));
    let raw_lines: Vec<&str> = raw.lines().collect();
    let mut out = Vec::new();
    for (orig, foul) in pairs.as_object().into_iter().flat_map(|o| o.iter()) {
        let Some(foul) = foul.as_str() else { continue };
        let (o, f) = (lines_of("ItemExclusive", orig), lines_of("Foulborn", foul));
        if o.is_empty() || f.is_empty() {
            continue;
        }
        let at: Vec<Option<usize>> = o.iter().map(|ol| (1..raw_lines.len()).find(|&i| on(raw_lines[i]) && raw_lines[i][tags(raw_lines[i])..] == *ol)).collect();
        let Some(at) = at.into_iter().collect::<Option<Vec<usize>>>() else { continue };
        let first = at[0];
        let prefix = &raw_lines[first][..tags(raw_lines[first])];
        let mut lines: Vec<String> = Vec::new();
        for (i, l) in raw_lines.iter().enumerate() {
            if i == 0 {
                lines.push(format!("Foulborn {name}"));
            } else if i == first {
                lines.extend(f.iter().map(|x| format!("{prefix}{{mutated}}{x}")));
            } else if !at.contains(&i) {
                lines.push(l.to_string());
            }
        }
        out.push((lines.join("\n"), format!("Foulborn {name} [{}] (unique)", f.join(" / "))));
    }
    out
}

/// A unique piece with `notable` anointed (one "Allocates" line first among its implicits, replacing an earlier one).
/// None: the item text has no implicit count to extend.
pub(super) fn anoint_unique(p: &Piece, notable: &str) -> Option<Piece> {
    let had = p.xml.lines().any(|l| l.starts_with("{crafted}Allocates "));
    let mut lines: Vec<String> = p.xml.lines().filter(|l| !l.starts_with("{crafted}Allocates ")).map(String::from).collect();
    let at = lines.iter().position(|l| l.starts_with("Implicits: "))?;
    let n: usize = lines[at]["Implicits: ".len()..].trim().parse().ok()?;
    lines[at] = format!("Implicits: {}", n + !had as usize);
    lines.insert(at + 1, crate::edit::esc_text(&format!("{{crafted}}Allocates {notable}")));
    let label = format!("{} (anointed: {notable})", p.label.split(" (anointed: ").next().unwrap_or(&p.label));
    Some(Piece { xml: Arc::new(lines.join("\n")), label, ..p.clone() })
}

pub(super) fn unique_piece(u: &UniqueInfo) -> Piece {
    Piece { item_type: u.item_type.clone(), two_hand: u.two_hand, design: Design::Unique(u.name.clone()), xml: u.xml.clone(), label: u.label.clone() }
}

// ---------------------------------------------------------------------------------------------------------------
// The player's items

/// The player's active item set: (slot name, `<Item>` content) for every filled slot, and the passive tree's socketed
/// jewels as (node, content).
pub(super) fn player_items(xml: &str) -> (Vec<(String, Arc<String>)>, Vec<(i64, Arc<String>)>) {
    let mut slots = Vec::new();
    let mut sockets = Vec::new();
    let Ok(doc) = roxmltree::Document::parse(xml) else { return (slots, sockets) };
    let root = doc.root_element();
    let mut items: HashMap<i64, Arc<String>> = HashMap::default();
    let content = |n: roxmltree::Node| -> Arc<String> {
        let r = n.range();
        let t = &xml[r];
        let start = t.find('>').map(|i| i + 1).unwrap_or(0);
        let end = t.rfind("</").unwrap_or(t.len());
        Arc::new(t[start..end.max(start)].to_string())
    };
    if let Some(it) = root.children().find(|c| c.has_tag_name("Items")) {
        for i in it.children().filter(|c| c.has_tag_name("Item")) {
            if let Some(id) = i.attribute("id").and_then(|v| v.parse::<i64>().ok()) {
                items.insert(id, content(i));
            }
        }
        let active: i64 = it.attribute("activeItemSet").and_then(|v| v.parse().ok()).unwrap_or(1);
        let set = it.children().filter(|c| c.has_tag_name("ItemSet")).find(|s| s.attribute("id").and_then(|v| v.parse::<i64>().ok()).unwrap_or(1) == active).unwrap_or(it);
        for s in set.children().filter(|c| c.has_tag_name("Slot")) {
            let (Some(name), Some(id)) = (s.attribute("name"), s.attribute("itemId").and_then(|v| v.parse::<i64>().ok())) else { continue };
            if let Some(c) = items.get(&id) {
                slots.push((name.to_string(), c.clone()));
            }
        }
    }
    if let Some(tree) = root.children().find(|c| c.has_tag_name("Tree")) {
        let active: usize = tree.attribute("activeSpec").and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
        let specs: Vec<_> = tree.children().filter(|c| c.has_tag_name("Spec")).collect();
        if let Some(spec) = specs.get(active - 1).or_else(|| specs.first()) {
            for s in spec.descendants().filter(|c| c.has_tag_name("Socket")) {
                let (Some(node), Some(id)) = (s.attribute("nodeId").and_then(|v| v.parse::<i64>().ok()), s.attribute("itemId").and_then(|v| v.parse::<i64>().ok())) else { continue };
                if let Some(c) = items.get(&id) {
                    sockets.push((node, c.clone()));
                }
            }
        }
    }
    (slots, sockets)
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

/// The item id of the tree jewel shared by every socket.
pub(super) fn slot_item_id(i: usize) -> usize {
    i + 1
}

pub(super) fn items_xml(defs: &[SlotDef], gear: &Gear, sockets: &[Option<String>]) -> String {
    let mut items = String::new();
    let mut set = String::new();
    for (i, p) in gear.pieces.iter().enumerate() {
        let Some(p) = p else { continue };
        let id = slot_item_id(i);
        match sockets.get(i).and_then(|l| l.as_deref()) {
            Some(l) => items.push_str(&format!("<Item id=\"{id}\">{}</Item>", super::sockets::with_sockets_line(&p.xml, l))),
            None => items.push_str(&format!("<Item id=\"{id}\">{}</Item>", p.xml)),
        }
        match defs[i].kind {
            SlotKind::TreeJewel => {}
            SlotKind::Flask => {
                let n = defs[i].name.rsplit(' ').next().and_then(|x| x.parse::<u32>().ok()).unwrap_or(1);
                let on = if gear.flask_mask & (1 << (n - 1)) != 0 { " active=\"true\"" } else { "" };
                set.push_str(&format!("<Slot name=\"{}\" itemId=\"{id}\"{on}/>", defs[i].name))
            }
            _ => set.push_str(&format!("<Slot name=\"{}\" itemId=\"{id}\"/>", defs[i].name)),
        }
    }
    for (k, si) in gear.sockets.iter().enumerate() {
        items.push_str(&format!("<Item id=\"{}\">{}</Item>", 500 + k, si.xml));
    }
    format!("<Items activeItemSet=\"1\" useSecondWeaponSet=\"nil\">{items}<ItemSet id=\"1\" useSecondWeaponSet=\"nil\">{set}</ItemSet></Items>")
}

pub(super) fn sockets_xml(defs: &[SlotDef], gear: &Gear, tree_sockets: &[i64]) -> String {
    let jewel = defs.iter().position(|d| d.kind == SlotKind::TreeJewel).filter(|&i| gear.pieces.get(i).is_some_and(|p| p.is_some())).map(slot_item_id);
    let mut s = String::from("<Sockets>");
    for &n in tree_sockets {
        let id = match gear.sockets.iter().position(|si| si.node == n) {
            Some(k) => 500 + k,
            None => jewel.unwrap_or(0),
        };
        s.push_str(&format!("<Socket nodeId=\"{n}\" itemId=\"{id}\"/>"));
    }
    // (cluster jewels in a cluster jewel's own sockets)
    for (k, si) in gear.sockets.iter().enumerate() {
        if !tree_sockets.contains(&si.node) {
            s.push_str(&format!("<Socket nodeId=\"{}\" itemId=\"{}\"/>", si.node, 500 + k));
        }
    }
    s.push_str("</Sockets>");
    s
}

pub(super) fn player_piece(xml: &Arc<String>) -> Piece {
    let game = pom_calc::data::game_data();
    let base = xml.lines().map(|l| l.trim()).find_map(|l| game.item_bases.get(l).map(|b| (l.to_string(), b)));
    let (item_type, two_hand, name) = match base {
        Some((n, b)) => (b.base_type.clone().unwrap_or_default(), b.tags.get("twohand").copied().unwrap_or(false), n),
        None => (String::new(), false, "item".to_string()),
    };
    let title = xml.lines().map(|l| l.trim()).find(|l| !l.is_empty() && !l.starts_with("Rarity:")).unwrap_or("").to_string();
    Piece { design: Design::Player, item_type, two_hand, xml: xml.clone(), label: format!("{} ({name}, kept)", if title.is_empty() { name.clone() } else { title }) }
}

// ---------------------------------------------------------------------------------------------------------------
// The layer

type Scored = (f64, f64, Vals, Arc<String>);

const QUICK_FAMS: usize = 16;

impl Solver {
    /// Item rules, slots and the player's locked items (in `new`).
    pub(super) fn setup_items(&mut self, player_xml: &str) -> Result<(), String> {
        self.rules = ItemRules::from_value(&self.goal.items)?;
        if self.rules.craft_top() {
            self.item_level = self.item_level.max(craft::CRAFT_ILVL);
        }
        if let Some(w) = self.goal.wealth {
            self.item_level = self.item_level.min(w.item_level());
        }
        self.slots = slot_defs(&self.rules);
        let (pslots, psockets) = player_items(player_xml);
        let a = &self.goal.assume;
        let mask = if a.flasks_always || a.sustained() { 0x1f } else { 0 };
        let mut gear = Gear { pieces: vec![None; self.slots.len()], flask_mask: mask, ..Default::default() };
        for (i, d) in self.slots.iter().enumerate() {
            if d.locked {
                if let Some((_, x)) = pslots.iter().find(|(n, _)| *n == d.name) {
                    gear.pieces[i] = Some(player_piece(x));
                }
            }
        }
        // The open build's items seed the open slots (each one weighed against the solver's own), and its socketed
        // jewels stay where they are.
        self.player_pieces = self.slots.iter().map(|d| pslots.iter().find(|(n, _)| *n == d.name).map(|(_, x)| player_piece(x))).collect();
        for (node, x) in psockets {
            gear.sockets.push(SocketItem { node, label: player_piece(&x).label, xml: x, kept: true, nodes: Vec::new(), unique: None, subs: Vec::new(), cost: 0.0 });
        }
        if self.rules.uniques_allowed() {
            let (wealth, live) = (self.goal.wealth.unwrap_or(super::Wealth::Mirror), &self.goal.unique_prices);
            let affordable = |n: &str, chosen: bool| {
                let t = super::Wealth::of_price(super::Wealth::price(live, n));
                (if chosen || craft::Special::of(n).is_some() { t.max(super::Wealth::made_to_order()) } else { t }) <= wealth
            };
            self.uniques = unique_list(&self.rules, self.level as u32, gd::game_data().gems.get(self.main_gem).and_then(|g| g.name.as_deref()), &affordable);
            let pr = &self.goal.priority.uniques;
            super::by_priority(&mut self.uniques, |u| super::Priority::of(pr, &u.name));
        }
        // Must-use uniques take the first open slot they fit and keep it.
        for name in self.rules.must_use.clone() {
            let u = self.uniques.iter().find(|u| u.name.eq_ignore_ascii_case(&name)).cloned().ok_or_else(|| format!("unknown unique {name:?} (or above the character level)"))?;
            let slot = (0..self.slots.len()).find(|&i| gear.pieces[i].is_none() && !self.slots[i].locked && slot_types(self.slots[i].kind).contains(&u.item_type.as_str()));
            let Some(i) = slot else { return Err(format!("no free slot for {name:?}")) };
            gear.pieces[i] = Some(unique_piece(&u));
            self.slots[i].locked = true;
        }
        self.start_gear = Arc::new(gear);
        Ok(())
    }

    pub(super) fn base(&self, name: &str) -> Result<Arc<BaseInfo>, String> {
        if let Some(b) = self.bases.borrow().get(name) {
            return Ok(b.clone());
        }
        let mut b = base_info(name, self.item_level, self.level as u32, self.goal.rolls == super::Rolls::Perfect)?;
        // Jev's shortlist: likely modifier families first (all stay).
        super::by_priority(&mut b.fams, |f| self.goal.priority.of_family(&f.group, &f.lines.join(" / ")));
        let b = Arc::new(b);
        self.bases.borrow_mut().insert(name.to_string(), b.clone());
        Ok(b)
    }

    /// `base` for a top-craft item with this influence set (cached per base and set), with its enchants and catalysts.
    pub(super) fn base_craft(&self, name: &str, influences: &[String]) -> Result<Arc<BaseInfo>, String> {
        let key = format!("{name}|craft|{}", influences.join(","));
        if let Some(b) = self.bases.borrow().get(&key) {
            return Ok(b.clone());
        }
        let wealth = self.goal.wealth.unwrap_or(super::Wealth::Mirror);
        if influences.len() > wealth.max_influences() {
            return Err(format!("{} influences are above the goal's wealth", influences.len()));
        }
        let mut b = base_info_craft(name, self.item_level, self.level as u32, &[], self.goal.rolls == super::Rolls::Perfect, influences, wealth.eldritch_floor().min(6))?;
        self.craft_extras(&mut b)?;
        // Only the lines the goal's wealth reaches (solver_wealth.rs).
        b.fams.retain(|f| wealth.allows_source(f.source));
        b.corrupt_cap = b.corrupt_cap.min(wealth.max_corrupted());
        super::by_priority(&mut b.fams, |f| self.goal.priority.of_family(&f.group, &f.lines.join(" / ")));
        let b = Arc::new(b);
        self.bases.borrow_mut().insert(key, b.clone());
        Ok(b)
    }

    /// The main skill's weaponTypes allow no weapon (Poisonous Concoction: "None"): it never holds or hits with one.
    pub(super) fn unarmed(&self) -> bool {
        self.weapon_types.as_ref().is_some_and(|w| !WEAPON_TYPES.iter().any(|t| w.contains(*t)))
    }

    pub(super) fn weapon_ok(&self, t: &str) -> bool {
        self.weapon_types.as_ref().is_none_or(|w| w.contains(t))
    }

    pub(super) fn slot_bases(&self, i: usize) -> Vec<String> {
        let kind = self.slots[i].kind;
        if let Some(v) = self.slot_base_memo.borrow().get(&kind) {
            return v.clone();
        }
        let v = base_candidates(kind, self.level as u32, &|t| self.weapon_ok(t));
        self.slot_base_memo.borrow_mut().insert(kind, v.clone());
        v
    }

    /// Every build's first flask slot holds a life flask (a player's floor); `Flask 1`'s index.
    pub(super) fn life_flask_slot(&self) -> Option<usize> {
        if !self.goal.assume.flasks {
            return None;
        }
        self.slots.iter().position(|d| d.name == "Flask 1" && !d.locked)
    }

    /// A caster's (mana-hungry) second flask slot holds a mana flask; `Flask 2`'s index.
    pub(super) fn mana_flask_slot(&self) -> Option<usize> {
        let spell = gd::game_data().gems.get(self.main_gem).is_some_and(|g| g.tags.get("spell").copied().unwrap_or(false));
        if !spell || !self.goal.assume.flasks {
            return None;
        }
        self.slots.iter().position(|d| d.name == "Flask 2" && !d.locked)
    }

    /// The highest-level mana flask base the character can use.
    pub(super) fn mana_flask(&self) -> Result<Piece, String> {
        let game = pom_calc::data::game_data();
        let req = |n: &String| game.item_bases.get(n).and_then(|b| b.req.as_ref()).and_then(|r| r.get("level")).copied().unwrap_or(0.0);
        let names: Vec<String> = base_candidates(SlotKind::Flask, self.level as u32, &|_| true).into_iter().filter(|n| n.ends_with(" Mana Flask")).collect();
        let name = names.iter().max_by(|a, b| req(a).partial_cmp(&req(b)).unwrap_or(std::cmp::Ordering::Equal)).ok_or("no mana flask base")?;
        Ok(craft_piece(&self.craft_base(name, &[])?, Vec::new(), None, self.item_level))
    }

    /// The life flask for that slot: the highest-level life flask base the character can use, with the suffix that
    /// grants immunity to bleeding when used while bleeding (preferred: melee gets bled).
    pub(super) fn life_flask(&self) -> Result<Piece, String> {
        self.life_flask_by(&|b| b.req.as_ref().and_then(|r| r.get("level")).copied().unwrap_or(0.0), false)
    }

    /// The life flask slot's choices: `life_flask`, and the base that recovers the most life (a skill part can turn the
    /// flask's recovery into damage).
    pub(super) fn life_flasks(&self) -> Result<Vec<Piece>, String> {
        let most = |b: &pom_engine::data::bases::ItemBase| b.extra.get("flask").and_then(|f| f.get("life")).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mut v = vec![self.life_flask()?, self.life_flask_by(&most, false)?];
        // A part fed by the worn flask (or not known yet) scales with its recovery: also the modifier that raises the
        // amount recovered most.
        if self.main_part.get().is_none_or(|p| p.0 > 1) {
            v.push(self.life_flask_by(&most, true)?);
        }
        v.dedup_by(|a, b| a.xml == b.xml);
        Ok(v)
    }

    /// `recovery`: with the modifier whose lines raise the flask's amount recovered most (mod data: `FlaskRecovery` INC).
    fn life_flask_by(&self, key: &dyn Fn(&pom_engine::data::bases::ItemBase) -> f64, recovery: bool) -> Result<Piece, String> {
        let game = pom_calc::data::game_data();
        let req = |n: &String| game.item_bases.get(n).map_or(0.0, key);
        let names: Vec<String> = base_candidates(SlotKind::Flask, self.level as u32, &|_| true).into_iter().filter(|n| n.ends_with(" Life Flask")).collect();
        let name = names.iter().max_by(|a, b| req(a).partial_cmp(&req(b)).unwrap_or(std::cmp::Ordering::Equal)).ok_or("no life flask base")?;
        let base = self.craft_base(name, &[])?;
        let mut mods: Vec<usize> = base.fams.iter().position(|f| f.lines.iter().any(|l| l.contains("Immunity to Bleeding"))).into_iter().collect();
        if recovery {
            let gain = |f: &Fam| -> f64 {
                f.lines.iter().filter_map(|l| pom_engine::modparser::parse_mod(l).0).flatten().filter(|m| m.name == "FlaskRecovery" && m.ty == "INC").map(|m| if let pom_engine::modparser::types::PVal::Num(n) = m.value { n } else { 0.0 }).sum()
            };
            let best = (0..base.fams.len()).filter(|&f| !base.fams[f].implicit && addable(&base, &mods, f) && gain(&base.fams[f]) > 0.0).max_by(|&a, &b| gain(&base.fams[a]).total_cmp(&gain(&base.fams[b])));
            mods.extend(best);
        }
        Ok(craft_piece(&base, mods, None, self.item_level))
    }

    /// `fake_no_defence` over the gear the solver chose (the player's own items are taken as they are).
    pub(super) fn fake_defence(&self, g: &Gear) -> bool {
        let worn: Vec<&Piece> = g.pieces.iter().enumerate().filter(|(i, _)| !matches!(self.slots[*i].kind, SlotKind::Flask | SlotKind::TreeJewel | SlotKind::Abyss)).filter_map(|(_, p)| p.as_ref()).collect();
        if !worn.iter().any(|p| matches!(p.design, Design::Unique(_)) && p.xml.contains("no Defence Modifiers on other Equipped Items")) {
            return false;
        }
        fake_no_defence(&worn.iter().map(|p| p.xml.as_str()).collect::<Vec<_>>())
    }

    /// Gem sockets slot `i` holds in `g` and its longest link: the item's own "Sockets:" / "Has N Sockets" line, else
    /// the most its kind can have (an empty slot counts as that most until the bases are chosen, then as none; the main
    /// hand of a skill whose weaponTypes allow no weapon has none).
    pub(super) fn piece_sockets(&self, g: &Gear, i: usize) -> (usize, usize) {
        static HAS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let two_hand = self.slot_of(SlotKind::Weapon1).and_then(|w| g.pieces[w].as_ref()).is_some_and(|p| p.two_hand);
        let p = g.pieces[i].as_ref();
        let most = match self.slots[i].kind {
            SlotKind::Weapon1 if self.unarmed() => 0,
            SlotKind::Weapon1 => if p.is_some_and(|p| !p.two_hand) { 3 } else { 6 },
            SlotKind::Weapon2 if two_hand || p.is_some_and(|p| p.item_type == "Quiver") => 0,
            SlotKind::Weapon2 => 3,
            SlotKind::Body => 6,
            SlotKind::Helmet | SlotKind::Gloves | SlotKind::Boots => 4,
            _ => 0,
        };
        let Some(p) = p else { return if g.ready { (0, 0) } else { (most, most) } };
        let x = p.xml.as_str();
        if let Some(l) = x.lines().find_map(|l| l.trim().strip_prefix("Sockets: ")) {
            let n = |t: &str| t.chars().filter(|c| "RGBW".contains(*c)).count();
            return (n(l), l.split(' ').map(n).max().unwrap_or(0));
        }
        if x.contains("Has no Sockets") {
            return (0, 0);
        }
        let has = HAS.get_or_init(|| regex::Regex::new(r"Has (\d) Sockets?").unwrap());
        match has.captures(x).and_then(|c| c[1].parse::<usize>().ok()) {
            Some(n) => (n, n),
            None => (most, most),
        }
    }

    /// A flask line that gains charges on critical strikes is worn only by a build that crits (the main skill crits
    /// within 4 seconds 9 times in 10, `Solver.CritRecently`).
    fn crit_lines_ok(&self, st: &State, p: &Piece) -> bool {
        let on_crit = |l: &String| l.contains("Flask Charge") && l.contains("Critical Strike");
        let Some(i) = self.scorer.names.iter().position(|n| n == CRIT_RECENT) else { return true };
        !p.xml.contains("Critical Strike") || st.vals.get(i).copied().flatten().is_none_or(|c| c > 0.5) || !active_lines(&p.xml).iter().any(on_crit)
    }

    /// The base armour, evasion, ward and energy shield of the worn armour pieces and shield (game data, highest roll).
    pub(super) fn gear_defences(&self, g: &Gear) -> [f64; 4] {
        let game = pom_calc::data::game_data();
        let mut d = [0.0; 4];
        for (i, p) in g.pieces.iter().enumerate() {
            let Some(p) = p.as_ref().filter(|_| matches!(self.slots[i].kind, SlotKind::Helmet | SlotKind::Body | SlotKind::Gloves | SlotKind::Boots | SlotKind::Weapon2)) else { continue };
            let Some(a) = p.xml.lines().find_map(|l| game.item_bases.get(l.trim().replace("&apos;", "'").as_str())).and_then(|b| b.armour.as_ref()) else { continue };
            for (k, n) in ["ArmourBaseMax", "EvasionBaseMax", "WardBaseMax", "EnergyShieldBaseMax"].iter().enumerate() {
                d[k] += a.get(*n).copied().unwrap_or(0.0);
            }
        }
        d
    }

    /// Whether the gear holds the gems (`Gear::sockets_need`), or falls no further short than `old` does.
    pub(super) fn sockets_ok(&self, g: &Gear, old: Option<&Gear>) -> bool {
        let short = |g: &Gear| {
            let s: Vec<(usize, usize)> = (0..self.slots.len().min(g.pieces.len())).map(|i| self.piece_sockets(g, i)).collect();
            g.sockets_need.0.saturating_sub(s.iter().map(|x| x.0).sum()) + g.sockets_need.1.saturating_sub(s.iter().map(|x| x.1).max().unwrap_or(0))
        };
        let n = short(g);
        n == 0 || old.is_some_and(|o| n <= short(o))
    }

    pub(super) fn slot_of(&self, kind: SlotKind) -> Option<usize> {
        self.slots.iter().position(|d| d.kind == kind)
    }

    /// `gear` with piece `p` in slot `i`, the off hand emptied when the main hand no longer allows it; `None` when the
    /// result cannot be worn (an off-hand item the main hand forbids, the same unique twice).
    pub(super) fn with_piece(&self, gear: &Gear, i: usize, p: Option<Piece>) -> Option<Gear> {
        if gear.held.contains(&i) {
            // (a unique by its name: its Foulborn forms and variants are the same item, so a weaker form can still
            // give way to the plain one)
            let id = |q: &Option<Piece>| q.as_ref().map(|q| match &q.design {
                Design::Craft { base, .. } => base.name.clone(),
                Design::Unique(n) => n.clone(),
                Design::Player => q.label.clone(),
            });
            if id(&p) != id(&gear.pieces[i]) {
                return None;
            }
        }
        if let Some(n) = p.as_ref().and_then(|p| p.unique_name()) {
            if gear.pieces.iter().enumerate().any(|(k, q)| k != i && q.as_ref().and_then(|q| q.unique_name()) == Some(n)) {
                return None;
            }
        }
        if p.as_ref().is_some_and(|p| !self.rules.slot_allows(&self.slots[i].name, p)) {
            return None;
        }
        // An item that spends a charge kind the main skill uses (a stat id of its granted effect names "<kind>_charge":
        // Flicker Strike's per-frenzy-charge attack speed) takes those charges from the skill.
        if let Some(q) = p.as_ref().filter(|q| q.xml.contains("onsume")) {
            let spent: Vec<String> = active_lines(&q.xml).iter().flat_map(|l| spent_charges(l)).collect();
            if !spent.is_empty() {
                let ge = gd::game_data().gems.get(self.main_gem).and_then(gd::gem_primary_effect);
                let uses = |c: &str| {
                    let (Some(g), k) = (ge, format!("{c}_charge")) else { return false };
                    let names = |p: &pom_engine::cjson::J| p.get(0).and_then(|n| n.as_str()).is_some_and(|n| n.contains(&k));
                    g.stats.iter().any(|s| s.contains(&k)) || g.extra.get("constantStats").and_then(|c| c.as_array()).is_some_and(|a| a.iter().any(|p| names(&p))) || g.quality_stats.iter().any(names)
                };
                if spent.iter().any(|c| uses(c)) {
                    return None;
                }
            }
        }
        // "Can't use Chest armour" (The Bringer of Rain, foulborn or not) and a body armour exclude each other.
        if let Some(b) = self.slot_of(SlotKind::Body) {
            let bans = |q: &Option<Piece>| q.as_ref().is_some_and(|q| q.xml.to_ascii_lowercase().contains("use chest armour"));
            if (i == b && p.is_some() && gear.pieces.iter().enumerate().any(|(k, q)| k != i && bans(q))) || (i != b && bans(&p) && gear.pieces[b].is_some()) {
                return None;
            }
        }
        // One utility flask per effect (no four resist flasks).
        let utility = |q: &Piece| q.base().filter(|b| b.sub_type == "Utility").map(|b| flask_class(&b.name).to_string());
        if self.slots[i].kind == SlotKind::Flask {
            if let Some(c) = p.as_ref().and_then(utility) {
                if gear.pieces.iter().enumerate().any(|(k, q)| k != i && self.slots[k].kind == SlotKind::Flask && q.as_ref().and_then(utility).is_some_and(|d| d == c)) {
                    return None;
                }
            }
            // One flask per "during Effect" line (numbers aside): the same line on two flasks is one effect taken twice.
            let during = |q: &Piece| -> Vec<String> {
                q.xml.lines().map(|l| l.to_lowercase()).filter(|l| !l.starts_with('{') && (l.contains("during effect") || l.contains("during flask effect"))).map(|l| l.chars().filter(|c| !c.is_ascii_digit()).collect()).collect()
            };
            if let Some(d) = p.as_ref().map(during).filter(|d| !d.is_empty()) {
                if gear.pieces.iter().enumerate().any(|(k, q)| k != i && self.slots[k].kind == SlotKind::Flask && q.as_ref().is_some_and(|q| during(q).iter().any(|x| d.contains(x)))) {
                    return None;
                }
            }
        }
        // The one legality check: no crafted item reaches an evaluation unless `CraftRules` holds for all its families.
        if let Some(Design::Craft { base, mods, .. }) = p.as_ref().map(|p| &p.design) {
            if !CraftRules::item_legal(base, mods) {
                return None;
            }
        }
        if self.mana_flask_slot() == Some(i) && !p.as_ref().is_some_and(|p| p.xml.contains(" Mana Flask")) {
            return None;
        }
        // The life flask slot holds a life flask that removes bleeding and recovers its full amount (the
        // affix rounds may not trade the bleed suffix away).
        if self.life_flask_slot() == Some(i) && !p.as_ref().is_some_and(|p| p.xml.contains(" Life Flask") && p.xml.contains("Bleeding") && !p.xml.contains("reduced Amount Recovered")) {
            return None;
        }
        let mut g = gear.clone();
        g.pieces[i] = p;
        // A worn line "Can't use Flask in Fifth Slot" leaves that flask slot empty (no flask placed there; one already
        // there comes off).
        let blocked = blocked_flask_slots(&g);
        let flask_no = |k: usize| (self.slots[k].kind == SlotKind::Flask).then(|| self.slots[k].name.rsplit(' ').next().and_then(|x| x.parse::<usize>().ok())).flatten();
        if !blocked.is_empty() {
            if self.slots[i].kind == SlotKind::Flask && g.pieces[i].is_some() && flask_no(i).is_some_and(|n| blocked.contains(&n)) {
                return None;
            }
            for k in 0..g.pieces.len() {
                if !self.slots[k].locked && flask_no(k).is_some_and(|n| blocked.contains(&n)) {
                    g.pieces[k] = None;
                }
            }
        }
        // Checked on the whole gear, so a change elsewhere cannot leave a worn piece without what it needs.
        // A flask whose buff raises a defence (its base's buff text: Armour, Evasion, Ward) needs gear built on that
        // defence once any defence base is worn: no Ward flask without ward, armour or evasion only when the worn bases
        // carry at least half as much of it as of the other. A flask the change leaves unfit comes off (shortcut: base
        // defences only, not the tree's or auras'). Only what this change breaks counts: a piece already unfit before
        // it (a locked or kept flask) stays and blocks nothing.
        let unfit = |g: &Gear, d: &[f64; 4], k: usize| -> bool {
            let Some(x) = g.pieces[k].as_ref().and_then(|q| q.base()).and_then(|b| flask_defence(&b.name)) else { return false };
            d.iter().sum::<f64>() > 0.0 && (d[x] <= 0.0 || (x < 2 && d[x] * 2.0 < d[1 - x]))
        };
        let (d, d0) = (self.gear_defences(&g), self.gear_defences(gear));
        for k in (0..g.pieces.len()).filter(|&k| self.slots[k].kind == SlotKind::Flask) {
            if unfit(&g, &d, k) && (k == i || !unfit(gear, &d0, k)) {
                if k == i || self.slots[k].locked {
                    return None;
                }
                g.pieces[k] = None;
            }
        }
        // A line that puts an ailment on the player ("You are Chilled while you are Bleeding") is worn only while the
        // rest of the gear makes the player lastingly immune to it (shortcut: tree and pantheon immunity are not read).
        // As above, a kept piece that was already uncovered before this change blocks nothing.
        let uncovered = |g: &Gear| -> Vec<usize> {
            let bad: Vec<(usize, Vec<&str>)> = g.pieces.iter().enumerate().filter_map(|(k, q)| q.as_ref().filter(|q| q.xml.contains("You are ")).map(|q| (k, active_lines(&q.xml).iter().flat_map(|l| self_ailments(l)).collect::<Vec<_>>()))).filter(|x| !x.1.is_empty()).collect();
            if bad.is_empty() {
                return Vec::new();
            }
            let worn: Vec<(usize, Vec<String>)> = g.pieces.iter().enumerate().filter_map(|(k, q)| q.as_ref().map(|q| (k, active_lines(&q.xml)))).collect();
            bad.into_iter().filter(|(k, aa)| aa.iter().any(|a| !worn.iter().any(|(j, ls)| j != k && ls.iter().any(|l| line_covers(l, a, true))))).map(|x| x.0).collect()
        };
        let now = uncovered(&g);
        if !now.is_empty() {
            let before = uncovered(gear);
            if now.iter().any(|&k| k == i || !before.contains(&k)) {
                return None;
            }
        }
        // Veiled (Jun unveil) mods across the whole build stay within what the wealth tier affords.
        if let Some(cap) = self.goal.wealth.map(|w| w.unveil_cap()) {
            let unveils = |g: &Gear| -> usize { g.pieces.iter().flatten().map(|q| if let Design::Craft { base, mods, .. } = &q.design { mods.iter().filter(|&&m| base.fams[m].source == "veiled").count() } else { 0 }).sum() };
            if unveils(&g) > cap && unveils(&g) > unveils(gear) {
                return None;
            }
        }
        if self.fake_defence(&g) || !self.sockets_ok(&g, Some(gear)) {
            return None;
        }
        let (w1, w2) = (self.slot_of(SlotKind::Weapon1)?, self.slot_of(SlotKind::Weapon2)?);
        let ok = |g: &Gear| -> bool {
            let Some(off) = &g.pieces[w2] else { return true };
            match &g.pieces[w1] {
                None => off.item_type == "Shield",
                Some(m) if m.item_type == "Bow" => off.item_type == "Quiver",
                Some(m) if m.two_hand => false,
                Some(m) => off.item_type != "Quiver" && (off.item_type == "Shield" || WEAPON_TYPES.contains(&m.item_type.as_str())),
            }
        };
        if !ok(&g) {
            if i == w2 || self.slots[w2].locked {
                return None;
            }
            g.pieces[w2] = None;
        }
        // Abyss jewels need their socket.
        for (k, d) in self.slots.iter().enumerate() {
            if let Some((pi, n)) = d.parent {
                if g.pieces[k].is_some() && g.pieces[pi].as_ref().is_none_or(|p| abyss_sockets(&p.xml) < n) {
                    if k == i {
                        return None;
                    }
                    g.pieces[k] = None;
                }
            }
        }
        // The goal's wealth budget is a hard limit on the whole build's price (solver_wealth.rs); a crafted piece over
        // it steps its lines down to lower tiers until it fits.
        if !self.affordable(&g, Some(gear)) && !self.step_to_budget(&mut g, i, gear) {
            return None;
        }
        Some(g)
    }

    /// Steps the lines of the crafted piece in slot `i` of `g` down the mod data's tiers, good ordinary lines (life,
    /// resists, attributes) first, then each step the one that saves most (a tie: the line filled last, the planner's
    /// least valued), until `g` is within budget. False when even its
    /// lowest kept tiers are over (shortcut: steps by price, not by what each line is worth to the build).
    pub(super) fn step_to_budget(&self, g: &mut Gear, i: usize, old: &Gear) -> bool {
        let Some(p) = g.pieces[i].clone() else { return false };
        let Design::Craft { base, mods, anoint } = &p.design else { return false };
        let mut held: Vec<Fam> = mods.iter().map(|&m| base.fams[m].clone()).collect();
        let price = |h: &[Fam]| super::Wealth::fams_divines(self.goal.wealth, base.magic, WEAPON_TYPES.contains(&base.item_type.as_str()), h.iter(), anoint.is_some());
        let rest = self.gear_cost(g) - self.piece_cost(&p);
        while !self.affordable_at(g, rest + price(&held), Some(old)) {
            let Some((k, f)) = (0..held.len()).filter_map(|k| held[k].stepped().map(|f| (k, f))).min_by(|a, b| {
                let cost = |(k, f): &(usize, Fam)| price(&[&held[..*k], std::slice::from_ref(f), &held[k + 1..]].concat());
                // (ordinary good lines first: with their cheaper factor a price-only pick dropped the scarce damage lines)
                (!super::wealth::steps_first(&held[a.0])).cmp(&!super::wealth::steps_first(&held[b.0])).then(cost(a).total_cmp(&cost(b))).then(b.0.cmp(&a.0))
            }) else {
                return false;
            };
            held[k] = f;
        }
        let mut b = (**base).clone();
        for (&m, f) in mods.iter().zip(held) {
            b.fams[m] = f;
        }
        g.pieces[i] = Some(craft_piece(&Arc::new(b), mods.clone(), anoint.clone(), self.item_level));
        true
    }

    /// The main skill's last link competes with the gear for the wealth budget: when the budget left is under what that
    /// link costs (wealth_tiers.json linkFusings), the build one link shorter (the support whose loss costs least) gets its
    /// modifiers filled again with the freed divines. Kept when it closes more of a failed limit, else leaves fewer armour
    /// or jewellery slots bare, else scores higher (`budget_order`). A 6-link at league start ate 0.85 of the 1 divine
    /// and left six slots blank and a resistance failed (seen on a pconc solve).
    fn link_budget_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let Some(cap) = self.goal.wealth.and_then(|w| w.budget()) else { return Ok(false) };
        let n = st.main.len();
        let freed = super::Wealth::links_divines(n) - super::Wealth::links_divines(n.saturating_sub(1));
        if self.stop() || freed <= 1e-9 || cap - self.gear_cost(&st.gear) >= freed {
            return Ok(false);
        }
        let mut states = Vec::new();
        let mut texts = Vec::new();
        for j in (1..n).filter(|&j| !self.required.contains(&st.main[j])) {
            let mut s = st.clone();
            s.main.remove(j);
            self.price_gems(&mut s);
            texts.push(Cand::Xml(Arc::new(self.render(&s)?)));
            states.push(s);
        }
        let Some(i) = self.eval(texts).into_iter().enumerate().filter_map(|(i, v)| v.map(|v| (self.score(&v).0, i))).max_by(|a, b| a.0.total_cmp(&b.0)).map(|b| b.1) else { return Ok(false) };
        let mut s = states.swap_remove(i);
        self.rebase(&mut s)?;
        for _ in 0..8 {
            if self.stop() || !self.affix_round(&mut s, false, true, None)? {
                break;
            }
        }
        if self.budget_order(&s, st) {
            *st = s;
            return Ok(true);
        }
        Ok(false)
    }

    /// Whether `a` beats `b` the way a player spends a budget: a failed limit (resistances, life floor) closes first,
    /// then no armour or jewellery slot stays bare, then the score.
    pub(super) fn budget_order(&self, a: &State, b: &State) -> bool {
        const EPS: f64 = 1e-7;
        if (a.viol - b.viol).abs() > EPS {
            return a.viol < b.viol;
        }
        let (x, y) = (self.bare_slots(&a.gear), self.bare_slots(&b.gear));
        if x != y {
            return x < y;
        }
        a.score > b.score + EPS
    }

    /// A piece's estimated price in divine orbs: a unique at its market price, a crafted item by its mods.
    pub(super) fn piece_cost(&self, p: &Piece) -> f64 {
        match &p.design {
            Design::Player => 0.0,
            // (a Foulborn form sells as "Foulborn <name>"; an anointed copy adds the anoint)
            Design::Unique(n) => {
                let sold = if p.label.starts_with("Foulborn ") { format!("Foulborn {n}") } else { n.clone() };
                self.unique_cost(&sold) + if p.label.contains("(anointed: ") { super::Wealth::anoint_divines() } else { 0.0 }
            }
            Design::Craft { base, mods, anoint } => super::Wealth::craft_divines(self.goal.wealth, base, mods, anoint.is_some()),
        }
    }

    pub(super) fn unique_cost(&self, name: &str) -> f64 {
        super::Wealth::price(&self.goal.unique_prices, name).unwrap_or(0.0)
    }

    /// A made-to-order unique (Watcher's Eye, Megalomaniac, Forbidden jewels, Impossible Escape) with `mods` chosen
    /// mods: the cheapest listing is a random roll, so the copy the build needs costs the tier table's price.
    pub(super) fn made_cost(&self, name: &str, mods: usize) -> f64 {
        self.unique_cost(name).max(super::Wealth::made_to_order_divines(mods))
    }

    /// What the solver's build costs to buy: the open slots, its own jewels and the gems (`Gear::gems`) (the player's
    /// locked items, must-use uniques and kept jewels are not counted).
    /// shortcut: the tree jewel design is counted once though every free allocated socket gets a copy; count per socket
    /// if a result fills several sockets with it.
    pub(super) fn gear_cost(&self, g: &Gear) -> f64 {
        // (locked slots count too: the player's own items are Design::Player, 0; a must-use unique is bought)
        let pieces: f64 = g.pieces.iter().filter_map(|p| p.as_ref()).map(|p| self.piece_cost(p)).sum();
        pieces + g.sockets.iter().filter(|s| !s.kept).map(|s| s.cost).sum::<f64>() + g.gems + self.socket_cost(g)
    }

    /// Armour and jewellery slots the solver may fill that hold nothing, or a crafted base with no rolled line (an
    /// enchant alone counts as bare): what a player fills with life and resistances before any luxury.
    pub(super) fn bare_slots(&self, g: &Gear) -> usize {
        (0..self.slots.len()).filter(|&i| self.is_bare(g, i)).count()
    }

    fn is_bare(&self, g: &Gear, i: usize) -> bool {
        let armour = [SlotKind::Helmet, SlotKind::Body, SlotKind::Gloves, SlotKind::Boots, SlotKind::Belt, SlotKind::Amulet, SlotKind::Ring];
        !self.slots[i].locked
            && armour.contains(&self.slots[i].kind)
            && match g.pieces.get(i).cloned().flatten().map(|p| p.design) {
                None => true,
                Some(Design::Craft { base, mods, .. }) => mods.iter().all(|&m| base.fams[m].implicit || base.fams[m].source == "enchant"),
                Some(_) => false,
            }
    }

    /// A bare crafted armour or jewellery slot gets one ordinary line (life, a resistance, an attribute) at its lowest
    /// tier even when the budget is spent: another crafted piece steps its lines down to make room (`step_to_budget`).
    /// Kept by `budget_order`, so it never opens a failed limit.
    fn bare_slot_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let bare: Vec<usize> = (0..self.slots.len()).filter(|&i| self.is_bare(&st.gear, i)).collect();
        if bare.is_empty() || self.stop() {
            return Ok(false);
        }
        self.layer = "items: bare slots".into();
        let mut gears = Vec::new();
        for i in bare {
            let Some(Design::Craft { base, mods, anoint }) = st.gear.pieces[i].as_ref().map(|p| p.design.clone()) else { continue };
            for f in (0..base.fams.len()).filter(|&f| !base.fams[f].implicit && super::wealth::is_ordinary(&base.fams[f])) {
                for m in with_family(&base, &mods, f, false) {
                    let mut b = (*base).clone();
                    while let Some(x) = b.fams[f].stepped() {
                        b.fams[f] = x;
                    }
                    let p = craft_piece(&Arc::new(b), m, anoint.clone(), self.item_level);
                    if let Some(g) = self.with_piece(&st.gear, i, Some(p.clone())) {
                        gears.push(g);
                        continue;
                    }
                    let mut g = (*st.gear).clone();
                    g.pieces[i] = Some(p);
                    for k in (0..self.slots.len()).filter(|&k| k != i) {
                        let mut h = g.clone();
                        if self.step_to_budget(&mut h, k, &st.gear) {
                            gears.push(h);
                        }
                    }
                }
            }
        }
        let r = self.eval_gears(st, &gears)?;
        let mut best: Option<State> = None;
        for (g, v) in gears.into_iter().zip(r) {
            let Some(v) = v else { continue };
            let mut s = st.clone();
            self.take(&mut s, g, v);
            if self.budget_order(&s, best.as_ref().unwrap_or(st)) {
                best = Some(s);
            }
        }
        Ok(best.map(|b| *st = b).is_some())
    }

    /// Whether `g` is within the goal's wealth budget, or at least no dearer than `old`.
    pub(super) fn affordable(&self, g: &Gear, old: Option<&Gear>) -> bool {
        self.affordable_at(g, self.gear_cost(g), old)
    }

    /// `affordable` with `g` costing `c`.
    fn affordable_at(&self, g: &Gear, c: f64, old: Option<&Gear>) -> bool {
        let Some(cap) = self.goal.wealth.and_then(|w| w.budget()) else { return true };
        // (gems and must-use uniques are fixed costs: past the budget on their own, nothing more is bought, but the search still runs)
        let fixed = g.gems + g.pieces.iter().zip(&self.slots).filter(|(_, d)| d.locked).filter_map(|(p, _)| p.as_ref()).map(|p| self.piece_cost(p)).sum::<f64>();
        let cap = cap.max(fixed);
        c <= cap + 1e-9 || old.is_some_and(|o| c <= self.gear_cost(o) + 1e-9)
    }

    /// An abyss jewel base for every abyss socket the items have and no jewel fills yet.
    fn ensure_abyss(&mut self, st: &mut State) -> Result<bool, String> {
        let mut ch = Vec::new();
        for (k, d) in self.slots.iter().enumerate() {
            let Some((pi, n)) = d.parent else { continue };
            if d.locked || st.gear.pieces[k].is_some() || st.gear.pieces[pi].as_ref().is_none_or(|p| abyss_sockets(&p.xml) < n) {
                continue;
            }
            for b in self.slot_bases(k) {
                ch.push((k, Some(self.empty_craft(&b)?)));
            }
        }
        if ch.is_empty() || self.stop() {
            return Ok(false);
        }
        Ok(self.apply_best(st, ch, true)?.0)
    }

    /// Each slot still holding the open build's item tried with a rare the solver makes (best base, then modifiers);
    /// kept when it scores higher.
    fn craft_trial_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let mut any = false;
        for i in 0..self.slots.len() {
            if self.slots[i].locked || self.stop() || !matches!(st.gear.pieces[i].as_ref().map(|p| &p.design), Some(Design::Player)) {
                continue;
            }
            let mut ts = st.clone();
            let mut ch = Vec::new();
            for b in self.slot_bases(i) {
                ch.push((i, Some(self.empty_craft(&b)?)));
            }
            self.apply_best(&mut ts, ch, true)?;
            for _ in 0..8 {
                if self.stop() || !self.affix_round(&mut ts, false, false, Some(i))? {
                    break;
                }
            }
            if ts.score > st.score + EPS {
                *st = ts;
                any = true;
            }
        }
        Ok(any)
    }

    /// A crafted belt tried as a Stygian Vise (its modifiers kept) with a designed abyss jewel.
    fn abyss_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let Some(bi) = self.slot_of(SlotKind::Belt) else { return Ok(false) };
        let Some(p) = st.gear.pieces[bi].clone() else { return Ok(false) };
        let Design::Craft { base, mods, .. } = &p.design else { return Ok(false) };
        if self.slots[bi].locked || abyss_sockets(&p.xml) > 0 || self.stop() || !self.slot_bases(bi).iter().any(|b| b == "Stygian Vise") {
            return Ok(false);
        }
        let Some(ai) = self.slots.iter().position(|d| d.parent == Some((bi, 1))) else { return Ok(false) };
        let nb = self.base("Stygian Vise")?;
        let mut m: Vec<usize> = Vec::new();
        for &f in mods {
            if let Some(nf) = nb.fams.iter().position(|x| x.key == base.fams[f].key) {
                if addable(&nb, &m, nf) {
                    m.push(nf);
                }
            }
        }
        let mut ts = st.clone();
        let Some(g) = self.with_piece(&ts.gear, bi, Some(craft_piece(&nb, m, None, self.item_level))) else { return Ok(false) };
        ts.gear = Arc::new(g);
        self.rebase(&mut ts)?;
        self.ensure_abyss(&mut ts)?;
        for _ in 0..8 {
            if self.stop() || !(self.affix_round(&mut ts, false, false, Some(bi))? | self.affix_round(&mut ts, false, false, Some(ai))?) {
                break;
            }
        }
        if ts.score > st.score + EPS {
            *st = ts;
            return Ok(true);
        }
        Ok(false)
    }

    fn eval_gears(&self, st: &State, gears: &[Gear]) -> Result<Vec<Option<Scored>>, String> {
        let mut cands = Vec::with_capacity(gears.len());
        let mut texts = Vec::with_capacity(gears.len());
        let ok: Vec<bool> = gears.iter().map(|g| self.affordable(g, Some(&st.gear))).collect();
        for g in gears.iter().zip(&ok).filter(|(_, ok)| **ok).map(|(g, _)| g) {
            let mut s = st.clone();
            s.gear = Arc::new(g.clone());
            let x = Arc::new(self.render(&s)?);
            texts.push(x.clone());
            cands.push(Cand::Xml(x));
        }
        let mut r = self.eval(cands).into_iter().zip(texts);
        Ok(ok
            .iter()
            .map(|&ok| {
                let (v, x) = if ok { r.next()? } else { return None };
                v.map(|v| {
                    let (s, viol) = self.score(&v);
                    (s, viol, v, x)
                })
            })
            .collect())
    }

    fn take(&self, st: &mut State, g: Gear, v: Scored) {
        st.gear = Arc::new(g);
        st.score = v.0;
        st.viol = v.1;
        st.vals = v.2;
        st.base = v.3;
        self.settle(st);
    }

    /// Evaluates single-slot changes in one batch and keeps, per slot, the best that beats `st` (with `force`, the best
    /// at all); the chosen changes are applied together when that scores at least as well as the best one alone.
    /// Returns whether `st` improved and each change's score.
    pub(super) fn apply_best(&mut self, st: &mut State, changes: Vec<(usize, Option<Piece>)>, force: bool) -> Result<(bool, Vec<Option<f64>>), String> {
        let mut gears = Vec::new();
        let mut idx = Vec::new();
        for (k, (i, p)) in changes.iter().enumerate() {
            if p.as_ref().is_some_and(|p| self.slots[*i].kind == SlotKind::Flask && !self.crit_lines_ok(st, p)) {
                continue;
            }
            if let Some(g) = self.with_piece(&st.gear, *i, p.clone()) {
                gears.push(g);
                idx.push(k);
            }
        }
        let r = self.eval_gears(st, &gears)?;
        let mut scores = vec![None; changes.len()];
        let mut best: Vec<(usize, f64, usize)> = Vec::new();
        for (gi, v) in r.iter().enumerate() {
            let Some(v) = v else { continue };
            let k = idx[gi];
            scores[k] = Some(v.0);
            if !force && v.0 <= st.score + EPS {
                continue;
            }
            let slot = changes[k].0;
            match best.iter_mut().find(|b| b.0 == slot) {
                Some(b) => {
                    if v.0 > b.1 {
                        b.1 = v.0;
                        b.2 = gi;
                    }
                }
                None => best.push((slot, v.0, gi)),
            }
        }
        if best.is_empty() {
            return Ok((false, scores));
        }
        best.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let top = best[0].2;
        let mut chosen = (gears[top].clone(), r[top].clone().unwrap());
        if best.len() > 1 && !self.stop() {
            let mut g = gears[top].clone();
            for b in &best[1..] {
                let k = idx[b.2];
                if let Some(ng) = self.with_piece(&g, changes[k].0, changes[k].1.clone()) {
                    g = ng;
                }
            }
            if let Some(Some(v)) = self.eval_gears(st, std::slice::from_ref(&g))?.pop() {
                if v.0 >= chosen.1 .0 - EPS {
                    chosen = (g, v);
                }
            }
        }
        let before = st.score;
        self.take(st, chosen.0, chosen.1);
        Ok((force || st.score > before + EPS, scores))
    }

    pub(super) fn empty_craft(&self, base: &str) -> Result<Piece, String> {
        self.empty_craft_with(base, &[])
    }

    /// `base` as a top craft with these influences (top mode), else the basic base.
    pub(super) fn craft_base(&self, name: &str, influences: &[String]) -> Result<Arc<BaseInfo>, String> {
        if self.rules.craft_top() {
            self.base_craft(name, influences)
        } else {
            self.base(name)
        }
    }

    fn empty_craft_with(&self, base: &str, influences: &[String]) -> Result<Piece, String> {
        Ok(craft_piece(&self.craft_base(base, influences)?, Vec::new(), None, self.item_level))
    }

    /// Bases for the open slots: weapons, then armour and jewellery together, then each flask (a utility flask once).
    fn init_gear(&mut self, st: &mut State) -> Result<(), String> {
        self.layer = "items: bases".into();
        self.publish();
        let open = |s: &Solver, st: &State, i: usize| !s.slots[i].locked && st.gear.pieces[i].is_none();
        for kind in [SlotKind::Weapon1, SlotKind::Weapon2] {
            let Some(i) = self.slot_of(kind) else { continue };
            if !open(self, st, i) || self.stop() {
                continue;
            }
            let mut ch = vec![(i, None)];
            ch.extend(self.player_pieces.get(i).cloned().flatten().map(|p| (i, Some(p))));
            for b in self.slot_bases(i) {
                ch.push((i, Some(self.empty_craft(&b)?)));
            }
            self.apply_best(st, ch, true)?;
        }
        let mut ch = Vec::new();
        for i in 0..self.slots.len() {
            if matches!(self.slots[i].kind, SlotKind::Weapon1 | SlotKind::Weapon2 | SlotKind::Flask | SlotKind::TreeJewel | SlotKind::Abyss) || !open(self, st, i) {
                continue;
            }
            if !REQUIRED.contains(&self.slots[i].kind) {
                ch.push((i, None));
            }
            ch.extend(self.player_pieces.get(i).cloned().flatten().map(|p| (i, Some(p))));
            for b in self.slot_bases(i) {
                ch.push((i, Some(self.empty_craft(&b)?)));
            }
        }
        if !ch.is_empty() && !self.stop() {
            self.apply_best(st, ch, true)?;
        }
        // Body, helmet, gloves, boots and belt are worn: apply_best takes one slot's change when the combined one costs
        // too much, so offer the empty ones again until each holds a base (empty only when none is affordable).
        for _ in 0..REQUIRED.len() {
            let empty = |s: &Solver, st: &State| (0..s.slots.len()).filter(|&i| REQUIRED.contains(&s.slots[i].kind) && open(s, st, i)).collect::<Vec<_>>();
            let todo = empty(self, st);
            if todo.is_empty() || self.stop() {
                break;
            }
            let mut ch = Vec::new();
            for &i in &todo {
                for b in self.slot_bases(i) {
                    ch.push((i, Some(self.empty_craft(&b)?)));
                }
            }
            self.apply_best(st, ch, true)?;
            if empty(self, st).len() == todo.len() {
                break;
            }
        }
        for i in 0..self.slots.len() {
            if self.slots[i].kind != SlotKind::Flask || !open(self, st, i) || self.stop() {
                continue;
            }
            if self.life_flask_slot() == Some(i) {
                let ch: Vec<(usize, Option<Piece>)> = self.player_pieces.get(i).cloned().flatten().into_iter().chain(self.life_flasks()?).map(|p| (i, Some(p))).collect();
                self.apply_best(st, ch, true)?;
                continue;
            }
            if self.mana_flask_slot() == Some(i) {
                let ch: Vec<(usize, Option<Piece>)> = self.player_pieces.get(i).cloned().flatten().into_iter().chain(std::iter::once(self.mana_flask()?)).map(|p| (i, Some(p))).collect();
                self.apply_best(st, ch, true)?;
                continue;
            }
            let used: Vec<String> = st.gear.pieces.iter().flatten().filter_map(|p| p.base().filter(|b| b.sub_type == "Utility").map(|b| flask_class(&b.name).to_string())).collect();
            // (on a tie a flask stays in the slot, the player's first: one that does not count yet can still be made
            // to, by its modifiers)
            let mut ch: Vec<(usize, Option<Piece>)> = self.player_pieces.get(i).cloned().flatten().map(|p| (i, Some(p))).into_iter().collect();
            for b in self.slot_bases(i) {
                if !used.iter().any(|u| u == flask_class(&b)) {
                    ch.push((i, Some(self.empty_craft(&b)?)));
                }
            }
            ch.push((i, None));
            self.apply_best(st, ch, true)?;
        }
        if let Some(i) = self.slot_of(SlotKind::TreeJewel) {
            if open(self, st, i) {
                let g = gd::game_data().gems.get(self.main_gem);
                let base = match g.map(|g| (g.req_str, g.req_dex, g.req_int)) {
                    Some((s, d, n)) if s >= d && s >= n => "Crimson Jewel",
                    Some((_, d, n)) if d >= n => "Viridian Jewel",
                    _ => "Cobalt Jewel",
                };
                let mut g = (*st.gear).clone();
                g.pieces[i] = Some(self.empty_craft(base)?);
                st.gear = Arc::new(g);
            }
        }
        let mut g = (*st.gear).clone();
        g.ready = true;
        st.gear = Arc::new(g);
        self.rebase(st)?;
        Ok(())
    }

    /// The families tried on `base` in slot `i`: all, or (quick) the best ones of the last full round or, for top-craft
    /// items, of the last slot plan (`plan_pass`).
    fn fam_candidates(&self, i: usize, base: &BaseInfo, quick: bool, n: usize) -> Vec<usize> {
        let all: Vec<usize> = (0..base.fams.len()).collect();
        if !quick {
            return all;
        }
        let Some(r) = self.ranks.get(&(i, rank_key(base))) else { return all };
        let mut v: Vec<(f64, usize)> = all.iter().map(|&f| (r.get(f).copied().filter(|x| !x.is_nan()).unwrap_or(f64::NEG_INFINITY), f)).collect();
        v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().take(n).map(|(_, f)| f).collect()
    }

    fn socket_allocated(&self, st: &State) -> bool {
        st.nodes.iter().any(|n| self.tree_sockets.contains(n))
    }

    /// One round over the crafted items: add a modifier (`swap` false) or replace one (`swap` true), the best change
    /// per item, all evaluated in one batch. `only` limits it to one slot.
    fn affix_round(&mut self, st: &mut State, swap: bool, quick: bool, only: Option<usize>) -> Result<bool, String> {
        let mut changes = Vec::new();
        let mut tags: Vec<(usize, Arc<BaseInfo>, usize)> = Vec::new();
        for i in 0..self.slots.len() {
            if self.slots[i].locked || only.is_some_and(|o| o != i) {
                continue;
            }
            if only.is_none() && self.slots[i].kind == SlotKind::TreeJewel && !self.socket_allocated(st) {
                continue;
            }
            let Some(p) = &st.gear.pieces[i] else { continue };
            let Design::Craft { base, mods, anoint } = &p.design else { continue };
            if !swap {
                for f in self.fam_candidates(i, base, quick, QUICK_FAMS) {
                    if addable(base, mods, f) {
                        let mut m = mods.clone();
                        m.push(f);
                        changes.push((i, Some(craft_piece(base, m, anoint.clone(), self.item_level))));
                        tags.push((i, base.clone(), f));
                    }
                }
            } else {
                let cands = self.fam_candidates(i, base, true, if quick { QUICK_FAMS } else { 2 * QUICK_FAMS });
                for j in 0..mods.len() {
                    let mut rest = mods.clone();
                    rest.remove(j);
                    for &f in &cands {
                        if f != mods[j] && addable(base, &rest, f) {
                            let mut m = rest.clone();
                            m.insert(j, f);
                            changes.push((i, Some(craft_piece(base, m, anoint.clone(), self.item_level))));
                        }
                    }
                }
            }
        }
        if changes.is_empty() || self.stop() {
            return Ok(false);
        }
        let before = st.score;
        let (imp, scores) = self.apply_best(st, changes, false)?;
        for (k, (i, b, f)) in tags.iter().enumerate() {
            if let Some(s) = scores[k] {
                let e = self.ranks.entry((*i, rank_key(b))).or_insert_with(|| vec![f64::NAN; b.fams.len()]);
                e[*f] = s - before;
            }
        }
        if imp {
            self.publish();
        }
        Ok(imp)
    }

    /// Other bases for each crafted item, keeping the modifiers the new base can roll.
    pub(super) fn base_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let mut changes = Vec::new();
        for i in 0..self.slots.len() {
            if self.slots[i].locked || self.slots[i].kind == SlotKind::TreeJewel {
                continue;
            }
            let Some(p) = &st.gear.pieces[i] else { continue };
            let Design::Craft { base, mods, anoint } = &p.design else { continue };
            for b in self.slot_bases(i) {
                if b == base.name {
                    continue;
                }
                let own = if self.rules.craft_top() { craft::base_influences(&b)? } else { Vec::new() };
                let nb = self.craft_base(&b, &base.influences.iter().filter(|x| own.contains(x)).cloned().collect::<Vec<_>>())?;
                let mut m: Vec<usize> = Vec::new();
                for &f in mods {
                    if let Some(nf) = nb.fams.iter().position(|x| x.key == base.fams[f].key) {
                        if addable(&nb, &m, nf) {
                            m.push(nf);
                        }
                    }
                }
                let an = if nb.anoints.is_empty() { None } else { anoint.clone() };
                changes.push((i, Some(craft_piece(&nb, m, an, self.item_level))));
            }
        }
        if changes.is_empty() || self.stop() {
            return Ok(false);
        }
        Ok(self.apply_best(st, changes, false)?.0)
    }

    /// Each allowed unique in each open slot it fits, against the item there now.
    pub(super) fn unique_pass(&mut self, st: &mut State) -> Result<bool, String> {
        if self.uniques.is_empty() {
            return Ok(false);
        }
        let mut changes = Vec::new();
        for i in 0..self.slots.len() {
            let kind = self.slots[i].kind;
            if self.slots[i].locked || kind == SlotKind::TreeJewel {
                continue;
            }
            let types = slot_types(kind);
            for u in self.uniques.iter().flat_map(|u| std::iter::once(u).chain(u.variants.iter())) {
                if !types.contains(&u.item_type.as_str()) || (kind == SlotKind::Weapon1 && !self.weapon_ok(&u.item_type)) || (kind == SlotKind::Abyss) != (u.sub_type == "Abyss") {
                    continue;
                }
                if st.gear.pieces[i].as_ref().is_some_and(|p| p.label == u.label) {
                    continue;
                }
                changes.push((i, Some(unique_piece(u))));
            }
        }
        if changes.is_empty() || self.stop() {
            return Ok(false);
        }
        self.layer = "items: uniques".into();
        let imp = self.apply_best(st, changes.clone(), false)?.0;
        Ok(self.curse_aura_swap(st, &changes)? | imp)
    }

    /// An item that grants a curse aura fights the build's curse gems for the curse limit, so worn beside them it adds
    /// nothing: each such change (and the gear as worn, when it has one) is also tried with those gems taken out, in one
    /// move. Kept at an equal score too: a player drops the gem the item makes redundant (a socket and a cast saved).
    fn curse_aura_swap(&mut self, st: &mut State, changes: &[(usize, Option<Piece>)]) -> Result<bool, String> {
        let curse = |s: &Self, u: &'static str| !s.required.contains(&u) && s.gems.iter().any(|g| g.id == util_root(u) && g.kind == Kind::Curse);
        if self.stop() || !st.utils.iter().any(|&u| curse(self, u)) {
            return Ok(false);
        }
        let mut gears: Vec<Gear> = changes.iter().filter(|(_, p)| p.as_ref().is_some_and(|p| grants_curse_aura(&p.xml))).filter_map(|(i, p)| self.with_piece(&st.gear, *i, p.clone())).collect();
        if st.gear.pieces.iter().flatten().any(|p| grants_curse_aura(&p.xml)) {
            gears.push((*st.gear).clone());
        }
        if gears.is_empty() {
            return Ok(false);
        }
        let mut s = st.clone();
        s.utils.retain(|&u| !curse(self, u));
        self.price_gems(&mut s);
        let r = self.eval_gears(&s, &gears)?;
        let best = r.into_iter().zip(gears).filter_map(|(v, g)| v.map(|v| (v, g))).filter(|(v, _)| v.0 >= st.score - EPS).max_by(|a, b| a.0 .0.total_cmp(&b.0 .0));
        let Some((v, g)) = best else { return Ok(false) };
        self.take(&mut s, g, v);
        *st = s;
        Ok(true)
    }

    /// The amulet's anoint: every notable the amulet can be anointed with, ranked with the notable counted as
    /// allocated (fast node evaluation), the best few tried as the real enchantment.
    fn anoint_pass(&mut self, st: &mut State) -> Result<bool, String> {
        if self.rules.anoint == Some(false) {
            return Ok(false);
        }
        let Some(ai) = self.slot_of(SlotKind::Amulet) else { return Ok(false) };
        if self.slots[ai].locked {
            return Ok(false);
        }
        let Some(p) = st.gear.pieces[ai].clone() else { return Ok(false) };
        // A unique amulet takes the anoint too (any amulet base lists the same notables).
        let (base, cur) = match &p.design {
            Design::Craft { base, anoint, .. } => (base.clone(), anoint.clone()),
            Design::Unique(_) => {
                let Some(b) = self.slot_bases(ai).first().map(|b| self.base(b)).transpose()? else { return Ok(false) };
                (b, p.label.split(" (anointed: ").nth(1).map(|a| a.trim_end_matches(')').to_string()))
            }
            Design::Player => return Ok(false),
        };
        if base.anoints.is_empty() || self.stop() {
            return Ok(false);
        }
        let list: Vec<&(i64, String)> = base.anoints.iter().filter(|(n, name)| !st.nodes.contains(n) && Some(name) != cur.as_ref()).collect();
        let full = self.full_nodes(st);
        let cands: Vec<Cand> = list
            .iter()
            .map(|(n, _)| {
                let mut nodes = full.clone();
                nodes.push(*n);
                Cand::Nodes { base: st.base.clone(), nodes, mastery: None, pin: vec![*n] }
            })
            .collect();
        let r = self.eval(cands);
        let mut ranked: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(k, v)| v.as_ref().map(|v| (self.score(v).0, k))).collect();
        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let anointed = |a: &str| -> Option<Piece> {
            match &p.design {
                Design::Craft { base, mods, .. } => Some(craft_piece(base, mods.clone(), Some(a.to_string()), self.item_level)),
                _ => anoint_unique(&p, a),
            }
        };
        let changes: Vec<(usize, Option<Piece>)> = ranked.iter().take(6).filter_map(|&(_, k)| anointed(&list[k].1).map(|x| (ai, Some(x)))).collect();
        if changes.is_empty() {
            return Ok(false);
        }
        self.layer = "items: anoint".into();
        Ok(self.apply_best(st, changes, false)?.0)
    }

    /// The tree jewel's modifiers, designed with the nearest socket allocated when the tree has none yet (the tree
    /// layer then decides which sockets to take).
    fn jewel_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let Some(ji) = self.slot_of(SlotKind::TreeJewel) else { return Ok(false) };
        if self.slots[ji].locked || st.gear.pieces[ji].is_none() || self.stop() {
            return Ok(false);
        }
        self.layer = "items: jewel".into();
        let mut ds = st.clone();
        if !self.socket_allocated(st) {
            let c = &self.ctx[st.class];
            let alloc: HashSet<i64> = st.nodes.iter().copied().collect();
            let reach = c.bfs(&alloc, false);
            let near = self.tree_sockets.iter().filter_map(|s| reach.get(s).map(|(d, _)| (*d, *s))).min();
            let Some((_, s)) = near else { return Ok(false) };
            let path = c.path_to(&reach, s);
            ds.nodes.extend(path);
            self.rebase(&mut ds)?;
        }
        let mut changed = self.design_jewel(&mut ds, ji)?;
        if changed {
            let mut g = (*st.gear).clone();
            g.pieces[ji] = ds.gear.pieces[ji].clone();
            st.gear = Arc::new(g);
            self.rebase(st)?;
        }
        // Each allocated socket gets its own design: freeze the current one into the socket, then design the next
        // one from scratch against the sockets already filled.
        let socks: Vec<i64> = self.tree_sockets.iter().copied().filter(|s| st.nodes.contains(s) && !st.gear.sockets.iter().any(|x| x.node == *s && !x.is_design())).collect();
        if socks.len() >= 2 && !self.stop() {
            let mut cur = st.clone();
            for (k, &s) in socks.iter().enumerate() {
                let Some(p) = cur.gear.pieces[ji].clone() else { break };
                let mut g = (*cur.gear).clone();
                g.sockets.retain(|x| x.node != s);
                g.sockets.push(SocketItem { node: s, xml: p.xml.clone(), label: p.label.clone(), kept: false, nodes: Vec::new(), unique: None, subs: Vec::new(), cost: self.piece_cost(&p) });
                if k + 1 < socks.len() {
                    if let Some(b) = p.base() {
                        g.pieces[ji] = Some(self.empty_craft(&b.name.clone())?);
                    }
                }
                cur.gear = Arc::new(g);
                self.rebase(&mut cur)?;
                if k + 1 < socks.len() {
                    self.design_jewel(&mut cur, ji)?;
                }
            }
            *st = cur;
            changed = true;
        }
        Ok(changed)
    }

    /// Adds modifiers to the tree jewel in slot `ji` until none helps, then one swap.
    fn design_jewel(&mut self, ds: &mut State, ji: usize) -> Result<bool, String> {
        let mut changed = false;
        for _ in 0..6 {
            if self.stop() || !self.affix_round(ds, false, false, Some(ji))? {
                break;
            }
            changed = true;
        }
        if self.affix_round(ds, true, false, Some(ji))? {
            changed = true;
        }
        Ok(changed)
    }

    /// Items: bases for the open slots (once), then modifiers until none helps; `thorough` adds modifier swaps, uniques,
    /// other bases, the anoint and the tree jewel.
    pub(super) fn items_layer(&mut self, st: &mut State, thorough: bool) -> Result<bool, String> {
        if self.stop() {
            return Ok(false);
        }
        self.layer = "items".into();
        self.publish();
        let mut improved = false;
        if !st.gear.ready {
            self.init_gear(st)?;
            improved = true;
        }
        self.ensure_abyss(st)?;
        self.layer = "items: modifiers".into();
        let fill = |s: &mut Solver, st: &mut State, quick: bool| -> Result<bool, String> {
            let mut any = false;
            for _ in 0..8 {
                if s.stop() || !s.affix_round(st, false, quick, None)? {
                    break;
                }
                any = true;
            }
            Ok(any)
        };
        // Top crafting: plan every slot from line probes first; the rounds after it try the plan's freshest families.
        let top = self.rules.craft_top();
        if top {
            improved |= self.plan_pass(st, &craft::PlanCtx { lead: self.lead_hint.clone(), ..Default::default() })?.0;
        }
        improved |= fill(self, st, !thorough || top)?;
        if thorough {
            for _ in 0..3 {
                if self.stop() || !self.affix_round(st, true, true, None)? {
                    break;
                }
                improved = true;
            }
            if self.unique_pass(st)? {
                improved = true;
                fill(self, st, true)?;
            }
            self.layer = "items: bases".into();
            if self.base_pass(st)? {
                improved = true;
                fill(self, st, true)?;
            }
            improved |= self.craft_trial_pass(st)?;
            self.ensure_abyss(st)?;
            improved |= self.abyss_pass(st)?;
            improved |= self.anoint_pass(st)?;
            improved |= self.jewel_pass(st)?;
            improved |= self.cluster_pass(st)?;
            improved |= self.cluster_sub_pass(st)?;
            improved |= self.unique_jewel_pass(st)?;
            improved |= self.special_jewel_pass(st)?;
        }
        // (the score-only trade runs in thorough passes; a failed limit or a bare slot every time)
        if thorough || st.viol > 1e-7 || self.bare_slots(&st.gear) > 0 {
            improved |= self.link_budget_pass(st)?;
            while self.bare_slot_pass(st)? {
                improved = true;
            }
        }
        improved |= self.movement_pass(st)?;
        improved |= self.life_pass(st)?;
        improved |= self.cover_pass(st)?;
        improved |= self.flask_fill_pass(st)?;
        self.publish();
        Ok(improved)
    }

    /// An empty flask slot gets the utility flask (bare, or with one suffix) that scores best, when one beats leaving
    /// it empty: the soft checklist cells are in the score, so a flask suffix that meets an unmet chip (curse effect on
    /// you) is what fills it. Blocked and reserved slots stay as they are.
    pub(super) fn flask_fill_pass(&mut self, st: &mut State) -> Result<bool, String> {
        if self.stop() {
            return Ok(false);
        }
        let reserved = [self.life_flask_slot(), self.mana_flask_slot()];
        let mut ch: Vec<(usize, Option<Piece>)> = Vec::new();
        for i in (0..self.slots.len()).filter(|&k| self.slots[k].kind == SlotKind::Flask && !self.slots[k].locked && !reserved.contains(&Some(k)) && st.gear.pieces[k].is_none()) {
            for b in self.slot_bases(i) {
                let base = self.craft_base(&b, &[])?;
                if base.sub_type != "Utility" {
                    continue;
                }
                ch.push((i, Some(craft_piece(&base, Vec::new(), None, self.item_level))));
                ch.extend((0..base.fams.len()).filter(|&f| !base.fams[f].prefix && !base.fams[f].implicit).map(|f| (i, Some(craft_piece(&base, vec![f], None, self.item_level)))));
            }
        }
        if ch.is_empty() {
            return Ok(false);
        }
        self.layer = "items: empty flask slots".into();
        let mut done = self.apply_best(st, ch, false)?.0;
        // (no flask slot stays empty: one no flask beats takes the defence flask that adds the most EHP)
        for i in (0..self.slots.len()).filter(|&k| self.slots[k].kind == SlotKind::Flask && !self.slots[k].locked && !reserved.contains(&Some(k))) {
            if st.gear.pieces[i].is_none() {
                if let Some(s) = self.defence_flask_for(st, i)? {
                    *st = s;
                    done = true;
                }
            }
        }
        Ok(done)
    }

    /// The defence flask (Granite, Jade, ..., flask_class "defence"; bare or with one suffix) in slot `i` that adds the most
    /// EHP without costing score or a limit, when one adds any; a base another slot wears is not taken twice.
    pub(super) fn defence_flask_for(&self, st: &State, i: usize) -> Result<Option<State>, String> {
        let Some(k) = self.scorer.names.iter().position(|n| n == "TotalEHP") else { return Ok(None) };
        let ehp = |s: &State| s.vals.get(k).copied().flatten().unwrap_or(0.0);
        let worn: Vec<String> = st.gear.pieces.iter().enumerate().filter(|(j, _)| *j != i).filter_map(|(_, p)| p.as_ref().and_then(|p| p.base()).map(|b| b.name.clone())).collect();
        let mut states = Vec::new();
        for b in self.slot_bases(i) {
            let base = self.craft_base(&b, &[])?;
            if base.sub_type != "Utility" || flask_class(&base.name) != "defence" || worn.contains(&base.name) {
                continue;
            }
            let pieces = std::iter::once(Vec::new()).chain((0..base.fams.len()).filter(|&f| !base.fams[f].prefix && !base.fams[f].implicit).map(|f| vec![f]));
            for m in pieces {
                if let Some(g) = self.with_piece(&st.gear, i, Some(craft_piece(&base, m, None, self.item_level))) {
                    let mut s = st.clone();
                    s.gear = Arc::new(g);
                    states.push(s);
                }
            }
        }
        let base_ehp = ehp(st);
        Ok(self.eval_states(states)?.into_iter().flatten().filter(|s| s.score >= st.score - EPS && s.viol <= st.viol + EPS && ehp(s) > base_ehp + EPS).max_by(|a, b| ehp(a).total_cmp(&ehp(b))))
    }

    /// A player runs at more than base speed: crafted boots carry plain "increased Movement Speed", added when they have
    /// room, else in place of the modifier whose loss costs least (a seasoned player never goes without it). Boots that
    /// cannot hold it (a unique, a locked pair) leave it to a flask whose buff is movement speed, in the last free flask
    /// slot. The score values neither.
    pub(super) fn movement_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let Some(bi) = self.slot_of(SlotKind::Boots) else { return Ok(false) };
        let ms = |l: &str| l.trim_end().ends_with("% increased Movement Speed");
        let boots = |st: &State| st.gear.pieces[bi].as_ref().is_some_and(|p| active_lines(&p.xml).iter().any(|l| ms(l)));
        let speed_flask = |b: &str| flask_buff(b).iter().any(|l| l.contains("Movement Speed"));
        if boots(st) || self.stop() {
            return Ok(false);
        }
        self.layer = "items: movement speed".into();
        if !self.slots[bi].locked {
            if let Some(Design::Craft { base, mods, anoint }) = st.gear.pieces[bi].as_ref().map(|p| p.design.clone()) {
                let ch: Vec<(usize, Option<Piece>)> = (0..base.fams.len())
                    .filter(|&f| !base.fams[f].implicit && base.fams[f].lines.iter().any(|l| ms(l)))
                    .flat_map(|f| with_family(&base, &mods, f, true))
                    .map(|m| (bi, Some(craft_piece(&base, m, anoint.clone(), self.item_level))))
                    .collect();
                if !ch.is_empty() {
                    self.apply_best(st, ch, true)?;
                }
            }
        }
        if boots(st) {
            return Ok(true);
        }
        if st.gear.pieces.iter().enumerate().any(|(k, q)| self.slots[k].kind == SlotKind::Flask && q.as_ref().and_then(|q| q.base()).is_some_and(|b| speed_flask(&b.name))) {
            return Ok(false);
        }
        let reserved = [self.life_flask_slot(), self.mana_flask_slot()];
        let Some(fi) = (0..self.slots.len()).rev().find(|&k| self.slots[k].kind == SlotKind::Flask && !self.slots[k].locked && !reserved.contains(&Some(k))) else { return Ok(false) };
        let mut ch = Vec::new();
        for b in self.slot_bases(fi).into_iter().filter(|b| speed_flask(b)) {
            ch.push((fi, Some(self.empty_craft(&b)?)));
        }
        if ch.is_empty() {
            return Ok(false);
        }
        Ok(self.apply_best(st, ch, true)?.0)
    }

    /// A life build wears life on every crafted armour piece, shield and piece of jewellery with room for it: a slot
    /// without it is a gap a player fills even past the score's floors. Kept only where the build's life rises (a
    /// "no life modifiers on body armour" mastery goes the other way).
    fn life_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let at = |v: &Vals, k: &str| self.scorer.names.iter().position(|n| n == k).and_then(|j| v.get(j).copied().flatten());
        let Some(life) = at(&st.vals, "Life") else { return Ok(false) };
        if self.stop() || at(&st.vals, "EnergyShield").unwrap_or(0.0) > life || at(&st.vals, "Solver.Flag.ChaosInoculation").is_some_and(|c| c > 0.5) {
            return Ok(false);
        }
        let flat = |l: &str| l.trim_end().ends_with("to maximum Life");
        let mut ch: Vec<(usize, Option<Piece>)> = Vec::new();
        for i in 0..self.slots.len() {
            if self.slots[i].locked || !matches!(self.slots[i].kind, SlotKind::Helmet | SlotKind::Body | SlotKind::Gloves | SlotKind::Boots | SlotKind::Belt | SlotKind::Amulet | SlotKind::Ring | SlotKind::Weapon2) {
                continue;
            }
            let Some(p) = &st.gear.pieces[i] else { continue };
            let Design::Craft { base, mods, anoint } = &p.design else { continue };
            if (self.slots[i].kind == SlotKind::Weapon2 && base.item_type != "Shield") || p.xml.lines().any(flat) {
                continue;
            }
            for f in (0..base.fams.len()).filter(|&f| !base.fams[f].implicit && base.fams[f].lines.len() == 1 && flat(&base.fams[f].lines[0])) {
                for m in with_family(base, mods, f, false) {
                    ch.push((i, Some(craft_piece(base, m, anoint.clone(), self.item_level))));
                }
            }
        }
        if ch.is_empty() {
            return Ok(false);
        }
        self.layer = "items: life".into();
        let gears: Vec<Option<Gear>> = ch.iter().map(|(i, p)| self.with_piece(&st.gear, *i, p.clone())).collect();
        let mut r = self.eval_gears(st, &gears.iter().flatten().cloned().collect::<Vec<_>>())?.into_iter();
        // per slot, the best change that raises life
        let mut best: Vec<(usize, f64, usize)> = Vec::new();
        for (k, g) in gears.iter().enumerate() {
            let Some(Some(v)) = g.as_ref().map(|_| r.next().flatten()) else { continue };
            if at(&v.2, "Life").is_none_or(|l| l <= life + 1e-6) {
                continue;
            }
            let slot = ch[k].0;
            match best.iter_mut().find(|b| b.0 == slot) {
                Some(b) if v.0 > b.1 => *b = (slot, v.0, k),
                Some(_) => {}
                None => best.push((slot, v.0, k)),
            }
        }
        if best.is_empty() {
            return Ok(false);
        }
        let chosen: Vec<(usize, Option<Piece>)> = best.iter().map(|b| ch[b.2].clone()).collect();
        Ok(self.apply_best(st, chosen, true)?.0)
    }

    /// Freeze stops a player cold: a build no worn item or flask protects from it gets the flask suffix that does
    /// (read from the flask's families: "Immunity to Freeze and Chill during Effect"), added to a utility flask or in
    /// place of a suffix, whichever costs least. The score does not value it.
    fn cover_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let avoid = self.scorer.names.iter().position(|n| n == "FreezeAvoidChance").and_then(|j| st.vals.get(j).copied().flatten()).unwrap_or(0.0);
        if avoid >= 100.0 || self.stop() || st.gear.pieces.iter().flatten().any(|p| active_lines(&p.xml).iter().any(|l| line_covers(l, "freeze", false))) {
            return Ok(false);
        }
        let reserved = [self.life_flask_slot(), self.mana_flask_slot()];
        let mut ch: Vec<(usize, Option<Piece>)> = Vec::new();
        // (immunity, not a chance to avoid: one flask that stops it, not four that halve it)
        let covering = |b: &BaseInfo| (0..b.fams.len()).filter(|&f| b.fams[f].lines.iter().any(|l| line_covers(l, "freeze", false) && l.contains("Immun"))).collect::<Vec<_>>();
        for i in (0..self.slots.len()).filter(|&k| self.slots[k].kind == SlotKind::Flask && !self.slots[k].locked && !reserved.contains(&Some(k))) {
            match st.gear.pieces[i].as_ref().map(|p| &p.design) {
                Some(Design::Craft { base, mods, anoint }) => {
                    for f in covering(base) {
                        for m in with_family(base, mods, f, true) {
                            ch.push((i, Some(craft_piece(base, m, anoint.clone(), self.item_level))));
                        }
                    }
                }
                // (an empty flask slot: each utility flask with the suffix)
                None => {
                    for b in self.slot_bases(i) {
                        let base = self.craft_base(&b, &[])?;
                        if base.sub_type == "Utility" {
                            ch.extend(covering(&base).into_iter().map(|f| (i, Some(craft_piece(&base, vec![f], None, self.item_level)))));
                        }
                    }
                }
                _ => {}
            }
        }
        if ch.is_empty() {
            return Ok(false);
        }
        self.layer = "items: freeze immunity".into();
        // the one change that costs least (apply_best would put it on every flask at once)
        let gears: Vec<Option<Gear>> = ch.iter().map(|(i, p)| self.with_piece(&st.gear, *i, p.clone())).collect();
        let mut r = self.eval_gears(st, &gears.iter().flatten().cloned().collect::<Vec<_>>())?.into_iter();
        let scores: Vec<f64> = gears.iter().map(|g| g.as_ref().and_then(|_| r.next().flatten()).map_or(f64::NEG_INFINITY, |v| v.0)).collect();
        let Some(k) = (0..ch.len()).filter(|&k| scores[k].is_finite()).max_by(|&a, &b| scores[a].total_cmp(&scores[b])) else { return Ok(false) };
        Ok(self.apply_best(st, vec![ch[k].clone()], true)?.0)
    }

    /// States rendered and evaluated whole; each comes back scored (`None` when the calc failed).
    pub(super) fn eval_states(&self, states: Vec<State>) -> Result<Vec<Option<State>>, String> {
        self.eval_states_vs(states, None)
    }

    /// `eval_states`, where a state no dearer than `old` is affordable too (a build already past the budget keeps what
    /// it has: `affordable`).
    pub(super) fn eval_states_vs(&self, states: Vec<State>, old: Option<&Gear>) -> Result<Vec<Option<State>>, String> {
        // (a state over the wealth budget is not evaluated: it comes back as `None`)
        if states.iter().any(|s| !self.affordable(&s.gear, old)) {
            let ok: Vec<bool> = states.iter().map(|s| self.affordable(&s.gear, old)).collect();
            let mut r = self.eval_states_vs(states.into_iter().zip(&ok).filter(|(_, ok)| **ok).map(|(s, _)| s).collect(), old)?.into_iter();
            return Ok(ok.iter().map(|&ok| if ok { r.next().flatten() } else { None }).collect());
        }
        let mut texts = Vec::with_capacity(states.len());
        for s in &states {
            texts.push(Arc::new(self.render(s)?));
        }
        let r = self.eval(texts.iter().map(|x| Cand::Xml(x.clone())).collect());
        Ok(states
            .into_iter()
            .zip(texts)
            .zip(r)
            .map(|((mut s, x), v)| {
                let v = v?;
                let (sc, viol) = self.score(&v);
                s.base = x;
                s.score = sc;
                s.viol = viol;
                s.vals = v;
                self.settle(&mut s);
                Some(s)
            })
            .collect())
    }

    /// `st` with at least `need` passive points free, given back in the groups that cost the goal least per point
    /// (anything left unconnected goes too); `None` when the tree cannot give that much.
    pub(super) fn free_points(&mut self, st: &State, need: usize) -> Option<State> {
        let mut free = self.points.saturating_sub(self.used(st).0);
        if free >= need {
            return Some(st.clone());
        }
        let groups = self.removal_groups(st, false, 8);
        let cands: Vec<(Vec<i64>, Option<(i64, i64)>)> = groups.iter().map(|g| (Self::without(st, g).nodes, None)).collect();
        let r = self.eval_nodes(st, &cands);
        let mut order: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(i, v)| v.as_ref().map(|v| ((st.score - v.0) / groups[i].len() as f64, i))).collect();
        order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let mut s = st.clone();
        for (_, gi) in order {
            if free >= need {
                break;
            }
            if groups[gi].iter().any(|n| !s.nodes.contains(n)) {
                continue;
            }
            s = Self::without(&s, &groups[gi]);
            let c = &self.ctx[st.class];
            let main: HashSet<i64> = s.nodes.iter().copied().collect();
            let conn = c.connected(&main, false);
            s.nodes.retain(|n| !c.is_main(*n) || conn.contains(n));
            free = self.points.saturating_sub(self.used(&s).0);
        }
        (free >= need).then_some(s)
    }

    pub(super) fn cluster_base(&self, size: &str, skill: &pom_item::modpool::ClusterSkill, passives: usize) -> Result<Arc<BaseInfo>, String> {
        let key = format!("{size}|{}|{passives}", skill.id);
        if let Some(b) = self.bases.borrow().get(&key) {
            return Ok(b.clone());
        }
        let mut b = base_info_tagged(size, self.item_level, self.level as u32, std::slice::from_ref(&skill.tag), self.goal.rolls == super::Rolls::Perfect)?;
        // (the notables and the "also grant" lines; the enchant, passive and socket counts are the crafted implicits)
        b.fams.retain(|f| !f.lines.iter().any(|l| l.starts_with("Adds ") || l.contains("Jewel Socket")));
        b.implicit = vec![format!("{{crafted}}Adds {passives} Passive Skills")];
        if size == "Large Cluster Jewel" {
            b.implicit.push("{crafted}2 Added Passive Skills are Jewel Sockets".to_string());
        }
        b.implicit.extend(skill.enchant.iter().map(|e| format!("{{crafted}}{e}")));
        b.header = vec![format!("Cluster Jewel Skill: {}", skill.id), format!("Cluster Jewel Node Count: {passives}")];
        let b = Arc::new(b);
        self.bases.borrow_mut().insert(key, b.clone());
        Ok(b)
    }

    /// The passives and the jewel sockets a cluster jewel (of `size`, with `notables` notables) adds in socket `sock`, as
    /// the tree builds them.
    pub(super) fn cluster_node_ids(&self, st: &State, sock: i64, size: &str, notables: usize, probe: &Piece) -> Result<(Vec<i64>, Vec<i64>), String> {
        let key = format!("{sock}|{size}|{notables}");
        if let Some(v) = self.cluster_ids.borrow().get(&key) {
            return Ok(v.clone());
        }
        let mut with = st.clone();
        let mut g = (*st.gear).clone();
        g.sockets.retain(|x| x.node != sock);
        g.sockets.push(SocketItem { node: sock, xml: probe.xml.clone(), label: String::new(), kept: false, nodes: Vec::new(), unique: None, subs: Vec::new(), cost: 0.0 });
        with.gear = Arc::new(g);
        let mut without = st.clone();
        let mut g = (*st.gear).clone();
        g.sockets.retain(|x| x.node != sock);
        without.gear = Arc::new(g);
        let a = self.session.paths_for_xml(&self.render(&with)?)?;
        let b = self.session.paths_for_xml(&self.render(&without)?)?;
        let new: Vec<i64> = {
            let mut v: Vec<i64> = a.nodes.iter().filter(|(id, n)| **id >= 65536 && !b.nodes.contains_key(id) && n.kind != "Socket" && n.kind != "Mastery").map(|(id, _)| *id).collect();
            v.sort_unstable();
            v
        };
        // The socket's own sockets the jewel's passives link to.
        let linked = |k: i64| a.nodes.get(&k).is_some_and(|n| n.linked.iter().any(|l| new.contains(l))) || new.iter().any(|g| a.nodes.get(g).is_some_and(|n| n.linked.contains(&k)));
        let subs: Vec<i64> = self.sub_sockets.get(&sock).map(|v| v.iter().copied().filter(|&k| linked(k)).collect()).unwrap_or_default();
        // The jewel's passives past one of its own sockets are cut off from the tree until that socket is allocated (one
        // point each): the engine prunes them, so a notable behind a socket did nothing. Walk from the socket the jewel
        // sits in and take the sockets on the way to every passive.
        let mut up: HashMap<i64, i64> = HashMap::default();
        let mut queue = std::collections::VecDeque::from([sock]);
        while let Some(x) = queue.pop_front() {
            for &l in a.nodes.get(&x).map(|n| n.linked.as_slice()).unwrap_or(&[]) {
                if l != sock && !up.contains_key(&l) && (new.contains(&l) || subs.contains(&l)) {
                    up.insert(l, x);
                    queue.push_back(l);
                }
            }
        }
        let mut new = new;
        for &id in &new.clone() {
            let mut x = id;
            while let Some(&p) = up.get(&x) {
                if subs.contains(&p) && !new.contains(&p) {
                    new.push(p);
                }
                x = p;
            }
        }
        new.sort_unstable();
        let r = (new, subs);
        self.cluster_ids.borrow_mut().insert(key, r.clone());
        Ok(r)
    }

    /// A rare large cluster jewel (8 passives, 2 of them jewel sockets) in one of the two outer sockets nearest the
    /// tree, its six passives allocated, the points freed from the least useful groups: every enchant is tried bare,
    /// the best three get modifiers (notables and "also grant" lines) one at a time. Kept when the goal scores higher.
    pub(super) fn cluster_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let designs = self.cluster_designs(st)?;
        let Some(mut b) = designs.into_iter().max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal)) else { return Ok(false) };
        // Points left over from the freed groups.
        self.grow(&mut b, false)?;
        if b.score > st.score + EPS {
            *st = b;
            self.publish();
            return Ok(true);
        }
        Ok(false)
    }

    /// Every large cluster jewel design `cluster_pass` builds for `st` (per outer socket, the best three enchants
    /// with modifiers added), each as the evaluated state holding it, before the leftover points are grown.
    pub(super) fn cluster_designs(&mut self, st: &State) -> Result<Vec<State>, String> {
        const PASSIVES: usize = 8;
        const LARGE: &str = "Large Cluster Jewel";
        let Some(ji) = self.slot_of(SlotKind::TreeJewel) else { return Ok(Vec::new()) };
        // Shortcut: one solver large cluster jewel per build (medium and small ones go in its sockets, see
        // `cluster_sub_pass`); a second large socket when builds need it
        if self.slots[ji].locked || self.stop() || self.large_sockets.is_empty() || st.gear.sockets.iter().any(|s| !s.kept && !s.nodes.is_empty()) || self.goal.wealth.is_some_and(|w| !w.allows_large_cluster()) {
            return Ok(Vec::new());
        }
        self.layer = "items: cluster jewel".into();
        self.publish();
        let game = pom_calc::data::game_data();
        let skills = mod_pool(game, "Large Cluster Jewel", self.item_level, &PoolOptions::default())?.cluster_skills;
        if skills.is_empty() {
            return Ok(Vec::new());
        }
        let c = &self.ctx[st.class];
        let alloc: HashSet<i64> = st.nodes.iter().copied().collect();
        let reach = c.bfs(&alloc, false);
        let mut socks: Vec<(usize, i64)> = self.large_sockets.iter().copied().filter(|s| !st.gear.sockets.iter().any(|x| x.node == *s && !x.is_design())).filter_map(|s| if alloc.contains(&s) { Some((0, s)) } else { reach.get(&s).map(|(d, _)| (*d, s)) }).collect();
        socks.sort_unstable();
        socks.truncate(2);
        let mut out: Vec<State> = Vec::new();
        for (d, sock) in socks {
            if self.stop() {
                break;
            }
            let Some(mut base) = self.free_points(st, d + PASSIVES) else { continue };
            if !base.nodes.contains(&sock) {
                let c = &self.ctx[st.class];
                let a: HashSet<i64> = base.nodes.iter().copied().collect();
                let reach = c.bfs(&a, false);
                let Some(&(d2, _)) = reach.get(&sock) else { continue };
                if self.used(&base).0 + d2 + PASSIVES > self.points {
                    continue;
                }
                base.nodes.extend(c.path_to(&reach, sock));
            }
            // The passives' ids depend on how many of them are notables: one probe jewel per notable count.
            let pb = self.cluster_base(LARGE, &skills[0], PASSIVES)?;
            let notable = |b: &BaseInfo, f: usize| b.fams[f].lines.iter().any(|l| l.contains("Added Passive Skill is"));
            let mut ids_by: Vec<(Vec<i64>, Vec<i64>)> = Vec::new();
            let mut pm: Vec<usize> = Vec::new();
            for n in 0..=3usize {
                if n > 0 {
                    match (0..pb.fams.len()).find(|&f| notable(&pb, f) && addable(&pb, &pm, f)) {
                        Some(f) => pm.push(f),
                        None => break,
                    }
                }
                ids_by.push(self.cluster_node_ids(&base, sock, LARGE, n, &craft_piece(&pb, pm.clone(), None, self.item_level))?);
            }
            if ids_by.first().is_none_or(|v| v.0.is_empty()) {
                continue;
            }
            let with = |b: &State, p: Piece| -> State {
                let n = match &p.design {
                    Design::Craft { base, mods, .. } => mods.iter().filter(|&&f| notable(base, f)).count(),
                    _ => 0,
                };
                let (ids, subs) = ids_by.get(n).or(ids_by.last()).cloned().unwrap_or_default();
                let mut n = b.clone();
                let mut g = (*b.gear).clone();
                g.sockets.retain(|x| x.node != sock);
                g.sockets.push(SocketItem { node: sock, label: format!("{} (cluster jewel)", p.label), xml: p.xml.clone(), kept: false, nodes: ids, unique: None, subs, cost: self.piece_cost(&p) });
                n.gear = Arc::new(g);
                n
            };
            // Enchants, bare.
            let mut designs = Vec::new();
            let mut states = Vec::new();
            for sk in &skills {
                let b = self.cluster_base(LARGE, sk, PASSIVES)?;
                states.push(with(&base, craft_piece(&b, Vec::new(), None, self.item_level)));
                designs.push(b);
            }
            let r = self.eval_states(states)?;
            let mut ranked: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(i, s)| s.as_ref().map(|s| (s.score, i))).collect();
            ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
            for &(_, k) in ranked.iter().take(3) {
                let b = designs[k].clone();
                let mut mods: Vec<usize> = Vec::new();
                let Some(mut cur) = r[k].clone() else { continue };
                // Modifiers one at a time (two prefixes, two suffixes at most), a notable first: a cluster jewel with no
                // notable is never worth its passives' points to a player.
                for _ in 0..4 {
                    if self.stop() {
                        break;
                    }
                    let fs: Vec<usize> = (0..b.fams.len()).filter(|&f| addable(&b, &mods, f) && (!mods.is_empty() || notable(&b, f))).collect();
                    let states: Vec<State> = fs
                        .iter()
                        .map(|&f| {
                            let mut m = mods.clone();
                            m.push(f);
                            with(&base, craft_piece(&b, m, None, self.item_level))
                        })
                        .collect();
                    let rr = self.eval_states(states)?;
                    let Some((i, s)) = rr.into_iter().enumerate().filter_map(|(i, s)| s.map(|s| (i, s))).max_by(|a, b| a.1.score.partial_cmp(&b.1.score).unwrap_or(std::cmp::Ordering::Equal)) else { break };
                    if s.score <= cur.score + EPS {
                        break;
                    }
                    mods.push(fs[i]);
                    cur = s;
                }
                if mods.iter().any(|&f| notable(&b, f)) {
                    out.push(cur);
                }
            }
        }
        Ok(out)
    }

    /// A medium (4 passives) or small (2 passives) rare cluster jewel in each free socket of the solver's large cluster
    /// jewel: the socket and the passives cost points (freed from the least useful groups), every enchant of both
    /// sizes is tried bare, the best two get modifiers one at a time. Kept when the goal scores higher.
    pub(super) fn cluster_sub_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let Some(ji) = self.slot_of(SlotKind::TreeJewel) else { return Ok(false) };
        if self.slots[ji].locked || self.stop() {
            return Ok(false);
        }
        let Some(li) = st.gear.sockets.iter().position(|s| !s.kept && !s.subs.is_empty()) else { return Ok(false) };
        let game = pom_calc::data::game_data();
        let sizes: Vec<(&str, usize, usize)> = vec![("Medium Cluster Jewel", 4, 2), ("Small Cluster Jewel", 2, 1)];
        let mut any = false;
        for sub in st.gear.sockets[li].subs.clone() {
            if self.stop() || st.gear.sockets.iter().any(|s| s.node == sub) {
                continue;
            }
            self.layer = "items: cluster jewel (medium/small)".into();
            self.publish();
            let mut best: Option<State> = None;
            for &(size, passives, max_notables) in &sizes {
                if self.stop() {
                    break;
                }
                let skills = mod_pool(game, size, self.item_level, &PoolOptions::default())?.cluster_skills;
                if skills.is_empty() {
                    continue;
                }
                let Some(mut base) = self.free_points(st, passives + 1) else { continue };
                // (freeing points may have dropped the large jewel's socket)
                if !base.nodes.contains(&st.gear.sockets[li].node) {
                    continue;
                }
                // The large jewel's passives now include this socket (one point).
                let mut g = (*base.gear).clone();
                let Some(lk) = g.sockets.iter().position(|s| s.node == st.gear.sockets[li].node) else { continue };
                if !g.sockets[lk].nodes.contains(&sub) {
                    g.sockets[lk].nodes.push(sub);
                }
                base.gear = Arc::new(g);
                let pb = self.cluster_base(size, &skills[0], passives)?;
                let notable = |b: &BaseInfo, f: usize| b.fams[f].lines.iter().any(|l| l.contains("Added Passive Skill is"));
                let mut ids_by: Vec<Vec<i64>> = Vec::new();
                let mut pm: Vec<usize> = Vec::new();
                for n in 0..=max_notables {
                    if n > 0 {
                        match (0..pb.fams.len()).find(|&f| notable(&pb, f) && addable(&pb, &pm, f)) {
                            Some(f) => pm.push(f),
                            None => break,
                        }
                    }
                    ids_by.push(self.cluster_node_ids(&base, sub, size, n, &craft_piece(&pb, pm.clone(), None, self.item_level))?.0);
                }
                if ids_by.first().is_none_or(|v| v.is_empty()) {
                    continue;
                }
                let with = |b: &State, p: Piece| -> State {
                    let n = match &p.design {
                        Design::Craft { base, mods, .. } => mods.iter().filter(|&&f| notable(base, f)).count(),
                        _ => 0,
                    };
                    let ids = ids_by.get(n).or(ids_by.last()).cloned().unwrap_or_default();
                    let mut n = b.clone();
                    let mut g = (*b.gear).clone();
                    g.sockets.retain(|x| x.node != sub);
                    g.sockets.push(SocketItem { node: sub, label: format!("{} (cluster jewel)", p.label), xml: p.xml.clone(), kept: false, nodes: ids, unique: None, subs: Vec::new(), cost: self.piece_cost(&p) });
                    n.gear = Arc::new(g);
                    n
                };
                let mut designs = Vec::new();
                let mut states = Vec::new();
                for sk in &skills {
                    let b = self.cluster_base(size, sk, passives)?;
                    states.push(with(&base, craft_piece(&b, Vec::new(), None, self.item_level)));
                    designs.push(b);
                }
                let r = self.eval_states(states)?;
                let mut ranked: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(i, s)| s.as_ref().map(|s| (s.score, i))).collect();
                ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                for &(_, k) in ranked.iter().take(2) {
                    let b = designs[k].clone();
                    let mut mods: Vec<usize> = Vec::new();
                    let Some(mut cur) = r[k].clone() else { continue };
                    for _ in 0..4 {
                        if self.stop() {
                            break;
                        }
                        let fs: Vec<usize> = (0..b.fams.len()).filter(|&f| addable(&b, &mods, f) && (!mods.is_empty() || notable(&b, f)) && (!notable(&b, f) || mods.iter().filter(|&&m| notable(&b, m)).count() < max_notables)).collect();
                        let states: Vec<State> = fs
                            .iter()
                            .map(|&f| {
                                let mut m = mods.clone();
                                m.push(f);
                                with(&base, craft_piece(&b, m, None, self.item_level))
                            })
                            .collect();
                        let rr = self.eval_states(states)?;
                        let Some((i, s)) = rr.into_iter().enumerate().filter_map(|(i, s)| s.map(|s| (i, s))).max_by(|a, b| a.1.score.partial_cmp(&b.1.score).unwrap_or(std::cmp::Ordering::Equal)) else { break };
                        if s.score <= cur.score + EPS {
                            break;
                        }
                        mods.push(fs[i]);
                        cur = s;
                    }
                    // (no notable: not worth its passives, see `cluster_designs`)
                    if mods.iter().any(|&f| notable(&b, f)) && best.as_ref().is_none_or(|b| cur.score > b.score) {
                        best = Some(cur);
                    }
                }
            }
            let Some(mut b) = best else { continue };
            self.grow(&mut b, false)?;
            if b.score > st.score + EPS {
                *st = b;
                any = true;
                self.publish();
            }
        }
        Ok(any)
    }

    /// A perturbation for the search: one crafted item (not a flask or the tree jewel) made again from a random base
    /// of its slot, its modifiers chosen afresh.
    pub(super) fn item_kick(&mut self, st: &State, pick: u64) -> Result<State, String> {
        let slots: Vec<usize> = (0..self.slots.len()).filter(|&i| !self.slots[i].locked && !st.gear.held.contains(&i) && !matches!(self.slots[i].kind, SlotKind::Flask | SlotKind::TreeJewel) && matches!(st.gear.pieces[i].as_ref().map(|p| &p.design), Some(Design::Craft { .. }))).collect();
        let mut s = st.clone();
        if slots.is_empty() {
            return Ok(s);
        }
        let i = slots[(pick % slots.len() as u64) as usize];
        let bases = self.slot_bases(i);
        if bases.is_empty() {
            return Ok(s);
        }
        let b = &bases[((pick / 7) % bases.len() as u64) as usize];
        // top mode: no influence, or one of the base's own, by the pick
        let mut own = if self.rules.craft_top() { craft::base_influences(b)? } else { Vec::new() };
        if self.goal.wealth.is_some_and(|w| w.max_influences() == 0) {
            own.clear();
        }
        let k = ((pick / 53) % (own.len() as u64 + 1)) as usize;
        let inf: Vec<String> = own.get(k.wrapping_sub(1)).cloned().into_iter().collect();
        let Some(g) = self.with_piece(&s.gear, i, Some(self.empty_craft_with(b, &inf)?)) else { return Ok(s) };
        s.gear = Arc::new(g);
        self.rebase(&mut s)?;
        self.ensure_abyss(&mut s)?;
        for _ in 0..8 {
            if self.stop() || !self.affix_round(&mut s, false, false, Some(i))? {
                break;
            }
        }
        Ok(s)
    }

    /// Each allowed unique jewel (not cluster, timeless or abyss) in each allocated tree socket that holds the tree
    /// jewel design, against that design.
    pub(super) fn unique_jewel_pass(&mut self, st: &mut State) -> Result<bool, String> {
        if self.uniques.is_empty() || self.stop() {
            return Ok(false);
        }
        let socks: Vec<i64> = self.tree_sockets.iter().copied().filter(|s| st.nodes.contains(s) && !st.gear.sockets.iter().any(|x| x.node == *s && !x.is_design())).take(3).collect();
        if socks.is_empty() {
            return Ok(false);
        }
        let jewels: Vec<Arc<UniqueInfo>> = self.uniques.iter().flat_map(|u| std::iter::once(u).chain(u.variants.iter())).filter(|u| u.special.is_none() && u.item_type == "Jewel" && u.sub_type != "Abyss" && !u.base.contains("Cluster") && u.base != "Timeless Jewel" && !st.gear.has_unique(&u.name)).cloned().collect();
        let mut states = Vec::new();
        for &sock in &socks {
            for u in &jewels {
                let mut n = st.clone();
                let mut g = (*st.gear).clone();
                g.sockets.retain(|x| x.node != sock);
                g.sockets.push(SocketItem { node: sock, xml: u.xml.clone(), label: u.label.clone(), kept: false, nodes: Vec::new(), unique: Some(u.name.clone()), subs: Vec::new(), cost: self.unique_cost(&u.name) });
                n.gear = Arc::new(g);
                states.push(n);
            }
        }
        self.layer = "items: unique jewels".into();
        let r = self.eval_states(states)?;
        let Some(b) = r.into_iter().flatten().max_by(|a, b| a.score.partial_cmp(&b.score).unwrap_or(std::cmp::Ordering::Equal)) else { return Ok(false) };
        if b.score > st.score + EPS {
            *st = b;
            self.publish();
            return Ok(true);
        }
        Ok(false)
    }

    pub(super) fn gear_json(&self, gear: &Gear) -> Value {
        let mut out: Vec<Value> = gear.pieces.iter().enumerate().filter_map(|(i, p)| p.as_ref().map(|p| json!({ "slot": self.slots[i].name, "item": p.label, "locked": self.slots[i].locked }))).collect();
        for si in &gear.sockets {
            out.push(json!({ "slot": format!("Jewel {}", si.node), "item": si.label, "locked": si.kept }));
        }
        Value::Array(out)
    }
}

#[cfg(test)]
#[path = "solver_items_pass_tests.rs"]
mod pass_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn solver_for(goal: &str) -> Solver {
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// A tornado-like start (Tornado Shot, flasks counted, `wealth` a goal field or empty) with the bases chosen.
    fn started(wealth: &str) -> (Solver, State) {
        let mut s = solver_for(&format!(r#"{{"skill":"Tornado Shot","level":90,{wealth}"assume":{{"flasks":true}}}}"#));
        let c = s.candidates().unwrap();
        let mut st = s.initial_state(c[0], None, None).unwrap();
        s.init_gear(&mut st).unwrap();
        (s, st)
    }

    fn worn(s: &Solver, st: &State, name: &str) -> Option<Piece> {
        s.slots.iter().position(|d| d.name == name).and_then(|i| st.gear.pieces[i].clone())
    }

    /// Under a 10 divine cap body, helmet, gloves, boots and belt still hold a base (empty cost nothing and won).
    #[test]
    fn armour_slots_are_filled_under_a_cap() {
        let (s, st) = started(r#""wealth":"mid-league","#);
        for n in ["Helmet", "Body Armour", "Gloves", "Boots", "Belt"] {
            assert!(worn(&s, &st, n).is_some(), "{n} is empty");
        }
    }

    /// Flask 1 is a life flask that removes bleeding, and no four resist flasks stack.
    #[test]
    fn flasks_have_life_and_no_stacked_effect() {
        let (s, st) = started(r#""wealth":"mid-league","#);
        let f1 = worn(&s, &st, "Flask 1").expect("Flask 1");
        assert!(f1.xml.contains(" Life Flask") && f1.xml.contains("Bleeding"), "{}", f1.label);
        let resist = (1..=5).filter_map(|n| worn(&s, &st, &format!("Flask {n}"))).filter(|p| p.base().is_some_and(|b| ["Ruby", "Sapphire", "Topaz", "Amethyst"].iter().any(|r| b.name.starts_with(r)))).count();
        assert!(resist <= 1, "{resist} resist flasks");
    }

    /// The boots carry movement speed or a Quicksilver Flask is worn.
    #[test]
    fn build_moves_faster_than_base() {
        let (mut s, mut st) = started("");
        s.movement_pass(&mut st).unwrap();
        let boots = worn(&s, &st, "Boots").expect("boots");
        let quicksilver = (1..=5).filter_map(|n| worn(&s, &st, &format!("Flask {n}"))).any(|p| p.base().is_some_and(|b| b.name == "Quicksilver Flask"));
        assert!(boots.xml.contains("increased Movement Speed") || quicksilver, "{}", boots.label);
    }

    /// The Bringer of Rain ("Can't use Chest armour") and a body armour never share a build.
    #[test]
    fn bringer_of_rain_and_body_armour_exclude_each_other() {
        let (s, st) = started("");
        let bringer = unique_list(&ItemRules::default(), 90, None, &|_, _| true).into_iter().find(|u| u.name == "The Bringer of Rain").expect("Bringer of Rain");
        let (h, b) = (s.slot_of(SlotKind::Helmet).unwrap(), s.slot_of(SlotKind::Body).unwrap());
        assert!(st.gear.pieces[b].is_some());
        assert!(s.with_piece(&st.gear, h, Some(unique_piece(&bringer))).is_none(), "Bringer put on over a worn body armour");
        let mut bare = (*st.gear).clone();
        bare.pieces[b] = None;
        let worn_bringer = s.with_piece(&bare, h, Some(unique_piece(&bringer))).expect("Bringer on a bare chest");
        let body = st.gear.pieces[b].clone();
        assert!(s.with_piece(&worn_bringer, b, body).is_none(), "body armour over the Bringer");
    }

    #[test]
    fn rolls_and_families() {
        assert_eq!(max_roll("+(91-100) to maximum Life"), "+100 to maximum Life");
        assert_eq!(max_roll("Adds (10-15) to (20-25) Fire Damage"), "Adds 15 to 25 Fire Damage");
        assert_eq!(max_roll("(-25--15)% to Fire Resistance"), "-15% to Fire Resistance");
        assert_eq!(max_roll("10% increased Attack Speed"), "10% increased Attack Speed");
        assert_eq!(family_text(&["+(91-100) to maximum Life".to_string()]), family_text(&["+(5-10) to maximum Life".to_string()]));
        // Typical: the middle of the top two tiers' span; one tier: the middle of its range.
        assert_eq!(typical_roll("+(110-119) to maximum Life", Some("+(100-109) to maximum Life")), "+110 to maximum Life");
        assert_eq!(typical_roll("Adds (10-15) to (20-25) Fire Damage", None), "Adds 13 to 23 Fire Damage");
        assert_eq!(typical_roll("(0.5-0.8)% of Physical Attack Damage Leeched as Life", None), "0.7% of Physical Attack Damage Leeched as Life");
        assert_eq!(typical_roll("10% increased Attack Speed", Some("8% increased Attack Speed")), "10% increased Attack Speed");
        // A typical rare is weaker than a perfect one.
        let (t, p) = (base_info("Vaal Regalia", 90, 90, false).unwrap(), base_info("Vaal Regalia", 90, 90, true).unwrap());
        let life = |b: &BaseInfo| b.fams.iter().find(|f| f.lines.len() == 1 && f.lines[0].ends_with("to maximum Life")).map(|f| f.lines[0].clone());
        assert!(life(&t).is_some() && life(&t) != life(&p), "{:?} {:?}", life(&t), life(&p));
    }

    /// Uniques whose effect upstream cannot model (one random effect at a time, all counted at once) are not offered.
    #[test]
    fn random_choice_uniques_left_out() {
        let names: Vec<String> = unique_list(&ItemRules::default(), 90, None, &|_, _| true).iter().map(|u| u.name.clone()).collect();
        assert!(names.iter().any(|n| n == "Kintsugi"));
        assert!(!names.iter().any(|n| n == "Bound Fate"));
    }

    /// A large cluster jewel's pool for a skill tag has notables ("1 Added Passive Skill is ...").
    #[test]
    fn cluster_pool_has_notables() {
        let game = pom_calc::data::game_data();
        let skills = mod_pool(game, "Large Cluster Jewel", 90, &PoolOptions::default()).unwrap().cluster_skills;
        let chaos = skills.iter().find(|s| s.id.contains("chaos")).expect("a chaos skill");
        let b = base_info_tagged("Large Cluster Jewel", 90, 90, std::slice::from_ref(&chaos.tag), true).unwrap();
        let notables: Vec<&Fam> = b.fams.iter().filter(|f| f.lines.iter().any(|l| l.contains("Added Passive Skill is"))).collect();
        assert!(!notables.is_empty(), "{:?}", b.fams.iter().map(|f| (&f.key, f.req)).collect::<Vec<_>>());
    }

    #[test]
    fn crafted_rare_is_rollable() {
        let b = Arc::new(base_info("Vaal Regalia", 90, 90, true).unwrap());
        assert_eq!((b.prefix_limit, b.suffix_limit), (3, 3));
        let life = b.fams.iter().position(|f| f.group == "IncreasedLife" && f.prefix).unwrap();
        // One modifier per group: no second life roll.
        assert!(!addable(&b, &[life], life));
        let p = craft_piece(&b, vec![life], None, 90);
        assert!(p.xml.contains("Rarity: RARE") && p.xml.contains("Vaal Regalia"), "{}", p.xml);
        // The best life tier at item level 90 is level 86's (+(110-119) or similar); its top roll is written.
        assert!(b.fams[life].lines[0].contains("to maximum Life") && !b.fams[life].lines[0].contains('('));
        // Every family needs at most the character level.
        assert!(b.fams.iter().all(|f| f.req <= 90));
        let low = base_info("Vaal Regalia", 90, 20, true).unwrap();
        assert!(low.fams.iter().all(|f| f.req <= 20) && low.fams.len() < b.fams.len());
    }

    /// Two allocated sockets hold two designs under two item ids, each within the jewel's 2 prefix / 2 suffix limits.
    #[test]
    fn each_socket_has_its_own_jewel_design() {
        let b = Arc::new(base_info("Crimson Jewel", 86, 100, true).unwrap());
        let design = |order: Vec<usize>| {
            let mut mods: Vec<usize> = Vec::new();
            for f in order {
                if addable(&b, &mods, f) {
                    mods.push(f);
                }
            }
            craft_piece(&b, mods, None, 86)
        };
        let (a, c) = (design((0..b.fams.len()).collect()), design((0..b.fams.len()).rev().collect()));
        for p in [&a, &c] {
            let Design::Craft { mods, .. } = &p.design else { panic!("craft") };
            let n = |pre: bool| mods.iter().filter(|&&m| !b.fams[m].implicit && b.fams[m].prefix == pre).count();
            println!("{}: {} prefixes, {} suffixes", p.label, n(true), n(false));
            assert!(n(true) == 2 && n(false) == 2);
        }
        assert_ne!(a.xml, c.xml);
        let si = |node: i64, p: &Piece| SocketItem { node, xml: p.xml.clone(), label: p.label.clone(), kept: false, nodes: Vec::new(), unique: None, subs: Vec::new(), cost: 0.0 };
        let defs = slot_defs(&ItemRules::default());
        let gear = Gear { ready: true, pieces: vec![None; defs.len()], sockets: vec![si(11, &a), si(22, &c)], groups: Vec::new(), flask_mask: 0, gems: 0.0, sockets_need: (0, 0), held: Vec::new() };
        assert!(gear.sockets.iter().all(|x| x.is_design()));
        let xml = sockets_xml(&defs, &gear, &[11, 22]);
        println!("{xml}");
        assert!(xml.contains("nodeId=\"11\" itemId=\"500\"") && xml.contains("nodeId=\"22\" itemId=\"501\""));
        assert!(items_xml(&defs, &gear, &[]).contains("<Item id=\"501\">"));
    }
}
