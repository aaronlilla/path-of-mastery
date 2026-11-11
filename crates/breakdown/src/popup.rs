//! The modifier table of a Calcs breakdown popup: a port of `CalcBreakdownControl:AddModSection` and its format helpers
//! (`Classes/CalcBreakdownControl.lua`). A cell's details that name a stat (`modName`) are answered by tabulating the
//! actor's mod store the way upstream does; the rows come back as plain JSON the popup draws.
use crate::format::{format_calc_val, lua_num_tostring, round, ModRenderCtx};
use crate::modifier::{Mod, ModType, Tag};
use crate::sections::Detail;
use crate::sym::Sym;
use crate::value::Value;
use serde_json::{json, Value as J};

/// `ModFlag` (Data/Global.lua): names in the table's own order are not needed, the popup sorts the names.
const MOD_FLAGS: &[(&str, u64)] = &[
    ("Attack", 0x1),
    ("Spell", 0x2),
    ("Hit", 0x4),
    ("Dot", 0x8),
    ("Cast", 0x10),
    ("Melee", 0x100),
    ("Area", 0x200),
    ("Projectile", 0x400),
    ("SourceMask", 0x600),
    ("Ailment", 0x800),
    ("MeleeHit", 0x1000),
    ("Weapon", 0x2000),
    ("Axe", 0x10000),
    ("Bow", 0x20000),
    ("Claw", 0x40000),
    ("Dagger", 0x80000),
    ("Mace", 0x100000),
    ("Staff", 0x200000),
    ("Sword", 0x400000),
    ("Wand", 0x800000),
    ("Unarmed", 0x1000000),
    ("Fishing", 0x2000000),
    ("WeaponMelee", 0x4000000),
    ("WeaponRanged", 0x8000000),
    ("Weapon1H", 0x10000000),
    ("Weapon2H", 0x20000000),
    ("WeaponMask", 0x2FFF0000),
];

/// `KeywordFlag` (Data/Global.lua).
const KEYWORD_FLAGS: &[(&str, u64)] = &[
    ("Aura", 0x1),
    ("Curse", 0x2),
    ("Warcry", 0x4),
    ("Movement", 0x8),
    ("Physical", 0x10),
    ("Fire", 0x20),
    ("Cold", 0x40),
    ("Lightning", 0x80),
    ("Chaos", 0x100),
    ("Vaal", 0x200),
    ("Bow", 0x400),
    ("Arrow", 0x800),
    ("Trap", 0x1000),
    ("Mine", 0x2000),
    ("Totem", 0x4000),
    ("Minion", 0x8000),
    ("Attack", 0x10000),
    ("Spell", 0x20000),
    ("Hit", 0x40000),
    ("Ailment", 0x80000),
    ("Brand", 0x100000),
    ("Poison", 0x200000),
    ("Bleed", 0x400000),
    ("Ignite", 0x800000),
    ("PhysicalDot", 0x1000000),
    ("LightningDot", 0x2000000),
    ("ColdDot", 0x4000000),
    ("FireDot", 0x8000000),
    ("ChaosDot", 0x10000000),
    ("MatchAll", 0x40000000),
];

/// `SkillType` (Data/Global.lua), by value.
const SKILL_TYPES: &[&str] = &[
    "", "Attack", "Spell", "Projectile", "DualWieldOnly", "Buff", "Minion", "Damage", "Area", "Duration", "RequiresShield", "ProjectileSpeed", "HasReservation",
    "ReservationBecomesCost", "Trappable", "Totemable", "Mineable", "ElementalStatus", "MinionsCanExplode", "Chains", "Melee", "MeleeSingleTarget",
    "Multicastable", "TotemCastsAlone", "Multistrikeable", "CausesBurning", "SummonsTotem", "TotemCastsWhenNotDetached", "Physical", "Fire", "Cold",
    "Lightning", "Triggerable", "Trapped", "Movement", "DamageOverTime", "RemoteMined", "Triggered", "Vaal", "Aura", "CanTargetUnusableCorpse", "RangedAttack",
    "Chaos", "FixedSpeedProjectile", "ThresholdJewelArea", "ThresholdJewelProjectile", "ThresholdJewelDuration", "ThresholdJewelRangedAttack", "Channel",
    "DegenOnlySpellDamage", "InbuiltTrigger", "Golem", "Herald", "AuraAffectsEnemies", "NoRuthless", "ThresholdJewelSpellDamage", "Cascadable",
    "ProjectilesFromUser", "MirageArcherCanUse", "ProjectileSpiral", "SingleMainProjectile", "MinionsPersistWhenSkillRemoved", "ProjectileNumber", "Warcry",
    "Instant", "Brand", "DestroysCorpse", "NonHitChill", "ChillingArea", "AppliesCurse", "CanRapidFire", "AuraDuration", "AreaSpell", "OR", "AND", "NOT",
    "AppliesMaim", "CreatesMinion", "Guard", "Travel", "Blink", "CanHaveBlessing", "ProjectilesNotFromUser", "AttackInPlaceIsDefault", "Nova",
    "InstantNoRepeatWhenHeld", "InstantShiftAttackForLeftMouse", "AuraNotOnCaster", "Banner", "Rain", "Cooldown", "ThresholdJewelChaining", "Slam", "Stance",
    "NonRepeatable", "OtherThingUsesSkill", "Steel", "Hex", "Mark", "Aegis", "Orb", "KillNoDamageModifiers", "RandomElement", "LateConsumeCooldown", "Arcane",
    "FixedCastTime", "RequiresOffHandNotWeapon", "Link", "Blessing", "ZeroReservation", "DynamicCooldown", "Microtransaction", "OwnerCannotUse",
    "ProjectilesNumberModifiersNotApplied", "TotemsAreBallistae", "SkillGrantedBySupport", "PreventHexTransfer", "MinionsAreUndamagable", "InnateTrauma",
    "DualWieldRequiresDifferentTypes", "NoVolley", "Retaliation", "NeverExertable", "DisallowTriggerSupports", "ProjectileCannotReturn", "Offering",
    "SupportedByBane", "WandAttack", "GainsIntensity", "CreatesSentinelMinion", "SupportedByAutoExertion", "SupportedByCrabTotem", "SupportedBySpellTotem",
    "CreatesCorpse", "RequiresStaff", "Pact",
];

/// Lua's `%g` (6 significant digits, no trailing zeros, exponent form when the exponent is below -4 or at least 6).
fn fmt_g(v: f64) -> String {
    if v == 0.0 {
        return "0".to_string();
    }
    if v.is_nan() {
        return "nan".to_string();
    }
    if v.is_infinite() {
        return if v > 0.0 { "inf".to_string() } else { "-inf".to_string() };
    }
    let exp = v.abs().log10().floor() as i32;
    // Rounding to 6 significant digits can carry into the next power of ten.
    let sci = format!("{:.5e}", v);
    let exp = sci.split('e').nth(1).and_then(|e| e.parse::<i32>().ok()).unwrap_or(exp);
    if !(-4..6).contains(&exp) {
        let (m, e) = sci.split_once('e').unwrap_or((&sci, "0"));
        let m = if m.contains('.') { m.trim_end_matches('0').trim_end_matches('.') } else { m };
        let e: i32 = e.parse().unwrap_or(0);
        return format!("{m}e{}{:02}", if e < 0 { '-' } else { '+' }, e.abs());
    }
    let decimals = (5 - exp).max(0) as usize;
    let s = format!("{:.*}", decimals, v);
    if s.contains('.') {
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    } else {
        s
    }
}

fn fmt_plus_g(v: f64) -> String {
    let s = fmt_g(v);
    if v >= 0.0 && !s.starts_with('-') {
        format!("+{s}")
    } else {
        s
    }
}

fn is_lower_or_digit(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit()
}

/// `modName:gsub("([%l%d]:?)(%u)","%1 %2"):gsub("(%l)(%d)","%1 %2")`.
pub fn format_mod_name(name: &str) -> String {
    let c: Vec<char> = name.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if is_lower_or_digit(c[i]) {
            // `:?` is greedy but backs off when no capital follows.
            if c.get(i + 1) == Some(&':') && c.get(i + 2).is_some_and(|x| x.is_ascii_uppercase()) {
                out.push(c[i]);
                out.push(':');
                out.push(' ');
                out.push(c[i + 2]);
                i += 3;
                continue;
            }
            if c.get(i + 1).is_some_and(|x| x.is_ascii_uppercase()) {
                out.push(c[i]);
                out.push(' ');
                out.push(c[i + 1]);
                i += 2;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    let c: Vec<char> = out.chars().collect();
    let mut out2 = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_ascii_lowercase() && c.get(i + 1).is_some_and(|x| x.is_ascii_digit()) {
            out2.push(c[i]);
            out2.push(' ');
            out2.push(c[i + 1]);
            i += 2;
            continue;
        }
        out2.push(c[i]);
        i += 1;
    }
    out2
}

fn num_str(v: f64) -> String {
    lua_num_tostring(v)
}

/// `CalcBreakdownControl:FormatModValue`.
fn format_mod_value(value: &Value, mod_type: ModType) -> String {
    let n = value.num();
    match mod_type {
        ModType::Base => format!("{} base", fmt_plus_g(n.unwrap_or(0.0))),
        ModType::Inc => {
            let v = n.unwrap_or(0.0);
            if v >= 0.0 {
                format!("{}% increased", num_str(v))
            } else {
                format!("{}% reduced", num_str(-v))
            }
        }
        ModType::More => {
            let v = n.unwrap_or(0.0);
            if v >= 0.0 {
                format!("{}% more", num_str(v))
            } else {
                format!("{}% less", num_str(-v))
            }
        }
        ModType::Override => format!("Override: {}", value_text(value)),
        ModType::Flag => if value.truthy() { "True" } else { "False" }.to_string(),
        ModType::List => match value.get(Sym::new("mod")) {
            Value::Nil => "?".to_string(),
            m => format!("Modifier: {}", format_mod_name(&match m.get(Sym::new("name")) {
                Value::Str(s) => s.to_string(),
                _ => String::new(),
            })),
        },
        _ => value_text(value),
    }
}

fn value_text(v: &Value) -> String {
    match v {
        Value::Num(n) => num_str(*n),
        Value::Str(s) => s.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

/// `CalcBreakdownControl:FormatModBase`.
fn format_mod_base(mod_type: ModType, base: f64) -> String {
    if mod_type == ModType::Base {
        fmt_plus_g(base.abs())
    } else {
        format!("{}%", num_str(base.abs()))
    }
}

fn tag_str(t: &Tag, key: &str) -> Option<String> {
    match t.get(Sym::new(key)) {
        Value::Str(s) => Some(s.to_string()),
        Value::Num(n) => Some(num_str(*n)),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn tag_num(t: &Tag, key: &str) -> Option<f64> {
    t.get(Sym::new(key)).num()
}

fn tag_truthy(t: &Tag, key: &str) -> bool {
    t.get(Sym::new(key)).truthy()
}

fn tag_list(t: &Tag, key: &str) -> Option<Vec<String>> {
    match t.get(Sym::new(key)) {
        Value::List(l) => Some(l.iter().map(value_text).collect()),
        _ => None,
    }
}

/// `FormatVarNameOrList(var, varList)`.
fn var_or_list(var: Option<String>, list: Option<Vec<String>>) -> String {
    match var {
        Some(v) => format_mod_name(&v),
        None => format_mod_name(&list.unwrap_or_default().join(" / ")),
    }
}

fn cap_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// The notes column: one description per tag, as upstream words them.
fn tag_notes(m: &Mod, skill_name: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    if m.tags.is_empty() {
        return None;
    }
    let mut notes: Option<String> = None;
    let mut base_val: Option<String> = m.value.num().map(|v| format!("{} ", format_mod_base(m.ty, v)));
    let abs_value = m.value.num().map(|v| num_str(v.abs())).unwrap_or_default();
    for tag in &m.tags {
        let kind = tag.kind.as_str();
        let desc: Option<String> = match kind {
            "Condition" | "ActorCondition" => {
                let var = tag_str(tag, "var");
                let list = tag_list(tag, "varList");
                let cond = if var.is_some() || list.is_some() {
                    format!(": {}{}", if tag_truthy(tag, "neg") { "Not " } else { "" }, var_or_list(var, list))
                } else {
                    String::new()
                };
                let actor = tag_str(tag, "actor").map(|a| format!("{} ", cap_first(&a))).unwrap_or_default();
                Some(format!("{actor}Condition{cond}"))
            }
            "Multiplier" => {
                let base = match tag_num(tag, "base") {
                    Some(b) => format!("{} + {} ", format_mod_base(m.ty, b), abs_value),
                    None => base_val.clone().unwrap_or_default(),
                };
                let div = tag_num(tag, "div").map(|d| format!("{} ", num_str(d))).unwrap_or_default();
                base_val = Some(String::new());
                Some(format!("{base}per {div}{}", var_or_list(tag_str(tag, "var"), tag_list(tag, "varList"))))
            }
            "PerStat" => {
                let base = match tag_num(tag, "base") {
                    Some(b) => format!("{} + {} ", format_mod_base(m.ty, b), abs_value),
                    None => base_val.clone().unwrap_or_default(),
                };
                let div = tag_num(tag, "div").map(num_str).unwrap_or_else(|| "1".to_string());
                let actor = tag_str(tag, "actor").map(|a| format!("{a} ")).unwrap_or_default();
                base_val = Some(String::new());
                Some(format!("{base}per {div} {actor}{}", var_or_list(tag_str(tag, "stat"), tag_list(tag, "statList"))))
            }
            "PercentStat" => {
                let value = m.value.num().unwrap_or(0.0);
                let final_percent = (value * (tag_num(tag, "percent").unwrap_or(1.0) / 100.0)) * 100.0;
                let base = match tag_num(tag, "base") {
                    Some(b) => format!("{} + {} ", format_mod_base(m.ty, b), num_str(final_percent.abs())),
                    None => format_mod_base(m.ty, final_percent),
                };
                let actor = tag_str(tag, "actor").map(|a| format!("{a} ")).unwrap_or_default();
                let var = tag_str(tag, "percentVar").or_else(|| tag_str(tag, "stat"));
                base_val = Some(String::new());
                Some(format!("{base}% of {actor}{}", var_or_list(var, tag_list(tag, "statList"))))
            }
            "MultiplierThreshold" | "StatThreshold" => {
                let var = tag_str(tag, "var").or_else(|| tag_str(tag, "stat"));
                let list = tag_list(tag, "varList").or_else(|| tag_list(tag, "statList"));
                let upper = tag_truthy(tag, "upper");
                let pct = tag_num(tag, "thresholdPercent").map(|p| format!("{}% ", num_str(p))).unwrap_or_default();
                let thr = match tag_num(tag, "threshold") {
                    Some(t) => num_str(t),
                    None => format_mod_name(&tag_str(tag, "thresholdVar").or_else(|| tag_str(tag, "thresholdStat")).unwrap_or_default()),
                };
                Some(format!("If {}{}{pct}{thr}", var_or_list(var, list), if upper { " <= " } else { " >= " }))
            }
            "SkillName" => {
                let names = tag_list(tag, "skillNameList").map(|l| l.join(" / ")).or_else(|| tag_str(tag, "skillName")).unwrap_or_default();
                Some(format!("Skill: {names}"))
            }
            "SkillId" => {
                let id = tag_str(tag, "skillId").unwrap_or_default();
                Some(format!("Skill: {}", skill_name(&id).unwrap_or(id)))
            }
            "SkillType" => {
                let ty = tag_num(tag, "skillType").map(|n| n as usize).and_then(|i| SKILL_TYPES.get(i).copied()).filter(|n| !n.is_empty());
                let neg = if tag_truthy(tag, "neg") { "Not " } else { "" };
                Some(match ty {
                    Some(n) => format!("Skill type: {neg}{}", format_mod_name(n)),
                    None => format!("Skill type: {neg}?"),
                })
            }
            "BaseFlag" => Some(format!("Base flag: {}{}", if tag_truthy(tag, "neg") { "Not " } else { "" }, format_mod_name(&tag_str(tag, "baseFlag").unwrap_or_default()))),
            "SlotNumber" => Some(format!("When in slot #{}", tag_str(tag, "num").unwrap_or_default())),
            "GlobalEffect" => Some(format_mod_name(&tag_str(tag, "effectType").unwrap_or_default())),
            "Limit" => Some(format!(
                "Limited to {}",
                match tag_str(tag, "limitVar") {
                    Some(v) => format_mod_name(&v),
                    None => format_mod_base(m.ty, tag_num(tag, "limit").unwrap_or(0.0)),
                }
            )),
            "MonsterTag" => Some(format!("Monster Tag: {}", tag_list(tag, "monsterTagList").map(|l| l.join("/")).or_else(|| tag_str(tag, "monsterTag")).unwrap_or_default())),
            other => Some(format_mod_name(other)),
        };
        if let Some(d) = desc {
            notes = Some(match notes {
                Some(n) => format!("{n}, {d}"),
                None => d,
            });
        }
    }
    notes
}

/// The names of the `ModFlag` and `KeywordFlag` bits a mod carries, sorted, joined by ", ".
fn flag_names(m: &Mod) -> Option<String> {
    if m.flags == 0 && m.keyword_flags == 0 {
        return None;
    }
    let mut names: Vec<&str> = Vec::new();
    for (n, v) in MOD_FLAGS {
        if m.flags & v == *v {
            names.push(n);
        }
    }
    for (n, v) in KEYWORD_FLAGS {
        if m.keyword_flags & v == *v {
            names.push(n);
        }
    }
    names.sort_unstable();
    Some(names.join(", "))
}

fn source_type(m: &Mod) -> String {
    m.source.as_deref().map(|s| s.split(':').next().unwrap_or("").to_string()).unwrap_or_default()
}

/// Everything after the colons of `Type:...`.
fn source_tail(s: &str) -> &str {
    s.split_once(':').map(|(_, t)| t).unwrap_or("")
}

/// The popup's modifier table for one detail (`sectionData`) of a cell: `None` when the stat has no modifiers
/// (`#rowList == 0`: upstream shows no section then).
pub fn mod_section(d: &Detail, ctx: &ModRenderCtx, skill_name: &dyn Fn(&str) -> Option<String>) -> Option<J> {
    let names: Vec<Sym> = d.mod_name.as_deref()?.iter().map(|n| Sym::new(n)).collect();
    let multi = d.mod_name.as_deref().map(|n| n.len() > 1).unwrap_or(false);
    let cfg = crate::format::detail_cfg(d, ctx);
    let store = crate::format::pick_store(d, ctx);
    let mod_type = d.mod_type.as_deref().and_then(ModType::parse);
    let rows = store.tabulate(mod_type, Some(&cfg), &names);
    if rows.is_empty() {
        return None;
    }
    // Rows as (value, mod).
    let mut rows: Vec<(Value, &Mod)> = rows.into_iter().map(|(v, m)| (v, unsafe { &*m })).collect();
    let by_name_value = |a: &(Value, &Mod), b: &(Value, &Mod)| {
        // `a.mod.name > b.mod.name or (same name and both numbers) and a.value > b.value`, as a descending order.
        let (an, bn) = (a.1.name.as_str(), b.1.name.as_str());
        match bn.cmp(an) {
            std::cmp::Ordering::Equal => match (a.0.num(), b.0.num()) {
                (Some(x), Some(y)) if matches!(a.0, Value::Num(_)) && matches!(b.0, Value::Num(_)) => y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal),
                _ => std::cmp::Ordering::Equal,
            },
            o => o,
        }
    };
    if d.mod_type.is_none() {
        rows.sort_by(|a, b| a.1.ty.as_str().cmp(b.1.ty.as_str()).then_with(|| by_name_value(a, b)));
    } else {
        rows.sort_by(by_name_value);
    }

    // Totals of each source type, shown on hover of the Source cell.
    let mut totals = serde_json::Map::new();
    let with_totals = d.mod_source.is_none();
    if with_totals {
        let mut types: Vec<ModType> = Vec::new();
        let mut source_types: Vec<String> = Vec::new();
        for (_, m) in &rows {
            if !types.contains(&m.ty) {
                types.push(m.ty);
            }
            let st = source_type(m);
            if !source_types.contains(&st) {
                source_types.push(st);
            }
        }
        for st in &source_types {
            let mut c = cfg.clone();
            c.source = Some(std::sync::Arc::from(st.as_str()));
            let mut lines: Vec<String> = Vec::new();
            for mt in &types {
                let combine = |name: &str| -> f64 { store.combine(mt.as_str(), Some(&c), &[Sym::new(name)]) };
                let line = |total: f64, name: Option<&str>| {
                    let mut total = total;
                    if *mt == ModType::More {
                        total = round((total - 1.0) * 100.0, 0);
                    }
                    if total != 0.0 {
                        let v = format_mod_value(&Value::Num(total), *mt);
                        Some(match name {
                            Some(n) => format!("{v} {}", add_spaces_lower_upper(n)),
                            None => v,
                        })
                    } else {
                        None
                    }
                };
                if multi {
                    for n in d.mod_name.as_deref().unwrap_or(&[]) {
                        if let Some(l) = line(combine(n), Some(n)) {
                            lines.push(l);
                        }
                    }
                } else if let Some(n) = d.mod_name.as_deref().and_then(|n| n.first()) {
                    if let Some(l) = line(combine(n), None) {
                        lines.push(l);
                    }
                }
            }
            totals.insert(st.clone(), J::Array(lines.into_iter().map(J::String).collect()));
        }
    }

    let out_rows: Vec<J> = rows.iter().map(|(value, m)| row_json(value, m, d.mod_type.is_none(), multi, skill_name)).collect();

    Some(json!({ "label": d.label, "rows": out_rows, "named": multi, "totals": if with_totals { J::Object(totals) } else { J::Null } }))
}


/// One row of the popup's modifier table: the value, stat, skill types, notes and source columns.
fn row_json(value: &Value, m: &Mod, type_unset: bool, multi: bool, skill_name: &dyn Fn(&str) -> Option<String>) -> J {
            let st = source_type(m);
            let display = if type_unset {
                format_mod_value(value, m.ty)
            } else {
                format_calc_val(value.num().unwrap_or(0.0), 2)
            };
            let mut o = serde_json::Map::new();
            o.insert("value".into(), json!(display));
            if multi {
                o.insert("name".into(), json!(format_mod_name(m.name.as_str())));
            }
            if let Some(f) = flag_names(m) {
                o.insert("flags".into(), json!(f));
            }
            if let Some(n) = tag_notes(m, skill_name) {
                o.insert("tags".into(), json!(n));
            }
            o.insert("source".into(), json!(st));
            let src = m.source.as_deref().unwrap_or("");
            match st.as_str() {
                "Item" => {
                    // `Item:<id>:<name>`
                    let mut it = src.splitn(3, ':');
                    let _ = it.next();
                    if let Some(id) = it.next().and_then(|s| s.parse::<i64>().ok()) {
                        o.insert("itemId".into(), json!(id));
                    }
                    if let Some(name) = it.next() {
                        o.insert("sourceName".into(), json!(name));
                    }
                }
                "Tree" => {
                    let tail = source_tail(src);
                    if let Ok(id) = tail.parse::<i64>() {
                        o.insert("nodeId".into(), json!(id));
                    } else {
                        o.insert("sourceName".into(), json!(tail));
                    }
                }
                "Skill" => {
                    let tail = source_tail(src);
                    o.insert("sourceName".into(), json!(skill_name(tail).unwrap_or_else(|| tail.to_string())));
                    o.insert("skillId".into(), json!(tail));
                }
                "Pantheon" | "Spectre" | "Custom" => {
                    o.insert("sourceName".into(), json!(source_tail(src)));
                }
                _ => {}
            }
    J::Object(o)
}

/// The popup's table for a list of modifiers with their values (`breakdown.modList`: the "Aura and Buff Skills" and
/// "Curses and Debuffs" lists), sorted by stat name then value, each row naming its stat.
pub fn mod_list_section(rows: &[(Value, Mod)], skill_name: &dyn Fn(&str) -> Option<String>) -> Option<J> {
    if rows.is_empty() {
        return None;
    }
    let mut r: Vec<(Value, &Mod)> = rows.iter().map(|(v, m)| (v.clone(), m)).collect();
    r.sort_by(|a, b| {
        let (an, bn) = (a.1.name.as_str(), b.1.name.as_str());
        match bn.cmp(an) {
            std::cmp::Ordering::Equal => match (&a.0, &b.0) {
                (Value::Num(x), Value::Num(y)) => y.partial_cmp(x).unwrap_or(std::cmp::Ordering::Equal),
                _ => std::cmp::Ordering::Equal,
            },
            o => o,
        }
    });
    let out: Vec<J> = r.iter().map(|(v, m)| row_json(v, m, true, true, skill_name)).collect();
    Some(json!({ "label": J::Null, "rows": out, "named": true, "totals": J::Null }))
}

/// `name:gsub("(%l)(%u)","%1 %2")` (the totals lines' stat name).
fn add_spaces_lower_upper(name: &str) -> String {
    let c: Vec<char> = name.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i].is_ascii_lowercase() && c.get(i + 1).is_some_and(|x| x.is_ascii_uppercase()) {
            out.push(c[i]);
            out.push(' ');
            out.push(c[i + 1]);
            i += 2;
            continue;
        }
        out.push(c[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mod_names_get_spaces() {
        assert_eq!(format_mod_name("PhysicalDamage"), "Physical Damage");
        assert_eq!(format_mod_name("FireResistMax"), "Fire Resist Max");
        assert_eq!(format_mod_name("Multiplier:FrenzyCharge"), "Multiplier: Frenzy Charge");
        assert_eq!(format_mod_name("Str2"), "Str 2");
    }

    #[test]
    fn g_format_matches_lua() {
        assert_eq!(fmt_g(5.0), "5");
        assert_eq!(fmt_g(0.1), "0.1");
        assert_eq!(fmt_g(1234567.0), "1.23457e+06");
        assert_eq!(fmt_g(0.0001), "0.0001");
        assert_eq!(fmt_plus_g(12.5), "+12.5");
        assert_eq!(fmt_plus_g(-3.0), "-3");
    }
}
