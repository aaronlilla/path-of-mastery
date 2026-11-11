//! Item display for the app's Items tab: the item tooltip as upstream draws it (`ItemsTabClass:AddItemTooltip`),
//! what the item editor needs from a parsed item, and the item catalog (bases, uniques, rare templates).
//!
//! Colours are returned as names, not hex: the renderer maps each name to a design token. A line is
//! `{"k": "title"|"big"|"tip"|"sep", "segs": [{"c": colour name|null, "t": text}]}`.
use pom_engine::data::GameData;
use pom_item::item::{Item, ModLine, INFLUENCE_KEYS};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

mod flask;
mod foulborn;
mod gemtip;
mod pools;
pub use pools::apply_affixes;

/// The numbers a tooltip colours requirements against.
#[derive(Clone, Copy, Default)]
pub struct Player {
    pub level: Option<f64>,
    pub str_: Option<f64>,
    pub dex: Option<f64>,
    pub int: Option<f64>,
}

fn seg(c: Option<&str>, t: impl Into<String>) -> Value {
    json!({ "c": c, "t": t.into() })
}

fn line(k: &str, segs: Vec<Value>) -> Value {
    json!({ "k": k, "segs": segs })
}

fn sep() -> Value {
    json!({ "k": "sep", "segs": [] })
}

/// `main:StatColor(stat, base, limit)`.
fn stat_color(stat: f64, base: Option<f64>, limit: Option<f64>) -> Option<&'static str> {
    if limit.is_some_and(|l| stat > l) {
        Some("negative")
    } else if base.is_some_and(|b| stat != b) {
        Some("magic")
    } else {
        None
    }
}

fn rarity_colour(r: &str) -> &'static str {
    match r {
        "NORMAL" => "normal",
        "MAGIC" => "magic",
        "RARE" => "rare",
        "UNIQUE" => "unique",
        "RELIC" => "relic",
        _ => "normal",
    }
}

fn influence_display(key: &str) -> &'static str {
    match key {
        "shaper" => "Shaper",
        "elder" => "Elder",
        "adjudicator" => "Warlord",
        "basilisk" => "Hunter",
        "crusader" => "Crusader",
        "eyrie" => "Redeemer",
        "cleansing" => "Searing Exarch",
        "tangle" => "Eater of Worlds",
        _ => "",
    }
}

const CATALYSTS: [&str; 12] = ["Abrasive", "Accelerating", "Dextral", "Fertile", "Imbued", "Intrinsic", "Noxious", "Prismatic", "Sinistral", "Tempering", "Turbulent", "Unstable"];
const CATALYST_DESC: [&str; 12] = ["Attack", "Speed", "Suffix", "Life and Mana", "Caster", "Attribute", "Physical and Chaos", "Resistance", "Prefix", "Defence", "Elemental", "Critical"];

fn jf(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(|x| x.as_f64())
}

fn has_influence(item: &Item, key: &str) -> bool {
    item.influence.get(key).copied().unwrap_or(false)
}

/// The variant rule of `ItemClass:CheckModLineVariant` for items without variant groups (the parser has already
/// resolved variant groups into an always or never matching list).
fn line_active(item: &Item, ml: &ModLine) -> bool {
    match &ml.variant_list {
        None => true,
        Some(list) => {
            if item.variant_count == 0 {
                return true;
            }
            let sel = item.selected_variant.unwrap_or(item.variant_count);
            list.contains(&sel) || item.alt_variants.iter().any(|v| list.contains(v))
        }
    }
}

fn has_bare_range(s: &str) -> bool {
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'(' {
            let mut j = i + 1;
            if j < b.len() && b[j] == b'-' {
                j += 1;
            }
            let ds = j;
            while j < b.len() && (b[j].is_ascii_digit() || b[j] == b'.') {
                j += 1;
            }
            if j > ds && j < b.len() && b[j] == b'-' {
                j += 1;
                if j < b.len() && b[j] == b'-' {
                    j += 1;
                }
                let es = j;
                while j < b.len() && (b[j].is_ascii_digit() || b[j] == b'.') {
                    j += 1;
                }
                if j > es && j < b.len() && b[j] == b')' {
                    return true;
                }
            }
        }
        i += 1;
    }
    false
}

/// The "hide zero-value modifiers" hack of `itemLib.formatModLine`.
fn is_zero_line(l: &str) -> bool {
    let b = l.strip_prefix('+').unwrap_or(l);
    if let Some(rest) = b.strip_prefix('0') {
        let rest = rest.strip_prefix('%').unwrap_or(rest);
        if rest.starts_with(' ') {
            return true;
        }
    }
    let spaced = [" 0 ", " 0% ", " +0 ", " +0% "].iter().any(|p| l.contains(p));
    if spaced && !(0..10).any(|d| d > 0 && l.contains(&format!("0 to {d}"))) {
        return true;
    }
    l.contains(" 0-0 ") || l.contains(" 0 to 0 ")
}

/// A mod line's display text and colour (`itemLib.formatModLine`); `None` when upstream hides it.
fn mod_display(ml: &ModLine, db_mode: bool, game: &GameData) -> Option<(String, &'static str)> {
    let apply = !db_mode && (ml.range.is_some() || ml.corrupted_range.is_some());
    let text = if apply {
        pom_item::parse::apply_range_display(&ml.line, ml.range.unwrap_or(0.5), ml.value_scalar.unwrap_or(1.0), ml.corrupted_range.unwrap_or(1.0), game)
    } else {
        ml.line.clone()
    };
    if is_zero_line(&text) {
        return None;
    }
    if ml.disabled {
        return Some((text, "disabled"));
    }
    if ml.extra.is_some() {
        return Some((text, "unsupported"));
    }
    let c = if ml.fractured {
        "fractured"
    } else if ml.crafted {
        "crafted"
    } else if ml.mutated {
        "mutated"
    } else if ml.scourge {
        "scourge"
    } else if ml.custom {
        "custom"
    } else if ml.crucible {
        "crucible"
    } else if ml.vestigial {
        "vestigial"
    } else {
        "magic"
    };
    Some((text, c))
}

fn weapon_label(game: &GameData, base: &pom_engine::data::ItemBase) -> String {
    let ty = base.base_type.clone().unwrap_or_default();
    let label = game.extra.get("weaponTypeInfo").ok().flatten().and_then(|w| w.get(ty.as_str())).and_then(|i| i.get("label")).and_then(|l| l.as_str().map(|s| s.to_string()));
    label.or_else(|| base.extra.get("subType").and_then(|s| s.as_str()).map(|s| s.to_string())).unwrap_or(ty)
}

fn one_hand(game: &GameData, ty: &str) -> Option<bool> {
    game.extra.get("weaponTypeInfo").ok().flatten().and_then(|w| w.get(ty)).and_then(|i| i.get("oneHand")).and_then(|b| b.as_bool())
}

fn n0(v: f64) -> String {
    format!("{}", v.round() as i64)
}

fn requirement_segs(item: &Item, p: &Player) -> Option<Value> {
    let r = &item.requirements;
    let mut parts: Vec<Vec<Value>> = Vec::new();
    if let Some(level) = r.level.filter(|l| *l > 0.0) {
        let c = stat_color(level, None, p.level);
        parts.push(vec![seg(Some("muted"), "Level "), seg(c, n0(level))]);
    }
    let attr = |v: Option<f64>, base: f64, have: Option<f64>, name: &str, parts: &mut Vec<Vec<Value>>| {
        if let Some(v) = v {
            if v > 14.0 || have.is_some_and(|h| v > h) {
                let c = stat_color(v, Some(base), have);
                parts.push(vec![seg(c, n0(v)), seg(Some("muted"), format!(" {name}"))]);
            }
        }
    };
    attr(r.str_mod, r.str_, p.str_, "Str", &mut parts);
    attr(r.dex_mod, r.dex, p.dex, "Dex", &mut parts);
    attr(r.int_mod, r.int, p.int, "Int", &mut parts);
    if parts.is_empty() {
        return None;
    }
    let mut segs = vec![seg(Some("muted"), "Requires ")];
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            segs.push(seg(Some("muted"), ", "));
        }
        segs.extend(part);
    }
    Some(line("big", segs))
}

fn socket_line(item: &Item) -> Vec<Value> {
    let mut segs = vec![seg(Some("muted"), "Sockets: ")];
    let mut group = 0;
    for (i, s) in item.sockets.iter().enumerate() {
        if i > 0 {
            if s.group == group {
                segs.push(seg(None, "="));
            } else {
                segs.push(seg(None, "  "));
            }
            group = s.group;
        } else {
            group = s.group;
        }
        let c = match s.color {
            'R' => "str",
            'G' => "dex",
            'B' => "int",
            'W' => "scion",
            _ => "socket-a",
        };
        segs.push(seg(Some(c), s.color.to_string()));
    }
    segs
}

fn add_inf(out: &mut Vec<&'static str>, n: &'static str) {
    if out.len() < 2 {
        out.push(n);
    }
}

/// `ItemsTabClass:SetTooltipHeaderInfluence`: the (up to) two icons beside the title.
fn header_influence(item: &Item) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    if has_influence(item, "cleansing") && has_influence(item, "tangle") {
        add_inf(&mut out, "Exarch");
        add_inf(&mut out, "Eater");
        return out;
    }
    if item.fractured {
        add_inf(&mut out, "Fractured");
    }
    if item.title.as_deref().is_some_and(|t| t.contains("Replica")) {
        add_inf(&mut out, "Experimented");
    }
    if item.foulborn {
        add_inf(&mut out, "Foulborn");
    }
    if item.veiled {
        add_inf(&mut out, "Veiled");
    }
    if has_influence(item, "cleansing") {
        add_inf(&mut out, "Exarch");
    }
    if has_influence(item, "tangle") {
        add_inf(&mut out, "Eater");
    }
    for (k, n) in [("shaper", "Shaper"), ("elder", "Elder"), ("crusader", "Crusader"), ("eyrie", "Redeemer"), ("basilisk", "Hunter"), ("adjudicator", "Warlord")] {
        if has_influence(item, k) {
            add_inf(&mut out, n);
        }
    }
    if item.synthesised && out.is_empty() {
        add_inf(&mut out, "Synthesis");
    }
    out
}

fn flavour_for(game: &GameData, title: &str) -> Option<Vec<String>> {
    let t = title.strip_prefix("Foulborn ").unwrap_or(title);
    let list = game.extra.get("flavourText").ok().flatten()?;
    let arr = list.as_array()?;
    for e in arr.iter() {
        if e.get("name").and_then(|n| n.as_str()) == Some(t) {
            let text = e.get("text")?.as_array()?;
            return Some(text.iter().filter_map(|l| l.as_str().map(|s| s.to_string())).collect());
        }
    }
    None
}

pub struct Opts {
    pub db_mode: bool,
    pub slot_num: usize,
    pub sanitise: bool,
}

/// Parses `text` and describes it: the tooltip lines and the facts the editor and slot pickers need.
/// Resolves an `itemMods` entry that is a reference (`{"$ref": "data.itemMods.Explicit.X"}`) to the entry itself.
fn mod_entry(mods: &pom_engine::cjson::J, table: &str, id: &str) -> Option<pom_engine::cjson::J> {
    let e = mods.get(table)?.get(id)?;
    if let Some(r) = e.get("$ref").and_then(|r| r.as_str()) {
        let mut parts = r.split('.').skip(2);
        let t = parts.next()?;
        let i = parts.next()?;
        return mods.get(t)?.get(i);
    }
    Some(e)
}

/// The item text the way upstream reads items from its databases and crafts them: a crafted item with only
/// `Prefix:`/`Suffix:` lines gets the modifier lines they stand for, a crafted rare gets its base's implicit, and a
/// database armour piece, weapon or flask has 20% quality.
fn prepare_text(game: &'static GameData, text: &str, opts: &Opts) -> String {
    let item = pom_item::parse::parse_raw_with_id(text, opts.sanitise, None, game);
    let Some(base) = item.base_name.as_ref().and_then(|n| game.item_bases.get(n)) else { return text.to_string() };
    let mut lines: Vec<String> = text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let mut changed = false;
    let strip = |l: &str| -> String {
        let mut s = l;
        while let Some(rest) = s.strip_prefix('{') {
            match rest.find('}') {
                Some(i) => s = &rest[i + 1..],
                None => break,
            }
        }
        s.trim().to_string()
    };
    let affix_lines: Vec<(bool, String, Option<String>)> = lines
        .iter()
        .filter_map(|l| {
            let (is_prefix, rest) = if let Some(r) = l.strip_prefix("Prefix:") { (true, r) } else if let Some(r) = l.strip_prefix("Suffix:") { (false, r) } else { return None };
            let rest = rest.trim();
            let range = rest.find("{range:").map(|i| rest[i + 7..].split('}').next().unwrap_or("").to_string());
            Some((is_prefix, strip(rest), range))
        })
        .filter(|(_, id, _)| id != "None")
        .collect();
    let implicit_count = item.enchant_mod_lines.len() + item.scourge_mod_lines.len() + item.implicit_mod_lines.len();
    // A crafted item's implicits, when it has none written.
    if opts.db_mode && item.crafted && implicit_count == 0 {
        if let Some(imp) = base.implicit.as_ref() {
            let imps: Vec<&str> = imp.lines().filter(|l| !l.trim().is_empty()).collect();
            if !imps.is_empty() {
                let at = lines.iter().position(|l| l.starts_with("Implicits:"));
                let mut block = vec![format!("Implicits: {}", imps.len())];
                block.extend(imps.iter().map(|s| s.to_string()));
                match at {
                    Some(i) => {
                        lines.remove(i);
                        for (k, b) in block.into_iter().enumerate() {
                            lines.insert(i + k, b);
                        }
                    }
                    None => {
                        let i = spec_end(&lines);
                        for (k, b) in block.into_iter().enumerate() {
                            lines.insert(i + k, b);
                        }
                    }
                }
                changed = true;
            }
        }
    }
    if item.explicit_mod_lines.is_empty() && !affix_lines.is_empty() {
        if let Ok(Some(mods)) = game.extra.get("itemMods") {
            let ty = base.base_type.clone().unwrap_or_default();
            let sub = base.extra.get("subType").and_then(|s| s.as_str()).unwrap_or("");
            let table = [format!("{ty}{sub}"), ty.clone(), "Item".to_string()].into_iter().find(|t| mods.get(t.as_str()).is_some()).unwrap_or_else(|| "Item".into());
            let mut add: Vec<String> = Vec::new();
            let mut level = base.req.as_ref().and_then(|r| r.get("level")).copied().unwrap_or(0.0);
            for (is_prefix, id, range) in &affix_lines {
                let Some(m) = mod_entry(&mods, &table, id) else { continue };
                level = level.max((m.get("level").and_then(|l| l.as_f64()).unwrap_or(0.0) * 0.8).floor());
                let tags: Vec<String> = m.get("modTags").and_then(|t| t.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
                let mut k = 1;
                while let Some(l) = m.get(k.to_string().as_str()).and_then(|l| l.as_str()) {
                    let mut t = String::new();
                    if !tags.is_empty() {
                        t.push_str(&format!("{{tags:{}}}", tags.join(",")));
                    }
                    t.push_str(if *is_prefix { "{prefix}" } else { "{suffix}" });
                    if let Some(r) = range {
                        t.push_str(&format!("{{range:{r}}}"));
                    }
                    t.push_str(l);
                    add.push(t);
                    k += 1;
                }
            }
            if !add.is_empty() {
                let mut at = lines.len();
                while at > 0 && ["Corrupted", "Mirrored", "Split", "Fractured Item", "Synthesised Item"].contains(&lines[at - 1].as_str()) {
                    at -= 1;
                }
                for (k, a) in add.into_iter().enumerate() {
                    lines.insert(at + k, a);
                }
                if !lines.iter().any(|l| l.starts_with("LevelReq:")) && level > 0.0 {
                    let i = lines.iter().position(|l| l.starts_with("Implicits:")).unwrap_or_else(|| anchor_after_base(&lines));
                    lines.insert(i, format!("LevelReq: {}", level as i64));
                }
                changed = true;
            }
        }
    }
    if opts.db_mode && item.quality.is_none_or(|q| q == 0.0) && !lines.iter().any(|l| l.starts_with("Quality:")) && !item.corrupted && !item.mirrored && !item.split && (base.armour.is_some() || base.weapon.is_some() || base.extra.get("flask").is_some() || base.extra.get("tincture").is_some()) && !lines.iter().any(|l| l.starts_with("Unique ID:")) {
        let i = lines.iter().position(|l| l.starts_with("Implicits:")).unwrap_or_else(|| anchor_after_base(&lines));
        lines.insert(i, "Quality: 20".to_string());
        changed = true;
    }
    if changed { lines.join("\n") } else { text.to_string() }
}

/// Index after the header's `Name: value` lines, where an `Implicits:` count and the modifier lines begin.
fn spec_end(lines: &[String]) -> usize {
    const SPECS: [&str; 18] = ["Crafted:", "Prefix:", "Suffix:", "Quality:", "Sockets:", "LevelReq:", "Item Level:", "League:", "Source:", "Variant:", "Selected Variant:", "Requires Level", "Unique ID:", "Catalyst:", "CatalystQuality:", "Radius:", "Limited to:", "Talisman Tier:"];
    let mut i = anchor_after_base(lines);
    while i < lines.len() && SPECS.iter().any(|s| lines[i].starts_with(s)) {
        i += 1;
    }
    i
}

/// Index of the first line after the item's name and base lines.
fn anchor_after_base(lines: &[String]) -> usize {
    let mut i = 0;
    if lines.first().is_some_and(|l| l.starts_with("Item Class:")) {
        i += 1;
    }
    let mut titled = true;
    if lines.get(i).is_some_and(|l| l.starts_with("Rarity:")) {
        let r = lines[i].to_uppercase();
        titled = r.contains("RARE") || r.contains("UNIQUE") || r.contains("RELIC");
        i += 1;
    }
    (i + if titled { 2 } else { 1 }).min(lines.len())
}

pub fn item_info(game: &'static GameData, text: &str, player: &Player, opts: &Opts) -> Value {
    let prepared = prepare_text(game, text, opts);
    let text = prepared.as_str();
    let item = pom_item::parse::parse_raw_with_id(text, opts.sanitise, None, game);
    let Some(base_name) = item.base_name.clone() else {
        return json!({ "valid": false, "name": item.title.clone().unwrap_or(item.name.clone()), "lines": [
            line("title", vec![seg(Some("normal"), item.title.clone().unwrap_or(item.name.clone()))]),
            sep(),
            line("big", vec![seg(Some("negative"), "Item base is not supported by the current version.")]),
        ] });
    };
    let Some(base) = game.item_bases.get(&base_name) else {
        return json!({ "valid": false, "name": item.name });
    };
    let rarity = item.rarity.clone();
    let rc = rarity_colour(&rarity);
    let ty = item.item_type.clone().unwrap_or_default();
    let mut lines: Vec<Value> = Vec::new();
    let clean_base = match base_name.find(" (") {
        Some(i) if base_name.ends_with(')') => base_name[..i].to_string(),
        _ => base_name.clone(),
    };
    let header_inf = header_influence(&item);

    if let Some(title) = &item.title {
        lines.push(line("title", vec![seg(Some(rc), title.clone())]));
        lines.push(line("title", vec![seg(Some(rc), clean_base.clone())]));
    } else {
        lines.push(line("title", vec![seg(Some(rc), format!("{}{}{}", item.name_prefix, clean_base, item.name_suffix))]));
    }
    lines.push(sep());

    // Source, league and variant lines, as the item browser shows them.
    if opts.db_mode {
        let variants: Vec<String> = text.lines().filter_map(|l| l.trim().strip_prefix("Variant:").map(|s| s.trim().to_string())).collect();
        if variants.len() == 1 {
            lines.push(line("big", vec![seg(Some("rare"), format!("Variant: {}", variants[0]))]));
        } else if variants.len() > 1 {
            let sel = (item.selected_variant.unwrap_or(item.variant_count).max(1) as usize).min(variants.len());
            lines.push(line("big", vec![seg(Some("rare"), format!("Variant: {} ({} variants)", variants[sel - 1], variants.len()))]));
        }
        let league = text.lines().find_map(|l| l.strip_prefix("League:")).map(|s| s.trim().to_string());
        if let Some(l) = league {
            lines.push(line("big", vec![seg(Some("league"), format!("Exclusive to: {l}"))]));
        }
        if text.lines().any(|l| l.trim() == "Unreleased: true") {
            lines.push(line("big", vec![seg(Some("negative"), "Not yet available")]));
        }
        if let Some(s) = text.lines().find_map(|l| l.strip_prefix("Source:")) {
            lines.push(line("big", vec![seg(Some("source"), format!("Source: {}", s.trim()))]));
        }
        lines.push(sep());
    }

    // Type-specific block.
    let slot_idx = opts.slot_num.clamp(1, 2) - 1;
    let quality = item.quality.unwrap_or(0.0);
    let qline = |lines: &mut Vec<Value>| {
        if quality > 0.0 {
            lines.push(line("big", vec![seg(Some("muted"), "Quality: "), seg(Some("magic"), format!("+{}%", n0(quality)))]));
        }
    };
    if let Some(weapon) = base.weapon.as_ref() {
        let wd = item.weapon_data.as_ref().and_then(|v| v.get(slot_idx)).cloned().unwrap_or(Value::Null);
        lines.push(line("big", vec![seg(Some("muted"), weapon_label(game, base))]));
        qline(&mut lines);
        let mut types = 0;
        if let Some(dps) = jf(&wd, "PhysicalDPS") {
            lines.push(line("big", vec![seg(Some("muted"), "Physical Damage: "), seg(Some("magic"), format!("{}-{} ({:.1} DPS)", n0(jf(&wd, "PhysicalMin").unwrap_or(0.0)), n0(jf(&wd, "PhysicalMax").unwrap_or(0.0)), dps))]));
            types += 1;
        }
        if let Some(edps) = jf(&wd, "ElementalDPS") {
            let mut segs = vec![seg(Some("muted"), "Elemental Damage: ")];
            let mut first = true;
            for (t, c) in [("Fire", "fire"), ("Cold", "cold"), ("Lightning", "lightning")] {
                if jf(&wd, &format!("{t}DPS")).is_some() {
                    if !first {
                        segs.push(seg(Some("muted"), ", "));
                    }
                    first = false;
                    segs.push(seg(Some(c), format!("{}-{}", n0(jf(&wd, &format!("{t}Min")).unwrap_or(0.0)), n0(jf(&wd, &format!("{t}Max")).unwrap_or(0.0)))));
                }
            }
            lines.push(line("big", segs));
            lines.push(line("big", vec![seg(Some("muted"), "Elemental DPS: "), seg(Some("magic"), format!("{edps:.1}"))]));
            types += 1;
        }
        if let Some(dps) = jf(&wd, "ChaosDPS") {
            lines.push(line("big", vec![seg(Some("muted"), "Chaos Damage: "), seg(Some("chaos"), format!("{}-{} ", n0(jf(&wd, "ChaosMin").unwrap_or(0.0)), n0(jf(&wd, "ChaosMax").unwrap_or(0.0)))), seg(Some("magic"), format!("({dps:.1} DPS)"))]));
            types += 1;
        }
        if types > 1 {
            lines.push(line("big", vec![seg(Some("muted"), "Total DPS: "), seg(Some("magic"), format!("{:.1}", jf(&wd, "TotalDPS").unwrap_or(0.0)))]));
        }
        let crit = jf(&wd, "CritChance").unwrap_or(0.0);
        lines.push(line("big", vec![seg(Some("muted"), "Critical Strike Chance: "), seg(stat_color(crit, weapon.get("CritChanceBase").copied(), None), format!("{crit:.2}%"))]));
        let rate = jf(&wd, "AttackRate").unwrap_or(0.0);
        lines.push(line("big", vec![seg(Some("muted"), "Attacks per Second: "), seg(stat_color(rate, weapon.get("AttackRateBase").copied(), None), format!("{rate:.2}"))]));
        let range = jf(&wd, "range").unwrap_or(0.0);
        if range < 120.0 {
            lines.push(line("big", vec![seg(Some("muted"), "Weapon Range: "), seg(stat_color(range, weapon.get("Range").copied(), None), format!("{:.1} ", range / 10.0)), seg(Some("muted"), "metres")]));
        }
    } else if let Some(armour) = base.armour.as_ref() {
        let ad = item.armour_data.clone().unwrap_or(Value::Null);
        qline(&mut lines);
        if let (Some(bb), Some(bc)) = (armour.get("BlockChance").copied(), jf(&ad, "BlockChance")) {
            if bc > 0.0 {
                lines.push(line("big", vec![seg(Some("muted"), "Chance to Block: "), seg(stat_color(bc, Some(bb), None), format!("{}%", n0(bc)))]));
            }
        }
        for (key, label) in [("Armour", "Armour"), ("Evasion", "Evasion Rating"), ("EnergyShield", "Energy Shield"), ("Ward", "Ward")] {
            let v = jf(&ad, key).unwrap_or(0.0);
            if v > 0.0 {
                lines.push(line("big", vec![seg(Some("muted"), format!("{label}: ")), seg(stat_color(v, jf(&ad, &format!("{key}Base")), None), n0(v))]));
            }
        }
    } else if let Some(flask) = base.extra.get("flask").map(|j| j.to_value()) {
        let fd = item.flask_data.clone().unwrap_or(Value::Null);
        qline(&mut lines);
        let dur = jf(&fd, "duration").unwrap_or(0.0);
        let base_dur = jf(&flask, "duration");
        let dur_c = stat_color(dur, base_dur, None);
        for (res, total_k, grad_k, inst_k, label) in [("life", "lifeTotal", "lifeGradual", "lifeInstant", "Life"), ("mana", "manaTotal", "manaGradual", "manaInstant", "Mana")] {
            if let Some(total) = jf(&fd, total_k) {
                let tc = stat_color(total, jf(&flask, res), None);
                let grad = jf(&fd, grad_k).unwrap_or(0.0);
                let inst = jf(&fd, inst_k).unwrap_or(0.0);
                if grad != 0.0 {
                    lines.push(line("big", vec![seg(Some("muted"), "Recovers "), seg(tc, n0(grad)), seg(Some("muted"), format!(" {label} over ")), seg(dur_c, format!("{dur:.1}0")), seg(Some("muted"), " Seconds")]));
                }
                if inst != 0.0 {
                    lines.push(line("big", vec![seg(Some("muted"), "Recovers "), seg(tc, n0(inst)), seg(Some("muted"), format!(" {label} instantly"))]));
                }
            }
        }
        if jf(&fd, "lifeTotal").is_none() && jf(&fd, "manaTotal").is_none() {
            lines.push(line("big", vec![seg(Some("muted"), "Lasts "), seg(dur_c, format!("{dur:.2}")), seg(Some("muted"), " Seconds")]));
        }
        let used = jf(&fd, "chargesUsed").unwrap_or(0.0);
        let max = jf(&fd, "chargesMax").unwrap_or(0.0);
        lines.push(line("big", vec![seg(Some("muted"), "Consumes "), seg(stat_color(used, jf(&flask, "chargesUsed"), None), n0(used)), seg(Some("muted"), " of "), seg(stat_color(max, jf(&flask, "chargesMax"), None), n0(max)), seg(Some("muted"), " Charges on use")]));
        if let Some(buff) = flask.get("buff").and_then(|b| b.as_array()) {
            for b in buff {
                if let Some(s) = b.as_str() {
                    lines.push(line("big", vec![seg(Some("magic"), s)]));
                }
            }
        }
    } else if let Some(tincture) = base.extra.get("tincture").map(|j| j.to_value()) {
        let td = item.tincture_data.clone().unwrap_or(Value::Null);
        qline(&mut lines);
        let mb = jf(&td, "manaBurn").unwrap_or(0.0);
        lines.push(line("big", vec![seg(Some("muted"), "Inflicts Mana Burn every "), seg(stat_color(mb, jf(&tincture, "manaBurn"), None), format!("{mb:.2}")), seg(Some("muted"), " Seconds")]));
        let cd = jf(&td, "cooldown").unwrap_or(0.0);
        lines.push(line("big", vec![seg(stat_color(cd, jf(&tincture, "cooldown"), None), format!("{cd:.2}")), seg(Some("muted"), " Second Cooldown When Deactivated")]));
        if let Some(buff) = tincture.get("buff").and_then(|b| b.as_array()) {
            for b in buff {
                if let Some(s) = b.as_str() {
                    lines.push(line("big", vec![seg(Some("magic"), s)]));
                }
            }
        }
    } else if ty == "Jewel" {
        if let Some(l) = item.limit {
            lines.push(line("big", vec![seg(Some("muted"), "Limited to: "), seg(None, n0(l))]));
        }
        if let Some(c) = &item.class_restriction {
            lines.push(line("big", vec![seg(Some("muted"), "Requires Class "), seg(Some("negative"), c.clone())]));
        }
        if let Some(l) = &item.jewel_radius_label {
            lines.push(line("big", vec![seg(Some("muted"), "Radius: "), seg(None, l.clone())]));
        }
    }
    if let (Some(c), Some(cq)) = (item.catalyst, item.catalyst_quality) {
        if c > 0 && (c as usize) <= CATALYST_DESC.len() && cq > 0.0 {
            lines.push(line("big", vec![seg(Some("muted"), format!("Quality ({} Modifiers): ", CATALYST_DESC[c as usize - 1])), seg(Some("magic"), format!("+{}% (augmented)", n0(cq)))]));
            lines.push(sep());
        }
    }
    if !item.sockets.is_empty() {
        lines.push(line("big", socket_line(&item)));
    }
    if let Some(t) = item.talisman_tier {
        lines.push(line("big", vec![seg(Some("muted"), "Talisman Tier "), seg(Some("white"), n0(t))]));
        lines.push(sep());
    }
    // Memory Strands and Intangibility are written in the item text and drawn on a themed strip in upstream.
    let spec_number = |name: &str| -> Option<f64> {
        text.lines().find_map(|l| {
            let l = l.trim().strip_prefix(name)?.strip_prefix(':')?;
            l.trim().trim_end_matches('%').parse::<f64>().ok()
        })
    };
    if let Some(n) = spec_number("Memory Strands") {
        lines.push(line("big", vec![seg(Some("memory"), "Memory Strands: "), seg(Some("white"), n0(n))]));
    }
    if let Some(n) = spec_number("Intangibility") {
        lines.push(line("big", vec![seg(Some("intangibility"), "Intangibility: "), seg(Some("white"), format!("{}%", n0(n)))]));
    }
    lines.push(sep());
    if let Some(r) = requirement_segs(&item, player) {
        lines.push(r);
        lines.push(sep());
    }

    // Modifiers, group by group.
    for (bucket, _name) in [(&item.enchant_mod_lines, "enchant"), (&item.scourge_mod_lines, "scourge"), (&item.implicit_mod_lines, "implicit"), (&item.explicit_mod_lines, "explicit"), (&item.crucible_mod_lines, "crucible")] {
        if bucket.is_empty() {
            continue;
        }
        for ml in bucket {
            if !line_active(&item, ml) {
                continue;
            }
            if let Some((t, c)) = mod_display(ml, opts.db_mode, game) {
                for part in t.split('\n') {
                    if c == "unsupported" {
                        lines.push(line("big", vec![seg(Some(c), part), seg(Some("muted"), " (Not supported yet)")]));
                    } else {
                        lines.push(line("big", vec![seg(Some(c), part)]));
                    }
                }
            }
        }
        lines.push(sep());
    }

    // Cluster jewel notables and keystone.
    if item.cluster_jewel.is_some() {
        let names = &item.jewel_data.cluster_jewel_notables;
        // The notable's (or keystone's) name and stat lines, from the tree's own nodes (`clusterNodeMap` in upstream).
        let notable = |name: &str, lines: &mut Vec<Value>| {
            lines.push(line("big", vec![seg(Some("magic"), name.to_string())]));
            if let Some(n) = game.tree().nodes.values().find(|n| n.dn.as_deref() == Some(name)) {
                for s in &n.sd {
                    lines.push(line("big", vec![seg(Some("muted"), s.clone())]));
                }
            }
        };
        if !names.is_empty() {
            lines.push(sep());
            for n in names {
                notable(n, &mut lines);
            }
            lines.push(sep());
        } else if let Some(k) = &item.jewel_data.cluster_jewel_keystone {
            lines.push(sep());
            notable(k, &mut lines);
            lines.push(sep());
        }
    }

    if item.corrupted || item.split || item.mirrored {
        if item.explicit_mod_lines.is_empty() {
            lines.push(sep());
        }
        if item.split {
            lines.push(line("big", vec![seg(Some("negative"), "Split")]));
        }
        if item.mirrored {
            lines.push(line("big", vec![seg(Some("negative"), "Mirrored")]));
        }
        if item.corrupted {
            lines.push(line("big", vec![seg(Some("negative"), "Corrupted")]));
        }
        lines.push(sep());
    }

    if rarity == "UNIQUE" || rarity == "RELIC" {
        if let Some(title) = &item.title {
            if let Some(fl) = flavour_for(game, title) {
                for l in fl {
                    lines.push(line("flavour", vec![seg(Some("unique"), l)]));
                }
                lines.push(sep());
            }
        }
    }
    // Drop a trailing run of separators.
    while lines.last().is_some_and(|l| l.get("k").and_then(|k| k.as_str()) == Some("sep")) {
        lines.pop();
    }
    // And doubled ones.
    let mut tidy: Vec<Value> = Vec::new();
    for l in lines {
        let is_sep = l.get("k").and_then(|k| k.as_str()) == Some("sep");
        if is_sep && tidy.last().is_none_or(|p| p.get("k").and_then(|k| k.as_str()) == Some("sep")) {
            continue;
        }
        tidy.push(l);
    }

    // What the editor needs.
    let mods = |bucket: &Vec<ModLine>, name: &str| -> Vec<Value> {
        bucket
            .iter()
            .filter(|ml| line_active(&item, ml))
            .filter_map(|ml| {
                let (t, c) = mod_display(ml, opts.db_mode, game).unwrap_or((ml.line.clone(), "magic"));
                Some(json!({
                    "bucket": name, "text": t, "c": c, "rawLine": if ml.raw_line == usize::MAX { Value::Null } else { json!(ml.raw_line) },
                    "range": ml.range, "scalable": has_bare_range(&ml.line) && ml.extra.is_none(),
                    "crafted": ml.crafted, "fractured": ml.fractured, "custom": ml.custom, "mutated": ml.mutated,
                    "prefix": ml.prefix, "suffix": ml.suffix, "unsupported": ml.extra.is_some(),
                }))
            })
            .collect()
    };
    let mut all_mods = Vec::new();
    all_mods.extend(mods(&item.enchant_mod_lines, "enchant"));
    all_mods.extend(mods(&item.scourge_mod_lines, "scourge"));
    all_mods.extend(mods(&item.implicit_mod_lines, "implicit"));
    all_mods.extend(mods(&item.explicit_mod_lines, "explicit"));
    all_mods.extend(mods(&item.crucible_mod_lines, "crucible"));

    let influences: Vec<&str> = INFLUENCE_KEYS.iter().copied().filter(|k| has_influence(&item, k)).collect();
    let no_quality = ["Amulet", "Belt", "Jewel", "Quiver", "Ring", "Graft"].contains(&ty.as_str());
    let can_influence = pom_item::modpool::base_influences(game, &base_name).is_ok_and(|v| !v.is_empty());
    let (mut max_link_sockets, mut abyssal) = (0, 0);
    for s in &item.sockets {
        if s.color == 'A' {
            abyssal += 1;
        } else {
            max_link_sockets += 1;
        }
    }
    let sub_type = base.extra.get("subType").and_then(|s| s.as_str());
    let impl_count = item.enchant_mod_lines.len() + item.scourge_mod_lines.len() + item.implicit_mod_lines.len();
    let art_name = if rarity == "UNIQUE" || rarity == "RELIC" { item.title.clone().unwrap_or(clean_base.clone()) } else { clean_base.clone() };
    let mut m = Map::new();
    m.insert("valid".into(), json!(true));
    m.insert("name".into(), json!(item.title.clone().unwrap_or(format!("{}{}{}", item.name_prefix, clean_base, item.name_suffix))));
    m.insert("title".into(), json!(item.title));
    m.insert("baseName".into(), json!(clean_base));
    m.insert("baseKey".into(), json!(base_name));
    m.insert("artName".into(), json!(art_name));
    m.insert("rarity".into(), json!(rarity));
    m.insert("type".into(), json!(ty));
    m.insert("subType".into(), json!(sub_type));
    m.insert("isWeapon".into(), json!(base.weapon.is_some()));
    m.insert("jewelRadius".into(), json!(item.jewel_radius_label));
    m.insert("jewelRadiusIndex".into(), json!(item.jewel_radius_index));
    m.insert("oneHand".into(), json!(one_hand(game, &ty)));
    m.insert("quality".into(), json!(item.quality));
    m.insert("noQuality".into(), json!(no_quality));
    m.insert("canInfluence".into(), json!(can_influence));
    m.insert("influences".into(), json!(influences));
    m.insert("headerInfluence".into(), json!(header_inf));
    m.insert("sockets".into(), json!(item.sockets.iter().map(|s| json!({"c": s.color.to_string(), "g": s.group})).collect::<Vec<_>>()));
    m.insert("socketLimit".into(), json!(base.socket_limit));
    m.insert("normalSockets".into(), json!(max_link_sockets));
    m.insert("abyssalSockets".into(), json!(abyssal));
    m.insert("corrupted".into(), json!(item.corrupted));
    m.insert("mirrored".into(), json!(item.mirrored));
    m.insert("crafted".into(), json!(item.crafted));
    m.insert("catalyst".into(), json!(item.catalyst.map(|c| if c > 0 && (c as usize) <= CATALYSTS.len() { CATALYSTS[c as usize - 1] } else { "" })));
    m.insert("catalystQuality".into(), json!(item.catalyst_quality));
    m.insert("itemLevel".into(), json!(item.item_level));
    m.insert("levelReq".into(), json!(item.requirements.level));
    m.insert("implicitCount".into(), json!(impl_count));
    m.insert("mods".into(), json!(all_mods));
    m.insert("cluster".into(), json!(item.cluster_jewel.as_ref().map(|c| json!({"size": c.size, "sizeIndex": c.size_index}))));
    m.insert("charm".into(), json!(sub_type == Some("Charm")));
    m.insert("abyssJewel".into(), json!(sub_type == Some("Abyss")));
    // Which of the editor's enchant, anoint, corrupt, implicit and Crucible controls apply (`ItemsTabClass` `shown` rules).
    let lines_lower = pools::all_lines_lower(&item);
    let cannot_anoint = base.extra.get("cannotBeAnointed").is_some_and(|v| v.to_value().as_bool().unwrap_or(false));
    let implicits_locked = lines_lower.iter().any(|l| l == "implicit modifiers cannot be changed");
    m.insert("maxEnchants".into(), json!(pools::max_enchants(&lines_lower)));
    m.insert("anointable".into(), json!(!cannot_anoint && sub_type != Some("Talisman") && (lines_lower.iter().any(|l| l.contains("can be anointed")) || ty == "Amulet")));
    m.insert("corruptible".into(), json!(ty != "Flask"));
    m.insert("implicitsLocked".into(), json!(implicits_locked));
    m.insert("canAddImplicit".into(), json!(ty != "Tincture" && ty != "Graft" && ty != "Flask" && !implicits_locked));
    m.insert("granted".into(), Value::Array(granted_skills(&item)));
    let has_tags = [&item.enchant_mod_lines, &item.scourge_mod_lines, &item.implicit_mod_lines, &item.explicit_mod_lines, &item.crucible_mod_lines].iter().any(|b| b.iter().any(|ml| !ml.mod_tags.is_empty()));
    m.insert("hasModTags".into(), json!(has_tags));
    m.insert("canCrucible".into(), json!(base.weapon.is_some() || ty == "Shield" || lines_lower.iter().any(|l| l == "has a crucible passive skill tree")));
    m.insert("variants".into(), json!(item.variant_count));
    m.insert("selectedVariant".into(), json!(item.selected_variant.unwrap_or(item.variant_count)));
    m.insert("headerRarity".into(), json!(rc));
    m.insert("text".into(), json!(text));
    m.insert("defences".into(), base.armour.as_ref().and(item.armour_data.clone()).unwrap_or(Value::Null));
    m.insert("lines".into(), Value::Array(tidy));
    Value::Object(m)
}

/// The unique database entry fields read off a unique's raw text.
fn unique_entry(game: &'static GameData, group: &str, text: &str) -> Value {
    let mut lines = text.lines();
    let name = lines.next().unwrap_or("").to_string();
    let base = lines.next().unwrap_or("").to_string();
    let mut level = 0.0;
    let mut league = None;
    let mut source = None;
    let mut variants: Vec<String> = Vec::new();
    for l in text.lines().skip(2) {
        if let Some(v) = l.strip_prefix("LevelReq:") {
            level = v.trim().parse().unwrap_or(0.0);
        } else if let Some(v) = l.strip_prefix("Requires Level ") {
            level = v.trim().split(|c: char| !c.is_ascii_digit()).next().and_then(|n| n.parse().ok()).unwrap_or(level);
        } else if let Some(v) = l.strip_prefix("League:") {
            league = Some(v.trim().to_string());
        } else if let Some(v) = l.strip_prefix("Source:") {
            source = Some(v.trim().to_string());
        } else if let Some(v) = l.strip_prefix("Variant:") {
            variants.push(v.trim().to_string());
        }
        if l.starts_with("Implicits:") {
            break;
        }
    }
    // The requirements upstream filters by (`item.requirements`: the level line or the base's, and the attribute
    // totals after the item's own "increased/reduced requirements" and "+N to requirements" lines).
    let item = pom_item::parse::parse_raw_with_id(text, true, None, game);
    let r = &item.requirements;
    let level = r.level.unwrap_or(level);
    json!({ "name": name, "base": base, "group": group, "level": level, "league": league, "source": source, "variants": variants, "text": text, "reqStr": r.str_mod, "reqDex": r.dex_mod, "reqInt": r.int_mod })
}

/// The base lists, uniques and rare templates the item browser and the craft dialog read.
pub fn catalog(game: &'static GameData) -> Result<Value, String> {
    let types = game.extra.get("itemBaseTypeList")?.map(|j| j.to_value()).unwrap_or(Value::Null);
    let lists = game.extra.get("itemBaseLists")?.map(|j| j.to_value()).unwrap_or(Value::Null);
    let mut bases = Map::new();
    let wti = game.extra.get("weaponTypeInfo").ok().flatten();
    if let Some(obj) = lists.as_object() {
        for (ty, arr) in obj {
            let list: Vec<Value> = arr
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|e| {
                            let b = &e["base"];
                            let info = wti.and_then(|w| w.get(b["type"].as_str().unwrap_or("")));
                            json!({
                                "armour": b.get("armour").is_some(),
                                "melee": info.and_then(|i| i.get("melee")).and_then(|v| v.as_bool()),
                                "oneHand": info.and_then(|i| i.get("oneHand")).and_then(|v| v.as_bool()),
                                "name": e["name"].as_str().or(e["label"].as_str()),
                                "type": b["type"], "subType": b["subType"],
                                "level": b["req"]["level"], "str": b["req"]["str"], "dex": b["req"]["dex"], "int": b["req"]["int"],
                                "implicit": b["implicit"], "flask": b.get("flask").is_some(), "weapon": b.get("weapon").is_some(),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            bases.insert(ty.clone(), Value::Array(list));
        }
    }
    let uniques_v = game.extra.get("uniques")?.map(|j| j.to_value()).unwrap_or(Value::Null);
    let mut uniques = Vec::new();
    if let Some(obj) = uniques_v.as_object() {
        for (group, arr) in obj {
            if group == "generated" || group == "race" || group == "new" {
                continue;
            }
            if let Some(a) = arr.as_array() {
                for t in a {
                    if let Some(s) = t.as_str() {
                        uniques.push(unique_entry(game, group, s));
                    }
                }
            }
        }
    }
    let rares_v = game.extra.get("rares")?.map(|j| j.to_value()).unwrap_or(Value::Null);
    let mut rares = Vec::new();
    if let Some(a) = rares_v.as_array() {
        for t in a {
            if let Some(s) = t.as_str() {
                let mut l = s.lines();
                let label = l.next().unwrap_or("").to_string();
                let base = l.next().unwrap_or("").to_string();
                rares.push(json!({ "label": label, "base": base, "text": format!("Rarity: RARE\n{s}") }));
            }
        }
    }
    Ok(json!({ "types": types, "bases": bases, "uniques": uniques, "rares": rares }))
}

/// The skills an item grants (`item.grantedSkills` and the `ExtraSupport` mods): skill id and level.
fn granted_skills(item: &Item) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let all = [&item.enchant_mod_lines, &item.scourge_mod_lines, &item.implicit_mod_lines, &item.explicit_mod_lines, &item.crucible_mod_lines];
    for bucket in all {
        for ml in bucket.iter().filter(|ml| !ml.disabled) {
            let Some(list) = &ml.mod_list else { continue };
            for m in list {
                if &*m.name != "ExtraSkill" && &*m.name != "ExtraSupport" {
                    continue;
                }
                let pom_engine::modparser::types::PVal::Map(fields) = &m.value else { continue };
                let field = |k: &str| fields.iter().find(|(n, _)| n == k).map(|(_, v)| v);
                let Some(pom_engine::modparser::types::PVal::Str(id)) = field("skillId") else { continue };
                let level = match field("level") {
                    Some(pom_engine::modparser::types::PVal::Num(n)) => *n,
                    _ => 1.0,
                };
                let id = id.clone();
                out.push(json!({ "skillId": id, "level": level }));
            }
        }
    }
    out
}

/// The tooltip of a skill at `level` (see `gemtip::tip`), with requirements coloured against `player`.
pub fn gem_tip(game: &'static GameData, skill_id: &str, level: f64, player: &Player) -> Result<Value, String> {
    gemtip::tip(game, skill_id, level, player)
}

/// The effective flask or tincture stats of the item in `text`, with the modifiers of the build `env` was calculated for
/// (see `flask::lines`); a list of tooltip lines, empty for any other item.
pub fn flask_lines(game: &'static GameData, env: &pom_pipeline::Env, text: &str) -> Value {
    let item = pom_item::parse::parse_raw_with_id(text, true, None, game);
    let Some(base) = item.base_name.as_ref().and_then(|n| game.item_bases.get(n)) else { return json!([]) };
    let empty = (1..=5).filter(|n| !env.slot_items.get(&format!("Flask {n}")).is_some_and(|id| *id > 0)).count();
    Value::Array(flask::lines(env, &item, base, empty))
}

/// A new item of `base`, as the craft dialog makes it (`ItemsTabClass:CraftItem`): the item text.
pub fn craft(game: &'static GameData, base_name: &str, rarity: &str, title: Option<&str>) -> Result<String, String> {
    let base = game.item_bases.get(base_name).ok_or_else(|| format!("unknown base {base_name}"))?;
    let ty = base.base_type.clone().unwrap_or_default();
    let sub = base.extra.get("subType").and_then(|s| s.as_str()).unwrap_or("");
    let is_flask = base.extra.get("flask").is_some() || ty == "Tincture" || (ty == "Jewel" && sub == "Charm");
    let mut rarity = rarity.to_uppercase();
    if is_flask && rarity == "RARE" {
        rarity = "MAGIC".into();
    }
    let mut out = format!("Rarity: {rarity}\n");
    if rarity == "RARE" || rarity == "UNIQUE" || rarity == "RELIC" {
        let t = title.map(|t| t.trim()).filter(|t| !t.is_empty()).unwrap_or("New Item");
        out.push_str(&format!("{t}\n{base_name}\n"));
    } else {
        out.push_str(&format!("{base_name}\n"));
    }
    if !["Amulet", "Belt", "Jewel", "Quiver", "Ring", "Graft"].contains(&ty.as_str()) && (base.weapon.is_some() || base.armour.is_some() || base.extra.get("flask").is_some() || ty == "Tincture") {
        out.push_str("Quality: 0\n");
    }
    if rarity == "MAGIC" || rarity == "RARE" {
        out.push_str("Crafted: true\n");
    }
    if let Some(l) = base.req.as_ref().and_then(|r| r.get("level")).filter(|l| **l > 0.0) {
        out.push_str(&format!("LevelReq: {}\n", *l as i64));
    }
    let implicit = base.implicit.clone().unwrap_or_default();
    let impl_lines: Vec<&str> = implicit.lines().filter(|l| !l.trim().is_empty()).collect();
    out.push_str(&format!("Implicits: {}\n", impl_lines.len()));
    for l in impl_lines {
        out.push_str(l);
        out.push('\n');
    }
    Ok(out)
}

// ---- modifier pools for the item editor's dialogs ---------------------------------------------------------------

fn jstr(v: &pom_engine::cjson::J, k: &str) -> Option<String> {
    v.get(k).and_then(|x| x.as_str().map(|s| s.to_string()))
}

/// The numbered lines of a modifier entry ("1", "2", ...).
fn mod_lines(m: &pom_engine::cjson::J) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 1;
    while let Some(l) = m.get(i.to_string().as_str()).and_then(|l| l.as_str()) {
        out.push(l.to_string());
        i += 1;
    }
    out
}

fn str_list(v: Option<pom_engine::cjson::J>) -> Vec<String> {
    v.and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect()).unwrap_or_default()
}

/// `ItemClass:GetModSpawnWeight` (without the restrict-tag flags, which only some uniques set).
fn spawn_weight(m: &pom_engine::cjson::J, tags: &std::collections::HashSet<String>, inf: &HashMap<String, String>, strip_necropolis: bool) -> f64 {
    let hit = |k: &str| {
        let k2 = if strip_necropolis { k.strip_prefix("necropolis_").unwrap_or(k) } else { k };
        tags.contains(k2) || inf.values().any(|v| v == k)
    };
    let keys = str_list(m.get("weightKey"));
    let vals: Vec<f64> = m.get("weightVal").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
    let mut w = 0.0;
    for (i, k) in keys.iter().enumerate() {
        if hit(k) {
            let elevated = inf.values().any(|v| v == k) && jstr(m, "affix").is_some_and(|a| a.contains("Elevated"));
            w = if elevated { 1000.0 } else { vals.get(i).copied().unwrap_or(0.0) };
            break;
        }
    }
    let mk = str_list(m.get("weightMultiplierKey"));
    let mv: Vec<f64> = m.get("weightMultiplierVal").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
    for (i, k) in mk.iter().enumerate() {
        if hit(k) {
            w = w * mv.get(i).copied().unwrap_or(100.0) / 100.0;
            break;
        }
    }
    w
}

fn entry_json(id: &str, m: &pom_engine::cjson::J, kind: &str, source: &str) -> Value {
    json!({
        "id": id, "lines": mod_lines(m), "tags": str_list(m.get("modTags")), "type": jstr(m, "type"),
        "affix": jstr(m, "affix"), "level": m.get("level").and_then(|l| l.as_f64()), "group": jstr(m, "group"), "kind": kind, "source": source,
    })
}

fn resolve(mods: &pom_engine::cjson::J, e: pom_engine::cjson::J) -> pom_engine::cjson::J {
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

fn prefix_first(v: &mut [Value]) {
    v.sort_by(|a, b| {
        let ta = a["type"].as_str().unwrap_or("");
        let tb = b["type"].as_str().unwrap_or("");
        (ta != "Prefix").cmp(&(tb != "Prefix"))
    });
}

/// The modifier lists the item editor's dialogs pick from, for the item in `text` (`kind`: `mods`, `corrupt`,
/// `enchant` or `anoint`). Lists follow `ItemsTabClass:AddModifierToDisplayItem`, `CorruptDisplayItem`,
/// `EnchantDisplayItem` and `AnointDisplayItem`; the drop-restricted Delve and Incursion lists are not included.
pub fn mod_pool(game: &'static GameData, text: &str, kind: &str) -> Result<Value, String> {
    let item = pom_item::parse::parse_raw_with_id(text, true, None, game);
    let base_name = item.base_name.clone().ok_or("the item's base is not recognised")?;
    let base = game.item_bases.get(&base_name).ok_or("unknown base")?;
    let ty = base.base_type.clone().unwrap_or_default();
    let sub = base.extra.get("subType").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let tags: std::collections::HashSet<String> = base.tags.iter().filter(|(_, v)| **v).map(|(k, _)| k.clone()).collect();
    let mut inf: HashMap<String, String> = HashMap::new();
    if let Some(it) = base.extra.get("influenceTags").and_then(|v| v.as_object()) {
        for k in INFLUENCE_KEYS {
            if has_influence(&item, k) {
                if let Some(t) = it.get(k).and_then(|t| t.as_str()) {
                    inf.insert(k.to_string(), t.to_string());
                }
            }
        }
    }
    let mods = game.extra.get("itemMods")?.ok_or("no item mods")?;
    let table = [format!("{ty}{sub}"), ty.clone(), "Item".to_string()].into_iter().find(|t| mods.get(t.as_str()).is_some()).unwrap_or_else(|| "Item".into());
    let affixes = mods.get(table.as_str()).ok_or("no affix table")?;
    match kind {
        "mods" => {
            let mut sources: Vec<Value> = Vec::new();
            let affix_list = |filter: &dyn Fn(&pom_engine::cjson::J) -> bool, kind: &str, source: &str| -> Vec<Value> {
                let mut v: Vec<(Vec<f64>, f64, Value)> = Vec::new();
                if let Some(o) = affixes.as_object() {
                    for (id, e) in o.iter() {
                        let m = resolve(&mods, e);
                        if filter(&m) && spawn_weight(&m, &tags, &inf, false) > 0.0 {
                            let so: Vec<f64> = m.get("statOrder").and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
                            v.push((so, m.get("level").and_then(|l| l.as_f64()).unwrap_or(0.0), entry_json(id, &m, kind, source)));
                        }
                    }
                }
                v.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal).then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)).then(a.2["id"].as_str().cmp(&b.2["id"].as_str())));
                v.into_iter().map(|x| x.2).collect()
            };
            let delve = |m: &pom_engine::cjson::J| matches!(jstr(m, "affix").as_deref(), Some("Subterranean") | Some("of the Underground"));
            if ty != "Tincture" && ty != "Graft" {
                if ty != "Jewel" {
                    let mut v: Vec<Value> = Vec::new();
                    if let Some(a) = game.extra.get("masterMods")?.and_then(|a| a.as_array()) {
                        for (i, m) in a.iter().enumerate() {
                            if m.get("types").and_then(|t| t.get(ty.as_str())).is_some() {
                                v.push(entry_json(&format!("master{i}"), &m, "crafted", "MASTER"));
                            }
                        }
                    }
                    prefix_first(&mut v);
                    if !v.is_empty() {
                        sources.push(json!({"id": "MASTER", "label": "Crafting Bench", "mods": v}));
                    }
                }
                if ty != "Jewel" && ty != "Flask" {
                    let mut ess: Vec<(String, f64, String, Value)> = Vec::new();
                    if let Some(o) = game.extra.get("essences")?.and_then(|o| o.as_object()) {
                        for (_, e) in o.iter() {
                            let Some(id) = e.get("mods").and_then(|m| m.get(ty.as_str())).and_then(|x| x.as_str().map(|s| s.to_string())) else { continue };
                            let Some(ent) = affixes.get(id.as_str()) else { continue };
                            let m = resolve(&mods, ent);
                            let mut j = entry_json(&id, &m, "custom", "ESSENCE");
                            j["essence"] = json!(jstr(&e, "name"));
                            ess.push((jstr(&e, "type").unwrap_or_default(), e.get("tier").and_then(|t| t.as_f64()).unwrap_or(0.0), jstr(&e, "name").unwrap_or_default(), j));
                        }
                    }
                    ess.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal)).then(a.2.cmp(&b.2)));
                    let v: Vec<Value> = ess.into_iter().map(|x| x.3).collect();
                    if !v.is_empty() {
                        sources.push(json!({"id": "ESSENCE", "label": "Essence", "mods": v}));
                    }
                    let mut veiled: Vec<Value> = Vec::new();
                    if let Some(o) = game.extra.get("veiledMods")?.and_then(|o| o.as_object()) {
                        for (id, m) in o.iter() {
                            if spawn_weight(&m, &tags, &inf, false) > 0.0 {
                                veiled.push(entry_json(id, &m, "custom", "VEILED"));
                            }
                        }
                    }
                    prefix_first(&mut veiled);
                    if !veiled.is_empty() {
                        sources.push(json!({"id": "VEILED", "label": "Veiled", "mods": veiled}));
                    }
                    let mut beast: Vec<Value> = Vec::new();
                    if let Some(o) = game.extra.get("beastCraft")?.and_then(|o| o.as_object()) {
                        for (id, m) in o.iter() {
                            beast.push(entry_json(id, &m, "custom", "BEASTCRAFT"));
                        }
                    }
                    prefix_first(&mut beast);
                    if !beast.is_empty() {
                        sources.push(json!({"id": "BEASTCRAFT", "label": "Beastcraft", "mods": beast}));
                    }
                }
                if ["Helmet", "Body Armour", "Gloves", "Boots"].contains(&ty.as_str()) {
                    let mut nec: Vec<Value> = Vec::new();
                    if let Some(o) = game.extra.get("necropolisMods")?.and_then(|o| o.as_object()) {
                        for (id, m) in o.iter() {
                            if spawn_weight(&m, &tags, &HashMap::new(), true) > 0.0 {
                                nec.push(entry_json(id, &m, "custom", "NECROPOLIS"));
                            }
                        }
                    }
                    prefix_first(&mut nec);
                    if !nec.is_empty() {
                        sources.push(json!({"id": "NECROPOLIS", "label": "Necropolis", "mods": nec}));
                    }
                }
                if item.cluster_jewel.is_none() && ty != "Flask" {
                    let mut fossil = affix_list(&delve, "custom", "FOSSIL");
                    prefix_first(&mut fossil);
                    if !fossil.is_empty() {
                        sources.push(json!({"id": "FOSSIL", "label": "Fossil", "mods": fossil}));
                    }
                }
                if item.cluster_jewel.is_none() && ty != "Flask" {
                    // The modifiers that only drop from Delve and from Incursion (`buildDropRestricted`).
                    let sub_name = if sub.is_empty() { None } else { Some(format!("{ty}: {sub}")) };
                    for (id, label, key, source_table) in [("DELVE", "Delve Drop-restricted", "delve", "Delve"), ("INCURSION", "Incursion Drop-restricted", "incursion", "Explicit")] {
                        let mut v: Vec<Value> = Vec::new();
                        if let (Some(cats), Some(tbl)) = (pools::drop_only().get(key).and_then(|c| c.as_object()), mods.get(source_table)) {
                            let mut ids: Vec<&String> = cats.keys().collect();
                            ids.sort();
                            for mod_id in ids {
                                let applies = cats[mod_id].as_array().is_some_and(|a| a.iter().filter_map(|c| c.as_str()).any(|c| c == ty || sub_name.as_deref() == Some(c)));
                                if !applies {
                                    continue;
                                }
                                if let Some(m) = tbl.get(mod_id.as_str()) {
                                    v.push(entry_json(mod_id, &m, "custom", id));
                                }
                            }
                        }
                        prefix_first(&mut v);
                        if !v.is_empty() {
                            sources.push(json!({"id": id, "label": label, "mods": v}));
                        }
                    }
                }
                if item.rarity == "MAGIC" || item.rarity == "RARE" || item.rarity == "NORMAL" || !item.crafted {
                    for (id, label) in [("PREFIX", "Prefix"), ("SUFFIX", "Suffix")] {
                        let v = affix_list(&|m| jstr(m, "type").as_deref() == Some(label) && !delve(m), "custom", id);
                        if !v.is_empty() {
                            sources.push(json!({"id": id, "label": label, "mods": v}));
                        }
                    }
                }
            }
            Ok(json!({ "sources": sources }))
        }
        "corrupt" => {
            let mut lists = Map::new();
            for t in ["Corrupted", "ScourgeUpside", "ScourgeDownside"] {
                let mut v: Vec<(String, f64, Value)> = Vec::new();
                if t == "Corrupted" {
                    let opts = pom_item::modpool::PoolOptions { influences: inf.keys().cloned().collect(), ..Default::default() };
                    for m in pom_item::modpool::mod_pool(game, &base_name, u32::MAX, &opts)?.corrupted {
                        let first = m.stats.first().map(|s| s.text.clone()).unwrap_or_default().to_lowercase();
                        let norm: String = first.chars().filter(|c| !"+-%".contains(*c)).collect();
                        let e = json!({
                            "id": m.id, "lines": m.stats.iter().map(|s| s.text.clone()).collect::<Vec<_>>(), "tags": m.tags, "type": "Corrupted",
                            "affix": m.affix, "level": m.level as f64, "group": m.group, "kind": "implicit", "source": t,
                        });
                        v.push((norm, m.level as f64, e));
                    }
                } else if let Some(o) = affixes.as_object() {
                    for (id, e) in o.iter() {
                        let m = resolve(&mods, e);
                        if jstr(&m, "type").as_deref() == Some(t) && spawn_weight(&m, &tags, &inf, false) > 0.0 {
                            let first = mod_lines(&m).first().cloned().unwrap_or_default().to_lowercase();
                            let norm: String = first.chars().filter(|c| !"+-%".contains(*c)).collect();
                            v.push((norm, m.get("level").and_then(|l| l.as_f64()).unwrap_or(0.0), entry_json(id, &m, "implicit", t)));
                        }
                    }
                }
                v.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal)));
                lists.insert(t.to_string(), Value::Array(v.into_iter().map(|x| x.2).collect()));
            }
            let glimpse = item.title.as_deref().is_some_and(|t| t.to_lowercase().contains("glimpse of chaos")) && (item.rarity == "UNIQUE" || item.rarity == "RELIC");
            if glimpse {
                let mut v = Vec::new();
                if let Some(o) = mods.get("ItemExclusive").and_then(|o| o.as_object()) {
                    for (id, m) in o.iter() {
                        if id.starts_with("UniqueSpecialCorruption") {
                            v.push(entry_json(id, &m, "implicit", "Glimpse of Chaos"));
                        }
                    }
                }
                lists.insert("Glimpse of Chaos".into(), Value::Array(v));
            }
            Ok(json!({ "lists": lists, "glimpse": glimpse }))
        }
        "enchant" => {
            let e = pom_item::modpool::enchant_table(game, &base_name)?.map(|v| v.to_value()).unwrap_or(Value::Null);
            let sources = game.extra.get("enchantmentSource")?.map(|v| v.to_value()).unwrap_or(Value::Null);
            Ok(json!({ "table": e, "sources": sources }))
        }
        "anoint" => {
            let mut v: Vec<(String, Value)> = Vec::new();
            for n in game.tree().nodes.values() {
                let oils: Vec<String> = n.extra.get("recipe").map(|r| str_list(Some(r.clone()))).unwrap_or_default();
                if !oils.is_empty() {
                    if let Some(dn) = &n.dn {
                        v.push((dn.clone(), json!({ "id": n.id, "name": dn, "stats": n.sd, "oils": oils })));
                    }
                }
            }
            v.sort_by(|a, b| a.0.cmp(&b.0));
            Ok(json!({ "nodes": v.into_iter().map(|x| x.1).collect::<Vec<_>>() }))
        }
        "crucible" => pools::crucible(game, &item, &tags, &inf),
        "affixes" => {
            // A crafted cluster jewel's modifiers also spawn from its chosen skill's tag (`extraTags[skill.tag]`).
            let cluster_tag = item.jewel_data.cluster_jewel_skill.as_deref().filter(|_| item.cluster_jewel.is_some()).and_then(|sk| {
                let cj = game.extra.get("clusterJewels").ok().flatten()?;
                cj.get("jewels")?.get(base_name.as_str())?.get("skills")?.get(sk)?.get("tag")?.as_str().map(|t| t.to_string())
            });
            pools::affixes(&item, text, &ty, &tags, &inf, &affixes, &mods, cluster_tag.as_deref())
        }
        "cluster" => pools::cluster(game, &item, &base_name),
        "foulborn" => foulborn::pool(game, &item, &mods),
        "implicits" => pools::implicits(game, &item, &ty, &tags, &inf, &mods, &affixes),
        other => Err(format!("unknown pool {other}")),
    }
}

// ---- game text to build text -------------------------------------------------------------------------------------

fn fmt_range(r: f64) -> String {
    let s = format!("{:.6}", r);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// One mod line written the way `ItemClass:BuildRaw` writes it (flags and tags in front).
fn write_mod_line(ml: &ModLine) -> String {
    let mut line = ml.line.clone();
    let prepend = |line: &mut String, p: &str| {
        *line = line.split('\n').map(|l| format!("{p}{l}")).collect::<Vec<_>>().join("\n");
    };
    if ml.range.is_some() && has_bare_range(&line) {
        line = format!("{{range:{}}}{}", fmt_range(ml.range.unwrap_or(0.5)), line);
    }
    if let Some(c) = ml.corrupted_range {
        line = format!("{{corruptedRange:{}}}{}", fmt_range((c * 100.0).round() / 100.0), line);
    }
    for (on, tag) in [(ml.disabled, "disabled"), (ml.crafted, "crafted"), (ml.enchant, "enchant"), (ml.custom, "custom"), (ml.scourge, "scourge"), (ml.crucible, "crucible"), (ml.mutated, "mutated")] {
        if on {
            line = format!("{{{tag}}}{line}");
        }
    }
    if let Some(g) = &ml.mod_group {
        let tag = format!("{{modGroup:{g}}}");
        prepend(&mut line, &tag);
    }
    for (on, tag) in [(ml.fractured, "fractured"), (ml.prefix, "prefix"), (ml.suffix, "suffix"), (ml.exarch, "exarch"), (ml.eater, "eater"), (ml.synthesis, "synthesis"), (ml.unscalable, "unscalable"), (ml.vestigial, "vestigial")] {
        if on {
            line = format!("{{{tag}}}{line}");
        }
    }
    if !ml.mod_tags.is_empty() {
        line = format!("{{tags:{}}}{}", ml.mod_tags.join(","), line);
    }
    if let Some(v) = &ml.variant_list {
        let ids: Vec<String> = v.iter().map(|x| x.to_string()).collect();
        let tag = format!("{{variant:{}}}", ids.join(","));
        prepend(&mut line, &tag);
    }
    line
}

/// Item text as the build file keeps it (`ItemClass:BuildRaw`), rebuilt from the parsed item. Used for text copied
/// from the game, so every later edit finds the `Implicits:` count and the flags upstream writes. Lines the
/// parser does not model (unique id, league, memory strands, variants) are carried over from the source text.
pub fn normalise_text(game: &'static GameData, text: &str) -> Result<String, String> {
    let item = pom_item::parse::parse_raw_with_id(text, true, None, game);
    let base_name = item.base_name.clone().ok_or("the item's base is not recognised")?;
    let mut out: Vec<String> = vec![format!("Rarity: {}", item.rarity)];
    if let Some(t) = &item.title {
        out.push(t.clone());
        out.push(base_name.clone());
    } else {
        out.push(format!("{}{}{}", item.name_prefix, base_name, item.name_suffix));
    }
    if let Some(ad) = &item.armour_data {
        for (k, label) in [("Armour", "Armour"), ("Evasion", "Evasion"), ("EnergyShield", "Energy Shield"), ("Ward", "Ward")] {
            if jf(ad, k).unwrap_or(0.0) > 0.0 {
                out.push(format!("{label}: {}", n0(jf(ad, k).unwrap_or(0.0))));
                if let Some(p) = jf(ad, &format!("{k}BasePercentile")) {
                    out.push(format!("{k}BasePercentile: {}", fmt_range(p)));
                }
            }
        }
    }
    let carry = ["Intangibility:", "Unique ID:", "League:", "Unreleased:", "Memory Strands:", "Cluster Jewel Skill:", "Cluster Jewel Node Count:", "Version:", "Selected Version:", "Variant:", "Selected Variant:", "Has Alt Variant", "Selected Alt Variant", "Allow Duplicate Variants:", "Crafted:", "Prefix:", "Suffix:"];
    let src: Vec<String> = text.lines().map(|l| l.trim().to_string()).collect();
    for c in &carry[..6] {
        for l in src.iter().filter(|l| l.starts_with(c)) {
            out.push(l.clone());
        }
    }
    for k in INFLUENCE_KEYS {
        if has_influence(&item, k) {
            out.push(format!("{} Item", influence_display(k)));
        }
    }
    if item.crafted {
        out.push("Crafted: true".into());
    }
    for c in &carry[16..] {
        for l in src.iter().filter(|l| l.starts_with(c)) {
            if !out.contains(l) {
                out.push(l.clone());
            }
        }
    }
    if let Some(c) = item.catalyst.filter(|c| *c > 0 && (*c as usize) <= CATALYSTS.len()) {
        out.push(format!("Catalyst: {}", CATALYSTS[c as usize - 1]));
    }
    if let Some(q) = item.catalyst_quality {
        out.push(format!("CatalystQuality: {}", n0(q)));
    }
    if let Some(t) = item.talisman_tier {
        out.push(format!("Talisman Tier: {}", n0(t)));
    }
    if let Some(l) = item.item_level {
        out.push(format!("Item Level: {}", n0(l)));
    }
    for c in &carry[6..16] {
        for l in src.iter().filter(|l| l.starts_with(c)) {
            if !out.contains(l) && !l.starts_with("Crafted:") {
                out.push(l.clone());
            }
        }
    }
    if let Some(q) = item.quality {
        out.push(format!("Quality: {}", n0(q)));
    }
    if !item.sockets.is_empty() {
        let mut s = String::from("Sockets: ");
        for (i, k) in item.sockets.iter().enumerate() {
            s.push(k.color);
            if let Some(next) = item.sockets.get(i + 1) {
                s.push(if next.group == k.group { '-' } else { ' ' });
            }
        }
        out.push(s);
    }
    if let Some(l) = item.requirements.level {
        out.push(format!("LevelReq: {}", n0(l)));
    }
    if let Some(l) = &item.jewel_radius_label {
        out.push(format!("Radius: {l}"));
    }
    if let Some(l) = item.limit {
        out.push(format!("Limited to: {}", n0(l)));
    }
    if let Some(c) = &item.class_restriction {
        out.push(format!("Requires Class {c}"));
    }
    let n = item.enchant_mod_lines.len() + item.implicit_mod_lines.len() + item.scourge_mod_lines.len();
    out.push(format!("Implicits: {n}"));
    for bucket in [&item.enchant_mod_lines, &item.scourge_mod_lines, &item.class_requirement_mod_lines, &item.implicit_mod_lines, &item.explicit_mod_lines, &item.crucible_mod_lines] {
        for ml in bucket.iter() {
            if ml.raw_line == usize::MAX {
                continue; // added by the base itself
            }
            out.push(write_mod_line(ml));
        }
    }
    if item.split {
        out.push("Split".into());
    }
    if item.mirrored {
        out.push("Mirrored".into());
    }
    if item.fractured {
        out.push("Fractured Item".into());
    }
    if item.corrupted {
        out.push("Corrupted".into());
    }
    if let Some(f) = &item.foil_type {
        out.push(format!("Foil Unique ({f})"));
    }
    Ok(out.join("\n"))
}
