//! What the Configuration tab reads from the engine: the option catalog (`Modules/ConfigOptions.lua`, stored in
//! `data/config_catalog.json`), the display-stat list tooltips compare with, and the
//! per-build state: config sets, inputs, which options upstream shows (`Modules/ConfigVisibility.lua`) and custom
//! modifier blocks. Nothing here changes a build.
use crate::Env;
use pom_engine::fxhash::{HashMap, HashSet};
use pom_engine::modifier::Mod;
use pom_engine::value::Value as V;
use roxmltree::Document;
use serde_json::{json, Map, Value};
use std::sync::OnceLock;

static CATALOG_RAW: &str = include_str!("../data/config_catalog.json");
static STAT_META_RAW: &str = include_str!("../data/stat_meta.json");

/// The `ConfigCatalog` of `packages/protocol/src/tabs.ts`.
pub fn config_catalog() -> &'static Value {
    static CATALOG: OnceLock<Value> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let rows: Vec<Value> = serde_json::from_str(CATALOG_RAW).expect("config_catalog.json");
        let mut sections = Vec::new();
        let mut options = Vec::new();
        let mut section = String::new();
        for row in rows {
            let Some(o) = row.as_object() else { continue };
            if let Some(title) = o.get("section").and_then(|s| s.as_str()) {
                section = title.to_string();
                sections.push(json!({ "title": title, "col": o.get("col").cloned().unwrap_or(json!(1)) }));
                continue;
            }
            let mut out = Map::new();
            out.insert("index".into(), o["index"].clone());
            out.insert("section".into(), json!(section));
            for k in ["var", "type", "label", "tooltip", "dynamicTooltip", "list", "defaultIndex", "defaultState", "defaultPlaceholderState", "resizable", "hideIfInvalid", "doNotHighlight", "legacy"] {
                if let Some(v) = o.get(k) {
                    out.insert(k.into(), v.clone());
                }
            }
            let mut conds = Map::new();
            for (k, v) in o {
                if k.starts_with("if") || k.starts_with("imply") || k == "includeTransfigured" {
                    conds.insert(k.clone(), v.clone());
                }
            }
            out.insert("conditions".into(), Value::Object(conds));
            out.insert("showAllExcluded".into(), o.get("showAllExcluded").cloned().unwrap_or(json!(false)));
            options.push(Value::Object(out));
        }
        json!({ "sections": sections, "options": options })
    })
}

/// `BuildDisplayStats.lua`'s display stats (label, format, colour, flags), for stat comparisons in tooltips.
pub fn stat_meta() -> Value {
    serde_json::from_str(STAT_META_RAW).expect("stat_meta.json")
}

fn catalog_options() -> &'static Vec<Value> {
    config_catalog()["options"].as_array().expect("options")
}

// -------------------------------------------------------------------------------------------------------------------
// What the calculation used (`Calcs.lua` 448-590): conditions, multipliers, per-stat and mod names that some mod reads.

#[derive(Default)]
pub struct Used {
    pub skills: HashSet<String>,
    pub cond: HashSet<String>,
    pub minion_cond: HashSet<String>,
    pub enemy_cond: HashSet<String>,
    pub mult: HashSet<String>,
    pub enemy_mult: HashSet<String>,
    pub per_stat: HashSet<String>,
    pub enemy_per_stat: HashSet<String>,
    pub tag_types: HashSet<String>,
    pub mods: HashSet<String>,
}

fn str_of(v: &V) -> Option<&str> {
    if let V::Str(s) = v {
        Some(s)
    } else {
        None
    }
}

/// `tag.varList` or `tag.var` as names.
fn tag_names(tag: &pom_engine::modifier::Tag, list_key: &str, one_key: &str) -> Vec<String> {
    let list = tag.get(pom_engine::sym::Sym::new(list_key));
    if let V::List(l) = list {
        return l.iter().filter_map(|v| str_of(v).map(|s| s.to_string())).collect();
    }
    if let Some(s) = str_of(tag.get(pom_engine::sym::Sym::new(one_key))) {
        return vec![s.to_string()];
    }
    Vec::new()
}

/// `[fi][ig][rn][ei]` / `[cf][or][le][de]` anywhere in the lowercased name (Lua `match`, unanchored).
fn window_match(name: &str, sets: [&str; 4]) -> bool {
    let b: Vec<char> = name.to_lowercase().chars().collect();
    b.windows(4).any(|w| w.iter().zip(sets.iter()).all(|(c, set)| set.contains(*c)))
}

impl Used {
    fn add(set: &mut HashSet<String>, var: &str, m: &Mod) {
        // Base mods only describe other mods; they are not "used".
        if m.source.as_deref() == Some("Base") {
            return;
        }
        set.insert(var.to_string());
    }

    fn add_mod_tags(&mut self, player: bool, m: &Mod) {
        let name = m.name.as_str();
        Self::add(&mut self.mods, name, m);
        if window_match(name, ["fi", "ig", "rn", "ei"]) {
            for v in ["Ignited", "Burning"] {
                Self::add(&mut self.enemy_cond, v, m);
            }
        }
        if window_match(name, ["cf", "or", "le", "de"]) {
            Self::add(&mut self.enemy_cond, "Frozen", m);
        }
        for tag in m.tags.iter() {
            let kind = tag.kind.as_str();
            Self::add(&mut self.tag_types, kind, m);
            let actor = str_of(tag.get(pom_engine::sym::Sym::new("actor")));
            match kind {
                "IgnoreCond" => break,
                "Condition" => {
                    let target = if player { &mut self.cond } else { &mut self.minion_cond };
                    for v in tag_names(tag, "varList", "var") {
                        Self::add(target, &v, m);
                    }
                }
                "ActorCondition" => {
                    if let Some(var) = str_of(tag.get(pom_engine::sym::Sym::new("var"))) {
                        if actor == Some("enemy") {
                            Self::add(&mut self.enemy_cond, var, m);
                        } else {
                            Self::add(&mut self.cond, var, m);
                        }
                    }
                }
                "Multiplier" | "MultiplierThreshold" => {
                    if actor.is_none() {
                        if player {
                            for v in tag_names(tag, "varList", "var") {
                                Self::add(&mut self.mult, &v, m);
                            }
                        }
                    } else if actor == Some("enemy") {
                        for v in tag_names(tag, "varList", "var") {
                            Self::add(&mut self.enemy_mult, &v, m);
                        }
                    }
                }
                "PerStat" | "StatThreshold" => {
                    let stats = if matches!(tag.get(pom_engine::sym::Sym::new("varList")), V::List(_)) {
                        tag_names(tag, "statList", "stat_none")
                    } else {
                        tag_names(tag, "stat_none", "stat")
                    };
                    if actor.is_none() {
                        if player {
                            for v in &stats {
                                Self::add(&mut self.per_stat, v, m);
                            }
                        }
                    } else if actor == Some("enemy") {
                        for v in &stats {
                            Self::add(&mut self.enemy_per_stat, v, m);
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn add_enemy_mod(&mut self, m: &Mod) {
        for tag in m.tags.iter() {
            let kind = tag.kind.as_str();
            let actor = str_of(tag.get(pom_engine::sym::Sym::new("actor")));
            match kind {
                "IgnoreCond" => break,
                "Condition" => {
                    for v in tag_names(tag, "varList", "var") {
                        Self::add(&mut self.enemy_cond, &v, m);
                    }
                }
                "ActorCondition" => {
                    if let Some(var) = str_of(tag.get(pom_engine::sym::Sym::new("var"))) {
                        if actor == Some("enemy") || actor == Some("player") {
                            Self::add(&mut self.cond, var, m);
                        } else {
                            Self::add(&mut self.enemy_cond, var, m);
                        }
                    }
                }
                "Multiplier" | "MultiplierThreshold" => {
                    if actor.is_none() {
                        for v in tag_names(tag, "varList", "var") {
                            Self::add(&mut self.enemy_mult, &v, m);
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

fn all_mods<'a>(store: &'a pom_engine::modstore::store::ModStore, out: &mut Vec<&'a Mod>) {
    use pom_engine::modstore::store::Backing;
    match &store.backing {
        Backing::List(l) => out.extend(l.iter()),
        Backing::Db(m) => {
            for v in m.values() {
                out.extend(v.iter());
            }
        }
    }
}

pub fn collect_used(env: &Env) -> Used {
    let mut u = Used::default();
    for s in &env.active_skills {
        // `skillEffect.grantedEffect.name`: the effect's own name ("Vaal Molten Shell"), not the cfg's `skillName`.
        let own = pom_skills::data::all_skills().get(&s.granted_effect_id).and_then(|g| g.name.clone());
        u.skills.insert(own.unwrap_or_else(|| s.name.clone()));
        for &i in &s.effect_list {
            if let Some((ge, _, _)) = s.support_list.get(i) {
                if let Some(n) = &ge.name {
                    u.skills.insert(n.clone());
                }
            }
        }
    }
    u.skills.extend(env.minion_skill_ids.iter().cloned());
    let mut mods = Vec::new();
    all_mods(&env.player, &mut mods);
    for m in mods {
        u.add_mod_tags(true, m);
    }
    // Mods the engine keeps beside the player's store until they are merged (upstream's modDB holds them all).
    for m in env.parent_level_mods.iter().chain(env.aegis_mod_list.iter()).chain(env.weapon_mod_list1.iter()).chain(env.keystone_mods.iter().flatten()) {
        u.add_mod_tags(true, m);
    }
    // CalcActiveSkill.lua:805-830 moves a skill's `GlobalEffect` mods out of its mod list into its buff list, so the
    // `baseSkillModList` upstream scans no longer holds them.
    let global_effect = pom_engine::sym::Sym::new("GlobalEffect");
    // The moved mods reach the actor that carries the effect: buffs and auras the player's store, curses and debuffs
    // the enemy's, and only the curses actually applied (the enemy store, scanned below, holds exactly those).
    let effect_type = pom_engine::sym::Sym::new("effectType");
    let global = |m: &Mod| m.tags.iter().find(|t| t.kind == global_effect).map(|t| str_of(t.get(effect_type)).unwrap_or("").to_string());
    for s in &env.active_skills {
        for m in &s.skill_mod_list {
            match global(m).as_deref() {
                None => u.add_mod_tags(true, m),
                Some("Curse") | Some("Debuff") => {}
                Some(_) => u.add_mod_tags(true, m),
            }
        }
    }
    // The minion's own mods and its skills' (`addModTags(env.minion, mod)`): their conditions are the minion's.
    if let Some(mm) = &env.minion_mods {
        for m in mm {
            match global(m).as_deref() {
                None => u.add_mod_tags(false, m),
                Some("Curse") | Some("Debuff") => {}
                Some(_) => u.add_mod_tags(false, m),
            }
        }
    }
    let mut enemy = Vec::new();
    all_mods(&env.enemy, &mut enemy);
    for m in enemy {
        u.add_enemy_mod(m);
    }
    u
}

// -------------------------------------------------------------------------------------------------------------------
// Visibility (`Modules/ConfigVisibility.lua` isRelevantForBuild)

fn as_list(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect(),
        _ => Vec::new(),
    }
}

/// Lua truthiness of a stored input.
fn truthy(v: &Value) -> bool {
    !matches!(v, Value::Null | Value::Bool(false))
}

/// The main skill's finished state (`mainEnv.player.mainSkill`): its `skillFlags`, `skillModList` and `skillData`.
pub struct MainView {
    pub flags: HashSet<String>,
    pub skill_mod_list: pom_engine::modstore::store::ModStore,
    pub skill_data: HashSet<String>,
}

struct Facts<'a> {
    used: &'a Used,
    env: &'a Env,
    /// The active config set's inputs as JSON.
    input: &'a Map<String, Value>,
    main: Option<&'a MainView>,
    any_skill_flags: HashSet<String>,
    skill_data_keys: HashSet<String>,
}

fn relevant(o: &Value, f: &Facts) -> bool {
    let conds = &o["conditions"];
    let get = |k: &str| conds.get(k).map(as_list);
    let var = o.get("var").and_then(|v| v.as_str());
    let implied = || -> bool {
        let Some(var) = var else { return false };
        if !f.input.get(var).map(truthy).unwrap_or(false) {
            return false;
        }
        if let Some(list) = get("implyCondList") {
            if list.iter().any(|c| f.used.cond.contains(c)) {
                return true;
            }
        }
        get("implyCond").map(|l| l.iter().any(|c| f.used.cond.contains(c))).unwrap_or(false)
            || get("implyMinionCond").map(|l| l.iter().any(|c| f.used.minion_cond.contains(c))).unwrap_or(false)
            || get("implyEnemyCond").map(|l| l.iter().any(|c| f.used.enemy_cond.contains(c))).unwrap_or(false)
    };
    let simple: [(&str, &HashSet<String>); 8] = [
        ("ifCond", &f.used.cond),
        ("ifMinionCond", &f.used.minion_cond),
        ("ifEnemyCond", &f.used.enemy_cond),
        ("ifMult", &f.used.mult),
        ("ifEnemyMult", &f.used.enemy_mult),
        ("ifEnemyStat", &f.used.enemy_per_stat),
        ("ifTagType", &f.used.tag_types),
        ("ifMod", &f.used.mods),
    ];
    for (key, set) in simple {
        if let Some(list) = get(key) {
            if !list.iter().any(|opt| set.contains(opt) || implied()) {
                return false;
            }
        }
    }
    if let Some(list) = get("ifOption") {
        if !list.iter().any(|opt| f.input.get(opt).map(truthy).unwrap_or(false)) {
            return false;
        }
    }
    if let Some(list) = get("ifCondTrue") {
        let conditions = &f.env.player.conditions;
        if !list.iter().any(|opt| conditions.get(&pom_engine::sym::Sym::new(opt)).copied().unwrap_or(false)) {
            return false;
        }
    }
    if let Some(list) = get("ifStat") {
        if !list.iter().any(|opt| f.used.per_stat.contains(opt) || f.used.enemy_mult.contains(opt) || implied()) {
            return false;
        }
    }
    if let Some(list) = get("ifFlag") {
        let Some(main) = f.main else { return false };
        if !list.iter().any(|opt| main.flags.contains(opt) || main.skill_mod_list.flag(None, &[pom_engine::sym::Sym::new(opt)])) {
            return false;
        }
    }
    if let Some(list) = get("ifSkill") {
        let transfigured = conds.get("includeTransfigured").map(truthy).unwrap_or(false);
        let ok = if transfigured {
            list.iter().any(|opt| pom_skills::data::game_id_from_gem_name(opt, true).is_some() && f.used.skills.iter().any(|s| pom_skills::data::is_gem_id_same(s, opt)))
        } else {
            list.iter().any(|opt| f.used.skills.contains(opt))
        };
        if !ok {
            return false;
        }
    }
    if let Some(list) = get("ifSkillFlag") {
        if !list.iter().any(|opt| f.any_skill_flags.contains(opt)) {
            return false;
        }
    }
    if let Some(list) = get("ifSkillData") {
        if !list.iter().any(|opt| f.skill_data_keys.contains(opt)) {
            return false;
        }
    }
    // Our own condition (no upstream option uses it): the main skill is of the overlapping-explosion class.
    if conds.get("ifProjectileOverlap").is_some() && !crate::offence::select_main_skill(&f.env.xml_text, &f.env.active_skills).is_some_and(|m| crate::proj_overlap::is_class(&m.granted_effect_id, &m.skill_types)) {
        return false;
    }
    true
}

// -------------------------------------------------------------------------------------------------------------------
// State

#[derive(Default)]
struct SetRead {
    id: i64,
    title: String,
}

/// The config sets in file order, as `ConfigTab:Load` builds `configSetOrderList`, and the active set id.
fn sets_in_order(xml: &str) -> (Vec<SetRead>, i64) {
    let mut out = Vec::new();
    let mut active = 1;
    if let Ok(doc) = Document::parse(xml) {
        if let Some(cfg) = doc.root_element().children().find(|c| c.is_element() && c.tag_name().name() == "Config") {
            active = cfg.attribute("activeConfigSet").and_then(|s| s.parse().ok()).unwrap_or(1);
            for c in cfg.children().filter(|c| c.is_element() && c.tag_name().name() == "ConfigSet") {
                let id = c.attribute("id").and_then(|s| s.parse().ok()).unwrap_or(1);
                // A set listed twice keeps its first place and its last content (`configSets[id]` is overwritten).
                if !out.iter().any(|s: &SetRead| s.id == id) {
                    out.push(SetRead { id, title: c.attribute("title").unwrap_or("Default").to_string() });
                }
            }
        }
    }
    if out.is_empty() {
        out.push(SetRead { id: 1, title: "Default".into() });
    }
    if !out.iter().any(|s| s.id == active) {
        active = out[0].id;
    }
    (out, active)
}

fn ov_json(v: &pom_config::types::OwnedOptionValue) -> Value {
    use pom_config::types::OwnedOptionValue as O;
    match v {
        O::Bool(b) => json!(b),
        O::Num(n) => num_json(*n),
        O::Str(s) => json!(&**s),
    }
}

fn num_json(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// `ConfigTab:GetDefaultState` for one option, from the catalog and the set's placeholders.
fn default_of(o: &Value, placeholder: &HashMap<String, pom_config::types::OwnedOptionValue>) -> Value {
    let var = o["var"].as_str().unwrap_or("");
    if let Some(p) = placeholder.get(var) {
        return ov_json(p);
    }
    let ty = o["type"].as_str().unwrap_or("");
    match ty {
        "check" => o.get("defaultState").cloned().unwrap_or(json!(false)),
        "count" | "integer" | "countAllowZero" | "float" => o.get("defaultState").cloned().unwrap_or(json!(0)),
        "list" => {
            let idx = o.get("defaultIndex").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
            o["list"].get(idx.saturating_sub(1)).map(|e| e["val"].clone()).unwrap_or(Value::Null)
        }
        "text" => o.get("defaultState").cloned().unwrap_or(json!("")),
        _ => o.get("defaultState").cloned().unwrap_or(Value::Null),
    }
}

fn values_equal(a: &Value, b: &Value) -> bool {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) if a.is_number() && b.is_number() => x == y,
        _ => a == b,
    }
}

fn strip_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '^' {
            match chars.peek() {
                Some('x') | Some('X') => {
                    chars.next();
                    for _ in 0..6 {
                        chars.next();
                    }
                }
                Some(d) if d.is_ascii_digit() => {
                    chars.next();
                }
                _ => out.push(c),
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn fmt_lua_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// The `ConfigState` of `packages/protocol/src/tabs.ts` for a calculated build.
pub fn config_state(xml: &str, env: &Env, main: Option<MainView>, stats: &Map<String, Value>) -> Result<Value, String> {
    let data = pom_config::xml::parse_config(xml)?;
    let (order, active) = sets_in_order(xml);
    let opts = catalog_options();

    let empty = pom_config::xml::ConfigSet::default();
    let set_of = |id: i64| data.config_sets.get(&id).unwrap_or(&empty);

    let count_changed = |id: i64| -> usize {
        let set = set_of(id);
        let mut n = 0;
        for o in opts.iter() {
            let Some(var) = o.get("var").and_then(|v| v.as_str()) else { continue };
            let Some(cur) = set.input.get(var) else { continue };
            let def = default_of(o, &set.placeholder);
            if !values_equal(&ov_json(cur), &def) {
                n += 1;
            }
        }
        n + set.custom_mods.iter().filter(|b| b.enabled && !b.text.trim().is_empty()).count()
    };
    let sets: Vec<Value> = order.iter().map(|s| json!({ "id": s.id, "title": s.title, "changed": count_changed(s.id) })).collect();

    let set = set_of(active);
    let mut values = Map::new();
    let mut input_json = Map::new();
    for (k, v) in &set.input {
        input_json.insert(k.clone(), ov_json(v));
    }
    // Only the inputs that differ from their default are "set"; the defaults seeded by NewConfigSet are not.
    let mut defaults = Map::new();
    for o in opts.iter() {
        let Some(var) = o.get("var").and_then(|v| v.as_str()) else { continue };
        let def = default_of(o, &set.placeholder);
        if let Some(cur) = input_json.get(var) {
            if !values_equal(cur, &def) {
                values.insert(var.to_string(), cur.clone());
            }
        }
        defaults.insert(var.to_string(), def);
    }

    // The placeholders the calculation settled on (boss presets rewrite some).
    let mut placeholders = Map::new();
    for (k, v) in &env.config_placeholder {
        placeholders.insert(k.clone(), num_json(*v));
    }
    for (k, v) in &env.config_placeholder_str {
        placeholders.insert(k.clone(), json!(v));
    }

    // PoM's overlap option: an empty field means every projectile (crate::proj_overlap), so the field shows that count.
    if crate::offence::select_main_skill(&env.xml_text, &env.active_skills).is_some_and(|m| crate::proj_overlap::is_class(&m.granted_effect_id, &m.skill_types)) {
        placeholders.entry(crate::proj_overlap::VAR.to_string()).or_insert(num_json(env.output.get("ProjectileCount").copied().unwrap_or(1.0)));
    }

    let mut used = collect_used(env);
    // The second loop of Calcs.lua:553-560: every active skill's `skillModList` (the main skill's as offence left it,
    // with mods the offence pass adds, such as Point Blank's) counts for modsUsed and tagTypesUsed.
    {
        let mut finished: Vec<&Mod> = Vec::new();
        if let Some(m) = &main {
            all_mods(&m.skill_mod_list, &mut finished);
        }
        let from_lists = env.active_skills.iter().flat_map(|s| s.skill_mod_list.iter());
        let global_effect = pom_engine::sym::Sym::new("GlobalEffect");
        for m in finished.into_iter().chain(from_lists) {
            if m.tags.iter().any(|t| t.kind == global_effect) {
                continue;
            }
            Used::add(&mut used.mods, m.name.as_str(), m);
            for tag in m.tags.iter() {
                Used::add(&mut used.tag_types, tag.kind.as_str(), m);
            }
        }
    }
    // `SkillData` list mods (gem data such as explodeCorpse) of every active skill, and the main skill's final skillData.
    let mut skill_data_keys: HashSet<String> = main.as_ref().map(|m| m.skill_data.clone()).unwrap_or_default();
    // `skillModList:List(skillCfg, "SkillData")` per active skill (CalcActiveSkill.lua:664): the list's tags (a skill
    // part, a condition) decide which entries apply.
    let snapshot = crate::buffs::player_snapshot(&env.player);
    for s in &env.active_skills {
        let mut store = pom_engine::modstore::store::ModStore::new_list(Some(snapshot.clone()), env.player.actor.clone());
        for m in s.skill_mod_list.iter().filter(|m| m.name.as_str() == "SkillData") {
            store.add_mod(m.clone());
        }
        let cfg = crate::buffs::skill_cfg(s);
        for v in store.list(Some(&cfg), &[pom_engine::sym::Sym::new("SkillData")]) {
            let key = v.get(pom_engine::sym::Sym::new("key"));
            if let (Some(k), true) = (str_of(key), v.get(pom_engine::sym::Sym::new("value")).truthy()) {
                skill_data_keys.insert(k.to_string());
            }
        }
    }
    let mut any_skill_flags: HashSet<String> = HashSet::default();
    for s in &env.active_skills {
        any_skill_flags.extend(s.skill_flags.iter().cloned());
    }
    let facts = Facts { used: &used, env, input: &input_json, main: main.as_ref(), any_skill_flags, skill_data_keys };
    let mut shown = Map::new();
    for o in opts.iter() {
        let key = match o.get("var").and_then(|v| v.as_str()) {
            Some(v) => v.to_string(),
            None => format!("#{}", o["index"]),
        };
        shown.insert(key, json!(relevant(o, &facts)));
    }

    let mut dynamic = Map::new();
    let stat = |k: &str| stats.get(k).and_then(|v| v.as_f64());
    if let Some(low) = stat("LowLifePercentage") {
        dynamic.insert(
            "conditionLowLife".into(),
            json!(format!("You will automatically be considered to be on Low ^xE05030Life ^7if you have at least {}% ^xE05030Life ^7reserved\nbut you can use this option to force it if necessary.", fmt_lua_num(100.0 - low))),
        );
    }
    if let Some(full) = stat("FullLifePercentage") {
        dynamic.insert(
            "conditionFullLife".into(),
            json!(format!(
                "You can be considered to be on Full ^xE05030Life ^7if you have at least {}% ^xE05030Life ^7left.\nYou will automatically be considered to be on Full ^xE05030Life ^7if you have Chaos Inoculation,\nbut you can use this option to force it if necessary.",
                fmt_lua_num(full)
            )),
        );
    }

    let custom: Vec<Value> = set
        .custom_mods
        .iter()
        .map(|b| {
            let line_ok: Vec<bool> = b
                .text
                .split('\n')
                .map(|line| {
                    let stripped = strip_escapes(line).trim().to_string();
                    matches!(pom_engine::modparser::parse_mod(&stripped), (Some(_), None))
                })
                .collect();
            json!({ "title": b.title, "enabled": b.enabled, "text": b.text, "lineOk": line_ok })
        })
        .collect();

    Ok(json!({
        "sets": sets,
        "activeSet": active,
        "values": values,
        "placeholders": placeholders,
        "defaults": defaults,
        "shown": shown,
        "dynamicTooltips": dynamic,
        "customMods": custom,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_every_option() {
        let c = config_catalog();
        assert_eq!(c["sections"].as_array().unwrap().len(), 7);
        let vars = c["options"].as_array().unwrap().iter().filter(|o| o.get("var").is_some()).count();
        assert_eq!(vars, 586);
        assert!(c["options"].as_array().unwrap().iter().any(|o| o["var"] == "enemyIsBoss" && o["list"].as_array().unwrap().len() == 4));
    }

    /// Compares `shown` with what upstream's `ConfigVisibility.isRelevantForBuild` said for the same builds
    /// `POM_SHOWN_LIST` is the build list upstream was run on, `POM_SHOWN_RECORDED` its recorded output.
    #[test]
    #[ignore]
    fn shown_matches_upstream() {
        let (Ok(list), Ok(recorded)) = (std::env::var("POM_SHOWN_LIST"), std::env::var("POM_SHOWN_RECORDED")) else { return };
        let paths: Vec<String> = std::fs::read_to_string(list).unwrap().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
        let by_name: HashMap<String, String> = paths.iter().map(|p| (p.rsplit(['/', '\\']).next().unwrap().trim_end_matches(".xml").to_string(), p.clone())).collect();
        let mut total = 0usize;
        let mut wrong = 0usize;
        let mut per_var: std::collections::BTreeMap<String, (usize, usize)> = Default::default();
        for line in std::fs::read_to_string(recorded).unwrap().lines() {
            let o: Value = serde_json::from_str(line).unwrap();
            let name = o["build"].as_str().unwrap();
            if std::env::var("SHOWN_ONLY").map(|o| o != name).unwrap_or(false) {
                continue;
            }
            let xml = std::fs::read_to_string(&by_name[name]).unwrap();
            let mut session = crate::session::Session::new(xml.clone(), pom_calc::data::game_data());
            let Ok(first) = session.calc() else {
                eprintln!("SKIP {name}: engine cannot calculate it");
                continue;
            };
            let stats = first.stats["player"].as_object().cloned().unwrap_or_default();
            let state = session.inspect_main(|env, main| config_state(&xml, env, main, &stats)).unwrap().unwrap();
            for (k, want) in o["shown"].as_object().unwrap() {
                let got = state["shown"][k].as_bool().unwrap_or(false);
                total += 1;
                let e = per_var.entry(k.clone()).or_default();
                e.0 += 1;
                if got != want.as_bool().unwrap() {
                    wrong += 1;
                    e.1 += 1;
                    eprintln!("MISMATCH {name} {k}: engine {got}, original {want}");
                }
            }
        }
        let bad: Vec<_> = per_var.iter().filter(|(_, v)| v.1 > 0).map(|(k, v)| format!("{k}:{}", v.1)).collect();
        eprintln!("shown agreement: {} of {} ({} wrong); vars with a mismatch: {}", total - wrong, total, wrong, bad.join(" "));
        assert_eq!(wrong, 0);
    }
}

