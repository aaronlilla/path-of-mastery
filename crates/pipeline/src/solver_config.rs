//! Config switches the solver sets per candidate (engine-data/config-sources.json, every upstream switch classified as a
//! seasoned player would set it). `source` switches go on when the candidate has a matching source (gem, tree node,
//! item line, keystone, engine flag), `playstyle` switches take the value the main skill's tags and the play mode give,
//! `defence` switches follow the candidate's own defence stats. Only `high` entries go on by themselves; close calls
//! come back as offers the player can turn on (`assume.configOn`).
//!
//! Cheap by design: gem and tree sources are read from the state at render time (tree and item lines matched once and
//! remembered), and everything that needs computed stats (defence rules, '=expr' values, engine flags, ailment tags)
//! reads the state's last whole evaluation. `archive_add` settles a result on its own numbers and measures each switch.
use super::*;
use regex::{Regex, RegexSet};
use std::sync::OnceLock;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Class {
    Source,
    Playstyle,
    Defence,
    Other,
}

#[derive(Debug)]
enum Src {
    Mod,
    Skill(String),
    Support(String),
    Keystone(String),
    Item(String),
    Flag(String),
    Ref(String),
    Unknown,
}

struct SrcDef {
    src: Src,
    mapping: bool,
    bossing: bool,
    /// Main-skill tags (config_tags) the source needs / is off with: Fortify needs a melee skill, Withering Step's Elusive
    /// ends on every skill use.
    need: Vec<String>,
    not: Vec<String>,
}

struct Case {
    when: Vec<String>,
    mapping: Value,
    bossing: Value,
}

pub(super) struct Sw {
    pub key: String,
    pub label: String,
    ty: String,
    class: Class,
    high: bool,
    srcs: Vec<SrcDef>,
    value: Value,
    cases: Vec<Case>,
    on: Option<Expr>,
    close: Option<Expr>,
    off: Option<Expr>,
    /// relevantWhen.ifSkill: the switch only matters with one of these skills.
    if_skill: Vec<String>,
    /// relevantWhen.ifFlag when it is a "Condition:" flag (read from the evaluation as `Solver.Flag.<flag>`).
    if_flag: Option<String>,
}

/// Switches whose sources must all be there (a skill plus the charges it spends, both golems, the transfigured gem and
/// the skill it is cast on). The file lists sources as alternatives everywhere else.
const ALL_SOURCES: [&str; 8] = ["carrionGolemEqualsChaosGolem", "chaosGolemEqualsStoneGolem", "stoneGolemEqualsCarrionGolem", "ColdSnapBypassCD", "ConcPathBypassCD", "FlickerStrikeBypassCD", "iceNovaCastOnFrostbolt", "vortexCastOnFrostbolt"];

pub(super) struct Data {
    pub sw: Vec<Sw>,
    mods: RegexSet,
    /// Per `mods` pattern: (switch, source).
    mod_owner: Vec<(usize, usize)>,
    /// Stats the rules read (added to the solver's evaluation names).
    pub stats: Vec<String>,
    /// `lineGates`: a matched source line whose own wording names a skill type (Melee Hits ...) or an enemy state no map
    /// or boss has (an Enemy with no Armour): (pattern, main-skill tags it needs, never).
    gates: Vec<(Regex, Vec<String>, bool)>,
}

impl Data {
    /// Whether a matched source line ("origin: text", as `line_hits` writes it) applies to the main skill (`tags`) by its
    /// own wording.
    fn line_applies(&self, line: &str, tags: &HashSet<String>) -> bool {
        let text = line.split_once(": ").map_or(line, |x| x.1);
        self.gates.iter().all(|(re, need, never)| !re.is_match(text) || (!never && need.iter().all(|n| tags.contains(n))))
    }
}

/// Stats the tagger reads from the last evaluation.
const TAG_STATS: [&str; 20] = ["HitChance", "Speed", "CritChance", "Repeats", "FrenzyChargesMax", "FrenzyChargesMin", "AverageHit", "TotalDotDPS", "PoisonDPS", "BleedDPS", "IgniteDPS", "PoisonChance", "BleedChance", "IgniteChance", "ShockChance", "FreezeChance", "ImpaleChance", "FireHitAverage", "ColdHitAverage", "LightningHitAverage"];
/// Set by the solver's own code (setup_config, crit flag, flasks), never by the file.
const OWNED: [&str; 5] = ["multiplierWitheredStackCount", "buffLifetap", "feedingFrenzyFeedingFrenzyActive", "conditionCritRecently", "conditionUsingFlask"];

pub(super) fn data() -> &'static Data {
    static D: OnceLock<Data> = OnceLock::new();
    D.get_or_init(|| {
        let raw: Value = serde_json::from_str(include_str!("../../../engine-data/config-sources.json")).expect("config-sources.json");
        let mut sw = Vec::new();
        let mut pats = Vec::new();
        let mut mod_owner = Vec::new();
        let mut stats: Vec<String> = TAG_STATS.iter().map(|s| s.to_string()).collect();
        let s = |v: &Value, k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let all = raw["switches"].as_array().cloned().unwrap_or_default();
        let keys: HashSet<String> = all.iter().map(|v| s(v, "key")).collect();
        let note = |e: &Expr, stats: &mut Vec<String>| {
            let mut ids = Vec::new();
            e.idents(&mut ids);
            for i in ids {
                if !keys.contains(&i) && !stats.contains(&i) && i != "true" && i != "false" {
                    stats.push(i);
                }
            }
        };
        for v in &all {
            let class = match s(v, "class").as_str() {
                "source" => Class::Source,
                "playstyle" => Class::Playstyle,
                "defence" => Class::Defence,
                _ => Class::Other,
            };
            let i = sw.len();
            let mut srcs = Vec::new();
            for x in v.get("sources").and_then(|x| x.as_array()).into_iter().flatten() {
                let m = s(x, "match");
                let modes: Vec<String> = x.get("modes").and_then(|m| m.as_array()).map(|a| a.iter().filter_map(|y| y.as_str().map(String::from)).collect()).unwrap_or_default();
                let (mapping, bossing) = if modes.is_empty() { (true, true) } else { (modes.iter().any(|m| m == "mapping"), modes.iter().any(|m| m == "bossing")) };
                let src = match s(x, "kind").as_str() {
                    "mod" if Regex::new(&format!("(?i){m}")).is_ok() => {
                        pats.push(format!("(?i){m}"));
                        mod_owner.push((i, srcs.len()));
                        Src::Mod
                    }
                    "skill" => Src::Skill(m),
                    "support" => Src::Support(m),
                    "keystone" => Src::Keystone(m),
                    "item" => Src::Item(m),
                    "flag" => {
                        let f = format!("Solver.Flag.{m}");
                        if !stats.contains(&f) {
                            stats.push(f);
                        }
                        Src::Flag(m)
                    }
                    "ref" => Src::Ref(m),
                    _ => Src::Unknown,
                };
                let list = |k: &str| -> Vec<String> { x.get(k).and_then(|m| m.as_array()).map(|a| a.iter().filter_map(|y| y.as_str().map(String::from)).collect()).unwrap_or_default() };
                srcs.push(SrcDef { src, mapping, bossing, need: list("requiresTag"), not: list("unlessTag") });
            }
            let mut cases = Vec::new();
            for c in v.get("valueRule").and_then(|r| r.get("cases")).and_then(|c| c.as_array()).into_iter().flatten() {
                let when = c.get("when").and_then(|w| w.as_array()).map(|a| a.iter().filter_map(|y| y.as_str().map(String::from)).collect()).unwrap_or_default();
                for m in ["mapping", "bossing"] {
                    if let Some(e) = c.get(m).and_then(|x| x.as_str()).and_then(|x| x.strip_prefix('=')).and_then(Expr::parse) {
                        note(&e, &mut stats);
                    }
                }
                cases.push(Case { when, mapping: c.get("mapping").cloned().unwrap_or(Value::Null), bossing: c.get("bossing").cloned().unwrap_or(Value::Null) });
            }
            let value = v.get("value").cloned().unwrap_or(Value::Null);
            if let Some(e) = value.as_str().and_then(|x| x.strip_prefix('=')).and_then(Expr::parse) {
                note(&e, &mut stats);
            }
            let rule = |k: &str| v.get("rule").and_then(|r| r.get(k)).and_then(|x| x.as_str()).and_then(Expr::parse);
            let (on, close, off) = (rule("on"), rule("closeCall"), rule("off"));
            for e in [&on, &close, &off].into_iter().flatten() {
                note(e, &mut stats);
            }
            let if_skill: Vec<String> = match v.get("relevantWhen").and_then(|r| r.get("ifSkill")) {
                Some(Value::String(x)) => vec![x.clone()],
                Some(Value::Array(a)) => a.iter().filter_map(|y| y.as_str().map(String::from)).collect(),
                _ => Vec::new(),
            };
            let if_flag = v.get("relevantWhen").and_then(|r| r.get("ifFlag")).and_then(|f| f.as_str()).filter(|f| f.starts_with("Condition:")).map(String::from);
            if let Some(f) = &if_flag {
                let st = format!("Solver.Flag.{f}");
                if !stats.contains(&st) {
                    stats.push(st);
                }
            }
            sw.push(Sw { key: s(v, "key"), label: s(v, "label"), ty: s(v, "type"), class, high: s(v, "confidence") == "high", srcs, value, cases, on, close, off, if_skill, if_flag });
        }
        let gates = raw["lineGates"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|g| {
                let need = g["requiresTag"].as_array().map(|a| a.iter().filter_map(|y| y.as_str().map(String::from)).collect()).unwrap_or_default();
                (Regex::new(&format!("(?i){}", s(g, "match"))).expect("lineGates pattern"), need, g["never"].as_bool().unwrap_or(false))
            })
            .collect();
        Data { sw, mods: RegexSet::new(&pats).expect("mod patterns"), mod_owner, stats, gates }
    })
}

impl Sw {
    /// Whether this switch, found on a result, holds under the honest re-check's stricter rules (solver_recheck.rs): a
    /// source is its own proof; a playstyle value must hold in a fight without kills (its bossing case is on); a defence
    /// needs the rule's own "on" (no close call, no carry-over). `id` reads the result's numbers.
    pub(super) fn is_source(&self) -> bool {
        self.class == Class::Source
    }

    pub(super) fn is_defence(&self) -> bool {
        self.class == Class::Defence
    }

    pub(super) fn earned(&self, id: &dyn Fn(&str) -> Option<f64>) -> bool {
        let truthy = |v: &Value| match v {
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
            Value::String(_) => true,
            _ => false,
        };
        match self.class {
            Class::Source | Class::Other => true,
            Class::Playstyle => self.cases.iter().any(|c| truthy(&c.bossing)),
            Class::Defence => self.on.as_ref().and_then(|e| e.eval(id)).is_some_and(|x| x != 0.0),
        }
    }
}

/// "Are you Fortified?" -> "Fortified".
pub(super) fn short_label(l: &str) -> String {
    let mut t = l.trim().trim_end_matches([':', '?']).trim().to_string();
    for (p, to) in [("Are you always ", ""), ("Are you ", ""), ("Do you have ", ""), ("Have you ", ""), ("Is the enemy ", "Enemy "), ("Is your ", ""), ("Is ", ""), ("Do your ", ""), ("Do ", ""), ("Has the ", ""), ("Has ", "")] {
        if let Some(r) = t.strip_prefix(p) {
            t = format!("{to}{r}");
            break;
        }
    }
    let mut c = t.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => t,
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Expressions ('=Speed*4', 'BlockChance >= 40 or SpellBlockChance >= 40')

#[derive(Debug, Clone)]
pub(super) enum Expr {
    Num(f64),
    Id(String),
    Neg(Box<Expr>),
    Not(Box<Expr>),
    Bin(&'static str, Box<Expr>, Box<Expr>),
    Min(Vec<Expr>),
}

impl Expr {
    /// None for what the solver cannot compute ("count(freeze,shock,ignite applied)").
    pub(super) fn parse(s: &str) -> Option<Expr> {
        let mut toks = Vec::new();
        let b = s.as_bytes();
        let mut i = 0;
        while i < b.len() {
            let c = b[i] as char;
            if c.is_whitespace() {
                i += 1;
            } else if c.is_ascii_digit() || c == '.' {
                let j = (i..b.len()).find(|&j| !((b[j] as char).is_ascii_digit() || b[j] == b'.')).unwrap_or(b.len());
                toks.push(s[i..j].to_string());
                i = j;
            } else if c.is_ascii_alphabetic() || c == '_' {
                let j = (i..b.len()).find(|&j| !((b[j] as char).is_ascii_alphanumeric() || b[j] == b'_' || b[j] == b':')).unwrap_or(b.len());
                toks.push(s[i..j].to_string());
                i = j;
            } else if i + 1 < b.len() && matches!(&s[i..i + 2], ">=" | "<=" | "==" | "!=") {
                toks.push(s[i..i + 2].to_string());
                i += 2;
            } else if "<>+-*/^(),".contains(c) {
                toks.push(c.to_string());
                i += 1;
            } else {
                return None;
            }
        }
        let mut p = 0;
        let e = Self::or(&toks, &mut p)?;
        (p == toks.len()).then_some(e)
    }

    fn or(t: &[String], p: &mut usize) -> Option<Expr> {
        let mut l = Self::and(t, p)?;
        while t.get(*p).is_some_and(|x| x == "or") {
            *p += 1;
            l = Expr::Bin("or", Box::new(l), Box::new(Self::and(t, p)?));
        }
        Some(l)
    }
    fn and(t: &[String], p: &mut usize) -> Option<Expr> {
        let mut l = Self::cmp(t, p)?;
        while t.get(*p).is_some_and(|x| x == "and") {
            *p += 1;
            l = Expr::Bin("and", Box::new(l), Box::new(Self::cmp(t, p)?));
        }
        Some(l)
    }
    fn cmp(t: &[String], p: &mut usize) -> Option<Expr> {
        if t.get(*p).is_some_and(|x| x == "not") {
            *p += 1;
            return Some(Expr::Not(Box::new(Self::cmp(t, p)?)));
        }
        let l = Self::sum(t, p)?;
        for op in [">=", "<=", "==", "!=", "<", ">"] {
            if t.get(*p).is_some_and(|x| x == op) {
                *p += 1;
                return Some(Expr::Bin(op, Box::new(l), Box::new(Self::sum(t, p)?)));
            }
        }
        Some(l)
    }
    fn sum(t: &[String], p: &mut usize) -> Option<Expr> {
        let mut l = Self::prod(t, p)?;
        while let Some(op) = t.get(*p).and_then(|x| ["+", "-"].into_iter().find(|o| x == o)) {
            *p += 1;
            l = Expr::Bin(op, Box::new(l), Box::new(Self::prod(t, p)?));
        }
        Some(l)
    }
    fn prod(t: &[String], p: &mut usize) -> Option<Expr> {
        let mut l = Self::pow(t, p)?;
        while let Some(op) = t.get(*p).and_then(|x| ["*", "/"].into_iter().find(|o| x == o)) {
            *p += 1;
            l = Expr::Bin(op, Box::new(l), Box::new(Self::pow(t, p)?));
        }
        Some(l)
    }
    fn pow(t: &[String], p: &mut usize) -> Option<Expr> {
        let l = Self::unary(t, p)?;
        if t.get(*p).is_some_and(|x| x == "^") {
            *p += 1;
            return Some(Expr::Bin("^", Box::new(l), Box::new(Self::pow(t, p)?)));
        }
        Some(l)
    }
    fn unary(t: &[String], p: &mut usize) -> Option<Expr> {
        let x = t.get(*p)?.clone();
        *p += 1;
        if x == "-" {
            return Some(Expr::Neg(Box::new(Self::unary(t, p)?)));
        }
        if x == "(" {
            let e = Self::or(t, p)?;
            (t.get(*p)? == ")").then_some(())?;
            *p += 1;
            return Some(e);
        }
        if let Ok(n) = x.parse::<f64>() {
            return Some(Expr::Num(n));
        }
        if !x.chars().next()?.is_ascii_alphabetic() {
            return None;
        }
        if t.get(*p).is_some_and(|y| y == "(") {
            // (min only; anything else is not computable)
            if x != "min" {
                return None;
            }
            *p += 1;
            let mut args = vec![Self::or(t, p)?];
            while t.get(*p).is_some_and(|y| y == ",") {
                *p += 1;
                args.push(Self::or(t, p)?);
            }
            (t.get(*p)? == ")").then_some(())?;
            *p += 1;
            return Some(Expr::Min(args));
        }
        Some(Expr::Id(x))
    }

    fn idents(&self, out: &mut Vec<String>) {
        match self {
            Expr::Id(s) => out.push(s.clone()),
            Expr::Neg(e) | Expr::Not(e) => e.idents(out),
            Expr::Bin(_, a, b) => {
                a.idents(out);
                b.idents(out);
            }
            Expr::Min(a) => a.iter().for_each(|e| e.idents(out)),
            Expr::Num(_) => {}
        }
    }

    pub(super) fn eval(&self, id: &dyn Fn(&str) -> Option<f64>) -> Option<f64> {
        let b = |x: bool| if x { 1.0 } else { 0.0 };
        Some(match self {
            Expr::Num(n) => *n,
            Expr::Id(s) => match s.as_str() {
                "true" => 1.0,
                "false" => 0.0,
                _ => id(s)?,
            },
            Expr::Neg(e) => -e.eval(id)?,
            Expr::Not(e) => b(e.eval(id)? == 0.0),
            Expr::Min(a) => a.iter().map(|e| e.eval(id)).collect::<Option<Vec<f64>>>()?.into_iter().fold(f64::INFINITY, f64::min),
            Expr::Bin(op, l, r) => {
                let (x, y) = (l.eval(id)?, r.eval(id)?);
                match *op {
                    "or" => b(x != 0.0 || y != 0.0),
                    "and" => b(x != 0.0 && y != 0.0),
                    ">=" => b(x >= y),
                    "<=" => b(x <= y),
                    "==" => b(x == y),
                    "!=" => b(x != y),
                    "<" => b(x < y),
                    ">" => b(x > y),
                    "+" => x + y,
                    "-" => x - y,
                    "*" => x * y,
                    "/" if y != 0.0 => x / y,
                    "^" => x.powf(y),
                    _ => return None,
                }
            }
        })
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Per candidate

/// One switch a candidate sets (or is offered).
#[derive(Clone, Debug)]
pub(super) struct On {
    pub key: String,
    pub label: String,
    pub reason: String,
    /// The `<Input>` it writes.
    pub xml: String,
    /// The player turned it on (`assume.configOn`).
    pub player: bool,
    /// Kept by the big-jump check: a check the build's own gem, item or keystone grants.
    pub exempt: bool,
    pub source: bool,
}

#[derive(Default, Clone, Debug)]
pub(super) struct Cfg {
    pub on: Vec<On>,
    pub offers: Vec<On>,
    /// `boolean="false"` inputs for switches upstream turns on by default that the solver decided against (no input would
    /// leave upstream's default on).
    pub off: Vec<String>,
}

impl Cfg {
    pub(super) fn xml(&self) -> String {
        self.on.iter().map(|o| o.xml.as_str()).chain(self.off.iter().map(|x| x.as_str())).collect()
    }

    /// `key` is decided off: if upstream has it on by default, say so in the text.
    fn decided_off(&mut self, key: &str) {
        let default_on = pom_config::gen::defaults::ALL_OPTION_DEFAULTS.iter().any(|m| m.var == key && matches!(m.default_state, Some(pom_config::types::OptionValue::Bool(true))));
        let x = format!("<Input name=\"{}\" boolean=\"false\"/>", crate::edit::esc(key));
        if default_on && !self.off.contains(&x) {
            self.off.push(x);
        }
    }
}

/// How long a Frenzy Charge lasts, in seconds.
const FRENZY_SECS: f64 = 10.0;

/// Frenzy Charges a second the lines give: "N% chance to gain a Frenzy Charge on Hit" (per hit, `hits` a second), "on
/// Critical Strike" (per crit: `hits` x `crit`, the crit chance 0-1), "on Kill" (mapping only, `MAPPING_KILL_CHARGES`
/// kills a second), "every N seconds".
pub(super) fn frenzy_gen(lines: &[String], hits: f64, crit: f64, mapping: bool) -> f64 {
    static CHANCE: OnceLock<Regex> = OnceLock::new();
    static EVERY: OnceLock<Regex> = OnceLock::new();
    let chance = CHANCE.get_or_init(|| Regex::new(r"(\d+(?:\.\d+)?)% chance").unwrap());
    let every = EVERY.get_or_init(|| Regex::new(r"every (\d+) seconds?").unwrap());
    lines
        .iter()
        .map(|l| {
            let l = l.to_lowercase();
            if !l.contains("frenzy charge") || !l.contains("gain") {
                return 0.0;
            }
            let p = chance.captures(&l).and_then(|c| c[1].parse::<f64>().ok()).unwrap_or(100.0) / 100.0;
            let rate = if l.contains("on kill") {
                if mapping { MAPPING_KILL_CHARGES } else { 0.0 }
            } else if let Some(c) = every.captures(&l) {
                1.0 / c[1].parse::<f64>().unwrap_or(1.0).max(1.0)
            } else if l.contains("every second") {
                1.0
            } else if l.contains("critical strike") {
                hits * crit.clamp(0.0, 1.0)
            } else if l.contains("on hit") {
                hits
            } else {
                0.0
            };
            rate * p
        })
        .sum()
}

/// Withered stacks the lines and gem chances keep up on one enemy: each "N% chance to inflict Withered for S seconds on
/// Hit" line (no chance = every hit) and each gem chance (0-1, two seconds) adds `hits` a second x chance x S stacks. A
/// line that works only "if there are M or fewer Withered Debuffs on Enemy" adds up to M + 1. At most 15.
pub(super) fn wither_gen(lines: &[String], gem_chance: f64, hits: f64) -> f64 {
    static LINE: OnceLock<Regex> = OnceLock::new();
    let re = LINE.get_or_init(|| Regex::new(r"^(?:(\d+(?:\.\d+)?)% chance to )?inflict withered for (\d+|two) seconds on hit(?: with this weapon)?(?: if there are (\d+) or fewer withered debuffs on enemy)?$").unwrap());
    let mut free = gem_chance * hits * 2.0;
    let mut capped: Vec<(f64, f64)> = Vec::new();
    for l in lines {
        let Some(c) = re.captures(l.trim().to_lowercase().trim_end_matches('.')).map(|c| (c.get(1).map(|m| m.as_str().to_string()), c[2].to_string(), c.get(3).map(|m| m.as_str().to_string()))) else { continue };
        let p = c.0.and_then(|x| x.parse::<f64>().ok()).unwrap_or(100.0) / 100.0;
        let secs = if c.1 == "two" { 2.0 } else { c.1.parse().unwrap_or(2.0) };
        match c.2.and_then(|m| m.parse::<f64>().ok()) {
            Some(m) => capped.push((hits * p * secs, m + 1.0)),
            None => free += hits * p * secs,
        }
    }
    capped.into_iter().fold(free, |n, (add, cap)| n.max((n + add).min(cap))).min(15.0)
}

/// Gem quality the solver's gems have (the "20% quality" assumption).
const GEM_QUALITY: f64 = 20.0;

/// The main skill's own chance (0-1) to gain a Frenzy Charge on hit, at the solver's gem quality (its gem stat).
pub(super) fn skill_frenzy_on_hit(gem: &str) -> f64 {
    gd::game_data().gems.get(gem).and_then(gd::gem_primary_effect).map_or(0.0, |ge| gd::stat_value(ge, 20.0, GEM_QUALITY, "add_frenzy_charge_on_skill_hit_%") / 100.0)
}

/// A gem's chance (0-1) to inflict Withered on hit at the solver's level and quality: its withered-on-hit chance stats
/// (level, quality and constant), read from the game data.
pub(super) fn gem_wither_chance(gem: &str) -> f64 {
    let Some(ge) = gd::game_data().gems.get(gem).and_then(gd::gem_primary_effect) else { return 0.0 };
    let wither = |id: &str| id.starts_with("withered_on_hit") && id.contains("chance");
    let first = |j: &pom_engine::cjson::J| j.as_array().and_then(|a| a.first()).and_then(|v| v.as_str()).map(String::from);
    let mut ids: Vec<String> = ge.stats.iter().cloned().chain(ge.quality_stats.iter().filter_map(first)).chain(ge.extra.get("constantStats").and_then(|v| v.as_array()).into_iter().flatten().filter_map(|c| first(&c))).filter(|id| wither(id)).collect();
    ids.sort();
    ids.dedup();
    ids.iter().map(|id| gd::stat_value(ge, 20.0, GEM_QUALITY, id)).sum::<f64>() / 100.0
}

/// Frenzy Charges a second the build's gems grant on kill (each gem's own `add_frenzy_charge_on_kill_%_chance`), at
/// `kills` a second.
pub(super) fn gem_frenzy_on_kill(effects: &[&pom_engine::data::gems::GrantedEffect], kills: f64) -> f64 {
    effects.iter().map(|ge| gd::stat_value(ge, 20.0, GEM_QUALITY, "add_frenzy_charge_on_kill_%_chance") / 100.0).sum::<f64>() * kills
}

/// Whether `skill` spends a Frenzy Charge per use: a switch of that skill's is sourced by using Frenzy Charges
/// (config-sources.json: a cooldown bypass that expends one).
pub(super) fn spends_frenzy(sw: &[Sw], skill: &str) -> bool {
    sw.iter().any(|s| s.if_skill.iter().any(|n| n.eq_ignore_ascii_case(skill)) && s.srcs.iter().any(|x| matches!(&x.src, Src::Ref(r) if r == "useFrenzyCharges")))
}

/// Whether item lines consume Frenzy Charges on use (a flask that spends the stock each time it is drunk).
pub(super) fn consumes_frenzy(lines: &[String]) -> bool {
    lines.iter().any(|l| {
        let l = l.to_lowercase();
        l.contains("consume") && l.contains("frenzy charge")
    })
}

/// Uses a second of a skill that attacks `speed` times a second with `repeats` hits per use (a repeat support's
/// extra hits are not uses: they spend no charge).
pub(super) fn uses_per_sec(speed: f64, repeats: f64) -> f64 {
    speed / repeats.max(1.0)
}

/// The Frenzy Charges a setup can keep up: it makes `gen` a second and its main skill spends `spend` a second (Flicker
/// Strike spends one per use to skip its cooldown). Minimum charges are always there; a spender that makes less than
/// it spends uses each charge as it comes, so it holds none (and its bypass, sourced by them, goes too); a build that
/// only collects keeps a stock of `gen` x 10 s. 0: none.
pub(super) fn frenzy_count(gen: f64, spend: f64, max: f64, min: f64) -> u32 {
    let stock = if spend > 0.0 { if gen >= spend { max } else { 0.0 } } else { (gen * FRENZY_SECS).min(max) };
    stock.max(min).min(max.max(min)).floor() as u32
}

/// Tree lines (node stats and mastery effects) matched once per tree: node -> [(switch, source, line)], mastery effect
/// -> the same, and keystone names by node.
#[derive(Default)]
pub(super) struct TreeHits {
    nodes: HashMap<i64, Vec<(usize, usize, String)>>,
    effects: HashMap<i64, Vec<(usize, usize, String)>>,
    names: HashMap<i64, String>,
}

pub(super) fn line_hits(lines: &[String], origin: &str) -> Vec<(usize, usize, String)> {
    let d = data();
    let mut out = Vec::new();
    for l in lines {
        for p in d.mods.matches(l) {
            let (s, k) = d.mod_owner[p];
            out.push((s, k, if origin.is_empty() { l.clone() } else { format!("{origin}: {l}") }));
        }
    }
    out
}

/// The lines of an item's text (escaped or not) that can be a config source: its modifier lines of the variant it is.
pub(super) fn item_lines(xml: &str) -> Vec<String> {
    // (the solver's skill groups sit in no item, so an item's "Socketed Gems are Supported by Fortify" never reaches them)
    super::items::active_lines(xml).into_iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty() && !l.to_ascii_lowercase().starts_with("socketed")).collect()
}

pub(super) fn input_xml(key: &str, v: &Value) -> Option<String> {
    let k = crate::edit::esc(key);
    match v {
        Value::Bool(true) => Some(format!("<Input name=\"{k}\" boolean=\"true\"/>")),
        Value::Number(n) if n.as_f64().is_some_and(|x| x > 0.0) => Some(format!("<Input name=\"{k}\" number=\"{}\"/>", n)),
        Value::String(s) if s != "max" && s != "keep" && !s.starts_with('=') => Some(format!("<Input name=\"{k}\" string=\"{}\"/>", crate::edit::esc(s))),
        _ => None,
    }
}

impl Solver {
    /// Withered stacks the main skill's own hits keep up on one enemy (`wither_gen`): chance lines on the allocated tree
    /// and the worn items and jewels, and the main link's gem chances, at the hits a second of `vals`.
    pub(super) fn wither_on_hit(&self, st: &State, nodes: &[i64], vals: &Vals) -> f64 {
        let val = |k: &str| self.scorer.names.iter().position(|n| n == k).and_then(|i| vals.get(i).copied().flatten());
        let hits = val("Speed").unwrap_or(0.0) * val("HitChance").unwrap_or(100.0) / 100.0;
        if hits <= 0.0 {
            return 0.0;
        }
        let mut lines: Vec<String> = nodes.iter().flat_map(|&n| self.node_info(n).1.lines().map(String::from).collect::<Vec<_>>()).collect();
        for (i, def) in self.slots.iter().enumerate() {
            if def.kind != SlotKind::Flask {
                lines.extend(st.gear.pieces.get(i).cloned().flatten().map(|p| item_lines(&p.xml)).unwrap_or_default());
            }
        }
        for so in st.gear.sockets.iter().filter(|so| nodes.contains(&so.node)) {
            lines.extend(item_lines(&so.xml));
        }
        let gems: f64 = st.main.iter().map(|g| gem_wither_chance(g)).sum();
        wither_gen(&lines, gems, hits)
    }

    fn tree_hits(&self) -> &'static TreeHits {
        self.cfg_tree.get_or_init(|| self.load_tree_hits())
    }

    fn load_tree_hits(&self) -> &'static TreeHits {
        static T: OnceLock<Mutex<HashMap<String, &'static TreeHits>>> = OnceLock::new();
        let ver = tag_attr(&self.base_xml, "Spec", "treeVersion").unwrap_or_else(|| "3_29".into());
        let mut m = T.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        if let Some(t) = m.get(&ver) {
            return t;
        }
        let mut h = TreeHits::default();
        if let Ok(t) = crate::cached_tree(&ver) {
            for (&id, n) in t.nodes.iter() {
                let name = n.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if n.get("isKeystone").and_then(|v| v.as_bool()).unwrap_or(false) {
                    h.names.insert(id, name.clone());
                }
                let stats = n.get("stats").map(|v| pom_passives::treedata::str_list(t.deref(v))).unwrap_or_default();
                let hits = line_hits(&stats, &name);
                if !hits.is_empty() {
                    h.nodes.insert(id, hits);
                }
                for e in n.get("masteryEffects").map(|v| t.deref(v)).and_then(|v| v.as_array()).into_iter().flatten() {
                    let e = t.deref(e);
                    let Some(eid) = e.get("effect").and_then(|v| v.as_i64()) else { continue };
                    let stats = e.get("stats").map(|v| pom_passives::treedata::str_list(t.deref(v))).unwrap_or_default();
                    let hits = line_hits(&stats, &format!("{name} mastery"));
                    if !hits.is_empty() {
                        h.effects.insert(eid, hits);
                    }
                }
            }
        }
        let leaked: &'static TreeHits = Box::leak(Box::new(h));
        m.insert(ver, leaked);
        leaked
    }

    /// An item's text matched once (memo by its text).
    fn item_hits(&self, xml: &Arc<String>, name: &str) -> Arc<Vec<(usize, usize, String)>> {
        if let Some(h) = self.cfg_items.borrow().get(xml.as_str()) {
            return h.clone();
        }
        let h = Arc::new(line_hits(&item_lines(xml), name));
        self.cfg_items.borrow_mut().insert(xml.to_string(), h.clone());
        h
    }

    /// The base type of the weapon in the state's main-hand slot.
    fn weapon_slot_type(&self, st: &State) -> Option<String> {
        let i = self.slot_of(SlotKind::Weapon1)?;
        st.gear.pieces.get(i)?.as_ref().map(|p| p.item_type.clone())
    }

    /// The main skill's tags (config-sources.json `tags`) for a state; `vals` is its last whole evaluation.
    pub(super) fn config_tags(&self, st: &State, vals: &Vals) -> HashSet<String> {
        let mut t: HashSet<String> = HashSet::default();
        // (the fight: fresh packs while mapping, a unique enemy in a boss fight)
        let a = &self.goal.assume;
        if a.mode().profile().kill_effects && !a.single_target {
            t.insert("mapping".into());
        }
        if a.mode() != PlayMode::Mapping {
            t.insert("bossFight".into());
        }
        let gems = &gd::game_data().gems;
        let tag = |id: &str, k: &str| gems.get(id).is_some_and(|g| g.tags.get(k).copied().unwrap_or(false));
        let main = self.main_gem;
        for k in ["attack", "spell", "melee", "strike", "slam", "projectile", "channelling", "totem", "trap", "mine", "minion", "brand", "herald", "link", "fire", "cold", "chaining", "mark"] {
            if tag(main, k) {
                t.insert(k.into());
            }
        }
        // (a mark curses one enemy: "mark", never "curse")
        if (tag(main, "hex") || tag(main, "curse")) && !tag(main, "mark") {
            t.insert("curse".into());
        }
        t.insert(format!("mainSkill:{}", gem_name(main)));
        for &g in st.main.iter().filter(|&&g| g != main) {
            let n = gem_name(g);
            t.insert(format!("support:{n}"));
            for k in ["totem", "trap", "mine"] {
                if tag(g, k) {
                    t.insert(k.into());
                    if k == "totem" {
                        t.insert("supportTotem".into());
                    }
                }
            }
            match n.as_str() {
                "Fork" => {
                    t.insert("forking".into());
                }
                "Chain" => {
                    t.insert("chaining".into());
                }
                "Pierce" => {
                    t.insert("piercing".into());
                }
                "Lifetap" | "Blood Magic" => {
                    t.insert("costsLife".into());
                }
                _ => {}
            }
        }
        let mut all: Vec<&str> = vec![main];
        for u in &st.utils {
            all.extend(u.split('+'));
        }
        for g in all {
            t.insert(format!("skill:{}", gem_name(g)));
            if g != main {
                if (tag(g, "hex") || tag(g, "curse")) && !tag(g, "mark") {
                    t.insert("curse".into());
                }
                if tag(g, "mark") {
                    t.insert("mark".into());
                }
            }
            if tag(g, "warcry") {
                t.insert("hasWarcry".into());
            }
            // (a gem the build's weapon cannot use, e.g. Chain Hook with no weapon, never moves the player)
            let usable = gems.get(g).and_then(gd::gem_primary_effect).and_then(gd::weapon_types).is_none_or(|w| self.weapon_slot_type(st).is_some_and(|t| w.contains(&t)));
            if usable && tag(g, "movement") {
                t.insert("hasMovementSkill".into());
            }
            if usable && tag(g, "travel") {
                t.insert("hasTravelSkill".into());
            }
        }
        // (a worn item's curse aura curses every pack too; a flask only when the evaluation counts it as up)
        let mask = self.flask_mask_of(vals).unwrap_or(st.gear.flask_mask);
        let up = |i: usize| self.slots[i].kind != SlotKind::Flask || self.slots[i].name.rsplit(' ').next().and_then(|x| x.parse::<usize>().ok()).is_some_and(|n| mask & (1 << (n - 1)) != 0);
        if st.gear.pieces.iter().enumerate().any(|(i, p)| p.as_ref().is_some_and(|p| up(i) && items::grants_curse_aura(&p.xml))) {
            t.insert("curse".into());
        }
        // (an attack hits with the weapon unless its weaponTypes allow none)
        if t.contains("attack") && !self.unarmed() {
            t.insert("weaponHit".into());
        }
        let used_by_player = !["totem", "trap", "mine", "minion"].iter().any(|k| t.contains(*k));
        if used_by_player {
            t.insert("selfOrTriggered".into());
            if t.contains("spell") && !tag(main, "trigger") {
                t.insert("selfCast".into());
            }
        }
        // (from the last whole evaluation; without one, hit skills are assumed to hit)
        let v = |k: &str| self.scorer.names.iter().position(|n| n == k).and_then(|i| vals.get(i).copied().flatten());
        let pos = |k: &str| v(k).is_some_and(|x| x > 0.0);
        if vals.is_empty() {
            if t.contains("attack") || t.contains("spell") {
                t.insert("hit".into());
            }
        } else {
            for (k, s) in [("hit", "AverageHit"), ("fireHit", "FireHitAverage"), ("coldHit", "ColdHitAverage"), ("lightningHit", "LightningHitAverage")] {
                if pos(s) {
                    t.insert(k.into());
                }
            }
            // An ailment counts when the build applies it reliably: a quarter of hits or more (a crit-only shock on a
            // 5% crit build does not keep the enemy shocked).
            let often = |c: &str| v(c).is_some_and(|x| x >= 25.0);
            for (k, dps, chance) in [("poison", Some("PoisonDPS"), "PoisonChance"), ("bleed", Some("BleedDPS"), "BleedChance"), ("ignite", Some("IgniteDPS"), "IgniteChance"), ("shock", None, "ShockChance"), ("freeze", None, "FreezeChance"), ("impale", None, "ImpaleChance")] {
                // (shock and freeze need lightning and cold damage: upstream reports their chance on a physical hit too)
                // shortcut: "Physical Damage can Shock" and the like are not read; add them if a build relies on one.
                let can = match k {
                    "shock" => pos("LightningHitAverage"),
                    "freeze" => pos("ColdHitAverage"),
                    _ => true,
                };
                if dps.is_none_or(|d| pos(d)) && often(chance) && can {
                    t.insert(k.into());
                }
            }
            if pos("TotalDotDPS") || ["poison", "bleed", "ignite"].iter().any(|k| t.contains(*k)) {
                t.insert("dot".into());
            }
            if t.contains("ignite") {
                t.insert("burning".into());
            }
        }
        t
    }

    /// The switches state `st` sets, and the close calls it is offered, with `vals` its last whole evaluation.
    pub(super) fn config_for(&self, st: &State, vals: &Vals) -> Cfg {
        let d = data();
        let mapping = self.goal.assume.mode().profile().kill_effects && !self.goal.assume.single_target;
        let mode = if mapping { "mapping" } else { "bossing" };
        let tags = self.config_tags(st, vals);
        let flagged = self.cfg_flagged.borrow();
        let player: HashSet<&str> = self.goal.assume.config_on.iter().map(|s| s.as_str()).collect();
        // Sources the state has: (switch, source) -> what it is.
        let mut has: HashMap<(usize, usize), String> = HashMap::default();
        let th = self.tree_hits();
        let mut keystones: HashSet<String> = HashSet::default();
        for n in &st.nodes {
            if let Some(h) = th.nodes.get(n) {
                for (s, k, l) in h {
                    if d.line_applies(l, &tags) {
                        has.entry((*s, *k)).or_insert_with(|| l.clone());
                    }
                }
            }
            if let Some(k) = th.names.get(n) {
                keystones.insert(k.clone());
            }
        }
        for (n, e) in &st.masteries {
            if st.nodes.contains(n) {
                for (s, k, l) in th.effects.get(e).into_iter().flatten() {
                    if d.line_applies(l, &tags) {
                        has.entry((*s, *k)).or_insert_with(|| l.clone());
                    }
                }
            }
        }
        let mut items: Vec<String> = Vec::new();
        // (a flask is a source only when the evaluation counted it as sustained; one up part of the time is credited at
        // its uptime by the evaluation's own mix, its buff with it)
        let flask_mask = self.flask_mask_of(vals).unwrap_or(st.gear.flask_mask);
        for (i, def) in self.slots.iter().enumerate() {
            let Some(p) = st.gear.pieces.get(i).cloned().flatten() else { continue };
            if def.kind == SlotKind::Flask {
                let n: usize = def.name.rsplit(' ').next().and_then(|x| x.parse().ok()).unwrap_or(1);
                if flask_mask & (1 << (n - 1)) == 0 {
                    continue;
                }
            }
            let name = p.unique_name().map(String::from).or_else(|| p.base().map(|b| b.name.clone())).unwrap_or_else(|| p.label.split(" (").next().unwrap_or("").to_string());
            for (s, k, l) in self.item_hits(&p.xml, &name).iter() {
                if d.line_applies(l, &tags) {
                    has.entry((*s, *k)).or_insert_with(|| l.clone());
                }
            }
            items.push(name);
        }
        for so in &st.gear.sockets {
            if st.nodes.contains(&so.node) {
                for (s, k, l) in self.item_hits(&so.xml, &so.label).iter() {
                    if d.line_applies(l, &tags) {
                        has.entry((*s, *k)).or_insert_with(|| l.clone());
                    }
                }
            }
        }
        let gem_names: Vec<String> = st.main.iter().chain(st.utils.iter()).flat_map(|g| g.split('+')).map(gem_name).collect();
        let supports: Vec<String> = st.main.iter().filter(|&&g| g != self.main_gem).map(|g| gem_name(g)).collect();
        let val = |k: &str| self.scorer.names.iter().position(|n| n == k).and_then(|i| vals.get(i).copied().flatten());
        let ks_set: HashSet<String> = keystones.iter().map(|k| k.replace(' ', "")).collect();
        let mut decided: HashMap<String, bool> = HashMap::default();
        let mut out = Cfg::default();
        let id = |k: &str, decided: &HashMap<String, bool>| -> Option<f64> {
            if ks_set.contains(k) {
                return Some(1.0);
            }
            if let Some(b) = decided.get(k) {
                return Some(if *b { 1.0 } else { 0.0 });
            }
            if d.sw.iter().any(|s| s.key == k) {
                return Some(0.0);
            }
            if vals.is_empty() {
                return None;
            }
            Some(val(k).unwrap_or(0.0))
        };
        // A value from the file: '=expr' over the last evaluation, else the literal.
        let resolve = |v: &Value, ty: &str, decided: &HashMap<String, bool>| -> Value {
            match v.as_str().and_then(|x| x.strip_prefix('=')) {
                Some(e) => match Expr::parse(e).and_then(|e| e.eval(&|k| id(k, decided))) {
                    Some(x) if ty == "check" => Value::Bool(x != 0.0),
                    Some(x) => json!(x.round().max(0.0) as i64),
                    None => Value::Null,
                },
                None => v.clone(),
            }
        };
        // The Frenzy Charges the setup keeps up (its generation against what the main skill spends).
        let frenzy = d.sw.iter().position(|w| w.key == "useFrenzyCharges").map(|fi| {
            let speed = val("Speed").unwrap_or(1.0);
            let crit = val("CritChance").unwrap_or(0.0) / 100.0;
            let lines: Vec<String> = has.iter().filter(|((i, _), _)| *i == fi).map(|(_, l)| l.clone()).collect();
            let mut gen = frenzy_gen(&lines, speed, crit, mapping);
            gen += skill_frenzy_on_hit(self.main_gem) * speed;
            if mapping {
                let effects: Vec<&pom_engine::data::gems::GrantedEffect> = st.main.iter().chain(st.utils.iter()).flat_map(|g| g.split('+')).filter_map(|g| gd::game_data().gems.get(g).and_then(gd::gem_primary_effect)).collect();
                gen += gem_frenzy_on_kill(&effects, MAPPING_KILL_CHARGES);
            }
            let spend = if spends_frenzy(&d.sw, &gem_name(self.main_gem)) { uses_per_sec(speed, val("Repeats").unwrap_or(1.0)) } else { 0.0 };
            let (max, min) = (val("FrenzyChargesMax").unwrap_or(3.0), val("FrenzyChargesMin").unwrap_or(0.0));
            // (a worn item that consumes the charges the main skill spends empties the stock on each use: one at most)
            // (a flask only when the evaluation drinks it, as the sources above)
            let eats = spend > 0.0
                && self.slots.iter().enumerate().any(|(i, def)| {
                    let Some(p) = st.gear.pieces.get(i).and_then(|p| p.as_ref()) else { return false };
                    let off = def.kind == SlotKind::Flask && flask_mask & (1 << (def.name.rsplit(' ').next().and_then(|x| x.parse::<usize>().ok()).unwrap_or(1) - 1)) == 0;
                    !off && consumes_frenzy(&item_lines(&p.xml))
                });
            let n = frenzy_count(gen, spend, max, min);
            (if eats { n.min(1.max(min as u32)) } else { n }, max, gen, spend, eats)
        });
        // Two passes so `ref` sources and rules over other keys see the first pass.
        for pass in 0..2 {
            for (i, s) in d.sw.iter().enumerate() {
                if OWNED.contains(&s.key.as_str()) || (pass == 1 && decided.contains_key(&s.key)) {
                    continue;
                }
                let needs_ref = s.srcs.iter().any(|x| matches!(x.src, Src::Ref(_))) || s.on.is_some();
                if pass == 0 && needs_ref {
                    continue;
                }
                // (a switch for a skill the build does not use; the player's own switches still go on)
                if !s.if_skill.is_empty() && !s.if_skill.iter().any(|n| gem_names.iter().any(|g| g.eq_ignore_ascii_case(n))) && !player.contains(s.key.as_str()) {
                    decided.insert(s.key.clone(), false);
                    continue;
                }
                // ("Config assumptions" off: flasks, ailments and charges all off. The player's own switches only. Default Assume has
                // charges off, so charges alone cannot gate: the panel sends charges on with the assumptions.)
                let a = &self.goal.assume;
                if !player.contains(s.key.as_str()) && (!a.flasks && !a.ailments && !a.charges) {
                    decided.insert(s.key.clone(), false);
                    out.decided_off(&s.key);
                    continue;
                }
                // (value, reason, offer only, exempt)
                let mut got: Option<(Value, String, bool, bool)> = None;
                match s.class {
                    Class::Source if ALL_SOURCES.contains(&s.key.as_str()) => {
                        let why: Option<Vec<String>> = s
                            .srcs
                            .iter()
                            .map(|x| match &x.src {
                                Src::Skill(n) => gem_names.iter().any(|g| g.eq_ignore_ascii_case(n)).then(|| n.clone()),
                                Src::Ref(r) => decided.get(r).copied().unwrap_or(false).then(|| format!("{} is on", short_label(&d.sw.iter().find(|w| w.key == *r).map(|w| w.label.clone()).unwrap_or_default()))),
                                _ => None,
                            })
                            .collect();
                        if let Some(w) = why {
                            got = Some((resolve(&s.value, &s.ty, &decided), w.join(" + "), !s.high, s.ty == "check"));
                        }
                    }
                    Class::Source => {
                        for (k, x) in s.srcs.iter().enumerate() {
                            if !(if mapping { x.mapping } else { x.bossing }) || !x.need.iter().all(|n| tags.contains(n)) || x.not.iter().any(|n| tags.contains(n)) {
                                continue;
                            }
                            let why = match &x.src {
                                Src::Mod => has.get(&(i, k)).cloned(),
                                Src::Skill(n) => gem_names.iter().any(|g| g.eq_ignore_ascii_case(n)).then(|| n.clone()),
                                Src::Support(n) => supports.iter().any(|g| g.eq_ignore_ascii_case(n) || g.eq_ignore_ascii_case(&format!("{n} Support"))).then(|| format!("{n} support")),
                                Src::Keystone(n) => keystones.contains(n).then(|| n.clone()),
                                Src::Item(n) => items.iter().any(|g| g.eq_ignore_ascii_case(n)).then(|| n.clone()),
                                Src::Flag(f) => val(&format!("Solver.Flag.{f}")).is_some_and(|x| x > 0.5).then(|| "the build applies it".to_string()),
                                Src::Ref(r) => decided.get(r).copied().unwrap_or(false).then(|| format!("{} is on", short_label(&d.sw.iter().find(|w| w.key == *r).map(|w| w.label.clone()).unwrap_or_default()))),
                                Src::Unknown => None,
                            };
                            if let Some(w) = why {
                                let exempt = s.ty == "check" && matches!(x.src, Src::Skill(_) | Src::Support(_) | Src::Keystone(_) | Src::Item(_));
                                got = Some((resolve(&s.value, &s.ty, &decided), w, !s.high, exempt));
                                break;
                            }
                        }
                    }
                    Class::Playstyle => {
                        if let Some(c) = s.cases.iter().find(|c| c.when.iter().all(|w| tags.contains(w))) {
                            let v = resolve(if mapping { &c.mapping } else { &c.bossing }, &s.ty, &decided);
                            let what = if c.when.is_empty() { mode.to_string() } else { format!("{}, {mode}", c.when.join(" ").replace("mainSkill:", "").replace("support:", "")) };
                            got = Some((v, what, !s.high, false));
                        }
                    }
                    Class::Defence => {
                        let ev = |e: &Option<Expr>| e.as_ref().and_then(|e| e.eval(&|k| id(k, &decided))).is_some_and(|x| x != 0.0);
                        // (on in the text these numbers came from stays on: a defence the build has only while the switch
                        // is off, "maximum block if you have not Blocked Recently", would flip it on every other render)
                        let was_on = st.base.contains(&format!("<Input name=\"{}\" boolean=\"true\"", s.key));
                        if !ev(&s.off) && s.ty == "check" {
                            // (was_on is kept only while the rule still sees a close call: a "blocked recently" carried in from another build needs real block chance)
                            if ev(&s.on) || (was_on && ev(&s.close)) {
                                got = Some((Value::Bool(true), "your defences".into(), !s.high, false));
                            } else if ev(&s.close) {
                                got = Some((Value::Bool(true), "your defences (close call)".into(), true, false));
                            }
                        }
                    }
                    Class::Other => {}
                }
                // (the main skill's own chance to gain a charge on hit is a source too: its gem stat)
                if got.is_none() && s.key == "useFrenzyCharges" && skill_frenzy_on_hit(self.main_gem) > 0.0 {
                    got = Some((Value::Bool(true), format!("the main skill ({:.0}% chance on hit)", skill_frenzy_on_hit(self.main_gem) * 100.0), !s.high, false));
                }
                if let Some((n, max, gen, spend, eats)) = frenzy {
                    match s.key.as_str() {
                        "useFrenzyCharges" if n == 0 => got = None,
                        "overrideFrenzyCharges" if n > 0 && (n as f64) < max && decided.get("useFrenzyCharges") == Some(&true) => {
                            let why = if eats { format!("makes {gen:.1} a second, spends {spend:.1}; a worn item consumes them on use") } else { format!("makes {gen:.1} a second, spends {spend:.1}") };
                            got = Some((json!(n), why, false, false));
                        }
                        _ => {}
                    }
                }
                let is_player = player.contains(s.key.as_str());
                if is_player {
                    // (the player's switch: its own value when the rules give one, else on)
                    let v = got.as_ref().map(|g| g.0.clone()).filter(|v| input_xml(&s.key, v).is_some()).unwrap_or_else(|| if s.ty == "check" { Value::Bool(true) } else { s.value.clone() });
                    if let Some(x) = input_xml(&s.key, &v) {
                        decided.insert(s.key.clone(), true);
                        out.on.push(On { key: s.key.clone(), label: s.label.clone(), reason: "you turned it on".into(), xml: x, player: true, exempt: true, source: true });
                    }
                    continue;
                }
                let Some((v, why, offer, exempt)) = got else {
                    if pass == 1 || !needs_ref {
                        decided.insert(s.key.clone(), false);
                        out.decided_off(&s.key);
                    }
                    continue;
                };
                let Some(x) = input_xml(&s.key, &v) else {
                    decided.insert(s.key.clone(), false);
                    out.decided_off(&s.key);
                    continue;
                };
                let shown = match &v {
                    Value::Bool(_) => why,
                    _ => format!("{} ({why})", v.as_str().map(String::from).unwrap_or_else(|| v.to_string())),
                };
                let o = On { key: s.key.clone(), label: s.label.clone(), reason: shown, xml: x, player: false, exempt, source: s.class == Class::Source };
                if offer || flagged.contains(&(st.lead, s.key.clone())) {
                    decided.insert(s.key.clone(), false);
                    out.decided_off(&s.key);
                    // (upstream hides a switch whose flag the build lacks, e.g. Rampage without a Rampage source: no offer.
                    // Only offers are gated: some flags live on the skill, not the player, so an "on" stays measured.)
                    let shown = s.if_flag.as_ref().is_none_or(|f| vals.is_empty() || val(&format!("Solver.Flag.{f}")).is_some_and(|x| x > 0.5));
                    if shown {
                        out.offers.push(o);
                    }
                } else {
                    decided.insert(s.key.clone(), true);
                    out.on.push(o);
                }
            }
        }
        // The enemy has the ailments this candidate applies reliably (the solve-wide ailment step reads only the first
        // state, often before the weapon that bleeds is in).
        if self.goal.assume.ailments {
            for (tag, key, chance) in [("bleed", "conditionEnemyBleeding", "BleedChance"), ("poison", "conditionEnemyPoisoned", "PoisonChance"), ("ignite", "conditionEnemyIgnited", "IgniteChance")] {
                if tags.contains(tag) && !self.base_xml.contains(&format!("name=\"{key}\"")) {
                    let label = d.sw.iter().find(|s| s.key == key).map(|s| s.label.clone()).unwrap_or_else(|| key.to_string());
                    let reason = format!("the main skill applies it ({:.0}% chance)", val(chance).unwrap_or(0.0));
                    out.on.push(On { key: key.into(), label, reason, xml: format!("<Input name=\"{key}\" boolean=\"true\"/>"), player: false, exempt: true, source: true });
                }
            }
        }
        out
    }

    /// Settles a result on its own numbers and measures each switch: `xml` (rendered from `st`) and its evaluation in,
    /// the final text, evaluation, switches kept on and offers out. A switch the solver turned on without a source of its
    /// own that, taken out with the switches it feeds, moves the weighted score by more than a quarter is turned off and
    /// offered instead, and stays off for the rest of the lead.
    pub(super) fn settle_config(&self, st: &State, mut xml: Arc<String>, mut vals: Vals) -> (Arc<String>, Vals, Vec<On>, Vec<(On, f64, String)>) {
        let ev = |x: &Arc<String>| -> Option<Vals> {
            if self.cancel.load(Ordering::Relaxed) {
                return None;
            }
            self.evals.fetch_add(1, Ordering::Relaxed);
            self.pool.eval(vec![Cand::Xml(x.clone())], &self.names, &self.cancel).pop().flatten()
        };
        // (the numbers in were scored in a search batch, whose buff uptime mix may carry another text's ratio)
        if let Some(v) = ev(&xml) {
            vals = v;
        }
        // '=expr' values and defence rules on the result's own numbers (once).
        let mut cfg = self.config_for(st, &vals);
        let used = format!("{}</Config>", self.setup_config_with(st, &st.vals));
        let now = format!("{}</Config>", self.setup_config_with(st, &vals));
        if now != used && xml.contains(&used) {
            let x2 = Arc::new(xml.replacen(&used, &now, 1));
            if let Some(v) = ev(&x2) {
                xml = x2;
                vals = v;
                cfg = self.config_for(st, &vals);
            }
        }
        let on: Vec<On> = cfg.on.iter().filter(|o| xml.contains(&o.xml)).cloned().collect();
        let offers = cfg.offers.clone();
        let sc = &self.scorer;
        // (relative change of each target from `a` to `b`; the biggest, with its text)
        let delta = |a: &Vals, b: &Vals| -> (f64, String) {
            let mut best = (0.0f64, String::new());
            for t in &sc.targets {
                let (x, y) = (sc.target_value(t, a), sc.target_value(t, b));
                let r = if x.abs() > 1e-9 { (y - x) / x.abs() } else if y.abs() > 1e-9 { 1.0 } else { 0.0 };
                if r.abs() > best.0.abs() {
                    best = (r, format!("{}{:.0}% {}", if r >= 0.0 { "+" } else { "" }, r * 100.0, t.name));
                }
            }
            best
        };
        let changed = |a: &Vals, b: &Vals| {
            a.iter().zip(b).any(|(a, b)| match (a, b) {
                (Some(a), Some(b)) => (a - b).abs() > 1e-6 * b.abs().max(1.0),
                (a, b) => a.is_some() != b.is_some(),
            })
        };
        let without = |keys: &[&On]| -> Cand {
            let mut x = xml.to_string();
            for o in keys {
                x = x.replacen(&o.xml, "", 1);
            }
            Cand::Xml(Arc::new(x))
        };
        let adding = |keys: &[&On]| -> Cand { Cand::Xml(Arc::new(xml.replacen("</Config>", &format!("{}</Config>", keys.iter().map(|o| o.xml.as_str()).collect::<String>()), 1))) };
        let run = |cands: Vec<Cand>| -> Vec<Option<Vals>> {
            if cands.is_empty() || self.cancel.load(Ordering::Relaxed) {
                return vec![None; cands.len()];
            }
            self.evals.fetch_add(cands.len() as u64, Ordering::Relaxed);
            self.pool.eval(cands, &self.names, &self.cancel)
        };
        // A switch and the switches whose source is it (config-sources.json `ref`: a bypass that spends its charges)
        // come out together.
        let d = data();
        let on_c = on.clone();
        let group = |o: &On| -> Vec<On> {
            let mut g = vec![o.clone()];
            g.extend(on_c.iter().cloned().filter(|x| x.key != o.key && d.sw.iter().any(|w| w.key == x.key && w.srcs.iter().any(|y| matches!(&y.src, Src::Ref(r) if *r == o.key)))));
            g
        };
        // (the goal's weighted score without the limits, per unit of weight: ln of the average target change)
        let wsum: f64 = sc.targets.iter().enumerate().map(|(k, t)| self.weights.get(k).copied().unwrap_or(t.weight)).sum::<f64>().max(1e-9);
        let worth = |v: &Vals| {
            let (s, viol) = sc.score(v, &self.weights);
            (s + sc.penalty * viol) / wsum
        };
        // All of the solver's switches off, and all offers on, first: most builds use few of them, so one each.
        let mine: Vec<&On> = on.iter().filter(|o| !o.player).collect();
        let all: Vec<&On> = offers.iter().collect();
        let mut g = Vec::new();
        if !mine.is_empty() {
            g.push(without(&mine));
        }
        if !all.is_empty() {
            g.push(adding(&all));
        }
        let gr = run(g);
        let mut gi = gr.into_iter();
        let on_matters = if mine.is_empty() { false } else { gi.next().flatten().is_none_or(|v| changed(&v, &vals)) };
        let offers_matter = if all.is_empty() { false } else { gi.next().flatten().is_none_or(|v| delta(&vals, &v).0.abs() >= 0.005) };
        let mut cands = Vec::new();
        if on_matters {
            cands.extend(on.iter().map(|o| without(&group(o).iter().collect::<Vec<_>>())));
        }
        if offers_matter {
            cands.extend(offers.iter().map(|o| adding(&[o])));
        }
        let res = run(cands);
        let n_on = if on_matters { on.len() } else { 0 };
        let on_all = on.clone();
        let mut kept = Vec::new();
        let mut out_offers = Vec::new();
        let mut drop = Vec::new();
        if offers_matter {
            for (k, o) in offers.into_iter().enumerate() {
                let Some(Some(with)) = res.get(n_on + k) else { continue };
                let (r, text) = delta(&vals, with);
                // (an offer that changes no target is not worth a chip)
                if r.abs() >= 0.005 {
                    out_offers.push((o, r, text));
                }
            }
        }
        for (k, o) in on.into_iter().enumerate() {
            let Some(Some(off)) = res.get(k).filter(|_| on_matters) else {
                if o.player || o.source {
                    kept.push(o);
                }
                continue;
            };
            let (r, text) = delta(off, &vals);
            // Only an assumption without a source of its own is held to the size guard; a sourced switch (an item, tree,
            // gem or keystone line the build has) stays on however much it adds.
            if !o.player && !o.exempt && !o.source && worth(&vals) - worth(off) > 1.25f64.ln() {
                self.cfg_flagged.borrow_mut().insert((st.lead, o.key.clone()));
                drop.extend(group(&o).iter().map(|g| g.xml.clone()));
                out_offers.push((o, r, text));
            } else if o.player || o.source || changed(off, &vals) {
                // (a playstyle or defence switch the build has no use for is left out of the list)
                kept.push(o);
            }
        }
        if !drop.is_empty() {
            let mut x2 = xml.to_string();
            for d in &drop {
                x2 = x2.replacen(d.as_str(), "", 1);
            }
            let x2 = Arc::new(x2);
            if let Some(v) = ev(&x2) {
                xml = x2;
                vals = v;
            }
        }
        // A switch that changes nothing on its own is not listed, so it comes out of the text too: nothing stays on that
        // the player is not told about. (When taking them all out together does change something, they all stay listed.)
        let silent: Vec<On> = on_all.into_iter().filter(|o| !o.player && !drop.contains(&o.xml) && !kept.iter().any(|k| k.key == o.key) && xml.contains(&o.xml)).collect();
        if !silent.is_empty() {
            let mut x2 = xml.to_string();
            for o in &silent {
                x2 = x2.replacen(o.xml.as_str(), "", 1);
            }
            let x2 = Arc::new(x2);
            match ev(&x2) {
                Some(v) if !changed(&v, &vals) => {
                    xml = x2;
                    vals = v;
                }
                _ => kept.extend(silent),
            }
        }
        out_offers.sort_by(|a, b| b.1.abs().partial_cmp(&a.1.abs()).unwrap_or(std::cmp::Ordering::Equal));
        (xml, vals, kept, out_offers)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solver_for(goal: &str) -> Solver {
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
    }

    fn state(s: &mut Solver, utils: Vec<&'static str>, supports: Vec<&'static str>) -> State {
        let c = s.candidates().unwrap();
        let mut main = vec![s.main_gem];
        main.extend(supports);
        s.initial_state(c[0], Some((main, utils)), None).unwrap()
    }

    /// Fortify needs a melee skill (sup_str.lua requireSkillTypes Melee): on Righteous Fire it is not Fortified.
    #[test]
    fn fortified_needs_a_melee_skill() {
        let mut s = solver_for(r#"{"skill":"Righteous Fire","level":90}"#);
        let st = state(&mut s, vec![], vec![find_gem("Fortify").unwrap()]);
        assert!(!s.config_for(&st, &st.vals).on.iter().any(|o| o.key == "buffFortification"));
    }

    /// Honesty 1: a single-target DPS goal never counts kill-fed switches or kill-fed flask uptime, in mapping too; a clear-only goal keeps them.
    #[test]
    fn single_target_goal_counts_no_kills() {
        let on = |targets: &str| {
            let mut s = solver_for(&format!(r#"{{"skill":"Cleave","level":90,"assume":{{"playMode":"mapping"}},"targets":[{targets}]}}"#));
            let st = state(&mut s, vec![], vec![]);
            (s.config_for(&st, &st.vals).on.iter().any(|o| o.key == "conditionKilledRecently"), s.goal.assume.drain_stat())
        };
        assert_eq!(on(r#"{"name":"DPS","metric":"dps"}"#), (false, "Solver.FlaskDrainUptime"));
        assert_eq!(on(r#"{"name":"Clear","metric":"clear"}"#), (true, "Solver.FlaskDrainUptimeMap"));
    }

    /// Honesty: Flicker Strike spends a Frenzy Charge per use to skip its
    /// cooldown. Its own 25% on hit makes 1.0 a second against 1.33 spent (three hits a use): it holds no charges, so no
    /// charge count, no bypass and no "gained recently". Four hits a use make what it spends: all three come on.
    #[test]
    fn flicker_charges_need_generation_over_spending() {
        let on = |repeats: f64| {
            let mut s = solver_for(r#"{"skill":"Flicker Strike","level":90,"assume":{"playMode":"mapping"},"targets":[{"name":"DPS","metric":"combined"}]}"#);
            let st = state(&mut s, vec![], vec![]);
            let mut v: Vals = vec![None; s.scorer.names.len()];
            for (k, x) in [("Speed", 4.0), ("Repeats", repeats), ("HitChance", 100.0), ("FrenzyChargesMax", 3.0), ("FrenzyChargesMin", 0.0)] {
                v[s.scorer.names.iter().position(|n| n == k).unwrap()] = Some(x);
            }
            let c = s.config_for(&st, &v);
            (c.on.iter().map(|o| o.key.clone()).collect::<Vec<_>>(), c.xml())
        };
        let (short, xml) = on(3.0);
        // (upstream has the bypass on by default: off is written out)
        assert!(xml.contains(r#"<Input name="FlickerStrikeBypassCD" boolean="false"/>"#), "{xml}");
        for k in ["useFrenzyCharges", "overrideFrenzyCharges", "FlickerStrikeBypassCD", "conditionGainedFrenzyChargeRecently"] {
            assert!(!short.contains(&k.to_string()), "{k} on while spending more than it makes: {short:?}");
        }
        let (kept, _) = on(4.0);
        for k in ["useFrenzyCharges", "FlickerStrikeBypassCD"] {
            assert!(kept.contains(&k.to_string()), "{k} off while making what it spends: {kept:?}");
        }
    }

    /// Honesty: "Crush Enemies ... when you Hit them while they are on Full Life" (a Flicker Strike solve, Vanquisher) holds for a
    /// fresh pack's first hit, never through a single-target fight.
    #[test]
    fn full_life_enemy_lines_count_while_mapping_only() {
        let l = "Vanquisher: Crush Enemies for 4 seconds when you Hit them while they are on Full Life";
        let tags = |t: &[&str]| t.iter().map(|x| x.to_string()).collect::<HashSet<String>>();
        assert!(!data().line_applies(l, &tags(&["melee", "attack"])));
        assert!(data().line_applies(l, &tags(&["melee", "attack", "mapping"])));
    }

    /// Honesty (RF ES regen only with a rare nearby, pconc "1 (bossing)" on a map monster): a rare or unique is nearby
    /// in a boss fight only; mapping sustain and a single map enemy read none.
    #[test]
    fn rare_nearby_only_in_a_boss_fight() {
        let on = |goal: &str| {
            let mut s = solver_for(goal);
            let st = state(&mut s, vec![], vec![]);
            s.config_for(&st, &st.vals).on.iter().any(|o| o.key == "multiplierNearbyRareOrUniqueEnemies")
        };
        assert!(!on(r#"{"skill":"Righteous Fire","level":90,"assume":{"playMode":"mapping"},"targets":[{"name":"Clear","metric":"clear"}]}"#));
        assert!(!on(r#"{"skill":"Righteous Fire","level":90,"assume":{"playMode":"mapping"},"targets":[{"name":"DPS","metric":"combined"}]}"#));
        assert!(on(r#"{"skill":"Righteous Fire","level":90,"assume":{"playMode":"bossing"}}"#));
    }

    /// Honesty 2: "Blocked Recently" carried in on the text stays only while the build has block chance.
    #[test]
    fn blocked_recently_needs_block_chance() {
        let mut s = solver_for(r#"{"skill":"Cleave","level":90,"assume":{"playMode":"bossing"}}"#);
        let mut st = state(&mut s, vec![], vec![]);
        st.base = Arc::new(st.base.replace("</Config>", r#"<Input name="conditionBlockedRecently" boolean="true"/></Config>"#));
        assert!(st.base.contains("conditionBlockedRecently"));
        assert!(!s.config_for(&st, &st.vals).on.iter().any(|o| o.key == "conditionBlockedRecently"));
    }

    /// A source line gated by its own wording (pconc solve): "Melee Hits which Stun Fortify" needs a melee main
    /// skill, and charges "on Hitting an Enemy with no Armour / Evasion Rating" need an enemy a map or boss is not. A
    /// melee main keeps the melee line.
    #[test]
    fn source_lines_gated_by_their_wording() {
        let belt = "Rarity: UNIQUE\nPerseverance\nVanguard Belt\nVariant: Pre 3.16.0\nVariant: Current\nImplicits: 1\n+(260-320) to Armour and Evasion Rating\n(4-8)% increased maximum Life\n+(20-40)% to Cold Resistance\n1% increased Attack Damage per 200 of the lowest of Armour and Evasion Rating\n{variant:1}Melee Hits which Stun have (14-20)% chance to Fortify\n{variant:2}Melee Hits which Stun Fortify\nYou have Onslaught while Fortified";
        let gloves = "Rarity: UNIQUE\nCeaseless Feast\nSpiked Gloves\nImplicits: 1\n(16-20)% increased Melee Damage\nAdds (2-3) to (22-26) Physical Damage to Attacks\n(100-150)% increased Armour\n(20-30)% chance to inflict Corrosion on Hit with Attacks\n(20-30)% chance to gain an Endurance Charge on Hitting an Enemy with no Armour\n(20-30)% chance to gain a Frenzy Charge on Hitting an Enemy with no Evasion Rating";
        let on = |skill: &str| {
            let mut s = solver_for(&format!(r#"{{"skill":"{skill}","level":90,"assume":{{"charges":true}}}}"#));
            let mut st = state(&mut s, vec![], vec![]);
            let mut g = (*st.gear).clone();
            for (kind, x) in [(SlotKind::Belt, belt), (SlotKind::Gloves, gloves)] {
                g.pieces[s.slot_of(kind).unwrap()] = Some(items::player_piece(&Arc::new(x.to_string())));
            }
            st.gear = Arc::new(g);
            s.config_for(&st, &st.vals).on.into_iter().map(|o| (o.key, o.reason)).collect::<Vec<_>>()
        };
        let pconc = on("Poisonous Concoction");
        for k in ["buffFortification", "useFrenzyCharges", "useEnduranceCharges"] {
            assert!(!pconc.iter().any(|o| o.0 == k), "{k} on for pconc: {pconc:?}");
        }
        let flicker = on("Flicker Strike");
        assert!(flicker.iter().any(|o| o.0 == "buffFortification"), "melee main loses the melee line: {flicker:?}");
    }

    /// An attack whose weaponTypes allow no weapon (Poisonous Concoction: "None") never hits with a weapon: no "Hit
    /// Recently with Your Weapon" (pconc solve). A weapon attack keeps it.
    #[test]
    fn unarmed_attack_never_hits_with_a_weapon() {
        let on = |skill: &str| {
            let mut s = solver_for(&format!(r#"{{"skill":"{skill}","level":90}}"#));
            let st = state(&mut s, vec![], vec![]);
            s.config_for(&st, &st.vals).on.into_iter().map(|o| o.key).collect::<Vec<_>>()
        };
        let pconc = on("Poisonous Concoction");
        assert!(!pconc.iter().any(|k| k == "conditionHitRecentlyWithWeapon"), "{pconc:?}");
        let flicker = on("Flicker Strike");
        assert!(flicker.iter().any(|k| k == "conditionHitRecentlyWithWeapon"), "{flicker:?}");
    }

    /// Trinity's damage scales with the lowest resonance, which upstream reads from a count box that is 0 when empty: the
    /// support itself sources the cap, but only when the hit has all three elements (skill package solve, Lightning Arrow).
    #[test]
    fn trinity_sources_resonance_when_the_hit_has_three_elements() {
        let mut s = solver_for(r#"{"skill":"Lightning Arrow","level":90}"#);
        let st = state(&mut s, vec![], vec![find_gem("Trinity").unwrap()]);
        let key = |s: &Solver, v: &Vals| s.config_for(&st, v).on.into_iter().find(|o| o.key == "configResonanceCount").map(|o| o.xml);
        let with = |els: [f64; 3]| -> Vals {
            let mut v = st.vals.clone();
            for (n, x) in ["FireHitAverage", "ColdHitAverage", "LightningHitAverage"].iter().zip(els) {
                v[s.scorer.names.iter().position(|m| m == n).unwrap()] = Some(x);
            }
            v
        };
        assert_eq!(key(&s, &with([100.0, 100.0, 100.0])).as_deref(), Some(r#"<Input name="configResonanceCount" number="50"/>"#));
        assert_eq!(key(&s, &with([0.0, 0.0, 100.0])), None, "a mono-element hit never builds the other resonances");
    }

    /// Withering Step's Elusive ends on every skill use: a build that attacks constantly does not have it.
    #[test]
    fn elusive_off_for_constant_attackers() {
        let mut s = solver_for(r#"{"skill":"Tornado Shot","level":90}"#);
        let st = state(&mut s, vec![find_gem("Withering Step").unwrap()], vec![]);
        assert!(!s.config_for(&st, &st.vals).on.iter().any(|o| o.key == "buffElusive"));
    }

    /// Chain Hook needs a one-handed weapon: with none equipped it sets no movement-skill tag.
    #[test]
    fn unusable_movement_gem_sets_no_tag() {
        let mut s = solver_for(r#"{"skill":"Tornado Shot","level":90}"#);
        let hook = find_gem("Chain Hook").unwrap();
        assert!(gd::game_data().gems.get(hook).and_then(gd::gem_primary_effect).and_then(gd::weapon_types).is_some(), "Chain Hook has a weapon requirement");
        let st = state(&mut s, vec![hook], vec![]);
        assert!(!s.config_tags(&st, &st.vals).contains("hasMovementSkill"));
    }
    /// List switches are written with upstream's list values (INC, MAX, SAND), not their labels: a label upstream does not know does
    /// nothing, and the result still says the setting is on.
    #[test]
    fn list_switch_values_are_option_values() {
        for s in &data().sw {
            if s.ty != "list" {
                continue;
            }
            let Some(meta) = pom_config::gen::defaults::ALL_OPTION_DEFAULTS.iter().find(|m| m.var == s.key) else { panic!("{} is not a known option", s.key) };
            for c in &s.cases {
                for v in [&c.mapping, &c.bossing] {
                    let Some(x) = v.as_str().filter(|x| !x.starts_with('=')) else { continue };
                    assert!(meta.list_vals.iter().any(|l| matches!(l, pom_config::types::OptionValue::Str(y) if *y == x)), "{} writes {x}, the list is {:?}", s.key, meta.list_vals);
                }
            }
        }
    }

    /// "Config assumptions" off (flasks, ailments and charges off): the solver sets no switch of its own.
    #[test]
    fn assumptions_off_sets_no_switches() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","level":90,"assume":{"flasks":false,"ailments":false,"charges":false}}"#);
        let st = state(&mut s, vec![], vec![find_gem("Fortify").unwrap()]);
        let on = s.config_for(&st, &st.vals).on;
        assert!(on.is_empty(), "{:?}", on.iter().map(|o| &o.key).collect::<Vec<_>>());
    }

    /// A switch upstream turns on by default (Flicker Strike's bypass cooldown) is written off when the build has no frenzy
    /// charge source; left out of the text, upstream's default would turn it on again.
    #[test]
    fn default_on_switch_is_written_off() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","level":90}"#);
        let st = state(&mut s, vec![], vec![]);
        let x = s.config_for(&st, &st.vals).xml();
        assert!(x.contains(r#"<Input name="FlickerStrikeBypassCD" boolean="false"/>"#), "{x}");
    }
    /// Templar Flicker (bossing) with Immortal Call and Terminus Est ("Gain a Frenzy Charge on Critical Strike"): the
    /// charge switch has a real source and the bypass depends on it, so settling keeps both on. Taking out a switch
    /// that moves no engine number measures 0 ("+26% EHP" read on unrelated switches).
    #[test]
    fn sourced_charge_switch_and_its_bypass_stay_on() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"},{"name":"EHP","metric":"ehp"}],"wealth":"mid-league","assume":{"flasks":true,"flaskUptime":"bossing","playMode":"bossing","ailments":true,"charges":true}}"#);
        let ic = find_gem("Immortal Call").unwrap();
        // (with Multistrike, as the gap's build: three hits per use keep the charges up)
        let st = state(&mut s, vec![ic], vec![find_gem("Multistrike").unwrap()]);
        let u = s.uniques.iter().find(|u| u.name == "Terminus Est").cloned().expect("Terminus Est");
        let mut st = s.with_weapon(&st, &items::unique_piece(&u)).expect("wears Terminus Est");
        s.rebase(&mut st).unwrap();
        println!("Speed/CritChance/Repeats {:?}", ["Speed", "CritChance", "Repeats"].map(|n| s.scorer.names.iter().position(|m| m == n).and_then(|i| st.vals[i])));
        let xml = Arc::new(s.render(&st).unwrap());
        assert!(xml.contains("Immortal Call"), "Immortal Call is in");
        let vals = s.eval(vec![Cand::Xml(xml.clone())]).pop().flatten().unwrap();
        let (_, _, on, offers) = s.settle_config(&st, xml, vals);
        let keys: Vec<&str> = on.iter().map(|o| o.key.as_str()).collect();
        for (o, d, t) in &offers {
            println!("offer {} {t} {d:.3}", o.key);
        }
        println!("on {keys:?}");
        assert!(keys.contains(&"useFrenzyCharges") && keys.contains(&"FlickerStrikeBypassCD"), "on {keys:?}");
        assert!(s.cfg_flagged.borrow().is_empty(), "flagged {:?}", s.cfg_flagged.borrow());
    }
    /// Flicker Strike with Multistrike and no other charge source: its own 25% chance on hit over three hits per use
    /// keeps most charges up, so charge use is on, sourced by the skill.
    #[test]
    fn skill_own_charge_on_hit_is_a_source() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"}],"assume":{"playMode":"bossing","charges":true}}"#);
        let ms = find_gem("Multistrike").unwrap();
        let st = state(&mut s, vec![], vec![ms]);
        let u = s.uniques.iter().find(|u| items::slot_types(SlotKind::Weapon1).contains(&u.item_type.as_str()) && s.weapon_ok(&u.item_type) && !u.xml.contains("Frenzy") && s.with_weapon(&st, &items::unique_piece(u)).is_some()).cloned().unwrap();
        let mut st = s.with_weapon(&st, &items::unique_piece(&u)).unwrap();
        s.rebase(&mut st).unwrap();
        let c = s.config_for(&st, &st.vals);
        let f = c.on.iter().find(|o| o.key == "useFrenzyCharges").unwrap_or_else(|| panic!("charge use off: {:?} offers {:?} off {:?} vals {:?}", c.on.iter().map(|o| &o.key).collect::<Vec<_>>(), c.offers.iter().map(|o| &o.key).collect::<Vec<_>>(), c.off, ["Speed", "Repeats", "FrenzyChargesMax", "FrenzyChargesMin"].map(|n| s.scorer.names.iter().position(|m| m == n).and_then(|i| st.vals[i]))));
        println!("{} {}", f.key, f.reason);
        assert!(f.reason.contains("main skill") && f.source);
    }

    /// The bossing finish's Rotgut ("Consumes Frenzy Charges on use") beside Flicker Strike, which spends one per use:
    /// the stock the config counts is one charge, not the share of the maximum the skill alone keeps up.
    #[test]
    fn item_that_consumes_the_spent_charge_caps_the_stock() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"}],"assume":{"playMode":"bossing","charges":true}}"#);
        let st = state(&mut s, vec![], vec![find_gem("Multistrike").unwrap()]);
        let w = s.uniques.iter().find(|u| items::slot_types(SlotKind::Weapon1).contains(&u.item_type.as_str()) && s.weapon_ok(&u.item_type) && !u.xml.contains("Frenzy") && s.with_weapon(&st, &items::unique_piece(u)).is_some()).cloned().unwrap();
        let mut st = s.with_weapon(&st, &items::unique_piece(&w)).unwrap();
        let f = (0..s.slots.len()).rev().find(|&i| s.slots[i].kind == SlotKind::Flask && Some(i) != s.life_flask_slot() && Some(i) != s.mana_flask_slot()).unwrap();
        let rot = s.uniques.iter().find(|u| u.name == "Rotgut").cloned().expect("Rotgut");
        assert!(consumes_frenzy(&item_lines(&rot.xml)), "Rotgut's line is read");
        // (alone in the flask slots: the starting flasks out of the way)
        let mut g = (*st.gear).clone();
        for (i, _) in s.slots.iter().enumerate().filter(|(_, d)| d.kind == SlotKind::Flask) {
            g.held.retain(|&k| k != i);
            g.pieces[i] = None;
        }
        // (put on by hand: the item choice now refuses it beside a skill that spends the charge; the cap is the fallback
        // for a build that wears one anyway)
        g.pieces[f] = Some(items::unique_piece(&rot));
        st.gear = Arc::new(g);
        s.rebase(&mut st).unwrap();
        // (drunk: every flask in the evaluation's mask)
        let k = s.scorer.names.iter().position(|x| x == FLASK_MASK).expect("the mask is read");
        let mut v = st.vals.clone();
        v[k] = Some(0x1f as f64);
        let c = s.config_for(&st, &v);
        let o = c.on.iter().find(|o| o.key == "overrideFrenzyCharges");
        assert!(o.is_some_and(|o| o.xml.contains(r#"number="1""#)), "stock {:?}", c.on.iter().map(|o| (&o.key, &o.reason)).collect::<Vec<_>>());
        // (a Rotgut the evaluation never drinks consumes nothing)
        let n: usize = s.slots[f].name.rsplit(' ').next().and_then(|x| x.parse().ok()).unwrap();
        v[k] = Some((0x1f & !(1 << (n - 1))) as f64);
        let c = s.config_for(&st, &v);
        let o = c.on.iter().find(|o| o.key == "overrideFrenzyCharges");
        assert!(!o.is_some_and(|o| o.xml.contains(r#"number="1""#)), "an undrunk flask capped the stock: {:?}", o.map(|o| &o.reason));
    }

    /// A whole text reads its own Immortal Call uptime mix whatever the worker evaluated before it (whole texts are
    /// always measured on and off for real): another build in the same batch does not move it (a reused ratio once made
    /// unrelated switches read "+26% EHP").
    #[test]
    fn settle_scores_each_text_on_its_own_blend() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"},{"name":"EHP","metric":"ehp"}],"assume":{"playMode":"bossing","charges":true}}"#);
        let ic = find_gem("Immortal Call").unwrap();
        let st = state(&mut s, vec![ic], vec![]);
        let xml = s.render(&st).unwrap();
        let i = xml.find("<Gem nameSpec=\"Immortal Call\"").unwrap();
        let e = i + xml[i..].find('>').unwrap();
        let other = format!("{}{}{}", &xml[..i], xml[i..e].replacen("level=\"20\"", "level=\"1\"", 1), &xml[e..]);
        assert_ne!(other, xml);
        let pool = Pool::new(1, Arc::new(vec![("Immortal Call".to_string(), 0.25)]), Arc::new(Vec::new()));
        let names = s.names.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let alone = pool.eval(vec![Cand::Xml(Arc::new(xml.clone()))], &names, &cancel).pop().flatten().unwrap();
        let both = pool.eval(vec![Cand::Xml(Arc::new(other)), Cand::Xml(Arc::new(xml))], &names, &cancel);
        let ehp = s.scorer.targets.iter().find(|t| t.metric == "ehp").unwrap();
        let (a, b) = (s.scorer.target_value(ehp, &alone), s.scorer.target_value(ehp, both[1].as_ref().unwrap()));
        println!("EHP alone {a:.0}, after another build {b:.0}");
        assert!((a - b).abs() <= 1e-6 * a.abs().max(1.0), "{a} vs {b}");
    }

    /// A flask up part of the time is not a full-time source: the Phasing its buff grants is credited at its uptime by
    /// the evaluation's mix, so the switch stays off unless the evaluation counted the flask as sustained.
    #[test]
    fn part_time_flask_is_not_a_full_time_source() {
        let mut s = solver_for(r#"{"skill":"Flicker Strike","className":"Templar","level":90,"targets":[{"name":"DPS","metric":"boss"}],"assume":{"playMode":"bossing","flasks":true}}"#);
        let mut st = state(&mut s, vec![], vec![]);
        let fi = (0..s.slots.len()).rev().find(|&k| s.slots[k].kind == SlotKind::Flask && !s.slots[k].locked).unwrap();
        let n: usize = s.slots[fi].name.rsplit(' ').next().unwrap().parse().unwrap();
        let mut g = (*st.gear).clone();
        g.pieces[fi] = Some(s.empty_craft("Quartz Flask").unwrap());
        g.flask_mask = 0x1f;
        st.gear = Arc::new(g);
        let m = s.scorer.names.iter().position(|x| x == FLASK_MASK).unwrap();
        let on = |s: &Solver, mask: u8| {
            let mut v = st.vals.clone();
            v[m] = Some(mask as f64);
            s.config_for(&st, &v).on.iter().any(|o| o.key == "buffPhasing")
        };
        assert!(on(&s, 0x1f), "a sustained flask is a source");
        assert!(!on(&s, 0x1f & !(1 << (n - 1))), "a flask up part of the time counted full time");
    }

    /// Charge spend and charge on kill come from the data, not gem names: a gem with Blood Rage's stats under a new
    /// name grants the same charges on kill, and a skill whose bypass switch spends Frenzy Charges spends them under
    /// any name.
    #[test]
    fn frenzy_spend_and_kill_charges_read_the_data() {
        let br = gd::game_data().gems.values().find_map(|g| gd::gem_primary_effect(g).filter(|e| gd::stat_value(e, 20.0, GEM_QUALITY, "add_frenzy_charge_on_kill_%_chance") > 0.0)).expect("a gem with frenzy on kill");
        let mut renamed = br.clone();
        renamed.name = Some("Test Rage".into());
        renamed.id = Some("TestRage".into());
        assert!((gem_frenzy_on_kill(&[&renamed], 5.0) - gem_frenzy_on_kill(&[br], 5.0)).abs() < 1e-9 && gem_frenzy_on_kill(&[&renamed], 5.0) > 0.0);
        let bypass = |skill: &str| Sw { key: "TestBypassCD".into(), label: "Bypass CD".into(), ty: "check".into(), class: Class::Source, high: true, srcs: vec![SrcDef { src: Src::Ref("useFrenzyCharges".into()), mapping: true, bossing: true, need: Vec::new(), not: Vec::new() }], value: Value::Bool(true), cases: Vec::new(), on: None, close: None, off: None, if_skill: vec![skill.into()], if_flag: None };
        assert!(spends_frenzy(&[bypass("Test Strike")], "Test Strike") && !spends_frenzy(&[bypass("Test Strike")], "Cyclone"));
        let d = data();
        let spenders: Vec<&str> = d.sw.iter().filter(|s| s.srcs.iter().any(|x| matches!(&x.src, Src::Ref(r) if r == "useFrenzyCharges"))).flat_map(|s| s.if_skill.iter().map(|n| n.as_str())).collect();
        assert!(!spenders.is_empty() && spenders.iter().all(|n| spends_frenzy(&d.sw, n)), "{spenders:?}");
    }
}
