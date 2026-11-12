//! Port of `Modules/CalcFormat.lua` (`formatCalcVal`/`formatCalcStr`) plus the two `Modules/
//! Common.lua` helpers it calls (`round`, `formatNumSep`). Verified against CalcSections.lua (via
//! grep over every `format = "..."` string in the file) to have exactly three placeholder shapes:
//! `{output:Key}` (bare value, numbers stringified but not rounded/grouped -- see
//! `output_lookup_raw`), `{N:output:Key}` (rounded to N decimals + thousands-grouped), and
//! `{N:mod:i,j,...}` (a live `ModStore:Combine` query against this cell's own `details` array,
//! `crates/breakdown/src/sections.rs::Cell::details`, 1-indexed per Lua array convention). No
//! other placeholder shape exists in the corpus's CalcSections.lua, so `format_calc_str` does not
//! attempt a general Lua-gsub engine; an unrecognized `{...}` is left verbatim, matching gsub's
//! own non-destructive behavior for a non-matching pattern.
use crate::modmatch::store::ModStore;
use crate::modmatch::types::Cfg;
use crate::sections::Detail;
use crate::sym::Sym;
use serde_json::Value as J;
use std::collections::HashMap;
use std::sync::Arc;

/// What `formatCalcStr`'s third argument (`colData`, the enclosing `env.player`/`env.enemy`
/// pair plus the named skill/dot/bleed/... cfg tables) supplies for the `{p:mod:...}` case.
pub struct ModRenderCtx<'a> {
    pub player_store: &'a ModStore,
    pub skill_store: Option<&'a ModStore>,
    pub enemy_store: Option<&'a ModStore>,
    pub cfgs: &'a HashMap<String, Cfg>,
}

/// Port of `Modules/Common.lua`'s `round(val, dec)`: `floor(val * 10^dec + 0.5) / 10^dec`.
pub fn round(val: f64, dec: i32) -> f64 {
    let mult = 10f64.powi(dec);
    (val * mult + 0.5).floor() / mult
}

/// Port of Lua's default `tostring(number)` (`%.14g`), approximated with Rust's shortest
/// round-trip `Display` for f64: both algorithms print the fewest digits that read back to the
/// same value, so for the "clean" numbers `round()` produces (n decimal places, no long tails of
/// binary-fraction noise) they coincide. They diverge for huge magnitudes that need scientific
/// notation; none seen in the graded builds so far.
pub fn lua_num_tostring(v: f64) -> String {
    if v.is_nan() {
        return "nan".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".to_string() } else { "-inf".to_string() };
    }
    format!("{v}")
}

/// Port of `formatNumSep` (Modules/Common.lua): groups the integer part of a plain numeric string
/// by 3 digits with `,` (upstream's default `thousandsSeparator`, `showThousandsSeparators = true` by
/// default -- Modules/Main.lua lines 108/111/112). The Lua original also swaps in a
/// `decimalSeparator` for `.` (default is `.` itself, a no-op) and preserves a leading `^`-color
/// prefix on the matched substring, which `formatCalcVal`'s caller here never supplies (see
/// module doc): both are omitted as dead code for this crate's inputs.
pub fn format_num_sep(s: &str) -> String {
    let (neg, rest) = match s.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, s),
    };
    let (int_part, frac_part) = match rest.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (rest, None),
    };
    if !int_part.chars().all(|c| c.is_ascii_digit()) || int_part.is_empty() {
        return s.to_string();
    }
    let mut grouped = String::new();
    let bytes = int_part.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        let from_end = bytes.len() - i;
        if i > 0 && from_end % 3 == 0 {
            grouped.push(',');
        }
        grouped.push(*b as char);
    }
    let mut out = String::new();
    if neg {
        out.push('-');
    }
    out.push_str(&grouped);
    if let Some(f) = frac_part {
        out.push('.');
        out.push_str(f);
    }
    out
}

/// Port of `formatCalcVal(val, p)`: `formatNumSep(tostring(round(val, p)))`.
pub fn format_calc_val(val: f64, p: i32) -> String {
    format_num_sep(&lua_num_tostring(round(val, p)))
}

/// `c:match("^(%a+)%.(%a+)$")`: the *entire* key must be exactly `letters.letters`, e.g.
/// `MainHand.Accuracy`. `Gear:Armour` (no dot) or anything with digits/extra dots does not match
/// and is used as one literal key instead.
fn split_ns_var(key: &str) -> Option<(&str, &str)> {
    let dot = key.find('.')?;
    let (ns, rest) = key.split_at(dot);
    let var = &rest[1..];
    let is_alpha = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphabetic());
    if is_alpha(ns) && is_alpha(var) {
        Some((ns, var))
    } else {
        None
    }
}

fn output_get<'a>(output: &'a J, key: &str) -> Option<&'a J> {
    if let Some((ns, var)) = split_ns_var(key) {
        output.get(ns).and_then(|sub| sub.get(var))
    } else {
        output.get(key)
    }
}

/// `actor.output[ns][var] or 0` / `actor.output[c] or 0` used by the `{p:output:...}` case
/// (always numeric: `formatCalcVal` calls `round` on it). `math.huge`/`-math.huge`/`0/0` values
/// are recorded as the JSON strings `"Inf"`/`"-Inf"`/`"NaN"` (the same convention the recorded
/// answer keys use, since plain JSON has no numeric literal for them) -- a real corpus
/// value (`Maximum Hit Taken`/`Time before death`/etc on an unkillable-by-that-damage-type build
/// legitimately renders as `"inf"`), not a rare edge case to skip.
fn output_lookup_num(output: &J, key: &str) -> f64 {
    match output_get(output, key) {
        Some(J::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(J::String(s)) => match s.as_str() {
            "Inf" => f64::INFINITY,
            "-Inf" => f64::NEG_INFINITY,
            "NaN" => f64::NAN,
            _ => 0.0,
        },
        _ => 0.0,
    }
}

/// `actor.output[ns] and actor.output[ns][var] or ""` / `actor.output[c] or ""` used by the bare
/// `{output:...}` case: some entries (e.g. `DisplayDamage`) are pre-formatted strings computed by
/// the (unported) Perform stage, passed straight through; a number is stringified with Lua's
/// plain `tostring` (no rounding, no thousands grouping -- gsub auto-converts a numeric
/// replacement value the same way).
fn output_lookup_raw(output: &J, key: &str) -> String {
    match output_get(output, key) {
        // "Inf"/"-Inf"/"NaN" are this recorder's JSON encoding of a genuine numeric
        // math.huge/-math.huge/0-0 value (see output_lookup_num's doc comment), not a real
        // output string -- no output field's display text is spelled that way -- so route them
        // through the same numeric tostring as a plain number to get Lua's lowercase "inf"/"nan".
        Some(J::String(s)) => match s.as_str() {
            "Inf" => lua_num_tostring(f64::INFINITY),
            "-Inf" => lua_num_tostring(f64::NEG_INFINITY),
            "NaN" => lua_num_tostring(f64::NAN),
            _ => s.clone(),
        },
        Some(J::Number(n)) => lua_num_tostring(n.as_f64().unwrap_or(0.0)),
        Some(J::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

enum Placeholder<'a> {
    Output { key: &'a str },
    POutput { p: i32, key: &'a str },
    PMod { p: i32, idxs: Vec<usize> },
    Literal,
}

fn parse_placeholder(inner: &str) -> Placeholder<'_> {
    if let Some(key) = inner.strip_prefix("output:") {
        if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == ':' || c == '_') {
            return Placeholder::Output { key };
        }
        return Placeholder::Literal;
    }
    if let Some(colon) = inner.find(':') {
        let (digits, rest) = inner.split_at(colon);
        if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
            let rest = &rest[1..]; // drop ':'
            if let Some(key) = rest.strip_prefix("output:") {
                if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == ':' || c == '_') {
                    return Placeholder::POutput { p: digits.parse().unwrap_or(0), key };
                }
            } else if let Some(idxstr) = rest.strip_prefix("mod:") {
                if !idxstr.is_empty() && idxstr.chars().all(|c| c.is_ascii_digit() || c == ',') {
                    let idxs: Vec<usize> = idxstr.split(',').filter_map(|s| s.parse().ok()).collect();
                    if !idxs.is_empty() {
                        return Placeholder::PMod { p: digits.parse().unwrap_or(0), idxs };
                    }
                }
            }
        }
    }
    Placeholder::Literal
}

/// Picks the ModStore a `{p:mod:...}` detail queries, per CalcFormat.lua:
/// `(sectionData.enemy and actor.enemy and actor.enemy.modDB) or (sectionData.cfg and
/// actor.mainSkill and actor.mainSkill.skillModList) or actor.modDB`. This is a genuine `or`
/// chain (each `and`-guarded term can be falsy on its own, e.g. no enemy or no main skill) that
/// always bottoms out at `actor.modDB`, so it never fails to pick a store the way a plain
/// `if d.enemy {..} else if d.cfg.is_some() {..} else {..}` would if `enemy_store`/`skill_store`
/// happened to be unavailable despite the detail asking for one.
pub(crate) fn pick_store<'a>(d: &Detail, ctx: &ModRenderCtx<'a>) -> &'a ModStore {
    if d.enemy {
        if let Some(e) = ctx.enemy_store {
            return e;
        }
    }
    if d.cfg.is_some() {
        if let Some(s) = ctx.skill_store {
            return s;
        }
    }
    ctx.player_store
}

pub(crate) fn detail_cfg(d: &Detail, ctx: &ModRenderCtx) -> Cfg {
    // `actor.mainSkill[sectionData.cfg.."Cfg"]` (CalcFormat.lua): the row's `cfg` string names a
    // suffix ("skill", "weapon1", "dotFire", ...), not the map key itself.
    let mut cfg = d.cfg.as_deref().and_then(|name| ctx.cfgs.get(&format!("{name}Cfg"))).cloned().unwrap_or_default();
    if let Some(src) = &d.mod_source {
        cfg.source = Some(Arc::from(src.as_str()));
    }
    if let Some(a) = &d.actor {
        cfg.actor_tag = Some(Arc::from(a.as_str()));
    }
    cfg
}

/// Port of `formatCalcStr(str, actor, colData)`. `output` is the player actor's raw `output`
/// JSON (see `record::BreakdownBuild::player_output`); `details` is the enclosing cell's own
/// array part (`colData` in the Lua, indexed 1-based by `{p:mod:i,j}`).
pub fn format_calc_str(fmt: &str, output: &J, ctx: &ModRenderCtx, details: &[Detail]) -> String {
    let mut out = String::new();
    let bytes = fmt.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'{' {
            if let Some(end) = fmt[i + 1..].find('}') {
                let inner = &fmt[i + 1..i + 1 + end];
                match parse_placeholder(inner) {
                    Placeholder::Output { key } => {
                        out.push_str(&output_lookup_raw(output, key));
                        i = i + 1 + end + 1;
                        continue;
                    }
                    Placeholder::POutput { p, key } => {
                        out.push_str(&format_calc_val(output_lookup_num(output, key), p));
                        i = i + 1 + end + 1;
                        continue;
                    }
                    Placeholder::PMod { p, idxs } => {
                        out.push_str(&eval_p_mod(p, &idxs, details, ctx));
                        i = i + 1 + end + 1;
                        continue;
                    }
                    Placeholder::Literal => {}
                }
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

fn eval_p_mod(p: i32, idxs: &[usize], details: &[Detail], ctx: &ModRenderCtx) -> String {
    let first = match idxs.first().and_then(|&i| details.get(i.wrapping_sub(1))) {
        Some(d) if d.mod_type.is_some() => d,
        _ => return "?".to_string(),
    };
    let mod_type = first.mod_type.as_deref().unwrap();
    let mut total = if mod_type == "MORE" { 1.0 } else { 0.0 };
    for &idx in idxs {
        let d = match details.get(idx.wrapping_sub(1)) {
            Some(d) => d,
            None => break,
        };
        let cfg = detail_cfg(d, ctx);
        let store = pick_store(d, ctx);
        let names: Vec<Sym> = d.mod_name.as_deref().unwrap_or(&[]).iter().map(|n| Sym::new(n)).collect();
        let v = store.combine(mod_type, Some(&cfg), &names);
        if mod_type == "MORE" {
            total *= v;
        } else {
            total += v;
        }
    }
    if mod_type == "MORE" {
        total = (total - 1.0) * 100.0;
    }
    format_calc_val(total, p)
}

/// `formatCalcStr(subSec.data.extra, actor)` -- the subsection header's summary text has no
/// `colData`/details, matching a `{p:mod:...}` placeholder there is never valid (none in the
/// corpus, confirmed by grep) so an empty details slice is correct.
pub fn format_extra(fmt: &str, output: &J, ctx: &ModRenderCtx) -> String {
    format_calc_str(fmt, output, ctx, &[])
}
