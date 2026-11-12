// preFlagList: mechanical entries from gen_preflag.rs plus the 7 function-valued entries
// (ModParser.lua lines 1253-1273) hand-ported since they run cond:gsub("^%a", string.upper).
use super::gen_preflag::build_pre_flag_list_data;
use super::support::Entry;
use super::types::tag;
use crate::value::Value;

pub enum PreFlagVal {
    Data(Entry),
    Func(fn(&str) -> Entry),
}

fn first_upper(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

pub fn build() -> Vec<(&'static str, PreFlagVal)> {
    let mut out: Vec<(&'static str, PreFlagVal)> =
        build_pre_flag_list_data().into_iter().map(|(k, v)| (k, PreFlagVal::Data(v))).collect();
    out.push((
        "^enemies (%a+) by you take ",
        PreFlagVal::Func(|cond| Entry {
            tag: Some(tag("Condition", vec![("var", Value::Str(first_upper(cond).into()))])),
            apply_to_enemy: true,
            mod_suffix: Some("Taken"),
            ..Default::default()
        }),
    ));
    out.push((
        "^enemies (%a+) by ",
        PreFlagVal::Func(|cond| Entry {
            tag: Some(tag("Condition", vec![("var", Value::Str(first_upper(cond).into()))])),
            apply_to_enemy: true,
            ..Default::default()
        }),
    ));
    out.push((
        "^enemies (%a+) by you have ",
        PreFlagVal::Func(|cond| Entry {
            tag: Some(tag("Condition", vec![("var", Value::Str(first_upper(cond).into()))])),
            apply_to_enemy: true,
            ..Default::default()
        }),
    ));
    out.push((
        "^while a pinnacle atlas boss is in your presence, enemies you've hit recently have ",
        PreFlagVal::Func(|_cond| Entry {
            player_tag_list: Some(vec![
                tag("Condition", vec![("var", Value::Str("HitRecently".into()))]),
                tag("ActorCondition", vec![("actor", Value::Str("enemy".into())), ("var", Value::Str("PinnacleBoss".into()))]),
            ]),
            apply_to_enemy: true,
            ..Default::default()
        }),
    ));
    out.push((
        "^while a unique enemy is in your presence, enemies you've hit recently have ",
        PreFlagVal::Func(|_cond| Entry {
            player_tag_list: Some(vec![
                tag("Condition", vec![("var", Value::Str("HitRecently".into()))]),
                tag("ActorCondition", vec![("actor", Value::Str("enemy".into())), ("var", Value::Str("RareOrUnique".into()))]),
            ]),
            apply_to_enemy: true,
            ..Default::default()
        }),
    ));
    out.push((
        "^enemies you've hit recently have ",
        PreFlagVal::Func(|_cond| Entry {
            player_tag: Some(tag("Condition", vec![("var", Value::Str("HitRecently".into()))])),
            apply_to_enemy: true,
            ..Default::default()
        }),
    ));
    out.push((
        "^hits against enemies (%a+) by you have ",
        PreFlagVal::Func(|cond| Entry {
            tag: Some(tag(
                "ActorCondition",
                vec![("actor", Value::Str("enemy".into())), ("var", Value::Str(first_upper(cond).into()))],
            )),
            ..Default::default()
        }),
    ));
    out
}
