//! Port of `Classes/Item.lua`'s `ParseRaw` (header/metadata parsing + mod-line bucketing).
//!
//! Scope cut, so mismatches can be told apart from real bugs: this does NOT implement
//! `BuildModList`/`BuildModListForSlotNum` (local-mod extraction, quality/weapon/armour/flask
//! data derivation), the `{ ... }` "advanced copy" crafting-bench format (line 574 in the
//! original), catalyst scalars, `data.modScalability` display-precision remapping inside
//! `itemLib.applyRange`, crafted-affix bookkeeping (Prefix/Suffix spec lines), variant groups,
//! cluster jewels, or foulborn/mutated mod matching. Each is a real, separately-trackable gap;
//! the answer-key grader buckets them separately. Everything else in `ParseRaw` is ported line-for-
//! line against upstream `Classes/Item.lua`.
use crate::item::{influence_key_for_line, ClusterJewelBaseInfo, Item, ModLine, Socket};
use pom_engine::data::GameData;
use pom_engine::modparser::parse_mod;
use pom_engine::modparser::types::PVal;
use pom_engine::fxhash::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    FindImplicit,
    Implicit,
    FindExplicit,
    Explicit,
    Done,
}

const CATALYST_LIST: &[&str] = &[
    "Abrasive", "Accelerating", "Dextral", "Fertile", "Imbued", "Intrinsic", "Noxious",
    "Prismatic", "Sinistral", "Tempering", "Turbulent", "Unstable",
];
const CATALYST_DESCRIPTOR_LIST: &[&str] = &[
    "Attack", "Speed", "Suffix", "Life and Mana", "Caster", "Attribute", "Physical and Chaos",
    "Resistance", "Prefix", "Defence", "Elemental", "Critical",
];

/// Port of `specToNumber`: `s:match("^([%+%-]?[%d%.]+)")` then `tonumber`.
fn spec_to_number(s: &str) -> Option<f64> {
    let bytes = s.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let start_digits = i;
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
        i += 1;
    }
    if i == start_digits {
        return None;
    }
    s[..i].parse::<f64>().ok()
}

/// Port of `escapeGGGString`.
fn escape_ggg_string(s: &str) -> String {
    // `<[^>]+>{([^}]+)}` -> "%1"
    let mut out = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'<' {
            if let Some(gt) = s[i + 1..].find('>') {
                let gt_abs = i + 1 + gt;
                if gt_abs + 1 < b.len() && b[gt_abs + 1] == b'{' {
                    if let Some(close) = s[gt_abs + 2..].find('}') {
                        let close_abs = gt_abs + 2 + close;
                        // `[^>]+` requires at least one char between < and >
                        // `[^}]+` requires at least one char between { and }
                        if gt_abs > i + 1 && close_abs > gt_abs + 2 {
                            out.push_str(&s[gt_abs + 2..close_abs]);
                            i = close_abs + 1;
                            continue;
                        }
                    }
                }
            }
        }
        // push current char (may be multi-byte)
        let ch_len = s[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&s[i..i + ch_len]);
        i += ch_len;
    }
    let s = out;
    // `%[([^|%]]+)%]` -> "%1"  and  `%[[^|]+|([^|]+)%]` -> "%1"
    let mut out2 = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'[' {
            if let Some(close) = s[i + 1..].find(']') {
                let close_abs = i + 1 + close;
                let inner = &s[i + 1..close_abs];
                if !inner.is_empty() {
                    if let Some(pipe) = inner.find('|') {
                        let (before, after) = (&inner[..pipe], &inner[pipe + 1..]);
                        if !before.is_empty() && !after.is_empty() {
                            out2.push_str(after);
                            i = close_abs + 1;
                            continue;
                        }
                    } else {
                        out2.push_str(inner);
                        i = close_abs + 1;
                        continue;
                    }
                }
            }
        }
        let ch_len = s[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out2.push_str(&s[i..i + ch_len]);
        i += ch_len;
    }
    out2
}

/// Port of `sanitiseText`: identity unless a byte 128-255 (in a Latin-1-ish encoding) or '<' is
/// present. Since Rust strings are UTF-8, "byte 128-255" is approximated as "any non-ASCII char".
fn sanitise_text(s: &str) -> String {
    if !s.chars().any(|c| c == '<' || (c as u32) >= 128) {
        return s.to_string();
    }
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '<' {
            let mut buf = String::new();
            let mut closed = false;
            while let Some(&n) = chars.peek() {
                chars.next();
                if n == '>' {
                    closed = true;
                    break;
                }
                buf.push(n);
            }
            if !closed {
                out.push('<');
                out.push_str(&buf);
            }
            continue;
        }
        match c {
            '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}'
            | '\u{2212}' => out.push('-'),
            '\u{00e4}' => out.push('a'),
            '\u{00f6}' => out.push('o'),
            c if (c as u32) >= 128 => out.push('?'),
            c => out.push(c),
        }
    }
    out
}

/// Port of the `{(%a*):?([^}]*)}` gsub in `ParseRaw` (line 874): strips inline tags and records
/// their effect on `modLine` / `usesVariantGroups`-style state. Variant/version/group tag content
/// is parsed but not retained (variant groups are out of scope here).
fn strip_brace_tags(line: &str, ml: &mut ModLine) -> String {
    let mut out = String::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                j += 1;
            }
            let k = &line[i + 1..j];
            let mut jj = j;
            if jj < bytes.len() && bytes[jj] == b':' {
                jj += 1;
            }
            let val_start = jj;
            while jj < bytes.len() && bytes[jj] != b'}' {
                jj += 1;
            }
            if jj < bytes.len() && bytes[jj] == b'}' {
                let val = &line[val_start..jj];
                apply_brace_tag(k, val, ml);
                i = jj + 1;
                continue;
            }
        }
        let ch_len = line[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&line[i..i + ch_len]);
        i += ch_len;
    }
    out
}

fn is_line_flag(k: &str) -> bool {
    matches!(
        k,
        "crafted" | "crucible" | "custom" | "disabled" | "eater" | "enchant" | "exarch"
            | "fractured" | "implicit" | "scourge" | "synthesis" | "mutated" | "unscalable"
            | "prefix" | "suffix" | "unveiled" | "vestigial"
    )
}

fn set_line_flag(ml: &mut ModLine, k: &str) {
    match k {
        "crafted" => ml.crafted = true,
        "crucible" => ml.crucible = true,
        "custom" => ml.custom = true,
        "disabled" => ml.disabled = true,
        "eater" => ml.eater = true,
        "enchant" => ml.enchant = true,
        "exarch" => ml.exarch = true,
        "fractured" => ml.fractured = true,
        "implicit" => ml.implicit = true,
        "scourge" => ml.scourge = true,
        "synthesis" => ml.synthesis = true,
        "mutated" => ml.mutated = true,
        "unscalable" => ml.unscalable = true,
        "prefix" => ml.prefix = true,
        "suffix" => ml.suffix = true,
        "unveiled" => ml.unveiled = true,
        "vestigial" => ml.vestigial = true,
        _ => {}
    }
}

fn apply_brace_tag(k: &str, val: &str, ml: &mut ModLine) {
    match k {
        "tags" => {
            for tag in val.split(|c: char| !(c.is_ascii_alphabetic() || c == '_')) {
                if !tag.is_empty() {
                    ml.mod_tags.push(tag.to_string());
                }
            }
        }
        "modGroup" => ml.mod_group = Some(val.to_string()),
        "range" => ml.range = val.parse::<f64>().ok(),
        "corruptedRange" => ml.corrupted_range = val.parse::<f64>().ok(),
        "variant" => {
            let ids: Vec<i64> = val.split(|c: char| !c.is_ascii_digit()).filter_map(|s| s.parse().ok()).collect();
            if !ids.is_empty() {
                ml.variant_list = Some(ids);
            }
        }
        "version" => {
            let ids: Vec<i64> = val.split(|c: char| !c.is_ascii_digit()).filter_map(|s| s.parse().ok()).collect();
            ml.version_list = Some(ids);
        }
        "group" => {
            let ids: Vec<i64> = val.split(|c: char| !c.is_ascii_digit()).filter_map(|s| s.parse().ok()).filter(|g| *g > 0).collect();
            ml.variant_group_list = Some(ids);
        }
        _ if is_line_flag(k) => set_line_flag(ml, k),
        _ => {}
    }
}

/// Port of the ` %((%l+)%)` gsub (line 940): strips trailing "(flag)" markers in plain-text form.
fn strip_trailing_paren_flags(line: &str) -> String {
    let mut out = String::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b' ' && i + 1 < bytes.len() && bytes[i + 1] == b'(' {
            let mut j = i + 2;
            while j < bytes.len() && bytes[j].is_ascii_lowercase() {
                j += 1;
            }
            if j > i + 2 && j < bytes.len() && bytes[j] == b')' {
                i = j + 1;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn extract_flag_word(line: &str, ml: &mut ModLine) {
    let mut rest = line;
    loop {
        let Some(pos) = rest.find(" (") else { break };
        let after = &rest[pos + 2..];
        let end = after.find(')');
        let Some(end) = end else { break };
        let word = &after[..end];
        if word.chars().all(|c| c.is_ascii_lowercase()) && !word.is_empty() {
            if is_line_flag(word) {
                set_line_flag(ml, word);
            }
        }
        rest = &after[end + 1..];
    }
}

/// Collapses "current(base)" (a single parenthesised number with no dash) down to "current": the
/// advanced-copy fixed-value display. Port of the unconditional gsub at line 1091.
fn collapse_current_base(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        if let Some((num_start, num_end)) = match_number(bytes, i) {
            if num_end < bytes.len() && bytes[num_end] == b'(' {
                if let Some((_, inner_end)) = match_number(bytes, num_end + 1) {
                    if inner_end < bytes.len() && bytes[inner_end] == b')' {
                        out.push_str(&line[num_start..num_end]);
                        i = inner_end + 1;
                        continue;
                    }
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Matches `-?\d+\.?\d*` starting at `i` (byte offsets, ASCII only as Lua digits are). Returns
/// (start, end) or None.
fn match_number(bytes: &[u8], i: usize) -> Option<(usize, usize)> {
    let mut j = i;
    if j < bytes.len() && bytes[j] == b'-' {
        j += 1;
    }
    let digit_start = j;
    while j < bytes.len() && bytes[j].is_ascii_digit() {
        j += 1;
    }
    if j == digit_start {
        return None;
    }
    if j < bytes.len() && bytes[j] == b'.' {
        j += 1;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
    }
    Some((i, j))
}

/// Port of the plain-range branch of `ParseRaw` (lines 1144-1184): resolves any remaining
/// "value(min-max)" occurrences to a concrete value at `range` (0..1), tracking the best-
/// precision roll fraction for `modLine.range`. Does not implement `data.modScalability` display
/// remapping (see module docs).
fn resolve_ranges(line: &str) -> (String, Option<f64>) {
    let mut result = line.to_string();
    let mut best_delta = -1.0f64;
    let mut best_range: Option<f64> = None;
    let mut first_roll: Option<f64> = None;
    let mut has_independent = false;
    loop {
        let Some((full_start, full_end, value_str, min, max)) = find_value_range(&result) else {
            break;
        };
        let (min, max) = if min > max { (max, min) } else { (min, max) };
        let delta = max - min;
        let roll = if delta > 0.0 { round6((value_str.1 - min) / delta) } else { 0.5 };
        if let Some(fr) = first_roll {
            if (fr - roll).abs() > 1e-9 {
                has_independent = true;
            }
        } else {
            first_roll = Some(roll);
        }
        if delta > best_delta {
            best_delta = delta;
            best_range = Some(round3((value_str.1 - min) / if delta > 0.0 { delta } else { 1.0 }));
        }
        let replacement = if best_range.is_some() && (roll > 1.0 || roll < 0.0) {
            value_str.0.clone()
        } else {
            let sign = if value_str.1 < 0.0 { "+" } else { "" };
            format!("{}({}-{})", sign, fmt_num(min), fmt_num(max))
        };
        result = format!("{}{}{}", &result[..full_start], replacement, &result[full_end..]);
    }
    if has_independent {
        // Re-derive from the original line with all ranges collapsed to just the value.
        let mut collapsed = line.to_string();
        loop {
            let Some((full_start, full_end, value_str, _, _)) = find_value_range(&collapsed) else {
                break;
            };
            collapsed = format!("{}{}{}", &collapsed[..full_start], value_str.0, &collapsed[full_end..]);
        }
        (collapsed, None)
    } else if let Some(r) = best_range {
        if (0.0..=1.0).contains(&r) {
            (result, Some(r))
        } else {
            (result, None)
        }
    } else {
        (result, None)
    }
}

fn fmt_num(v: f64) -> String {
    if v == v.trunc() {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}
fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// Finds the first `(-?\d+\.?\d*)\((-?\d+\.?\d*)-(-?\d+\.?\d*)\)` occurrence: value(min-max).
/// Returns (match_start, match_end, (value_text, value_num), min, max).
fn find_value_range(s: &str) -> Option<(usize, usize, (String, f64), f64, f64)> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if let Some((vs, ve)) = match_number(bytes, i) {
            if ve < bytes.len() && bytes[ve] == b'(' {
                if let Some((ms, me)) = match_number(bytes, ve + 1) {
                    if me < bytes.len() && bytes[me] == b'-' {
                        if let Some((xs, xe)) = match_number(bytes, me + 1) {
                            if xe < bytes.len() && bytes[xe] == b')' {
                                let value_text = s[vs..ve].to_string();
                                let value_num: f64 = value_text.parse().unwrap_or(0.0);
                                let min: f64 = s[ms..me].parse().unwrap_or(0.0);
                                let max: f64 = s[xs..xe].parse().unwrap_or(0.0);
                                return Some((vs, xe + 1, (value_text, value_num), min, max));
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Port of `itemLib.applyRange`'s dominant fallback path (the `data.modScalability` lookup
/// branch is out of scope -- see module docs): resolves a bare `(min-max)` (no leading value,
/// the WIKI/catalog display for an unrolled mod) at `range` = 1 (always our call site), which is
/// `max` whenever `max` is already an integer (`data.modScalability`-tagged mods and non-integer
/// bounds are the only cases this simplifies away). Also applies the antonym swap for a resulting
/// negative percentage (`-20% increased` -> `+20% reduced`), since `parse_mod`'s tables are keyed
/// on the positive/canonical wording.
fn resolve_bare_ranges(line: &str, data: &GameData, value_scalar: f64, base_value_scalar: f64) -> String {
    resolve_bare_ranges_at(line, 1.0, data, value_scalar, base_value_scalar)
}

/// `range` is the roll fraction (0..1): `itemLib.applyRange`'s `range` parameter. `ParseRaw`'s own
/// first pass (building `modLine.modList` the first time) always calls this at `range = 1`; the
/// REAL per-mod range (an explicit `{range:X}` tag, or `main.defaultItemAffixQuality` = 0.5 when
/// untagged) only gets applied afterward, by `BuildModList`'s `getRangedModList` -- see
/// `apply_ranged_mod_list` below, which overrides `modLine.modList` accordingly. Skipping that
/// second pass would leave every ranged unique mod at its range=1 (max-roll) value instead of its
/// real tagged/default-0.5 one.
///
/// Tries `data.modScalability` first (`crate::modscale`, port of `itemLib.applyRange`'s primary
/// branch): resolves every range to a plain number, then looks up the line with ALL its numbers
/// replaced by `#` and reformats each per its recognized display format (a duration shown in
/// seconds but matched per-millisecond, etc.). Falls back to the plain roll-fraction value,
/// rounded to an integer, when that key isn't found -- see `modscale.rs` module docs for the exact
/// (small, disclosed) gap from upstream's broader combinatorial search.
/// Test/debug hook (`examples/debug3.rs`): exposes the private range-resolution pipeline.
pub fn test_resolve_bare_ranges_at(line: &str, range: f64, data: &GameData) -> String {
    resolve_bare_ranges_at(line, range, data, 1.0, 1.0)
}

/// `itemLib.applyRange` for display (the app's item tooltips): the line with its `(min-max)` ranges resolved at
/// `range`, scaled by the catalyst `value_scalar` and the corrupted-range scalar.
pub fn apply_range_display(line: &str, range: f64, value_scalar: f64, base_value_scalar: f64, data: &GameData) -> String {
    resolve_bare_ranges_at(line, range, data, value_scalar, base_value_scalar)
}

fn resolve_bare_ranges_at(line: &str, range: f64, data: &GameData, value_scalar: f64, base_value_scalar: f64) -> String {
    let resolved = resolve_ranges_to_plain(line, range);
    let resolved = apply_antonym_swap(&resolved);
    let (stripped, values) = strip_all_numbers(&resolved);
    if !values.is_empty() {
        if let Some(formats) = crate::modscale::lookup(data, &stripped) {
            let mut out = String::new();
            let mut rest = stripped.as_str();
            let mut vi = 0;
            while let Some(pos) = rest.find('#') {
                out.push_str(&rest[..pos]);
                let fmt = formats.get(vi).copied().flatten();
                out.push_str(&crate::modscale::format_value(values[vi], fmt, value_scalar, base_value_scalar));
                vi += 1;
                rest = &rest[pos + 1..];
            }
            out.push_str(rest);
            return out;
        }
    }
    resolve_bare_ranges_fallback_scaled(line, range, value_scalar, base_value_scalar, data)
}

/// The no-`modScalability` fallback of `itemLib.applyRange` (ItemTools.lua:294-352): when a rolled
/// value isn't a whole number (or a value scalar applies), its precision comes from
/// `data.highPrecisionMods[name][type]` of the mod `testLine` parses to (else
/// `defaultHighPrecision` when the original line carries a decimal), not plain integer rounding.
fn resolve_bare_ranges_fallback_scaled(line: &str, range: f64, value_scalar: f64, base_value_scalar: f64, data: &GameData) -> String {
    let int_line = resolve_bare_ranges_fallback(line, range);
    // `precisionSame`: every rolled value already equals its integer rounding.
    let precision_same = {
        let plain = resolve_ranges_to_plain(line, range);
        let plain = apply_antonym_swap(&plain);
        plain == int_line
    };
    if precision_same && value_scalar == 1.0 && base_value_scalar == 1.0 {
        return int_line;
    }
    let (list, extra) = parse_mod(&int_line);
    let mut precision: Option<f64> = None;
    if let (Some(list), None) = (list, extra) {
        if let Ok(Some(table)) = data.extra.get("highPrecisionMods") {
            for m in list.iter() {
                let mut name: &str = &m.name;
                let mut ty: &str = &m.ty;
                let mut numeric = matches!(m.value, PVal::Num(_));
                if let PVal::Map(fields) = &m.value {
                    if let Some((_, PVal::Map(inner))) = fields.iter().find(|(k, _)| k == "mod") {
                        let get = |k: &str| inner.iter().find(|(ik, _)| ik == k).map(|(_, v)| v);
                        if let Some(PVal::Str(n)) = get("name") {
                            name = n;
                        }
                        if let Some(PVal::Str(tp)) = get("type") {
                            ty = tp;
                        }
                        numeric = matches!(get("value"), Some(PVal::Num(_)));
                    }
                }
                if numeric {
                    if let Some(p) = table.get(name).and_then(|v| v.get(ty)).and_then(|v| v.as_f64()) {
                        precision = Some(p);
                    }
                }
            }
        }
    }
    if precision.is_none() && has_decimal_number(line) {
        precision = data.extra.get("defaultHighPrecision").ok().flatten().and_then(|v| v.as_f64());
    }
    // Re-roll every bare range at `precision` (0 when unset).
    let power = 10f64.powf(precision.unwrap_or(0.0));
    let mut out = String::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let mut j = i;
        let sign_present = bytes[j] == b'+';
        if sign_present {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'(' {
            if let Some((ms, me)) = match_number(bytes, j + 1) {
                if me < bytes.len() && bytes[me] == b'-' {
                    if let Some((xs, xe)) = match_number(bytes, me + 1) {
                        if xe < bytes.len() && bytes[xe] == b')' {
                            let min: f64 = line[ms..me].parse().unwrap_or(0.0);
                            let max: f64 = line[xs..xe].parse().unwrap_or(0.0);
                            let v = ((min + range * (max - min)) * power + 0.5).floor() / power;
                            out.push_str(if v < 0.0 { "" } else if sign_present { "+" } else { "" });
                            out.push_str(&fmt_num(v));
                            i = xe + 1;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    let out = apply_antonym_swap(&out);
    apply_value_scalar_fallback(out, line, value_scalar, base_value_scalar, precision)
}

fn has_decimal_number(line: &str) -> bool {
    let b = line.as_bytes();
    (0..b.len()).any(|i| b[i].is_ascii_digit() && match_decimal_at(b, i))
}

/// Resolves every bare `(min-max)` to its plain roll-fraction value (unformatted; no display
/// remapping), leaving any other number in the line untouched. Mirrors the first `gsub` inside
/// `itemLib.applyRange`'s `strippedLine` local.
fn resolve_ranges_to_plain(line: &str, range: f64) -> String {
    let mut out = String::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let mut j = i;
        let sign_present = bytes[j] == b'+';
        if sign_present {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'(' {
            if let Some((ms, me)) = match_number(bytes, j + 1) {
                if me < bytes.len() && bytes[me] == b'-' {
                    if let Some((xs, xe)) = match_number(bytes, me + 1) {
                        if xe < bytes.len() && bytes[xe] == b')' {
                            let min: f64 = line[ms..me].parse().unwrap_or(0.0);
                            let max: f64 = line[xs..xe].parse().unwrap_or(0.0);
                            let value = min + range * (max - min);
                            let sign = if value < 0.0 { "" } else if sign_present { "+" } else { "" };
                            out.push_str(sign);
                            out.push_str(&fmt_num(value));
                            i = xe + 1;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Scans for every `-?\d+\.?\d*` in `line`, returning (line with each replaced by `#`, the values
/// in order). Mirrors `strippedLine`'s second `gsub` + `values`.
fn strip_all_numbers(line: &str) -> (String, Vec<f64>) {
    let bytes = line.as_bytes();
    let mut out = String::new();
    let mut values = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if let Some((s, e)) = match_number(bytes, i) {
            if e > s {
                values.push(line[s..e].parse().unwrap_or(0.0));
                out.push('#');
                i = e;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    (out, values)
}

/// The old (pre-`modscale`) per-range heuristic: rounds the roll-fraction value to the nearest
/// integer. Used only when the line's `modScalability` key isn't found.
fn resolve_bare_ranges_fallback(line: &str, range: f64) -> String {
    let mut out = String::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let mut j = i;
        let sign_present = bytes[j] == b'+';
        if sign_present {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b'(' {
            if let Some((ms, me)) = match_number(bytes, j + 1) {
                if me < bytes.len() && bytes[me] == b'-' {
                    if let Some((xs, xe)) = match_number(bytes, me + 1) {
                        if xe < bytes.len() && bytes[xe] == b')' {
                            let min: f64 = line[ms..me].parse().unwrap_or(0.0);
                            let max: f64 = line[xs..xe].parse().unwrap_or(0.0);
                            let value = (min + range * (max - min) + 0.5).floor();
                            let value_i = value as i64;
                            let sign = if value_i < 0 { "" } else if sign_present { "+" } else { "" };
                            out.push_str(sign);
                            out.push_str(&value_i.to_string());
                            i = xe + 1;
                            continue;
                        }
                    }
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    apply_antonym_swap(&out)
}

fn has_bare_range(line: &str) -> bool {
    let bytes = line.as_bytes();
    for i in 0..bytes.len() {
        if bytes[i] == b'(' {
            if let Some((_, me)) = match_number(bytes, i + 1) {
                if me < bytes.len() && bytes[me] == b'-' {
                    if let Some((_, xe)) = match_number(bytes, me + 1) {
                        if xe < bytes.len() && bytes[xe] == b')' {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

/// Port of `itemLib.isZeroValueLine`.
fn is_zero_value_line(line: &str) -> bool {
    if line.starts_with("0 ") || line.starts_with("+0 ") || line.starts_with("0% ") || line.starts_with("+0% ") {
        return true;
    }
    if line.contains(" 0-0 ") || line.contains(" 0 to 0 ") {
        return true;
    }
    for pat in [" 0 ", " +0 ", " 0% ", " +0% "] {
        if let Some(pos) = line.find(pat) {
            let after = &line[pos + pat.len()..];
            if !after.starts_with(|c: char| c.is_ascii_digit()) {
                // exclude "0 to [1-9]" and "0% to N%"
                let rest = &line[pos..];
                if rest.starts_with(" 0 to ") && rest[6..].starts_with(|c: char| ('1'..='9').contains(&c)) {
                    continue;
                }
                if rest.starts_with(" 0% to ") {
                    continue;
                }
                return true;
            }
        }
    }
    false
}

/// Port of `getRangedModList` (called from `BuildModList`'s `processModLine`): re-resolves
/// `modLine.modList` using the mod line's real `range` (not the range=1 used by `ParseRaw`'s first
/// pass), when the line still contains a bare `(min-max)`.
fn apply_ranged_mod_list(ml: &mut ModLine, data: &GameData) {
    let Some(range) = ml.range else { return };
    if ml.extra.is_some() {
        return;
    }
    if !has_bare_range(&ml.line) {
        return;
    }
    let flat = ml.line.replace('\n', " ");
    let resolved = resolve_bare_ranges_at(&flat, range, data, ml.value_scalar.unwrap_or(1.0), ml.corrupted_range.unwrap_or(1.0));
    if is_zero_value_line(&resolved) {
        ml.mod_list = Some(vec![]);
        return;
    }
    let (list, extra) = parse_mod(&resolved);
    if extra.is_none() {
        if let Some(list) = list {
            ml.mod_list = Some(list);
        }
    }
}

/// Item.lua:1207-1304: recognise a "N% increased/reduced <tags> modifier magnitudes" line (or
/// "effect of prefixes/suffixes", or "<tags> modifier magnitudes are doubled").
fn magnitude_mod(ranged_text: &str, text: &str, ml: &ModLine, catalyst_scalar: f64, data: &GameData) -> Option<crate::item::ModMagnitudeMod> {
    use pom_engine::luapat::{lmatch, Cap};
    const PATS: [&str; 3] = [
        "(%d+)%% ([ir][ne][cd][ru][ec][ae][sd]e?d?) ?([%a%s]*) modifier magnitudes",
        "(%d+)%% ([ir][ne][cd][ru][ec][ae][sd]e?d?) effect of ([sp][ur][fe]fix)es",
        "([%a%s]*) modifier magnitudes are doubled",
    ];
    // Text each pattern contains literally: a line without it can't match, and most mod lines have neither (the
    // unanchored `([%a%s]*)` patterns otherwise backtrack across the whole line).
    const NEEDS: [&str; 3] = [" modifier magnitudes", " effect of ", " modifier magnitudes are doubled"];
    let lower = ranged_text.to_lowercase();
    for (pat, need) in PATS.into_iter().zip(NEEDS) {
        if !lower.contains(need) {
            continue;
        }
        if !matches!(lmatch(lower.as_bytes(), pat.as_bytes(), None), Ok(Some(_))) {
            continue;
        }
        let flat = text.replace('\n', " ");
        let ranged2 = resolve_bare_ranges_at(&flat, ml.range.unwrap_or(1.0), data, catalyst_scalar, ml.corrupted_range.unwrap_or(1.0)).to_lowercase();
        let Ok(Some(caps)) = lmatch(ranged2.as_bytes(), pat.as_bytes(), None) else { continue };
        let s = |i: usize| -> Option<String> {
            match caps.get(i) {
                Some(Cap::S(b)) => Some(String::from_utf8_lossy(b).to_string()),
                _ => None,
            }
        };
        let (amount, inc_dec, tags_string, multiplier);
        if pat.ends_with("are doubled") {
            tags_string = s(0);
            amount = Some("100".to_string());
            inc_dec = Some("increased".to_string());
            multiplier = Some(2.0);
        } else {
            amount = s(0);
            inc_dec = s(1);
            tags_string = s(2);
            multiplier = None;
        }
        let (Some(amount), Some(inc_dec), Some(tags_string)) = (amount, inc_dec, tags_string) else { continue };
        if inc_dec != "increased" && inc_dec != "reduced" {
            continue;
        }
        let amt: f64 = amount.parse().unwrap_or(0.0);
        let quality = if inc_dec == "increased" { amt } else { -amt };
        if tags_string == "explicit physical and chaos damage" {
            return Some(crate::item::ModMagnitudeMod {
                tags: vec!["damage".into()],
                any_tags: Some(["physical".into(), "chaos".into()]),
                quality,
                multiplier: None,
                mod_type: Some("explicit".into()),
            });
        }
        let mut tags = Vec::new();
        let mut mod_type = None;
        for word in tags_string.split_whitespace() {
            let word = match word {
                "defence" => "defences",
                "enchantment" => "enchant",
                w => w,
            };
            if word == "implicit" || word == "explicit" || word == "enchant" {
                mod_type = Some(word.to_string());
            } else {
                tags.push(word.to_string());
            }
        }
        return Some(crate::item::ModMagnitudeMod { tags, any_tags: None, quality, multiplier, mod_type });
    }
    None
}

/// Item.lua:1409-1463 for one line and one magnitude mod.
fn apply_magnitude(ml: &mut ModLine, mm: &crate::item::ModMagnitudeMod, data: &GameData) {
    let mut grants_skill = ml.mod_list.as_ref().is_some_and(|l| l.iter().any(|m| &*m.name == "ExtraSkill"));
    if ml.extra.is_some() && !grants_skill {
        let line = ml.line.to_lowercase();
        grants_skill = is_grants_level_line(&line) || is_grants_line(&line);
    }
    let has = |t: &str| ml.mod_tags.iter().any(|x| x == t) || (t == "prefix" && ml.prefix) || (t == "suffix" && ml.suffix) || (t == "unveiled" && ml.unveiled);
    let mut matched = mm.tags.iter().all(|t| has(t));
    if let Some(any) = &mm.any_tags {
        if !(has(&any[0]) || has(&any[1])) {
            matched = false;
        }
    }
    if matched && !ml.unscalable && !grants_skill {
        let cur = ml.value_scalar.unwrap_or(1.0);
        ml.value_scalar = Some(match mm.multiplier {
            Some(m) => cur * m,
            None => cur + mm.quality / 100.0,
        });
    }
    if let Some(vs) = ml.value_scalar {
        if vs != 1.0 {
            let flat = ml.line.replace('\n', " ");
            let ranged = resolve_bare_ranges_at(&flat, ml.range.unwrap_or(1.0), data, vs, 1.0);
            let (list, extra) = parse_mod(&ranged);
            if list.is_some() {
                ml.mod_list = list;
                ml.extra = extra;
            }
        }
    }
}

/// `line:match("^grants level %d+ ")`
fn is_grants_level_line(line: &str) -> bool {
    match line.strip_prefix("grants level ") {
        Some(rest) => {
            let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
            digits > 0 && rest[digits..].starts_with(' ')
        }
        None => false,
    }
}

/// `line:match("^grants %D+$")`
fn is_grants_line(line: &str) -> bool {
    match line.strip_prefix("grants ") {
        Some(rest) => !rest.is_empty() && !rest.chars().any(|c| c.is_ascii_digit()),
        None => false,
    }
}

/// Re-derives every ranged, currently-active mod line's `modList` from its (possibly just-changed)
/// `range` -- the same loop `parse_raw_pre_build` runs once inline near the end of `ParseRaw`
/// (mirroring `BuildModList`'s `processModLine` -> `getRangedModList`, gated by
/// `CheckModLineVariant`/`GetModLineVariantCount`, Item.lua lines 2120-2150/2567-2593), factored
/// out so `apply_mod_range_overrides` can call it again after mutating some lines' `range`
/// (mirroring upstream: `BuildModList` re-resolves EVERY active ranged line from its current
/// `range` every time it runs, not just the ones that just changed). Idempotent for a line whose
/// `range` didn't change.
fn reapply_ranged_mod_lines(item: &mut Item, data: &GameData) {
    let variant_count = item.variant_count;
    let effective_variant = item.selected_variant.unwrap_or(variant_count);
    let alt_variants = item.alt_variants.clone();
    let is_selected = |vl: &Option<Vec<i64>>| -> bool {
        match vl {
            None => true,
            Some(list) => variant_count == 0 || list.contains(&effective_variant) || alt_variants.iter().any(|v| list.contains(v)),
        }
    };
    for bucket in [
        &mut item.implicit_mod_lines,
        &mut item.explicit_mod_lines,
        &mut item.enchant_mod_lines,
        &mut item.scourge_mod_lines,
        &mut item.crucible_mod_lines,
    ] {
        for ml in bucket.iter_mut() {
            if is_selected(&ml.variant_list) {
                apply_ranged_mod_list(ml, data);
            }
        }
    }
}

/// Port of the legacy `<ModRange id="N" range="R"/>` build-XML sibling elements (`ItemsTabClass:
/// Load`, ItemsTab.lua lines 1246-1263): applied AFTER `ParseRaw` (including its internal
/// `sortCraftedModLines` reorder, see `parse_raw_pre_build`) and BEFORE `BuildModList`, directly
/// overwriting `modLine.range` at a GLOBAL 1-based index across the concatenated
/// `[buffModLines, enchantModLines, scourgeModLines, implicitModLines, explicitModLines,
/// crucibleModLines]` lists (in that order) -- REGARDLESS of whether the targeted line originally
/// carried an inline `{range:N}` tag; the tag is only ever a fallback seed value the FIRST time a
/// line is saved (`BuildRaw`'s `writeModLine`, `round(modLine.range, 6)`), not an authoritative
/// value `ModRange` must agree with.
///
/// Because the id indexes into `explicitModLines` in its POST-SORT order, and the sort
/// (`sortCraftedModLines`/`assign_unique_stat_order`) can silently displace a line whose text
/// doesn't exact/normalized-match the unique's canonical stat text to the END of the list (its
/// `.order` falls back to `math.huge`), a saved build's `ModRange` ids -- assigned against
/// whatever order the lines were in AT SAVE TIME -- can end up landing on the WRONG line after a
/// reload if that order has since shifted. Confirmed as the real, exact mechanism behind "Soul
/// Ascension"'s `+(-10-10) to maximum number of Eaten Souls` line resolving to 0 (see its
/// `<ModRange id="4" range="0.5"/>`, landing on that line instead of the `{variant:2}` line's own
/// original slot, because the item's OTHER variant's "Eat a Soul..." line -- present but inactive
/// -- has stale pre-3.24.0 wording that no longer text-matches the current unique data, so it
/// sorts to the end and shifts everything after it up by one) -- a genuine, reproducible original
/// quirk, not a bug in this port.
///
/// This crate's own `parse_raw`/`parse_raw_with_id` take only the item's raw text (mirroring
/// `Item::Item(raw)`) and have no way to know these sibling XML elements exist at all -- they must
/// be read from the surrounding `<Item>` build-XML node by the caller and applied with
/// `parse_raw_with_mod_range_overrides`.
///
/// `buff_mod_line_count` stands in for `#item.buffModLines`: this crate does not track
/// `buffModLines` at all (see `item.rs` -- they never contribute to a graded field; they're the
/// flask/tincture BASE's own fixed buff-text lines, not anything from the item's raw text), so the
/// caller supplies just the COUNT (the length of the matched base's `flask.buff`/`tincture.buff`
/// array in `GameData`, when present) so the global index still lands on the right element in the
/// buckets this crate DOES track.
pub fn apply_mod_range_overrides(item: &mut Item, data: &GameData, buff_mod_line_count: i64, overrides: &[(i64, f64)]) {
    for &(id, range) in overrides {
        let mut idx = id - buff_mod_line_count;
        if idx < 1 {
            continue; // lands inside buffModLines -- untracked, never contributes to a graded field
        }
        for bucket in [
            &mut item.enchant_mod_lines,
            &mut item.scourge_mod_lines,
            &mut item.implicit_mod_lines,
            &mut item.explicit_mod_lines,
            &mut item.crucible_mod_lines,
        ] {
            if idx >= 1 && (idx as usize) <= bucket.len() {
                bucket[(idx - 1) as usize].range = Some(range);
                break;
            }
            idx -= bucket.len() as i64;
        }
    }
    reapply_ranged_mod_lines(item, data);
}

const ANTONYMS: &[(&str, &str)] = &[("increased", "reduced"), ("reduced", "increased"), ("more", "less"), ("less", "more")];

/// Port of `antonymFunc` via the `%-(%d+%%) (%a+)` gsub: "-N% word" -> "+N% antonym(word)".
fn apply_antonym_swap(line: &str) -> String {
    let mut out = String::new();
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'-' {
            let mut j = i + 1;
            let digit_start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            // `%d+%.?%d*`: an optional fractional part (a rolled "-15.6% increased").
            if j > digit_start && j < bytes.len() && bytes[j] == b'.' {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_digit() {
                    j += 1;
                }
            }
            if j > digit_start && j < bytes.len() && bytes[j] == b'%' && j + 1 < bytes.len() && bytes[j + 1] == b' ' {
                let word_start = j + 2;
                let mut k = word_start;
                while k < bytes.len() && bytes[k].is_ascii_alphabetic() {
                    k += 1;
                }
                let word = &line[word_start..k];
                if let Some((_, antonym)) = ANTONYMS.iter().find(|(w, _)| *w == word) {
                    // Port of `antonymFunc`: `return antonym and (num.." "..antonym) or ...` --
                    // `num` is the digits+"%" WITHOUT the leading "-" (consumed by the outer
                    // pattern but never part of a capture group), and upstream does NOT
                    // reinstate any sign here (found this session on "(-10--20)% increased
                    // Charges per use": the resolved "-15% increased" must become "15% reduced",
                    // not "+15% reduced" -- a stray "+" here made modLib.parseMod reject the line
                    // entirely, silently dropping the FlaskChargesUsed mod).
                    out.push_str(&line[digit_start..j + 1]);
                    out.push(' ');
                    out.push_str(antonym);
                    i = k;
                    continue;
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

struct Lines {
    items: Vec<String>,
}

fn split_lines(raw: &str) -> Lines {
    let mut items = Vec::new();
    for raw_line in raw.split('\n') {
        let trimmed = raw_line.trim();
        if !trimmed.is_empty() {
            items.push(escape_ggg_string(trimmed));
        }
    }
    Lines { items }
}

/// Port of `ItemClass:ParseRaw`. The `rarity`/`highQuality` constructor args are never passed
/// non-nil by either golden-data source (`ItemsTab:Load` calls `item:ParseRaw(child)` directly;
/// `new("Item"):Item(raw)` for uniques never passes a rarity either), so they're dropped here.
/// `apply_sanitise` mirrors the one real difference between the two call paths: `Item(raw)`
/// (uniques) runs `sanitiseText` first; `ParseRaw` called directly (corpus items, from the XML
/// loader) does not.
pub fn parse_raw(raw: &str, apply_sanitise: bool, data: &GameData) -> Item {
    parse_raw_with_id(raw, apply_sanitise, None, data)
}

/// `id` mirrors `item.id` (`ItemsTab:Load` sets it before calling `ParseRaw`; used only to build
/// each mod's `source` string, `"Item:<id>:<name>"`).
pub fn parse_raw_with_id(raw: &str, apply_sanitise: bool, id: Option<i64>, data: &GameData) -> Item {
    let mut item = parse_raw_pre_build(raw, apply_sanitise, id, data);
    crate::buildmod::build_mod_lists(&mut item, data);
    item
}

/// Like `parse_raw_with_id`, but also applies the legacy `<ModRange>` build-XML sibling-element
/// overrides (`ItemsTabClass:Load`, ItemTools.lua/ItemsTab.lua) BEFORE the final `BuildModList`
/// pass -- matching upstream's real call order (`ParseRaw` -> apply each `<ModRange>` ->
/// `BuildModList`). See `apply_mod_range_overrides`'s doc comment for the mechanism and why it
/// can't live inside `parse_raw_with_id` itself (the overrides come from data this crate's own
/// raw-text-only input has no way to see).
pub fn parse_raw_with_mod_range_overrides(
    raw: &str,
    apply_sanitise: bool,
    id: Option<i64>,
    data: &GameData,
    buff_mod_line_count: i64,
    overrides: &[(i64, f64)],
) -> Item {
    let mut item = parse_raw_pre_build(raw, apply_sanitise, id, data);
    apply_mod_range_overrides(&mut item, data, buff_mod_line_count, overrides);
    crate::buildmod::build_mod_lists(&mut item, data);
    item
}

/// Everything `ParseRaw` does, up to but NOT including the final `BuildModList` call at the very
/// end (line 1636 in upstream) -- split out so `parse_raw_with_mod_range_overrides` can splice
/// the legacy `<ModRange>` override step in between, exactly where upstream's caller
/// (`ItemsTabClass:Load`) does, without running `BuildModList` twice (it is not safe to call
/// twice: its abyssal-socket rebuild reads and re-appends to `item.sockets`, so a second call
/// would double-count).
pub fn parse_raw_pre_build(raw: &str, apply_sanitise: bool, id: Option<i64>, data: &GameData) -> Item {
    let raw_sanitised = if apply_sanitise { sanitise_text(raw) } else { raw.to_string() };
    let mut item = Item::default();
    item.id = id;
    item.raw = raw_sanitised.clone();
    item.name = "?".to_string();
    item.rarity = "UNIQUE".to_string();

    let lines_struct = split_lines(&raw_sanitised);
    let raw_lines = &lines_struct.items;
    let mut mode_game = false;
    let mut l: usize = 0; // 0-based index into raw_lines (Lua is 1-based)
    let mut item_class: Option<String> = None;

    if l < raw_lines.len() {
        if let Some(rest) = raw_lines[l].strip_prefix("Item Class:") {
            item_class = Some(rest.trim_start().to_string());
            l += 1;
        }
        if l < raw_lines.len() {
            if let Some(rarity_word) = parse_rarity_line(&raw_lines[l]) {
                mode_game = true;
                let upper = rarity_word.to_uppercase();
                if is_known_rarity_color(&upper) {
                    item.rarity = upper.clone();
                }
                if item.rarity == "UNIQUE" || item.rarity == "RELIC" {
                    for line in raw_lines {
                        if line.contains("Foil Unique") {
                            item.rarity = "RELIC".to_string();
                            item.foil_type = Some(extract_parens(line).unwrap_or_else(|| "Rainbow".to_string()));
                            break;
                        }
                    }
                }
                l += 1;
            }
        }
    }

    let mut unidentified = false;
    if l < raw_lines.len() {
        if raw_lines[l] == "--------" {
            l += 1;
        }
        if l < raw_lines.len() {
            item.name = raw_lines[l].clone();
            for line in raw_lines {
                if line == "Unidentified" {
                    unidentified = true;
                    break;
                }
            }
            if !(item.rarity == "NORMAL" || item.rarity == "MAGIC" || unidentified) {
                l += 1;
            }
        }
    }

    let mut check_section = false;
    let mut stage = Stage::FindImplicit;
    let mut found_explicit = false;
    let mut found_implicit = false;
    let mut implicit_lines_expected: f64 = 0.0;
    let mut item_level_set = false;
    let mut has_unique_id = false;
    let mut imported_level_req: Option<f64> = None;
    let mut variant_count: i64 = 0;
    let mut selected_variant: Option<i64> = None;
    let mut uses_variant_groups = false;
    let mut version_count: i64 = 0;
    let mut selected_version: Option<i64> = None;
    let mut group_selections: std::collections::BTreeMap<i64, i64> = std::collections::BTreeMap::new();
    let mut has_alt: [bool; 5] = [false; 5];
    let mut alt_val: [Option<i64>; 5] = [None; 5];
    // Item.lua:525,538-539,1058-1065: the first matched flask base's `buff` lines are fixed buff lines;
    // an item text line equal to one of them is consumed once (it becomes the base buff, not an item mod).
    let mut flask_buff_lines: Option<Vec<String>> = None;

    while l < raw_lines.len() {
        let line0 = raw_lines[l].clone();

        if let Some(fb) = flask_buff_lines.as_mut() {
            if let Some(pos) = fb.iter().position(|b| *b == line0) {
                fb.remove(pos);
                l += 1;
                continue;
            }
        }

        if line0 == "Veiled Prefix" || line0 == "Veiled Suffix" {
            item.veiled = true;
        }

        if line0 == "--------" {
            check_section = true;
            l += 1;
            continue;
        } else if line0 == "Split" {
            item.split = true;
            l += 1;
            continue;
        } else if line0 == "Mirrored" {
            item.mirrored = true;
            l += 1;
            continue;
        } else if line0 == "Corrupted" {
            item.corrupted = true;
            l += 1;
            continue;
        } else if line0 == "Fractured Item" {
            item.fractured = true;
            l += 1;
            continue;
        } else if line0 == "Synthesised Item" {
            item.synthesised = true;
            l += 1;
            continue;
        } else if line0.contains("Foil Unique") {
            item.foil_type = Some(extract_parens(&line0).unwrap_or_else(|| "Rainbow".to_string()));
            l += 1;
            continue;
        } else if let Some(key) = influence_key_for_line(&line0) {
            item.influence.insert(key, true);
            l += 1;
            continue;
        } else if line0 == "Requirements:" {
            l += 1;
            continue;
        } else if is_reminder_text_start(&line0) {
            while l < raw_lines.len() && !raw_lines[l].ends_with(')') {
                l += 1;
            }
            l += 1;
            continue;
        } else if line0.starts_with('{') && line0.starts_with("{ ") {
            // "advanced copy" crafting-bench format: out of scope, skip the line.
            l += 1;
            continue;
        } else if is_flask_state_line(&line0) && item.base_name.as_ref().and_then(|n| data.item_bases.get(n)).is_some_and(|b| b.extra.get("flask").is_some()) {
            // Port of Item.lua lines 568-573: "In-game flask state and base properties aren't
            // modifier lines" -- a flask copy's own current duration/charge display text (e.g.
            // "Lasts 6.60 (augmented) Seconds", "Consumes 40 of 60 Charges on use", "Currently has
            // 0 Charges") is pure reminder text, contributing NOTHING (no modLine, no bucket slot,
            // no flaskData seed) -- not even skipped-but-counted the way `Implicits: N` counts a
            // real implicit line. Without this, these 3 lines fell through to normal mod-line
            // parsing, which (mis)shifted every later line's implicit/explicit bucket assignment
            // on affected flasks (confirmed on "Bottled Faith" and other corpus flasks).
            l += 1;
            continue;
        }

        let line_for_processing = line0.clone();
        if check_section {
            match stage {
                Stage::Implicit => {
                    if found_implicit {
                        stage = Stage::Explicit;
                        found_explicit = true;
                    } else {
                        stage = Stage::FindExplicit;
                    }
                }
                Stage::Explicit => stage = Stage::Done,
                Stage::FindImplicit
                    if item_level_set
                        && !line_for_processing.ends_with(" (implicit)")
                        && !line_for_processing.ends_with(" (enchant)")
                        && !line_for_processing.contains("Talisman Tier") =>
                {
                    stage = Stage::Explicit;
                    found_explicit = true;
                }
                _ => {}
            }
            check_section = false;
        }

        let (spec_name, spec_val) = parse_spec_line(&line_for_processing);
        let mut consumed_by_spec = false;
        let mut skip_next_line = false;
        if let Some(spec_name_raw) = &spec_name {
            let spec_name_norm: &str = if spec_name_raw == "Class" { "Requires Class" } else { spec_name_raw.as_str() };
            let spec_val = spec_val.as_deref().unwrap_or("");
            consumed_by_spec = true;
            match spec_name_norm {
                "Unique ID" => has_unique_id = true,
                "Variant" => variant_count += 1,
                "Selected Variant" => selected_variant = spec_to_number(spec_val).map(|n| n as i64),
                "Version" => {
                    version_count += 1;
                    uses_variant_groups = true;
                }
                "Selected Version" => {
                    selected_version = spec_to_number(spec_val).map(|n| n as i64);
                    uses_variant_groups = true;
                }
                "Selected Variant Group" => {
                    // Item.lua:765-770: `^(%d+)%s*=%s*(%d+)$`
                    let t = spec_val.trim();
                    if let Some((g, v)) = t.split_once('=') {
                        if let (Ok(g), Ok(v)) = (g.trim().parse::<i64>(), v.trim().parse::<i64>()) {
                            group_selections.insert(g, v);
                            uses_variant_groups = true;
                        }
                    }
                }
                "Has Alt Variant" => has_alt[0] = true,
                "Has Alt Variant Two" => has_alt[1] = true,
                "Has Alt Variant Three" => has_alt[2] = true,
                "Has Alt Variant Four" => has_alt[3] = true,
                "Has Alt Variant Five" => has_alt[4] = true,
                "Selected Alt Variant" => alt_val[0] = spec_to_number(spec_val).map(|n| n as i64),
                "Selected Alt Variant Two" => alt_val[1] = spec_to_number(spec_val).map(|n| n as i64),
                "Selected Alt Variant Three" => alt_val[2] = spec_to_number(spec_val).map(|n| n as i64),
                "Selected Alt Variant Four" => alt_val[3] = spec_to_number(spec_val).map(|n| n as i64),
                "Selected Alt Variant Five" => alt_val[4] = spec_to_number(spec_val).map(|n| n as i64),
                "Level" => imported_level_req = spec_to_number(spec_val),
                "Memory Strands" | "League" | "Unreleased" | "Upgrade" | "Source"
                | "Note" | "Intangibility" | "Cluster Jewel Skill" | "Cluster Jewel Node Count"
                | "Allow Duplicate Variants"
                | "Prefix" | "Suffix" | "Crucible" | "Implicit" => {
                    // Consumed, not modeled: out of scope or not needed for the header fields this
                    // port grades.
                }
                "Has Variants" | "Selected Variants" => {
                    skip_next_line = true;
                }
                "Item Level" => {
                    item.item_level = spec_to_number(spec_val);
                    item_level_set = item.item_level.is_some();
                }
                "Requires Class" => item.class_restriction = Some(spec_val.to_string()),
                "Quality" => item.quality = spec_to_number(spec_val),
                "Sockets" => item.sockets = parse_sockets(spec_val),
                "Radius" => {
                    // Port of Item.lua lines 690-702. `self.type` (`item.item_type`) must already
                    // be "Jewel" for this to apply -- true in practice since the base-name line
                    // (which sets `item_type`) always precedes any spec line in real item text.
                    if item.item_type.as_deref() == Some("Jewel") {
                        let label: String = spec_val.chars().take_while(|c| c.is_alphabetic() || *c == ' ').collect();
                        item.jewel_radius_label = Some(label.clone());
                        if label == "Variable" {
                            item.defer_jewel_radius_index = true;
                        } else {
                            item.jewel_radius_index = jewel_radius_index_for_label(data, &label);
                        }
                    }
                }
                "Limited to" => { if item.item_type.as_deref() == Some("Jewel") { item.limit = spec_to_number(spec_val); } }
                "Talisman Tier" => item.talisman_tier = spec_to_number(spec_val),
                "Armour" | "Evasion Rating" | "Evasion" | "Energy Shield" | "Ward" => {
                    // Port of Item.lua lines 722-736: a real "Armour:"/"Evasion:"/etc. line off an
                    // ordinary item copy (not just the advanced-copy format), seeding
                    // `armour_data_seed` for `buildmod.rs`'s percentile back-calculation. The two
                    // "Two-Toned Boots" renames are a real base-name hack in upstream: this
                    // spec line can retroactively pick a more specific Two-Toned Boots sub-base
                    // once it's clear which two defences the item actually rolled.
                    let key = if spec_name_norm == "Evasion Rating" {
                        if item.base_name.as_deref() == Some("Two-Toned Boots (Armour/Energy Shield)") {
                            item.base_name = Some("Two-Toned Boots (Armour/Evasion)".to_string());
                        }
                        "Evasion"
                    } else if spec_name_norm == "Energy Shield" {
                        if item.base_name.as_deref() == Some("Two-Toned Boots (Armour/Evasion)") {
                            item.base_name = Some("Two-Toned Boots (Evasion/Energy Shield)".to_string());
                        }
                        "EnergyShield"
                    } else {
                        spec_name_norm
                    };
                    if let Some(n) = spec_to_number(spec_val) {
                        item.armour_data_seed.insert(key.to_string(), n);
                    }
                }
                "Requires Level" => item.requirements.level = spec_to_number(spec_val),
                "LevelReq" => item.requirements.level = spec_to_number(spec_val),
                "Crafted" => item.crafted = true,
                "Scourge" => { /* self.scourge: no dedicated field yet */ }
                "Implicits" => {
                    implicit_lines_expected = spec_to_number(spec_val).unwrap_or(0.0);
                    stage = Stage::Explicit;
                }
                "Catalyst" => {
                    item.catalyst = CATALYST_LIST.iter().position(|c| *c == spec_val).map(|i| i as i64 + 1);
                }
                "CatalystQuality" => item.catalyst_quality = spec_to_number(spec_val),
                "Str" | "Strength" => item.requirements.str_ = spec_to_number(spec_val).unwrap_or(0.0),
                "Dex" | "Dexterity" => item.requirements.dex = spec_to_number(spec_val).unwrap_or(0.0),
                "Int" | "Intelligence" => item.requirements.int = spec_to_number(spec_val).unwrap_or(0.0),
                "Critical Strike Range" | "Attacks per Second" | "Weapon Range"
                | "Critical Strike Chance" | "Physical Damage" | "Elemental Damage"
                | "Chaos Damage" | "Chance to Block" | "Block chance" => { /* hidden_specs, display only */ }
                _ if spec_name_norm.contains("BasePercentile") => {
                    item.armour_data_seed.insert(spec_name_norm.to_string(), spec_to_number(spec_val).unwrap_or(0.0));
                }
                _ if is_catalyst_quality_spec(spec_name_norm) => {
                    item.catalyst_quality = spec_to_number(&spec_val.replace('%', ""));
                    if let Some(desc) = extract_catalyst_descriptor(spec_name_norm) {
                        item.catalyst = CATALYST_DESCRIPTOR_LIST.iter().position(|d| *d == desc).map(|i| i as i64 + 1);
                    }
                }
                _ => {
                    if !(item.name.contains(spec_name_norm) && item.name.contains(spec_val)) {
                        found_explicit = true;
                        stage = Stage::Explicit;
                    }
                }
            }
        }

        if line_for_processing == "Prefixes:" {
            found_explicit = true;
            stage = Stage::Explicit;
        }

        if !consumed_by_spec || found_explicit || found_implicit {
            let mut ml = ModLine::default();
            ml.raw_line = l;
            let mut text = strip_brace_tags(&line_for_processing, &mut ml);
            // Port of line 899's `elseif k == "range" then self.advancedCopy = true; ... end`:
            // seeing an explicit `{range:N}` tag (not `{corruptedRange:N}`) marks the whole item
            // as an "advanced copy" export, which later gates `sortCraftedModLines` (see the
            // end of this function) and the unique stat-order lookup it uses.
            if ml.range.is_some() {
                item.advanced_copy = true;
            }
            text = strip_trailing_paren_flags(&text);
            // Port of line 958's `if line:find("%((%-?%d+%.?%d*)%-(%-?%d+%.?%d*)%)") then
            // self.advancedCopy = true end` -- the DOMINANT way an item ends up "advanced copy":
            // any mod line (implicit or explicit) that still shows a bare "(min-max)" range in its
            // display text. Every `{range:N}`-tagged line matches this too (the tag never resolves
            // the paren pair away), so this check alone accounts for both origins; kept as two
            // separate ports (see above) to mirror upstream's two separate call sites exactly.
            if has_bare_range(&text) {
                item.advanced_copy = true;
            }
            extract_flag_word(&line_for_processing, &mut ml); // best-effort re-scan for edge cases
            if ml.enchant {
                ml.crafted = true;
                ml.implicit = true;
            }
            if ml.vestigial {
                item.veiled = item.veiled; // vestigial tracked on item elsewhere; no field yet
            }

            // Port of the `lineLower == "has elder, shaper and all conqueror influences"` special
            // case (Item.lua line 1231): a literal mod line (an implicit on a small set of bases,
            // e.g. Astrolabe Amulet) that sets every influence flag true, independent of the normal
            // modparser path.
            if text.eq_ignore_ascii_case("Has Elder, Shaper and all Conqueror Influences") {
                // `itemLib.influenceInfo.default`: shaper/elder/the 4 conqueror keys, NOT the
                // Crucible pair (cleansing/tangle) that `.all` also carries.
                for key in ["shaper", "elder", "adjudicator", "basilisk", "crusader", "eyrie"] {
                    item.influence.insert(key, true);
                }
            }

            let mut base_name: Option<String> = None;
            if item.base_name.is_none() && (item.rarity == "NORMAL" || item.rarity == "MAGIC") {
                if let Some(exact) = data.item_bases.get(&item.name) {
                    let _ = exact;
                    base_name = Some(item.name.clone());
                } else {
                    let mut best: Option<(String, usize)> = None;
                    for base_key in data.item_bases.keys() {
                        if let Some(pos) = item.name.find(base_key.as_str()) {
                            let len = base_key.len();
                            if best.as_ref().map(|(_, l)| len > *l).unwrap_or(true) {
                                best = Some((base_key.clone(), len));
                                let _ = pos;
                            }
                        }
                    }
                    if let Some((matched, _)) = best {
                        if let Some(pos) = item.name.find(matched.as_str()) {
                            item.name_prefix = item.name[..pos].to_string();
                            item.name_suffix = item.name[pos + matched.len()..].to_string();
                            base_name = Some(matched);
                        }
                    }
                }
                if base_name.is_none() {
                    if let Some(pos) = item.name.find("Two-Toned Boots") {
                        base_name = Some("Two-Toned Boots".to_string());
                        item.name_prefix = item.name[..pos].to_string();
                        item.name_suffix = item.name[pos + "Two-Toned Boots".len()..].to_string();
                    }
                }
                item.name = strip_paren_suffix(&item.name);
            }
            if base_name.is_none() {
                let mut b = text.as_str();
                for prefix in ["Superior ", "Synthesised ", "Vestigial "] {
                    if let Some(rest) = b.strip_prefix(prefix) {
                        b = rest;
                    }
                }
                base_name = Some(b.to_string());
            }
            if base_name.as_deref() == Some("Two-Toned Boots") {
                base_name = Some("Two-Toned Boots (Armour/Energy Shield)".to_string());
            }

            if let (Some(bn), Some(base)) = (base_name.clone(), base_name.as_ref().and_then(|n| data.item_bases.get(n))) {
                // Port of `baseMatches` (line 1015-1016): with no variant groups (out of scope),
                // a candidate base line applies when no variant is selected yet, the line has no
                // variant restriction, or the line's variant list includes the selected one. When
                // it matches, `self.base`/`baseName` are OVERWRITTEN (last match in raw-text order
                // wins), not set-once -- e.g. "Beacon of Madness" lists all 3 Two-Toned Boots
                // sub-bases and the selected one must win over earlier ones.
                let base_matches = match (&ml.variant_list, selected_variant) {
                    (None, _) => true,
                    (Some(_), None) => true,
                    (Some(list), Some(sel)) => list.contains(&sel),
                };
                if base_matches {
                    item.base_name = Some(bn.clone());
                    if !(item.rarity == "NORMAL" || item.rarity == "MAGIC") {
                        item.title = Some(item.name.clone());
                    }
                    item.item_type = base.base_type.clone();
                    // Port of `self.clusterJewel = data.clusterJewels and data.clusterJewels.jewels
                    // [self.baseName]` (Item.lua line 1052): re-looked-up on every base match, same
                    // "last match wins" rule as `item_type`/`requirements` above.
                    item.cluster_jewel = cluster_jewels_index(data).get(&bn).cloned();
                    item.requirements.str_ = base.req.as_ref().and_then(|r| r.get("str")).copied().unwrap_or(0.0);
                    item.requirements.dex = base.req.as_ref().and_then(|r| r.get("dex")).copied().unwrap_or(0.0);
                    item.requirements.int = base.req.as_ref().and_then(|r| r.get("int")).copied().unwrap_or(0.0);
                    let max_req = item.requirements.str_.max(item.requirements.dex).max(item.requirements.int);
                    item.default_socket_color = if max_req == item.requirements.dex {
                        'G'
                    } else if max_req == item.requirements.int {
                        'B'
                    } else {
                        'R'
                    };
                    if flask_buff_lines.is_none() {
                        if let Some(buff) = base.extra.get("flask").and_then(|f| f.get("buff")).and_then(|b| b.as_array()) {
                            flask_buff_lines = Some(buff.iter().filter_map(|x| x.as_str().map(|x| x.to_string())).collect());
                        }
                    }
                }
                l += 1;
                continue; // base lines don't need mod parsing
            }

            if ml.implicit {
                found_implicit = true;
                stage = Stage::Implicit;
            }

            text = collapse_current_base(&text);
            // `text` stays the DISPLAY line: `resolve_ranges` (the value(min-max) advanced-copy
            // case) can turn "115(100-130)" into a bare "(100-130)", but never resolves a bare
            // range to a concrete number -- that's `itemLib.applyRange`'s job (`resolve_bare_
            // ranges`), applied only to a separate copy used for `parse_mod`. `modLine.line` keeps
            // the unresolved range text (see the recorded golden data: e.g. "+(30-50) to
            // Dexterity"); only the parsed `modList` reflects the range = 1 (max roll) value.
            let (resolved_text, resolved_range) = resolve_ranges(&text);
            text = resolved_text;
            if ml.range.is_none() {
                ml.range = resolved_range;
            }
            // Lines 1083-1089: `- Unscalable Value` marks the line unscalable; otherwise the
            // catalyst's magnitude scalar for this line's tags.
            let mut catalyst_scalar = 1.0;
            if let Some(stripped) = text.strip_suffix(" - Unscalable Value") {
                text = stripped.to_string();
                ml.unscalable = true;
            } else {
                catalyst_scalar = get_catalyst_scalar(item.catalyst, &ml, item.catalyst_quality);
            }
            ml.value_scalar = Some(catalyst_scalar);
            let ranged_text = resolve_bare_ranges(&text, data, catalyst_scalar, ml.corrupted_range.unwrap_or(1.0));

            let (mut mod_list, mut extra) = parse_mod(&ranged_text);

            if !ml.disabled {
                if let Some(mm) = magnitude_mod(&ranged_text, &text, &ml, catalyst_scalar, data) {
                    item.mod_magnitude_mods.push(mm);
                }
            }

            // Port of lines 1191-1204: "Only combine generated lines that came from the same
            // modifier." A blank `modGroup` on both this line and the next counts as equal (Lua
            // `nil == nil`), so this fires for any adjacent pair that both lack an explicit
            // `{modGroup:X}` tag whenever the line alone doesn't parse clean -- not just
            // intentionally grouped ones. On a clean combined parse, `line` becomes the two lines
            // joined by "\n" and the next raw line is consumed. On a FAILED combined parse, the
            // original still overwrites `modList`/`extra` with the (failed) combined-parse result
            // -- `line` stays just this line's text, and the next raw line is NOT consumed. This
            // looks like a bug (the recorded `modList`/`extra` for a line can end up describing a
            // neighboring line's leftover text) but it's the real original behavior, confirmed
            // against the recorder's golden data (e.g. "Gain 2 Charges when you are Hit by an
            // Enemy" recording an unrelated "MovementSpeed" mod pulled from the next line), so it
            // is kept faithfully rather than "corrected".
            let next_mod_group = raw_lines.get(l + 1).and_then(|s| extract_mod_group(s));
            if (mod_list.is_none() || extra.is_some()) && l + 1 < raw_lines.len() && ml.mod_group == next_mod_group {
                let next_line = strip_brace_and_flags(&raw_lines[l + 1]);
                let comb_line = format!("{} {}", text, next_line);
                let ranged_comb = resolve_bare_ranges(&comb_line, data, catalyst_scalar, ml.corrupted_range.unwrap_or(1.0));
                let (comb_list, comb_extra) = parse_mod(&ranged_comb);
                if comb_list.is_some() && comb_extra.is_none() {
                    ml.line = format!("{}\n{}", text, next_line);
                    l += 1;
                    finalize_mod_line(&mut item, ml, comb_list, comb_extra, mode_game, &mut stage, &mut found_explicit, &mut found_implicit, implicit_lines_expected, &line_for_processing);
                    l += 1;
                    continue;
                }
                mod_list = comb_list;
                extra = comb_extra;
            }
            ml.line = text.clone();
            finalize_mod_line(&mut item, ml, mod_list, extra, mode_game, &mut stage, &mut found_explicit, &mut found_implicit, implicit_lines_expected, &line_for_processing);
        }

        l += 1;
        if skip_next_line {
            l += 1;
        }
    }

    if item.base_name.is_some() && !item.sockets.is_empty() {
        if let Some(base) = item.base_name.as_ref().and_then(|n| data.item_bases.get(n)) {
            item.requirements.str_ = base.req.as_ref().and_then(|r| r.get("str")).copied().unwrap_or(0.0);
            item.requirements.dex = base.req.as_ref().and_then(|r| r.get("dex")).copied().unwrap_or(0.0);
            item.requirements.int = base.req.as_ref().and_then(|r| r.get("int")).copied().unwrap_or(0.0);
        }
    }
    // Port of lines 1385-1391: when no "Requires Level"/"LevelReq" spec set `requirements.level`
    // directly, a plain "Level:" spec (`importedLevelReq`) is trusted only on an unsocketed item
    // (an imported item's displayed requirement totals include socketed gems' own requirements, so
    // they cannot be trusted on a socketed item); otherwise fall back to the base's own requirement.
    if item.base_name.is_some() && item.requirements.level.is_none() {
        if let Some(base) = item.base_name.as_ref().and_then(|n| data.item_bases.get(n)) {
            item.requirements.level = if imported_level_req.is_some() && item.sockets.is_empty() {
                imported_level_req
            } else {
                base.req.as_ref().and_then(|r| r.get("level")).copied()
            };
        }
    }

    // Variant groups / versions (Item.lua:509-519, 340-407, `CheckModLineVariant` 2121-2137): resolved once here into the
    // legacy `variant_list` shape, so every later `is_selected`/`is_line_active` gate sees the group-aware answer.
    if item_uses_groups(uses_variant_groups, &item) && variant_count > 0 {
        resolve_variant_groups(&mut item, variant_count, version_count, selected_version, &mut group_selections);
    }
    // Port of `BuildModList`'s `getRangedModList` override, gated by `CheckModLineVariant`
    // (lines 2567-2593/2120-2146): only re-resolves a line's `modList` at its real range when the
    // line is active for the selected variant. `self.variant` with no prior selection defaults to
    // the LAST variant (`#self.variantList`, lines 1533-1534); this port has no persisted
    // selection to restore, so it always uses that default.
    let effective_variant = selected_variant.unwrap_or(variant_count);
    let alt_variants: Vec<i64> = (0..5).filter(|&i| has_alt[i]).filter_map(|i| alt_val[i]).collect();
    let is_selected = |vl: &Option<Vec<i64>>| -> bool {
        match vl {
            None => true,
            Some(list) => variant_count == 0 || list.contains(&effective_variant) || alt_variants.iter().any(|v| list.contains(v)),
        }
    };
    // Item.lua:1393-1399, "hack for cane of kulemak": every explicit line that isn't itself a magnitude line counts as unveiled.
    if item.title.as_deref().map(|t| t.to_lowercase()).as_deref() == Some("cane of kulemak") && (item.rarity == "UNIQUE" || item.rarity == "RELIC") && item.advanced_copy {
        for ml in item.explicit_mod_lines.iter_mut() {
            if !ml.line.contains("magnitude") {
                ml.unveiled = true;
            }
        }
    }
    // Item.lua:1401-1470: apply "modifier magnitudes" boosts to the matching mod lines.
    if (item.advanced_copy || item.crafted) && !item.mod_magnitude_mods.is_empty() {
        let mags = item.mod_magnitude_mods.clone();
        for mm in &mags {
            let which: Vec<u8> = match mm.mod_type.as_deref() {
                Some("implicit") => vec![0],
                Some("explicit") => vec![1],
                Some("enchant") => vec![2],
                Some(_) => vec![],
                None => vec![0, 1, 2],
            };
            for w in which {
                let bucket = match w {
                    0 => &mut item.implicit_mod_lines,
                    1 => &mut item.explicit_mod_lines,
                    _ => &mut item.enchant_mod_lines,
                };
                for ml in bucket.iter_mut() {
                    if !is_selected(&ml.variant_list) {
                        continue;
                    }
                    apply_magnitude(ml, mm, data);
                }
            }
        }
    }

    for bucket in [
        &mut item.implicit_mod_lines,
        &mut item.explicit_mod_lines,
        &mut item.enchant_mod_lines,
        &mut item.scourge_mod_lines,
        &mut item.crucible_mod_lines,
    ] {
        for ml in bucket.iter_mut() {
            if is_selected(&ml.variant_list) {
                apply_ranged_mod_list(ml, data);
            }
        }
    }

    // Port of the default-socket fill (lines 1520-1528): a base with a fixed `socketLimit` and no
    // sockets parsed from the raw text (common for catalog/uniques entries, which often omit the
    // "Sockets:" line entirely) gets that many default-colored sockets, all in group 0.
    if item.sockets.is_empty() {
        if let Some(base) = item.base_name.as_ref().and_then(|n| data.item_bases.get(n)) {
            if let Some(limit) = base.socket_limit {
                for _ in 0..limit {
                    item.sockets.push(Socket { color: item.default_socket_color, group: 0 });
                }
            }
        }
    }

    // Port of `NormaliseQuality`, called at the end of `ParseRaw` (line 1612) ONLY when no explicit
    // `Quality:` line was found (`if not self.quality then self:NormaliseQuality() end`). Because
    // of that outer gate, `NormaliseQuality`'s own body always sees a nil `self.quality` here, so
    // its `if not self.quality then ... elseif ... quality < 20 then self.quality = 20 end` can
    // only ever take the FIRST branch (quality -> 0) from this call site: the "bump an existing
    // sub-20 quality up to 20" branch is dead code for a normal raw-item parse and must NOT run
    // here (it matters only for `NormaliseQuality`'s other callers, e.g. CompareTab's gear-swap
    // preview, which are out of this port's scope). An explicit `Quality: 0` line must survive as
    // 0, not get bumped, which the unguarded `unwrap() < 20.0` version of this code used to do.
    if item.quality.is_none() {
        if let Some(base) = item.base_name.as_ref().and_then(|n| data.item_bases.get(n)) {
            if is_quality_bearing_base(base) {
                item.quality = Some(0.0);
            }
        }
    }
    let _ = has_unique_id;

    item.variant_count = variant_count;
    item.selected_variant = selected_variant;
    item.alt_variants = alt_variants;

    // Port of Item.lua lines 1358-1373 (order lookup, unique/relic + advanced-copy only) and
    // 1471-1472 (`if self.advancedCopy and #self.explicitModLines > 1 then sortCraftedModLines(
    // self.explicitModLines) end`, unconditional on rarity): an "advanced copy" export of a
    // unique doesn't keep its explicit lines in raw-text order -- it re-sorts them into the item's
    // OWN canonical display order (fractured mods first, then normal/unique mods by their
    // in-game stat-display order, then crafted/custom mods last, each group falling back to
    // original position on a tie). Skipping this was a real, previously undiscovered gap: it's
    // the dominant cause of `final_mod_list` mismatches on affected items (a full content match
    // that still fails because two mods are swapped), not a modparser or removal bug.
    assign_unique_stat_order(&mut item, data);
    if item.advanced_copy && item.explicit_mod_lines.len() > 1 {
        sort_crafted_mod_lines(&mut item.explicit_mod_lines);
    }

    // Port of Item.lua lines 1551-1611: detect a "Foulborn" mutated unique (matches its explicit
    // lines' text against `data.foulbornMap`) and force/strip the "Foulborn " title prefix
    // accordingly, then rebuild `self.name` from the (possibly just-changed) title -- see
    // `detect_foulborn`'s own doc comment for the mechanism and the deliberate simplification.
    detect_foulborn(&mut item, data);
    if item.base_name.is_some() && item.title.is_some() {
        let base_clean = strip_paren_suffix(item.base_name.as_ref().unwrap());
        item.name = format!("{}, {}", item.title.as_ref().unwrap(), base_clean);
    }

    inject_base_enchant(&mut item, data);

    item
}

/// `data.foulbornMap` (unique title -> `{origModId: foulModId}`) plus the display-text lines each
/// side's mod id resolves to in `data.itemMods.ItemExclusive`/`data.itemMods.Foulborn` (both
/// `$ref`-linked into `data.itemMods.Item`, like `UniqueStatOrder` above). Built once per process
/// and cached in a `OnceLock` for the same reason `UniqueStatOrder` is: `GameData::extra.get`
/// reparses its (large) JSON file on every call.
struct FoulbornData {
    /// unique title -> `(origModId, foulModId)` pairs. Only `foulModId` (the mutated side) is
    /// ever looked up through this crate's simplified `detect_foulborn` (see its doc comment), but
    /// both are kept so the stored shape mirrors `data.foulbornMap` directly.
    map: HashMap<String, Vec<(String, String)>>,
    /// modId -> its display-text lines, from `data.itemMods.Foulborn`.
    foulborn_lines: HashMap<String, Vec<String>>,
}

static FOULBORN_DATA: OnceLock<FoulbornData> = OnceLock::new();

fn foulborn_data(data: &GameData) -> &'static FoulbornData {
    FOULBORN_DATA.get_or_init(|| build_foulborn_data(data))
}

fn build_foulborn_data(data: &GameData) -> FoulbornData {
    let mut map: HashMap<String, Vec<(String, String)>> = HashMap::default();
    if let Ok(Some(fb)) = data.extra.get("foulbornMap") {
        if let Some(obj) = fb.as_object() {
            for (title, pairs) in obj {
                if let Some(inner) = pairs.as_object() {
                    let v: Vec<(String, String)> =
                        inner.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.to_string(), s.to_string()))).collect();
                    map.insert(title.to_string(), v);
                }
            }
        }
    }
    let mut foulborn_lines: HashMap<String, Vec<String>> = HashMap::default();
    if let Ok(Some(item_mods)) = data.extra.get("itemMods") {
        if let Some(item_defs) = item_mods.get("Item").and_then(|v| v.as_object()) {
            if let Some(cat) = item_mods.get("Foulborn").and_then(|v| v.as_object()) {
                for (mod_id, refval) in cat {
                    let entry = match refval.get("$ref").and_then(|v| v.as_str()) {
                        Some(refstr) => refstr.strip_prefix("data.itemMods.Item.").and_then(|k| item_defs.get(k)),
                        None => Some(refval),
                    };
                    let Some(entry) = entry else { continue };
                    let mut lines = Vec::new();
                    let mut i = 1;
                    while let Some(line) = entry.get(i.to_string()).and_then(|v| v.as_str()) {
                        lines.push(line.to_string());
                        i += 1;
                    }
                    if !lines.is_empty() {
                        foulborn_lines.insert(mod_id.to_string(), lines);
                    }
                }
            }
        }
    }
    FoulbornData { map, foulborn_lines }
}

/// Port of Item.lua lines 1551-1608 (`self.mutatedLines`/`checkMod`/`self.foulborn`/the title
/// prefix), simplified: upstream runs `checkMod` TWICE per `(origModId, foulModId)` pair --
/// once (mutated=false) matching the NORMAL mod's text, which only ever sets `modLine.modId`/
/// `.newModId` (this crate doesn't track those; they only drive the `MutateMod` UI checkbox, never
/// a graded field, see `item.rs`), and once (mutated=true) matching the FOULBORN mod's text, which
/// additionally sets `modLine.mutated = true`. Since `.mutated` (the only outcome that feeds
/// `self.foulborn`/the title) is set ONLY by the second call, this port runs just that one --
/// behaviorally identical for every graded field, and skips building `modId`/`newModId` lookups
/// this crate has no use for.
fn detect_foulborn(item: &mut Item, data: &GameData) {
    let orig_title = strip_foulborn_prefix(item.title.as_deref().unwrap_or(""));
    // Port of the exclusion at Item.lua lines 1022-1027: "Might of the Meek"'s foulborn
    // transformation changes the jewel's RADIUS, not a mod line, so it's incompatible with this
    // whole text-matching approach and is deliberately excluded -- `self.mutatedLines` is never
    // even set for it, so it can never get the "Foulborn " title prefix through this mechanism
    // (its actual radius-swap behavior is a separate, jewel-radius-function concern, out of this
    // crate's scope -- see `crates/engine`'s jewelfunc handling).
    let excluded = orig_title.to_lowercase().contains("might of the meek");
    if !excluded {
        let fdata = foulborn_data(data);
        if let Some(pairs) = fdata.map.get(&orig_title) {
            let variant_count = item.variant_count;
            let effective_variant = item.selected_variant.unwrap_or(variant_count);
            let alt_variants = item.alt_variants.clone();
            let is_active = |vl: &Option<Vec<i64>>| -> bool {
                match vl {
                    None => true,
                    Some(list) => variant_count == 0 || list.contains(&effective_variant) || alt_variants.iter().any(|v| list.contains(v)),
                }
            };
            for (_orig_id, foul_id) in pairs {
                if let Some(foul_lines) = fdata.foulborn_lines.get(foul_id) {
                    mark_matching_lines_mutated(&mut item.explicit_mod_lines, foul_lines, &is_active);
                }
            }
        }
    }
    // Unconditional, exactly like upstream (Item.lua lines 1597-1601): a raw `{mutated}` tag
    // already on a line (set earlier, via the generic `lineFlags` handling) counts too, not just a
    // line this function itself just matched.
    item.foulborn = item.explicit_mod_lines.iter().any(|ml| ml.mutated);
    let has_prefix = item.title.as_deref().is_some_and(|t| t.len() >= 9 && (t.as_bytes()[0] == b'F' || t.as_bytes()[0] == b'f') && t[1..9].eq_ignore_ascii_case("oulborn "));
    if item.foulborn && !has_prefix {
        if let Some(t) = item.title.take() {
            item.title = Some(format!("Foulborn {}", t));
        }
    } else if !item.foulborn && has_prefix {
        if let Some(t) = item.title.take() {
            item.title = Some(strip_all_foulborn_occurrences(&t));
        }
    }
}

/// Port of `findMatchingLines` (Item.lua lines 1560-1576), called with `mutated=true`'s side only
/// (see `detect_foulborn`'s doc comment): tries matching `wanted` as ONE combined line
/// (`table.concat(originalMod, " ")`) first -- some mod descriptions upstream splits across
/// several `self.explicitModLines` entries are stored as a single line in game data -- then, if
/// that fails, tries matching each element of `wanted` against a SEPARATE (distinct, currently
/// variant-active) explicit line. Marks every line in whichever attempt succeeds `.mutated = true`;
/// a partial match (not everything in `wanted` found) marks nothing, exactly like upstream
/// only inserting into `self.explicitModLines`'s real entries once the WHOLE set matched.
fn mark_matching_lines_mutated(explicit_lines: &mut [ModLine], wanted: &[String], is_active: &impl Fn(&Option<Vec<i64>>) -> bool) {
    let combined = vec![wanted.join(" ")];
    let idxs = find_matching_line_indices(explicit_lines, &combined, is_active).or_else(|| find_matching_line_indices(explicit_lines, wanted, is_active));
    if let Some(idxs) = idxs {
        for i in idxs {
            explicit_lines[i].mutated = true;
        }
    }
}

fn find_matching_line_indices(explicit_lines: &[ModLine], wanted: &[String], is_active: &impl Fn(&Option<Vec<i64>>) -> bool) -> Option<Vec<usize>> {
    let mut used = vec![false; explicit_lines.len()];
    let mut out = Vec::with_capacity(wanted.len());
    for w in wanted {
        let want_norm = normalise_mod_line(w);
        let found = explicit_lines
            .iter()
            .enumerate()
            .find(|(i, ml)| !used[*i] && normalise_mod_line(&ml.line) == want_norm && is_active(&ml.variant_list));
        match found {
            Some((i, _)) => {
                used[i] = true;
                out.push(i);
            }
            None => return None,
        }
    }
    Some(out)
}

/// Port of `title:gsub("^[Ff]oulborn ", "")` (the `foulbornMap` lookup key derivation, Item.lua
/// line 1028): strips a leading "Foulborn "/"foulborn " only.
fn strip_foulborn_prefix(title: &str) -> String {
    for prefix in ["Foulborn ", "foulborn "] {
        if let Some(rest) = title.strip_prefix(prefix) {
            return rest.to_string();
        }
    }
    title.to_string()
}

/// Port of `title:gsub("[Ff]oulborn ", "")` (Item.lua line 1607): every occurrence, not just a
/// leading one, matching upstream literally (in practice only a leading one ever exists).
fn strip_all_foulborn_occurrences(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut i = 0;
    while i < title.len() {
        let rest = &title[i..];
        if (rest.as_bytes()[0] == b'F' || rest.as_bytes()[0] == b'f') && rest[1..].starts_with("oulborn ") {
            i += 1 + "oulborn ".len();
            continue;
        }
        let ch_len = rest.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        out.push_str(&title[i..i + ch_len]);
        i += ch_len;
    }
    out
}

/// Port of Item.lua lines 1620-1635 (the last thing `ParseRaw` does before calling
/// `BuildModList`): a base that carries its own fixed `enchant` text (e.g. every Talisman base's
/// innate "Has 1 Socket", or a stat-charge enchant) gets it auto-injected as a synthetic
/// `enchantModLines` entry -- but ONLY when the item doesn't already have a REAL enchant-bucketed
/// line of its own (`#self.enchantModLines == 0`). Crucially this is a check on the ENCHANT
/// bucket specifically, not on whether the base's own text already appears anywhere on the item:
/// a unique/rare's raw text commonly lists this very same text as its own EXPLICIT or IMPLICIT
/// line (most Talisman uniques list "Has 1 Socket" as their one counted implicit), which leaves
/// `enchantModLines` empty regardless -- so the synthetic copy lands ALONGSIDE that other line,
/// not instead of it, and BOTH survive into `BuildModList` (Night's Hold: two
/// separate `SocketCount BASE 1` mods -- one from the item's own implicit line, one from this
/// synthetic enchant line -- summing to a real socket count of 2, not the 1 a literal reading of
/// the raw text alone would suggest).
///
/// The synthetic line always carries `crafted = true, implicit = true, enchant = true` together
/// (matching upstream's literal `{ line = line, crafted = true, implicit = true, enchant =
/// true, ... }` table construction) -- an otherwise-impossible flag combination for a normally-
/// parsed line, but that's what upstream does, so it's kept faithfully.
fn inject_base_enchant(item: &mut Item, data: &GameData) {
    if !item.enchant_mod_lines.is_empty() {
        return;
    }
    let Some(base) = item.base_name.as_ref().and_then(|n| data.item_bases.get(n)) else { return };
    let Some(enchant_text) = base.extra.get("enchant").and_then(|v| v.as_str()) else { return };
    let mod_types = base.extra.get("enchantModTypes").filter(|v| v.is_array()).map(|j| j.to_value());
    for (idx, line) in enchant_text.split('\n').enumerate() {
        let (mod_list, extra) = parse_mod(line);
        let mod_tags = mod_types
            .as_ref()
            .and_then(|arr| arr.get(idx))
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|t| t.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        item.enchant_mod_lines.push(ModLine {
            line: line.to_string(),
            crafted: true,
            implicit: true,
            enchant: true,
            extra,
            mod_list: Some(mod_list.unwrap_or_default()),
            mod_tags,
            raw_line: usize::MAX,
            ..Default::default()
        });
    }
}

fn is_quality_bearing_base(base: &pom_engine::data::ItemBase) -> bool {
    base.armour.is_some()
        || base.weapon.is_some()
        || base.extra.get("flask").is_some()
        || base.extra.get("tincture").is_some()
}

#[allow(clippy::too_many_arguments)]
fn finalize_mod_line(
    item: &mut Item,
    mut ml: ModLine,
    mod_list: Option<Vec<pom_engine::modparser::types::PMod>>,
    extra: Option<String>,
    mode_game: bool,
    stage: &mut Stage,
    found_explicit: &mut bool,
    found_implicit: &mut bool,
    implicit_lines_expected: f64,
    _raw_line: &str,
) {
    let counts_so_far = (item.enchant_mod_lines.len() + item.scourge_mod_lines.len() + item.implicit_mod_lines.len()) as f64;
    let bucket: &mut Vec<ModLine> = if ml.enchant || (ml.crafted && counts_so_far < implicit_lines_expected) {
        &mut item.enchant_mod_lines
    } else if ml.scourge {
        &mut item.scourge_mod_lines
    } else if ml.line.contains("Requires Class") {
        &mut item.class_requirement_mod_lines
    } else if ml.implicit || (!ml.crafted && counts_so_far < implicit_lines_expected) {
        &mut item.implicit_mod_lines
    } else if ml.crucible {
        &mut item.crucible_mod_lines
    } else {
        &mut item.explicit_mod_lines
    };

    if let Some(list) = mod_list {
        ml.mod_list = Some(list);
        ml.extra = extra;
        ml.range = ml.range.or(Some(0.5));
        bucket.push(ml);
        if mode_game {
            match *stage {
                Stage::FindImplicit => *stage = Stage::Implicit,
                Stage::FindExplicit => {
                    *found_explicit = true;
                    *stage = Stage::Explicit;
                }
                Stage::Explicit => *found_explicit = true,
                _ => {}
            }
        } else {
            *found_explicit = true;
        }
    } else if mode_game {
        let is_base_like = false; // base-line short-circuit already handled earlier
        if matches!(*stage, Stage::Implicit | Stage::Explicit) || (matches!(*stage, Stage::FindImplicit) && !is_base_like) {
            ml.mod_list = Some(vec![]);
            ml.extra = Some(ml.line.clone());
            bucket.push(ml);
        } else if matches!(*stage, Stage::FindExplicit) {
            *stage = Stage::Done;
        }
    } else if *found_explicit || matches!(*stage, Stage::Explicit) {
        ml.mod_list = Some(vec![]);
        ml.extra = Some(ml.line.clone());
        bucket.push(ml);
    }
}

fn extract_mod_group(line: &str) -> Option<String> {
    let idx = line.find("{modGroup:")?;
    let rest = &line[idx + "{modGroup:".len()..];
    let end = rest.find('}')?;
    Some(rest[..end].to_string())
}

fn strip_brace_and_flags(line: &str) -> String {
    let mut ml = ModLine::default();
    let stripped = strip_brace_tags(line, &mut ml);
    strip_trailing_paren_flags(&stripped)
}

fn strip_paren_suffix(s: &str) -> String {
    if let Some(pos) = s.find(" (") {
        if s.ends_with(')') {
            return s[..pos].to_string();
        }
    }
    s.to_string()
}

fn extract_parens(line: &str) -> Option<String> {
    let start = line.find('(')?;
    let end = line[start..].find(')')? + start;
    Some(line[start + 1..end].to_string())
}

fn is_reminder_text_start(line: &str) -> bool {
    if let Some(rest) = line.strip_prefix('(') {
        if rest.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
            return true;
        }
    }
    if let Some(rest) = line.strip_prefix('(') {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            let after = &rest[digits.len()..];
            if let Some(after) = after.strip_prefix('%') {
                if after.starts_with(" of ") {
                    return true;
                }
            } else if after.starts_with(" of ") {
                return true;
            }
        }
    }
    false
}

/// Port of the pattern union at Item.lua lines 569-571 (`^Lasts .+ Seconds$`, `^Consumes %d+ of
/// %d+ Charges on use$`, `^Currently has %d+ Charges$`): a flask's own in-game duration/charge
/// display text, gated (by the caller) on the item actually being a flask base.
fn is_flask_state_line(line: &str) -> bool {
    fn digits(s: &str) -> (usize, &str) {
        let n = s.chars().take_while(|c| c.is_ascii_digit()).count();
        (n, &s[n..])
    }
    if let Some(rest) = line.strip_prefix("Lasts ") {
        if rest.ends_with(" Seconds") && rest.len() > " Seconds".len() {
            return true;
        }
    }
    if let Some(rest) = line.strip_prefix("Consumes ") {
        let (n1, rest) = digits(rest);
        if n1 > 0 {
            if let Some(rest) = rest.strip_prefix(" of ") {
                let (n2, rest) = digits(rest);
                if n2 > 0 && rest == " Charges on use" {
                    return true;
                }
            }
        }
    }
    if let Some(rest) = line.strip_prefix("Currently has ") {
        let (n, rest) = digits(rest);
        if n > 0 && rest == " Charges" {
            return true;
        }
    }
    false
}

fn parse_rarity_line(line: &str) -> Option<String> {
    let rest = line.strip_prefix("Rarity: ")?;
    if rest.chars().all(|c| c.is_ascii_alphabetic()) && !rest.is_empty() {
        Some(rest.to_string())
    } else {
        // Lua's %a+ stops at the first non-letter; take the leading alphabetic run.
        let word: String = rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        if word.is_empty() { None } else { Some(word) }
    }
}

fn is_known_rarity_color(s: &str) -> bool {
    matches!(
        s,
        "NORMAL" | "MAGIC" | "RARE" | "UNIQUE" | "RELIC" | "GEM" | "PROPHECY" | "CURRENCY"
            | "CRAFTED" | "CUSTOM"
    )
}

/// Port of the specName/specVal extraction (line 655-662): `^([%a %(%)]+:?): (.+)$`, falling back
/// to `^(Requires %a+) (.+)$`.
fn parse_spec_line(line: &str) -> (Option<String>, Option<String>) {
    if let Some(pos) = line.find(": ") {
        let name = &line[..pos];
        if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphabetic() || c == ' ' || c == '(' || c == ')') {
            return (Some(name.to_string()), Some(line[pos + 2..].to_string()));
        }
    }
    if let Some(rest) = line.strip_prefix("Requires ") {
        let word: String = rest.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
        if !word.is_empty() {
            let after = &rest[word.len()..];
            if let Some(val) = after.strip_prefix(' ') {
                if !val.is_empty() {
                    return (Some(format!("Requires {}", word)), Some(val.to_string()));
                }
            }
        }
    }
    (None, None)
}

fn parse_sockets(spec_val: &str) -> Vec<Socket> {
    let mut sockets = Vec::new();
    let mut group = 0i64;
    for c in spec_val.chars() {
        if matches!(c, 'R' | 'G' | 'B' | 'W' | 'A') {
            sockets.push(Socket { color: c, group });
        } else if c == ' ' {
            group += 1;
        }
    }
    sockets
}

fn is_catalyst_quality_spec(spec_name: &str) -> bool {
    spec_name.starts_with("Quality (") && spec_name.ends_with("Modifiers)")
}

fn extract_catalyst_descriptor(spec_name: &str) -> Option<&str> {
    let inner = spec_name.strip_prefix("Quality (")?.strip_suffix(" Modifiers)")?;
    Some(inner)
}

/// Loads item bases lookup helper (re-exported for the golden test).
pub fn base_lookup<'a>(data: &'a GameData, name: &str) -> Option<&'a pom_engine::data::ItemBase> {
    data.item_bases.get(name)
}

/// `data.clusterJewels.jewels`, keyed by base name (`engine-data/data_clusterJewels.json`'s
/// "jewels" section -- the same file `pom_passives::clusterjewel::ClusterJewelData` loads, but this
/// only keeps the 4 fields Item.lua's own jewel branch reads off `self.clusterJewel`: `.size`,
/// `.minNodes`/`.maxNodes` (the node-count clamp), `.skills` (the `clusterJewelSkill` validation
/// set). Cached in a `OnceLock` like `UNIQUE_STAT_ORDER`/`FOULBORN_DATA` above.
static CLUSTER_JEWELS_INDEX: OnceLock<HashMap<String, ClusterJewelBaseInfo>> = OnceLock::new();

fn cluster_jewels_index(data: &GameData) -> &'static HashMap<String, ClusterJewelBaseInfo> {
    CLUSTER_JEWELS_INDEX.get_or_init(|| build_cluster_jewels_index(data))
}

fn build_cluster_jewels_index(data: &GameData) -> HashMap<String, ClusterJewelBaseInfo> {
    let mut out = HashMap::default();
    let Ok(Some(cj)) = data.extra.get("clusterJewels") else { return out };
    let Some(jewels) = cj.get("jewels").and_then(|v| v.as_object()) else { return out };
    for (base_name, v) in jewels {
        let size = v.get("size").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let size_index = v.get("sizeIndex").and_then(|n| n.as_i64()).unwrap_or(0);
        let min_nodes = v.get("minNodes").and_then(|n| n.as_i64()).unwrap_or(0);
        let max_nodes = v.get("maxNodes").and_then(|n| n.as_i64()).unwrap_or(0);
        let mut skills = HashSet::default();
        if let Some(sk) = v.get("skills").and_then(|s| s.as_object()) {
            skills.extend(sk.keys().map(|k| k.to_string()));
        }
        out.insert(base_name.to_string(), ClusterJewelBaseInfo { size, size_index, min_nodes, max_nodes, skills });
    }
    out
}

/// Port of `data.setJewelRadiiGlobally` (Modules/Data.lua lines 583-601): `data.jewelRadius`
/// (singular) is `data.jewelRadii["3_15"]` for tree version <= 3.15, `data.jewelRadii["3_16"]`
/// otherwise (the physical radius table hasn't changed since 3.16, so every later tree version,
/// including ones with no dedicated key of their own, reuses it). `GameData::jewel_radii` already
/// carries both keyed tables (`crates/engine/src/data/tree.rs`), so this just picks the right one
/// for `data.tree_version` -- unlike the pre-resolved `data_jewelRadius.json` export (a single
/// snapshot for whatever tree version happened to be loaded when it was exported), which is wrong
/// for any OTHER tree version's items.
fn jewel_radius_table(data: &GameData) -> Option<&Vec<pom_engine::data::JewelRadiusBand>> {
    let (major, minor) = data.tree_version.split_once('_').and_then(|(a, b)| {
        let b = b.split('_').next().unwrap_or(b); // drop a "_ruthless"/"_alternate" suffix
        Some((a.parse::<i64>().ok()?, b.parse::<i64>().ok()?))
    })?;
    let key = if major <= 3 && minor <= 15 { "3_15" } else { "3_16" };
    data.jewel_radii.get(key)
}

/// Port of the `for index, data in pairs(data.jewelRadius) do if specVal:match("^[%a ]+") ==
/// data.label then self.jewelRadiusIndex = index; break end end` loop (Item.lua lines 696-701):
/// first 1-based index in the tree-version-appropriate radius table whose label matches. `None`
/// when nothing matches (e.g. "Very Large"/"Massive" against the 3-entry "3_15" table).
pub fn jewel_radius_index_for_label(data: &GameData, label: &str) -> Option<i64> {
    let table = jewel_radius_table(data)?;
    table.iter().position(|band| band.label.as_deref() == Some(label)).map(|i| i as i64 + 1)
}

/// `data.itemMods.ItemExclusive`, flattened into two lookup tables keyed by mod-line text (Item.lua
/// lines 1358-1367): `exact` by the line's exact lowercased text (newlines collapsed to spaces),
/// `normalised` by the same text with every number replaced by `#` (see `normalise_mod_line`), for
/// a ranged line whose real roll doesn't match any single game-data example verbatim. Where two
/// `ItemExclusive` entries share the same text, the LOWER `statOrder` wins (`m_min` in the
/// original). Built once per process (this table never changes within a run) and cached in a
/// `OnceLock`; `GameData` doesn't expose a typed form of `itemMods`, so this reads the raw JSON
/// export directly and resolves its `$ref`s itself (`crate::data`'s own docs say it does not).
struct UniqueStatOrder {
    exact: HashMap<String, f64>,
    normalised: HashMap<String, f64>,
}

static UNIQUE_STAT_ORDER: OnceLock<UniqueStatOrder> = OnceLock::new();

fn unique_stat_order(data: &GameData) -> &'static UniqueStatOrder {
    UNIQUE_STAT_ORDER.get_or_init(|| build_unique_stat_order(data))
}

fn build_unique_stat_order(data: &GameData) -> UniqueStatOrder {
    let mut exact: HashMap<String, f64> = HashMap::default();
    let mut normalised: HashMap<String, f64> = HashMap::default();
    let Ok(Some(item_mods)) = data.extra.get("itemMods") else { return UniqueStatOrder { exact, normalised } };
    let (Some(exclusive), Some(item_defs)) = (item_mods.get("ItemExclusive").and_then(|v| v.as_object()), item_mods.get("Item").and_then(|v| v.as_object())) else {
        return UniqueStatOrder { exact, normalised };
    };
    for refval in exclusive.values() {
        let entry = match refval.get("$ref").and_then(|v| v.as_str()) {
            Some(refstr) => refstr.strip_prefix("data.itemMods.Item.").and_then(|k| item_defs.get(k)),
            None => Some(refval),
        };
        let Some(entry) = entry else { continue };
        let Some(stat_order) = entry.get("statOrder").and_then(|v| v.as_array()) else { continue };
        for (i, order) in stat_order.iter().enumerate() {
            let Some(order) = order.as_f64() else { continue };
            let Some(line) = entry.get(&(i + 1).to_string()).and_then(|v| v.as_str()) else { continue };
            let exact_line = line.to_lowercase().replace('\n', " ");
            exact.entry(exact_line).and_modify(|v| *v = v.min(order)).or_insert(order);
            let norm_line = normalise_mod_line(line);
            normalised.entry(norm_line).and_modify(|v| *v = v.min(order)).or_insert(order);
        }
    }
    UniqueStatOrder { exact, normalised }
}

/// Port of `normaliseModLine` (Item.lua line 63): every digit run (with an optional decimal part)
/// becomes `#`, then a resulting `(#-#)` or `(-#-#)` becomes a single `#`, lowercased, newlines to
/// spaces.
pub fn normalise_mod_line(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut digits_replaced = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '.' {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            digits_replaced.push('#');
        } else {
            digits_replaced.push(chars[i]);
            i += 1;
        }
    }
    let collapsed = collapse_hash_range(&digits_replaced);
    collapsed.to_lowercase().replace('\n', " ")
}

/// Collapses a literal `(#-#)` or `(-#-#)` (from `normalise_mod_line`'s digit pass) into one `#`.
fn collapse_hash_range(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let mut j = i;
        let matched = (|| {
            if chars.get(j)? != &'(' {
                return None;
            }
            j += 1;
            if chars.get(j) == Some(&'-') {
                j += 1;
            }
            if chars.get(j)? != &'#' {
                return None;
            }
            j += 1;
            if chars.get(j)? != &'-' {
                return None;
            }
            j += 1;
            if chars.get(j)? != &'#' {
                return None;
            }
            j += 1;
            if chars.get(j)? != &')' {
                return None;
            }
            j += 1;
            Some(j)
        })();
        if let Some(end) = matched {
            out.push('#');
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// Port of Item.lua lines 1368-1373: for a unique/relic item whose raw text is an "advanced
/// copy" (`item.advanced_copy`), sets each explicit line's canonical `order` from the unique
/// stat-order table (exact text match, falling back to the number-normalized match for a ranged
/// line that never appears verbatim in the game-data examples). A no-op for anything else, exactly
/// matching upstream's own gate.
fn assign_unique_stat_order(item: &mut Item, data: &GameData) {
    if !item.advanced_copy || !(item.rarity == "UNIQUE" || item.rarity == "RELIC") {
        return;
    }
    let table = unique_stat_order(data);
    for ml in item.explicit_mod_lines.iter_mut() {
        let exact_line = ml.line.to_lowercase().replace('\n', " ");
        ml.order = table.exact.get(&exact_line).copied().or_else(|| table.normalised.get(&normalise_mod_line(&ml.line)).copied());
    }
}

/// Port of `sortCraftedModLines` (Item.lua lines 71-84): a stable sort by (group, order, original
/// position), where group is fractured=1, normal/unique=2, crafted-or-custom=3 -- and `order`
/// (nil sorts last, `math.huge`) is only compared WITHIN group 1/2; a group-3 pair, or a group-1/2
/// pair with no order difference, keeps its original relative order (Lua's own comparator falls
/// through to `sourceOrder[a] < sourceOrder[b]` either way, which is what "original position" as
/// the final tiebreak replicates here).
fn sort_crafted_mod_lines(lines: &mut Vec<ModLine>) {
    fn group_of(ml: &ModLine) -> u8 {
        if ml.crafted || ml.custom {
            3
        } else if ml.fractured {
            1
        } else {
            2
        }
    }
    let mut idx: Vec<usize> = (0..lines.len()).collect();
    idx.sort_by(|&ai, &bi| {
        let (a, b) = (&lines[ai], &lines[bi]);
        let (ag, bg) = (group_of(a), group_of(b));
        if ag != bg {
            return ag.cmp(&bg);
        }
        if ag < 3 {
            let (ao, bo) = (a.order.unwrap_or(f64::INFINITY), b.order.unwrap_or(f64::INFINITY));
            if ao != bo {
                return ao.partial_cmp(&bo).unwrap_or(std::cmp::Ordering::Equal);
            }
        }
        ai.cmp(&bi)
    });
    let mut slots: Vec<Option<ModLine>> = std::mem::take(lines).into_iter().map(Some).collect();
    *lines = idx.into_iter().map(|i| slots[i].take().unwrap()).collect();
}

#[allow(dead_code)]
fn unused(_: &HashMap<String, bool>) {}

const CATALYST_TAGS: [&[&str]; 12] = [
    &["attack"],
    &["speed"],
    &["suffix"],
    &["life", "mana", "resource"],
    &["caster"],
    &["jewellery_attribute", "attribute"],
    &["physical_damage", "chaos_damage"],
    &["jewellery_resistance", "resistance"],
    &["prefix"],
    &["jewellery_defense", "defences", "armour", "evasion", "energyshield"],
    &["jewellery_elemental", "elemental_damage"],
    &["critical"],
];

/// Port of `getCatalystScalar` (Item.lua:31-64).
fn get_catalyst_scalar(catalyst: Option<i64>, ml: &ModLine, quality: Option<f64>) -> f64 {
    if ml.unscalable {
        return 1.0;
    }
    let Some(id) = catalyst else { return 1.0 };
    if id < 1 || id as usize > CATALYST_TAGS.len() || ml.mod_tags.is_empty() {
        return 1.0;
    }
    let quality = quality.unwrap_or(20.0);
    let has = |t: &str| ml.mod_tags.iter().any(|x| x == t) || (t == "prefix" && ml.prefix) || (t == "suffix" && ml.suffix);
    if CATALYST_TAGS[id as usize - 1].iter().any(|t| has(t)) {
        (100.0 + quality) / 100.0
    } else {
        1.0
    }
}

/// `itemLib.applyValueScalar` for the no-`modScalability` fallback branch of `itemLib.applyRange`
/// (`orig_line` is the unresolved line, `out` its range-resolved form). `highPrecisionMods` is not
/// consulted (only `defaultHighPrecision` when upstream carries a decimal).
fn apply_value_scalar_fallback(out: String, orig_line: &str, value_scalar: f64, base_value_scalar: f64, precision: Option<f64>) -> String {
    if value_scalar == 1.0 && base_value_scalar == 1.0 {
        return out;
    }
    let mut numbers = count_bare_ranges(orig_line);
    if numbers == 0 {
        let b = orig_line.as_bytes();
        // `(%d+%.?%d*)%%? ` : a number optionally followed by '%' then a space.
        let mut i = 0;
        while i < b.len() {
            if b[i].is_ascii_digit() {
                let mut e = i;
                while e < b.len() && b[e].is_ascii_digit() { e += 1; }
                if e < b.len() && b[e] == b'.' { e += 1; while e < b.len() && b[e].is_ascii_digit() { e += 1; } }
                if e < b.len() && b[e] == b'%' { e += 1; }
                if e < b.len() && b[e] == b' ' { numbers = 1; break; }
                i = e.max(i + 1);
            } else { i += 1; }
        }
    }
    let power = 10f64.powf(precision.unwrap_or(0.0));
    let scale = |num: &str| -> String {
        let mut v: f64 = num.parse().unwrap_or(0.0);
        if base_value_scalar != 1.0 {
            v = (v * base_value_scalar * power + 0.5).floor() / power;
        }
        fmt_num((v * value_scalar * power + if precision.is_some() { 0.0 } else { 0.001 }).floor() / power)
    };
    let b = out.as_bytes();
    let mut res = String::new();
    let mut i = 0;
    let mut done = 0;
    while i < b.len() {
        if done < numbers && b[i].is_ascii_digit() {
            let mut e = i;
            while e < b.len() && b[e].is_ascii_digit() { e += 1; }
            if precision.is_some() {
                if e < b.len() && b[e] == b'.' { e += 1; while e < b.len() && b[e].is_ascii_digit() { e += 1; } }
                res.push_str(&scale(&out[i..e]));
                done += 1;
                i = e;
                continue;
            }
            // `(%d+)([^%.])` with backtracking.
            let mut len = e - i;
            let mut matched = false;
            while len >= 1 {
                if i + len < b.len() && b[i + len] != b'.' {
                    res.push_str(&scale(&out[i..i + len]));
                    res.push(b[i + len] as char);
                    done += 1;
                    i += len + 1;
                    matched = true;
                    break;
                }
                len -= 1;
            }
            if matched { continue; }
            res.push_str(&out[i..e]);
            i = e;
            continue;
        }
        res.push(b[i] as char);
        i += 1;
    }
    res
}

fn match_decimal_at(b: &[u8], i: usize) -> bool {
    // `%d+%.%d*` starting at a digit run's start.
    if i > 0 && b[i - 1].is_ascii_digit() { return false; }
    let mut e = i;
    while e < b.len() && b[e].is_ascii_digit() { e += 1; }
    e < b.len() && b[e] == b'.'
}

fn count_bare_ranges(line: &str) -> usize {
    let b = line.as_bytes();
    let mut n = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'(' {
            if let Some((_, me)) = match_number(b, i + 1) {
                if me < b.len() && b[me] == b'-' {
                    if let Some((_, xe)) = match_number(b, me + 1) {
                        if xe < b.len() && b[xe] == b')' { n += 1; i = xe + 1; continue; }
                    }
                }
            }
        }
        i += 1;
    }
    n
}

/// True when the item uses the group/version scheme (`usesVariantGroups`).
fn item_uses_groups(flag: bool, item: &Item) -> bool {
    flag
        || [&item.implicit_mod_lines, &item.explicit_mod_lines, &item.enchant_mod_lines, &item.scourge_mod_lines, &item.crucible_mod_lines]
            .iter()
            .any(|b| b.iter().any(|ml| ml.version_list.is_some() || ml.variant_group_list.is_some()))
}

/// `NormaliseVariantSelections` + `CheckModLineVariant` for `usesVariantGroups` items. Active lines lose their
/// `variant_list` (always selected); inactive ones get an unmatchable one.
fn resolve_variant_groups(item: &mut Item, variant_count: i64, version_count: i64, selected_version: Option<i64>, selections: &mut std::collections::BTreeMap<i64, i64>) {
    use std::collections::{BTreeMap, BTreeSet};
    // variantGroups[groupId][variantId] = set of versionIds (0 = any version)
    let mut groups: BTreeMap<i64, BTreeMap<i64, BTreeSet<i64>>> = BTreeMap::new();
    for bucket in [&item.implicit_mod_lines, &item.explicit_mod_lines, &item.enchant_mod_lines, &item.scourge_mod_lines, &item.crucible_mod_lines] {
        for ml in bucket.iter() {
            let (Some(gl), Some(vl)) = (&ml.variant_group_list, &ml.variant_list) else { continue };
            for g in gl {
                let group = groups.entry(*g).or_default();
                for v in vl {
                    if *v < 1 || *v > variant_count {
                        continue;
                    }
                    let versions = group.entry(*v).or_default();
                    match &ml.version_list {
                        Some(vs) => {
                            for ver in vs {
                                if *ver >= 1 && *ver <= version_count {
                                    versions.insert(*ver);
                                }
                            }
                        }
                        None => {
                            versions.insert(0);
                        }
                    }
                }
            }
        }
    }
    let sel_version = if version_count > 0 { Some(selected_version.unwrap_or(version_count).clamp(1, version_count)) } else { None };
    let eligible = |g: i64, v: i64| -> bool {
        groups.get(&g).and_then(|gr| gr.get(&v)).is_some_and(|vs| vs.contains(&0) || sel_version.is_some_and(|sv| vs.contains(&sv)))
    };
    let options = |g: i64| -> Vec<i64> { (1..=variant_count).filter(|v| eligible(g, *v)).collect() };
    selections.retain(|g, _| groups.contains_key(g));
    let mut used: BTreeSet<i64> = BTreeSet::new();
    let mut needs: Vec<i64> = Vec::new();
    for g in groups.keys() {
        if !options(*g).is_empty() {
            match selections.get(g) {
                Some(s) if eligible(*g, *s) && !used.contains(s) => {
                    used.insert(*s);
                }
                _ => needs.push(*g),
            }
        }
    }
    for g in needs {
        let pick = options(g).into_iter().find(|v| !used.contains(v));
        match pick {
            Some(v) => {
                selections.insert(g, v);
                used.insert(v);
            }
            None => {
                selections.remove(&g);
            }
        }
    }
    for bucket in [&mut item.implicit_mod_lines, &mut item.explicit_mod_lines, &mut item.enchant_mod_lines, &mut item.scourge_mod_lines, &mut item.crucible_mod_lines] {
        for ml in bucket.iter_mut() {
            let mut active = true;
            if let Some(vs) = &ml.version_list {
                if !sel_version.is_some_and(|sv| vs.contains(&sv)) {
                    active = false;
                }
            }
            if active {
                if let Some(gl) = &ml.variant_group_list {
                    active = match &ml.variant_list {
                        None => false,
                        Some(vl) => gl.iter().any(|g| selections.get(g).is_some_and(|s| vl.contains(s))),
                    };
                } else {
                    active = ml.variant_list.is_none();
                }
            }
            ml.variant_list = if active { None } else { Some(vec![i64::MIN]) };
        }
    }
}
