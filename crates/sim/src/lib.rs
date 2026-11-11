//! Boss fight simulator, v1: one boss, average mode.
//!
//! The upstream calculator (and this engine) is steady state: the player sets each condition by hand ("Is the enemy on Low Life?",
//! "# of Poison on enemy", charges, flasks) and gets one number. This steps a fight against one boss instead. At each
//! step it derives those config conditions from the fight's own state (enemy life, time since the fight began,
//! flask charges) and asks the engine for the numbers. Every distinct condition state is calculated once and kept,
//! so a fight costs (distinct states) x (one engine calculation), not ticks x calculation.
//!
//! Damage-over-time ailments ramp in this layer from the engine's own outputs: the engine's ailment DPS is the
//! steady state (stacks = application rate x duration), so at time t the stacks are rate x min(t, duration), capped
//! at the engine's max stacks.
//!
//! Boss life comes from the game files (`engine-data/data_bossLife.json`, exported from the game data):
//! monster life at the enemy's level x the boss's own life multiplier x the Unique rarity life x (1 + (map boss +
//! map life percent)/100) x the enemy's More Life. `bossName` picks one boss from that data; without it the
//! Pinnacle/Uber preset uses the median pinnacle boss.
use pom_engine::modifier::ModType;
use pom_engine::sym::Sym;
use pom_pipeline::edit::{set_config_input, set_slot_active, ConfigValue};
use pom_pipeline::session::Session;
use pom_pipeline::Env;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, HashMap};

/// Engine outputs one condition state needs.
const STATS: &[&str] = &[
    "CombinedDPS", "FullDPS", "TotalDPS", "CullMultiplier", "CullPercent", "ReservationDpsMultiplier",
    "TotalPoisonDPS", "PoisonStacks", "PoisonDuration",
    "IgniteDPS", "TotalIgniteDPS", "IgniteDuration", "IgniteStackPotential", "IgniteStacksMax",
    "BleedDPS", "BleedDuration", "BleedStackPotential", "BleedStacksMax",
    "ImpaleDPS", "ImpaleDuration", "ImpaleChance",
    "Speed", "HitSpeed", "HitChance", "PowerChargesMax", "FrenzyChargesMax", "EnduranceChargesMax",
    "CritChance", "CritMultiplier",
    "PhysicalMinBase", "PhysicalMaxBase", "LightningMinBase", "LightningMaxBase", "ColdMinBase", "ColdMaxBase",
    "FireMinBase", "FireMaxBase", "ChaosMinBase", "ChaosMaxBase",
];

/// Kill conditions: a lone boss gives no kill until it dies, so these are off for the whole fight.
const KILL_KEYS: &[&str] = &[
    "conditionKilledRecently", "multiplierKilledRecently", "conditionKilledLast3Seconds", "conditionKilledPoisonedLast2Seconds",
    "conditionKilledTauntedEnemyRecently", "conditionTotemsKilledRecently", "multiplierTotemsKilledRecently",
    "conditionMinionsKilledRecently", "multiplierMinionsKilledRecently", "conditionKilledAffectedByDoT",
    "multiplierShockedEnemyKilledRecently", "conditionKilledUniqueEnemy",
];

/// Conditions a hit has to cause first (ailments, debuffs, exposure, "hit/crit recently"): off until the first hit
/// lands, then as the build saved them. shortcut: on from the first hit; real build-up per ailment chance later.
const HIT_KEYS: &[&str] = &[
    "conditionHitRecently", "conditionHitSpellRecently", "conditionCritRecently", "conditionSkillCritRecently",
    "conditionCritWithHeraldSkillRecently", "conditionNonCritRecently", "conditionFrozenEnemyRecently",
    "conditionChilledEnemyRecently", "conditionIgnitedEnemyRecently", "conditionShockedEnemyRecently",
    "conditionStunnedEnemyRecently", "conditionPoisonedEnemyRecently", "conditionImpaledRecently",
    "conditionCausedBleedingRecently", "conditionCursedEnemyRecently", "conditionEnemyCursed", "conditionEnemyStunned",
    "conditionEnemyBleeding", "conditionEnemyPoisoned", "conditionEnemyMaimed", "conditionEnemyHindered",
    "conditionEnemyBlinded", "conditionEnemyBurning", "conditionEnemyIgnited", "conditionEnemyScorched",
    "conditionEnemyChilled", "conditionEnemyChilledByYourHits", "conditionEnemyBrittle", "conditionEnemyShocked",
    "conditionEnemySapped", "conditionEnemyFireExposure", "conditionEnemyColdExposure", "conditionEnemyLightningExposure",
    "conditionEnemyIntimidated", "conditionEnemyCrushed", "conditionEnemyUnnerved", "conditionEnemyCoveredInAsh",
    "conditionEnemyCoveredInFrost",
];

/// How a stack count the player typed in builds up during the fight.
#[derive(Clone, Copy, Debug)]
enum Ramp {
    /// Follows the engine's poison stacks (rate x min(t, duration)).
    Poison,
    /// Follows the engine's bleed stacks (Crimson Dance).
    Bleed,
    /// One per hit that impales.
    Impale,
    /// One per hit. shortcut: real sources differ (Wither channel, Rage per hit cooldowns); per-source rates later.
    PerHit,
}

/// Config counts that ramp from 0 to the value the player set.
const COUNTERS: &[(&str, Ramp)] = &[
    ("multiplierPoisonOnEnemy", Ramp::Poison),
    ("multiplierBleedsOnEnemy", Ramp::Bleed),
    ("multiplierImpalesOnEnemy", Ramp::Impale),
    ("multiplierWitheredStackCount", Ramp::PerHit),
    ("multiplierCorrosionStackCount", Ramp::PerHit),
    ("multiplierRage", Ramp::PerHit),
];

/// (use flag, count override, engine max) per charge type.
const CHARGES: &[(&str, &str, &str)] = &[
    ("usePowerCharges", "overridePowerCharges", "PowerChargesMax"),
    ("useFrenzyCharges", "overrideFrenzyCharges", "FrenzyChargesMax"),
    ("useEnduranceCharges", "overrideEnduranceCharges", "EnduranceChargesMax"),
];

/// A config input's value in one condition state.
#[derive(Clone, Copy, Debug, PartialEq)]
enum V {
    Bool(bool),
    Num(f64),
}

impl V {
    fn json(self) -> Value {
        match self {
            V::Bool(b) => json!(b),
            V::Num(n) => json!(n),
        }
    }
}

type State = BTreeMap<String, V>;

fn state_key(s: &State) -> String {
    s.iter().map(|(k, v)| format!("{k}={v:?}")).collect::<Vec<_>>().join(";")
}

/// One condition state as the engine calculated it.
#[derive(Clone, Debug)]
struct Snap {
    o: HashMap<&'static str, f64>,
}

impl Snap {
    fn get(&self, k: &str) -> f64 {
        self.o.get(k).copied().unwrap_or(0.0)
    }
    fn opt(&self, k: &str) -> Option<f64> {
        self.o.get(k).copied().filter(|v| *v > 0.0)
    }
    /// The engine's headline DPS: FullDPS when the build includes skills in it, else the main skill's CombinedDPS.
    fn total(&self) -> (f64, &'static str) {
        match self.opt("FullDPS") {
            Some(v) => (v, "FullDPS"),
            None => (self.get("CombinedDPS"), "CombinedDPS"),
        }
    }
    fn hit_rate(&self) -> f64 {
        self.opt("HitSpeed").or(self.opt("Speed")).unwrap_or(0.0) * self.o.get("HitChance").copied().unwrap_or(100.0) / 100.0
    }
    /// The hit's base damage range (sum of each type's base min and max): the spread a dice roll draws from.
    /// shortcut: one uniform roll over the summed range, not one per damage type.
    fn hit_range(&self) -> (f64, f64) {
        let t = ["Physical", "Lightning", "Cold", "Fire", "Chaos"];
        (t.iter().map(|d| self.get(&format!("{d}MinBase"))).sum(), t.iter().map(|d| self.get(&format!("{d}MaxBase"))).sum())
    }
    /// The damage-over-time parts that build up, as (name, steady DPS before the reservation multiplier, stack
    /// potential P, duration D, max stacks M). Stacks at t = min(P x min(t, D) / D, M).
    fn ramps(&self) -> Vec<(&'static str, f64, f64, f64, f64)> {
        let mut v = Vec::new();
        let poison = self.get("TotalPoisonDPS");
        if poison > 0.0 {
            v.push(("Poison", poison, self.get("PoisonStacks"), self.get("PoisonDuration"), f64::INFINITY));
        }
        let ignite = self.opt("TotalIgniteDPS").unwrap_or(self.get("IgniteDPS"));
        if ignite > 0.0 {
            v.push(("Ignite", ignite, self.get("IgniteStackPotential"), self.get("IgniteDuration"), self.opt("IgniteStacksMax").unwrap_or(1.0)));
        }
        let bleed = self.get("BleedDPS");
        if bleed > 0.0 {
            v.push(("Bleed", bleed, self.get("BleedStackPotential"), self.get("BleedDuration"), self.opt("BleedStacksMax").unwrap_or(1.0)));
        }
        let impale = self.get("ImpaleDPS");
        if impale > 0.0 {
            let d = self.get("ImpaleDuration");
            // Impale stacks cap at 5 (the engine's ImpaleModifier counts 5 unless a mod changes it).
            v.push(("Impale", impale, self.hit_rate() * self.get("ImpaleChance") / 100.0 * d, d, 5.0));
        }
        v
    }
}

/// Share of the steady stacks up at time t: min(P x min(t, D) / D, M) / min(P, M). 1 when P or D is unknown.
fn ramp_frac(t: f64, p: f64, d: f64, m: f64) -> f64 {
    if p <= 0.0 || d <= 0.0 {
        return 1.0;
    }
    let steady = p.min(m);
    ((p * t.min(d) / d).min(m) / steady).clamp(0.0, 1.0)
}

/// What the build saved, read once from the configured state's env.
struct Base {
    flags: HashMap<String, bool>,
    nums: HashMap<String, f64>,
    enemy_level: f64,
    enemy_more_life: f64,
    /// Flasks the build marks active whose uptime in a fight without kills is under 1: (n, uptime, duration, charges
    /// per use, max charges).
    flasks: Vec<(usize, f64, f64, f64, f64)>,
}

fn read_base(env: &Env, xml: &str) -> Base {
    let p = &env.player;
    let inc = |name: &str| p.sum(ModType::Inc, None, &[Sym::new(name)]);
    let mut flasks = Vec::new();
    for n in 1..=5usize {
        let slot = format!("Flask {n}");
        if !flask_active(xml, &slot) {
            continue;
        }
        let Some(item) = env.slot_items.get(&slot).and_then(|id| env.items.get(id)) else { continue };
        // Life and mana flasks change no damage; driving them would only add engine calculations.
        if item.base_name.as_deref().and_then(pom_calc::data::flask_base_info).is_none_or(|b| b.is_life_or_mana) {
            continue;
        }
        let g = |k: &str| item.flask_data.as_ref().and_then(|f| f.get(k)).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let uptime = pom_pipeline::stat_value(env, &format!("Solver.FlaskUptime{n}")).unwrap_or(1.0);
        if uptime >= 1.0 {
            continue;
        }
        let dur = g("duration") * (1.0 + inc("FlaskDuration") / 100.0);
        let used = g("chargesUsed") * (1.0 + inc("FlaskChargesUsed") / 100.0);
        flasks.push((n, uptime, dur, used, g("chargesMax")));
    }
    Base {
        flags: env.config_flags.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        nums: env.config_input.iter().map(|(k, v)| (k.clone(), *v)).collect(),
        enemy_level: env.enemy_level,
        enemy_more_life: env.enemy.more(None, &[Sym::new("Life")]),
        flasks,
    }
}

/// Whether the build text marks `<Slot name="Flask n" ... active="true">`.
fn flask_active(xml: &str, slot: &str) -> bool {
    let needle = format!("name=\"{slot}\"");
    xml.match_indices("<Slot ").any(|(i, _)| {
        let end = xml[i..].find('>').map_or(xml.len(), |e| i + e);
        let t = &xml[i..end];
        t.contains(&needle) && t.contains("active=\"true\"")
    })
}

/// Fight options (JSON): `boss` "Pinnacle" (default) or "Uber" (the engine's enemy preset); `bossName` a boss from the
/// game data (name or metadata id); `life` a custom life pool; `forced` true keeps every
/// condition as the build saved it (the check that the sim's end state equals the engine); `charges` "full"
/// (default: charges are up from the first second) or "empty" (gained over the fight at `chargeRate` per second,
/// default 1); `dt` tick seconds (0.05);
/// `maxTime` seconds (600); `runs` > 0 turns on the dice mode (that many rolled fights, `seed` for the rolls).
pub struct Opts {
    pub boss: String,
    pub boss_name: Option<String>,
    pub life: Option<f64>,
    pub forced: bool,
    pub charges_full: bool,
    pub charge_rate: f64,
    pub dt: f64,
    pub max_time: f64,
    pub runs: usize,
    pub seed: u64,
}

impl Opts {
    pub fn from_json(v: &Value) -> Opts {
        Opts {
            boss: match v["boss"].as_str().map(|s| s.to_ascii_lowercase()) {
                Some(s) if s == "uber" => "Uber".into(),
                _ => "Pinnacle".into(),
            },
            boss_name: v["bossName"].as_str().filter(|s| !s.trim().is_empty()).map(str::to_string),
            life: v["life"].as_f64().filter(|l| *l > 0.0),
            forced: v["forced"].as_bool().unwrap_or(false),
            charges_full: v["charges"].as_str() != Some("empty"),
            charge_rate: v["chargeRate"].as_f64().filter(|r| *r > 0.0).unwrap_or(1.0),
            dt: v["dt"].as_f64().filter(|d| *d > 0.0).unwrap_or(0.05),
            max_time: v["maxTime"].as_f64().filter(|d| *d > 0.0).unwrap_or(600.0),
            runs: v["runs"].as_u64().unwrap_or(0) as usize,
            seed: v["seed"].as_u64().unwrap_or(1),
        }
    }
}

/// The engine calculations of one fight, one per distinct condition state.
struct Engine {
    session: Session,
    base_xml: String,
    cache: HashMap<String, Snap>,
    order: Vec<(String, State)>,
}

impl Engine {
    fn xml_for(&self, s: &State) -> Result<String, String> {
        let mut xml = self.base_xml.clone();
        for (k, v) in s {
            if let Some(n) = k.strip_prefix("flask:") {
                xml = set_slot_active(&xml, &format!("Flask {n}"), matches!(v, V::Bool(true)))?;
                continue;
            }
            let cv = match *v {
                V::Bool(b) => Some(ConfigValue::Bool(b)),
                V::Num(n) if n == 0.0 => None,
                V::Num(n) => Some(ConfigValue::Num(n)),
            };
            xml = set_config_input(&xml, k, cv.as_ref())?;
        }
        Ok(xml)
    }

    fn eval(&mut self, s: &State) -> Result<Snap, String> {
        let key = state_key(s);
        if let Some(c) = self.cache.get(&key) {
            return Ok(c.clone());
        }
        let xml = self.xml_for(s)?;
        let snap = self.session.eval_xml(&xml, true, |env| Snap { o: STATS.iter().filter_map(|k| pom_pipeline::stat_value(env, k).map(|v| (*k, v))).collect() })?;
        self.cache.insert(key.clone(), snap.clone());
        self.order.push((key, s.clone()));
        Ok(snap)
    }
}

/// Friendly name of a driven condition for the event list.
fn label(k: &str) -> String {
    if let Some(n) = k.strip_prefix("flask:") {
        return format!("Flask {n} active");
    }
    match k {
        "conditionEnemyFullLife" => "Enemy on Full Life".into(),
        "conditionEnemyLowLife" => "Enemy on Low Life".into(),
        "multiplierPoisonOnEnemy" => "# of Poison on enemy".into(),
        "multiplierBleedsOnEnemy" => "# of Bleeds on enemy".into(),
        "multiplierImpalesOnEnemy" => "# of Impales on enemy".into(),
        "multiplierWitheredStackCount" => "# of Withered stacks".into(),
        "multiplierCorrosionStackCount" => "# of Corrosion stacks".into(),
        "multiplierRage" => "Rage".into(),
        k if KILL_KEYS.contains(&k) => format!("{k} (lone boss: no kills)"),
        k => k.into(),
    }
}

/// Small deterministic random source for the dice mode (splitmix64): the same seed gives the same fights.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Everything one fight needs that does not change between fights.
struct Setup<'a> {
    opts: &'a Opts,
    base: Base,
    base_xml: String,
    steady: Snap,
    max_life: f64,
    kill_at: f64,
    low_threshold: f64,
    kill_keys: Vec<(&'static str, V)>,
    hit_keys: Vec<&'static str>,
    counters: Vec<(&'static str, Ramp, f64)>,
    charges: Vec<(&'static str, &'static str, f64)>,
    /// (n, uptime, duration, charges per use, max charges).
    flasks: Vec<(usize, f64, f64, f64, f64)>,
    hit_rate: f64,
    first_hit: f64,
}

/// One fight's result.
struct Run {
    ttk: Option<f64>,
    per_sec: Vec<f64>,
    events: Vec<Value>,
    last_dps: f64,
    life_left: f64,
    ticks: u64,
}

fn quant(v: f64, cap: f64) -> f64 {
    if v >= cap {
        return cap;
    }
    let step = (cap / 5.0).ceil().max(1.0);
    (v / step).floor() * step
}

impl Setup<'_> {
    /// The condition state at time `t`. `poison_live`: the dice mode's own count of poisons on the boss (else the
    /// engine's poison stacks ramp is used).
    fn state_at(&self, t: f64, life_frac: f64, flask_on: &[bool], poison_live: Option<f64>) -> State {
        let mut s = State::new();
        if self.opts.forced {
            return s;
        }
        let st = &self.steady;
        s.insert("conditionEnemyFullLife".into(), V::Bool(t < self.first_hit));
        s.insert("conditionEnemyLowLife".into(), V::Bool(life_frac <= self.low_threshold));
        for (k, v) in &self.kill_keys {
            s.insert((*k).into(), *v);
        }
        for k in &self.hit_keys {
            s.insert((*k).into(), V::Bool(t >= self.first_hit));
        }
        for (k, r, cap) in &self.counters {
            let v = match r {
                Ramp::Poison => poison_live.unwrap_or_else(|| st.get("PoisonStacks") * t.min(st.get("PoisonDuration")) / st.get("PoisonDuration").max(1e-9)),
                Ramp::Bleed => {
                    let d = st.get("BleedDuration").max(1e-9);
                    (st.get("BleedStackPotential") * t.min(d) / d).min(st.opt("BleedStacksMax").unwrap_or(f64::INFINITY))
                }
                Ramp::Impale => self.hit_rate * st.get("ImpaleChance") / 100.0 * t,
                Ramp::PerHit => self.hit_rate * t,
            };
            s.insert((*k).into(), V::Num(quant(v, *cap)));
        }
        for (use_key, over, cap) in &self.charges {
            let n = (self.opts.charge_rate * t).floor().min(*cap);
            s.insert((*use_key).into(), V::Bool(n > 0.0));
            s.insert((*over).into(), V::Num(if n > 0.0 { n } else { 0.0 }));
        }
        for (i, f) in self.flasks.iter().enumerate() {
            s.insert(format!("flask:{}", f.0), V::Bool(flask_on[i]));
        }
        s
    }

    fn configured_value(&self, k: &str) -> Value {
        if let Some(n) = k.strip_prefix("flask:") {
            return json!(flask_active(&self.base_xml, &format!("Flask {n}")));
        }
        self.base.flags.get(k).map(|b| json!(b)).or_else(|| self.base.nums.get(k).map(|n| json!(n))).unwrap_or(Value::Null)
    }

    /// One fight. With `rng` each hit rolls hit chance, critical strike and its damage between the engine's min and
    /// max, and each ailment is a rolled instance with its own duration (the dice mode); without it the damage is
    /// the engine's average at every instant (the average mode).
    fn fight(&self, eng: &mut Engine, mut rng: Option<&mut Rng>) -> Result<Run, String> {
        let opts = self.opts;
        let dt = opts.dt;
        let mut flask_state: Vec<(f64, f64)> = self.flasks.iter().map(|f| (0.0, f.4)).collect();
        let mut life = self.max_life;
        let mut per_sec: Vec<f64> = Vec::new();
        let mut events: Vec<Value> = Vec::new();
        let mut prev: Option<State> = None;
        let mut ramp_done: Vec<&'static str> = Vec::new();
        let mut ttk: Option<f64> = None;
        let mut last_dps = 0.0;
        let mut ticks = 0u64;
        // Dice mode: rolled ailment instances (name, expires at, DPS) and the next hit's time.
        let mut ailments: Vec<(&'static str, f64, f64)> = Vec::new();
        let mut next_hit = 0.0f64;
        loop {
            // Time from the tick count, so a long fight's seconds each hold the same number of ticks.
            let t = ticks as f64 * dt;
            if t >= opts.max_time {
                break;
            }
            ticks += 1;
            // Flasks: use one as soon as it is off and has the charges for a use; charges come back at the rate that
            // gives the engine's own uptime (`Solver.FlaskUptime<n>`: uptime = gain x duration / charges per use).
            let mut flask_on = Vec::with_capacity(self.flasks.len());
            for (i, f) in self.flasks.iter().enumerate() {
                let (_, uptime, dur, used, max) = *f;
                let st = &mut flask_state[i];
                if t >= st.0 && used > 0.0 && dur > 0.0 && st.1 >= used {
                    st.1 -= used;
                    st.0 = t + dur;
                }
                let gain = if dur > 0.0 { uptime * used / dur } else { 0.0 };
                st.1 = (st.1 + gain * dt).min(max);
                flask_on.push(t < st.0);
            }
            ailments.retain(|a| a.1 > t);
            let poison_live = rng.is_some().then(|| ailments.iter().filter(|a| a.0 == "Poison").count() as f64);
            let s = self.state_at(t, life / self.max_life, &flask_on, poison_live);
            if prev.as_ref() != Some(&s) {
                for (k, v) in &s {
                    if prev.as_ref().and_then(|p| p.get(k)).copied() != Some(*v) {
                        events.push(json!({"t": round3(t), "condition": k, "label": label(k), "value": v.json(), "configured": self.configured_value(k)}));
                    }
                }
                prev = Some(s.clone());
            }
            let snap = eng.eval(&s)?;
            let (total, stat) = snap.total();
            let cull = snap.opt("CullMultiplier").unwrap_or(1.0);
            // Forced: the engine's own number, cull credit included. Otherwise the boss dies at the cull threshold.
            let scale = if opts.forced { cull } else { 1.0 };
            let rm = snap.opt("ReservationDpsMultiplier").unwrap_or(1.0);
            let ramps = snap.ramps();
            let sec = (t + 1e-9).floor() as usize;
            if per_sec.len() <= sec {
                per_sec.resize(sec + 1, 0.0);
            }
            let mut dmg;
            let dps;
            match rng.as_deref_mut() {
                None => {
                    let mid = t + dt / 2.0;
                    let mut d = total / cull;
                    for (name, part, p, dur, m) in &ramps {
                        let f = ramp_frac(mid, *p, *dur, *m);
                        d -= part * rm * (1.0 - f);
                        if f >= 1.0 && !ramp_done.contains(name) {
                            ramp_done.push(name);
                            events.push(json!({"t": round3(t), "condition": format!("{name}Stacks"), "label": format!("{name} at full stacks"), "value": p.min(*m), "configured": Value::Null}));
                        }
                    }
                    dps = d.max(0.0) * scale;
                    dmg = dps * dt;
                }
                Some(rng) => {
                    // The main skill's hit is rolled only when the headline is its own CombinedDPS; FullDPS builds
                    // keep their other skills at the average. shortcut: per-skill rolls for FullDPS builds later.
                    let hit_rate = snap.hit_rate();
                    let hit_dps = if stat == "CombinedDPS" && hit_rate > 0.0 { snap.get("TotalDPS") * rm } else { 0.0 };
                    let ail_dps: f64 = if hit_dps > 0.0 { ramps.iter().map(|r| r.1 * rm).sum() } else { 0.0 };
                    let rest = (total / cull - hit_dps - ail_dps).max(0.0);
                    dmg = rest * dt * scale;
                    if hit_dps > 0.0 {
                        let hit_chance = (snap.o.get("HitChance").copied().unwrap_or(100.0) / 100.0).clamp(1e-9, 1.0);
                        let crit = (snap.get("CritChance") / 100.0).clamp(0.0, 1.0);
                        let crit_mult = snap.opt("CritMultiplier").unwrap_or(1.0);
                        let crit_effect = 1.0 + crit * (crit_mult - 1.0);
                        let (lo, hi) = snap.hit_range();
                        // Damage of one landed hit, scaled so the rolled mean is the engine's own average.
                        let per_hit = hit_dps / hit_rate / hit_chance * scale;
                        while next_hit < t + dt {
                            if rng.next() < hit_chance {
                                let roll = if hi > lo { (lo + (hi - lo) * rng.next()) / ((lo + hi) / 2.0) } else { 1.0 };
                                let c = if rng.next() < crit { crit_mult } else { 1.0 };
                                dmg += per_hit * roll * c / crit_effect;
                                // Ailments from this hit: applications per landed hit that give the engine's own
                                // stack potential, each based on the hit's non-critical roll.
                                for (name, part, p, dur, m) in &ramps {
                                    if *p <= 0.0 || *dur <= 0.0 {
                                        continue;
                                    }
                                    let per_hit_apps = p / (dur * hit_rate * hit_chance);
                                    let mut n = per_hit_apps.floor();
                                    if rng.next() < per_hit_apps - n {
                                        n += 1.0;
                                    }
                                    for _ in 0..n as usize {
                                        ailments.push((name, next_hit + dur, part * rm / p.min(*m) * roll * scale));
                                    }
                                }
                            }
                            next_hit += 1.0 / hit_rate;
                        }
                        // Each ailment deals damage from its strongest `max stacks` instances (one ignite at a time).
                        for (name, _, _, _, m) in &ramps {
                            let mut v: Vec<f64> = ailments.iter().filter(|a| a.0 == *name).map(|a| a.2).collect();
                            if m.is_finite() && v.len() > *m as usize {
                                v.sort_by(|a, b| b.total_cmp(a));
                                v.truncate(*m as usize);
                            }
                            dmg += v.iter().sum::<f64>() * dt;
                        }
                    }
                    dps = dmg / dt;
                }
            }
            last_dps = dps;
            if dmg > 0.0 && life - dmg <= self.kill_at {
                per_sec[sec] += life - self.kill_at;
                ttk = Some(t + (life - self.kill_at) / dmg * dt);
                life = self.kill_at;
                break;
            }
            per_sec[sec] += dmg;
            life -= dmg;
        }
        // The last second is a partial one: its damage over its own length.
        if let (Some(k), Some(last)) = (ttk, per_sec.last_mut()) {
            let len = k - k.floor();
            if len > 1e-9 {
                *last /= len;
            }
        }
        Ok(Run { ttk, per_sec, events, last_dps, life_left: life, ticks })
    }
}

/// `p`-th percentile (0..1) of sorted `v` (nearest rank).
fn pct(v: &[f64], p: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    Some(v[((v.len() - 1) as f64 * p).round() as usize])
}

/// Runs a fight against one boss. Returns the result JSON: `ttk` (`seconds` is the average fight's or the dice
/// median; `median`/`p10`/`p90`/`min`/`max` over the dice fights, all equal in average mode), `dpsSeries` (damage per
/// second, one entry per second; dice: the median over fights still running that second, with `dpsP10`/`dpsP90`),
/// `avgDps`, `endDps`, `events` (condition changes with times; dice: the median fight's), `steady` (the engine's own
/// DPS), `states` (each distinct condition state and its engine DPS). Errors are engine or build-text errors.
pub fn simulate(xml: &str, opts: &Opts) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let game = pom_calc::data::game_data();
    let base_xml = set_config_input(xml, "enemyIsBoss", Some(&ConfigValue::Str(opts.boss.clone())))?;
    // The boss the build saved, when it is not the preset the fight uses.
    let saved_boss = xml.find("name=\"enemyIsBoss\"").and_then(|i| {
        let tag = &xml[i..i + xml[i..].find('>').unwrap_or(0)];
        let v = tag.split("string=\"").nth(1)?;
        Some(v[..v.find('"')?].to_string())
    });
    let mut eng = Engine { session: Session::new(base_xml.clone(), game), base_xml: base_xml.clone(), cache: HashMap::new(), order: Vec::new() };

    // The configured state: every condition as the build saved it (what the engine's normal number assumes).
    let base = eng.session.eval_xml(&base_xml, false, |env| read_base(env, &base_xml))?;
    let steady = eng.eval(&State::new())?;
    let (steady_total, steady_stat) = steady.total();

    // Boss life pool from game data.
    let level = base.enemy_level.round() as i64;
    let boss = boss_life(level, opts.boss_name.as_deref())?;
    let max_life = opts.life.unwrap_or(boss.life * base.enemy_more_life);
    let low_threshold = pom_offence::data::misc("LowPoolThreshold");
    let cull_pct = if opts.forced { 0.0 } else { steady.get("CullPercent") };

    // Which conditions this fight drives, with their configured values.
    let mut assumptions: Vec<String> = Vec::new();
    if let Some(b) = saved_boss.filter(|b| *b != opts.boss) {
        assumptions.push(format!("the build saved the enemy as \"{b}\"; this fight uses the {} preset", opts.boss));
    }
    let mut kill_keys: Vec<(&'static str, V)> = Vec::new();
    let mut hit_keys: Vec<&'static str> = Vec::new();
    let mut counters: Vec<(&'static str, Ramp, f64)> = Vec::new();
    let mut charges: Vec<(&'static str, &'static str, f64)> = Vec::new();
    if !opts.forced {
        for k in KILL_KEYS {
            if base.flags.get(*k) == Some(&true) {
                kill_keys.push((k, V::Bool(false)));
            } else if base.nums.get(*k).is_some_and(|v| *v > 0.0) {
                kill_keys.push((k, V::Num(0.0)));
            }
        }
        hit_keys = HIT_KEYS.iter().copied().filter(|k| base.flags.get(*k) == Some(&true)).collect();
        for (k, r) in COUNTERS {
            if let Some(v) = base.nums.get(*k).filter(|v| **v > 0.0) {
                // A typed poison or bleed count above the engine's own stacks cannot be reached: it tops out there.
                let engine_max = match r {
                    Ramp::Poison => steady.opt("PoisonStacks"),
                    Ramp::Bleed => steady.opt("BleedStackPotential").map(|p| p.min(steady.opt("BleedStacksMax").unwrap_or(f64::INFINITY))),
                    _ => None,
                };
                let cap = match engine_max {
                    Some(m) if m.floor() < *v => {
                        assumptions.push(format!("{} set to {v}; the engine's own stacks are {m:.1}, so it tops out at {}", label(k), m.floor()));
                        m.floor()
                    }
                    _ => *v,
                };
                if cap > 0.0 {
                    counters.push((k, *r, cap));
                }
            }
        }
        if !opts.charges_full {
            for (use_key, over, max_stat) in CHARGES {
                if base.flags.get(*use_key) == Some(&true) {
                    let target = base.nums.get(*over).copied().filter(|v| *v > 0.0).unwrap_or(steady.get(max_stat));
                    if target > 0.0 {
                        charges.push((use_key, over, target));
                    }
                }
            }
            if !charges.is_empty() {
                assumptions.push(format!("charges start empty and come at {} per second", opts.charge_rate));
            }
        }
        if counters.iter().any(|c| matches!(c.1, Ramp::PerHit)) {
            assumptions.push("withered, corrosion and rage stacks: one per hit".into());
        }
    }
    let hit_rate = steady.hit_rate();
    let flasks = if opts.forced { Vec::new() } else { base.flasks.clone() };
    let setup = Setup {
        opts,
        base,
        base_xml,
        max_life,
        kill_at: max_life * cull_pct / 100.0,
        low_threshold,
        kill_keys,
        hit_keys,
        counters,
        charges,
        flasks,
        hit_rate,
        first_hit: if hit_rate > 0.0 { 1.0 / hit_rate } else { opts.dt },
        steady,
    };

    let dice = opts.runs > 0;
    let mut runs: Vec<Run> = Vec::new();
    if dice {
        for i in 0..opts.runs {
            let mut rng = Rng(opts.seed.wrapping_add(i as u64).wrapping_mul(0x2545_F491_4F6C_DD1D));
            runs.push(setup.fight(&mut eng, Some(&mut rng))?);
        }
    } else {
        runs.push(setup.fight(&mut eng, None)?);
    }
    // The fight the summary shows: the median one by time to kill (the only one in average mode).
    let mut ttks: Vec<f64> = runs.iter().filter_map(|r| r.ttk).collect();
    ttks.sort_by(|a, b| a.total_cmp(b));
    let median = pct(&ttks, 0.5);
    let shown = runs.iter().min_by(|a, b| {
        let d = |r: &Run| (r.ttk.unwrap_or(f64::INFINITY) - median.unwrap_or(f64::INFINITY)).abs();
        d(a).total_cmp(&d(b))
    });
    let shown = shown.ok_or("no fight ran")?;
    let secs = runs.iter().map(|r| r.per_sec.len()).max().unwrap_or(0);
    let band = |p: f64| -> Vec<f64> {
        (0..secs)
            .map(|s| {
                let mut v: Vec<f64> = runs.iter().filter_map(|r| r.per_sec.get(s).copied()).collect();
                v.sort_by(|a, b| a.total_cmp(b));
                pct(&v, p).unwrap_or(0.0).round()
            })
            .collect()
    };
    // Median-run series in average mode is the run itself.
    let series: Vec<f64> = if dice { band(0.5) } else { shown.per_sec.iter().map(|v| v.round()).collect() };
    let fight_time = shown.ttk.unwrap_or(shown.ticks as f64 * opts.dt);
    let states: Vec<Value> = eng
        .order
        .iter()
        .map(|(k, s)| {
            let snap = &eng.cache[k];
            let (total, stat) = snap.total();
            json!({"conditions": Map::from_iter(s.iter().map(|(k, v)| (k.clone(), v.json()))), "dps": total, "stat": stat})
        })
        .collect();
    let r3 = |v: Option<f64>| v.map(round3);
    let mut out = json!({
        "mode": if dice { "dice" } else { "average" },
        "runs": runs.len(),
        "forced": opts.forced,
        "boss": {
            "preset": opts.boss,
            "level": setup.base.enemy_level,
            "life": max_life,
            "name": if opts.life.is_some() { Value::Null } else { json!(boss.name) },
            "pinnacles": boss.pinnacles,
            "lifeSource": if opts.life.is_some() { "custom".to_string() } else { boss.source.clone() },
            "lowLifeThreshold": low_threshold,
            "cullPercent": cull_pct,
        },
        "steady": {"dps": steady_total, "stat": steady_stat, "combinedDPS": setup.steady.get("CombinedDPS"), "fullDPS": setup.steady.get("FullDPS")},
        "killed": shown.ttk.is_some(),
        "killedRuns": ttks.len(),
        "ttk": {"seconds": r3(median), "median": r3(median), "p10": r3(pct(&ttks, 0.1)), "p90": r3(pct(&ttks, 0.9)), "min": r3(ttks.first().copied()), "max": r3(ttks.last().copied())},
        "avgDps": if fight_time > 0.0 { (max_life - shown.life_left) / fight_time } else { 0.0 },
        // Dice: the last full second of the median fight (one tick holds whole hits, so a tick's rate means nothing).
        "endDps": if dice { shown.per_sec.iter().rev().nth(1).or(shown.per_sec.last()).copied().unwrap_or(0.0) } else { shown.last_dps },
        "dpsSeries": series,
        "events": shown.events,
        "states": states,
        "evals": eng.order.len() + 1,
        "ticks": runs.iter().map(|r| r.ticks).sum::<u64>(),
        "assumptions": assumptions,
        "ms": started.elapsed().as_millis() as u64,
    });
    if dice {
        out["ttks"] = json!(ttks.iter().map(|v| round3(*v)).collect::<Vec<_>>());
        out["dpsP10"] = json!(band(0.1));
        out["dpsP90"] = json!(band(0.9));
        out["seed"] = json!(opts.seed);
    }
    Ok(out)
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// One boss's life pool from the game files.
struct BossLife {
    name: String,
    life: f64,
    source: String,
    /// Pinnacle boss names, for the Fight tab's boss list.
    pinnacles: Vec<String>,
}

/// Life of a boss at `level` from `data_bossLife.json`: monster life x the boss's life multiplier x the Unique rarity
/// life x (1 + (map boss + map life percent + the boss's own maximum_life_+%)/100). `name` matches a boss name or
/// metadata id (exact first, then a part of either); several matches take the largest life multiplier. Without a
/// name: the median pinnacle boss (largest multiplier per distinct name, median over the names).
fn boss_life(level: i64, name: Option<&str>) -> Result<BossLife, String> {
    let data = pom_calc::data::game_data()
        .extra
        .get("bossLife")
        .map_err(|e| format!("bossLife data failed to parse: {e}"))?
        .ok_or("bossLife data missing from engine-data")?
        .to_value();
    let num = |v: &Value| v.as_f64().unwrap_or(0.0);
    let bosses = data["bosses"].as_array().ok_or("bossLife: no bosses")?;
    let pick: &Value = match name {
        Some(n) => {
            let n = n.trim().to_ascii_lowercase();
            let by = |f: &dyn Fn(&Value) -> bool| bosses.iter().filter(|b| f(b)).max_by(|a, b| num(&a["life"]).total_cmp(&num(&b["life"])));
            let eq = |b: &Value| ["name", "id"].iter().any(|k| b[k].as_str().is_some_and(|s| s.to_ascii_lowercase() == n));
            let has = |b: &Value| ["name", "id"].iter().any(|k| b[k].as_str().is_some_and(|s| s.to_ascii_lowercase().contains(&n)));
            by(&eq).or_else(|| by(&has)).ok_or_else(|| format!("no boss named \"{n}\" in the game data"))?
        }
        None => {
            let mut per_name: BTreeMap<&str, &Value> = BTreeMap::new();
            for b in bosses.iter().filter(|b| b["pinnacle"].as_bool() == Some(true)) {
                let k = b["name"].as_str().unwrap_or("");
                if per_name.get(k).is_none_or(|o| num(&o["life"]) < num(&b["life"])) {
                    per_name.insert(k, b);
                }
            }
            let mut v: Vec<&Value> = per_name.into_values().collect();
            v.sort_by(|a, b| num(&a["life"]).total_cmp(&num(&b["life"])));
            *v.get(v.len() / 2).ok_or("bossLife: no pinnacle bosses")?
        }
    };
    let table = data["monsterLife"].as_array().ok_or("bossLife: no monsterLife")?;
    let base = table.get((level - 1).clamp(0, table.len() as i64 - 1) as usize).map_or(0.0, num);
    let rarity = num(&data["rarity"]["Unique"]);
    // Map percents exist from map level 66 up; above the table's last level the last row holds.
    let ml = data["mapLevel"].as_object().ok_or("bossLife: no mapLevel")?;
    let top = ml.keys().filter_map(|k| k.parse::<i64>().ok()).max().unwrap_or(0);
    let map_pct = match ml.get(&level.min(top).to_string()) {
        Some(r) if level >= 66 => num(&r["boss"]) + num(&r["map"]),
        _ => 0.0,
    };
    let own: f64 = pick["lifeStats"].as_array().into_iter().flatten().filter(|s| s[0] == "maximum_life_+%").map(|s| num(&s[1])).sum();
    let life = base * num(&pick["life"]) * (1.0 + rarity / 100.0) * (1.0 + (map_pct + own) / 100.0);
    let name = pick["name"].as_str().unwrap_or("").to_string();
    let source = format!(
        "game files (patch {}): monster life {base} x {name} life x{} x Unique rarity +{rarity}% x (1 + {}% map boss, map life and own life)",
        data["patch"].as_str().unwrap_or("?"),
        num(&pick["life"]),
        map_pct + own
    );
    let mut pinnacles: Vec<String> = bosses.iter().filter(|b| b["pinnacle"].as_bool() == Some(true)).filter_map(|b| b["name"].as_str().map(str::to_string)).collect();
    pinnacles.sort();
    pinnacles.dedup();
    Ok(BossLife { name, life, source, pinnacles })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boss_life_from_game_files() {
        // poedb lists the Searing Exarch at 42.0M at level 84.
        let b = boss_life(84, Some("Searing Exarch")).unwrap();
        assert!((b.life / 1e6 - 42.0).abs() < 0.05, "{}", b.life);
        assert_eq!(b.name, "The Searing Exarch");
        // Default: the median pinnacle boss, not the old 2.68M engine model.
        assert!(boss_life(84, None).unwrap().life > 10e6);
        assert!(boss_life(84, Some("no such boss")).is_err());
    }

    #[test]
    fn ramp_frac_shapes() {
        // Poison: no cap, linear to 1 over the duration.
        assert!((ramp_frac(1.0, 20.0, 4.0, f64::INFINITY) - 0.25).abs() < 1e-12);
        assert_eq!(ramp_frac(5.0, 20.0, 4.0, f64::INFINITY), 1.0);
        // One ignite at a time, 3 applications per duration: full after a third of the duration.
        assert!((ramp_frac(1.0, 3.0, 4.0, 1.0) - 0.75).abs() < 1e-12);
        assert_eq!(ramp_frac(4.0 / 3.0, 3.0, 4.0, 1.0), 1.0);
        // Unknown potential: no ramp.
        assert_eq!(ramp_frac(0.0, 0.0, 4.0, 1.0), 1.0);
    }
}
