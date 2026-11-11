//! The modifiers that can roll on a base at an item level, for the build solver and the assistant.
//!
//! Follows how upstream picks a crafted item's affixes: the table is `itemMods[type..subType]`, else `itemMods[type]`, else the
//! `Item` union (`Item.lua` ParseRaw); a modifier can roll when `ItemClass:GetModSpawnWeight` is above 0; Delve modifiers
//! (affix "Subterranean" / "of the Underground") are left to fossils; the tiers of a modifier are the modifiers of the same
//! type and stat order, lowest level first, and tier 1 is the last of them (`ItemsTab` UpdateAffixControls: "Tier
//! #modList - index + 1"). Like upstream, tiers ignore the item level; the item level only removes modifiers whose level is
//! above it. Essences (`Essence.lua`), the crafting bench (`ModMaster.lua`), veiled modifiers (`ModVeiled.lua`) and the
//! Searing Exarch / Eater of Worlds implicits (`ModEldritch.lua`) follow `ItemsTab` AddModifierToDisplayItem and
//! AddImplicitToDisplayItem.
use pom_engine::cjson::J;
use pom_engine::data::GameData;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};

/// What the item has beyond its base.
#[derive(Deserialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct PoolOptions {
    /// Influences on the item: shaper, elder, crusader, redeemer, hunter, warlord (upstream's eyrie, basilisk and adjudicator
    /// are accepted too).
    pub influences: Vec<String>,
    /// Spawn tags the item state adds that the base does not carry: a cluster jewel's skill tag (`affliction_*`, see
    /// `clusterSkills`), `no_tier_N_eldritch_implicit`, the jewel weapon tags (`two_handed_mod`, ...).
    pub extra_tags: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Range {
    pub min: f64,
    pub max: f64,
}

#[derive(Serialize, Clone, Debug)]
pub struct StatLine {
    /// The line as the data writes it, `+(91-100) to maximum Energy Shield`.
    pub text: String,
    /// Every number in the line in order, a range or a fixed value (min = max).
    pub values: Vec<Range>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PoolMod {
    pub id: String,
    /// The affix name ("Resplendent").
    pub affix: String,
    /// One modifier per group per item.
    pub group: String,
    /// 1 is the best tier of this modifier on this base, `tiers` the worst.
    pub tier: u32,
    pub tiers: u32,
    /// The item level the modifier needs.
    pub level: u32,
    /// The character level it sets on the item (80% of `level`, as `ItemClass:Craft`).
    pub req_level: u32,
    /// Spawn weight on this base (0 for bench and essence modifiers).
    pub weight: f64,
    pub stats: Vec<StatLine>,
    pub tags: Vec<String>,
    /// normal, influence, elevated, essence, bench, veiled, delve, exarch, eater.
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub influence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub essence: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Anoint {
    pub node_id: i64,
    pub name: String,
    pub stats: Vec<String>,
    pub oils: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct ClusterSkill {
    pub id: String,
    pub name: String,
    /// Pass as an `extraTags` entry to get the modifiers this skill allows.
    pub tag: String,
    pub enchant: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModPool {
    pub base: String,
    pub base_type: String,
    pub item_level: u32,
    /// The rare item's affix limits (magic for flasks and tinctures).
    pub prefix_limit: u32,
    pub suffix_limit: u32,
    pub prefixes: Vec<PoolMod>,
    pub suffixes: Vec<PoolMod>,
    /// Searing Exarch and Eater of Worlds implicits (armour only).
    pub implicits: Vec<PoolMod>,
    /// Blight anoints, when the base can be anointed.
    pub anoints: Vec<Anoint>,
    /// The skills a cluster jewel base can be enchanted with.
    pub cluster_skills: Vec<ClusterSkill>,
    /// Corruption implicits the base can get (type Corrupted, weight above 0; upstream keeps these too). Each is its own tier 1.
    pub corrupted: Vec<PoolMod>,
}

/// One enchant: the skill it belongs to, its tier name (ENDGAME, MERCILESS, HARVEST, ...) and its lines.
#[derive(Serialize, Clone, Debug)]
pub struct Enchant {
    pub skill: String,
    pub tier: String,
    pub lines: Vec<String>,
}

/// The pool for `base` at `item_level`. Cached per base, influences and tags; the item level is a filter on the cached pool.
pub fn mod_pool(game: &GameData, base: &str, item_level: u32, opts: &PoolOptions) -> Result<ModPool, String> {
    let mut inf: Vec<String> = opts.influences.iter().map(|s| influence_key(s)).collect::<Result<_, _>>()?;
    inf.sort();
    inf.dedup();
    let mut extra = opts.extra_tags.clone();
    extra.sort();
    extra.dedup();
    let key = format!("{base}|{}|{}", inf.join(","), extra.join(","));
    static CACHE: OnceLock<Mutex<HashMap<String, Arc<ModPool>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let hit = cache.lock().unwrap().get(&key).cloned();
    let full = match hit {
        Some(p) => p,
        None => {
            let p = Arc::new(build(game, base, &inf, &extra)?);
            cache.lock().unwrap().insert(key, p.clone());
            p
        }
    };
    let gated = |v: &[PoolMod]| v.iter().filter(|m| m.level <= item_level || matches!(m.source, "essence" | "bench")).cloned().collect();
    Ok(ModPool {
        item_level,
        prefixes: gated(&full.prefixes),
        suffixes: gated(&full.suffixes),
        implicits: gated(&full.implicits),
        corrupted: gated(&full.corrupted),
        ..(*full).clone()
    })
}

fn influence_key(s: &str) -> Result<String, String> {
    let k = match s.to_lowercase().as_str() {
        "warlord" | "adjudicator" => "adjudicator",
        "hunter" | "basilisk" => "basilisk",
        "redeemer" | "eyrie" => "eyrie",
        "crusader" => "crusader",
        "shaper" => "shaper",
        "elder" => "elder",
        "exarch" | "searing exarch" | "cleansing" => "cleansing",
        "eater" | "eater of worlds" | "tangle" => "tangle",
        _ => return Err(format!("unknown influence {s}")),
    };
    Ok(k.to_string())
}

/// The groups a mod competes in: a normal mod's own; an elevated mod's with "Old"/"Maven" taken off, with and without "Uber".
pub fn group_keys(group: &str, elevated: bool) -> Vec<String> {
    if !elevated {
        return vec![group.to_string()];
    }
    let g = group.strip_suffix("Old").unwrap_or(group);
    let g = g.strip_suffix("Maven").unwrap_or(g);
    vec![g.to_string(), g.replace("Uber", "")]
}

fn jstr(m: J, k: &str) -> String {
    m.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn str_refs(v: Option<J>) -> Vec<&'static str> {
    v.and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str()).collect()).unwrap_or_default()
}

fn str_list(v: Option<J>) -> Vec<String> {
    v.and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}

fn num_list(v: Option<J>) -> Vec<f64> {
    v.and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default()
}

/// The numbered lines of a modifier ("1", "2", ...).
fn mod_lines(m: J) -> Vec<String> {
    (1..).map_while(|i: usize| m.get(i.to_string().as_str()).and_then(|l| l.as_str()).map(|s| s.to_string())).collect()
}

/// A `{"$ref": "data.itemMods.<table>.<id>"}` entry's target.
fn resolve(mods: J, e: J) -> J {
    if let Some(r) = e.get("$ref").and_then(|r| r.as_str()) {
        let mut parts = r.split('.').skip(2);
        if let (Some(t), Some(i)) = (parts.next(), parts.next()) {
            if let Some(x) = mods.get(t).and_then(|t| t.get(i)) {
                return x;
            }
        }
    }
    e
}

/// A table mod with the fields its spawn weight reads, decoded once per table (a build visits every mod of a table).
struct Pre {
    id: &'static str,
    m: J,
    elevated: bool,
    group: &'static str,
    keys: Vec<&'static str>,
    vals: Vec<f64>,
    mkeys: Vec<&'static str>,
    mvals: Vec<f64>,
}

fn pre_table(game: &GameData, name: &str, table: J, mods: J) -> Result<Arc<Vec<Pre>>, String> {
    static CACHE: OnceLock<Mutex<HashMap<(usize, String), Arc<Vec<Pre>>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = (game as *const GameData as usize, name.to_string());
    if let Some(p) = cache.lock().unwrap().get(&key) {
        return Ok(p.clone());
    }
    let v: Vec<Pre> = table
        .as_object()
        .ok_or("bad affix table")?
        .iter()
        .map(|(id, e)| {
            let m = resolve(mods, e);
            let affix = m.get("affix").and_then(|a| a.as_str()).unwrap_or("");
            Pre { id, m, elevated: affix.contains("Elevated"), group: m.get("group").and_then(|a| a.as_str()).unwrap_or(""), keys: str_refs(m.get("weightKey")), vals: num_list(m.get("weightVal")), mkeys: str_refs(m.get("weightMultiplierKey")), mvals: num_list(m.get("weightMultiplierVal")) }
        })
        .collect();
    let v = Arc::new(v);
    cache.lock().unwrap().insert(key, v.clone());
    Ok(v)
}

/// `spawn_weight` on a decoded mod.
fn spawn_weight_pre(p: &Pre, tags: &HashSet<String>, inf: &[(String, String)]) -> (f64, Option<String>) {
    let hit = |k: &str| tags.contains(k) || inf.iter().any(|(_, t)| t == k);
    let mut w = 0.0;
    let mut by = None;
    for (i, k) in p.keys.iter().enumerate() {
        if hit(k) {
            by = inf.iter().find(|(_, t)| t == k).map(|(i, _)| i.clone());
            w = if by.is_some() && p.elevated { 1000.0 } else { p.vals.get(i).copied().unwrap_or(0.0) };
            break;
        }
    }
    for (i, k) in p.mkeys.iter().enumerate() {
        if hit(k) {
            w = w * p.mvals.get(i).copied().unwrap_or(100.0) / 100.0;
            break;
        }
    }
    (w, by)
}

/// `ItemClass:GetModSpawnWeight` (no restrict-tag flags: those come from uniques). Returns the weight and, when an influence
/// tag matched, that influence.
fn spawn_weight(m: J, tags: &HashSet<String>, inf: &[(String, String)]) -> (f64, Option<String>) {
    let inf_of = |k: &str| inf.iter().find(|(_, t)| t == k).map(|(i, _)| i.clone());
    let hit = |k: &str| tags.contains(k) || inf.iter().any(|(_, t)| t == k);
    let keys = str_refs(m.get("weightKey"));
    let vals = num_list(m.get("weightVal"));
    let mut w = 0.0;
    let mut by = None;
    for (i, k) in keys.iter().enumerate() {
        if hit(k) {
            by = inf_of(k);
            w = if by.is_some() && jstr(m, "affix").contains("Elevated") { 1000.0 } else { vals.get(i).copied().unwrap_or(0.0) };
            break;
        }
    }
    let mk = str_refs(m.get("weightMultiplierKey"));
    let mv = num_list(m.get("weightMultiplierVal"));
    for (i, k) in mk.iter().enumerate() {
        if hit(k) {
            w = w * mv.get(i).copied().unwrap_or(100.0) / 100.0;
            break;
        }
    }
    (w, by)
}

/// Every number in a modifier line: `(a-b)` ranges (either end may be negative) and plain numbers. A `-` right before a
/// range or number at the start of a word negates it.
pub fn stat_values(line: &str) -> Vec<Range> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let num_at = |mut j: usize| -> Option<(f64, usize)> {
        let s = j;
        if j < b.len() && b[j] == b'-' {
            j += 1;
        }
        let d = j;
        while j < b.len() && (b[j].is_ascii_digit() || (b[j] == b'.' && j + 1 < b.len() && b[j + 1].is_ascii_digit())) {
            j += 1;
        }
        if j == d {
            return None;
        }
        line[s..j].parse().ok().map(|v| (v, j))
    };
    let negated = |i: usize| i > 0 && b[i - 1] == b'-' && (i == 1 || !b[i - 2].is_ascii_alphanumeric());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'(' {
            if let Some((lo, j)) = num_at(i + 1) {
                if j < b.len() && b[j] == b'-' {
                    if let Some((hi, k)) = num_at(j + 1) {
                        if k < b.len() && b[k] == b')' {
                            let (lo, hi) = if negated(i) { (-hi, -lo) } else { (lo, hi) };
                            out.push(Range { min: lo.min(hi), max: lo.max(hi) });
                            i = k + 1;
                            continue;
                        }
                    }
                }
            }
        }
        if b[i].is_ascii_digit() && (i == 0 || !b[i - 1].is_ascii_alphabetic() && b[i - 1] != b'.') {
            if let Some((v, j)) = num_at(i) {
                let v = if negated(i) { -v } else { v };
                out.push(Range { min: v, max: v });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// One candidate before tiering.
struct Cand {
    m: J,
    id: String,
    prefix: Option<bool>,
    source: &'static str,
    weight: f64,
    influence: Option<String>,
    essence: Option<String>,
}

fn trailing_num(id: &str) -> u64 {
    let n = id.len() - id.trim_end_matches(|c: char| c.is_ascii_digit()).len();
    id[id.len() - n..].parse().unwrap_or(0)
}

fn level_of(m: J) -> u32 {
    m.get("level").and_then(|l| l.as_f64()).unwrap_or(0.0).max(0.0) as u32
}

/// Ranks each candidate in its ladder: same tier family, same type, same stat order (eldritch implicits: same group),
/// lowest level first; tier 1 is the highest.
fn tiered(cands: Vec<Cand>) -> Vec<PoolMod> {
    let family = |c: &Cand| match c.source {
        "influence" | "elevated" => "normal",
        s => s,
    };
    let orders: Vec<Vec<f64>> = cands.iter().map(|c| num_list(c.m.get("statOrder"))).collect();
    let mut ladders: HashMap<(&str, Option<bool>, Vec<u64>, String), Vec<usize>> = HashMap::new();
    for (i, c) in cands.iter().enumerate() {
        let eldritch = matches!(c.source, "exarch" | "eater");
        let key = (family(c), c.prefix, if eldritch { Vec::new() } else { orders[i].iter().map(|x| x.to_bits()).collect() }, if eldritch { jstr(c.m, "group") } else { String::new() });
        ladders.entry(key).or_default().push(i);
    }
    let mut tier = vec![(0u32, 0u32); cands.len()];
    for idx in ladders.values_mut() {
        idx.sort_by(|&a, &b| {
            let (x, y) = (&cands[a], &cands[b]);
            level_of(x.m).cmp(&level_of(y.m)).then(trailing_num(&x.id).cmp(&trailing_num(&y.id))).then(x.id.cmp(&y.id))
        });
        let n = idx.len() as u32;
        for (r, &i) in idx.iter().enumerate() {
            tier[i] = (n - r as u32, n);
        }
    }
    let mut out: Vec<(Vec<f64>, PoolMod)> = cands
        .into_iter()
        .zip(tier)
        .zip(orders)
        .map(|((c, (t, n)), order)| {
            let level = level_of(c.m);
            let pm = PoolMod {
                affix: jstr(c.m, "affix"),
                group: jstr(c.m, "group"),
                tier: t,
                tiers: n,
                level,
                req_level: (level as f64 * 0.8).floor() as u32,
                weight: c.weight,
                stats: mod_lines(c.m).into_iter().map(|l| StatLine { values: stat_values(&l), text: l }).collect(),
                tags: str_list(c.m.get("modTags")),
                source: c.source,
                influence: c.influence,
                essence: c.essence,
                id: c.id,
            };
            (order, pm)
        })
        .collect();
    out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(a.1.source.cmp(b.1.source)).then(a.1.tier.cmp(&b.1.tier)).then(a.1.id.cmp(&b.1.id)));
    out.into_iter().map(|x| x.1).collect()
}

fn anoints(game: &GameData) -> Vec<Anoint> {
    let mut v: Vec<Anoint> = game
        .tree()
        .nodes
        .values()
        .filter_map(|n| {
            let oils = str_list(n.extra.get("recipe").copied());
            (!oils.is_empty()).then(|| Anoint { node_id: n.id.unwrap_or(0), name: n.dn.clone().unwrap_or_default(), stats: n.sd.clone(), oils })
        })
        .collect();
    v.sort_by(|a, b| a.name.cmp(&b.name));
    v
}

fn build(game: &GameData, base_name: &str, inf_keys: &[String], extra: &[String]) -> Result<ModPool, String> {
    let base = game.item_bases.get(base_name).ok_or_else(|| format!("unknown base {base_name}"))?;
    let ty = base.base_type.clone().unwrap_or_default();
    let sub = base.extra.get("subType").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let mut tags: HashSet<String> = base.tags.iter().filter(|(_, v)| **v).map(|(k, _)| k.clone()).collect();
    tags.extend(extra.iter().cloned());
    let inf_tags = base.extra.get("influenceTags").copied();
    let inf: Vec<(String, String)> = inf_keys.iter().filter_map(|k| Some((k.clone(), inf_tags?.get(k.as_str())?.as_str()?.to_string()))).collect();
    let mods = game.extra.get("itemMods")?.ok_or("no item mods")?;
    let table_name = [format!("{ty}{sub}"), ty.clone(), "Item".to_string()].into_iter().find(|t| mods.get(t.as_str()).is_some()).unwrap_or_else(|| "Item".into());
    let table = mods.get(table_name.as_str()).ok_or("no affix table")?;
    let is_prefix = |m: J| match jstr(m, "type").as_str() {
        "Prefix" => Some(true),
        "Suffix" => Some(false),
        _ => None,
    };
    let mut cands: Vec<Cand> = Vec::new();
    let mut implicit_cands: Vec<Cand> = Vec::new();
    let mut corrupted: Vec<PoolMod> = Vec::new();
    let armour = ["Helmet", "Body Armour", "Gloves", "Boots"].contains(&ty.as_str());
    // An elevated (Maven) mod upgrades an influenced mod: it needs a normal twin (same group) that spawns here, under the same influence.
    let mut twins: HashSet<(String, String)> = HashSet::new();
    // (each mod's weight is worked out once, here, and read again below)
    let pre = pre_table(game, &table_name, table, mods)?;
    let mut weights: Vec<(f64, Option<String>)> = Vec::with_capacity(pre.len());
    for p in pre.iter() {
        let (w, by) = spawn_weight_pre(p, &tags, &inf);
        if let (false, true, Some(i)) = (p.elevated, w > 0.0, &by) {
            twins.insert((p.group.to_string(), i.clone()));
        }
        weights.push((w, by));
    }
    // Upstream's combined `Item` table also holds the Mercenary-only mods (Data.lua 686); they are not craftable.
    let merc = mods.get("Mercenary");
    for (p, (w, by)) in pre.iter().zip(weights) {
        let (id, m) = (p.id, p.m);
        if merc.is_some_and(|t| t.get(id).is_some()) {
            continue;
        }
        if w <= 0.0 {
            continue;
        }
        if let (Some(i), true) = (&by, p.elevated) {
            if !group_keys(p.group, true).into_iter().any(|g| twins.contains(&(g, i.clone()))) {
                continue;
            }
        }
        let kind = jstr(m, "type");
        if let Some(p) = is_prefix(m) {
            let delve = matches!(jstr(m, "affix").as_str(), "Subterranean" | "of the Underground");
            let source = if delve {
                "delve"
            } else if by.is_some() && jstr(m, "affix").contains("Elevated") {
                "elevated"
            } else if by.is_some() {
                "influence"
            } else {
                "normal"
            };
            cands.push(Cand { m, id: id.to_string(), prefix: Some(p), source, weight: w, influence: by, essence: None });
        } else if kind == "Corrupted" {
            corrupted.extend(tiered(vec![Cand { m, id: id.to_string(), prefix: None, source: "corrupted", weight: w, influence: by, essence: None }]));
        } else if armour && (kind == "Exarch" || kind == "Eater") {
            let source = if kind == "Exarch" { "exarch" } else { "eater" };
            implicit_cands.push(Cand { m, id: id.to_string(), prefix: None, source, weight: w, influence: None, essence: None });
        }
    }
    let no_extras = ["Tincture", "Graft"].contains(&ty.as_str());
    // The crafting bench: every modifier whose item types include this one (`ModMaster.lua`).
    if !no_extras && ty != "Jewel" {
        if let Some(a) = game.extra.get("masterMods")?.and_then(|a| a.as_array()) {
            for (i, m) in a.iter().enumerate() {
                if m.get("types").and_then(|t| t.get(ty.as_str())).is_some() {
                    cands.push(Cand { m, id: format!("master{i}"), prefix: is_prefix(m), source: "bench", weight: 0.0, influence: None, essence: None });
                }
            }
        }
    }
    if !no_extras && ty != "Jewel" && ty != "Flask" {
        // Essences: each essence names the modifier it forces for each item type (`Essence.lua`).
        if let Some(o) = game.extra.get("essences")?.and_then(|o| o.as_object()) {
            for (_, e) in o.iter() {
                let Some(id) = e.get("mods").and_then(|m| m.get(ty.as_str())).and_then(|x| x.as_str()) else { continue };
                let Some(ent) = table.get(id) else { continue };
                let m = resolve(mods, ent);
                cands.push(Cand { m, id: id.to_string(), prefix: is_prefix(m), source: "essence", weight: 0.0, influence: None, essence: Some(jstr(e, "name")) });
            }
        }
        if let Some(o) = game.extra.get("veiledMods")?.and_then(|o| o.as_object()) {
            for (id, m) in o.iter() {
                let (w, _) = spawn_weight(m, &tags, &inf);
                if w > 0.0 {
                    cands.push(Cand { m, id: id.to_string(), prefix: is_prefix(m), source: "veiled", weight: w, influence: None, essence: None });
                }
            }
        }
    }
    let (mut prefixes, mut suffixes) = (Vec::new(), Vec::new());
    for c in cands {
        match c.prefix {
            Some(true) => prefixes.push(c),
            Some(false) => suffixes.push(c),
            None => {}
        }
    }
    let (pl, sl) = match ty.as_str() {
        "Flask" | "Tincture" => (1, 1),
        "Jewel" | "Graft" => (2, 2),
        _ => (3, 3),
    };
    let anointable = ty == "Amulet" && sub != "Talisman" && !base.extra.get("cannotBeAnointed").is_some_and(|v| v.as_bool().unwrap_or(false));
    static ANOINTS: OnceLock<Vec<Anoint>> = OnceLock::new();
    let mut cluster_skills = Vec::new();
    if let Some(o) = game.extra.get("clusterJewels")?.and_then(|c| c.get("jewels")).and_then(|j| j.get(base_name)).and_then(|j| j.get("skills")).and_then(|s| s.as_object()) {
        for (id, sk) in o.iter() {
            // The attribute skills are legacy: upstream's craft dialog hides them too. So are the "old_do_not_use" ones (Curse Effect, Aura Effect), which cannot drop.
            if ["affliction_strength", "affliction_dexterity", "affliction_intelligence"].contains(&id) || jstr(sk, "tag").starts_with("old_do_not_use") {
                continue;
            }
            cluster_skills.push(ClusterSkill { id: id.to_string(), name: jstr(sk, "name"), tag: jstr(sk, "tag"), enchant: str_list(sk.get("enchant")) });
        }
        cluster_skills.sort_by(|a, b| a.name.cmp(&b.name));
    }
    Ok(ModPool {
        base: base_name.to_string(),
        base_type: ty,
        item_level: 0,
        prefix_limit: pl,
        suffix_limit: sl,
        prefixes: tiered(prefixes),
        suffixes: tiered(suffixes),
        implicits: tiered(implicit_cands),
        anoints: if anointable { ANOINTS.get_or_init(|| anoints(game)).clone() } else { Vec::new() },
        cluster_skills,
        corrupted,
    })
}

/// The influences `base` can carry, as the keys the base's `influenceTags` uses (shaper, elder, adjudicator, ...).
pub fn base_influences(game: &GameData, base: &str) -> Result<Vec<String>, String> {
    let b = game.item_bases.get(base).ok_or_else(|| format!("unknown base {base}"))?;
    Ok(b.extra.get("influenceTags").and_then(|o| o.as_object()).map(|o| o.iter().map(|(k, _)| k.to_string()).collect()).unwrap_or_default())
}

/// The enchant table for a base: skill -> tier -> lines, under the base's type key (flasks: Flask or UtilityFlask).
pub fn enchant_table(game: &GameData, base: &str) -> Result<Option<J>, String> {
    let b = game.item_bases.get(base).ok_or_else(|| format!("unknown base {base}"))?;
    let key = if b.extra.get("flask").is_some() {
        if b.tags.get("utility_flask").copied().unwrap_or(false) { "UtilityFlask" } else { "Flask" }
    } else {
        b.base_type.as_deref().unwrap_or("")
    };
    Ok(game.extra.get("enchantments")?.and_then(|e| e.get(key)))
}

/// Every enchant `base` can get, flat, sorted by skill then tier name. Helmets list skill -> tier -> lines; the other
/// types list tier -> lines (skill empty), often as a `{"$ref": "data.enchantments.Bow.HARVEST"}` to another type's list.
pub fn enchants(game: &GameData, base: &str) -> Result<Vec<Enchant>, String> {
    let mut out = Vec::new();
    let Some(root) = game.extra.get("enchantments")? else { return Ok(out) };
    let follow = |v: J| -> J { v.get("$ref").and_then(|r| r.as_str()).and_then(|r| r.split('.').skip(2).try_fold(root, |x, k| x.get(k))).unwrap_or(v) };
    for (skill, tiers) in enchant_table(game, base)?.map(follow).and_then(|t| t.as_object()).into_iter().flatten() {
        let tiers = follow(tiers);
        if tiers.as_array().is_some() {
            out.push(Enchant { skill: String::new(), tier: skill.to_string(), lines: str_list(Some(tiers)) });
            continue;
        }
        for (tier, lines) in tiers.as_object().into_iter().flatten() {
            out.push(Enchant { skill: skill.to_string(), tier: tier.to_string(), lines: str_list(Some(follow(lines))) });
        }
    }
    out.sort_by(|a, b| a.skill.cmp(&b.skill).then(a.tier.cmp(&b.tier)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game() -> &'static GameData {
        static G: OnceLock<GameData> = OnceLock::new();
        G.get_or_init(|| {
            let dir = if std::path::Path::new("../../engine-data").exists() { "../../engine-data" } else { "engine-data" };
            GameData::load(std::path::Path::new(dir)).expect("load GameData")
        })
    }

    fn find<'a>(v: &'a [PoolMod], id: &str) -> Option<&'a PoolMod> {
        // Essences reuse normal modifier ids; this finds the normal roll.
        v.iter().find(|m| m.id == id && matches!(m.source, "normal" | "influence" | "elevated"))
    }

    #[test]
    fn stat_values_parse() {
        assert_eq!(stat_values("+(91-100) to maximum Energy Shield"), vec![Range { min: 91.0, max: 100.0 }]);
        assert_eq!(stat_values("Adds (14-16) to (20-22) Cold Damage"), vec![Range { min: 14.0, max: 16.0 }, Range { min: 20.0, max: 22.0 }]);
        assert_eq!(stat_values("(0.2-0.4)% of Physical Attack Damage Leeched as Life"), vec![Range { min: 0.2, max: 0.4 }]);
        assert_eq!(stat_values("-(20-10)% to Fire Resistance"), vec![Range { min: -20.0, max: -10.0 }]);
        assert_eq!(stat_values("(-10-10)% increased Charges"), vec![Range { min: -10.0, max: 10.0 }]);
        assert_eq!(stat_values("1 Added Passive Skill is Adrenaline"), vec![Range { min: 1.0, max: 1.0 }]);
    }

    // Expectations from upstream's Data/ModExplicit.lua and Data/ModFlask.lua (2.67.2).
    #[test]
    fn known_bases_match_mod_data() {
        let g = game();
        let o = PoolOptions::default();
        // Vaal Regalia (int_armour): LocalIncreasedEnergyShield1..11, tier 1 "Resplendent" +(91-100), level 75.
        let p = mod_pool(g, "Vaal Regalia", 84, &o).unwrap();
        let es = find(&p.prefixes, "LocalIncreasedEnergyShield11").expect("T1 local ES");
        assert_eq!((es.tier, es.tiers, es.level, es.source), (1, 11, 75, "normal"));
        assert_eq!(es.stats[0].values, vec![Range { min: 91.0, max: 100.0 }]);
        assert_eq!(find(&p.prefixes, "LocalIncreasedEnergyShield1").unwrap().tier, 11);
        // Body armour life: IncreasedLife0..12; IncreasedLife12 (Prime, level 86) is tier 1 and needs ilvl 86.
        assert!(find(&p.prefixes, "IncreasedLife12").is_none());
        let life = find(&p.prefixes, "IncreasedLife11").expect("T2 life");
        assert_eq!((life.tier, life.tiers, life.affix.as_str()), (2, 13, "Rapturous"));
        assert_eq!(find(&mod_pool(g, "Vaal Regalia", 86, &o).unwrap().prefixes, "IncreasedLife12").unwrap().tier, 1);
        // Flat ES of jewellery does not roll on body armour; nothing above ilvl 84 is in the pool.
        assert!(find(&p.prefixes, "IncreasedEnergyShield1").is_none());
        assert!(p.prefixes.iter().chain(&p.suffixes).filter(|m| m.source != "essence" && m.source != "bench").all(|m| m.level <= 84));
        assert!(p.prefixes.iter().any(|m| m.source == "bench") && p.suffixes.iter().any(|m| m.source == "essence"));
        assert!(p.implicits.iter().any(|m| m.source == "exarch") && p.implicits.iter().any(|m| m.source == "eater"));
        assert_eq!((p.prefix_limit, p.suffix_limit), (3, 3));
        // Influence: shaper adds influence modifiers that need it.
        let s = mod_pool(g, "Vaal Regalia", 84, &PoolOptions { influences: vec!["Shaper".into()], ..Default::default() }).unwrap();
        assert!(!p.prefixes.iter().chain(&p.suffixes).any(|m| m.source == "influence"));
        assert!(s.prefixes.iter().chain(&s.suffixes).any(|m| m.source == "influence" && m.influence.as_deref() == Some("shaper")));
        // Divine Life Flask: FlaskIncreasedRecoverySpeed1..5, tier 1 "Catalysed" (65-70)% level 81; not on utility flasks.
        let f = mod_pool(g, "Divine Life Flask", 84, &o).unwrap();
        let rec = find(&f.prefixes, "FlaskIncreasedRecoverySpeed5").expect("T1 recovery");
        assert_eq!((rec.tier, rec.tiers), (1, 5));
        assert_eq!(rec.stats[0].values, vec![Range { min: 65.0, max: 70.0 }]);
        assert!(find(&mod_pool(g, "Quicksilver Flask", 84, &o).unwrap().prefixes, "FlaskIncreasedRecoverySpeed5").is_none());
        // Amulets list anoints; cluster jewels list their skills and need the skill tag for notables.
        assert!(!mod_pool(g, "Onyx Amulet", 84, &o).unwrap().anoints.is_empty());
        let c = mod_pool(g, "Large Cluster Jewel", 84, &o).unwrap();
        let skill = c.cluster_skills.first().expect("cluster skills").tag.clone();
        let c2 = mod_pool(g, "Large Cluster Jewel", 84, &PoolOptions { extra_tags: vec![skill], ..Default::default() }).unwrap();
        assert!(c2.prefixes.len() + c2.suffixes.len() > c.prefixes.len() + c.suffixes.len());
        assert_eq!(mod_pool(g, "Cobalt Jewel", 84, &o).unwrap().prefix_limit, 2);
        assert!(!mod_pool(g, "Murderous Eye Jewel", 84, &o).unwrap().suffixes.is_empty());
        assert!(mod_pool(g, "No Such Base", 84, &o).is_err());
    }

    #[test]
    fn no_legacy_cluster_skills() {
        for base in ["Small Cluster Jewel", "Medium Cluster Jewel", "Large Cluster Jewel"] {
            let p = mod_pool(game(), base, 84, &PoolOptions::default()).unwrap();
            let bad: Vec<&str> = p.cluster_skills.iter().filter(|s| s.tag.starts_with("old_do_not_use")).map(|s| s.name.as_str()).collect();
            println!("{base} legacy skills: {bad:?}");
            assert!(bad.is_empty());
        }
    }

    #[test]
    fn no_mercenary_mods() {
        let p = mod_pool(game(), "Battery Staff", 86, &PoolOptions::default()).unwrap();
        let bad: Vec<&str> = p.prefixes.iter().chain(&p.suffixes).filter(|m| m.id.starts_with("MercenaryMod")).map(|m| m.id.as_str()).collect();
        println!("mercenary mods in Battery Staff pool: {bad:?}");
        assert!(bad.is_empty());
    }

    #[test]
    fn corrupted_enchants_influences() {
        let g = game();
        let p = mod_pool(g, "Onyx Amulet", 100, &PoolOptions::default()).unwrap();
        println!("amulet corrupted: {} {:?}", p.corrupted.len(), p.corrupted.iter().map(|m| m.id.as_str()).take(4).collect::<Vec<_>>());
        assert!(!p.corrupted.is_empty() && p.corrupted.iter().all(|m| m.id.contains("V2") && m.weight > 0.0));
        let h = enchants(g, "Hubris Circlet").unwrap();
        let endgame = h.iter().filter(|e| e.tier == "ENDGAME").count();
        println!("helmet enchants: {} ({endgame} ENDGAME)", h.len());
        assert!(h.iter().any(|e| e.skill == "Absolution" && e.tier == "ENDGAME" && !e.lines.is_empty()));
        let inf = base_influences(g, "Vaal Regalia").unwrap();
        println!("Vaal Regalia influences: {inf:?}");
        assert!(inf.iter().any(|i| i == "shaper") && base_influences(g, "Cobalt Jewel").unwrap().is_empty());
    }

    #[test]
    fn cached_query_is_fast() {
        let g = game();
        let o = PoolOptions::default();
        mod_pool(g, "Imbued Wand", 84, &o).unwrap();
        let t = std::time::Instant::now();
        for il in 1..=100 {
            mod_pool(g, "Imbued Wand", il, &o).unwrap();
        }
        let per = t.elapsed().as_secs_f64() / 100.0;
        assert!(per < 0.005, "cached query took {per}s");
    }
}
