// Hand-ported modTagList function entries that involve string concatenation, gsub or ternary
// logic the mechanical codegen (gen_modtag_funcs_simple.rs) can't safely translate, plus the
// TagArgs helper both files share.
pub use super::gen_modtag_funcs_simple::TagFn;
use super::gen_modtag_funcs_simple::build_simple;
use super::support::Entry;
use super::types::tag;
use crate::luapat::tonumber;
use crate::value::Value;
use std::sync::Arc;

/// Raw regex captures (cap1..cap5) from the modTagList pattern match. `.n(k)` parses capture k
/// (1-based) as a number (Lua's `tonumber`); `.s(k)` returns it as text.
pub struct TagArgs<'a> {
    pub c: [Option<&'a str>; 5],
}
impl<'a> TagArgs<'a> {
    pub fn n(&self, k: usize) -> f64 {
        self.c[k - 1].and_then(tonumber).unwrap_or(f64::NAN)
    }
    pub fn s(&self, k: usize) -> &'a str {
        self.c[k - 1].unwrap_or("")
    }
}

pub fn first_upper(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn drop_last_char(s: &str) -> String {
    let mut chars = s.chars();
    chars.next_back();
    chars.as_str().to_string()
}

pub fn build_complex() -> Vec<(&'static str, TagFn)> {
    vec![
        ("per (%d+) rampage kills", (|a: &TagArgs| Entry {
            tag: Some(tag("Multiplier", vec![
                ("var", Value::Str("Rampage".into())),
                ("div", Value::Num(a.n(1))),
                ("limit", Value::Num(1000.0 / a.n(1))),
                ("limitTotal", Value::Bool(true)),
            ])),
            ..Default::default()
        }) as TagFn),
        ("if both equipped ([%a%s]+) have a?n? ?([%a%s]+) modifiers?", (|a: &TagArgs| Entry {
            tag: Some(tag("ItemCondition", vec![
                ("searchCond", Value::Str(a.s(2).into())),
                ("itemSlot", Value::Str(drop_last_char(a.s(1)).into())),
                ("bothSlots", Value::Bool(true)),
            ])),
            ..Default::default()
        }) as TagFn),
        ("if both equipped left and right ([%a%s]+) have a?n? ?([%a%s]+) modifiers?", (|a: &TagArgs| Entry {
            tag: Some(tag("ItemCondition", vec![
                ("searchCond", Value::Str(a.s(2).into())),
                ("itemSlot", Value::Str(drop_last_char(a.s(1)).into())),
                ("bothSlots", Value::Bool(true)),
            ])),
            ..Default::default()
        }) as TagFn),
        ("per (%d+)%% (%a+) effect on enemy", (|a: &TagArgs| Entry {
            tag: Some(tag("Multiplier", vec![
                ("var", Value::Str(format!("{}Effect", first_upper(a.s(2))).into())),
                ("div", Value::Num(a.n(1))),
                ("actor", Value::Str("enemy".into())),
            ])),
            ..Default::default()
        }) as TagFn),
        ("if (%d+) (%a+) items are equipped", (|a: &TagArgs| Entry {
            tag: Some(tag("MultiplierThreshold", vec![
                ("var", Value::Str(format!("{}Item", first_upper(a.s(2))).into())),
                ("threshold", Value::Num(a.n(1))),
            ])),
            ..Default::default()
        }) as TagFn),
        ("per (.+) eye jewel affecting you, up to a maximum of %+?(%d+)%%", (|a: &TagArgs| Entry {
            tag: Some(tag("Multiplier", vec![
                ("var", Value::Str(format!("{}EyeJewel", first_upper(a.s(1))).into())),
                ("limit", Value::Num(a.n(2))),
                ("limitTotal", Value::Bool(true)),
            ])),
            ..Default::default()
        }) as TagFn),
        ("if you have a (%a+) (%a+) in (%a+) slot", (|a: &TagArgs| {
            let slot_num = if a.s(3) == "right" { "2" } else if a.s(3) == "left" { "1" } else { "false" };
            Entry {
                tag: Some(tag("Condition", vec![
                    ("var", Value::Str(format!("{}ItemIn{} {}", first_upper(a.s(1)), first_upper(a.s(2)), slot_num).into())),
                ])),
                ..Default::default()
            }
        }) as TagFn),
        ("while holding a (%w+)", (|a: &TagArgs| Entry {
            tag: Some(tag("Condition", vec![
                ("varList", Value::List(Arc::new(vec![Value::Str(format!("Using{}", first_upper(a.s(1))).into())]))),
            ])),
            ..Default::default()
        }) as TagFn),
        ("while holding a (%w+) or (%w+)", (|a: &TagArgs| Entry {
            tag: Some(tag("Condition", vec![
                ("varList", Value::List(Arc::new(vec![
                    Value::Str(format!("Using{}", first_upper(a.s(1))).into()),
                    Value::Str(format!("Using{}", first_upper(a.s(2))).into()),
                ]))),
            ])),
            ..Default::default()
        }) as TagFn),
        ("with at least one (%w+) grafted to you", (|a: &TagArgs| Entry {
            tag: Some(tag("Condition", vec![("var", Value::Str(format!("Using{}", first_upper(a.s(1))).into()))])),
            ..Default::default()
        }) as TagFn),
        ("against enemies with (%w+) exposure", (|a: &TagArgs| Entry {
            tag: Some(tag("ActorCondition", vec![
                ("actor", Value::Str("enemy".into())),
                ("var", Value::Str(format!("Has{}Exposure", first_upper(a.s(1))).into())),
            ])),
            ..Default::default()
        }) as TagFn),
    ]
}

pub fn build_all() -> Vec<(&'static str, TagFn)> {
    let mut v = build_simple();
    v.extend(build_complex());
    v
}
