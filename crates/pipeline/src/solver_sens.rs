//! Sensitivity probes: what one more unit, or a whole committed package, of an axis (crit,
//! conversion, ES, ...) is worth to a state, measured by the engine. A probe is the state's build text plus one custom
//! modifier block with the probe's lines, written into the template's config hole (`MK[6]`) and evaluated as `Cand::Xml`.
use super::*;

/// The main skill's tags an axis is gated on.
#[derive(Default, Clone, Debug)]
pub(super) struct SkillTags {
    pub attack: bool,
    pub spell: bool,
    pub minion: bool,
    pub projectile: bool,
    /// The damage is the minions' alone: the player's own modifiers scale none of it.
    pub minion_actor: bool,
}

impl SkillTags {
    pub(super) fn of(gem_id: &str) -> SkillTags {
        let Some(g) = gd::game_data().gems.get(gem_id) else { return SkillTags::default() };
        let t = |k: &str| g.tags.get(k).copied().unwrap_or(false);
        SkillTags { attack: t("attack"), spell: t("spell"), minion: t("minion"), projectile: t("projectile"), minion_actor: minion_actor(gem_id) }
    }
}

/// Whether a skill's damage is dealt by its minions only, read from its granted effect: it makes minions (`minion`
/// base flag), is no attack of the player's, and has no base damage of its own (Absolution's spell hit, Dominating
/// Blow's strike: those keep the player's axes).
pub(super) fn minion_actor(gem_id: &str) -> bool {
    let Some(ge) = gd::game_data().gems.get(gem_id).and_then(gd::gem_primary_effect) else { return false };
    let flag = |k: &str| ge.extra.get("baseFlags").and_then(|f| f.get(k)).and_then(|v| v.as_bool()).unwrap_or(false);
    flag("minion") && !flag("attack") && !ge.stats.iter().any(|s| s.contains("_minimum_base_"))
}

/// One thing a build can invest in. `unit` is a small step (the slope here), `commit` a full investment (shows axes that
/// pay more than their slope, like crit).
#[derive(Clone, Copy)]
pub(super) struct Axis {
    pub name: &'static str,
    pub unit: &'static [&'static str],
    pub commit: &'static [&'static str],
    pub when: fn(&SkillTags) -> bool,
    /// A joint axis (a route or a stacking scaler, made by `scanned`): the lines of `commit` that enable the rest. The
    /// axis is ranked by its synergy (`commit` beyond its two halves) and primed twice: whole, and with only this half,
    /// where the parts that bring the other half show what they are worth.
    pub pair: &'static [&'static str],
    /// A joint axis that is a damage-type route (a conversion with an ailment); else a stacking scaler.
    pub route: bool,
    pub family: Family,
}

/// What kind of investment an axis is: the leads' route rows keep one row pair per joint family and none for defence.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Family {
    Plain,
    /// Life, energy shield, armour, evasion, block, resistances: no damage route.
    Defence,
    /// Crit chance with multiplier.
    Crit,
    /// A damage conversion with the ailment it unlocks.
    Conversion,
    /// Minion modifiers that apply to the player.
    Transfer,
    /// A damage line scaled per point of a stat.
    Stacking,
    /// An ailment's chance with its damage-over-time multipliers.
    Ailment,
}

/// Every axis: the hand-made `BASE` and the joint axes the game data offers (`scanned`).
pub(super) static AXES: std::sync::LazyLock<Vec<Axis>> = std::sync::LazyLock::new(|| {
    let mut v = BASE.to_vec();
    let extra = scanned(BASE);
    v.extend(extra);
    v
});

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}
fn leak_all(v: Vec<&'static str>) -> &'static [&'static str] {
    Box::leak(v.into_boxed_slice())
}

/// A modifier line with its tags (`{variant:2}`) off and every roll range `(a-b)` at its top.
pub(super) fn top_roll(line: &str) -> String {
    let mut s = line.trim();
    while s.starts_with('{') {
        let Some(e) = s.find('}') else { break };
        s = &s[e + 1..];
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(a) = rest.find('(') {
        out.push_str(&rest[..a]);
        let inner = rest[a + 1..].split(')').next().unwrap_or("");
        match inner.rsplit_once('-') {
            Some((x, y)) if !inner.is_empty() && x.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-') && y.chars().all(|c| c.is_ascii_digit() || c == '.') => {
                out.push_str(y);
                rest = &rest[a + inner.len() + 2..];
            }
            _ => {
                out.push('(');
                rest = &rest[a + 1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Every modifier line the game data holds: uniques (all variants), the item modifier pool and the passive tree.
fn data_lines() -> Vec<String> {
    let game = pom_calc::data::game_data();
    let mut out: Vec<String> = Vec::new();
    if let Some(groups) = game.extra.get("uniques").ok().flatten().and_then(|u| u.as_object()) {
        for (_, list) in groups.iter() {
            for r in list.as_array().into_iter().flat_map(|a| a.iter()) {
                out.extend(r.as_str().into_iter().flat_map(|r| r.lines().map(top_roll)));
            }
        }
    }
    if let Some(tables) = game.extra.get("itemMods").ok().flatten().and_then(|m| m.as_object()) {
        for (_, t) in tables.iter() {
            for (_, e) in t.as_object().into_iter().flat_map(|o| o.iter()) {
                let mut i = 1;
                while let Some(l) = e.get(i.to_string().as_str()).and_then(|l| l.as_str()) {
                    out.push(top_roll(l));
                    i += 1;
                }
            }
        }
    }
    if let Ok(tree) = crate::cached_tree("3_29") {
        for n in tree.nodes.values() {
            if let Some(v) = n.get("stats") {
                out.extend(pom_passives::treedata::str_list(tree.deref(v)).iter().map(|l| top_roll(l)));
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn parses(l: &str) -> bool {
    matches!(pom_engine::modparser::parse_mod(l), (Some(_), None))
}

/// The leading number of a line ("67% of ..." / "Gain 67% of ...") replaced by `n`.
fn with_lead(l: &str, n: u32) -> Option<String> {
    let a = l.find(|c: char| c.is_ascii_digit())?;
    let b = a + l[a..].find(|c: char| !c.is_ascii_digit())?;
    (l[b..].starts_with("% of ")).then(|| format!("{}{n}{}", &l[..a], &l[b..]))
}

/// Joint axes found in the game data, nothing named:
/// - stacking: a damage line scaled "per N <stat>" with what a stacker of that stat holds: ten of the data's biggest
///   flat roll ("+X to <stat>") raised by its biggest increase ("Y% increased <stat>"), or 50 steps of N when no flat
///   line has it (`pair`: the stat alone);
/// - routes: a damage conversion ("X% of A Converted to B" / "Gain X% of A as Extra B") with each base axis that gives a
///   chance to inflict something (`pair`: that ailment's commitment with the damage-over-time one), so a type change
///   that unlocks an ailment shows up.
fn scanned(base: &[Axis]) -> Vec<Axis> {
    let mut out = Vec::new();
    let lines = data_lines();
    let mut seen: HashSet<String> = HashSet::default();
    // the biggest flat roll of each stat, as the data spells it ("+2000 to Armour")
    let mut flat: HashMap<String, (String, u32)> = HashMap::default();
    for l in &lines {
        let Some((n, stat)) = l.strip_prefix('+').and_then(|r| r.split_once(" to ")) else { continue };
        let Ok(n) = n.parse::<u32>() else { continue };
        let e = flat.entry(stat.to_lowercase()).or_insert_with(|| (stat.to_string(), 0));
        e.1 = e.1.max(n);
    }
    let mut inc: HashMap<String, u32> = HashMap::default();
    for l in &lines {
        let Some((n, stat)) = l.split_once("% increased ") else { continue };
        let Ok(n) = n.parse::<u32>() else { continue };
        let e = inc.entry(stat.to_lowercase()).or_default();
        *e = (*e).max(n);
    }
    // every line that is one minion modifier: (line, inner mod name, its mod flags, its value)
    let minion_lines: Vec<(String, String, u64, u32)> = lines.iter().filter_map(|l| minion_line(l).map(|(n, f, v)| (l.clone(), n, f, v))).collect();
    // minion axes: each minion stat the data increases (the inner mod and its flags), at its biggest roll, five of
    // them committed; the stats a base axis already measures are left to it
    let mut have: Vec<(String, u64)> = base.iter().flat_map(|a| a.unit.iter()).filter_map(|l| minion_line(l)).map(|(n, f, _)| (n, f)).collect();
    let mut by_top: Vec<&(String, String, u64, u32)> = minion_lines.iter().collect();
    by_top.sort_by(|a, b| b.3.cmp(&a.3).then(a.0.cmp(&b.0)));
    for x in by_top {
        if have.contains(&(x.1.clone(), x.2)) {
            continue;
        }
        let (Some(u), Some(c)) = (with_first_num(&x.0, x.3), with_first_num(&x.0, x.3 * 5)) else { continue };
        if parses(&u) && parses(&c) {
            have.push((x.1.clone(), x.2));
            out.push(Axis { name: leak(u.clone()), unit: leak_all(vec![leak(u)]), commit: leak_all(vec![leak(c)]), when: mnn, pair: &[], route: false, family: Family::Plain });
        }
    }
    for l in &lines {
        // stacking scalers
        if l.contains("Damage") && !l.contains("Radius") && !l.contains("Allies") {
            if let Some((_, tail)) = l.rsplit_once(" per ") {
                let (num, stat) = tail.split_once(' ').unwrap_or(("", ""));
                if let (Ok(n), false) = (num.parse::<u32>(), stat.is_empty()) {
                    let stat_line = |k: u32| match flat.get(&stat.to_lowercase()).or_else(|| flat.get(&format!("maximum {}", stat.to_lowercase()))) {
                        Some((name, top)) => Some(format!("+{} to {name}", top * k * (100 + inc.get(&name.to_lowercase()).copied().unwrap_or(0)) / 100)).filter(|s| parses(s)),
                        None => [format!("+{} to {stat}", n * 5 * k), format!("+{} to maximum {stat}", n * 5 * k)].into_iter().find(|s| parses(s)),
                    };
                    if let (Some(u), Some(c)) = (stat_line(1), stat_line(10)) {
                        if parses(l) && seen.insert(l.clone()) {
                            let s = leak(l.clone());
                            let c = leak(c);
                            // (a player's damage line is no scaler for a skill whose minions deal it all)
                            let minions = pom_engine::modparser::parse_mod(l).0.unwrap_or_default().iter().any(|m| m.name == "MinionModifier");
                            out.push(Axis { name: s, unit: leak_all(vec![leak(u), s]), commit: leak_all(vec![c, s]), when: if minions { any } else { ply }, pair: leak_all(vec![c]), route: false, family: Family::Stacking });
                        }
                    }
                }
            }
        }
        // transfers: a line whose parsed mods carry the flag `Minion<K>AppliesToPlayer` (the minion modifiers of stat K
        // count for the player too), with five of the data's biggest minion line of K (`pair`: the minion line alone)
        let parsed = pom_engine::modparser::parse_mod(l).0.unwrap_or_default();
        for k in parsed.iter().filter(|m| m.ty == "FLAG").filter_map(|m| m.name.strip_prefix("Minion")?.strip_suffix("AppliesToPlayer")) {
            let Some((top, line)) = minion_lines.iter().filter(|x| minion_stat_is(x, k)).max_by_key(|x| x.3).map(|x| (x.3, x.0.clone())) else { continue };
            let (Some(u), Some(c)) = (with_first_num(&line, top), with_first_num(&line, top * 5)) else { continue };
            if parses(&u) && parses(&c) && parses(l) && seen.insert(format!("transfer {k}")) {
                let (u, c, s) = (leak(u), leak(c), leak(l.clone()));
                out.push(Axis { name: s, unit: leak_all(vec![u, s]), commit: leak_all(vec![c, s]), when: hit, pair: leak_all(vec![c]), route: false, family: Family::Transfer });
            }
        }
        // conversion routes
        if l.contains(" Damage Converted to ") || l.contains(" Damage as Extra ") {
            let extra = l.contains(" as Extra ");
            let (Some(u), Some(c)) = (with_lead(l, if extra { 20 } else { 25 }), with_lead(l, if extra { 60 } else { 100 })) else { continue };
            if !parses(&c) || !seen.insert(c.clone()) {
                continue;
            }
            let (u, c) = (leak(u), leak(c));
            // (an ailment is damage over time: its half carries the base damage-over-time commitment too)
            let dot: Vec<&'static str> = base.iter().flat_map(|a| a.commit.iter().copied()).filter(|x| x.contains("Damage over Time Multiplier")).collect();
            for a in base.iter().filter(|a| a.pair.is_empty() && a.commit.iter().any(|x| x.contains("chance to"))) {
                let chance: Vec<&'static str> = a.commit.iter().copied().chain(dot.iter().copied()).collect();
                out.push(Axis {
                    name: leak(format!("{c} + {}", a.name)),
                    unit: leak_all(std::iter::once(u).chain(a.unit.iter().copied()).collect()),
                    commit: leak_all(std::iter::once(c).chain(chance.iter().copied()).collect()),
                    when: a.when,
                    pair: leak_all(chance),
                    route: true,
                    family: Family::Conversion,
                });
            }
        }
    }
    out
}

/// A line that parses to one `MinionModifier` of an increase: (the inner mod's name, its mod flags, its value).
fn minion_line(l: &str) -> Option<(String, u64, u32)> {
    use pom_engine::modparser::types::PVal;
    let (Some(mods), None) = pom_engine::modparser::parse_mod(l) else { return None };
    let [m] = mods.as_slice() else { return None };
    let PVal::Map(outer) = &m.value else { return None };
    let PVal::Map(inner) = &outer.iter().find(|(k, _)| k == "mod")?.1 else { return None };
    // (no condition: a tag rides in an array part or a key of its own)
    if !m.tags.is_empty() || inner.iter().any(|(k, _)| !matches!(k.as_str(), "name" | "type" | "value" | "flags" | "keywordFlags" | "source")) {
        return None;
    }
    let get = |key: &str| inner.iter().find(|(k, _)| k == key).map(|x| &x.1);
    let (Some(PVal::Str(name)), Some(PVal::Str(ty)), Some(PVal::Num(v))) = (get("name"), get("type"), get("value")) else { return None };
    let flags = match get("flags") {
        Some(PVal::Num(f)) => *f as u64,
        _ => 0,
    };
    (m.name == "MinionModifier" && ty == "INC" && *v > 0.0).then(|| (name.clone(), flags, *v as u32))
}

/// Whether a minion line (`minion_lines`) is of stat `k` as a `Minion<K>AppliesToPlayer` flag names it: the inner mod
/// is `k` with no mod flag ("Damage"), or `k` is a mod flag word and the inner name ("AttackSpeed": Speed with Attack).
fn minion_stat_is(x: &(String, String, u64, u32), k: &str) -> bool {
    use pom_engine::modparser::flags::mod_flag;
    if x.1 == k {
        return x.2 == 0;
    }
    let bit = match k.strip_suffix(x.1.as_str()) {
        Some("Attack") => mod_flag::Attack,
        Some("Cast") => mod_flag::Cast,
        Some("Spell") => mod_flag::Spell,
        _ => return false,
    };
    x.2 == bit
}

/// The line with its first number replaced by `n`.
fn with_first_num(l: &str, n: u32) -> Option<String> {
    let a = l.find(|c: char| c.is_ascii_digit())?;
    let b = a + l[a..].find(|c: char| !c.is_ascii_digit()).unwrap_or(l.len() - a);
    Some(format!("{}{n}{}", &l[..a], &l[b..]))
}

fn any(_: &SkillTags) -> bool {
    true
}
// (the player's damage axes are off when the minions deal it all: a player-fire line scales the boots' ground, never
// the spirits, and the probe would rank it as damage)
fn ply(t: &SkillTags) -> bool {
    !t.minion_actor
}
fn atk(t: &SkillTags) -> bool {
    t.attack && ply(t)
}
fn spl(t: &SkillTags) -> bool {
    t.spell && ply(t)
}
fn hit(t: &SkillTags) -> bool {
    (t.attack || t.spell) && ply(t)
}
fn prj(t: &SkillTags) -> bool {
    t.projectile && ply(t)
}
fn mnn(t: &SkillTags) -> bool {
    t.minion
}

const BASE: &[Axis] = &[
    Axis { name: "increased damage", unit: &["40% increased Damage"], commit: &["300% increased Damage"], when: ply, pair: &[], route: false, family: Family::Plain },
    Axis { name: "more damage", unit: &["20% more Damage"], commit: &["100% more Damage"], when: ply, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added physical (attack)", unit: &["Adds 10 to 20 Physical Damage to Attacks"], commit: &["Adds 60 to 100 Physical Damage to Attacks"], when: atk, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added physical (spell)", unit: &["Adds 10 to 20 Physical Damage to Spells"], commit: &["Adds 60 to 100 Physical Damage to Spells"], when: spl, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added fire (attack)", unit: &["Adds 10 to 20 Fire Damage to Attacks"], commit: &["Adds 60 to 100 Fire Damage to Attacks"], when: atk, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added fire (spell)", unit: &["Adds 10 to 20 Fire Damage to Spells"], commit: &["Adds 60 to 100 Fire Damage to Spells"], when: spl, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added cold (attack)", unit: &["Adds 10 to 20 Cold Damage to Attacks"], commit: &["Adds 60 to 100 Cold Damage to Attacks"], when: atk, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added cold (spell)", unit: &["Adds 10 to 20 Cold Damage to Spells"], commit: &["Adds 60 to 100 Cold Damage to Spells"], when: spl, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added lightning (attack)", unit: &["Adds 1 to 30 Lightning Damage to Attacks"], commit: &["Adds 10 to 180 Lightning Damage to Attacks"], when: atk, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added lightning (spell)", unit: &["Adds 1 to 30 Lightning Damage to Spells"], commit: &["Adds 10 to 180 Lightning Damage to Spells"], when: spl, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added chaos (attack)", unit: &["Adds 10 to 20 Chaos Damage to Attacks"], commit: &["Adds 60 to 100 Chaos Damage to Attacks"], when: atk, pair: &[], route: false, family: Family::Plain },
    Axis { name: "added chaos (spell)", unit: &["Adds 10 to 20 Chaos Damage to Spells"], commit: &["Adds 60 to 100 Chaos Damage to Spells"], when: spl, pair: &[], route: false, family: Family::Plain },
    Axis { name: "base crit chance", unit: &["+1% to Critical Strike Chance"], commit: &["+3% to Critical Strike Chance"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "increased crit chance", unit: &["40% increased Critical Strike Chance"], commit: &["250% increased Critical Strike Chance"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "crit multiplier", unit: &["+40% to Critical Strike Multiplier"], commit: &["+100% to Critical Strike Multiplier"], when: hit, pair: &[], route: false, family: Family::Plain },
    // (joint: crit chance and multiplier each pay little alone at a bare tree's 5% base crit; primed with the multiplier
    // half, the parts that bring the chance, like an ascendancy's crit from attributes, show what they are worth)
    Axis { name: "crit", unit: &["40% increased Critical Strike Chance", "+20% to Critical Strike Multiplier"], commit: &["+2% to Critical Strike Chance", "300% increased Critical Strike Chance", "+150% to Critical Strike Multiplier"], when: hit, pair: &["+150% to Critical Strike Multiplier"], route: true, family: Family::Crit },
    // (joint: an ailment's chance pays its base alone; its damage-over-time multipliers pay nothing without it. Measured
    // together, a build where the ailment carries the damage shows it as a route)
    Axis { name: "poison route", unit: &["30% chance to Poison on Hit", "+10% to Damage over Time Multiplier"], commit: &["100% chance to Poison on Hit", "+60% to Damage over Time Multiplier", "50% increased Damage with Poison"], when: hit, pair: &["+60% to Damage over Time Multiplier", "50% increased Damage with Poison"], route: true, family: Family::Ailment },
    Axis { name: "bleed route", unit: &["30% chance to cause Bleeding on Hit", "+10% to Damage over Time Multiplier"], commit: &["100% chance to cause Bleeding on Hit", "+60% to Damage over Time Multiplier", "50% increased Damage with Bleeding"], when: atk, pair: &["+60% to Damage over Time Multiplier", "50% increased Damage with Bleeding"], route: true, family: Family::Ailment },
    Axis { name: "ignite route", unit: &["30% chance to Ignite", "+10% to Damage over Time Multiplier"], commit: &["100% chance to Ignite", "+60% to Damage over Time Multiplier", "50% increased Damage with Ignite"], when: hit, pair: &["+60% to Damage over Time Multiplier", "50% increased Damage with Ignite"], route: true, family: Family::Ailment },
    Axis { name: "attack speed", unit: &["20% increased Attack Speed"], commit: &["60% increased Attack Speed"], when: atk, pair: &[], route: false, family: Family::Plain },
    Axis { name: "cast speed", unit: &["20% increased Cast Speed"], commit: &["60% increased Cast Speed"], when: spl, pair: &[], route: false, family: Family::Plain },
    Axis { name: "skill gem levels", unit: &["+1 to Level of all Skill Gems"], commit: &["+4 to Level of all Skill Gems"], when: any, pair: &[], route: false, family: Family::Plain },
    Axis { name: "minion gem levels", unit: &["+1 to Level of all Minion Skill Gems"], commit: &["+4 to Level of all Minion Skill Gems"], when: mnn, pair: &[], route: false, family: Family::Plain },
    Axis { name: "fire penetration", unit: &["Damage Penetrates 10% Fire Resistance"], commit: &["Damage Penetrates 40% Fire Resistance"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "cold penetration", unit: &["Damage Penetrates 10% Cold Resistance"], commit: &["Damage Penetrates 40% Cold Resistance"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "lightning penetration", unit: &["Damage Penetrates 10% Lightning Resistance"], commit: &["Damage Penetrates 40% Lightning Resistance"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "chaos penetration", unit: &["Damage Penetrates 10% Chaos Resistance"], commit: &["Damage Penetrates 40% Chaos Resistance"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "phys to fire", unit: &["25% of Physical Damage Converted to Fire Damage"], commit: &["100% of Physical Damage Converted to Fire Damage"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "phys to cold", unit: &["25% of Physical Damage Converted to Cold Damage"], commit: &["100% of Physical Damage Converted to Cold Damage"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "phys to lightning", unit: &["25% of Physical Damage Converted to Lightning Damage"], commit: &["100% of Physical Damage Converted to Lightning Damage"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "phys to chaos", unit: &["25% of Physical Damage Converted to Chaos Damage"], commit: &["100% of Physical Damage Converted to Chaos Damage"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "phys as extra fire", unit: &["Gain 20% of Physical Damage as Extra Fire Damage"], commit: &["Gain 60% of Physical Damage as Extra Fire Damage"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "phys as extra chaos", unit: &["Gain 20% of Physical Damage as Extra Chaos Damage"], commit: &["Gain 60% of Physical Damage as Extra Chaos Damage"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "projectiles", unit: &["Skills fire 1 additional Projectile"], commit: &["Skills fire 3 additional Projectiles"], when: prj, pair: &[], route: false, family: Family::Plain },
    Axis { name: "damage over time", unit: &["+10% to Damage over Time Multiplier"], commit: &["+60% to Damage over Time Multiplier"], when: ply, pair: &[], route: false, family: Family::Plain },
    Axis { name: "poison", unit: &["30% chance to Poison on Hit"], commit: &["100% chance to Poison on Hit", "50% increased Damage with Poison"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "bleed", unit: &["30% chance to cause Bleeding on Hit"], commit: &["100% chance to cause Bleeding on Hit", "50% increased Damage with Bleeding"], when: atk, pair: &[], route: false, family: Family::Plain },
    Axis { name: "ignite", unit: &["30% chance to Ignite"], commit: &["100% chance to Ignite", "50% increased Damage with Ignite"], when: hit, pair: &[], route: false, family: Family::Plain },
    Axis { name: "minion damage", unit: &["Minions deal 30% increased Damage"], commit: &["Minions deal 200% increased Damage"], when: mnn, pair: &[], route: false, family: Family::Plain },
    Axis { name: "minion speed", unit: &["Minions have 20% increased Attack Speed"], commit: &["Minions have 60% increased Attack Speed"], when: mnn, pair: &[], route: false, family: Family::Plain },
    Axis { name: "life", unit: &["+100 to maximum Life"], commit: &["+1000 to maximum Life"], when: any, pair: &[], route: false, family: Family::Defence },
    Axis { name: "increased life", unit: &["10% increased maximum Life"], commit: &["60% increased maximum Life"], when: any, pair: &[], route: false, family: Family::Defence },
    Axis { name: "energy shield", unit: &["+200 to maximum Energy Shield"], commit: &["+2000 to maximum Energy Shield"], when: any, pair: &[], route: false, family: Family::Defence },
    Axis { name: "increased energy shield", unit: &["20% increased maximum Energy Shield"], commit: &["120% increased maximum Energy Shield"], when: any, pair: &[], route: false, family: Family::Defence },
    Axis { name: "armour", unit: &["+1000 to Armour"], commit: &["+10000 to Armour"], when: any, pair: &[], route: false, family: Family::Defence },
    Axis { name: "evasion", unit: &["+1000 to Evasion Rating"], commit: &["+10000 to Evasion Rating"], when: any, pair: &[], route: false, family: Family::Defence },
    Axis { name: "block", unit: &["+10% Chance to Block Attack Damage"], commit: &["+40% Chance to Block Attack Damage"], when: any, pair: &[], route: false, family: Family::Defence },
    Axis { name: "elemental resistances", unit: &["+20% to all Elemental Resistances"], commit: &["+60% to all Elemental Resistances"], when: any, pair: &[], route: false, family: Family::Defence },
];

/// Score gain per axis (same units as `Scorer::score`).
pub(super) struct Sens {
    pub base: f64,
    /// Indexes into `AXES` of the axes that apply to the main skill.
    pub axes: Vec<usize>,
    pub marginal: Vec<f64>,
    pub committed: Vec<f64>,
    /// Joint axes only (0 elsewhere, empty in beam states): committed gain beyond the gains of its two halves.
    pub synergy: Vec<f64>,
    /// Wall ms per evaluation of the probe batch (whole-build text path).
    pub xml_ms: f64,
}

/// Joint axes kept after the first measurement (the beam measures every kept axis in every state).
const LIVE_JOINT: usize = 8;

fn block(lines: &[&str]) -> String {
    format!("<CustomModifierBlock title=\"probe\" enabled=\"true\" partial=\"true\">{}</CustomModifierBlock>", crate::edit::esc_text(&lines.join("\n")))
}

impl Solver {
    /// The state's build text with `lines` as one custom modifier block in the config hole (the active config set).
    pub(super) fn render_with_probe(&self, st: &State, lines: &[&str]) -> Result<String, String> {
        self.render_with(st, &block(lines))
    }

    /// Score gain of each line set over the state, as one batch of whole-build evaluations (base first).
    pub(super) fn probe_gains(&self, st: &State, probes: &[Vec<&str>]) -> Result<(f64, Vec<f64>, f64), String> {
        let mut cands = vec![Cand::Xml(Arc::new(self.render_with_probe(st, &[])?))];
        for p in probes {
            cands.push(Cand::Xml(Arc::new(self.render_with_probe(st, p)?)));
        }
        let t = Instant::now();
        // (one batch past a phase's end: a time cap is a cut, and the caller stops on `stop` after it)
        let saved = self.ignore_budget.replace(true);
        let r = self.eval(cands);
        self.ignore_budget.set(saved);
        let ms = t.elapsed().as_secs_f64() * 1000.0 / r.len() as f64;
        let score = |v: &Option<Vals>| v.as_ref().map(|v| self.score(v).0);
        // (a base that still does not evaluate, cancelled or broken, measures nothing: every gain 0)
        let Some(base) = r.first().and_then(score) else { return Ok((0.0, vec![0.0; probes.len()], ms)) };
        Ok((base, r[1..].iter().map(|v| score(v).map_or(0.0, |s| s - base)).collect(), ms))
    }

    /// The axes measured for the main skill: every base axis that applies, and the joint axes a full measurement found
    /// worth most (`full`: all of them).
    pub(super) fn sens_axes(&self, full: bool) -> Vec<usize> {
        let tags = SkillTags::of(self.main_gem);
        let live = self.live_axes.borrow();
        (0..AXES.len()).filter(|&i| (AXES[i].when)(&tags) && (AXES[i].pair.is_empty() || full || live.contains(&i))).collect()
    }

    /// Marginal and committed gain of every axis that applies to the main skill, and each joint axis's synergy. The
    /// joint axes are the live ones (see `sensitivity_full`).
    pub(super) fn sensitivity(&self, st: &State) -> Result<Sens, String> {
        self.measure(st, false)
    }

    /// `sensitivity` with every joint axis the scan made; the best of them (one per enabling half, so one route per
    /// ailment and one scaler per stat) join the live axes every later measurement takes.
    pub(super) fn sensitivity_full(&self, st: &State) -> Result<Sens, String> {
        self.measure(st, true)
    }

    fn measure(&self, st: &State, full: bool) -> Result<Sens, String> {
        let axes = self.sens_axes(full);
        let mut probes: Vec<Vec<&str>> = axes.iter().map(|&i| AXES[i].unit.to_vec()).collect();
        probes.extend(axes.iter().map(|&i| AXES[i].commit.to_vec()));
        let joint: Vec<usize> = (0..axes.len()).filter(|&k| !AXES[axes[k]].pair.is_empty()).collect();
        for &k in &joint {
            let a = &AXES[axes[k]];
            probes.push(a.pair.to_vec());
            probes.push(a.commit.iter().copied().filter(|l| !a.pair.contains(l)).collect());
        }
        let (base, gains, xml_ms) = self.probe_gains(st, &probes)?;
        let n = axes.len();
        let mut synergy = vec![0.0; n];
        for (j, &k) in joint.iter().enumerate() {
            synergy[k] = gains[n + k] - gains[2 * n + 2 * j] - gains[2 * n + 2 * j + 1];
        }
        if full {
            let mut v: Vec<(f64, usize)> = joint.iter().map(|&k| (synergy[k], axes[k])).filter(|x| x.0 > EPS).collect();
            v.sort_by(|a, b| b.0.total_cmp(&a.0));
            let mut halves: Vec<&[&str]> = Vec::new();
            let mut live = self.live_axes.borrow_mut();
            for (_, i) in v {
                if live.len() >= LIVE_JOINT {
                    break;
                }
                if !halves.contains(&AXES[i].pair) && !live.contains(&i) {
                    halves.push(AXES[i].pair);
                    live.push(i);
                }
            }
        }
        Ok(Sens { base, marginal: gains[..n].to_vec(), committed: gains[n..2 * n].to_vec(), synergy, axes, xml_ms })
    }

    /// Wall ms per evaluation of `n` node-list candidates of the state (the fast patched path), for comparison.
    pub(super) fn nodes_ms_per_eval(&self, st: &State, n: usize) -> f64 {
        let cands: Vec<Cand> = (0..n).map(|_| Cand::Nodes { base: st.base.clone(), nodes: self.full_nodes(st), mastery: None, pin: Vec::new() }).collect();
        let t = Instant::now();
        let r = self.eval(cands);
        t.elapsed().as_secs_f64() * 1000.0 / r.len().max(1) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slayer_axes_and_crit_priming() {
        let goal = r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":1000000},{"name":"EHP","metric":"ehp","value":50000}],"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"]}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":600000,"maxEvals":400000,"threads":4}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        assert!(s.ctx[cands[0]].label.contains("Slayer"), "{}", s.ctx[cands[0]].label);
        // fixed state: gems and rare gear for a bare Slayer
        let mut st = s.initial_state(cands[0], None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();

        // 1. every axis line parses, and every axis changes some stat (judged in a state that has the damage types the
        //    axes act on: a penetration or ignite line is worth nothing to a pure physical hit)
        let unparsed: Vec<&str> = AXES.iter().flat_map(|a| a.unit.iter().chain(a.commit)).copied().filter(|l| !matches!(pom_engine::modparser::parse_mod(l), (Some(_), None))).collect();
        assert!(unparsed.is_empty(), "lines the mod parser does not read: {unparsed:#?}");
        let names: Vec<&str> = vec![
            "CombinedDPS", "TotalDPS", "FullDPS", "TotalDotDPS", "Speed", "HitChance", "CritChance", "CritMultiplier", "PhysicalHitAverage", "FireHitAverage", "ColdHitAverage", "LightningHitAverage", "ChaosHitAverage",
            "Life", "EnergyShield", "Armour", "Evasion", "BlockChance", "FireResist", "ColdResist", "LightningResist", "ChaosResist", "FireResistOverCap", "ColdResistOverCap", "LightningResistOverCap", "TotalEHP", "FireMaximumHitTaken", "PoisonDPS", "BleedDPS", "IgniteDPS", "ProjectileCount",
            
        ];
        let sink: Vec<&str> = vec![
            "Gain 50% of Physical Damage as Extra Fire Damage",
            "Gain 50% of Physical Damage as Extra Cold Damage",
            "Gain 50% of Physical Damage as Extra Lightning Damage",
            "Gain 50% of Physical Damage as Extra Chaos Damage",
        ];
        let tags = SkillTags::of(s.main_gem);
        let mut sess = Session::new(s.render_with_probe(&st, &[]).unwrap(), pom_calc::data::game_data());
        let mut stats = |lines: &[&str]| sess.eval_xml_stats(&s.render_with_probe(&st, lines).unwrap(), &names, true).unwrap();
        let base = stats(&sink);
        let mut dead = Vec::new();
        for a in AXES.iter().filter(|a| (a.when)(&tags)) {
            for set in [a.unit, a.commit] {
                let mut l = sink.clone();
                l.extend(set);
                if stats(&l) == base {
                    dead.push(format!("{}: {set:?}", a.name));
                }
            }
        }
        assert!(dead.is_empty(), "axes that change no stat: {dead:#?}");

        // 2. the probe lands in the active config set
        let cfg = pom_config::xml::parse_config(&s.render_with_probe(&st, &["+1 to Level of all Skill Gems"]).unwrap()).unwrap();
        let set = &cfg.config_sets[&cfg.active_config_set_id];
        assert!(set.custom_mods.iter().any(|b| b.text.contains("Level of all Skill Gems")), "{:?}", set.custom_mods);

        // 3. crit multiplier: ~0 at base crit, worth something in the crit-committed state
        let ai = |n: &str| AXES.iter().find(|a| a.name == n).unwrap();
        let mut prime: Vec<&str> = ai("base crit chance").commit.to_vec();
        prime.extend(ai("increased crit chance").commit);
        let multi = ai("crit multiplier").unit;
        let mut primed_multi = prime.clone();
        primed_multi.extend(multi);
        let (_, g, _) = s.probe_gains(&st, &[multi.to_vec(), prime, primed_multi]).unwrap();
        let (marginal, primed) = (g[0], g[2] - g[1]);
        eprintln!("crit multi: marginal {marginal:.4}, primed {primed:.4}");
        assert!(marginal < 0.02 && primed > 0.05 && primed > 4.0 * marginal, "marginal {marginal}, primed {primed}");

        // sensitivity table + ms per eval
        let sens = s.sensitivity(&st).unwrap();
        for (k, &i) in sens.axes.iter().enumerate() {
            eprintln!("{:28} marginal {:8.4} committed {:8.4}", AXES[i].name, sens.marginal[k], sens.committed[k]);
        }
        let nodes_ms = s.nodes_ms_per_eval(&st, 64);
        eprintln!("ms per eval: Xml {:.2} (batch of {}), Nodes {:.2} (batch of 64), {} threads", sens.xml_ms, sens.axes.len() * 2 + 1, nodes_ms, s.pool.threads);
    }

    /// A phase cap (a lead's time slot) that ends before a probe batch is a cut, not a failed solve: no gains.
    #[test]
    fn probe_cut_by_cap_is_not_an_error() {
        let goal: Goal = serde_json::from_str(r#"{"skill":"Flicker Strike","targets":[{"name":"DPS"}]}"#).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":600000,"threads":2}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        let st = s.initial_state(cands[0], None, None).unwrap();
        s.phase_end.set(s.spent());
        let r = s.probe_gains(&st, &[vec!["+1 to Level of all Skill Gems"]]);
        assert!(r.as_ref().is_ok_and(|(_, g, _)| g == &vec![0.0]), "{:?}", r.err());
    }
}
