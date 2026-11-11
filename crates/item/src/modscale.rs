//! Port of the `data.modScalability`-driven branch of `itemLib.applyRange` (Modules/ItemTools.lua
//! lines ~121-296): once a bare `(min-max)` range is resolved to a concrete number at a given
//! roll fraction, some mods need their DISPLAYED number remapped to the INTERNAL magnitude
//! `parse_mod`'s tables expect (e.g. a duration shown in seconds but matched per millisecond, or
//! a value the game displays already divided by 100). `data_modScalability.json` (loaded lazily
//! from `GameData::extra`, see `table()`) maps a line with its numbers replaced by `#` to the
//! `format` name(s) that describe this remapping for each numbered position.
//!
//! Scope cut: upstream's `findScalableLine` tries every combination of "these N numbers are
//! fixed literals, the rest are scalable" (most-substituted-first) so a mod with two numbers where
//! only one is the scalable one still matches a narrower key. This port only tries the two ends
//! that cover the overwhelming majority of real mod lines: "every number is scalable" (the whole
//! line stripped to `#`s) and, failing that, upstream's own un-remapped value. A line with 2+
//! numbers whose key only exists with exactly one of them literal is a residual, disclosed gap
//! (falls through to the plain roll-fraction value with no display remapping).
use pom_engine::data::GameData;
use serde_json::Value as J;
use std::sync::OnceLock;

static TABLE: OnceLock<J> = OnceLock::new();

fn table(data: &GameData) -> &'static J {
    TABLE.get_or_init(|| data.extra.get("modScalability").ok().flatten().map(|j| j.to_value()).unwrap_or(J::Null))
}

#[derive(Clone, Copy)]
pub struct Format {
    pub precision: f64,
    pub display_precision: Option<i32>,
    /// Port of `itemLib.formatValue`'s `ifRequired` (see `format_value`): when set, trailing zeros
    /// are NOT padded on -- the displayed value is rounded to `display_precision` decimals but then
    /// printed with Lua's plain `tostring` (no fixed-width padding), same as this crate's own
    /// `parse.rs::fmt_num` convention.
    pub if_required: bool,
    /// `scalability.isScalable`: only scalable positions take the catalyst/magnitude `valueScalar`.
    pub is_scalable: bool,
}

/// Port of the `format ==` chain (lines ~192-270). Later recognized names in the same `formats`
/// list win, matching upstream's un-broken for-loop that keeps overwriting.
fn format_for(name: &str) -> Option<Format> {
    let (precision, display_precision, if_required) = match name {
        "divide_by_two_0dp" => (2.0, Some(0), true),
        "divide_by_three" => (3.0, None, false),
        "divide_by_four" => (4.0, None, false),
        "divide_by_five" => (5.0, None, false),
        "divide_by_six" => (6.0, None, false),
        "divide_by_ten_0dp" => (10.0, Some(0), false),
        "divide_by_ten_1dp" => (10.0, Some(1), false),
        "divide_by_ten_1dp_if_required" => (10.0, Some(1), true),
        "divide_by_twelve" => (12.0, None, false),
        "divide_by_fifteen_0dp" => (15.0, Some(0), false),
        "divide_by_twenty" => (20.0, None, false),
        "divide_by_twenty_then_double_0dp" => (10.0, Some(0), false),
        "divide_by_one_hundred" | "divide_by_one_hundred_and_negate" => (100.0, None, false),
        "divide_by_one_hundred_0dp" => (100.0, Some(0), false),
        "divide_by_one_hundred_1dp" => (100.0, Some(1), false),
        "divide_by_one_hundred_2dp" => (100.0, Some(2), false),
        "divide_by_one_hundred_2dp_if_required" => (100.0, Some(2), true),
        "divide_by_one_thousand" => (1000.0, None, false),
        "divide_by_ten_thousand_1dp" => (10000.0, Some(1), false),
        "per_minute_to_per_second" => (60.0, None, false),
        "per_minute_to_per_second_0dp" => (60.0, Some(0), false),
        "per_minute_to_per_second_1dp" => (60.0, Some(1), false),
        "per_minute_to_per_second_2dp" => (60.0, Some(2), false),
        "per_minute_to_per_second_2dp_if_required" => (60.0, Some(2), true),
        "milliseconds_to_seconds" => (1000.0, None, false),
        "milliseconds_to_seconds_halved" => (1000.0, None, false),
        "milliseconds_to_seconds_0dp" => (1000.0, Some(0), false),
        "milliseconds_to_seconds_1dp" => (1000.0, Some(1), false),
        "milliseconds_to_seconds_2dp" => (1000.0, Some(2), false),
        "milliseconds_to_seconds_2dp_if_required" => (1000.0, Some(2), true),
        "locations_to_metres" => (10.0, Some(1), false),
        "deciseconds_to_seconds" => (10.0, None, false),
        _ => return None,
    };
    Some(Format { precision, display_precision, if_required, is_scalable: false })
}

/// Folds one scalability entry (`formats` list plus `isScalable`) down to one `Format`; with no
/// recognized format name it is the identity remap (`precision or 1`).
fn fold_formats(scalability: &J) -> Format {
    let mut result = Format { precision: 1.0, display_precision: None, if_required: false, is_scalable: false };
    if let Some(arr) = scalability.get("formats").and_then(|f| f.as_array()) {
        for f in arr {
            if let Some(fmt) = f.as_str().and_then(format_for) {
                result = fmt;
            }
        }
    }
    result.is_scalable = scalability.get("isScalable").and_then(|v| v.as_bool()).unwrap_or(false);
    result
}

/// Looks up `data.modScalability[key]` (key: the line with every number already replaced by `#`,
/// and `"+#"` collapsed to `"#"`) and returns one `Format` per numbered position, in order. `None`
/// at a position means "no recognized format there" (precision defaults to 1, i.e. no remapping).
pub fn lookup(data: &GameData, key: &str) -> Option<Vec<Option<Format>>> {
    let collapsed = key.replace("+#", "#");
    let entry = table(data).get(&collapsed)?.as_array()?;
    Some(entry.iter().map(|scalability| Some(fold_formats(scalability))).collect())
}

/// Lua's plain `tostring(number)` for a value already rounded to the right number of decimals: no
/// fixed-width padding, matching `parse.rs::fmt_num`'s convention (used for the exact same reason
/// elsewhere in this crate -- see that function's callers).
fn fmt_plain(v: f64) -> String {
    if v == v.trunc() {
        format!("{}", v as i64)
    } else {
        format!("{}", v)
    }
}

/// Port of `itemLib.formatValue` with `baseValueScalar = valueScalar = 1` (always true in this
/// port: no catalyst/corruption scaling), which both of upstream's branches reduce to.
///
/// `ifRequired` (Item.lua's `itemLib.formatValue`): `if displayPrecision and not ifRequired then
/// return string.format("%."..displayPrecision.."f", value) elseif displayPrecision then return
/// tostring(value, displayPrecision) else ... end` -- Lua's builtin `tostring` takes exactly one
/// argument and silently ignores any extra ones, so `tostring(value, displayPrecision)` is plain
/// `tostring(value)`: the value is still rounded to `displayPrecision` decimals (the unconditional
/// `roundSymmetric` a few lines above both branches), but printed WITHOUT the fixed-width padding a
/// `"%.Nf"` format specifier adds -- e.g. `0.1` stays `"0.1"`, never `"0.10"`. Missing this (this
/// port's first version always padded, `if_required` marked dead code) was a real, found-and-fixed
/// bug: confirmed on `data_modScalability.json`'s "Regenerate #% of Life per Second" entry
/// (`divide_by_one_hundred_2dp`, `ifRequired = true`), which rendered a cluster jewel's "Regenerate
/// 0.1% of Life per Second" added-mod text as "Regenerate 0.10% of Life per Second" -- numerically
/// identical once `modLib.parseMod` reparses either string, but not byte-for-byte faithful, which is
/// this crate's own bar.
pub fn format_value(raw: f64, fmt: Option<Format>, value_scalar: f64, base_value_scalar: f64) -> String {
    let precision = fmt.map(|f| f.precision).unwrap_or(1.0);
    let display_precision = fmt.and_then(|f| f.display_precision);
    let if_required = fmt.map(|f| f.if_required).unwrap_or(false);
    let mut internal = (raw * precision).round();
    // `if valueScalar and valueScalar ~= 1 then value = floorSymmetric(value * valueScalar) end`,
    // reached only for `isScalable` positions.
    // `if baseValueScalar ~= 1 then value = alwaysPositiveRound(value * baseValueScalar) end`
    // (corrupted-range multiplier) comes first.
    if fmt.map(|f| f.is_scalable).unwrap_or(false) && base_value_scalar != 1.0 {
        internal = (internal * base_value_scalar + 0.5).trunc();
    }
    if fmt.map(|f| f.is_scalable).unwrap_or(false) && value_scalar != 1.0 {
        internal = (internal * value_scalar).trunc();
    }
    let mut display = internal / precision;
    if let Some(dp) = display_precision {
        let p = 10f64.powi(dp);
        display = (display * p).round() / p;
        if if_required {
            fmt_plain(display)
        } else {
            format!("{:.*}", dp.max(0) as usize, display)
        }
    } else {
        let dp = if precision > 0.0 { (precision.log10() + 0.001).floor().min(2.0).max(0.0) as usize } else { 2 };
        let p = 10f64.powi(dp as i32);
        display = (display * p).round() / p;
        // `tostring(roundSymmetric(value, ...))`: a plain Lua number, so a whole value has no decimals.
        fmt_plain(display)
    }
}
