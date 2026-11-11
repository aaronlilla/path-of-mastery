//! Offline combo finder. `pom-cli synergy-scan <out>`
//! probes the engine with pairs of parts (keystones, rule-changing ascendancy notables, unique mechanic lines, supports,
//! and the sensitivity axes) on fixed reference states, one per skill archetype and play mode, and writes the pairs
//! whose joint effect beats the sum of their separate effects (and the ones that cancel) to engine-data/synergies.json.
//! Everything is keyed by the parts' parsed mods, never by a name, so the file is rebuilt per patch by running the scan
//! again. The solver reads it for dead lines under a keystone (solver_parts.rs) and for combo leads (solver_leads.rs).

use super::items::{slot_types, SlotKind, UniqueInfo};
use super::sens::{top_roll, SkillTags, AXES};
use super::*;
use std::sync::OnceLock;

// ---------------------------------------------------------------------------------------------------------------
// Identity: what a part is, by its parsed mods

/// One parsed mod as `TYPE:Name` (a list mod's inner mod as `>Inner`), with its condition or multiplier variables
/// (`@Var`). Numbers are left out: a patch that changes a roll keeps the id.
fn mod_id(m: &pom_engine::modparser::types::PMod) -> String {
    use pom_engine::modparser::types::PVal;
    let mut s = format!("{}:{}", m.ty, m.name);
    if let PVal::Map(kv) = &m.value {
        if let Some((_, PVal::Map(inner))) = kv.iter().find(|(k, _)| k == "mod") {
            if let Some((_, PVal::Str(n))) = inner.iter().find(|(k, _)| k == "name") {
                s.push('>');
                s.push_str(n);
            }
        }
    }
    for t in &m.tags {
        if let PVal::Map(kv) = t {
            for (k, v) in kv {
                if let (true, PVal::Str(var)) = (k == "var" || k == "actor", v) {
                    s.push('@');
                    s.push_str(var);
                }
            }
        }
    }
    s
}

/// A part's identity: its fully parsed lines' mod ids, sorted and deduped, joined with `+`. None when no line parses.
pub(super) fn mod_key<S: AsRef<str>>(lines: &[S]) -> Option<String> {
    let mut v: Vec<String> = Vec::new();
    for l in lines {
        if let (Some(mods), None) = pom_engine::modparser::parse_mod(l.as_ref()) {
            v.extend(mods.iter().map(mod_id));
        }
    }
    v.sort_unstable();
    v.dedup();
    (!v.is_empty()).then(|| v.join("+"))
}

/// Mod names of one line (`#` read as 10), when the parser reads any of it.
fn line_mod_names(line: &str) -> Option<Vec<String>> {
    let l = line.replace('#', "10");
    match pom_engine::modparser::parse_mod(&l) {
        (Some(mods), _) if !mods.is_empty() => Some(mods.iter().map(|m| m.name.clone()).collect()),
        _ => None,
    }
}

/// The words of a key's mod names and variables (CamelCase split, lowercase), without the ones every mod shares.
fn referents(key: &str) -> HashSet<String> {
    const STOP: &[&str] = &["damage", "base", "inc", "more", "flag", "list", "override", "chance", "per", "from", "with", "to", "of", "the", "taken", "increased", "maximum", "max", "min", "multiplier", "condition", "skill", "skills", "effect", "rate", "on", "you", "have", "is", "while", "all", "total", "global", "mod", "modifier"];
    let mut out = HashSet::default();
    for part in key.split(['+', ':', '>', '@']) {
        let mut w = String::new();
        let mut push = |w: &mut String| {
            let x = w.to_lowercase();
            if x.len() >= 3 && !STOP.contains(&x.as_str()) && !x.chars().all(|c| c.is_ascii_uppercase()) {
                out.insert(x);
            }
            w.clear();
        };
        for c in part.chars() {
            if c.is_ascii_uppercase() && !w.is_empty() {
                push(&mut w);
            }
            if c.is_alphanumeric() {
                w.push(c);
            } else {
                push(&mut w);
            }
        }
        push(&mut w);
    }
    out
}

/// The condition variables a key's mods read (`@Var`).
fn cond_vars(key: &str) -> Vec<&str> {
    key.split('+').flat_map(|m| m.split('@').skip(1)).collect()
}

/// Words that say what the main skill is and deals: its true tags, its stat ids' words, the damage an attack deals
/// (physical) and each damage type's own ailment.
fn skill_words(gem: &str) -> HashSet<String> {
    let mut w: HashSet<String> = HashSet::default();
    let Some(g) = gd::game_data().gems.get(gem) else { return w };
    w.extend(g.tags.iter().filter(|(_, &on)| on).map(|(t, _)| t.to_lowercase()));
    if let Some(ge) = gd::gem_primary_effect(g) {
        w.extend(ge.stats.iter().flat_map(|s| s.split('_')).filter(|x| x.len() >= 4).map(|x| x.to_lowercase()));
    }
    if w.contains("attack") {
        w.insert("physical".into());
    }
    for (d, a) in [("physical", "bleed"), ("fire", "ignite"), ("cold", "chill"), ("cold", "freeze"), ("lightning", "shock"), ("chaos", "poison")] {
        if w.contains(d) {
            w.insert(a.into());
        }
    }
    w
}

/// Whether a part's key speaks to the main skill: one of its referents shares a stem (4+ letters) with `skill_words`.
fn fits_skill(words: &HashSet<String>, key: &str) -> bool {
    referents(key).iter().any(|r| r.len() >= 4 && words.iter().any(|w| w.len() >= 4 && (w.starts_with(r.as_str()) || r.starts_with(w.as_str()))))
}

// ---------------------------------------------------------------------------------------------------------------
// Parts the scan probes

#[derive(Clone, Debug)]
pub(super) struct Hub {
    /// "keystone" | "asc" | "unique" | "support"
    pub kind: &'static str,
    pub key: String,
    /// What a person calls it today (shown, never matched).
    pub label: String,
    /// The lines the probe adds (none for a support: it goes in the main link).
    pub probe: Vec<String>,
    pub support: Option<&'static str>,
}

/// Whether a line changes a rule, read from its parsed mods: a flag, an override, a
/// conversion, a damage-taken redirect or a granted keystone.
fn rule_line(l: &str) -> bool {
    matches!(pom_engine::modparser::parse_mod(l), (Some(m), None) if m.iter().any(|m| m.ty == "FLAG" || m.ty == "OVERRIDE" || m.name == "Keystone" || ["Convert", "Instead", "TakenFrom"].iter().any(|w| m.name.contains(w))))
}

fn node_lines(tree: &pom_passives::treedata::TreeData, n: pom_engine::cjson::J) -> Vec<String> {
    n.get("stats").map(|v| pom_passives::treedata::str_list(tree.deref(v)).iter().map(|l| top_roll(l)).collect()).unwrap_or_default()
}

fn full(l: &str) -> bool {
    matches!(pom_engine::modparser::parse_mod(l), (Some(_), None))
}

/// Keystones (the tree's and the timeless-only ones) and rule-changing ascendancy notables, with each tree node's key.
fn tree_hubs() -> &'static (Vec<Hub>, HashMap<String, Vec<i64>>) {
    static T: OnceLock<(Vec<Hub>, HashMap<String, Vec<i64>>)> = OnceLock::new();
    T.get_or_init(|| {
        let mut hubs: Vec<Hub> = Vec::new();
        let mut ids: HashMap<String, Vec<i64>> = HashMap::default();
        let Ok(tree) = crate::cached_tree("3_29") else { return (hubs, ids) };
        let mut nodes: Vec<(i64, pom_engine::cjson::J)> = tree.nodes.iter().map(|(k, v)| (*k, *v)).collect();
        nodes.sort_by_key(|x| x.0);
        let mut seen: HashSet<String> = HashSet::default();
        for (id, n) in nodes {
            let ty = n.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let asc = n.get("ascendancyName").and_then(|a| a.as_str()).is_some_and(|a| !a.is_empty());
            let notable = n.get("isNotable").and_then(|b| b.as_bool()).unwrap_or(false);
            if ty != "Keystone" && !(asc && notable) {
                continue;
            }
            let lines = node_lines(tree, n);
            let Some(key) = mod_key(&lines) else { continue };
            ids.entry(key.clone()).or_default().push(id);
            let name = n.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let kind = if ty == "Keystone" { "keystone" } else { "asc" };
            if kind == "asc" && !lines.iter().any(|l| rule_line(l)) {
                continue;
            }
            // (a keystone is probed whole by its name line when some of its lines do not parse: the engine grants the
            // keystone's mods from it)
            let probe = if lines.iter().all(|l| full(l)) || kind == "asc" || !full(&name) { lines.iter().filter(|l| full(l)).cloned().collect() } else { vec![name.clone()] };
            if probe.is_empty() || !seen.insert(key.clone()) {
                continue;
            }
            hubs.push(Hub { kind, key, label: name, probe, support: None });
        }
        // timeless-only keystones (keystoneMap entries that are not tree nodes)
        if let Some(km) = tree.root.get("keystoneMap") {
            let mut names: Vec<String> = km.as_object().map(|o| o.keys().map(|k| k.to_string()).collect()).unwrap_or_default();
            names.sort();
            for name in names {
                let Some(n) = km.get(name.as_str()).map(|v| tree.deref(v)) else { continue };
                let lines = node_lines(tree, n);
                let Some(key) = mod_key(&lines) else { continue };
                if !seen.insert(key.clone()) {
                    continue;
                }
                let probe = if lines.iter().all(|l| full(l)) || !full(&name) { lines.iter().filter(|l| full(l)).cloned().collect() } else { vec![name.clone()] };
                if !probe.is_empty() {
                    hubs.push(Hub { kind: "keystone", key, label: name, probe, support: None });
                }
            }
        }
        (hubs, ids)
    })
}

/// A unique's full mod set as the current variant rolls it (top rolls, drawbacks included): its fully parsed lines,
/// or none when no line sets a flag or grants a keystone (no rule changer, no hub).
fn mechanic_lines(raw: &str) -> Vec<String> {
    let current = raw.lines().filter(|l| l.starts_with("Variant:")).count();
    let mut out: Vec<String> = Vec::new();
    let mut rule = false;
    for l in raw.lines().skip(2) {
        if l.contains(": ") && !l.starts_with('{') || l.ends_with(':') {
            continue;
        }
        // (a line of older variants only is left out)
        if let Some(v) = l.strip_prefix("{variant:").and_then(|r| r.split('}').next()) {
            if current > 0 && !v.split(',').any(|x| x.trim().parse::<usize>() == Ok(current)) {
                continue;
            }
        }
        let l = top_roll(l);
        if let (Some(mods), None) = pom_engine::modparser::parse_mod(&l) {
            rule |= mods.iter().any(|m| m.ty == "FLAG" || m.name == "Keystone");
            if !out.contains(&l) {
                out.push(l);
            }
        }
    }
    if rule {
        out
    } else {
        Vec::new()
    }
}

/// Unique hubs from the unique data: one hub per distinct key (its whole mod set), and every unique name per key.
fn unique_hubs() -> &'static (Vec<Hub>, HashMap<String, Vec<String>>) {
    static U: OnceLock<(Vec<Hub>, HashMap<String, Vec<String>>)> = OnceLock::new();
    U.get_or_init(|| {
        let mut hubs = Vec::new();
        let mut names: HashMap<String, Vec<String>> = HashMap::default();
        let game = pom_calc::data::game_data();
        let Some(groups) = game.extra.get("uniques").ok().flatten().and_then(|u| u.as_object()) else { return (hubs, names) };
        let mut seen: HashSet<String> = HashSet::default();
        let mut all: Vec<(String, String)> = Vec::new();
        for (group, list) in groups.iter() {
            if group == "race" || group == "new" || group == "generated" {
                continue;
            }
            for raw in list.as_array().into_iter().flat_map(|a| a.iter()).filter_map(|r| r.as_str()) {
                let name = raw.lines().next().unwrap_or("").to_string();
                all.push((name, raw.to_string()));
            }
        }
        all.sort();
        for (name, raw) in all {
            let lines = mechanic_lines(&raw);
            let Some(key) = mod_key(&lines) else { continue };
            names.entry(key.clone()).or_default().push(name.clone());
            if seen.insert(key.clone()) {
                hubs.push(Hub { kind: "unique", key, label: name, probe: lines, support: None });
            }
        }
        (hubs, names)
    })
}

/// A support gem's key: its granted effect's stat ids.
fn support_key(id: &str) -> Option<String> {
    let ge = gd::game_data().gems.get(id).and_then(gd::gem_primary_effect)?;
    let mut s: Vec<&str> = ge.stats.iter().map(|x| x.as_str()).collect();
    if s.is_empty() {
        return ge.id.as_ref().map(|i| format!("GEM:{i}"));
    }
    s.sort_unstable();
    s.dedup();
    Some(format!("GEM:{}", s.join("+")))
}

// ---------------------------------------------------------------------------------------------------------------
// Axes: the sensitivity axes plus the defence and sustain ones the combos need

#[derive(Clone)]
pub(super) struct Ax {
    pub label: String,
    pub key: String,
    pub unit: Vec<String>,
    pub commit: Vec<String>,
    pub when: fn(&SkillTags) -> bool,
}

fn any(_: &SkillTags) -> bool {
    true
}
fn atk(t: &SkillTags) -> bool {
    t.attack
}
fn hit(t: &SkillTags) -> bool {
    t.attack || t.spell
}
fn mnn(t: &SkillTags) -> bool {
    t.minion
}

/// (label, unit, commit, gate): the defence and sustain axes, and an increase per damage type
/// (the dead-line test needs every damage type's own increase, not only its added flat).
const EXTRA: &[(&str, &str, &str, fn(&SkillTags) -> bool)] = &[
    ("mana", "+300 to maximum Mana", "+1500 to maximum Mana", any),
    ("mana before life", "10% of Damage is taken from Mana before Life", "40% of Damage is taken from Mana before Life", any),
    ("spell suppression", "+20% chance to Suppress Spell Damage", "+100% chance to Suppress Spell Damage", any),
    ("life leech", "1% of Damage Leeched as Life", "5% of Damage Leeched as Life", hit),
    ("life regen", "Regenerate 1% of Life per second", "Regenerate 5% of Life per second", any),
    ("energy shield regen", "Regenerate 1% of Energy Shield per second", "Regenerate 5% of Energy Shield per second", any),
    ("accuracy", "+500 to Accuracy Rating", "+3000 to Accuracy Rating", atk),
    ("spell block", "+10% Chance to Block Spell Damage", "+40% Chance to Block Spell Damage", any),
    ("physical reduction", "5% additional Physical Damage Reduction", "20% additional Physical Damage Reduction", any),
    ("chaos resistance", "+20% to Chaos Resistance", "+75% to Chaos Resistance", any),
    ("max resistances", "+1% to all maximum Elemental Resistances", "+4% to all maximum Elemental Resistances", any),
    ("minion life", "Minions have 30% increased maximum Life", "Minions have 150% increased maximum Life", mnn),
    ("totems", "+1 to maximum number of Summoned Totems", "+3 to maximum number of Summoned Totems", any),
    ("increased physical", "40% increased Physical Damage", "200% increased Physical Damage", any),
    ("increased fire", "40% increased Fire Damage", "200% increased Fire Damage", any),
    ("increased cold", "40% increased Cold Damage", "200% increased Cold Damage", any),
    ("increased lightning", "40% increased Lightning Damage", "200% increased Lightning Damage", any),
    ("increased chaos", "40% increased Chaos Damage", "200% increased Chaos Damage", any),
];

fn axes() -> &'static Vec<Ax> {
    static A: OnceLock<Vec<Ax>> = OnceLock::new();
    A.get_or_init(|| {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let mut out: Vec<Ax> = AXES.iter().filter(|a| a.pair.is_empty()).map(|a| Ax { label: a.name.to_string(), key: String::new(), unit: s(a.unit), commit: s(a.commit), when: a.when }).collect();
        out.extend(EXTRA.iter().filter(|e| full(e.1) && full(e.2)).map(|e| Ax { label: e.0.to_string(), key: String::new(), unit: vec![e.1.to_string()], commit: vec![e.2.to_string()], when: e.3 }));
        for a in out.iter_mut() {
            a.key = mod_key(&a.commit).unwrap_or_else(|| format!("AXIS:{}", a.label));
        }
        let mut seen: HashSet<String> = HashSet::default();
        out.retain(|a| seen.insert(a.key.clone()));
        out
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Reference states

/// (id, archetype, preferred skill, play mode). The base's skill is picked by tag (`ref_skill`): the preferred one
/// while the game data still files it under the archetype, else the first such skill by name.
const BASES: &[(&str, &str, &str, &str)] = &[
    ("melee-map", "melee", "Boneshatter", "mapping"),
    ("melee-boss", "melee", "Boneshatter", "bossing"),
    ("projectile-map", "projectile", "Tornado Shot", "mapping"),
    ("projectile-boss", "projectile", "Tornado Shot", "bossing"),
    ("spell-map", "spell", "Arc", "mapping"),
    ("spell-boss", "spell", "Arc", "bossing"),
    ("minion-map", "minion", "Raise Zombie", "mapping"),
    ("minion-boss", "minion", "Raise Zombie", "bossing"),
    ("dot-map", "dot", "Essence Drain", "mapping"),
    ("dot-boss", "dot", "Essence Drain", "bossing"),
    ("totem-map", "totem", "Holy Flame Totem", "mapping"),
    ("totem-boss", "totem", "Holy Flame Totem", "bossing"),
];

/// The skill a base stands on: an active, non-Vaal gem whose tags (`archetypes_of`) put it under `archetype` (and
/// under nothing else for a single-archetype one), the preferred one when it qualifies. Err: no gem qualifies.
fn ref_skill(archetype: &str, preferred: &str) -> Result<String, String> {
    let mut v: Vec<String> = gd::game_data()
        .gems
        .iter()
        .filter(|(_, g)| !g.vaal_gem && g.tags.get("grants_active_skill").copied().unwrap_or(false) && !g.tags.get("support").copied().unwrap_or(false))
        .filter_map(|(id, g)| {
            let a = archetypes_of(id);
            (a.contains(&archetype) && (a.len() == 1 || archetype == "dot")).then(|| g.name.clone()).flatten()
        })
        .collect();
    v.sort();
    if v.iter().any(|n| n == preferred) {
        return Ok(preferred.to_string());
    }
    v.into_iter().next().ok_or_else(|| format!("no skill in the game data is tagged {archetype}"))
}

/// The archetypes a main skill counts as (a pair found on one of them is offered to it).
pub(super) fn archetypes_of(gem: &str) -> Vec<&'static str> {
    let Some(g) = gd::game_data().gems.get(gem) else { return Vec::new() };
    let t = |k: &str| g.tags.get(k).copied().unwrap_or(false);
    if t("minion") {
        return vec!["minion"];
    }
    if t("totem") || t("trap") || t("mine") {
        return vec!["totem"];
    }
    let mut v = Vec::new();
    if t("attack") && t("melee") {
        v.push("melee");
    }
    if t("attack") && t("projectile") {
        v.push("projectile");
    }
    if t("spell") {
        v.push("spell");
    }
    if gd::gem_primary_effect(g).is_some_and(|ge| gd::skill_types(ge).contains(&pom_skills::skill_type::DAMAGE_OVER_TIME)) {
        v.push("dot");
    }
    v
}

/// Outputs a dead line must leave unchanged besides the score (read after the scorer's own).
const DEAD_OUTS: &[&str] = &["CritChance", "CritMultiplier", "EnergyShield", "Life", "Mana", "Accuracy", "HitChance", "AverageHit", "TotalDPS", "CombinedDPS", "TotalDotDPS", "Armour", "Evasion", CRIT_RECENT];

/// The base's goal on `threads` workers; the probe solver also reads `DEAD_OUTS`.
fn ref_solver(skill: &str, mode: &str, threads: usize) -> Result<Solver, String> {
    let goal = json!({
        "skill": skill, "level": 90,
        "targets": [{"name": "DPS", "metric": "combined"}, {"name": "EHP", "metric": "ehp"}],
        "limits": {"resists": 75, "pool": 3000, "attributes": true, "reservation": true, "warnings": true, "cost": true},
        "assume": {"playMode": mode, "flaskUptime": mode}
    });
    let goal: Goal = serde_json::from_value(goal).map_err(|e| e.to_string())?;
    // (an eval budget, not the clock: the same data builds the same base on a busy machine)
    let opts = Options { time_budget_ms: Some(600_000), max_evals: Some(400_000), threads: Some(threads), seed: None };
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false)))?;
    s.names = Arc::new(s.names.iter().cloned().chain(DEAD_OUTS.iter().map(|x| x.to_string())).collect());
    Ok(s)
}

/// The base state, built on one worker: the buff blend reuses one evaluation's ratio for the next within a batch, so
/// more workers can build a different base from the same data.
fn base_solver(skill: &str, mode: &str) -> Result<(Solver, State), String> {
    let mut s = ref_solver(skill, mode, 1)?;
    let ci = *s.candidates()?.first().ok_or("no class for the skill")?;
    let mut st = s.initial_state(ci, None, None)?;
    s.gem_layer(&mut st, false)?;
    s.items_layer(&mut st, false)?;
    // (no buff with an uptime: its on/off blend reuses one probe's ratio for the next, which reads as a synergy)
    st.utils.retain(|u| buff_uptime(u).is_none());
    s.rebase(&mut st)?;
    Ok((s, st))
}

const MARK: &str = "<!--k5probe-->";

fn block(lines: &[String]) -> String {
    if lines.is_empty() {
        return String::new();
    }
    format!("<CustomModifierBlock title=\"probe\" enabled=\"true\" partial=\"true\">{}</CustomModifierBlock>", crate::edit::esc_text(&lines.join("\n")))
}

/// The goal's score with every limit off: what the engine's numbers give, so a limit's fixed penalty never reads as a
/// synergy.
fn pure_score(s: &Solver, v: &[Option<f64>]) -> f64 {
    let (x, viol) = s.score(v);
    x + s.scorer.penalty * viol
}

/// Scores (`pure_score`) of probes on one base, each with its `DEAD_OUTS` values: `variant`
/// picks the base text (0) or a support's (k), `lines` the probe block. NaN where the engine gave nothing.
fn run_probes(s: &Solver, texts: &[String], probes: &[(usize, Vec<String>)], done: &mut u64, t0: Instant, label: &str) -> Vec<(f64, Vec<Option<f64>>)> {
    let mut out = Vec::with_capacity(probes.len());
    let mut last = Instant::now();
    let extra = s.names.len() - DEAD_OUTS.len();
    for chunk in probes.chunks(256) {
        let cands: Vec<Cand> = chunk.iter().map(|(v, l)| Cand::Xml(Arc::new(texts[*v].replacen(MARK, &block(l), 1)))).collect();
        let r = s.eval(cands);
        out.extend(r.iter().map(|v| v.as_ref().map_or((f64::NAN, Vec::new()), |v| (pure_score(s, &v[..extra]), v[extra..].to_vec()))));
        *done += chunk.len() as u64;
        if last.elapsed().as_secs() >= 30 {
            last = Instant::now();
            let secs = t0.elapsed().as_secs_f64();
            eprintln!("synergy-scan {label}: {done} evals, {:.0}/s, {secs:.0} s", *done as f64 / secs);
        }
    }
    out
}

/// Gain-test thresholds (tuning guesses).
const SOLO_SMALL: f64 = 0.02;
const JOINT_BIG: f64 = 0.10;
const SYN: f64 = 0.10;
/// A solo gain under this (95% of the score gone) means the part breaks this base.
const BROKEN: f64 = -3.0;

fn class_of(ga: f64, gb: f64, j: f64) -> Option<&'static str> {
    let s = j - ga - gb;
    if s <= -SYN {
        Some("conflict")
    } else if ga.max(gb) <= SOLO_SMALL && j >= JOINT_BIG {
        Some("unlock")
    } else if s >= SYN {
        Some("amplify")
    } else {
        None
    }
}

/// One measured pair on one base.
#[derive(Clone, Debug)]
struct Rec {
    a: String,
    b: String,
    class: &'static str,
    ga: f64,
    gb: f64,
    j: f64,
}

/// Scan options: `quick` = one base (spell, bossing), keystones only, a handful of axes (tests).
pub struct ScanOpts {
    pub quick: bool,
    pub threads: usize,
}

/// Everything one base gave: its score, pairs, and for each keystone hub the axes dead and alive under it.
struct BaseOut {
    id: String,
    archetype: String,
    mode: String,
    skill: String,
    score0: f64,
    recs: Vec<Rec>,
    /// (hub key, axis index, dead) for every keystone x axis with a solo gain worth testing.
    dead: Vec<(String, usize, bool)>,
}

fn scan_base(id: &str, archetype: &str, skill: &str, mode: &str, o: &ScanOpts, done: &mut u64, t0: Instant) -> Result<BaseOut, String> {
    let tb = Instant::now();
    let (s, st) = base_solver(skill, mode)?;
    let ev = ref_solver(skill, mode, o.threads)?;
    eprintln!("synergy-scan {id}: {skill} base built in {:.0} s", tb.elapsed().as_secs_f64());
    let tags = SkillTags::of(s.main_gem);
    let ax: Vec<usize> = (0..axes().len()).filter(|&i| (axes()[i].when)(&tags)).filter(|&i| !o.quick || ["mana", "mana before life", "energy shield", "life", "crit multiplier", "base crit chance"].contains(&axes()[i].label.as_str())).collect();
    let mut hubs: Vec<Hub> = tree_hubs().0.iter().filter(|h| !o.quick || h.kind == "keystone").cloned().collect();
    if !o.quick {
        hubs.extend(unique_hubs().0.iter().cloned());
        let tag = |id: &str, t: &str| gd::game_data().gems.get(id).is_some_and(|g| g.tags.get(t).copied().unwrap_or(false));
        let delivery = |id: &str| ["trigger", "trap", "mine", "totem"].iter().any(|t| tag(id, t) && !tag(s.main_gem, t));
        let mut seen: HashSet<String> = HashSet::default();
        for g in s.gems.iter().filter(|g| g.kind == Kind::Support && g.id != s.main_gem && !delivery(g.id) && support_fits(g.id, s.main_gem) && !st.main.contains(&g.id)) {
            if let Some(key) = support_key(g.id).filter(|k| seen.insert(k.clone())) {
                hubs.push(Hub { kind: "support", key, label: g.name.clone(), probe: Vec::new(), support: Some(g.id) });
            }
        }
    }
    // base texts: the base, then the base with each support in the main link
    let mut texts = vec![s.render_with(&st, MARK)?];
    let mut variant = vec![0usize; hubs.len()];
    for (k, h) in hubs.iter().enumerate() {
        if let Some(g) = h.support {
            if s.mana_clash(&st.main.iter().copied().chain([g]).collect::<Vec<_>>()) {
                continue;
            }
            texts.push(s.render_with(&State { main: st.main.iter().copied().chain([g]).collect(), ..st.clone() }, MARK)?);
            variant[k] = texts.len() - 1;
        }
    }
    // a support that could not join the link is left out
    let keep: Vec<usize> = (0..hubs.len()).filter(|&k| hubs[k].support.is_none() || variant[k] > 0).collect();
    let hubs: Vec<Hub> = keep.iter().map(|&k| hubs[k].clone()).collect();
    let variant: Vec<usize> = keep.iter().map(|&k| variant[k]).collect();
    let label = id.to_string();

    // solo: base, each hub, each axis at commit and unit
    let mut probes: Vec<(usize, Vec<String>)> = vec![(0, Vec::new())];
    probes.extend(hubs.iter().enumerate().map(|(k, h)| (variant[k], h.probe.clone())));
    probes.extend(ax.iter().map(|&i| (0, axes()[i].commit.clone())));
    probes.extend(ax.iter().map(|&i| (0, axes()[i].unit.clone())));
    let r = run_probes(&ev, &texts, &probes, done, t0, &label);
    let s0 = r[0].0;
    if !s0.is_finite() {
        return Err(format!("{id}: the base did not evaluate"));
    }
    let nh = hubs.len();
    let gh: Vec<f64> = r[1..1 + nh].iter().map(|x| x.0 - s0).collect();
    let oh: Vec<Vec<Option<f64>>> = r[1..1 + nh].iter().map(|x| x.1.clone()).collect();
    let gc: Vec<f64> = r[1 + nh..1 + nh + ax.len()].iter().map(|x| x.0 - s0).collect();
    let gu: Vec<f64> = r[1 + nh + ax.len()..].iter().map(|x| x.0 - s0).collect();

    // joint: hub x axis (commit), then hub x hub for keystones with a shared referent
    // (a hub that alone breaks the build, such as a damage type the skill cannot deal, says nothing about pairs)
    let live: Vec<usize> = (0..nh).filter(|&k| gh[k].is_finite() && gh[k] > BROKEN).collect();
    let mut jp: Vec<(usize, usize)> = Vec::new();
    let mut probes: Vec<(usize, Vec<String>)> = Vec::new();
    for &k in &live {
        for (a, &i) in ax.iter().enumerate() {
            if gc[a].is_finite() {
                jp.push((k, a));
                probes.push((variant[k], hubs[k].probe.iter().chain(&axes()[i].commit).cloned().collect()));
            }
        }
    }
    let nja = probes.len();
    let refs: Vec<HashSet<String>> = hubs.iter().map(|h| referents(&h.key)).collect();
    let mut hh: Vec<(usize, usize)> = Vec::new();
    for (x, &k) in live.iter().enumerate() {
        for &m in &live[x + 1..] {
            let (hk, hm) = (&hubs[k], &hubs[m]);
            // (a support pairs with a keystone in the support's link; two supports are not tried)
            if (hk.support.is_some() && hm.support.is_some()) || (hk.kind != "keystone" && hm.kind != "keystone") || refs[k].is_disjoint(&refs[m]) {
                continue;
            }
            hh.push((k, m));
            probes.push((variant[k].max(variant[m]), hk.probe.iter().chain(&hm.probe).cloned().collect()));
        }
    }
    eprintln!("synergy-scan {id}: {} hubs, {} axes, {} hub x axis, {} hub x hub", nh, ax.len(), nja, hh.len());
    let r = run_probes(&ev, &texts, &probes, done, t0, &label);
    let mut recs: Vec<Rec> = Vec::new();
    let mut dead: Vec<(String, usize, bool)> = Vec::new();
    // hub x axis: classes need the sign at unit size too
    let mut unit_q: Vec<(usize, usize, f64)> = Vec::new();
    let cr = DEAD_OUTS.iter().position(|x| *x == CRIT_RECENT).unwrap();
    for (n, &(k, a)) in jp.iter().enumerate() {
        let j = r[n].0 - s0;
        if !j.is_finite() {
            continue;
        }
        let under = j - gh[k];
        // Dead: the engine zeroes the axis under the keystone (score and every `DEAD_OUTS` value unchanged), judged
        // only where the keystone's enabling conditions are not assumed true (such as "crit recently" on a crit base).
        let assumed = cond_vars(&hubs[k].key).iter().any(|v| texts[0].contains(&format!("name=\"condition{v}\" boolean=\"true\"")) || (v.contains("Crit") && r[n].1.get(cr).copied().flatten() == Some(1.0)));
        if hubs[k].kind == "keystone" && gc[a] >= SOLO_SMALL && !assumed {
            let same = |x: Option<f64>, y: Option<f64>| match (x, y) {
                (Some(x), Some(y)) => (x - y).abs() <= 1e-9 * x.abs().max(y.abs()).max(1.0),
                (x, y) => x.is_none() == y.is_none(),
            };
            let is_dead = under.abs() <= 1e-6 && r[n].1.len() == oh[k].len() && r[n].1.iter().zip(&oh[k]).all(|(x, y)| same(*x, *y));
            dead.push((hubs[k].key.clone(), ax[a], is_dead));
            // (an axis that only stops paying is a dead line, not a conflict)
            if is_dead {
                continue;
            }
        }
        if class_of(gh[k], gc[a], j).is_some() {
            unit_q.push((k, a, j));
        }
    }
    let probes: Vec<(usize, Vec<String>)> = unit_q.iter().map(|&(k, a, _)| (variant[k], hubs[k].probe.iter().chain(&axes()[ax[a]].unit).cloned().collect())).collect();
    let ru = run_probes(&ev, &texts, &probes, done, t0, &label);
    for (n, &(k, a, j)) in unit_q.iter().enumerate() {
        let su = ru[n].0 - s0 - gh[k] - gu[a];
        let sc = j - gh[k] - gc[a];
        if su.is_finite() && su.signum() == sc.signum() {
            // (keys in order: an axis can share its key with a hub, so the same pair found both ways merges)
            let (hk, xk) = (hubs[k].key.clone(), axes()[ax[a]].key.clone());
            let class = class_of(gh[k], gc[a], j).unwrap();
            recs.push(if hk <= xk { Rec { a: hk, b: xk, class, ga: gh[k], gb: gc[a], j } } else { Rec { a: xk, b: hk, class, ga: gc[a], gb: gh[k], j } });
        }
    }
    for (n, &(k, m)) in hh.iter().enumerate() {
        let j = r[nja + n].0 - s0;
        if let Some(c) = j.is_finite().then(|| class_of(gh[k], gh[m], j)).flatten() {
            let (a, b, ga, gb) = if hubs[k].key <= hubs[m].key { (&hubs[k].key, &hubs[m].key, gh[k], gh[m]) } else { (&hubs[m].key, &hubs[k].key, gh[m], gh[k]) };
            recs.push(Rec { a: a.clone(), b: b.clone(), class: c, ga, gb, j });
        }
    }
    PARTS.with(|p| {
        let mut p = p.borrow_mut();
        for h in &hubs {
            p.entry(h.key.clone()).or_insert_with(|| json!({"kind": h.kind, "label": h.label, "lines": h.probe}));
        }
        for &i in &ax {
            let a = &axes()[i];
            p.entry(a.key.clone()).or_insert_with(|| json!({"kind": "axis", "label": a.label, "lines": a.commit, "unit": a.unit}));
        }
    });
    Ok(BaseOut { id: id.into(), archetype: archetype.into(), mode: mode.into(), skill: skill.into(), score0: s0, recs, dead })
}

thread_local! {
    static PARTS: RefCell<std::collections::BTreeMap<String, Value>> = RefCell::new(Default::default());
}

/// A short stable id of a pair (FNV-1a of its keys).
fn pair_id(a: &str, b: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for c in a.bytes().chain([b'|']).chain(b.bytes()) {
        h ^= c as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:012x}", h & 0xffff_ffff_ffff)
}

fn r4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

/// The scan: every base, then pairs merged across bases, dead lines and conflicts. The output is
/// sorted, so a rerun on the same data gives the same file.
pub fn scan(o: &ScanOpts) -> Result<Value, String> {
    let t0 = Instant::now();
    let mut done = 0u64;
    PARTS.with(|p| p.borrow_mut().clear());
    let bases: Vec<&(&str, &str, &str, &str)> = BASES.iter().filter(|b| !o.quick || b.0 == "spell-boss").collect();
    let mut outs: Vec<BaseOut> = Vec::new();
    // (an archetype without a base would leave its pairs and dead lines out silently: the scan stops instead)
    for b in bases {
        let skill = ref_skill(b.1, b.2).map_err(|e| format!("base {}: {e}", b.0))?;
        outs.push(scan_base(b.0, b.1, &skill, b.3, o, &mut done, t0).map_err(|e| format!("base {} failed: {e}", b.0))?);
    }
    // pairs merged across bases by (a, b, class): the numbers of the base with the largest synergy
    let mut merged: std::collections::BTreeMap<(String, String, &'static str), (Rec, Vec<String>, Vec<String>, Vec<String>)> = Default::default();
    for b in &outs {
        for r in &b.recs {
            let e = merged.entry((r.a.clone(), r.b.clone(), r.class)).or_insert_with(|| (r.clone(), Vec::new(), Vec::new(), Vec::new()));
            if (r.j - r.ga - r.gb).abs() > (e.0.j - e.0.ga - e.0.gb).abs() {
                e.0 = r.clone();
            }
            for (v, x) in [(&mut e.1, &b.archetype), (&mut e.2, &b.mode), (&mut e.3, &b.id)] {
                if !v.contains(x) {
                    v.push(x.clone());
                }
            }
        }
    }
    let parts = PARTS.with(|p| p.borrow().clone());
    let label = |k: &str| parts.get(k).and_then(|p| p["label"].as_str()).unwrap_or("?").to_string();
    let mut pairs: Vec<Value> = merged
        .into_values()
        .map(|(r, arch, mode, on)| {
            let syn = r.j - r.ga - r.gb;
            json!({
                "id": pair_id(&r.a, &r.b), "a": r.a, "b": r.b, "class": r.class,
                "solo": [r4(r.ga), r4(r.gb)], "joint": r4(r.j), "synergy": r4(syn),
                "archetypes": arch, "mode": mode, "bases": on, "needs": [],
                "why": format!("{} + {}: together {:+.2}, alone {:+.2} and {:+.2} (log score)", label(&r.a), label(&r.b), r.j, r.ga, r.gb),
            })
        })
        .collect();
    pairs.sort_by(|x, y| y["synergy"].as_f64().unwrap_or(0.0).abs().total_cmp(&x["synergy"].as_f64().unwrap_or(0.0).abs()).then_with(|| x["id"].as_str().cmp(&y["id"].as_str())));
    let conflicts: Vec<Value> = pairs.iter().filter(|p| p["class"] == "conflict").map(|p| json!([p["a"], p["b"]])).collect();
    // dead: a mod is dead under a keystone when every base that tested an axis carrying it found it dead, and no live
    // axis under the keystone carries it
    let mut dead_by: std::collections::BTreeMap<String, (std::collections::BTreeSet<String>, std::collections::BTreeSet<String>)> = Default::default();
    let mut votes: std::collections::BTreeMap<(String, usize), (u32, u32)> = Default::default();
    for b in &outs {
        for (h, i, d) in &b.dead {
            let v = votes.entry((h.clone(), *i)).or_default();
            if *d {
                v.0 += 1;
            } else {
                v.1 += 1;
            }
        }
    }
    // (an axis with an amplify or unlock pair under the keystone is alive whatever a base said)
    let paired: HashSet<(&str, &str)> = pairs.iter().filter(|p| p["class"] != "conflict").flat_map(|p| {
        let (a, b) = (p["a"].as_str().unwrap_or(""), p["b"].as_str().unwrap_or(""));
        [(a, b), (b, a)]
    }).collect();
    for ((h, i), (d, alive)) in votes {
        let names: Vec<String> = axes()[i].commit.iter().filter_map(|l| line_mod_names(l)).flatten().collect();
        let pos = paired.contains(&(h.as_str(), axes()[i].key.as_str()));
        let e = dead_by.entry(h).or_default();
        if d > 0 && alive == 0 && !pos {
            e.0.extend(names);
        } else {
            e.1.extend(names);
        }
    }
    let dead: Vec<Value> = dead_by
        .into_iter()
        .filter_map(|(h, (d, alive))| {
            let mods: Vec<String> = d.difference(&alive).cloned().collect();
            (!mods.is_empty()).then(|| json!({"hub": h, "label": label(&h), "mods": mods}))
        })
        .collect();
    let game_fp = pom_engine::modparser::parse::parse_cache_fingerprint(&crate::engine_data_dir());
    let secs = t0.elapsed().as_secs_f64();
    Ok(json!({
        "version": 1, "tree": "3_29", "engine": format!("{game_fp:016x}"), "quick": o.quick, "evals": done, "seconds": secs.round(),
        "bases": outs.iter().map(|b| json!({"id": b.id, "archetype": b.archetype, "mode": b.mode, "skill": b.skill, "score0": r4(b.score0)})).collect::<Vec<_>>(),
        "parts": parts, "pairs": pairs, "dead": dead, "conflicts": conflicts,
    }))
}

/// `pom-cli synergy-scan <out.json> [--quick] [--threads N]`
pub fn scan_cli(a: &[String]) {
    let Some(out) = a.first() else {
        eprintln!("usage: pom-cli synergy-scan <out.json> [--quick] [--threads N]");
        std::process::exit(2);
    };
    let quick = a.iter().any(|x| x == "--quick");
    let threads = a.iter().position(|x| x == "--threads").and_then(|i| a.get(i + 1)).and_then(|t| t.parse().ok()).unwrap_or(4);
    match scan(&ScanOpts { quick, threads }) {
        Ok(v) => {
            let _ = std::fs::write(out, serde_json::to_string_pretty(&v).unwrap_or_default());
            let n = |k: &str| v[k].as_array().map_or(0, |x| x.len());
            println!("synergy-scan: {} bases, {} evals in {} s; {} pairs ({} conflicts), {} keystones with dead lines -> {out}", n("bases"), v["evals"], v["seconds"], n("pairs"), n("conflicts"), n("dead"));
            let f = |p: &Value, k: &str| p[k].as_f64().unwrap_or(0.0);
            let combo = |p: &&Value| p["class"] != "conflict" && f(p, "joint") > 0.0 && p["solo"].as_array().is_some_and(|s| s.iter().all(|x| f(p, "joint") > x.as_f64().unwrap_or(0.0)));
            for p in v["pairs"].as_array().into_iter().flatten().filter(combo).take(10) {
                println!("  {:8} {:+.3}  {}", p["class"].as_str().unwrap_or(""), p["synergy"].as_f64().unwrap_or(0.0), p["why"].as_str().unwrap_or(""));
            }
        }
        Err(e) => {
            eprintln!("synergy-scan: {e}");
            std::process::exit(1);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Solver use: the file, dead lines, combo leads

#[derive(Deserialize, Default)]
pub(super) struct Synergies {
    #[serde(default)]
    pub pairs: Vec<PairRec>,
    #[serde(default)]
    pub dead: Vec<DeadRec>,
    #[serde(default)]
    pub parts: std::collections::HashMap<String, PartRec>,
}

#[derive(Deserialize, Clone)]
pub(super) struct PairRec {
    pub a: String,
    pub b: String,
    pub class: String,
    #[serde(default)]
    pub joint: f64,
    #[serde(default)]
    pub solo: Vec<f64>,
    #[serde(default)]
    pub archetypes: Vec<String>,
    #[serde(default)]
    pub mode: Vec<String>,
}

#[derive(Deserialize)]
pub(super) struct DeadRec {
    pub hub: String,
    pub mods: Vec<String>,
}

#[derive(Deserialize, Clone)]
pub(super) struct PartRec {
    pub kind: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub lines: Vec<String>,
}

/// engine-data/synergies.json, when the scan has been run.
pub(super) fn synergies() -> Option<&'static Synergies> {
    static S: OnceLock<Option<Synergies>> = OnceLock::new();
    S.get_or_init(|| std::fs::read_to_string(crate::engine_data_dir().join("synergies.json")).ok().and_then(|t| serde_json::from_str(&t).ok())).as_ref()
}

/// The mods the scan found dead under the keystone called `name` in today's tree (resolved to its key), if any.
pub(super) fn dead_mods(name: &str) -> Option<&'static HashSet<String>> {
    static D: OnceLock<HashMap<String, HashSet<String>>> = OnceLock::new();
    D.get_or_init(|| {
        let mut out: HashMap<String, HashSet<String>> = HashMap::default();
        let (Some(syn), Ok(tree)) = (synergies(), crate::cached_tree("3_29")) else { return out };
        for n in tree.nodes.values().filter(|n| n.get("type").and_then(|t| t.as_str()) == Some("Keystone")) {
            let Some(key) = mod_key(&node_lines(tree, *n)) else { continue };
            if let Some(d) = syn.dead.iter().find(|d| d.hub == key) {
                out.insert(n.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(), d.mods.iter().cloned().collect());
            }
        }
        out
    })
    .get(name)
}

/// Whether one line is dead under a keystone's dead mods: every mod the line parses to is one of them.
pub(super) fn line_dead_by(mods: &HashSet<String>, line: &str) -> bool {
    line_mod_names(line).is_some_and(|n| n.iter().all(|m| mods.contains(m)))
}

/// A beam part's scan key: a tree node's or unique's hub key, a support's, a mod line's parsed mods.
fn part_key(p: &super::parts::Part) -> Option<String> {
    use super::parts::PartKind;
    static BY_NODE: OnceLock<HashMap<i64, String>> = OnceLock::new();
    static BY_UNIQUE: OnceLock<HashMap<String, String>> = OnceLock::new();
    let lines = |t: &str| mod_key(&t.split('\n').map(|l| l.replace('#', "10")).collect::<Vec<_>>());
    match &p.kind {
        PartKind::Node(id) | PartKind::Asc(id) => BY_NODE.get_or_init(|| tree_hubs().1.iter().flat_map(|(k, ids)| ids.iter().map(move |i| (*i, k.clone()))).collect()).get(id).cloned(),
        PartKind::Unique { u, .. } => BY_UNIQUE.get_or_init(|| unique_hubs().1.iter().flat_map(|(k, ns)| ns.iter().map(move |n| (n.clone(), k.clone()))).collect()).get(&u.name).cloned(),
        PartKind::Support(g) => support_key(g),
        PartKind::ModLine { text, .. } => lines(text),
        PartKind::Gear(g) => lines(&g.text),
        _ => None,
    }
}

impl super::parts::Excl {
    /// Whether two marks keep their parts apart: the same mark, or the opposite sides of one conflict.
    pub(super) fn clashes(&self, o: &Self) -> bool {
        use super::parts::Excl::Conflict;
        match (self, o) {
            (Conflict(a, x), Conflict(b, y)) => a == b && x != y,
            _ => self == o,
        }
    }
}

/// What a combo lead holds from the start: tree nodes, a support in the main link, a unique, and the axis it pursues.
#[derive(Clone, Default)]
pub(super) struct ComboHold {
    /// The pair's two part keys.
    pub halves: Vec<String>,
    pub nodes: Vec<i64>,
    pub support: Option<&'static str>,
    pub unique: Option<(usize, Arc<UniqueInfo>)>,
    pub lines: Vec<String>,
    pub hint: Option<usize>,
    pub label: String,
}

impl Solver {
    /// One half of a pair made concrete for class context `ci`: a reachable node, an allowed unique (not a weapon:
    /// the lead holds its own), a support that fits, or an axis's lines. None: the context cannot have it.
    fn resolve_half(&self, ci: usize, key: &str, syn: &Synergies, h: &mut ComboHold) -> bool {
        let Some(part) = syn.parts.get(key) else { return false };
        let c = &self.ctx[ci];
        match part.kind.as_str() {
            "keystone" | "asc" => {
                let asc = part.kind == "asc";
                let Some(ids) = tree_hubs().1.get(key) else { return false };
                let alloc: HashSet<i64> = h.nodes.iter().copied().collect();
                let reach = c.bfs(&alloc, asc);
                let Some(&id) = ids.iter().find(|&&id| c.paths.nodes.contains_key(&id) && (if asc { c.allowed_asc(id) } else { c.allowed_main(id) }) && reach.contains_key(&id)) else { return false };
                h.nodes.extend(c.path_to(&reach, id));
                true
            }
            "unique" => {
                let Some(names) = unique_hubs().1.get(key) else { return false };
                for u in self.uniques.iter().filter(|u| names.contains(&u.name)) {
                    for (i, d) in self.slots.iter().enumerate() {
                        if d.locked || matches!(d.kind, SlotKind::Weapon1 | SlotKind::Weapon2 | SlotKind::TreeJewel) || (d.kind == SlotKind::Abyss) != (u.sub_type == "Abyss") || !slot_types(d.kind).contains(&u.item_type.as_str()) {
                            continue;
                        }
                        h.unique = Some((i, u.clone()));
                        return true;
                    }
                }
                false
            }
            "support" => {
                let Some(g) = self.gems.iter().find(|g| g.kind == Kind::Support && support_key(g.id).as_deref() == Some(key) && support_fits(g.id, self.main_gem)) else { return false };
                h.support = Some(g.id);
                true
            }
            _ => {
                h.lines = part.lines.clone();
                h.hint = AXES.iter().position(|a| a.name == part.label);
                true
            }
        }
    }

    /// `st` with the hold applied (nodes allocated, support linked, unique worn and held). None: it cannot be worn.
    fn with_hold(&self, st: &State, h: &ComboHold) -> Option<State> {
        let mut s = st.clone();
        for &n in &h.nodes {
            if !s.nodes.contains(&n) {
                s.nodes.push(n);
            }
        }
        if let Some(g) = h.support {
            if !s.main.contains(&g) && !self.mana_clash(&s.main.iter().copied().chain([g]).collect::<Vec<_>>()) {
                s.main.push(g);
            }
        }
        if let Some((i, u)) = &h.unique {
            let mut g = self.with_piece(&s.gear, *i, Some(items::unique_piece(u)))?;
            g.held.push(*i);
            s.gear = Arc::new(g);
        }
        Some(s)
    }

    /// Combo leads: the scan's pairs for the main skill's archetype and the goal's play mode,
    /// screened in each context's root with both halves in (the axis half as probe lines). The 2 best by joint gain
    /// join the leads (the book stays at 16 at most), each holding its pair from the start.
    pub(super) fn combo_leads(&mut self, roots: &[State]) -> Result<(), String> {
        let Some(syn) = synergies() else { return Ok(()) };
        let arch = archetypes_of(self.main_gem);
        let mode = if self.goal.assume.mode() != PlayMode::Mapping { "bossing" } else { "mapping" };
        let words = skill_words(self.main_gem);
        // (both halves change a rule: a keystone, ascendancy notable, unique or support, never a plain axis)
        let rule = |k: &str| syn.parts.get(k).is_some_and(|p| matches!(p.kind.as_str(), "keystone" | "asc" | "unique" | "support"));
        // (a pair that only undoes one half's loss is no combo: together it must beat the base and each half alone; one
        // half must speak to the main skill's tags or damage)
        let mut pairs: Vec<&PairRec> = syn.pairs.iter().filter(|p| p.class != "conflict" && p.joint > 0.0 && p.solo.iter().all(|&x| p.joint > x) && p.mode.iter().any(|m| m == mode) && p.archetypes.iter().any(|a| arch.contains(&a.as_str())) && rule(&p.a) && rule(&p.b) && (fits_skill(&words, &p.a) || fits_skill(&words, &p.b))).collect();
        pairs.sort_by(|a, b| b.joint.total_cmp(&a.joint));
        pairs.truncate(24);
        if pairs.is_empty() {
            return Ok(());
        }
        let mut cand: Vec<(usize, ComboHold)> = Vec::new();
        let mut texts: Vec<Option<String>> = Vec::new();
        let mut base: Vec<usize> = Vec::new();
        for (gi, root) in roots.iter().enumerate() {
            let Some(g) = self.gens.get(gi) else { continue };
            base.push(texts.len());
            texts.push(self.render(root).ok());
            for p in &pairs {
                let mut h = ComboHold { halves: vec![p.a.clone(), p.b.clone()], ..Default::default() };
                if !self.resolve_half(g.ctx, &p.a, syn, &mut h) || !self.resolve_half(g.ctx, &p.b, syn, &mut h) {
                    continue;
                }
                let Some(s) = self.with_hold(root, &h) else { continue };
                let lines: Vec<&str> = h.lines.iter().map(|l| l.as_str()).collect();
                let label = |k: &str| syn.parts.get(k).map_or("?", |x| x.label.as_str()).to_string();
                h.label = format!("combo {} + {}", label(&p.a), label(&p.b));
                texts.push(self.render_with_probe(&s, &lines).ok());
                cand.push((gi, h));
            }
        }
        if cand.is_empty() {
            return Ok(());
        }
        let sc = self.score_texts_relaxed(texts);
        // gain over the context's root, each candidate after its root's text
        let mut gains: Vec<(f64, usize)> = Vec::new();
        let mut k = 0;
        for (n, &b0) in base.iter().enumerate() {
            let end = base.get(n + 1).copied().unwrap_or(sc.len());
            for t in b0 + 1..end {
                gains.push((sc[t] - sc[b0], k));
                k += 1;
            }
        }
        gains.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut picked: Vec<usize> = Vec::new();
        for (g, k) in gains {
            if picked.len() >= 2 || !g.is_finite() || g <= 0.0 {
                break;
            }
            // (one lead per hub: a second pair sharing a half with a picked one is the same idea again)
            if !picked.iter().any(|&p| cand[p].1.halves.iter().any(|x| cand[k].1.halves.contains(x))) {
                picked.push(k);
            }
        }
        let room = 16usize.saturating_sub(picked.len());
        self.book.leads.truncate(room);
        for k in picked {
            let (gi, h) = cand[k].clone();
            let w = (0..self.gens[gi].weapons.len()).max_by(|&a, &b| self.gens[gi].root[a].total_cmp(&self.gens[gi].root[b])).unwrap_or(0);
            let c = &self.ctx[self.gens[gi].ctx];
            let label = format!("{} · {} · {}", h.label, self.gens[gi].weapons[w].name, c.asc_name.clone().unwrap_or_else(|| c.class_name.clone()));
            let mut l = leads::Lead::new(0, gi, w, None, label);
            l.combo = Some(Arc::new(h));
            self.book.add(l);
        }
        Ok(())
    }

    /// Lead start: a combo lead's pair goes in before the gems and gear are chosen (and its axis guides them).
    pub(super) fn hold_combo(&mut self, id: u16, st: &mut State) -> Result<(), String> {
        let Some(h) = self.book.leads.get(id as usize).and_then(|l| l.combo.clone()) else { return Ok(()) };
        // (a hold the engine cannot evaluate with this lead's gear is dropped: the lead goes on plain)
        if let Some(mut s) = self.with_hold(st, &h) {
            let text = Arc::new(self.render(&s)?);
            if self.eval(vec![Cand::Xml(text)]).pop().flatten().is_some() {
                self.rebase(&mut s)?;
                *st = s;
            }
        }
        self.lead_hint.extend(h.hint);
        Ok(())
    }

    /// Rung 1's leads in order: the first of the `n` that fit, with each combo lead in a slot of its own (in place of
    /// the last generated ones, so the rung's budget is unchanged and no combo waits in reserve).
    pub(super) fn rung_one(&self, n: usize) -> Vec<u16> {
        let (combo, plain): (Vec<&leads::Lead>, Vec<&leads::Lead>) = self.book.leads.iter().partition(|l| l.combo.is_some());
        let keep = n.saturating_sub(combo.len()).max(1).min(plain.len());
        plain[..keep].iter().chain(&combo).map(|l| l.id).collect()
    }

    /// The scan's conflicts for this main skill and play mode as exclusions on `parts`: the two sides of one conflict
    /// never go into one beam child (`Excl::clashes`).
    pub(super) fn conflict_excl(&self, parts: &mut [super::parts::Part]) {
        let Some(syn) = synergies() else { return };
        let arch = archetypes_of(self.main_gem);
        let mode = if self.goal.assume.mode() != PlayMode::Mapping { "bossing" } else { "mapping" };
        let keys: Vec<Option<String>> = parts.iter().map(part_key).collect();
        let have: HashSet<&str> = keys.iter().flatten().map(|k| k.as_str()).collect();
        for (n, c) in syn.pairs.iter().enumerate() {
            if c.class != "conflict" || !have.contains(c.a.as_str()) || !have.contains(c.b.as_str()) || !c.mode.iter().any(|m| m == mode) || !c.archetypes.iter().any(|a| arch.contains(&a.as_str())) {
                continue;
            }
            for (p, k) in parts.iter_mut().zip(&keys) {
                if let Some(side) = k.as_deref().and_then(|k| if k == c.a { Some(false) } else if k == c.b { Some(true) } else { None }) {
                    p.excl.push(super::parts::Excl::Conflict(n as u32, side));
                }
            }
        }
    }

    /// Relaxed scores of whole texts (`score_texts` in solver_leads.rs, which is private there).
    fn score_texts_relaxed(&self, texts: Vec<Option<String>>) -> Vec<f64> {
        let mut at: Vec<Option<usize>> = Vec::with_capacity(texts.len());
        let mut n = 0;
        for t in &texts {
            at.push(t.as_ref().map(|_| {
                n += 1;
                n - 1
            }));
        }
        let r = self.eval(texts.into_iter().flatten().map(|t| Cand::Xml(Arc::new(t))).collect());
        at.iter().map(|a| a.and_then(|i| r[i].as_ref()).map_or(f64::NEG_INFINITY, |v| self.relaxed_score(v, false))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn by_mod<'a>(v: &'a Value, flag: &str) -> Vec<&'a str> {
        v["parts"].as_object().unwrap().iter().filter(|(k, _)| k.split('+').any(|m| m == flag)).map(|(k, _)| k.as_str()).collect()
    }

    /// The quick scan (spell, bossing, keystones) finds Eldritch Battery + Mind over Matter as a positive pair and Blood
    /// Magic + Eldritch Battery as a conflict (catalog conflict table), each found by the keystones' parsed mods, and
    /// gives the same file twice.
    #[test]
    fn quick_scan_finds_known_pairs() {
        // (two probe workers: the base is built on one, so the file is the same on any number of workers)
        let o = ScanOpts { quick: true, threads: 2 };
        let v = scan(&o).unwrap();
        let _ = std::fs::write(std::env::temp_dir().join("k5-quick.json"), serde_json::to_string_pretty(&v).unwrap());
        let pairs = v["pairs"].as_array().unwrap();
        eprintln!("quick: {} evals in {} s, {} pairs, {} dead", v["evals"], v["seconds"], pairs.len(), v["dead"].as_array().unwrap().len());
        for p in pairs.iter().take(15) {
            eprintln!("  {} {:+.3} {}", p["class"], p["synergy"].as_f64().unwrap(), p["why"]);
        }
        let has = |a: &[&str], b: &[&str], class: &[&str]| pairs.iter().find(|p| class.contains(&p["class"].as_str().unwrap()) && ((a.contains(&p["a"].as_str().unwrap()) && b.contains(&p["b"].as_str().unwrap())) || (b.contains(&p["a"].as_str().unwrap()) && a.contains(&p["b"].as_str().unwrap())))).cloned();
        let eb = by_mod(&v, "FLAG:EnergyShieldProtectsMana");
        let mom: Vec<&str> = v["parts"].as_object().unwrap().iter().filter(|(k, _)| k.contains(":DamageTakenFromManaBeforeLife")).map(|(k, _)| k.as_str()).collect();
        assert!(!eb.is_empty() && !mom.is_empty(), "eb {eb:?} mom {mom:?}");
        let p = has(&eb, &mom, &["amplify", "unlock"]).expect("an Eldritch Battery + mana-before-life pair");
        eprintln!("EB + MoM: {p}");
        assert!(p["synergy"].as_f64().unwrap() >= SYN);
        let bm = by_mod(&v, "FLAG:CostLifeInsteadOfMana");
        assert!(!bm.is_empty(), "no life-cost hub");
        let c = has(&bm, &eb, &["conflict"]).expect("a life-cost + Eldritch Battery conflict");
        eprintln!("BM + EB: {c}");
        // stable: the same data gives the same pairs and dead lines
        let w = scan(&o).unwrap();
        let _ = std::fs::write(std::env::temp_dir().join("k5-quick2.json"), serde_json::to_string_pretty(&w).unwrap());
        assert_eq!(v["pairs"], w["pairs"]);
        assert_eq!(v["dead"], w["dead"]);
    }

    /// Review findings 1-3: a keystone's enabling stat is never dead (crit chance under Elemental Overload, energy
    /// shield under Eldritch Battery), and every hand-list word stays dead while the file covers the keystone.
    #[test]
    fn dead_lines_keep_enablers_and_hand_words() {
        use super::super::parts::line_is_dead;
        let k = |n: &str| vec![n.to_string()];
        assert!(!line_is_dead(&k("Elemental Overload"), "#% increased Critical Strike Chance"), "EO needs a recent crit");
        assert!(!line_is_dead(&k("Elemental Overload"), "#% increased Global Critical Strike Chance"));
        assert!(!line_is_dead(&k("Eldritch Battery"), "+# to maximum Energy Shield"), "ES is Eldritch Battery's point");
        assert!(!line_is_dead(&k("Eldritch Battery"), "#% increased maximum Energy Shield"));
        assert!(line_is_dead(&k("The Agnostic"), "+# to maximum Energy Shield"));
        for (ks, lines) in [
            ("Resolute Technique", &["#% increased Critical Strike Chance", "+#% to Critical Strike Multiplier", "#% increased Melee Critical Strike Chance", "+# to Accuracy Rating"][..]),
            ("Elemental Overload", &["+#% to Critical Strike Multiplier", "+#% to Global Critical Strike Multiplier"][..]),
            ("Roiling Tempest", &["#% increased Fire Damage", "#% increased Cold Damage", "#% increased Chaos Damage", "#% increased Physical Damage", "Damage Penetrates #% Fire Resistance", "Damage Penetrates #% Cold Resistance"][..]),
        ] {
            for l in lines {
                assert!(line_is_dead(&k(ks), l), "{ks}: {l} should stay dead");
            }
        }
    }

    /// The beam never pairs a known conflict: Blood Magic and Eldritch Battery (a scan conflict for spells) get
    /// opposite marks of one conflict; Eldritch Battery and Mind over Matter do not clash.
    #[test]
    fn conflicts_exclude_beam_parts() {
        use super::super::parts::{Part, PartKind};
        let s = ref_solver("Arc", "bossing", 1).unwrap();
        let node = |n: &str| {
            let h = tree_hubs().0.iter().find(|h| h.label == n).unwrap_or_else(|| panic!("no hub {n}"));
            Part { kind: PartKind::Node(tree_hubs().1[&h.key][0]), label: n.into(), excl: Vec::new(), cost: 0 }
        };
        let mut parts = vec![node("Blood Magic"), node("Eldritch Battery"), node("Mind Over Matter")];
        s.conflict_excl(&mut parts);
        let clash = |a: &Part, b: &Part| a.excl.iter().any(|e| b.excl.iter().any(|f| e.clashes(f)));
        assert!(clash(&parts[0], &parts[1]), "BM + EB must clash: {:?} / {:?}", parts[0].excl, parts[1].excl);
        assert!(!clash(&parts[1], &parts[2]), "EB + MoM must not clash");
    }

    /// With engine-data/synergies.json in place, the dead lines it found under Resolute Technique, Elemental Overload
    /// and Roiling Tempest agree with the hand list they replace (solver_parts.rs dead_tests).
    #[test]
    fn dead_lines_match_hand_list() {
        let d = |k: &str| dead_mods(k).unwrap_or_else(|| panic!("no dead lines for {k} in synergies.json"));
        let rt = d("Resolute Technique");
        assert!(line_dead_by(rt, "#% increased Melee Critical Strike Chance"));
        assert!(line_dead_by(rt, "+#% to Critical Strike Multiplier"));
        assert!(!line_dead_by(rt, "#% increased Attack Speed"));
        let eo = d("Elemental Overload");
        assert!(line_dead_by(eo, "+#% to Critical Strike Multiplier"));
        assert!(!line_dead_by(eo, "#% increased Attack Speed"));
        let t = d("Roiling Tempest");
        assert!(line_dead_by(t, "Adds # to # Cold Damage to Attacks"));
        assert!(line_dead_by(t, "#% increased Fire Damage"));
        assert!(!line_dead_by(t, "Adds # to # Lightning Damage to Attacks"));
        assert!(!line_dead_by(t, "#% to Cold Resistance"));
        assert!(!line_dead_by(t, "#% additional Physical Damage Reduction"));
    }
}
