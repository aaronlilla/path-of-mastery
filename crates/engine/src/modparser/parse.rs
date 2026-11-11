// Port of ModParser.lua's local `parseMod(line, order)` (lines 6640-6992) and the exported
// `parseMod(line)` wrapper (lines 6999-7020). specialModList, jewelFuncList, clusterJewelSkills
// and the data.gems-derived part of skillNameList are all ported (see tables.rs, jewelfunc.rs).
use super::flags::keyword_flag as kf;
use super::gen_small::FlagVal;
use super::modtag::call as call_modtag;
use super::preflag::PreFlagVal;
use super::scan::{cap_str, scan};
use super::special::support::SpecialArgs;
use super::special::SpecialVal;
use super::support::Entry;
use super::tables::{self, Tables};
use super::jewelfunc;
use super::types::{mod_to_pval, tag, tag_to_pval, PMod, PVal};
use crate::luapat::tonumber;
use crate::modifier::Tag;
use crate::value::Value;

fn lower(s: &[u8]) -> Vec<u8> {
    s.to_ascii_lowercase()
}

fn has_nonspace(s: &[u8]) -> bool {
    s.iter().any(|&c| !matches!(c, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r'))
}

#[derive(Default, Clone)]
struct Misc {
    flags: u64,
    keyword_flags: u64,
    tag_list: Vec<Tag>,
    add_to_aura: bool,
    only_add_to_banners: bool,
    new_aura: bool,
    new_aura_only_allies: bool,
    add_to_minion: bool,
    player_tag: Option<Tag>,
    add_to_minion_tag: Option<Tag>,
    player_tag_list: Option<Vec<Tag>>,
    add_to_skill: Option<Tag>,
    apply_to_enemy: bool,
    actor_enemy: bool,
    mod_suffix: Option<String>,
}

/// Mirrors parseMod's `for _, data in pairs({ modName, preFlag, modFlag, modTag, modTag2,
/// skillTag, modExtraTags }) do ... end` combine loop, in that fixed order.
fn combine(entries: &[Option<&Entry>]) -> Misc {
    let mut m = Misc::default();
    for e in entries.iter().flatten() {
        m.flags |= e.flags;
        m.keyword_flags |= e.keyword_flags;
        if let Some(t) = &e.tag {
            m.tag_list.push(t.clone());
        } else if let Some(tl) = &e.tag_list {
            m.tag_list.extend(tl.iter().cloned());
        }
        if e.add_to_aura {
            m.add_to_aura = true;
        }
        if e.only_add_to_banners {
            m.only_add_to_banners = true;
        }
        if e.new_aura {
            m.new_aura = true;
        }
        if e.new_aura_only_allies {
            m.new_aura_only_allies = true;
        }
        if e.add_to_minion {
            m.add_to_minion = true;
        }
        if e.player_tag.is_some() {
            m.player_tag = e.player_tag.clone();
        }
        if e.add_to_minion_tag.is_some() {
            m.add_to_minion_tag = e.add_to_minion_tag.clone();
        }
        if e.player_tag_list.is_some() {
            m.player_tag_list = e.player_tag_list.clone();
        }
        if e.add_to_skill.is_some() {
            m.add_to_skill = e.add_to_skill.clone();
        }
        if e.apply_to_enemy {
            m.apply_to_enemy = true;
        }
        if e.actor_enemy {
            m.actor_enemy = true;
        }
        if e.mod_suffix.is_some() {
            m.mod_suffix = e.mod_suffix.map(|s| s.to_string());
        }
    }
    m
}

#[derive(Clone)]
enum MV {
    Bool(bool),
    Num(f64),
    List(Vec<f64>),
}
impl MV {
    fn first_num(&self) -> f64 {
        match self {
            MV::Num(x) => *x,
            MV::List(v) => *v.first().unwrap_or(&0.0),
            MV::Bool(_) => f64::NAN,
        }
    }
}

fn call_tag_scan(line: &[u8], list: &[(&'static str, super::modtag::ModTagVal)]) -> Option<(Entry, Vec<u8>)> {
    let r = scan(line, list, false)?;
    let cap_strings: [Option<String>; 5] = std::array::from_fn(|i| cap_str(&r.caps[i]));
    let caps_ref: [Option<&str>; 5] = std::array::from_fn(|i| cap_strings[i].as_deref());
    let entry = call_modtag(r.val, caps_ref);
    Some((entry, r.remaining))
}

/// One attempt at parsing `line` (order 1 or 2). Returns (modList, remainingLineIfNonBlank).
fn parse_mod_once(line0: &[u8], order: i32) -> (Option<Vec<PMod>>, Option<Vec<u8>>) {
    let t: &Tables = tables::get();

    // jewelFuncList (ModParser.lua:6640-6652): capture-bearing patterns tried first, then a
    // literal whole-line lookup, both ahead of clusterJewelSkills/unsupportedModList.
    let line_lower_whole = lower(line0);
    if let Some(jf) = jewelfunc::lookup(&line_lower_whole) {
        let value = PVal::Map(vec![
            ("func".to_string(), PVal::JewelFunc(jewelfunc::JewelFuncHandle(jf.func))),
            ("type".to_string(), PVal::Str(jf.kind.as_str().to_string())),
        ]);
        let m = PMod {
            name: "JewelFunc".to_string(),
            ty: "LIST".to_string(),
            value,
            flags: 0,
            keyword_flags: 0,
            source: None,
            tags: vec![],
            unreachable_tags: vec![],
        };
        return (Some(vec![m]), None);
    }

    // clusterJewelSkills and unsupportedModList are both direct (non-pattern) lowercase
    // whole-line lookups, checked in that order (lines 6653-6658).
    if let Ok(s) = std::str::from_utf8(&line_lower_whole) {
        if let Some(mods) = t.cluster_jewel_skills.get(s) {
            return (Some(mods.clone()), None);
        }
        if t.unsupported.contains(&s) {
            return (Some(vec![]), Some(line0.to_vec()));
        }
    }

    // specialModList: a full-line match short-circuits everything below, including a function
    // entry that returns nothing (Lua: `return specialMod(...)` forwards a nil straight through).
    if let Some(r) = scan(line0, &t.special_mod_list, false) {
        if r.remaining.is_empty() {
            return match r.val {
                SpecialVal::Mods(mods) => (Some(mods.clone()), None),
                SpecialVal::Func(f) => {
                    let cap_strings: [Option<String>; 5] = std::array::from_fn(|i| cap_str(&r.caps[i]));
                    let caps_ref: [Option<&str>; 5] = std::array::from_fn(|i| cap_strings[i].as_deref());
                    match f(&SpecialArgs { c: caps_ref }) {
                        Some(mods) => (Some(mods), None),
                        None => (None, None),
                    }
                }
                SpecialVal::SkillFunc(skill_name, f) => {
                    let cap_strings: [Option<String>; 5] = std::array::from_fn(|i| cap_str(&r.caps[i]));
                    let caps_ref: [Option<&str>; 5] = std::array::from_fn(|i| cap_strings[i].as_deref());
                    match f(skill_name, &SpecialArgs { c: caps_ref }) {
                        Some(mods) => (Some(mods), None),
                        None => (None, None),
                    }
                }
            };
        }
    }

    // Add-to-cluster-jewel special case (line 6670-6673).
    if let Some(rest) =
        std::str::from_utf8(line0).ok().and_then(|s| s.strip_prefix("Added Small Passive Skills also grant: "))
    {
        if !rest.is_empty() {
            let m = PMod {
                name: "AddToClusterJewelNode".to_string(),
                ty: "LIST".to_string(),
                value: PVal::Str(rest.to_string()),
                flags: 0,
                keyword_flags: 0,
                source: None,
                tags: vec![],
                unreachable_tags: vec![],
            };
            return (Some(vec![m]), None);
        }
    }

    let mut line: Vec<u8> = line0.to_vec();
    line.push(b' ');

    // preFlag (pattern mode; may be a function of cap1)
    let mut pre_flag: Option<Entry> = None;
    if let Some(r) = scan(&line, &t.pre_flag_list, false) {
        let entry = match r.val {
            PreFlagVal::Data(e) => e.clone(),
            PreFlagVal::Func(f) => f(cap_str(&r.caps[0]).as_deref().unwrap_or("")),
        };
        line = r.remaining;
        pre_flag = Some(entry);
    }

    // skill name at start of line (preSkillNameList) -- always empty in this port.
    let mut skill_tag: Option<Entry> = None;
    if let Some(r) = scan(&line, &t.pre_skill_name_list, false) {
        skill_tag = Some(r.val.clone());
        line = r.remaining;
    }

    // form
    let form_r = match scan(&line, &t.form_list, false) {
        Some(r) => r,
        None => return (None, Some(line)),
    };
    let mod_form: &str = form_r.val;
    let mut form_caps: [Option<String>; 5] = std::array::from_fn(|i| cap_str(&form_r.caps[i]));
    line = form_r.remaining;

    // modTag / modTag2
    let mut mod_tag: Option<Entry> = None;
    if let Some((entry, rem)) = call_tag_scan(&line, &t.mod_tag_list) {
        line = rem;
        mod_tag = Some(entry);
    }
    let mut mod_tag2: Option<Entry> = None;
    if mod_tag.is_some() {
        if let Some((entry, rem)) = call_tag_scan(&line, &t.mod_tag_list) {
            line = rem;
            mod_tag2 = Some(entry);
        }
    }

    // skill name (order == 2, before name scan)
    if order == 2 && skill_tag.is_none() {
        if let Some(r) = scan(&line, &t.skill_name_list, false) {
            skill_tag = Some(r.val.clone());
            line = r.remaining;
        }
    }

    // modName, per form. mod_name_entry carries modNameList's own flags/tags (only populated
    // when we actually scan modNameList: FLAG and the default branch; PEN/BASECOST/TOTALCOST
    // discard their modNameList scan result entirely, matching `local _, line = scan(...)`).
    let mut mod_name: Option<Vec<String>> = None;
    let mut mod_name_entry: Option<Entry> = None;
    let mut flag_obj: Option<FlagVal> = None;
    match mod_form {
        "PEN" => {
            if let Some(r) = scan(&line, &t.pen_types, true) {
                mod_name = Some(vec![(*r.val).to_string()]);
                line = r.remaining;
            } else {
                return (Some(vec![]), Some(line));
            }
            if let Some(r) = scan(&line, &t.name_list, true) {
                line = r.remaining;
            }
        }
        "BASECOST" => {
            if let Some(r) = scan(&line, &t.base_cost_types, true) {
                mod_name = Some(r.val.names());
                line = r.remaining;
            } else {
                return (Some(vec![]), Some(line));
            }
            if let Some(r) = scan(&line, &t.name_list, true) {
                line = r.remaining;
            }
        }
        "TOTALCOST" => {
            if let Some(r) = scan(&line, &t.cost_types, true) {
                mod_name = Some(r.val.names());
                line = r.remaining;
            } else {
                return (Some(vec![]), Some(line));
            }
            if let Some(r) = scan(&line, &t.name_list, true) {
                line = r.remaining;
            }
        }
        "FLAG" => {
            if let Some(r) = scan(&line, &t.flag_types, false) {
                let fv = r.val.clone();
                line = r.remaining;
                form_caps[0] = Some(match &fv {
                    FlagVal::Name(n) => n.to_string(),
                    FlagVal::Obj { name, .. } => name.to_string(),
                });
                flag_obj = Some(fv);
            } else {
                return (None, Some(line));
            }
            if let Some(r) = scan(&line, &t.name_list, true) {
                mod_name = Some(r.val.names.iter().map(|s| s.to_string()).collect());
                mod_name_entry = Some(r.val.clone());
                line = r.remaining;
            }
        }
        _ => {
            if let Some(r) = scan(&line, &t.name_list, true) {
                mod_name = Some(r.val.names.iter().map(|s| s.to_string()).collect());
                mod_name_entry = Some(r.val.clone());
                line = r.remaining;
            }
        }
    }
    if order == 1 && skill_tag.is_none() {
        if let Some(r) = scan(&line, &t.skill_name_list, false) {
            skill_tag = Some(r.val.clone());
            line = r.remaining;
        }
    }

    // modFlag (plain substring match)
    let mut mod_flag: Option<Entry> = None;
    if let Some(r) = scan(&line, &t.flag_list, true) {
        mod_flag = Some(r.val.clone());
        line = r.remaining;
    }

    // value/type resolution per form
    let mut mod_value = MV::Num(tonumber(form_caps[0].as_deref().unwrap_or("")).unwrap_or(f64::NAN));
    let mut mod_type: Vec<String> = vec!["BASE".to_string()];
    let mut mod_suffix: Option<String> = None;
    let mut mod_extra_tags: Option<Entry> = None;
    let mut doubled_extra: Option<Tag> = None;

    macro_rules! suffix_scan {
        () => {{
            if let Some(r) = scan(&line, &t.suffix_types, true) {
                mod_suffix = Some((*r.val).to_string());
                line = r.remaining;
            }
        }};
    }

    match mod_form {
        "INC" => mod_type = vec!["INC".to_string()],
        "RED" => {
            mod_value = MV::Num(-mod_value.first_num());
            mod_type = vec!["INC".to_string()];
        }
        "MORE" => mod_type = vec!["MORE".to_string()],
        "LESS" => {
            mod_value = MV::Num(-mod_value.first_num());
            mod_type = vec!["MORE".to_string()];
        }
        "BASE" => suffix_scan!(),
        "GAIN" => {
            mod_type = vec!["BASE".to_string()];
            suffix_scan!();
        }
        "LOSE" => {
            mod_value = MV::Num(-mod_value.first_num());
            mod_type = vec!["BASE".to_string()];
            suffix_scan!();
        }
        "GRANTS" => {
            mod_type = vec!["BASE".to_string()];
            mod_extra_tags =
                Some(Entry { tag: Some(tag("Condition", vec![("var", Value::Str("{Hand}Attack".into()))])), ..Default::default() });
            suffix_scan!();
        }
        "GRANTS_GLOBAL" => {
            mod_type = vec!["BASE".to_string()];
            suffix_scan!();
        }
        "REMOVES" => {
            mod_value = MV::Num(-mod_value.first_num());
            mod_type = vec!["BASE".to_string()];
            mod_extra_tags =
                Some(Entry { tag: Some(tag("Condition", vec![("var", Value::Str("{Hand}Attack".into()))])), ..Default::default() });
            suffix_scan!();
        }
        "CHANCE" => {}
        "REGENPERCENT" => {
            mod_name = form_caps[1].as_deref().and_then(|k| t.regen_types.iter().find(|(n, _)| n == k)).map(|(_, v)| v.names());
            mod_suffix = Some("Percent".to_string());
        }
        "REGENFLAT" => {
            mod_name = form_caps[1].as_deref().and_then(|k| t.regen_types.iter().find(|(n, _)| n == k)).map(|(_, v)| v.names());
        }
        "DEGENPERCENT" => {
            mod_name = form_caps[1].as_deref().and_then(|k| t.degen_types.iter().find(|(n, _)| n == k)).map(|(_, v)| v.names());
            mod_suffix = Some("Percent".to_string());
        }
        "DEGENFLAT" => {
            mod_name = form_caps[1].as_deref().and_then(|k| t.degen_types.iter().find(|(n, _)| n == k)).map(|(_, v)| v.names());
        }
        "DEGEN" => {
            let dmg = form_caps[1].as_deref().and_then(|k| t.dmg_types.iter().find(|(n, _)| *n == k)).map(|(_, v)| *v);
            match dmg {
                None => return (Some(vec![]), Some(line)),
                Some(d) => {
                    mod_name = Some(vec![format!("{}Degen", d)]);
                    mod_suffix = Some(String::new());
                }
            }
        }
        "DMG" | "DMGATTACKS" | "DMGSPELLS" | "DMGBOTH" => {
            let dmg = form_caps[2].as_deref().and_then(|k| t.dmg_types.iter().find(|(n, _)| *n == k)).map(|(_, v)| *v);
            match dmg {
                None => return (Some(vec![]), Some(line)),
                Some(d) => {
                    let a = tonumber(form_caps[0].as_deref().unwrap_or("")).unwrap_or(f64::NAN);
                    let b = tonumber(form_caps[1].as_deref().unwrap_or("")).unwrap_or(f64::NAN);
                    mod_value = MV::List(vec![a, b]);
                    mod_name = Some(vec![format!("{}Min", d), format!("{}Max", d)]);
                    if mod_form != "DMG" && mod_flag.is_none() {
                        let kwf = match mod_form {
                            "DMGATTACKS" => kf::Attack,
                            "DMGSPELLS" => kf::Spell,
                            "DMGBOTH" => kf::Attack | kf::Spell,
                            _ => 0,
                        };
                        mod_flag = Some(Entry { keyword_flags: kwf, ..Default::default() });
                    }
                }
            }
        }
        "FLAG" => match flag_obj {
            Some(FlagVal::Obj { name, value, ty }) => {
                mod_name = Some(vec![name.to_string()]);
                mod_type = vec![ty.to_string()];
                mod_value = MV::Num(value);
            }
            Some(FlagVal::Name(name)) => {
                mod_name = Some(vec![name.to_string()]);
                mod_type = vec!["FLAG".to_string()];
                mod_value = MV::Bool(true);
            }
            None => {
                // Shouldn't happen (the FLAG branch above already returned early if flagTypes
                // didn't match), but fall back to whatever modNameList found rather than panic.
                mod_type = vec!["FLAG".to_string()];
                mod_value = MV::Bool(true);
            }
        },
        "OVERRIDE" => mod_type = vec!["OVERRIDE".to_string()],
        "DOUBLED" => {
            if let Some(names) = &mod_name {
                if !names.is_empty() {
                    let mod_name_string = names[0].clone();
                    let mut new_names = names.clone();
                    new_names.push(format!("Multiplier:{}Doubled", mod_name_string));
                    mod_name = Some(new_names);
                    mod_type = vec!["MORE".to_string(), "OVERRIDE".to_string()];
                    mod_value = MV::List(vec![100.0, 1.0]);
                    doubled_extra = Some(tag(
                        "Multiplier",
                        vec![
                            ("var", Value::Str(format!("{}Doubled", mod_name_string).into())),
                            ("globalLimit", Value::Num(100.0)),
                            ("globalLimitKey", Value::Str(format!("{}DoubledLimit", mod_name_string).into())),
                        ],
                    ));
                }
            }
        }
        _ => {}
    }

    let mod_name = match mod_name {
        Some(n) if !n.is_empty() => n,
        _ => return (Some(vec![]), Some(line)),
    };

    // Combine flags/tags in Lua's fixed order: modName, preFlag, modFlag, modTag, modTag2,
    // skillTag, modExtraTags.
    let misc = combine(&[
        mod_name_entry.as_ref(),
        pre_flag.as_ref(),
        mod_flag.as_ref(),
        mod_tag.as_ref(),
        mod_tag2.as_ref(),
        skill_tag.as_ref(),
        mod_extra_tags.as_ref(),
    ]);
    let flags = misc.flags;
    let keyword_flags = misc.keyword_flags;
    let tag_list = misc.tag_list.clone();
    let mod_suffix_final = mod_suffix.or_else(|| misc.mod_suffix.clone());

    let n = mod_name.len();
    let mut mod_list: Vec<PMod> = Vec::with_capacity(n);
    for (i, name) in mod_name.iter().enumerate() {
        let ty = mod_type.get(i).cloned().unwrap_or_else(|| mod_type[0].clone());
        let value = match &mod_value {
            MV::Bool(b) => PVal::Bool(*b),
            MV::Num(x) => PVal::Num(*x),
            MV::List(v) => PVal::Num(*v.get(i).unwrap_or(&0.0)),
        };
        let mut tags: Vec<PVal> = tag_list.iter().map(tag_to_pval).collect();
        if i == 0 {
            if let Some(dt) = &doubled_extra {
                tags.push(tag_to_pval(dt));
            }
        }
        mod_list.push(PMod {
            name: format!("{}{}", name, mod_suffix_final.clone().unwrap_or_default()),
            ty,
            value,
            flags,
            keyword_flags,
            source: None,
            tags,
            unreachable_tags: vec![],
        });
    }

    // misc post-processing wrappers (addToAura / newAura / addToMinion / addToSkill /
    // applyToEnemy). Mutually exclusive, in this priority order (lines 6934-6989).
    if !mod_list.is_empty() {
        if misc.add_to_aura {
            for m in mod_list.iter_mut() {
                let inner = mod_to_pval(m);
                let fields = vec![("mod".to_string(), inner)];
                let mut tags = vec![];
                if misc.only_add_to_banners {
                    // SkillType.Banner = 88
                    tags.push(tag_to_pval(&tag("SkillType", vec![("skillType", Value::Num(88.0))])));
                }
                *m = PMod {
                    name: "ExtraAuraEffect".to_string(),
                    ty: "LIST".to_string(),
                    value: PVal::Map(fields),
                    flags: 0,
                    keyword_flags: 0,
                    source: None,
                    tags,
                    unreachable_tags: vec![],
                };
            }
        } else if misc.new_aura {
            for m in mod_list.iter_mut() {
                let tags_taken: Vec<PVal> = m.tags.drain(..).collect();
                let inner = mod_to_pval(m);
                // Lua: modList[i] = mod("ExtraAura", "LIST", { mod = effectMod, onlyAllies = misc.newAuraOnlyAllies }, ...)
                // Table-constructor nil-omission: onlyAllies is entirely absent from the exported
                // table (not `false`) when misc.newAuraOnlyAllies wasn't set true (ModParser.lua:6953).
                let mut fields = vec![("mod".to_string(), inner)];
                if misc.new_aura_only_allies {
                    fields.push(("onlyAllies".to_string(), PVal::Bool(true)));
                }
                *m = PMod {
                    name: "ExtraAura".to_string(),
                    ty: "LIST".to_string(),
                    value: PVal::Map(fields),
                    flags: 0,
                    keyword_flags: 0,
                    source: None,
                    tags: tags_taken,
                    unreachable_tags: vec![],
                };
            }
        } else if misc.add_to_minion {
            for m in mod_list.iter_mut() {
                let inner = mod_to_pval(m);
                let fields = vec![("mod".to_string(), inner)];
                let mut tags = vec![];
                if let Some(pt) = &misc.player_tag {
                    tags.push(tag_to_pval(pt));
                }
                if let Some(mt) = &misc.add_to_minion_tag {
                    tags.push(tag_to_pval(mt));
                }
                if let Some(ptl) = &misc.player_tag_list {
                    for pt in ptl {
                        tags.push(tag_to_pval(pt));
                    }
                }
                *m = PMod {
                    name: "MinionModifier".to_string(),
                    ty: "LIST".to_string(),
                    value: PVal::Map(fields),
                    flags: 0,
                    keyword_flags: 0,
                    source: None,
                    tags,
                    unreachable_tags: vec![],
                };
            }
        } else if let Some(add_to_skill) = &misc.add_to_skill {
            let ats = tag_to_pval(add_to_skill);
            for m in mod_list.iter_mut() {
                let inner = mod_to_pval(m);
                let fields = vec![("mod".to_string(), inner)];
                *m = PMod {
                    name: "ExtraSkillMod".to_string(),
                    ty: "LIST".to_string(),
                    value: PVal::Map(fields),
                    flags: 0,
                    keyword_flags: 0,
                    source: None,
                    tags: vec![ats.clone()],
                    unreachable_tags: vec![],
                };
            }
        } else if misc.apply_to_enemy {
            for m in mod_list.iter_mut() {
                if misc.actor_enemy {
                    if let Some(PVal::Map(fields)) = m.tags.first_mut() {
                        if let Some(pair) = fields.iter_mut().find(|(k, _)| k == "actor") {
                            pair.1 = PVal::Str("enemy".to_string());
                        } else {
                            fields.push(("actor".to_string(), PVal::Str("enemy".to_string())));
                        }
                    }
                }
                let inner = mod_to_pval(m);
                let fields = vec![("mod".to_string(), inner)];
                let mut tags = vec![];
                if let Some(pt) = &misc.player_tag {
                    tags.push(tag_to_pval(pt));
                }
                if let Some(ptl) = &misc.player_tag_list {
                    for pt in ptl {
                        tags.push(tag_to_pval(pt));
                    }
                }
                *m = PMod {
                    name: "EnemyModifier".to_string(),
                    ty: "LIST".to_string(),
                    value: PVal::Map(fields),
                    flags: 0,
                    keyword_flags: 0,
                    source: None,
                    tags,
                    unreachable_tags: vec![],
                };
            }
        }
    }

    let extra = if has_nonspace(&line) { Some(line) } else { None };
    (Some(mod_list), extra)
}

/// Public entry point matching the exported `parseMod(line)` (re-parses with order 2 if order 1
/// found mods but also left a non-blank remainder).
type ParseResult = (Option<Vec<PMod>>, Option<String>);

thread_local! {
    // parse_mod is a pure function of the line, so results are memoized. The original gets the same effect from
    // Data/ModCache.lua. Two generations of up to `MEMO_CAP` lines each: when the current one fills it becomes the
    // previous one (the old previous is dropped), and a hit in the previous one moves back. A long-lived process
    // keeps the lines of its recent builds without growing with every build it loads.
    static PARSE_CACHE: std::cell::RefCell<crate::fxhash::HashMap<String, ParseResult>> = Default::default();
    static PARSE_PREV: std::cell::RefCell<crate::fxhash::HashMap<String, ParseResult>> = Default::default();
}

const MEMO_CAP: usize = 15_000;

/// The saved parse cache, kept as its file bytes plus an index of where each line's result starts; an entry is
/// decoded the first time its line is parsed.
struct Saved {
    bytes: &'static [u8],
    index: crate::fxhash::HashMap<&'static str, u32>,
}
static SAVED: std::sync::OnceLock<Saved> = std::sync::OnceLock::new();

fn saved_result(line: &str) -> Option<ParseResult> {
    let saved = SAVED.get()?;
    let at = *saved.index.get(line)? as usize;
    Rd { b: saved.bytes, i: at }.result()
}

pub fn parse_mod(line: &str) -> ParseResult {
    if let Some(r) = crate::modparser::text_rules::wrap(line, parse_mod) { return r; } // fp-skip
    if let Some(hit) = PARSE_CACHE.with(|c| c.borrow().get(line).cloned()) {
        return hit;
    }
    let r = PARSE_PREV
        .with(|c| c.borrow_mut().remove(line))
        .or_else(|| saved_result(line))
        .unwrap_or_else(|| parse_mod_uncached(line));
    PARSE_CACHE.with(|c| {
        let mut c = c.borrow_mut();
        // Writing a cache file (POM_PARSE_CACHE_OUT) needs every line of the run.
        if c.len() >= MEMO_CAP && crate::env::var_os("POM_PARSE_CACHE_OUT").is_none() {
            let full = std::mem::take(&mut *c);
            PARSE_PREV.with(|p| *p.borrow_mut() = full);
        }
        c.insert(line.to_string(), r.clone());
    });
    r
}

fn parse_mod_uncached(line: &str) -> ParseResult {
    let (mods1, extra1) = parse_mod_once(line.as_bytes(), 1);
    let (mut mods, extra) = if mods1.is_some() && extra1.is_some() { parse_mod_once(line.as_bytes(), 2) } else { (mods1, extra1) };
    // The original serves these lines from `Data/ModCache.lua`, whose numbers were written with `%.14g`
    // (e.g. 2 / 3 is stored as 0.66666666666667); every other cached value is exact at that precision.
    if line.contains(" Flasks gain ") || line.starts_with("Flasks gain ") || line.starts_with("While on Low Life, Life Flasks gain ") {
        const CACHED: [&str; 11] = [
            "Flasks gain 2 Charges every 3 seconds",
            "Flasks gain 4 Charges every 3 seconds",
            "Flasks gain a Charge every 3 seconds",
            "Life Flasks gain 1 Charge every 3 seconds",
            "Life Flasks gain 2 Charge every 3 seconds",
            "Life Flasks gain 2 Charges every 3 seconds",
            "Mana Flasks gain 1 Charge every 3 seconds",
            "Mana Flasks gain 2 Charge every 3 seconds",
            "Mana Flasks gain 2 Charges every 3 seconds",
            "Utility Flasks gain 2 Charges every 3 seconds",
            "While on Low Life, Life Flasks gain 5 Charges every 3 seconds",
        ];
        if CACHED.contains(&line) {
            for m in mods.iter_mut().flatten() {
                if let PVal::Num(v) = m.value {
                    m.value = PVal::Num(format!("{:.13e}", v).parse::<f64>().unwrap_or(v));
                }
            }
        }
    }
    (mods, extra.map(|b| String::from_utf8_lossy(&b).into_owned()))
}

// ---- saved parse cache: the counterpart of the original's Data/ModCache.lua ----
// A binary file of `line -> parse_mod(line)` entries. Floats are stored as raw bits so a loaded entry is
// bit-identical to a live parse; lines whose result holds a JewelFunc (a callable) are never saved and
// always parse live.

fn put_u32(o: &mut Vec<u8>, v: u32) { o.extend_from_slice(&v.to_le_bytes()); }
fn put_str(o: &mut Vec<u8>, s: &str) { put_u32(o, s.len() as u32); o.extend_from_slice(s.as_bytes()); }

fn put_pval(o: &mut Vec<u8>, v: &PVal) -> bool {
    match v {
        PVal::Num(n) => { o.push(0); o.extend_from_slice(&n.to_bits().to_le_bytes()); }
        PVal::Bool(b) => { o.push(1); o.push(*b as u8); }
        PVal::Str(s) => { o.push(2); put_str(o, s); }
        PVal::List(l) => {
            o.push(3);
            put_u32(o, l.len() as u32);
            for x in l { if !put_pval(o, x) { return false; } }
        }
        PVal::Map(m) => {
            o.push(4);
            put_u32(o, m.len() as u32);
            for (k, x) in m { put_str(o, k); if !put_pval(o, x) { return false; } }
        }
        PVal::JewelFunc(_) => return false,
    }
    true
}

fn put_pmod(o: &mut Vec<u8>, m: &PMod) -> bool {
    put_str(o, &m.name);
    put_str(o, &m.ty);
    if !put_pval(o, &m.value) { return false; }
    o.extend_from_slice(&m.flags.to_le_bytes());
    o.extend_from_slice(&m.keyword_flags.to_le_bytes());
    match &m.source { Some(s) => { o.push(1); put_str(o, s); } None => o.push(0) }
    put_u32(o, m.tags.len() as u32);
    for t in &m.tags { if !put_pval(o, t) { return false; } }
    put_u32(o, m.unreachable_tags.len() as u32);
    for (i, t) in &m.unreachable_tags { put_u32(o, *i as u32); if !put_pval(o, t) { return false; } }
    true
}

fn put_result(o: &mut Vec<u8>, r: &ParseResult) -> bool {
    match &r.0 {
        Some(mods) => { o.push(1); put_u32(o, mods.len() as u32); for m in mods { if !put_pmod(o, m) { return false; } } }
        None => o.push(0),
    }
    match &r.1 { Some(s) => { o.push(1); put_str(o, s); } None => o.push(0) }
    true
}

struct Rd<'a> { b: &'a [u8], i: usize }
impl<'a> Rd<'a> {
    fn bytes(&mut self, n: usize) -> Option<&'a [u8]> { let s = self.b.get(self.i..self.i + n)?; self.i += n; Some(s) }
    fn u8(&mut self) -> Option<u8> { Some(self.bytes(1)?[0]) }
    fn u32(&mut self) -> Option<u32> { Some(u32::from_le_bytes(self.bytes(4)?.try_into().ok()?)) }
    fn u64(&mut self) -> Option<u64> { Some(u64::from_le_bytes(self.bytes(8)?.try_into().ok()?)) }
    fn string(&mut self) -> Option<String> { let n = self.u32()? as usize; String::from_utf8(self.bytes(n)?.to_vec()).ok() }
    fn skip_string(&mut self) -> Option<()> { let n = self.u32()? as usize; self.bytes(n).map(|_| ()) }
    fn skip_pval(&mut self) -> Option<()> {
        match self.u8()? {
            0 => { self.bytes(8)?; }
            1 => { self.bytes(1)?; }
            2 => self.skip_string()?,
            3 => { let n = self.u32()?; for _ in 0..n { self.skip_pval()?; } }
            4 => { let n = self.u32()?; for _ in 0..n { self.skip_string()?; self.skip_pval()?; } }
            _ => return None,
        }
        Some(())
    }
    /// Moves past one `result` without building it (the layout `pmod`/`result` read).
    fn skip_result(&mut self) -> Option<()> {
        if self.u8()? == 1 {
            let n = self.u32()?;
            for _ in 0..n {
                self.skip_string()?;
                self.skip_string()?;
                self.skip_pval()?;
                self.bytes(16)?;
                if self.u8()? == 1 { self.skip_string()?; }
                let t = self.u32()?;
                for _ in 0..t { self.skip_pval()?; }
                let u = self.u32()?;
                for _ in 0..u { self.bytes(4)?; self.skip_pval()?; }
            }
        }
        if self.u8()? == 1 { self.skip_string()?; }
        Some(())
    }
    fn pval(&mut self) -> Option<PVal> {
        Some(match self.u8()? {
            0 => PVal::Num(f64::from_bits(self.u64()?)),
            1 => PVal::Bool(self.u8()? != 0),
            2 => PVal::Str(self.string()?),
            3 => { let n = self.u32()?; let mut v = Vec::with_capacity(n as usize); for _ in 0..n { v.push(self.pval()?); } PVal::List(v) }
            4 => { let n = self.u32()?; let mut v = Vec::with_capacity(n as usize); for _ in 0..n { let k = self.string()?; v.push((k, self.pval()?)); } PVal::Map(v) }
            _ => return None,
        })
    }
    fn pmod(&mut self) -> Option<PMod> {
        let name = self.string()?;
        let ty = self.string()?;
        let value = self.pval()?;
        let flags = self.u64()?;
        let keyword_flags = self.u64()?;
        let source = if self.u8()? == 1 { Some(self.string()?) } else { None };
        let n = self.u32()?;
        let mut tags = Vec::with_capacity(n as usize);
        for _ in 0..n { tags.push(self.pval()?); }
        let n = self.u32()?;
        let mut unreachable_tags = Vec::with_capacity(n as usize);
        for _ in 0..n { let i = self.u32()? as usize; unreachable_tags.push((i, self.pval()?)); }
        Some(PMod { name, ty, value, flags, keyword_flags, source, tags, unreachable_tags })
    }
    fn result(&mut self) -> Option<ParseResult> {
        let mods = if self.u8()? == 1 { let n = self.u32()?; let mut v = Vec::with_capacity(n as usize); for _ in 0..n { v.push(self.pmod()?); } Some(v) } else { None };
        let extra = if self.u8()? == 1 { Some(self.string()?) } else { None };
        Some((mods, extra))
    }
}

const MEMO_MAGIC: &[u8; 8] = b"POMPMC01";

/// Writes every memoized parse of this thread to `path`. Returns the number of entries written.
pub fn save_parse_cache(path: &std::path::Path, fingerprint: u64) -> std::io::Result<usize> {
    let mut o = MEMO_MAGIC.to_vec();
    o.extend_from_slice(&fingerprint.to_le_bytes());
    let mut n = 0usize;
    PARSE_CACHE.with(|c| {
        let c = c.borrow();
        let mut all: std::collections::BTreeMap<&str, ParseResult> = c.iter().map(|(k, v)| (k.as_str(), v.clone())).collect();
        if let Some(saved) = SAVED.get() {
            for (&k, _) in saved.index.iter() {
                if !all.contains_key(k) {
                    if let Some(r) = saved_result(k) {
                        all.insert(k, r);
                    }
                }
            }
        }
        for (k, r) in &all {
            let mut e = Vec::new();
            put_str(&mut e, k);
            if put_result(&mut e, r) { o.extend_from_slice(&e); n += 1; }
        }
    });
    std::fs::write(path, o)?;
    Ok(n)
}

/// Seeds this thread's parse memo from a file written by `save_parse_cache`. With `verify`, every entry is
/// re-parsed live and compared; mismatching entries are dropped and counted. Returns (loaded, mismatched).
pub fn load_parse_cache(path: &std::path::Path, fingerprint: u64, verify: bool) -> Result<(usize, usize), String> {
    let b = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if b.get(..8) != Some(&MEMO_MAGIC[..]) { return Err(format!("{}: not a parse cache", path.display())); }
    let saved = b.get(8..16).map(|x| u64::from_le_bytes(x.try_into().unwrap())).unwrap_or(0);
    if saved != fingerprint {
        return Err(format!("{} was written by a different parser or game data ({saved:016x}, this build is {fingerprint:016x}); regenerate the parse cache", path.display()));
    }
    // Indexed, not decoded: the file stays in memory as is and each entry is decoded on first use.
    let bytes: &'static [u8] = Box::leak(b.into_boxed_slice());
    let mut index = crate::fxhash::map_with_capacity(bytes.len() / 150);
    let mut r = Rd { b: bytes, i: 16 };
    let (mut loaded, mut bad) = (0usize, 0usize);
    while r.i < bytes.len() {
        let len = r.u32().ok_or("truncated parse cache")? as usize;
        let start = r.i;
        let line = bytes.get(start..start + len).and_then(|l| std::str::from_utf8(l).ok()).ok_or("truncated parse cache")?;
        r.i = start + len;
        let at = r.i as u32;
        if verify {
            let res = r.result().ok_or("truncated parse cache")?;
            if parse_mod_uncached(line) != res {
                bad += 1;
                continue;
            }
        } else {
            r.skip_result().ok_or("truncated parse cache")?;
        }
        index.insert(line, at);
        loaded += 1;
    }
    let _ = SAVED.set(Saved { bytes, index });
    Ok((loaded, bad))
}

/// Identifies what a saved parse depends on: this crate's source (hashed by build.rs) and the game data files
/// the parser reads. A cache written under a different fingerprint is refused.
pub fn parse_cache_fingerprint(data_dir: &std::path::Path) -> u64 {
    let mut h = u64::from_str_radix(env!("POM_ENGINE_SRC_FP"), 16).unwrap_or(0);
    // Eight bytes a step: this runs at every startup over about 20 MB.
    for f in ["data_skills.json", "data_gems.json", "data_clusterJewels.json", "data_gemForBaseName.json", "data_keystones.json"] {
        let bytes = std::fs::read(data_dir.join(f)).unwrap_or_default();
        for b in f.bytes() {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
        let mut chunks = bytes.chunks_exact(8);
        for c in &mut chunks {
            h = (h.rotate_left(5) ^ u64::from_le_bytes(c.try_into().unwrap())).wrapping_mul(0x517c_c1b7_2722_0a95);
        }
        for &b in chunks.remainder() {
            h = (h ^ b as u64).wrapping_mul(0x100000001b3);
        }
    }
    h
}
