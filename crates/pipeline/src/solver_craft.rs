//! Gear crafting rules: what a crafted top-tier item may hold and which
//! families it can draw from. `CraftRules::legal` is the one legality check (`addable` calls it); `wanted`,
//! `implicit_fams` and `check_influences` decide what `base_info_craft` puts in a base. Nothing here is a game rule
//! that is not in the engine data or upstream's Lua; the sources are named per rule.

use super::*;
use pom_item::modpool::PoolMod;
use std::collections::{BTreeMap, BTreeSet};

/// Crafted items are item level 86 (a level 85 character still gets the ilvl 86 tiers; the 80% requirement still gates).
pub(super) const CRAFT_ILVL: u32 = 86;
const ELDRITCH_TYPES: [&str; 4] = ["Helmet", "Body Armour", "Gloves", "Boots"];
/// The bench meta craft that lets the item hold 3 crafted modifiers.
const MULTIMOD: &str = "ItemGenerationCanHaveMultipleCraftedMods";

pub(crate) struct CraftRules;

impl CraftRules {
    /// Whether `mods` as a whole is a legal item: every family joins the others under `legal`. The multimod craft goes
    /// first so the crafts it pays for are not refused for coming before it.
    pub(crate) fn item_legal(base: &BaseInfo, mods: &[usize]) -> bool {
        let mut order: Vec<usize> = mods.to_vec();
        order.sort_by_key(|&f| base.fams.get(f).is_none_or(|x| x.group != MULTIMOD));
        let mut held = Vec::new();
        order.into_iter().all(|f| {
            let ok = f < base.fams.len() && Self::legal(base, &held, f);
            held.push(f);
            ok
        })
    }

    /// Whether family `f` can join `mods` on `base` and leave the item legal in game.
    pub(crate) fn legal(base: &BaseInfo, mods: &[usize], f: usize) -> bool {
        let fam = &base.fams[f];
        if mods.contains(&f) {
            return false;
        }
        let held = || mods.iter().map(|&m| &base.fams[m]);
        let count = |src: &str| held().filter(|m| m.source == src).count();
        // One modifier per group among the explicits (prefix, suffix, crafted, veiled), an elevated (Maven) mod counting as
        // its base mod's group (upstream ItemsTab.lua 2218-2249, bench 3613-3624). Implicits may share a group with an explicit
        // (a belt's life implicit with a life prefix); corrupted implicits only cannot repeat a group among themselves
        // (3190-3215).
        if !fam.implicit && held().any(|m| !m.implicit && same_group(m, fam)) {
            return false;
        }
        if fam.source == "corrupted" && held().any(|m| m.source == "corrupted" && m.group == fam.group) {
            return false;
        }
        // Corrupting wipes every implicit, the eldritch ones too (ItemsTab.lua 3324).
        if (fam.source == "corrupted" && held().any(|m| matches!(m.source, "exarch" | "eater"))) || (matches!(fam.source, "exarch" | "eater") && count("corrupted") > 0) {
            return false;
        }
        if !fam.implicit {
            let n = held().filter(|m| !m.implicit && m.prefix == fam.prefix).count();
            if n >= if fam.prefix { base.prefix_limit } else { base.suffix_limit } {
                return false;
            }
        }
        // At most two influences on the item, from the base's own set.
        let mut set: BTreeSet<&str> = held().filter_map(|m| m.influence.as_deref()).collect();
        if let Some(i) = fam.influence.as_deref() {
            set.insert(i);
        }
        if set.len() > 2 {
            return false;
        }
        let eldritch = |s: &str| matches!(s, "exarch" | "eater");
        match fam.source {
            "influence" | "elevated" => {
                let Some(i) = fam.influence.as_deref() else { return false };
                // Eldritch and conqueror/Shaper/Elder influence exclude each other (upstream ItemsTab.lua 1919-1930).
                if !base.influences.iter().any(|x| x == i) || held().any(|m| eldritch(m.source)) {
                    return false;
                }
                if fam.source == "elevated" && !base.perfect {
                    return false;
                }
            }
            // Meta crafts other than the multimod have no stats and are never offered.
            "bench" => {
                if fam.group != MULTIMOD {
                    let crafts = held().filter(|m| m.source == "bench" && m.group != MULTIMOD).count();
                    // The multimod counts as one of its own three, so two more crafts fit.
                    let cap = if held().any(|m| m.group == MULTIMOD) { 2 } else { 1 };
                    if crafts >= cap {
                        return false;
                    }
                }
            }
            // Essences and fossils both reforge the whole item: an essence mod and a Delve mod never share one.
            "delve" => {
                if count("essence") > 0 {
                    return false;
                }
            }
            "essence" => {
                if count("essence") > 0 || count("delve") > 0 {
                    return false;
                }
            }
            // One lab enchant per item (the anoint is a separate line, not a family).
            "enchant" => {
                if count("enchant") > 0 {
                    return false;
                }
            }
            "veiled" => {
                if count("veiled") > 0 {
                    return false;
                }
            }
            "exarch" | "eater" => {
                // Helmet, body armour, gloves, boots only; never on an influenced item; one Exarch and one Eater.
                if !ELDRITCH_TYPES.contains(&base.item_type.as_str()) || !base.influences.is_empty() || count(fam.source) > 0 || held().any(|m| m.influence.is_some()) {
                    return false;
                }
            }
            "corrupted" => {
                // Double corruption only with perfect rolls (upstream's default is 2).
                // (and the goal's wealth: `corrupt_cap`)
                if count("corrupted") >= base.corrupt_cap {
                    return false;
                }
            }
            _ => {}
        }
        true
    }
}

/// Whether two explicits compete in one mod group: an elevated mod's group is its base mod's with "Maven"/"MavenOld" taken
/// off, with or without "Uber"; a normal mod's group is its own.
fn same_group(a: &Fam, b: &Fam) -> bool {
    a.keys.iter().any(|k| b.keys.contains(k))
}

/// The influences the base can carry, as its `influenceTags` keys. The tags also list `cleansing` and `tangle` (Exarch and
/// Eater): those are the eldritch implicits, handled apart.
pub(super) fn base_influences(base: &str) -> Result<Vec<String>, String> {
    let mut v = pom_item::modpool::base_influences(pom_calc::data::game_data(), base)?;
    v.retain(|k| !matches!(k.as_str(), "cleansing" | "tangle"));
    v.sort();
    Ok(v)
}

/// The base's own influences, at most two, normalised to the keys of its `influenceTags`.
pub(super) fn check_influences(base: &str, influences: &[String]) -> Result<Vec<String>, String> {
    let own = base_influences(base)?;
    let mut v: Vec<String> = Vec::new();
    for i in influences {
        let k = i.to_lowercase();
        let k = match k.as_str() {
            "warlord" => "adjudicator",
            "hunter" => "basilisk",
            "redeemer" => "eyrie",
            x => x,
        }
        .to_string();
        if !own.contains(&k) {
            return Err(format!("{base} cannot carry the {i} influence"));
        }
        if !v.contains(&k) {
            v.push(k);
        }
    }
    if v.len() > 2 {
        return Err(format!("an item has at most 2 influences, not {}", v.len()));
    }
    v.sort();
    Ok(v)
}

/// The modifier ladders `base_info_impl` collapses to one family each. `craft`: top mode.
pub(super) fn wanted(m: &PoolMod, char_level: u32, perfect: bool, craft: bool) -> bool {
    if m.req_level > char_level {
        return false;
    }
    match m.source {
        "normal" => m.weight > 0.0,
        _ if !craft => false,
        "influence" => m.weight > 0.0 && m.influence.is_some(),
        "elevated" => perfect && m.influence.is_some(),
        "delve" | "veiled" => m.weight > 0.0,
        // Bench: stat crafts and the multimod; "Prefixes Cannot Be Changed" and the like say nothing the engine uses.
        "bench" => m.group == MULTIMOD || !m.group.starts_with("ItemGeneration"),
        "essence" => true,
        _ => false,
    }
}

/// Normal families keep today's key; every other source gets its own family.
pub(super) fn fam_key(prefix: bool, m: &PoolMod, text: &str) -> String {
    let p = if prefix { "P" } else { "S" };
    if m.source == "normal" {
        format!("{p}|{}|{text}", m.group)
    } else {
        format!("{p}|{}|{text}|{}", m.group, m.source)
    }
}

/// Lines of a family: perfect = top of the best tier; typical = middle of the span from the tier below.
pub(super) fn roll(best: &[String], second: Option<&[String]>, perfect: bool) -> Vec<String> {
    if perfect {
        best.iter().map(|l| max_roll(l)).collect()
    } else {
        best.iter().enumerate().map(|(i, l)| typical_roll(l, second.and_then(|s| s.get(i)).map(|x| x.as_str()))).collect()
    }
}

/// Eldritch implicits (armour pieces without influence) and corruption implicits. Eldritch: perfect = tier 1 of 6,
/// typical = tier 2, else the best the character level allows. They are added to the base's implicit, not replacing
/// it (upstream AddImplicitPopup.lua `applyCandidateMod`: only an implicit of the same eldritch type is replaced).
pub(super) fn implicit_fams(pool: &pom_item::modpool::ModPool, char_level: u32, perfect: bool, influences: &[String], eldritch_floor: u8) -> Vec<Fam> {
    let mk = |m: &PoolMod, key: String, lines: Vec<String>| Fam { key, keys: group_pair(&m.group, m.source), group: m.group.clone(), prefix: false, lines, req: m.req_level, source: m.source, influence: None, implicit: true, tags: m.tags.clone(), local: is_local(m), tier: m.tier, tries: 1.0, lower: Vec::new() };
    let mut out = Vec::new();
    if influences.is_empty() && ELDRITCH_TYPES.contains(&pool.base_type.as_str()) {
        let mut by: BTreeMap<(&str, &str), Vec<&PoolMod>> = BTreeMap::new();
        for m in pool.implicits.iter().filter(|m| matches!(m.source, "exarch" | "eater") && m.req_level <= char_level && !m.stats.is_empty()) {
            by.entry((m.source, m.group.as_str())).or_default().push(m);
        }
        let floor = eldritch_floor as u32;
        let want = (if perfect { 1 } else { 2 }).max(floor);
        for ((src, group), ms) in by {
            let Some(m) = ms.iter().find(|m| m.tier == want).or_else(|| ms.iter().filter(|m| m.tier >= floor).min_by_key(|m| m.tier)) else { continue };
            let texts: Vec<String> = m.stats.iter().map(|s| s.text.clone()).collect();
            // (an Ember or Ichor rolls one implicit of its kind by spawn weight: this one comes up weight / total of the time)
            let total: f64 = pool.implicits.iter().filter(|x| x.source == src && x.tier == m.tier).map(|x| x.weight).sum();
            let tries = if m.weight > 0.0 { (total / m.weight).max(1.0) } else { 1.0 };
            out.push(Fam { tries, ..mk(m, format!("I|{src}|{group}"), roll(&texts, None, perfect)) });
        }
    }
    // Corruption implicits: one family per (group, wording), the best level the character can wear.
    let mut best: BTreeMap<(String, String), &PoolMod> = BTreeMap::new();
    for m in pool.corrupted.iter().filter(|m| m.weight > 0.0 && m.req_level <= char_level && !m.stats.is_empty()) {
        let texts: Vec<String> = m.stats.iter().map(|s| s.text.clone()).collect();
        let k = (m.group.clone(), family_text(&texts));
        if best.get(&k).is_none_or(|b| m.level > b.level) {
            best.insert(k, m);
        }
    }
    for ((group, text), m) in best {
        let texts: Vec<String> = m.stats.iter().map(|s| s.text.clone()).collect();
        out.push(mk(m, format!("I|corrupted|{group}|{text}"), roll(&texts, None, perfect)));
    }
    out
}

/// The influence lines of an item's text: its influence set, plus Exarch / Eater for eldritch implicits.
pub(super) fn influence_lines(influences: &[String], fams: &[&Fam]) -> Vec<&'static str> {
    let mut v: Vec<&'static str> = influences
        .iter()
        .filter_map(|i| {
            Some(match i.as_str() {
                "shaper" => "Shaper Item",
                "elder" => "Elder Item",
                "adjudicator" => "Warlord Item",
                "basilisk" => "Hunter Item",
                "crusader" => "Crusader Item",
                "eyrie" => "Redeemer Item",
                _ => return None,
            })
        })
        .collect();
    if fams.iter().any(|f| f.source == "exarch") {
        v.push("Searing Exarch Item");
    }
    if fams.iter().any(|f| f.source == "eater") {
        v.push("Eater of Worlds Item");
    }
    v
}

/// Flags in front of a line: crafted (bench, enchant), exarch, eater; with a catalyst also the mod's tags and prefix /
/// suffix, which upstream's catalyst scalar reads from the line.
pub(in crate::solver) fn line_flags(f: &Fam, catalyst: bool) -> String {
    let mut s = String::new();
    if catalyst && !f.tags.is_empty() {
        s.push_str(&format!("{{tags:{}}}", f.tags.join(",")));
        if !f.implicit {
            s.push_str(if f.prefix { "{prefix}" } else { "{suffix}" });
        }
    }
    s.push_str(match f.source {
        "bench" => "{crafted}",
        "enchant" => "{crafted}{enchant}",
        "exarch" => "{exarch}",
        "eater" => "{eater}",
        _ => "",
    });
    s
}

/// (catalyst, the tags it scales) in upstream's `catalystList` / `catalystTags` order (Item.lua 14-29).
const CATALYSTS: [(&str, &[&str]); 12] = [
    ("Abrasive", &["attack"]),
    ("Accelerating", &["speed"]),
    ("Dextral", &["suffix"]),
    ("Fertile", &["life", "mana", "resource"]),
    ("Imbued", &["caster"]),
    ("Intrinsic", &["jewellery_attribute", "attribute"]),
    ("Noxious", &["physical_damage", "chaos_damage"]),
    ("Prismatic", &["jewellery_resistance", "resistance"]),
    ("Sinistral", &["prefix"]),
    ("Tempering", &["jewellery_defense", "defences", "armour", "evasion", "energyshield"]),
    ("Turbulent", &["jewellery_elemental", "elemental_damage"]),
    ("Unstable", &["critical"]),
];

/// The catalyst that scales the most lines of an amulet, ring or belt (upstream offers them on these three only).
pub(super) fn pick_catalyst(item_type: &str, fams: &[&Fam]) -> Option<&'static str> {
    if !matches!(item_type, "Amulet" | "Ring" | "Belt") {
        return None;
    }
    // (a line whose numbers are all below 5 reads the same after 20% quality: "+1 to Minimum Frenzy Charges")
    let raised = |l: &String| l.split(|c: char| !c.is_ascii_digit()).filter_map(|x| x.parse::<u32>().ok()).any(|n| n >= 5);
    let score = |tags: &[&str]| -> usize { fams.iter().filter(|f| scales(tags, f)).map(|f| f.lines.iter().filter(|l| raised(l)).count()).sum() };
    // (on a tie the catalyst named for the lines' kind, not Sinistral / Dextral for their affix side)
    let generic = |n: &str| matches!(n, "Sinistral" | "Dextral");
    let (name, n) = CATALYSTS.iter().map(|(n, t)| (*n, score(t))).fold(("", 0), |b, c| if c.1 > b.1 || (c.1 == b.1 && c.1 > 0 && generic(b.0) && !generic(c.0)) { c } else { b });
    (n > 0).then_some(name)
}

// ---------------------------------------------------------------------------------------------------------------
// Special uniques. Their power is a choice of mods, so the solver writes the item per build.

/// The uniques of the `generated` group the solver makes itself.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Special {
    WatchersEye,
    ForbiddenFlame,
    ForbiddenFlesh,
    ImpossibleEscape,
    Megalomaniac,
}

impl Special {
    pub(super) fn of(name: &str) -> Option<Special> {
        Some(match name {
            "Watcher's Eye" => Special::WatchersEye,
            "Forbidden Flame" => Special::ForbiddenFlame,
            "Forbidden Flesh" => Special::ForbiddenFlesh,
            "Impossible Escape" => Special::ImpossibleEscape,
            "Megalomaniac" => Special::Megalomaniac,
            _ => return None,
        })
    }
}

/// A unique with more current variants than this keeps its default one (Aul's Uprising, 17 variants, is not 17 trials).
const MAX_VARIANTS: usize = 8;

fn variant_names(raw: &str) -> Vec<&str> {
    raw.lines().filter_map(|l| l.strip_prefix("Variant: ")).collect()
}

/// The raw text of a `generated` unique (without the "Rarity" line some of them start with).
fn generated_raw(name: &str) -> Option<String> {
    let all = pom_calc::data::game_data().extra.get("uniques").ok().flatten()?;
    let list = all.get("generated")?.as_array()?;
    list.iter().filter_map(|r| r.as_str()).map(|r| r.strip_prefix("Rarity: UNIQUE\n").unwrap_or(r)).find(|r| r.lines().next() == Some(name)).map(|r| r.to_string())
}

/// `raw` with variant `n` (1-based) selected: the "Selected Variant" line goes after the last "Variant:" line, where upstream's
/// own export puts it, before any modifier line.
pub(super) fn select_variant(raw: &str, n: usize) -> String {
    let mut lines: Vec<&str> = raw.lines().filter(|l| !l.starts_with("Selected Variant:")).collect();
    let at = lines.iter().rposition(|l| l.starts_with("Variant: ")).map(|i| i + 1).unwrap_or(lines.len());
    let sel = format!("Selected Variant: {n}");
    lines.insert(at, &sel);
    lines.join("\n")
}

/// A generated unique that has a per-skill alt variant list, written for `skill` (a transfigured gem uses its base
/// skill's entry): leading tabs removed, `Selected Alt Variant` set to the skill's variant. None: no such variant.
pub(super) fn skill_variant(raw: &str, skill: &str) -> Option<String> {
    let names: Vec<&str> = raw.lines().filter_map(|l| l.trim_start_matches('\t').strip_prefix("Variant: ")).collect();
    let n = names.iter().position(|v| *v == skill || skill.starts_with(&format!("{v} of ")))? + 1;
    let mut lines: Vec<String> = raw.lines().map(|l| l.trim_start_matches('\t').trim_end().to_string()).filter(|l| !l.is_empty() && !l.starts_with("Selected Alt Variant:")).collect();
    let at = lines.iter().position(|l| l.starts_with("Has Alt Variant:"))? + 1;
    lines.insert(at, format!("Selected Alt Variant: {n}"));
    Some(lines.join("\n"))
}

/// The variants of a unique worth trying as (1-based index, name): not an old patch's or a test entry, and only for
/// uniques with one variant list (upstream's alt variants are further lists) and at most `MAX_VARIANTS` of them. The item's
/// own default (its last variant, or the one it names) is the plain entry, so it is left out here.
pub(super) fn variants_to_try(raw: &str) -> Vec<(usize, String)> {
    if raw.contains("Has Alt Variant") {
        return Vec::new();
    }
    let names = variant_names(raw);
    let keep: Vec<(usize, String)> = names.iter().enumerate().filter(|(_, n)| !["Pre ", "Legacy", "Test", "Removed"].iter().any(|w| n.contains(w))).map(|(i, n)| (i + 1, n.to_string())).collect();
    if keep.len() > MAX_VARIANTS {
        return Vec::new();
    }
    let default = if raw.lines().any(|l| l.starts_with("Selected Variant:")) { None } else { Some(names.len()) };
    keep.into_iter().filter(|(n, _)| Some(*n) != default).collect()
}

/// A Watcher's Eye modifier: its lines as the table writes them.
pub(super) struct EyeMod {
    pub group: String,
    pub lines: Vec<String>,
}

/// The `WatchersEye` table's modifiers that name one of `auras` ("... while affected by Hatred", "... while using
/// Pride"), one per group.
pub(super) fn eye_mods(auras: &[String]) -> Vec<EyeMod> {
    let mut out: Vec<EyeMod> = Vec::new();
    let Some(table) = pom_calc::data::game_data().extra.get("itemMods").ok().flatten().and_then(|m| m.get("WatchersEye")).and_then(|t| t.as_object()) else { return out };
    for (_, e) in table.iter() {
        let lines: Vec<String> = ["1", "2", "3", "4"].iter().filter_map(|k| e.get(*k).and_then(|l| l.as_str())).map(|l| l.to_string()).collect();
        let group = e.get("group").and_then(|g| g.as_str()).unwrap_or("").to_string();
        let text = lines.join(" ");
        if !lines.is_empty() && auras.iter().any(|a| text.contains(&format!("affected by {a}")) || text.contains(&format!("using {a}"))) && !out.iter().any(|m| m.group == group) {
            out.push(EyeMod { group, lines });
        }
    }
    out
}

/// A Watcher's Eye carrying `mods`: the unique's header and its always-on lines, then the chosen modifiers.
pub(super) fn eye_text(mods: &[&EyeMod], perfect: bool) -> String {
    let raw = generated_raw("Watcher's Eye").unwrap_or_default();
    let mut t = String::from("Watcher's Eye\nPrismatic Jewel\nLimited to: 1\n");
    let always = raw.lines().filter(|l| !l.is_empty() && !l.contains(':') && !l.starts_with('{') && !l.starts_with("Variant") && *l != "Watcher's Eye" && *l != "Prismatic Jewel");
    for l in always.chain(mods.iter().flat_map(|m| m.lines.iter().map(|l| l.as_str()))) {
        t.push_str(&roll(&[l.to_string()], None, perfect)[0]);
        t.push('\n');
    }
    t
}

/// A Megalomaniac listing the notables at 1-based `picks` (up to three), as upstream writes it: the variant list, the three
/// selections (a missing one repeats the first, so it lists no extra notable) and the chosen "Added Passive Skill" lines.
pub(super) fn megalomaniac_text(raw: &str, picks: &[usize]) -> String {
    let sel = |i: usize| picks.get(i).or(picks.first()).copied().unwrap_or(1);
    let mut out: Vec<String> = Vec::new();
    for l in raw.lines().filter(|l| !l.starts_with("Selected ")) {
        match l.strip_prefix("{variant:").and_then(|x| x.split_once('}')) {
            Some((n, _)) if !picks.iter().any(|p| n.parse::<usize>() == Ok(*p)) => continue,
            _ => out.push(l.to_string()),
        }
    }
    let at = out.iter().rposition(|l| l.starts_with("Variant: ")).map(|i| i + 1).unwrap_or(out.len());
    out.splice(at..at, [format!("Selected Variant: {}", sel(0)), format!("Selected Alt Variant: {}", sel(1)), format!("Selected Alt Variant Two: {}", sel(2))]);
    out.join("\n")
}

/// The class's Forbidden Flame/Flesh variants as (index, ascendancy notable): "(Duelist) Bane of Legends".
pub(super) fn forbidden_variants(raw: &str, class: &str) -> Vec<(usize, String)> {
    let pre = format!("({class}) ");
    variant_names(raw).iter().enumerate().filter_map(|(i, n)| n.strip_prefix(pre.as_str()).map(|x| (i + 1, x.to_string()))).collect()
}

impl Solver {
    /// The auras the setup runs (a Vaal aura counts as its plain one).
    fn active_aura_names(&self, st: &State) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for id in st.main.iter().chain(st.utils.iter()).flat_map(|id| id.split('+')) {
            if let Some(g) = self.gems.iter().find(|g| g.id == id && g.kind == Kind::Aura) {
                let n = g.name.strip_prefix("Vaal ").unwrap_or(&g.name).to_string();
                if !out.contains(&n) {
                    out.push(n);
                }
            }
        }
        out
    }

    /// Allocated tree sockets that hold no kept, cluster or other unique jewel (nor one of `again`, which may be redone).
    fn open_sockets(&self, st: &State, again: &[&str]) -> Vec<i64> {
        self.tree_sockets.iter().copied().filter(|s| st.nodes.contains(s) && !st.gear.sockets.iter().any(|x| x.node == *s && !x.is_design() && !x.unique.as_deref().is_some_and(|u| again.contains(&u)))).collect()
    }

    /// `st` with these jewels in these sockets: (node, item text, label, unique name).
    fn with_special(&self, st: &State, put: &[(i64, String, String, &str, usize)]) -> State {
        let mut n = st.clone();
        let mut g = (*st.gear).clone();
        for (node, text, label, name, mods) in put {
            g.sockets.retain(|x| x.node != *node);
            g.sockets.push(SocketItem { node: *node, xml: Arc::new(crate::edit::esc_text(&format!("Rarity: UNIQUE\n{text}"))), label: label.clone(), kept: false, nodes: Vec::new(), unique: Some(name.to_string()), subs: Vec::new(), cost: self.made_cost(name, *mods) });
        }
        n.gear = Arc::new(g);
        n
    }

    /// The best of `states` when it beats `st`.
    fn better_of(&self, st: &State, states: Vec<State>) -> Result<Option<(usize, State)>, String> {
        if states.is_empty() || self.stop() {
            return Ok(None);
        }
        let r = self.eval_states(states)?;
        Ok(r.into_iter().enumerate().filter_map(|(k, s)| s.map(|s| (k, s))).max_by(|a, b| a.1.score.partial_cmp(&b.1.score).unwrap_or(std::cmp::Ordering::Equal)).filter(|(_, s)| s.score > st.score + EPS))
    }

    /// Watcher's Eye (modifiers for the setup's auras, added one at a time while each helps, up to three), a Forbidden
    /// Flame + Flesh pair that grants one of the class's ascendancy notables, and Impossible Escape for a keystone the
    /// build has. Each takes open allocated tree sockets.
    pub(super) fn special_jewel_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let has = |sp: Special| self.uniques.iter().any(|u| u.special == Some(sp));
        let (eye, pair, escape, mega) = (has(Special::WatchersEye), has(Special::ForbiddenFlame) && has(Special::ForbiddenFlesh), has(Special::ImpossibleEscape), has(Special::Megalomaniac));
        if !(eye || pair || escape || mega) || self.stop() {
            return Ok(false);
        }
        let mut improved = false;
        if eye {
            improved |= self.eye_pass(st)?;
        }
        if pair && !st.gear.has_unique("Forbidden Flame") && !st.gear.has_unique("Forbidden Flesh") {
            let class = self.ctx[st.class].class_name.clone();
            let socks = self.open_sockets(st, &[]);
            if let (Some(flame), Some(flesh), [a, b, ..]) = (generated_raw("Forbidden Flame"), generated_raw("Forbidden Flesh"), socks.as_slice()) {
                let vs = forbidden_variants(&flame, &class);
                let states = vs.iter().map(|(n, notable)| self.with_special(st, &[(*a, select_variant(&flame, *n), format!("Forbidden Flame [{notable}] (unique)"), "Forbidden Flame", 1), (*b, select_variant(&flesh, *n), format!("Forbidden Flesh [{notable}] (unique)"), "Forbidden Flesh", 1)])).collect();
                self.layer = "items: Forbidden Flame and Flesh".into();
                if let Some((_, b)) = self.better_of(st, states)? {
                    *st = b;
                    self.publish();
                    improved = true;
                }
            }
        }
        if escape && !st.gear.has_unique("Impossible Escape") {
            let socks = self.open_sockets(st, &[]);
            let ver = tag_attr(&self.ctx[st.class].xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into());
            if let (Some(raw), Some(&a), Ok(tree)) = (generated_raw("Impossible Escape"), socks.first(), crate::cached_tree(&ver)) {
                // Shortcut: the keystones the build has; upstream only frees the nodes around the keystone from the connection rule, so
                // this scores only once the tree layer allocates unconnected nodes. Upgrade then to the keystones in reach.
                let held: Vec<&str> = st.nodes.iter().filter_map(|id| tree.nodes.get(id)).filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("Keystone")).filter_map(|n| n.get("dn").and_then(|d| d.as_str())).collect();
                let names = variant_names(&raw);
                let states: Vec<State> = names.iter().enumerate().filter(|(_, n)| held.contains(n)).map(|(i, n)| self.with_special(st, &[(a, select_variant(&raw, i + 1), format!("Impossible Escape [{n}] (unique)"), "Impossible Escape", 1)])).collect();
                self.layer = "items: Impossible Escape".into();
                if let Some((_, b)) = self.better_of(st, states)? {
                    *st = b;
                    self.publish();
                    improved = true;
                }
            }
        }
        if mega {
            improved |= self.megalomaniac_pass(st)?;
        }
        Ok(improved)
    }

    /// The Megalomaniac `picks` (1-based variant numbers) would put in socket `sub`, with the passives it adds.
    fn mega_state(&self, base: &State, raw: &str, sub: i64, picks: &[usize], ids: Vec<i64>) -> State {
        let names = variant_names(raw);
        let label = format!("Megalomaniac [{}] (unique)", picks.iter().map(|&p| names[p - 1]).collect::<Vec<_>>().join(", "));
        let mut n = base.clone();
        let mut g = (*base.gear).clone();
        g.sockets.push(SocketItem { node: sub, xml: Arc::new(crate::edit::esc_text(&format!("Rarity: UNIQUE\n{}", megalomaniac_text(raw, picks)))), label, kept: false, nodes: ids, unique: Some("Megalomaniac".into()), subs: Vec::new(), cost: self.made_cost("Megalomaniac", picks.len()) });
        n.gear = Arc::new(g);
        n
    }

    /// Megalomaniac in a medium socket of the solver's large cluster jewel (a free one, or one a rare medium jewel holds):
    /// 3 notables, each the best of the pool for the fit given the ones already chosen (the pool is the first step's top
    /// `POOL`, so the greedy rounds stay small). Kept when the goal scores higher.
    // shortcut: the first usable socket only, not one trial per socket; upgrade when builds show a second socket wins.
    fn megalomaniac_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let Some(cand) = self.megalomaniac_candidate(st)? else { return Ok(false) };
        let Some((_, b)) = self.better_of(st, vec![cand])? else { return Ok(false) };
        *st = b;
        self.publish();
        Ok(true)
    }

    /// The Megalomaniac `megalomaniac_pass` would try (3 notables), before it is scored against `st`.
    fn megalomaniac_candidate(&mut self, st: &State) -> Result<Option<State>, String> {
        const POOL: usize = 12;
        let Some(raw) = generated_raw("Megalomaniac") else { return Ok(None) };
        let Some(li) = st.gear.sockets.iter().position(|s| !s.kept && !s.subs.is_empty()) else { return Ok(None) };
        let (large, subs) = (st.gear.sockets[li].node, st.gear.sockets[li].subs.clone());
        let Some(sub) = subs.iter().copied().find(|&k| !st.gear.sockets.iter().any(|x| x.node == k && (x.kept || x.unique.as_deref().is_some_and(|u| u != "Megalomaniac")))) else { return Ok(None) };
        // The socket freed of what it holds, with room for the jewel's four passives and the socket (one point).
        let mut free = st.clone();
        let mut g = (*free.gear).clone();
        g.sockets.retain(|x| x.node != sub);
        free.gear = Arc::new(g);
        let Some(mut base) = self.free_points(&free, 5) else { return Ok(None) };
        if !base.nodes.contains(&large) || self.stop() {
            return Ok(None);
        }
        let mut g = (*base.gear).clone();
        let Some(lk) = g.sockets.iter().position(|s| s.node == large) else { return Ok(None) };
        if !g.sockets[lk].nodes.contains(&sub) {
            g.sockets[lk].nodes.push(sub);
        }
        base.gear = Arc::new(g);
        // The passives' ids depend on how many notables the jewel lists.
        let mut ids_by: Vec<Vec<i64>> = vec![Vec::new()];
        for k in 1..=3usize {
            let xml = crate::edit::esc_text(&format!("Rarity: UNIQUE\n{}", megalomaniac_text(&raw, &(1..=k).collect::<Vec<_>>())));
            let probe = Piece { item_type: "Jewel".into(), two_hand: false, design: Design::Unique("Megalomaniac".into()), xml: Arc::new(xml), label: String::new() };
            ids_by.push(self.cluster_node_ids(&base, sub, "Medium Cluster Jewel", k, &probe)?.0);
        }
        if ids_by[3].is_empty() {
            return Ok(None);
        }
        self.layer = "items: Megalomaniac".into();
        // Step 1: every notable alone; its top few are the pool for the other two.
        let all: Vec<Vec<usize>> = (1..=variant_names(&raw).len()).map(|n| vec![n]).collect();
        let r = self.eval_states(all.iter().map(|p| self.mega_state(&base, &raw, sub, p, ids_by[1].clone())).collect())?;
        let mut ranked: Vec<(f64, usize)> = r.iter().enumerate().filter_map(|(i, s)| s.as_ref().map(|s| (s.score, i + 1))).collect();
        ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let pool: Vec<usize> = ranked.iter().take(POOL).map(|x| x.1).collect();
        let Some(&first) = pool.first() else { return Ok(None) };
        let mut picks = vec![first];
        while picks.len() < 3 && !self.stop() {
            let cands: Vec<Vec<usize>> = pool.iter().filter(|p| !picks.contains(p)).map(|&p| picks.iter().copied().chain(std::iter::once(p)).collect()).collect();
            let r = self.eval_states(cands.iter().map(|p| self.mega_state(&base, &raw, sub, p, ids_by[p.len()].clone())).collect())?;
            let Some((i, _)) = r.iter().enumerate().filter_map(|(i, s)| s.as_ref().map(|s| (i, s.score))).max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)) else { break };
            picks = cands[i].clone();
        }
        if picks.len() < 3 {
            return Ok(None);
        }
        Ok(Some(self.mega_state(&base, &raw, sub, &picks, ids_by[3].clone())))
    }

    fn eye_pass(&mut self, st: &mut State) -> Result<bool, String> {
        let mods = eye_mods(&self.active_aura_names(st));
        let Some(&sock) = self.open_sockets(st, &["Watcher's Eye"]).iter().min_by_key(|s| !st.gear.sockets.iter().any(|x| x.node == **s && x.unique.is_some())) else { return Ok(false) };
        let perfect = self.goal.rolls == Rolls::Perfect;
        let mut picked: Vec<usize> = Vec::new();
        let mut best: Option<State> = None;
        for _ in 0..3 {
            let cur = best.as_ref().unwrap_or(st);
            let ks: Vec<usize> = (0..mods.len()).filter(|k| !picked.contains(k)).collect();
            let states: Vec<State> = ks
                .iter()
                .map(|&k| {
                    let m: Vec<&EyeMod> = picked.iter().chain(std::iter::once(&k)).map(|&i| &mods[i]).collect();
                    let label = format!("Watcher's Eye (unique): {}", m.iter().map(|m| m.lines.join(", ")).collect::<Vec<_>>().join("; "));
                    self.with_special(cur, &[(sock, eye_text(&m, perfect), label, "Watcher's Eye", m.len())])
                })
                .collect();
            self.layer = "items: Watcher's Eye".into();
            let Some((k, s)) = self.better_of(cur, states)? else { break };
            picked.push(ks[k]);
            best = Some(s);
        }
        let Some(b) = best else { return Ok(false) };
        *st = b;
        self.publish();
        Ok(true)
    }
}

/// Whether catalyst `tags` scale family `f` (upstream `catalystTags`: a tag match, or the affix side for Sinistral / Dextral).
fn scales(tags: &[&str], f: &Fam) -> bool {
    !f.tags.is_empty() && (f.tags.iter().any(|t| tags.contains(&t.as_str())) || (!f.implicit && tags.contains(if f.prefix { &"prefix" } else { &"suffix" })))
}

// ===============================================================================================================
// Crafting a slot to a plan. Every global line is valued by one probe at the state
// (shared by all slots); local lines by real item evaluations. Each slot then gets, per legal influence set, the best
// affixes, implicits, enchant, catalyst and corruption by value; its top 3 items are evaluated for real.

/// A modifier that acts only on its own item: `Local*` ids (weapon damage, armour defences) and socketed-gem lines.
pub(super) fn is_local(m: &PoolMod) -> bool {
    m.id.contains("Local") || m.stats.iter().any(|s| s.text.contains("Socketed"))
}

/// The catalyst a planned catalyst family stands for.
pub(in crate::solver) fn catalyst_of(f: &Fam) -> Option<&'static str> {
    let n = f.key.strip_prefix("C|").filter(|_| f.source == "catalyst")?;
    CATALYSTS.iter().map(|c| c.0).find(|c| *c == n)
}

/// What a plan is valued against.
#[derive(Default, Clone)]
pub(super) struct PlanCtx {
    /// Lines added to every evaluation of the plan: a committed package (a primed state). Nothing is kept when set.
    pub prime: Vec<String>,
    /// Lead axes (`AXES` indexes) whose families are always re-probed; empty: the state's convex axes.
    pub lead: Vec<usize>,
    /// Plan only: take nothing and write no ranks (implied by `prime`).
    pub dry: bool,
}

/// One planned item of a slot: its value by probes and, for the top 3, its real score.
pub(super) struct Planned {
    pub base: Arc<BaseInfo>,
    pub mods: Vec<usize>,
    pub value: f64,
    /// Each family's value on `base` (probe gain, or real gain for local lines).
    #[allow(dead_code)]
    pub vals: Vec<f64>,
    pub scored: Option<Scored>,
}

#[derive(Default, Debug)]
pub(super) struct PlanStats {
    pub probes: usize,
    pub real: usize,
    pub ms: f64,
}

const REPROBE: usize = 40;

/// The engine's modifier names for a line (what a probe of it changes).
fn mod_names(line: &str) -> Vec<String> {
    pom_engine::modparser::parse_mod(line).0.map(|v| v.into_iter().map(|m| m.name).collect()).unwrap_or_default()
}

/// Families of `fams` that a lead axis commits to: those whose lines set the axis's modifiers, plus every family whose
/// data tags hold all the tags those share (crit multiplier -> `critical` + `damage`).
fn lead_fams(lead: &[usize], fams: &[&Fam]) -> HashSet<String> {
    let mut out = HashSet::default();
    for &a in lead {
        let want: HashSet<String> = sens::AXES[a].unit.iter().flat_map(|l| mod_names(l)).collect();
        let hit: Vec<&&Fam> = fams.iter().filter(|f| f.lines.iter().any(|l| mod_names(l).iter().any(|n| want.contains(n)))).collect();
        let Some(first) = hit.first() else { continue };
        let common: Vec<&String> = first.tags.iter().filter(|t| hit.iter().all(|f| f.tags.contains(t))).collect();
        for f in fams {
            if hit.iter().any(|h| h.key == f.key) || (!common.is_empty() && common.iter().all(|t| f.tags.contains(t))) {
                out.insert(f.lines.join("\n"));
            }
        }
    }
    out
}

/// Greedy fill by value under `CraftRules`, then one-swap improvements, then the catalyst that adds most (20% quality
/// scales its lines by 20%). Returns the families and the item's value.
fn fill_by_value(b: &BaseInfo, val: &[f64]) -> (Vec<usize>, f64) {
    let plain = fill_from(b, val, Vec::new());
    // The multimod bench craft is worth nothing alone: it is valued by the crafted lines it lets the item hold.
    let Some(mm) = (0..b.fams.len()).find(|&f| b.fams[f].group == MULTIMOD && CraftRules::legal(b, &[], f)) else { return plain };
    let multi = fill_from(b, val, vec![mm]);
    if multi.1 > plain.1 {
        multi
    } else {
        plain
    }
}

/// `fill_by_value` from the families in `seed`, which stay.
fn fill_from(b: &BaseInfo, val: &[f64], seed: Vec<usize>) -> (Vec<usize>, f64) {
    let kept = seed.len();
    let mut order: Vec<usize> = (0..b.fams.len()).filter(|&f| val[f] > 0.0 && b.fams[f].source != "catalyst").collect();
    order.sort_by(|&x, &y| val[y].partial_cmp(&val[x]).unwrap_or(std::cmp::Ordering::Equal));
    let mut mods: Vec<usize> = seed;
    let top_up = |mods: &mut Vec<usize>| {
        for &f in &order {
            if CraftRules::legal(b, mods, f) {
                mods.push(f);
            }
        }
    };
    top_up(&mut mods);
    for _ in 0..32 {
        let mut swap = None;
        'find: for j in kept..mods.len() {
            let rest: Vec<usize> = mods.iter().enumerate().filter(|&(k, _)| k != j).map(|(_, &m)| m).collect();
            for &f in order.iter().take_while(|&&f| val[f] > val[mods[j]]) {
                if !mods.contains(&f) && CraftRules::legal(b, &rest, f) {
                    swap = Some((j, f));
                    break 'find;
                }
            }
        }
        let Some((j, f)) = swap else { break };
        mods[j] = f;
        top_up(&mut mods);
    }
    let mut value: f64 = mods.iter().map(|&m| val[m]).sum();
    let held: Vec<&Fam> = mods.iter().map(|&m| &b.fams[m]).collect();
    let cat = (0..b.fams.len())
        .filter_map(|c| {
            let tags = CATALYSTS.iter().find(|x| Some(x.0) == catalyst_of(&b.fams[c]))?.1;
            Some((0.2 * held.iter().zip(&mods).filter(|(f, _)| scales(tags, f)).map(|(_, &m)| val[m]).sum::<f64>(), c))
        })
        .fold((0.0, None), |a, (v, c)| if v > a.0 { (v, Some(c)) } else { a });
    if let (v, Some(c)) = cat {
        mods.push(c);
        value += v;
    }
    (mods, value)
}

impl Solver {
    /// Enchants and catalysts of a top-craft base, and no eldritch "in your Presence" lines unless the goal fights a
    /// pinnacle boss (they need a boss or unique enemy near).
    pub(super) fn craft_extras(&self, b: &mut BaseInfo) -> Result<(), String> {
        if !self.goal.assume.mode().pinnacle() {
            b.fams.retain(|f| !(matches!(f.source, "exarch" | "eater") && f.lines.iter().any(|l| l.contains("in your Presence"))));
        }
        let skill = gd::game_data().gems.get(self.main_gem).and_then(|g| g.name.clone()).unwrap_or_default();
        let all = pom_item::modpool::enchants(pom_calc::data::game_data(), &b.name)?;
        let t = b.item_type.as_str();
        let pick: Vec<&pom_item::modpool::Enchant> = if t == "Helmet" {
            // the main skill's own enchants, top tier (a transfigured gem uses its base skill's)
            let own: Vec<_> = all.iter().filter(|e| e.skill == skill || skill.starts_with(&format!("{} of ", e.skill))).collect();
            let tier = if own.iter().any(|e| e.tier == "ENDGAME") { "ENDGAME" } else { "MERCILESS" };
            own.into_iter().filter(|e| e.tier == tier).collect()
        } else {
            let tiers: &[&str] = match t {
                "Boots" | "Gloves" => &["ENDGAME"],
                "Belt" => &["DEDICATION"],
                "Flask" => &["ENKINDLING", "INSTILLING"],
                _ => &["HARVEST", "HEIST"],
            };
            all.iter().filter(|e| tiers.contains(&e.tier.as_str())).collect()
        };
        let perfect = b.perfect;
        let local = !matches!(t, "Helmet" | "Boots" | "Gloves" | "Belt");
        for e in pick {
            for opt in &e.lines {
                let lines: Vec<String> = opt.split('/').map(|s| s.to_string()).collect();
                b.fams.push(Fam { key: format!("E|{}|{opt}", e.tier), keys: group_pair("Enchant", "enchant"), group: "Enchant".into(), prefix: false, lines: roll(&lines, None, perfect), req: 0, source: "enchant", influence: None, implicit: true, tags: Vec::new(), local, tier: 0, tries: 1.0, lower: Vec::new() });
            }
        }
        if matches!(t, "Amulet" | "Ring" | "Belt") {
            for (n, tags) in CATALYSTS {
                b.fams.push(Fam { key: format!("C|{n}"), keys: group_pair("Catalyst", "catalyst"), group: "Catalyst".into(), prefix: false, lines: Vec::new(), req: 0, source: "catalyst", influence: None, implicit: true, tags: tags.iter().map(|s| s.to_string()).collect(), local: false, tier: 0, tries: 1.0, lower: Vec::new() });
            }
        }
        Ok(())
    }

    /// Whether slot `i` is empty armour or jewellery a plan may fill (bases from `slot_bases`).
    fn plan_empty(&self, st: &State, i: usize) -> bool {
        st.gear.pieces[i].is_none() && matches!(self.slots[i].kind, SlotKind::Weapon1 | SlotKind::Weapon2 | SlotKind::Helmet | SlotKind::Body | SlotKind::Gloves | SlotKind::Boots | SlotKind::Amulet | SlotKind::Ring | SlotKind::Belt)
    }

    /// The craft slots a plan fills: unlocked crafted items (the tree jewel only while a socket is allocated) and empty
    /// armour and jewellery slots.
    fn plan_slots(&self, st: &State) -> Vec<usize> {
        (0..self.slots.len())
            .filter(|&i| !self.slots[i].locked && (self.slots[i].kind != SlotKind::TreeJewel || self.socket_allocated(st)) && (self.plan_empty(st, i) || matches!(st.gear.pieces[i].as_ref().map(|p| &p.design), Some(Design::Craft { .. }))))
            .collect()
    }

    /// The slot's current base (an empty slot: each of its bases) under every legal influence set: none (armour:
    /// eldritch implicits), each one, each pair.
    fn plan_bases(&self, st: &State, i: usize) -> Result<Vec<Arc<BaseInfo>>, String> {
        let names = match st.gear.pieces[i].as_ref().and_then(|p| p.base()) {
            Some(b) => vec![b.name.clone()],
            None if self.plan_empty(st, i) => self.slot_bases(i),
            None => return Ok(Vec::new()),
        };
        let mut out = Vec::new();
        for name in names {
            let own = base_influences(&name)?;
            let mut sets: Vec<Vec<String>> = vec![Vec::new()];
            // (weapons: single influences only, there are many bases)
            let pairs = !matches!(self.slots[i].kind, SlotKind::Weapon1 | SlotKind::Weapon2);
            for (k, a) in own.iter().enumerate() {
                sets.push(vec![a.clone()]);
                for b in own[k + 1..].iter().filter(|_| pairs) {
                    sets.push(vec![a.clone(), b.clone()]);
                }
            }
            let cap = self.goal.wealth.map_or(2, |w| w.max_influences());
            for s in sets.iter().filter(|s| s.len() <= cap) {
                out.push(self.base_craft(&name, s)?);
            }
        }
        Ok(out)
    }

    /// Score of `st` with `prime`, and the gain of each line set over it: one whole-build evaluation each, in chunks.
    /// A batch the budget stops reads as no gain.
    pub(in crate::solver) fn line_gains(&self, st: &State, prime: &[String], sets: &[Vec<String>]) -> Result<(f64, Vec<f64>), String> {
        let text = |extra: &[String]| -> Result<Cand, String> {
            let l: Vec<&str> = prime.iter().chain(extra).map(String::as_str).collect();
            Ok(Cand::Xml(Arc::new(self.render_with_probe(st, &l)?)))
        };
        let base = self.eval(vec![text(&[])?]).pop().flatten().map_or(f64::NAN, |v| self.score(&v).0);
        let mut out = Vec::with_capacity(sets.len());
        for c in sets.chunks(256) {
            let cands = c.iter().map(|s| text(s)).collect::<Result<Vec<_>, _>>()?;
            out.extend(self.eval(cands).iter().map(|v| v.as_ref().map_or(0.0, |v| self.score(v).0 - base)));
        }
        Ok((base, out))
    }

    /// Real scores of slot `i` holding each piece (with `prime` in the config when set).
    fn slot_scores(&self, st: &State, i: usize, pieces: &[Piece], prime: &[String]) -> Result<Vec<Option<(Gear, Scored)>>, String> {
        let mut cands = Vec::new();
        let mut gears = Vec::new();
        for p in pieces {
            let Some(g) = self.with_piece(&st.gear, i, Some(p.clone())) else {
                gears.push(None);
                continue;
            };
            let mut s = st.clone();
            s.gear = Arc::new(g.clone());
            let l: Vec<&str> = prime.iter().map(String::as_str).collect();
            let x = Arc::new(if l.is_empty() { self.render(&s)? } else { self.render_with_probe(&s, &l)? });
            cands.push(Cand::Xml(x.clone()));
            gears.push(Some((g, x)));
        }
        let mut r = self.eval(cands).into_iter();
        Ok(gears
            .into_iter()
            .map(|g| {
                let (g, x) = g?;
                let v = r.next()??;
                let (s, viol) = self.score(&v);
                Some((g, (s, viol, v, x)))
            })
            .collect())
    }

    /// Plans slot `i` against `vals0` (the shared line probes at `st`): re-probes the slot's best and lead lines with
    /// the slot emptied, really evaluates its local lines, fills each influence set by value and really evaluates the
    /// top 3 items. Returns them best first, and each base's family values (the ranks of later quick rounds).
    fn plan_slot(&self, st: &State, i: usize, bases: &[Arc<BaseInfo>], ctx: &PlanCtx, vals0: &HashMap<String, f64>, stats: &mut PlanStats) -> Result<(Vec<Planned>, Vec<(String, Vec<f64>)>), String> {
        // the slot emptied: its base without modifiers (the anoint kept), or nothing for an empty slot
        let mut s0 = st.clone();
        let anoint = match st.gear.pieces[i].as_ref().map(|p| &p.design) {
            Some(Design::Craft { base: cur, anoint, .. }) => {
                let Some(g) = self.with_piece(&st.gear, i, Some(craft_piece(cur, Vec::new(), anoint.clone(), self.item_level))) else { return Ok((Vec::new(), Vec::new())) };
                s0.gear = Arc::new(g);
                anoint.clone()
            }
            None => None,
            _ => return Ok((Vec::new(), Vec::new())),
        };
        let anoint = &anoint;
        let key = |f: &Fam| f.lines.join("\n");
        // every family that can go on the empty item, by its lines (the same lines on two bases are one probe)
        let fams: Vec<(&Arc<BaseInfo>, usize)> = bases.iter().flat_map(|b| (0..b.fams.len()).filter(|&f| !b.fams[f].lines.is_empty() && CraftRules::legal(b, &[], f)).map(move |f| (b, f))).collect();
        let mut glob: Vec<(f64, String)> = Vec::new();
        let mut local: Vec<(String, Piece)> = Vec::new();
        let mut seen: HashSet<String> = HashSet::default();
        for &(b, f) in &fams {
            let fam = &b.fams[f];
            if !seen.insert(key(fam)) {
                continue;
            }
            if fam.local {
                local.push((key(fam), craft_piece(b, vec![f], anoint.clone(), self.item_level)));
            } else {
                glob.push((vals0.get(&key(fam)).copied().unwrap_or(0.0), key(fam)));
            }
        }
        glob.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        let all: Vec<&Fam> = fams.iter().map(|&(b, f)| &b.fams[f]).filter(|f| !f.local).collect();
        let lead = lead_fams(&ctx.lead, &all);
        let mut re: Vec<String> = glob.iter().take(REPROBE).map(|g| g.1.clone()).collect();
        re.extend(glob.iter().skip(REPROBE).filter(|g| lead.contains(&g.1)).map(|g| g.1.clone()));
        let sets: Vec<Vec<String>> = re.iter().map(|k| k.split('\n').map(|s| s.to_string()).collect()).collect();
        let (base0, gains) = self.line_gains(&s0, &ctx.prime, &sets)?;
        stats.probes += sets.len() + 1;
        let mut val: HashMap<String, f64> = re.into_iter().zip(gains).collect();
        // local lines: the item with only that family, really evaluated
        let pieces: Vec<Piece> = local.iter().map(|l| l.1.clone()).collect();
        let r = self.slot_scores(&s0, i, &pieces, &ctx.prime)?;
        stats.real += pieces.len();
        for ((k, _), v) in local.iter().zip(r) {
            val.insert(k.clone(), v.map_or(0.0, |v| v.1 .0 - base0));
        }
        // fill each influence set; keep the 3 best distinct items
        let mut plans: Vec<Planned> = Vec::new();
        let mut ranks = Vec::new();
        for b in bases {
            let v: Vec<f64> = b.fams.iter().map(|f| val.get(&key(f)).or_else(|| vals0.get(&key(f))).copied().unwrap_or(0.0)).map(|x| if x.is_nan() { 0.0 } else { x }).collect();
            let (mods, value) = fill_by_value(b, &v);
            ranks.push((rank_key(b), v.iter().enumerate().map(|(f, &x)| if CraftRules::legal(b, &[], f) { x } else { f64::NAN }).collect()));
            plans.push(Planned { base: b.clone(), mods, value, vals: v, scored: None });
        }
        plans.sort_by(|a, b| b.value.partial_cmp(&a.value).unwrap_or(std::cmp::Ordering::Equal));
        let mut labels: HashSet<String> = HashSet::default();
        plans.retain(|p| labels.insert(craft_piece(&p.base, p.mods.clone(), None, 0).label));
        plans.truncate(3);
        let pieces: Vec<Piece> = plans.iter().map(|p| craft_piece(&p.base, p.mods.clone(), anoint.clone(), self.item_level)).collect();
        let r = self.slot_scores(st, i, &pieces, &ctx.prime)?;
        stats.real += pieces.len();
        for (p, v) in plans.iter_mut().zip(r) {
            p.scored = v.map(|v| v.1);
        }
        plans.sort_by(|a, b| b.scored.as_ref().map_or(f64::MIN, |s| s.0).partial_cmp(&a.scored.as_ref().map_or(f64::MIN, |s| s.0)).unwrap_or(std::cmp::Ordering::Equal));
        Ok((plans, ranks))
    }

    /// Plans every craft slot: one probe per global line of every slot's bases, shared by all slots,
    /// then each slot in turn, taking its best real item when it beats the current one (not with `ctx.prime`), so the
    /// next slot is probed with this one fixed. Writes the plan's family values as the slots' ranks.
    /// Returns whether `st` improved, the counts, and each slot's top items.
    pub(super) fn plan_pass(&mut self, st: &mut State, ctx: &PlanCtx) -> Result<(bool, PlanStats, Vec<(usize, Vec<Planned>)>), String> {
        let t = Instant::now();
        let mut stats = PlanStats::default();
        let mut out = Vec::new();
        if self.stop() {
            return Ok((false, stats, out));
        }
        self.layer = "items: plan".into();
        let mut ctx = ctx.clone();
        if ctx.lead.is_empty() && ctx.prime.is_empty() {
            let s = self.sensitivity(st)?;
            stats.probes += 2 * s.axes.len() + 1;
            ctx.lead = parts::convex_axes(&s, 3);
        }
        self.plan_lead = ctx.lead.clone();
        let slots = self.plan_slots(st);
        let mut bases = Vec::new();
        for &i in &slots {
            bases.push(self.plan_bases(st, i)?);
        }
        let mut seen: HashSet<String> = HashSet::default();
        let mut keys: Vec<Vec<String>> = Vec::new();
        for f in bases.iter().flatten().flat_map(|b| b.fams.iter()) {
            if !f.local && !f.lines.is_empty() && seen.insert(f.lines.join("\n")) {
                keys.push(f.lines.clone());
            }
        }
        let (_, gains) = self.line_gains(st, &ctx.prime, &keys)?;
        stats.probes += keys.len() + 1;
        let vals0: HashMap<String, f64> = keys.iter().map(|k| k.join("\n")).zip(gains).collect();
        let mut improved = false;
        for (&i, bs) in slots.iter().zip(&bases) {
            if self.stop() {
                break;
            }
            let (plans, ranks) = self.plan_slot(st, i, bs, &ctx, &vals0, &mut stats)?;
            if ctx.prime.is_empty() && !ctx.dry {
                for (k, r) in ranks {
                    self.ranks.insert((i, k), r);
                }
                if let Some(Some(v)) = plans.first().map(|p| p.scored.clone()) {
                    if v.0 > st.score + EPS {
                        let p = &plans[0];
                        let anoint = match st.gear.pieces[i].as_ref().map(|p| &p.design) {
                            Some(Design::Craft { anoint, .. }) => anoint.clone(),
                            _ => None,
                        };
                        if let Some(g) = self.with_piece(&st.gear, i, Some(craft_piece(&p.base, p.mods.clone(), anoint, self.item_level))) {
                            self.take(st, g, v);
                            improved = true;
                        }
                    }
                }
            }
            out.push((i, plans));
        }
        if ctx.prime.is_empty() && !ctx.dry && !self.stop() {
            improved |= self.resist_trim_pass(st)?;
        }
        stats.ms = t.elapsed().as_secs_f64() * 1000.0;
        if improved {
            self.publish();
        }
        Ok((improved, stats, out))
    }
}

const RESISTS: [&str; 3] = ["Fire", "Cold", "Lightning"];

/// The elements and amounts of a resist line ("+17% to Cold and Lightning Resistances") or the attributes and amounts of
/// an attribute line ("+30 to Strength and Dexterity", "+12 to all Attributes", keys Str/Dex/Int); empty for any other line.
pub(in crate::solver) fn resist_amounts(line: &str) -> Vec<(&'static str, f64)> {
    let l = line.to_lowercase();
    let attr = !l.contains("resistance") && l.contains(" to ") && !l.contains('%') && ["strength", "dexterity", "intelligence", "all attributes"].iter().any(|a| l.contains(a));
    if !l.contains("resistance") && !attr {
        return Vec::new();
    }
    let n: String = l.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let n = n.parse().unwrap_or(0.0);
    if attr {
        let all = l.contains("all attributes");
        return [("Str", "strength"), ("Dex", "dexterity"), ("Int", "intelligence")].into_iter().filter(|(_, w)| all || l.contains(w)).map(|(k, _)| (k, n)).collect();
    }
    let all = l.contains("all elemental");
    RESISTS.into_iter().filter(|e| all || l.contains(&e.to_lowercase())).map(|e| (e, n)).collect()
}

/// Whether a craft family is only resists and every one of them could go without dropping its element below
/// `need` (`surplus(element)` = total minus the limit).
pub(in crate::solver) fn resist_surplus_line(lines: &[String], surplus: &dyn Fn(&str) -> f64) -> bool {
    let a: Vec<_> = lines.iter().flat_map(|l| resist_amounts(l)).collect();
    !a.is_empty() && a.len() >= lines.len() && a.iter().all(|(e, n)| *n <= surplus(e))
}

/// How far element `e`'s resist is over its floor: -1 when the goal has no floor for it. The floor is named
/// `NoFlask:<e>Resist` while flasks count (the default), plain `<e>Resist` otherwise.
pub(in crate::solver) fn resist_surplus(sc: &Scorer, vals: &Vals, e: &str) -> f64 {
    let want = format!("{e}Resist");
    let floor = sc.limits.iter().find_map(|l| match l.check {
        Check::AtLeast(j, b) if sc.names[j].strip_prefix(NO_FLASK).unwrap_or(&sc.names[j]) == want => Some((j, b)),
        _ => None,
    });
    floor.and_then(|(j, b)| vals.get(j).copied().flatten().map(|v| v - b)).unwrap_or(-1.0)
}

impl Solver {
    /// Resist-surplus trim: resist limits are only floors, so the hybrid resist craft and resist suffixes pile up past
    /// them. For each crafted piece, a resist family whose whole amount is surplus is swapped for the best other
    /// suffix (probed, then really evaluated); kept only when the build scores better and no limit gets worse.
    fn resist_trim_pass(&self, st: &mut State) -> Result<bool, String> {
        let sc = &self.scorer;
        let mut improved = false;
        for i in 0..self.slots.len() {
            if self.slots[i].locked || self.stop() {
                continue;
            }
            let Some(Design::Craft { base, mods, anoint }) = st.gear.pieces[i].as_ref().map(|p| p.design.clone()) else { continue };
            let surplus = |e: &str| -> f64 {
                // (an attribute: what the build has over what its gear and gems require)
                if matches!(e, "Str" | "Dex" | "Int") {
                    let at = |k: &str| sc.names.iter().position(|n| n == k).and_then(|j| st.vals.get(j).copied().flatten());
                    return match (at(e), at(&format!("Req{e}"))) {
                        (Some(v), Some(r)) if sc.limits.iter().any(|l| l.name.ends_with("requirement met")) => v - r,
                        _ => -1.0,
                    };
                }
                resist_surplus(sc, &st.vals, e)
            };
            for m in mods.iter().copied() {
                let f = &base.fams[m];
                if f.implicit || !resist_surplus_line(&f.lines, &surplus) {
                    continue;
                }
                let rest: Vec<usize> = mods.iter().copied().filter(|&x| x != m).collect();
                let Some(g0) = self.with_piece(&st.gear, i, Some(craft_piece(&base, rest.clone(), anoint.clone(), self.item_level))) else { continue };
                let mut s0 = st.clone();
                s0.gear = Arc::new(g0);
                let cands: Vec<usize> = (0..base.fams.len()).filter(|&c| c != m && base.fams[c].prefix == f.prefix && !base.fams[c].local && !base.fams[c].lines.is_empty() && !base.fams[c].lines.iter().any(|l| l.to_lowercase().contains("resistance") || !resist_amounts(l).is_empty()) && CraftRules::legal(&base, &rest, c)).collect();
                let sets: Vec<Vec<String>> = cands.iter().map(|&c| base.fams[c].lines.clone()).collect();
                let (_, gains) = self.line_gains(&s0, &[], &sets)?;
                let mut order: Vec<usize> = (0..cands.len()).collect();
                order.sort_by(|&a, &b| gains[b].partial_cmp(&gains[a]).unwrap_or(std::cmp::Ordering::Equal));
                let pieces: Vec<Piece> = order.iter().take(3).map(|&k| craft_piece(&base, rest.iter().copied().chain([cands[k]]).collect(), anoint.clone(), self.item_level)).collect();
                let best = self.slot_scores(st, i, &pieces, &[])?.into_iter().flatten().max_by(|a, b| a.1 .0.total_cmp(&b.1 .0));
                if let Some((g, v)) = best.filter(|(_, v)| v.0 > st.score + EPS && v.1 <= st.viol + EPS) {
                    self.take(st, g, v);
                    improved = true;
                    break;
                }
            }
        }
        Ok(improved)
    }
}

#[cfg(test)]
mod tests {
    /// With flasks counting (default) the resist floors are `NoFlask:` stats: 110% fire resist is 35 over the 75 floor.
    #[test]
    fn resist_surplus_reads_noflask_floors() {
        use super::*;
        let g: Goal = serde_json::from_str(r#"{"skill":"Poisonous Concoction","level":90,"targets":[{"name":"DPS"}]}"#).unwrap();
        let (sc, _) = Scorer::new(&g).unwrap();
        let mut v: Vals = vec![None; sc.names.len()];
        let i = sc.names.iter().position(|n| n == "NoFlask:FireResist").expect("default flasks name the floor NoFlask:FireResist");
        v[i] = Some(110.0);
        assert!((resist_surplus(&sc, &v, "Fire") - 35.0).abs() < 1e-9);
    }

    #[test]
    fn resist_surplus_trim_keeps_the_cap() {
        use super::*;
        // Lightning 152 vs 135 needed: the +45% line would break the cap, the +13% hybrid could go.
        let sur = |e: &str| match e {
            "Lightning" => 17.0,
            "Cold" => 40.0,
            _ => 0.0,
        };
        let l = |s: &str| vec![s.to_string()];
        assert!(!resist_surplus_line(&l("+45% to Lightning Resistance"), &sur));
        assert!(resist_surplus_line(&l("+13% to Cold and Lightning Resistances"), &sur));
        assert!(!resist_surplus_line(&l("+13% to Fire and Lightning Resistances"), &sur));
        assert!(!resist_surplus_line(&l("+80 to maximum Life"), &sur));
        // Attributes the requirements do not need: Str 40 over, Dex 10 over.
        let att = |e: &str| match e {
            "Str" => 40.0,
            "Dex" => 10.0,
            _ => 0.0,
        };
        assert!(resist_surplus_line(&l("+30 to Strength"), &att));
        assert!(resist_surplus_line(&l("+8 to Strength and Dexterity"), &att));
        assert!(!resist_surplus_line(&l("+30 to Strength and Dexterity"), &att), "Dex is only 10 over");
        assert!(!resist_surplus_line(&l("+12 to all Attributes"), &att), "Int is not over");
        assert!(!resist_surplus_line(&l("+30% increased Strength Requirement"), &att));
    }

    use super::*;

    fn top(name: &str, perfect: bool, inf: &[&str]) -> BaseInfo {
        let inf: Vec<String> = inf.iter().map(|s| s.to_string()).collect();
        base_info_craft(name, CRAFT_ILVL, 100, &[], perfect, &inf, 1).unwrap()
    }

    /// Families of `src` with distinct groups, `n` of them, optionally on one side.
    fn pick(b: &BaseInfo, src: &str, prefix: Option<bool>, n: usize) -> Vec<usize> {
        let mut seen = BTreeSet::new();
        let v: Vec<usize> = (0..b.fams.len()).filter(|&i| b.fams[i].source == src && b.fams[i].group != MULTIMOD && prefix.is_none_or(|p| b.fams[i].prefix == p) && seen.insert(b.fams[i].group.clone())).take(n).collect();
        assert_eq!(v.len(), n, "{} families of {src} on {}", v.len(), b.name);
        v
    }

    /// Adds each in order and says whether every step was legal.
    fn chain(b: &BaseInfo, fs: &[usize]) -> Vec<bool> {
        let mut held = Vec::new();
        fs.iter()
            .map(|&f| {
                let ok = CraftRules::legal(b, &held, f);
                if ok {
                    held.push(f);
                }
                ok
            })
            .collect()
    }

    /// Legality-check workload for the `same_group` timing: every pair of explicit families on one base.
    #[test]
    fn same_group_timing() {
        let b = top("Vaal Regalia", true, &["shaper"]);
        let ex: Vec<usize> = (0..b.fams.len()).filter(|&i| !b.fams[i].implicit).collect();
        // The old check, allocating per call, against the precomputed one on the same pairs.
        let old = |a: &Fam, b: &Fam| {
            let (ka, kb) = (pom_item::modpool::group_keys(&a.group, a.source == "elevated"), pom_item::modpool::group_keys(&b.group, b.source == "elevated"));
            ka.iter().any(|k| kb.contains(k))
        };
        let run = |f: &dyn Fn(&Fam, &Fam) -> bool| {
            let t = std::time::Instant::now();
            let mut hits = 0usize;
            for _ in 0..20 {
                for &x in &ex {
                    for &y in &ex {
                        hits += f(&b.fams[x], &b.fams[y]) as usize;
                    }
                }
            }
            (hits, t.elapsed())
        };
        let (h_old, t_old) = run(&old);
        let (hits, t_new) = run(&same_group);
        println!("same_group: {} calls; old {t_old:?} ({h_old} hits), new {t_new:?} ({hits} hits)", 20 * ex.len() * ex.len());
        assert_eq!(h_old, hits);
        // Semantics: an elevated mod shares a group with its normal twin.
        assert!(b.fams.iter().filter(|f| f.source == "elevated").all(|e| ex.iter().any(|&i| i != 0 && b.fams[i].source != "elevated" && same_group(&b.fams[i], e))));
    }

    #[test]
    fn one_enchant_per_item() {
        let mut boots = top("Crusader Boots", true, &[]);
        // (two lab enchants as craft_extras would add them)
        let base_fam = boots.fams[0].clone();
        for k in 0..2 {
            boots.fams.push(Fam { key: format!("E|ENDGAME|{k}"), group: "Enchant".into(), keys: group_pair("Enchant", "enchant"), source: "enchant", implicit: true, influence: None, ..base_fam.clone() });
        }
        let n = boots.fams.len();
        let e = vec![n - 2, n - 1];
        let r = chain(&boots, &e);
        println!("2 boot enchants: {r:?}");
        assert_eq!(r, vec![true, false]);
    }

    #[test]
    fn craft_legality_table() {
        // Third influence: the base refuses a set of three, and a 3-influence pool cannot put a third on the item.
        let own = base_influences("Vaal Regalia").unwrap();
        assert!(own.len() >= 3);
        let three: Vec<String> = own.iter().take(3).cloned().collect();
        assert!(base_info_craft("Vaal Regalia", 86, 100, &[], true, &three, 1).is_err());
        let mut b = top("Vaal Regalia", true, &[]);
        let wide = base_info_impl("Vaal Regalia", 86, 100, &[], true, Some(&three), 1).unwrap();
        b.fams = wide.fams;
        b.influences = three.clone();
        let by_inf: Vec<usize> = three.iter().map(|i| (0..b.fams.len()).find(|&f| b.fams[f].source == "influence" && b.fams[f].influence.as_ref() == Some(i)).expect("an influenced family")).collect();
        let r = chain(&b, &by_inf);
        println!("3 influences: {r:?}");
        assert_eq!(r, vec![true, true, false]);

        // Bench: one craft; a second needs the multimod; the multimod counts as one of the three, so 2 crafts fit and no 3rd.
        let b = top("Vaal Regalia", true, &[]);
        let benches = pick(&b, "bench", Some(true), 3);
        let more = pick(&b, "bench", Some(false), 4);
        let multi = (0..b.fams.len()).find(|&f| b.fams[f].group == MULTIMOD).expect("multimod craft");
        let two = [benches[0], more[0]];
        println!("2 bench, no multimod: {:?}", chain(&b, &two));
        assert_eq!(chain(&b, &two), vec![true, false]);
        let with = [multi, benches[0], benches[1], more[0]];
        println!("multimod + 2 crafts + 3rd: {:?}", chain(&b, &with));
        assert_eq!(chain(&b, &with), vec![true, true, true, false]);

        // Eldritch: not on a ring, not on an influenced helmet; one Exarch and one Eater.
        let helm = top("Hubris Circlet", true, &[]);
        let ex = pick(&helm, "exarch", None, 2);
        let ea = pick(&helm, "eater", None, 1);
        println!("exarch, exarch, eater: {:?}", chain(&helm, &[ex[0], ex[1], ea[0]]));
        assert_eq!(chain(&helm, &[ex[0], ex[1], ea[0]]), vec![true, false, true]);
        let mut ring = top("Two-Stone Ring", true, &[]);
        assert!(!ring.fams.iter().any(|f| f.implicit && f.source != "corrupted"));
        ring.fams.push(helm.fams[ex[0]].clone());
        let rf = ring.fams.len() - 1;
        assert!(!CraftRules::legal(&ring, &[], rf), "eldritch implicit on a ring");
        let shaped = top("Hubris Circlet", true, &["shaper"]);
        assert!(!shaped.fams.iter().any(|f| matches!(f.source, "exarch" | "eater")) && shaped.fams.iter().any(|f| f.source == "influence"));
        let mut inf_helm = top("Hubris Circlet", true, &[]);
        inf_helm.influences = vec!["shaper".into()];
        assert!(!CraftRules::legal(&inf_helm, &[], ex[0]), "eldritch implicit on an influenced helmet");

        // Essence-only: one.
        let ess = pick(&b, "essence", None, 2);
        println!("2 essence mods: {:?}", chain(&b, &ess));
        assert_eq!(chain(&b, &ess), vec![true, false]);
        // Essence and Delve mods both reforge the whole item: never together, in either order.
        let (es, dl) = (pick(&b, "essence", None, 1)[0], pick(&b, "delve", None, 1)[0]);
        println!("essence+delve {:?}, delve+essence {:?}", chain(&b, &[es, dl]), chain(&b, &[dl, es]));
        assert_eq!(chain(&b, &[es, dl]), vec![true, false]);
        assert_eq!(chain(&b, &[dl, es]), vec![true, false]);

        // Corruption implicits: 2 with perfect rolls, never 3; 1 with typical rolls.
        let amu = top("Onyx Amulet", true, &[]);
        let c = pick(&amu, "corrupted", None, 3);
        println!("3 corruption implicits: {:?}", chain(&amu, &c));
        assert_eq!(chain(&amu, &c), vec![true, true, false]);
        let amu_t = top("Onyx Amulet", false, &[]);
        assert_eq!(chain(&amu_t, &pick(&amu_t, "corrupted", None, 2)), vec![true, false]);
        // Elevated families need perfect rolls.
        assert!(top("Vaal Regalia", true, &["shaper"]).fams.iter().any(|f| f.source == "elevated"));
        assert!(!top("Vaal Regalia", false, &["shaper"]).fams.iter().any(|f| f.source == "elevated"));
        // Basic mode: only plain families.
        let basic = base_info("Vaal Regalia", 86, 100, true).unwrap();
        assert!(basic.fams.iter().all(|f| f.source == "normal" && !f.implicit && f.influence.is_none()));
    }

    /// Legality (upstream ItemsTab.lua): an implicit may share a group with an explicit (belt life implicit + life prefix); a
    /// corrupted implicit cannot repeat a group among the corrupted ones; eldritch and corrupted exclude each other;
    /// an elevated mod and its normal twin are one group; a corrupted item loses its base implicit.
    #[test]
    fn implicit_and_explicit_share_groups_but_not_corruption_with_eldritch() {
        let goal = r#"{"skill":"Essence Drain","level":90,"targets":[{"name":"DPS","value":1000000}],"items":{"rarities":["rare"],"craft":"top"}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":600000,"maxEvals":400000,"threads":2}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let gear = s.start_gear.clone();
        // implicit + explicit in one group: legal, and it reaches evaluation
        for (kind, base, src) in [(SlotKind::Gloves, "Paladin Gloves", "exarch"), (SlotKind::Ring, "Two-Stone Ring", "corrupted")] {
            let b = s.base_craft(base, &[]).unwrap();
            let (imp, exp) = (0..b.fams.len())
                .filter(|&f| b.fams[f].source == src && b.fams[f].implicit)
                .find_map(|i| (0..b.fams.len()).find(|&e| !b.fams[e].implicit && b.fams[e].source == "normal" && b.fams[e].group == b.fams[i].group).map(|e| (i, e)))
                .unwrap_or_else(|| panic!("no {src} implicit sharing a group with an explicit on {base}"));
            let slot = s.slot_of(kind).unwrap();
            println!("{base}: {:?} + {:?} (group {})", b.fams[imp].lines, b.fams[exp].lines, b.fams[imp].group);
            assert!(CraftRules::legal(&b, &[imp], exp) && CraftRules::legal(&b, &[exp], imp));
            assert!(s.with_piece(&gear, slot, Some(craft_piece(&b, vec![imp, exp], None, CRAFT_ILVL))).is_some());
        }
        // corrupted ring: the base implicit is gone, only the corrupted lines remain
        let ring = Arc::new(top("Two-Stone Ring", true, &[]));
        assert!(!ring.implicit.is_empty());
        let c = pick(&ring, "corrupted", None, 2);
        let n = ring.fams[c[0]].lines.len();
        let xml = craft_piece(&ring, vec![c[0]], None, CRAFT_ILVL).xml.to_string();
        println!("corrupted ring implicits: {:?}", xml.lines().skip_while(|l| !l.starts_with("Implicits")).take(n + 2).collect::<Vec<_>>());
        assert!(xml.contains(&format!("Implicits: {n}
")), "{xml}");
        assert!(!ring.implicit.iter().any(|l| xml.contains(l.as_str())));
        let plain = craft_piece(&ring, vec![], None, CRAFT_ILVL).xml.to_string();
        assert!(ring.implicit.iter().all(|l| plain.contains(l.as_str())));
        // the same group twice among corrupted implicits: refused
        let twin = (0..ring.fams.len()).find(|&f| f != c[0] && ring.fams[f].source == "corrupted" && ring.fams[f].group == ring.fams[c[0]].group);
        if let Some(t) = twin {
            assert!(!CraftRules::legal(&ring, &[c[0]], t));
        }
        // eldritch and corrupted exclude each other, both orders
        let helm = top("Hubris Circlet", true, &[]);
        let (ex, co) = (pick(&helm, "exarch", None, 1)[0], pick(&helm, "corrupted", None, 1)[0]);
        println!("eldritch then corrupted: {}, corrupted then eldritch: {}", CraftRules::legal(&helm, &[ex], co), CraftRules::legal(&helm, &[co], ex));
        assert!(!CraftRules::legal(&helm, &[ex], co) && !CraftRules::legal(&helm, &[co], ex));
        // an elevated mod and its normal twin: one group
        let (body, el, nm) = [("Hubris Circlet", "elder"), ("Hubris Circlet", "shaper"), ("Vaal Regalia", "elder"), ("Vaal Regalia", "shaper")]
            .into_iter()
            .find_map(|(n, i)| {
                let body = top(n, true, &[i]);
                (0..body.fams.len())
                    .filter(|&f| body.fams[f].source == "elevated")
                    .find_map(|e| (0..body.fams.len()).find(|&x| body.fams[x].source != "elevated" && !body.fams[x].implicit && same_group(&body.fams[x], &body.fams[e])).map(|x| (e, x)))
                    .map(|(e, x)| (body, e, x))
            })
            .expect("an elevated mod with a normal twin");
        println!("elevated {:?} ({}) + normal {:?} ({}): {}", body.fams[el].lines, body.fams[el].group, body.fams[nm].lines, body.fams[nm].group, CraftRules::legal(&body, &[el], nm));
        assert!(!CraftRules::legal(&body, &[el], nm) && !CraftRules::legal(&body, &[nm], el));
    }

    /// The Shaper's added lightning to spells and its elevated version are one group: never both on an item.
    #[test]
    fn uber_normal_and_elevated_one_group() {
        let helm = top("Hubris Circlet", true, &["shaper", "hunter"]);
        let find = |src: &str| (0..helm.fams.len()).find(|&f| helm.fams[f].source == src && helm.fams[f].group == "SpellAddedLightningDamageUber" && !helm.fams[f].implicit);
        let (x, e) = (find("influence").expect("the Shaper's mod"), find("elevated").expect("its elevated version"));
        println!("{:?} + {:?}: {} / {}", helm.fams[x].lines, helm.fams[e].lines, CraftRules::legal(&helm, &[x], e), CraftRules::legal(&helm, &[e], x));
        assert!(!CraftRules::legal(&helm, &[x], e) && !CraftRules::legal(&helm, &[e], x));
    }

    fn parsed(base: &Arc<BaseInfo>, mods: Vec<usize>) -> (String, pom_item::Item) {
        let xml = craft_piece(base, mods, None, CRAFT_ILVL).xml;
        let text = xml.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        let item = pom_item::parse_raw(&text, false, pom_calc::data::game_data());
        (text, item)
    }

    #[test]
    fn crafted_item_text_parses() {
        // Shaper + a bench craft: influence flag and {crafted}.
        let b = Arc::new(top("Vaal Regalia", true, &["shaper"]));
        let bench = (0..b.fams.len()).find(|&f| b.fams[f].source == "bench" && b.fams[f].group != MULTIMOD).unwrap();
        let (text, it) = parsed(&b, vec![bench]);
        assert!(it.influence.get("shaper") == Some(&true) && it.explicit_mod_lines.iter().any(|l| l.crafted), "{text}");
        // Eater ES implicit + bench (eldritch and Shaper exclude each other, so a second item): eater flag, an
        // EnergyShield mod the same item lacks without it.
        let b = Arc::new(top("Vaal Regalia", true, &[]));
        let ex = (0..b.fams.len()).find(|&f| b.fams[f].source == "eater" && b.fams[f].lines[0].contains("increased maximum Energy Shield") && !b.fams[f].lines[0].contains("Presence")).expect("eater ES implicit");
        let bench = (0..b.fams.len()).find(|&f| b.fams[f].source == "bench" && b.fams[f].group != MULTIMOD && b.fams[f].lines[0].contains("Life")).unwrap();
        let (text, with) = parsed(&b, vec![ex, bench]);
        let (_, without) = parsed(&b, vec![bench]);
        println!("{text}");
        assert!(with.influence.get("tangle") == Some(&true) && with.implicit_mod_lines.iter().any(|l| l.eater), "{text}");
        assert!(with.explicit_mod_lines.iter().any(|l| l.crafted));
        let es = |it: &pom_item::Item| it.implicit_mod_lines.iter().flat_map(|l| l.mod_list.iter().flatten()).filter(|m| m.name == "EnergyShield").count();
        println!("EnergyShield mods with {} without {}", es(&with), es(&without));
        assert!(es(&with) > es(&without));
        // Corrupted implicit.
        let cor = (0..b.fams.len()).find(|&f| b.fams[f].source == "corrupted").map(|f| vec![f]).unwrap_or_default();
        let (text, c) = parsed(&b, cor);
        assert!(c.corrupted, "{text}");
        // A ring with a catalyst: some line scales.
        let r = Arc::new(top("Two-Stone Ring", true, &[]));
        let mods: Vec<usize> = (0..r.fams.len()).filter(|&f| r.fams[f].source == "normal" && r.fams[f].tags.iter().any(|t| t == "resistance")).take(1).chain((0..r.fams.len()).filter(|&f| r.fams[f].source == "normal" && r.fams[f].tags.iter().any(|t| t == "life")).take(1)).collect();
        let (text, ring) = parsed(&r, mods);
        println!("{text}");
        assert!(ring.catalyst.is_some() && ring.catalyst_quality == Some(20.0), "{text}");
        assert!(ring.explicit_mod_lines.iter().any(|l| l.value_scalar.is_some_and(|v| v > 1.0)), "{text}");
    }

    /// With Hatred in the setup a Watcher's Eye carries a Hatred line the engine parses; a Forbidden Flame + Flesh pair
    /// on the class's ascendancy notable puts that notable's mods in the env.
    #[test]
    fn special_uniques_carry_aura_and_grant_notable() {
        let game = pom_calc::data::game_data();
        // Watcher's Eye: the setup's auras decide the table's modifiers.
        let goal: Goal = serde_json::from_str(r#"{"skill":"Boneshatter","level":90}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let c = s.candidates().unwrap();
        let mut st = s.initial_state(c[0], None, None).unwrap();
        st.utils = vec![find_gem("Hatred").unwrap()];
        let auras = s.active_aura_names(&st);
        assert_eq!(auras, vec!["Hatred".to_string()]);
        let mods = eye_mods(&auras);
        let pick: Vec<&EyeMod> = mods.iter().take(2).collect();
        let text = eye_text(&pick, true);
        println!("{text}");
        let eye = pom_item::parse_raw(&format!("Rarity: UNIQUE\n{text}"), false, game);
        let hatred: Vec<_> = eye.explicit_mod_lines.iter().filter(|l| l.line.contains("Hatred")).collect();
        assert!(!hatred.is_empty() && hatred.iter().all(|l| l.mod_list.as_ref().is_some_and(|m| !m.is_empty())), "{text}");
        // Forbidden Flame + Flesh for a Duelist: the first of the class's variants, in two allocated sockets.
        let (flame, flesh) = (generated_raw("Forbidden Flame").unwrap(), generated_raw("Forbidden Flesh").unwrap());
        let (n, notable) = forbidden_variants(&flame, "Duelist").remove(0);
        let tree = crate::cached_tree("3_29").unwrap();
        let duelist = blank_build_xml(90).replace("className=\"Scion\"", "className=\"Duelist\"").replace("classId=\"0\"", "classId=\"4\"");
        let paths = crate::treeclick::tree_paths(&duelist, game).unwrap();
        let mut socks: Vec<(i64, i64)> = paths.nodes.iter().filter(|(_, c)| c.kind == "Socket" && c.ascendancy.is_none() && !c.path.is_empty()).map(|(id, c)| (c.path_dist, *id)).collect();
        socks.sort_unstable();
        let (s1, s2) = (socks[0].1, socks[1].1);
        let mut nodes: Vec<i64> = paths.nodes[&s1].path.iter().chain(paths.nodes[&s2].path.iter()).copied().collect();
        nodes.sort_unstable();
        nodes.dedup();
        let nodes = nodes.iter().map(|n| n.to_string()).collect::<Vec<_>>().join(",");
        let item = |raw: &str| crate::edit::esc_text(&format!("Rarity: UNIQUE\n{}", select_variant(raw, n)));
        let spec = format!("classId=\"4\" ascendClassId=\"0\" masteryEffects=\"\" nodes=\"{nodes}\"><Sockets><Socket nodeId=\"{s1}\" itemId=\"1\"/><Socket nodeId=\"{s2}\" itemId=\"2\"/></Sockets>");
        let items = format!("<Item id=\"1\">{}</Item><Item id=\"2\">{}</Item><ItemSet useSecondWeaponSet=\"nil\" id=\"1\" />", item(&flame), item(&flesh));
        let xml = blank_build_xml(90).replace("className=\"Scion\"", "className=\"Duelist\"").replace("classId=\"0\" ascendClassId=\"0\" masteryEffects=\"\" nodes=\"\">", &spec).replace("<ItemSet useSecondWeaponSet=\"nil\" id=\"1\" />", &items);
        let tree_sources = |x: &str| -> std::collections::BTreeSet<String> {
            let env = crate::build_env(x, game).unwrap();
            let pom_engine::modstore::store::Backing::List(v) = &env.player.backing else { panic!("list") };
            v.iter().filter_map(|m| m.source.as_deref().filter(|s| s.starts_with("Tree:")).map(|s| s.to_string())).collect()
        };
        let with = tree_sources(&xml);
        let without = tree_sources(&xml.replace("<Item id=\"2\">", "<Item id=\"9\">"));
        let granted: Vec<&String> = with.difference(&without).collect();
        let names: Vec<&str> = granted.iter().filter_map(|s| s[5..].parse::<i64>().ok()).filter_map(|id| tree.nodes.get(&id)).filter_map(|v| v.get("dn").and_then(|d| d.as_str())).collect();
        println!("pair variant {n} {notable}: env gained {granted:?} = {names:?}");
        assert!(names.iter().any(|d| d.eq_ignore_ascii_case(&notable)), "{notable} not granted: {names:?}");
    }

    /// A Megalomaniac candidate in a medium socket of the solver's large cluster jewel lists 3 notables, and their
    /// passives are allocated (tree paths and env) once it is evaluated.
    #[test]
    fn megalomaniac_lists_three_allocated_notables() {
        let game = pom_calc::data::game_data();
        let goal: Goal = serde_json::from_str(r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let opts: Options = serde_json::from_str(r#"{"threads":2}"#).unwrap();
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let ci = s.candidates().unwrap()[0];
        let st = s.initial_state(ci, None, None).unwrap();
        let withl = s.cluster_designs(&st).unwrap().into_iter().find(|d| d.gear.sockets.iter().any(|x| !x.kept && !x.subs.is_empty())).expect("a large cluster jewel with sockets");
        let cand = s.megalomaniac_candidate(&withl).unwrap().expect("a Megalomaniac candidate");
        let si = cand.gear.sockets.iter().find(|x| x.unique.as_deref() == Some("Megalomaniac")).expect("Megalomaniac socket");
        let text = si.xml.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        let lines: Vec<&str> = text.lines().filter(|l| !l.starts_with("Variant: ")).collect();
        println!("{}\n{}", si.label, lines.join("\n"));
        let wanted: Vec<String> = text.lines().filter_map(|l| l.split_once("Added Passive Skill is ").map(|x| x.1.to_string())).collect();
        assert_eq!(wanted.len(), 3, "{wanted:?}");
        let scored = s.eval_states(vec![cand.clone()]).unwrap().remove(0).expect("evaluates");
        let xml = s.render(&scored).unwrap();
        let paths = crate::treeclick::tree_paths(&xml, game).unwrap();
        let gen = paths.state["generated"].as_array().unwrap();
        let alloc_names: Vec<&str> = gen.iter().filter(|n| n["id"].as_i64().is_some_and(|i| paths.alloc.contains(&i))).filter_map(|n| n["name"].as_str()).collect();
        println!("allocated cluster passives: {alloc_names:?}");
        for w in &wanted {
            assert!(alloc_names.contains(&w.as_str()), "{w} not allocated: {alloc_names:?}");
        }
        let env = crate::build_env(&xml, game).unwrap();
        let pom_engine::modstore::store::Backing::List(v) = &env.player.backing else { panic!("list") };
        let srcs: std::collections::BTreeSet<&str> = v.iter().filter_map(|m| m.source.as_deref()).collect();
        let ids: Vec<i64> = gen.iter().filter(|n| n["name"].as_str().is_some_and(|x| wanted.iter().any(|w| w == x))).filter_map(|n| n["id"].as_i64()).collect();
        println!("env has mods from notable nodes {:?}: {:?}", ids, ids.iter().map(|i| srcs.contains(format!("Tree:{i}").as_str())).collect::<Vec<_>>());
        assert!(ids.iter().any(|i| srcs.contains(format!("Tree:{i}").as_str())));
    }

    #[test]
    fn plan_amulet_crit_primed() {
        let goal = r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":100000000}],"limits":{"cost":false,"pool":null,"resists":null,"attributes":false},"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"]}}"#;
        // (a DPS target the state is far from: above a target damage counts a fifth, and the crit-primed state would pass 1M;
        // damage only, no floors: with the amulet emptied a bare-tree Slayer falls below the pool, attribute and Trauma
        // sustain floors, and every amulet affix goes to life, energy shield and attributes, primed or not)
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":900000,"maxEvals":600000,"threads":6}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        assert!(s.ctx[cands[0]].label.contains("Slayer"), "{}", s.ctx[cands[0]].label);
        // fixed state: gems and gear for a bare Slayer (items_layer runs one plan pass itself)
        let mut st = s.initial_state(cands[0], None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();

        let amu = s.slot_of(SlotKind::Amulet).unwrap();
        let helm = s.slot_of(SlotKind::Helmet).unwrap();
        let crit = |p: &Planned| p.mods.iter().filter(|&&m| p.base.fams[m].tags.iter().any(|t| t == "critical")).map(|&m| p.base.fams[m].lines.join(" / ")).collect::<Vec<_>>();
        let show = |p: &Planned| craft_piece(&p.base, p.mods.clone(), None, CRAFT_ILVL).xml.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        let slot = |plans: &[(usize, Vec<Planned>)], i: usize| plans.iter().position(|(k, _)| *k == i).expect("slot planned");

        // both plans at the same state: nothing taken between slots
        let (_, stats, base) = s.plan_pass(&mut st.clone(), &PlanCtx { dry: true, ..Default::default() }).unwrap();
        let b = &base[slot(&base, amu)].1[0];
        eprintln!("base plan: {stats:?}\nbase amulet (value {:.4}, real {:?}):\n{}", b.value, b.scored.as_ref().map(|v| v.0), show(b));

        let ax = |n: &str| sens::AXES.iter().position(|a| a.name == n).unwrap();
        let lead = vec![ax("base crit chance"), ax("increased crit chance"), ax("crit multiplier")];
        let prime: Vec<String> = sens::AXES[lead[0]].commit.iter().chain(sens::AXES[lead[1]].commit).map(|l| l.to_string()).collect();
        let (_, pstats, primed) = s.plan_pass(&mut st.clone(), &PlanCtx { prime, lead, dry: true }).unwrap();
        let p = &primed[slot(&primed, amu)].1[0];
        let h = &primed[slot(&primed, helm)].1[0];
        eprintln!("primed plan: {pstats:?}\nprimed amulet (value {:.4}, real {:?}):\n{}", p.value, p.scored.as_ref().map(|v| v.0), show(p));
        eprintln!("primed helmet (value {:.4}, real {:?}):\n{}", h.value, h.scored.as_ref().map(|v| v.0), show(h));
        let tops = |p: &Planned| {
            let mut v: Vec<(f64, String)> = p.vals.iter().enumerate().map(|(f, &x)| (x, p.base.fams[f].lines.join(" / "))).collect();
            v.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
            v.into_iter().enumerate().filter(|(k, x)| *k < 10 || x.1.contains("Critical")).map(|(k, (x, l))| format!("#{k} {x:+.4} {l}")).collect::<Vec<_>>()
        };
        eprintln!("base amulet top lines: {:#?}
primed amulet top lines: {:#?}", tops(b), tops(p));
        eprintln!("crit families: base {:?}, primed {:?}", crit(b), crit(p));
        // The design's "and not in the base state" does not hold here: the engine already rates +36% multi this
        // Slayer's best amulet line at base crit. What priming must do: raise the multi line, and keep a crit family.
        let multi = |p: &Planned| (0..p.base.fams.len()).filter(|&f| p.base.fams[f].lines.iter().any(|l| l.contains("Global Critical Strike Multiplier"))).map(|f| p.vals[f]).fold(f64::MIN, f64::max);
        eprintln!("crit multi line value: base {:.4}, primed {:.4}", multi(b), multi(p));
        assert!(multi(p) > 1.5 * multi(b).max(1e-4), "priming crit did not raise crit multi: {} -> {}", multi(b), multi(p));
        assert!(!crit(p).is_empty(), "primed amulet has no crit family");
    }
    /// The multimod craft is valued by the crafted lines it enables: three bench lines worth 10 each beat one line
    /// plus the suffix the multimod displaces.
    #[test]
    fn multimod_valued_by_its_lines() {
        let b = top("Onyx Amulet", true, &[]);
        let benches = pick(&b, "bench", Some(true), 3);
        let mm = (0..b.fams.len()).find(|&f| b.fams[f].group == MULTIMOD).expect("multimod craft");
        let mut val = vec![0.0; b.fams.len()];
        for &f in &benches {
            val[f] = 10.0;
        }
        for f in pick(&b, "normal", Some(false), 3) {
            val[f] = 1.0;
        }
        let (mods, value) = fill_by_value(&b, &val);
        let item = craft_piece(&Arc::new(top("Onyx Amulet", true, &[])), mods.clone(), None, CRAFT_ILVL);
        eprintln!("planned value {value}, multimod chosen {}:\n{}", mods.contains(&mm), item.xml.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"));
        assert!(mods.contains(&mm) && benches.iter().all(|f| mods.contains(f)));
        // with one bench line worth anything the multimod is not taken
        let mut one = val.clone();
        one[benches[1]] = 0.0;
        one[benches[2]] = 0.0;
        assert!(!fill_by_value(&b, &one).0.contains(&mm));
    }

    /// A bare Spark build: the plan fills Weapon 1 with a crafted top weapon, and Replica Dragonfang's Flight is offered
    /// written for Spark (+3 to level of all Spark gems), scored in the amulet slot.
    #[test]
    fn bare_build_weapon_craft_and_dragonfang() {
        let goal = r#"{"skill":"Spark","ascendancy":"Occultist","level":90,"targets":[{"name":"DPS","value":100000000}],"limits":{"cost":false,"pool":null,"resists":null,"attributes":false},"items":{"rarities":["rare","unique"],"mustUse":[],"neverUse":[]}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":900000,"maxEvals":600000,"threads":6}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        let mut st = s.initial_state(cands[0], None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        let show = |x: &str| x.replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&");
        let w = s.slot_of(SlotKind::Weapon1).unwrap();
        let t = Instant::now();
        s.items_layer(&mut st, false).unwrap();
        eprintln!("items layer {:.1} s, score {:.4}", t.elapsed().as_secs_f64(), st.score);
        let piece = st.gear.pieces[w].as_ref().expect("weapon 1 filled");
        eprintln!("weapon 1 ({}):\n{}", piece.label, show(&piece.xml));
        let top = matches!(&piece.design, Design::Craft { base, .. } if base.top);
        assert!(top, "weapon 1 is not a top craft");

        let d = s.uniques.iter().find(|u| u.name == "Replica Dragonfang's Flight").expect("Dragonfang's Flight offered").clone();
        eprintln!("candidate {}:\n{}", d.label, show(&d.xml).lines().filter(|l| (!l.starts_with("Variant:") && !l.contains("{variant:")) || l.contains("Spark")).collect::<Vec<_>>().join("\n"));
        assert!(show(&d.xml).contains("Selected Alt Variant: 235") && show(&d.xml).contains("{variant:235}+3 to Level of all Spark Gems"));
        let amu = s.slot_of(SlotKind::Amulet).unwrap();
        let r = s.slot_scores(&st, amu, &[unique_piece(&d)], &[]).unwrap();
        let (cur, got) = (st.score, r[0].as_ref().map(|v| v.1 .0));
        eprintln!("amulet slot: current score {cur:.4}, with Dragonfang's Flight {got:?}");
        assert!(got.is_some(), "Dragonfang's Flight cannot be worn in the amulet slot");
    }

}
