//! Port of ModStoreClass:EvalMod (Classes/ModStore.lua lines 359-971): every tag branch that
//! file defines, in the same order, plus the trailing global-limit pass. Tag kinds with no
//! branch there (SlotNumber, InSlot, GlobalEffect, DisablesItem, SelfUnalloc, ...) are no-ops in
//! upstream too: they steer which item slot a mod applies to before it ever reaches a
//! ModDB, not what EvalMod computes, so they are intentionally absent here as well.
use crate::modifier::Mod;
use crate::modmatch::store::ModStore;
use crate::modmatch::types::Cfg;
use crate::sym::Sym;
use crate::value::Value;
use std::collections::HashMap;
use std::sync::Arc;

fn map_get(v: &Value, key: Sym) -> Option<Value> {
    if let Value::Map(m) = v { m.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone()) } else { None }
}
fn map_set(v: &Value, key: Sym, newval: Value) -> Value {
    if let Value::Map(m) = v {
        let mut vec: Vec<(Sym, Value)> = (**m).clone();
        if let Some(entry) = vec.iter_mut().find(|(k, _)| *k == key) { entry.1 = newval; } else { vec.push((key, newval)); }
        Value::Map(Arc::new(vec))
    } else {
        newval
    }
}
fn as_list(v: &Value) -> Vec<Value> {
    if let Value::List(l) = v { (**l).clone() } else { Vec::new() }
}
fn as_str(v: &Value) -> Option<Arc<str>> {
    if let Value::Str(s) = v { Some(s.clone()) } else { None }
}
fn present(v: &Value) -> bool { !matches!(v, Value::Nil) }

/// Applies `value = value * mult + base` (optionally `ceil`ed, per PercentStat), then the
/// limitTotal/limitNegTotal clamps, either to a plain numeric value or, for a scaled sub-mod
/// value (`{mod = {...}}` or `{value = ...}`), to the nested numeric field, exactly as the
/// `type(value) == "table"` branches in upstream do.
fn scale_value(value: &Value, mult: f64, base: f64, ceil: bool, limit_total: Option<f64>, limit_neg_total: Option<f64>) -> Value {
    let apply = |old: f64| -> f64 {
        let mut v = old * mult + base;
        if ceil { v = v.ceil(); }
        if let Some(lt) = limit_total { v = v.min(lt); }
        if let Some(ln) = limit_neg_total { v = v.max(ln); }
        v
    };
    if let Value::Map(_) = value {
        let mod_sym = Sym::new("mod");
        let value_sym = Sym::new("value");
        if let Some(modv) = map_get(value, mod_sym) {
            let old = map_get(&modv, value_sym).and_then(|v| v.num()).unwrap_or(0.0);
            let newmod = map_set(&modv, value_sym, Value::Num(apply(old)));
            map_set(value, mod_sym, newmod)
        } else {
            let old = map_get(value, value_sym).and_then(|v| v.num()).unwrap_or(0.0);
            map_set(value, value_sym, Value::Num(apply(old)))
        }
    } else {
        Value::Num(apply(value.num().unwrap_or(0.0)))
    }
}

/// Title-cases an item slot key the way `tag.itemSlot:lower():gsub("(%l)(%w*)", ...)` does:
/// lowercase, then capitalize the first letter of each whitespace-separated word.
fn title_case_slot(s: &str) -> String {
    s.trim().split_whitespace().map(|w| {
        let lw = w.to_lowercase();
        let mut c = lw.chars();
        match c.next() {
            Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
            None => String::new(),
        }
    }).collect::<Vec<_>>().join(" ")
}

fn swap_trailing_digit(slot: &str) -> String {
    if let Some(stripped) = slot.strip_suffix('1') { format!("{}2", stripped) }
    else if let Some(stripped) = slot.strip_suffix('2') { format!("{}1", stripped) }
    else { slot.to_string() }
}

/// Port of `ModStoreClass:EvalMod`. `ctx` is the store `Sum`/`More`/... was originally called
/// on (Lua's `self` throughout this function, threaded unchanged down the parent chain).
pub fn eval_mod(ctx: &ModStore, m: &Mod, cfg: Option<&Cfg>, mut global_limits: Option<&mut HashMap<Sym, f64>>) -> Option<Value> {
    let mut value = m.value.clone();
    let stat_syms = crate::modmatch::store::StatSyms::new();

    for tag in &m.tags {
        let kind = tag.kind.as_str();
        match kind {
            "Multiplier" => {
                let mut target = ctx;
                let mut limit_target = ctx;
                let target_owned; // keeps a borrowed-out Arc alive for `target`/`limit_target`
                let limit_owned;
                if let Some(limit_actor) = as_str(tag.get(Sym::new("limitActor"))) {
                    match resolve_actor_store(ctx, &limit_actor) {
                        Some(s) => { limit_owned = s; limit_target = &limit_owned; }
                        None => return None,
                    }
                }
                if let Some(actor_role) = as_str(tag.get(Sym::new("actor"))) {
                    match resolve_actor_store(ctx, &actor_role) {
                        Some(s) => { target_owned = s; target = &target_owned; }
                        None => return None,
                    }
                }
                let var_list = tag.get(Sym::new("varList"));
                let mut base = 0.0;
                if present(var_list) {
                    for v in as_list(var_list) {
                        if let Some(s) = as_str(&v) { base += target.get_multiplier(Sym::new(&s), cfg, false); }
                    }
                } else if let Some(var) = as_str(tag.get(Sym::new("var"))) {
                    base = target.get_multiplier(Sym::new(&var), cfg, false);
                }
                let mut div = tag.get(Sym::new("div")).num();
                if let Some(div_var) = as_str(tag.get(Sym::new("divVar"))) {
                    div = Some(ctx.get_multiplier(Sym::new(&div_var), cfg, false));
                }
                let div = div.unwrap_or(1.0);
                let no_floor = tag.get(Sym::new("noFloor")).truthy();
                let mut mult = if no_floor { base / div } else { (base / div + 0.0001).floor() };
                let mut limit_total = None;
                let mut limit_neg_total = None;
                let limit_field = tag.get(Sym::new("limit"));
                let limit_var = as_str(tag.get(Sym::new("limitVar")));
                let limit_stat = as_str(tag.get(Sym::new("limitStat")));
                if present(limit_field) || limit_var.is_some() || limit_stat.is_some() {
                    let limit = if let Some(n) = limit_field.num() { n }
                        else if let Some(lv) = &limit_var { limit_target.get_multiplier(Sym::new(lv), cfg, false) }
                        else if let Some(ls) = &limit_stat { limit_target.get_stat(Sym::new(ls), cfg, &stat_syms) }
                        else { 0.0 };
                    if tag.get(Sym::new("limitTotal")).truthy() { limit_total = Some(limit); }
                    else if tag.get(Sym::new("limitNegTotal")).truthy() { limit_neg_total = Some(limit); }
                    else { mult = mult.min(limit); }
                }
                if tag.get(Sym::new("invert")).truthy() && mult != 0.0 { mult = 1.0 / mult; }
                let base_add = tag.get(Sym::new("base")).num().unwrap_or(0.0);
                value = scale_value(&value, mult, base_add, false, limit_total, limit_neg_total);
            }
            "MultiplierThreshold" => {
                let mut target = ctx;
                let mut threshold_target = ctx;
                let target_owned;
                let threshold_owned;
                if let Some(role) = as_str(tag.get(Sym::new("thresholdActor"))) {
                    match resolve_actor_store(ctx, &role) { Some(s) => { threshold_owned = s; threshold_target = &threshold_owned; } None => return None }
                }
                if let Some(role) = as_str(tag.get(Sym::new("actor"))) {
                    match resolve_actor_store(ctx, &role) { Some(s) => { target_owned = s; target = &target_owned; } None => return None }
                }
                let var_list = tag.get(Sym::new("varList"));
                let mut mult = 0.0;
                if present(var_list) {
                    for v in as_list(var_list) { if let Some(s) = as_str(&v) { mult += target.get_multiplier(Sym::new(&s), cfg, false); } }
                } else if let Some(var) = as_str(tag.get(Sym::new("var"))) {
                    mult = target.get_multiplier(Sym::new(&var), cfg, false);
                }
                let threshold = if let Some(n) = tag.get(Sym::new("threshold")).num() { n }
                    else if let Some(tv) = as_str(tag.get(Sym::new("thresholdVar"))) {
                        let tt = if as_str(tag.get(Sym::new("thresholdActor"))).is_some() { threshold_target } else { target };
                        tt.get_multiplier(Sym::new(&tv), cfg, false)
                    } else { 0.0 };
                let upper = tag.get(Sym::new("upper")).truthy();
                let equals = tag.get(Sym::new("equals")).truthy();
                let fail = (upper && mult > threshold) || (equals && mult != threshold) || (!upper && !equals && mult < threshold);
                if fail { return None; }
            }
            "PerStat" => {
                let mut target = ctx;
                let target_owned;
                if let Some(role) = as_str(tag.get(Sym::new("actor"))) {
                    if let Some(s) = resolve_actor_store(ctx, &role) { target_owned = s; target = &target_owned; }
                }
                let stat_list = tag.get(Sym::new("statList"));
                let mut base = 0.0;
                if present(stat_list) {
                    for v in as_list(stat_list) { if let Some(s) = as_str(&v) { base += target.get_stat(Sym::new(&s), cfg, &stat_syms); } }
                } else if let Some(stat) = as_str(tag.get(Sym::new("stat"))) {
                    base = target.get_stat(Sym::new(&stat), cfg, &stat_syms);
                }
                let mut div = tag.get(Sym::new("div")).num();
                if let Some(div_var) = as_str(tag.get(Sym::new("divVar"))) { div = Some(ctx.get_multiplier(Sym::new(&div_var), cfg, false)); }
                let mult = (base / div.unwrap_or(1.0) + 0.0001).floor();
                let mut limit_total = None;
                let mut mult = mult;
                let limit_field = tag.get(Sym::new("limit"));
                let limit_var = as_str(tag.get(Sym::new("limitVar")));
                if present(limit_field) || limit_var.is_some() {
                    let limit = limit_field.num().unwrap_or_else(|| limit_var.as_ref().map(|lv| ctx.get_multiplier(Sym::new(lv), cfg, false)).unwrap_or(0.0));
                    if tag.get(Sym::new("limitTotal")).truthy() { limit_total = Some(limit); } else { mult = mult.min(limit); }
                }
                let base_add = tag.get(Sym::new("base")).num().unwrap_or(0.0);
                value = scale_value(&value, mult, base_add, false, limit_total, None);
            }
            "PercentStat" => {
                let mut target = ctx;
                let target_owned;
                if let Some(role) = as_str(tag.get(Sym::new("actor"))) {
                    if let Some(s) = resolve_actor_store(ctx, &role) { target_owned = s; target = &target_owned; }
                }
                let stat_list = tag.get(Sym::new("statList"));
                let mut base = 0.0;
                if present(stat_list) {
                    for v in as_list(stat_list) { if let Some(s) = as_str(&v) { base += target.get_stat(Sym::new(&s), cfg, &stat_syms); } }
                } else if let Some(stat) = as_str(tag.get(Sym::new("stat"))) {
                    base = target.get_stat(Sym::new(&stat), cfg, &stat_syms);
                }
                let percent = if let Some(n) = tag.get(Sym::new("percent")).num() { Some(n) }
                    else { as_str(tag.get(Sym::new("percentVar"))).map(|pv| ctx.get_multiplier(Sym::new(&pv), cfg, false)) };
                let mut mult = base * percent.map(|p| p / 100.0).unwrap_or(1.0);
                if tag.get(Sym::new("floor")).truthy() { mult = mult.floor(); }
                let mut limit_total = None;
                let limit_field = tag.get(Sym::new("limit"));
                let limit_var = as_str(tag.get(Sym::new("limitVar")));
                if present(limit_field) || limit_var.is_some() {
                    let limit = limit_field.num().unwrap_or_else(|| limit_var.as_ref().map(|lv| ctx.get_multiplier(Sym::new(lv), cfg, false)).unwrap_or(0.0));
                    if tag.get(Sym::new("limitTotal")).truthy() { limit_total = Some(limit); } else { mult = mult.min(limit); }
                }
                let base_add = tag.get(Sym::new("base")).num().unwrap_or(0.0);
                value = scale_value(&value, mult, base_add, true, limit_total, None);
            }
            "StatThreshold" => {
                let stat_list = tag.get(Sym::new("statList"));
                let mut stat = 0.0;
                if present(stat_list) {
                    for v in as_list(stat_list) { if let Some(s) = as_str(&v) { stat += ctx.get_stat(Sym::new(&s), cfg, &stat_syms); } }
                } else if let Some(s) = as_str(tag.get(Sym::new("stat"))) {
                    stat = ctx.get_stat(Sym::new(&s), cfg, &stat_syms);
                }
                let mut threshold = if let Some(n) = tag.get(Sym::new("threshold")).num() { n }
                    else if let Some(ts) = as_str(tag.get(Sym::new("thresholdStat"))) { ctx.get_stat(Sym::new(&ts), cfg, &stat_syms) } else { 0.0 };
                let threshold_percent = if let Some(n) = tag.get(Sym::new("thresholdPercent")).num() { Some(n) }
                    else { as_str(tag.get(Sym::new("thresholdPercentVar"))).map(|v| ctx.get_multiplier(Sym::new(&v), cfg, false)) };
                if let Some(tp) = threshold_percent { threshold *= tp / 100.0; }
                let upper = tag.get(Sym::new("upper")).truthy();
                if (upper && stat > threshold) || (!upper && stat < threshold) { return None; }
            }
            "DistanceRamp" => {
                let dist = match cfg.and_then(|c| c.skill_dist) { Some(d) => d, None => return None };
                let ramp = as_list(tag.get(Sym::new("ramp")));
                if ramp.is_empty() { return None; }
                let pt = |v: &Value, i: usize| as_list(v).get(i).and_then(|x| x.num()).unwrap_or(0.0);
                let first_x = pt(&ramp[0], 0);
                let last_x = pt(&ramp[ramp.len() - 1], 0);
                let cur = value.num().unwrap_or(0.0);
                if dist <= first_x {
                    value = Value::Num(cur * pt(&ramp[0], 1));
                } else if dist >= last_x {
                    value = Value::Num(cur * pt(&ramp[ramp.len() - 1], 1));
                } else {
                    for i in 0..ramp.len() {
                        if let Some(next) = ramp.get(i + 1) {
                            let (x0, y0) = (pt(&ramp[i], 0), pt(&ramp[i], 1));
                            let (x1, y1) = (pt(next, 0), pt(next, 1));
                            if dist <= x1 {
                                value = Value::Num(cur * (y0 + (y1 - y0) * (dist - x0) / (x1 - x0)));
                                break;
                            }
                        }
                    }
                }
            }
            "MeleeProximity" => {
                let dist = match cfg.and_then(|c| c.skill_dist) { Some(d) => d, None => return None };
                let ramp0 = as_list(tag.get(Sym::new("ramp"))).first().and_then(|v| v.num()).unwrap_or(0.0);
                let cur = value.num().unwrap_or(0.0);
                value = Value::Num(if dist <= 15.0 { cur * ramp0 }
                    else if (16.0..=39.0).contains(&dist) { cur * (ramp0 - (ramp0 / 25.0) * (dist - 15.0)) }
                    else { 0.0 });
            }
            "Limit" => {
                let limit = if let Some(n) = tag.get(Sym::new("limit")).num() { n }
                    else if let Some(lv) = as_str(tag.get(Sym::new("limitVar"))) { ctx.get_multiplier(Sym::new(&lv), cfg, false) } else { f64::INFINITY };
                value = Value::Num(value.num().unwrap_or(0.0).min(limit));
            }
            "Condition" => {
                let neg = tag.get(Sym::new("neg")).truthy();
                let all_1h = one_h_weapon(ctx);
                let mut matched = false;
                let var_list = tag.get(Sym::new("varList"));
                if present(var_list) {
                    for v in as_list(var_list) {
                        let var = match as_str(&v) { Some(s) => s, None => continue };
                        if neg { if let Some(added) = all_1h.and_then(|w| w.get(format!("Added{}", var).as_str()).cloned()) { if !added.as_bool().unwrap_or(false) { return None; } continue; } }
                        if ctx.get_condition(Sym::new(&var), cfg, false) || cfg.map(|c| c.skill_cond.get(var.as_ref()).copied().unwrap_or(false)).unwrap_or(false) {
                            matched = true;
                            break;
                        }
                    }
                } else if let Some(var) = as_str(tag.get(Sym::new("var"))) {
                    if neg {
                        if let Some(added) = all_1h.and_then(|w| w.get(format!("Added{}", var).as_str()).cloned()) {
                            if !added.as_bool().unwrap_or(false) { return None; }
                        } else {
                            matched = ctx.get_condition(Sym::new(&var), cfg, false) || cfg.map(|c| c.skill_cond.get(var.as_ref()).copied().unwrap_or(false)).unwrap_or(false);
                        }
                    } else {
                        matched = ctx.get_condition(Sym::new(&var), cfg, false) || cfg.map(|c| c.skill_cond.get(var.as_ref()).copied().unwrap_or(false)).unwrap_or(false);
                    }
                }
                if neg { matched = !matched; }
                if !matched { return None; }
            }
            "ActorCondition" => {
                // Port of Classes/ModStore.lua:664-684. NOTE: this branch differs from
                // `crates/engine/src/modstore/eval.rs`'s copy of the same code, which nests the
                // `tag.actor == cfg.actor` fallback only inside the "actor not found" arm. The
                // real Lua condition is `if target and (tag.var or tag.varList) then ... elseif
                // tag.actor and cfg and tag.actor == cfg.actor then match = true end` -- the
                // elseif fires whenever var/varList are BOTH absent, regardless of whether
                // `target` resolved, e.g. a self-referential `actor = "player"` tag with no `var`
                // (confirmed against a real corpus mod, Tree:9373's `FlaskEffect` INC 5, whose
                // only tag is `{type="ActorCondition", actor="player"}`; the answer key expects it
                // counted).
                let role = as_str(tag.get(Sym::new("actor")));
                let neg = tag.get(Sym::new("neg")).truthy();
                let var_list = tag.get(Sym::new("varList"));
                let var = as_str(tag.get(Sym::new("var")));
                let mut matched = false;
                if let Some(r) = &role {
                    let target = resolve_actor_store(ctx, r);
                    if target.is_some() && (present(var_list) || var.is_some()) {
                        let target = target.unwrap();
                        if present(var_list) {
                            for v in as_list(var_list) { if let Some(s) = as_str(&v) { if target.get_condition(Sym::new(&s), cfg, false) { matched = true; break; } } }
                        } else if let Some(v) = &var {
                            matched = target.get_condition(Sym::new(v), cfg, false);
                        }
                    } else if cfg.and_then(|c| c.actor_tag.as_deref()) == Some(r.as_ref()) {
                        matched = true;
                    }
                }
                if neg { matched = !matched; }
                if !matched { return None; }
            }
            "ItemCondition" => {
                if !eval_item_condition(ctx, tag, cfg) { return None; }
            }
            "SocketedIn" => {
                if !eval_socketed_in(cfg, tag) { return None; }
            }
            "SkillName" => {
                if !eval_skill_name(cfg, tag) { return None; }
            }
            "SkillId" => {
                let want = as_str(tag.get(Sym::new("skillId")));
                let have = cfg.and_then(|c| c.skill_granted_effect_id.clone());
                if want != have { return None; }
            }
            "SkillPart" => {
                let neg = tag.get(Sym::new("neg")).truthy();
                let part = cfg.and_then(|c| c.skill_part);
                let list = tag.get(Sym::new("skillPartList"));
                let mut matched = false;
                if present(list) {
                    for v in as_list(list) { if v.num() == part { matched = true; break; } }
                } else {
                    matched = tag.get(Sym::new("skillPart")).num() == part;
                }
                if neg { matched = !matched; }
                if !matched { return None; }
            }
            "SkillType" => {
                let neg = tag.get(Sym::new("neg")).truthy();
                let list = tag.get(Sym::new("skillTypeList"));
                let mut matched = false;
                if present(list) {
                    for v in as_list(list) { if let Some(id) = v.num() { if cfg.map(|c| c.skill_types.get(&(id as i64)).copied().unwrap_or(false)).unwrap_or(false) { matched = true; break; } } }
                } else if let Some(id) = tag.get(Sym::new("skillType")).num() {
                    matched = cfg.map(|c| c.skill_types.get(&(id as i64)).copied().unwrap_or(false)).unwrap_or(false);
                }
                if neg { matched = !matched; }
                if !matched { return None; }
            }
            "BaseFlag" => {
                let neg = tag.get(Sym::new("neg")).truthy();
                let flag = as_str(tag.get(Sym::new("baseFlag")));
                let matched_raw = flag.as_ref().and_then(|f| cfg.and_then(|c| {
                    if !c.skill_granted_effect_base_flags.is_empty() { c.skill_granted_effect_base_flags.get(f.as_ref()).copied() }
                    else { c.base_flags.get(f.as_ref()).copied() }
                })).unwrap_or(false);
                let matched = if neg { !matched_raw } else { matched_raw };
                if !matched { return None; }
            }
            "SlotName" => {
                let neg = tag.get(Sym::new("neg")).truthy();
                let slot_name = cfg.and_then(|c| c.slot_name.clone());
                let list = tag.get(Sym::new("slotNameList"));
                let mut matched = false;
                if present(list) {
                    for v in as_list(list) { if as_str(&v) == slot_name { matched = true; break; } }
                } else {
                    matched = as_str(tag.get(Sym::new("slotName"))) == slot_name;
                }
                if neg { matched = !matched; }
                if !matched { return None; }
            }
            "ModFlagOr" => {
                let mod_flags = tag.get(Sym::new("modFlags")).num().unwrap_or(0.0) as u64;
                match cfg {
                    Some(c) if c.flags & mod_flags != 0 => {}
                    _ => return None,
                }
            }
            "KeywordFlagAnd" => {
                let kw = tag.get(Sym::new("keywordFlags")).num().unwrap_or(0.0) as u64;
                match cfg {
                    Some(c) if c.keyword_flags & kw == kw => {}
                    _ => return None,
                }
            }
            "MonsterTag" => {
                let tags = match ctx.actor.as_ref().and_then(|a| a.minion_monster_tags.as_ref()) { Some(t) => t, None => return None };
                let neg = tag.get(Sym::new("neg")).truthy();
                let list = tag.get(Sym::new("monsterTagList"));
                let mut matched = false;
                'outer: for t in tags {
                    let tl = t.to_lowercase();
                    if present(list) {
                        for v in as_list(list) { if let Some(s) = as_str(&v) { if s.to_lowercase() == tl { matched = true; break 'outer; } } }
                    } else if let Some(want) = as_str(tag.get(Sym::new("monsterTag"))) {
                        if want.to_lowercase() == tl { matched = true; break 'outer; }
                    }
                }
                if neg { matched = !matched; }
                if !matched { return None; }
            }
            _ => { /* not a branch EvalMod handles (e.g. SlotNumber, InSlot, GlobalEffect): no-op */ }
        }
    }

    // Trailing global-limit pass, applied regardless of which tags fired above.
    if let Some(gl) = global_limits.as_deref_mut() {
        for tag in &m.tags {
            let key = as_str(tag.get(Sym::new("globalLimitKey")));
            let limit = tag.get(Sym::new("globalLimit")).num();
            if let (Some(key), Some(limit)) = (key, limit) {
                let key_sym = Sym::new(&key);
                let mut v = value.num().unwrap_or(0.0);
                let used = gl.entry(key_sym).or_insert(0.0);
                if *used + v > limit { v = limit - *used; }
                *used += v;
                value = Value::Num(v);
            }
        }
    }
    Some(value)
}

fn resolve_actor_store(ctx: &ModStore, role: &str) -> Option<Arc<ModStore>> {
    ctx.actor.as_ref()?.related.borrow().get(role).cloned()
}

fn one_h_weapon(ctx: &ModStore) -> Option<&HashMap<Arc<str>, crate::modmatch::types::ScalarValue>> {
    let actor = ctx.actor.as_ref()?;
    let counts_as_all_1h = Sym::new("countsAsAll1H");
    let _ = counts_as_all_1h;
    if actor.weapon1.get("countsAsAll1H").map(|v| v.truthy()).unwrap_or(false) { return Some(&actor.weapon1); }
    if actor.weapon2.get("countsAsAll1H").map(|v| v.truthy()).unwrap_or(false) { return Some(&actor.weapon2); }
    None
}

fn eval_skill_name(cfg: Option<&Cfg>, tag: &crate::modifier::Tag) -> bool {
    let neg = tag.get(Sym::new("neg")).truthy();
    let summon_skill = tag.get(Sym::new("summonSkill")).truthy();
    let match_name = if summon_skill { cfg.and_then(|c| c.summon_skill_name.clone()) } else { cfg.and_then(|c| c.skill_name.clone()) }
        .map(|s| s.to_lowercase()).unwrap_or_default();
    let list = tag.get(Sym::new("skillNameList"));
    let mut matched = false;
    if present(list) {
        for v in as_list(list) { if let Some(s) = as_str(&v) { if s.to_lowercase() == match_name { matched = true; break; } } }
    } else if let Some(name) = as_str(tag.get(Sym::new("skillName"))) {
        matched = name.to_lowercase() == match_name;
    }
    if neg { matched = !matched; }
    matched
}

fn eval_socketed_in(cfg: Option<&Cfg>, tag: &crate::modifier::Tag) -> bool {
    let cfg = match cfg { Some(c) => c, None => return false };
    let slot_name = as_str(tag.get(Sym::new("slotName")));
    let keyword = as_str(tag.get(Sym::new("keyword")));
    let socket_color = as_str(tag.get(Sym::new("socketColor")));
    if slot_name.is_none() && keyword.is_none() && socket_color.is_none() { return false; }
    let sockets = tag.get(Sym::new("sockets"));
    let mut checks: Vec<bool> = Vec::new();
    if let Some(sn) = &slot_name { checks.push(cfg.slot_name.as_deref() == Some(sn.as_ref())); }
    if let Some(kw) = &keyword {
        checks.push(cfg.skill_gem.as_ref().map(|g| g.is_type(kw)).unwrap_or(false));
    } else if let Some(sc) = &socket_color {
        let is_all = matches!(as_str(sockets).as_deref(), Some("all"));
        if !is_all { checks.push(cfg.socket_color.as_deref() == Some(sc.as_ref())); }
    }
    if present(sockets) {
        let target_color = socket_color.as_deref();
        let count = match target_color {
            Some("R") => cfg.strength_gems, Some("G") => cfg.dexterity_gems, Some("B") => cfg.intelligence_gems, _ => None,
        }.unwrap_or(0.0);
        match sockets {
            Value::Str(s) if s.as_ref() == "all" => {
                let total = cfg.intelligence_gems.unwrap_or(0.0) + cfg.dexterity_gems.unwrap_or(0.0) + cfg.strength_gems.unwrap_or(0.0);
                checks.push(total == count && total > 0.0);
            }
            Value::List(list) => {
                if let Some(num) = cfg.socket_num {
                    checks.push(list.iter().any(|v| v.num() == Some(num)));
                } else {
                    return false;
                }
            }
            Value::Num(n) => checks.push(count < *n),
            _ => return false,
        }
    }
    let neg = tag.get(Sym::new("neg")).truthy();
    checks.into_iter().all(|v| if neg { !v } else { v })
}

fn eval_item_condition(ctx: &ModStore, tag: &crate::modifier::Tag, cfg: Option<&Cfg>) -> bool {
    let actor = match ctx.actor.as_ref() { Some(a) => a, None => return false };
    let all_slots = tag.get(Sym::new("allSlots")).truthy();
    let both_slots = tag.get(Sym::new("bothSlots")).truthy();
    let raw_slot = as_str(tag.get(Sym::new("itemSlot"))).unwrap_or_else(|| "".into());
    let item_slot = title_case_slot(&raw_slot);
    let neg = tag.get(Sym::new("neg")).truthy();

    let mut items: Vec<(String, &crate::modmatch::types::ItemInfo)> = Vec::new();
    if all_slots {
        for (slot, item) in &actor.items { items.push((slot.to_string(), item)); }
    } else if both_slots {
        let slot1 = format!("{} 1", item_slot);
        let slot2 = format!("{} 2", item_slot);
        let mut i1 = actor.items.get(slot1.as_str());
        let mut i2 = actor.items.get(slot2.as_str());
        if i1.map(|i| i.name.as_deref().unwrap_or("").contains("Kalandra's Touch")).unwrap_or(false) { i1 = i2; }
        if i2.map(|i| i.name.as_deref().unwrap_or("").contains("Kalandra's Touch")).unwrap_or(false) { i2 = actor.items.get(slot1.as_str()); }
        if let (Some(a), Some(b)) = (i1, i2) { items.push((slot1, a)); items.push((slot2, b)); }
    } else {
        let mut item = actor.items.get(item_slot.as_str());
        if item.map(|i| i.name.as_deref().unwrap_or("").contains("Kalandra's Touch")).unwrap_or(false) {
            item = actor.items.get(swap_trailing_digit(&item_slot).as_str());
        }
        let cfg_item_owned;
        let resolved = if let Some(it) = item { Some(it) } else if let Some(ci) = cfg.and_then(|c| c.item.as_ref()) { cfg_item_owned = ci; Some(cfg_item_owned) } else { None };
        // no item in this slot and no cfg.item fallback: Lua's `items` table stays empty
        // (assigning nil to a table key stores nothing), which the hasItems check below handles.
        if let Some(it) = resolved { items.push((item_slot.clone(), it)); }
    }

    let mut matches: Vec<bool> = Vec::new();
    if let Some(search_cond) = as_str(tag.get(Sym::new("searchCond"))) {
        let cond_lower = search_cond.to_lowercase();
        let exclude_self = tag.get(Sym::new("excludeSelf")).truthy();
        for (slot, _item) in &items {
            if all_slots && slot.as_str() == item_slot.as_str() && exclude_self { continue; }
            let slot_lower = slot.to_lowercase();
            let found = actor.item_search.get(cond_lower.as_str()).and_then(|m| m.get(slot_lower.as_str())).copied().unwrap_or(false);
            matches.push(found);
        }
    }
    if let Some(rc) = as_str(tag.get(Sym::new("rarityCond"))) { for (_, i) in &items { matches.push(i.rarity.as_deref() == Some(rc.as_ref())); } }
    if let Some(cc) = tag.get(Sym::new("corruptedCond")).as_bool() { for (_, i) in &items { matches.push(i.corrupted == Some(cc)); } }
    if let Some(sc) = tag.get(Sym::new("shaperCond")).as_bool() { for (_, i) in &items { matches.push(i.shaper == Some(sc)); } }
    if let Some(ec) = tag.get(Sym::new("elderCond")).as_bool() { for (_, i) in &items { matches.push(i.elder == Some(ec)); } }
    if let Some(nc) = as_str(tag.get(Sym::new("nameCond"))) { for (_, i) in &items { matches.push(i.name.as_deref().map(|n| n.to_lowercase()) == Some(nc.to_lowercase())); } }

    let has_items = !items.is_empty();
    let mut all_match = true;
    for b in matches { if b == neg { all_match = false; break; } }
    if !all_match || (!has_items && !neg) { return false; }
    true
}

trait ValueBoolExt { fn as_bool(&self) -> Option<bool>; }
impl ValueBoolExt for Value { fn as_bool(&self) -> Option<bool> { if let Value::Bool(b) = self { Some(*b) } else { None } } }
