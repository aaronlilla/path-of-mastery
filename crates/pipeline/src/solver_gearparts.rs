//! Gear parts: the build-defining gear lines as parts for the
//! beam, and `SlotBudget`, which says whether a set of them still fits a slot's legal item. Parts are lines only
//! sources a plain rare cannot hold (influenced, elevated, eldritch and corruption implicits, enchants); the plain
//! affixes stay with the items layer. Priced by the engine in a primed state (probe lines), like every part.

use super::items::{CraftRules, SlotKind};
use super::*;
use std::collections::BTreeSet;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(super) enum Side {
    Prefix,
    Suffix,
    Implicit,
    Enchant,
}

/// One gear line (all lines of one family) with where it can go. `slots` index `Solver::slots`.
#[derive(Clone, Debug)]
pub(super) struct GearPart {
    /// The family's lines joined with `\n` (the shape `PartKind::ModLine` uses).
    pub text: String,
    pub slots: Vec<usize>,
    pub side: Side,
    /// `PoolMod::source` ("influence", "elevated", "exarch", "eater", "corrupted") or "enchant".
    pub source: &'static str,
    pub influence: Option<String>,
    /// Score gain over the primed state, in `Scorer::score` units.
    pub gain: f64,
    /// The same line's gain in the state without the prime: `gain - root` is what the commitment adds to it.
    pub root: f64,
}

/// Enchants rank ENDGAME over MERCILESS over the rest (data_enchantments.json tier names).
fn tier_rank(t: &str) -> u8 {
    match t {
        "ENDGAME" => 4,
        "MERCILESS" => 3,
        "CRUEL" => 2,
        _ => 1,
    }
}

impl Solver {
    /// Every gear part the unlocked slots can use, unpriced. Depends only on the solver (slots, bases, level, goal),
    /// so it is built once. Local mod lines (weapon and armour base stats) are left out: as a global line they would
    /// be priced wrongly, they stay real item evals (design 3.2).
    fn enumerate_gear_parts(&self) -> Result<Vec<GearPart>, String> {
        let game = pom_calc::data::game_data();
        let mut at: HashMap<(String, Side, &'static str, Option<String>), usize> = HashMap::default();
        let mut parts: Vec<GearPart> = Vec::new();
        let mut add = |text: String, slot: usize, side: Side, source: &'static str, influence: Option<String>| {
            let k = at.entry((text.clone(), side, source, influence.clone())).or_insert_with(|| {
                parts.push(GearPart { text, slots: Vec::new(), side, source, influence, gain: 0.0, root: 0.0 });
                parts.len() - 1
            });
            if !parts[*k].slots.contains(&slot) {
                parts[*k].slots.push(slot);
            }
        };
        let skill = gd::game_data().gems.get(self.main_gem).and_then(|g| g.name.clone()).unwrap_or_else(|| self.goal.skill.clone());
        for (i, d) in self.slots.iter().enumerate() {
            if d.locked || matches!(d.kind, SlotKind::Flask | SlotKind::Abyss | SlotKind::TreeJewel) {
                continue;
            }
            for b in self.slot_bases(i) {
                // No influence (eldritch and corruption implicits), then each single influence.
                let mut sets: Vec<Vec<String>> = vec![Vec::new()];
                sets.extend(pom_item::modpool::base_influences(game, &b)?.into_iter().filter(|k| !matches!(k.as_str(), "cleansing" | "tangle")).map(|k| vec![k]));
                for set in sets {
                    let Ok(base) = self.base_craft(&b, &set) else { continue };
                    for f in &base.fams {
                        if !matches!(f.source, "influence" | "elevated" | "exarch" | "eater" | "corrupted") || f.group.starts_with("Local") {
                            continue;
                        }
                        let side = if f.implicit { Side::Implicit } else if f.prefix { Side::Prefix } else { Side::Suffix };
                        add(f.lines.join("\n"), i, side, f.source, f.influence.clone());
                    }
                }
                // Enchants: the helmet's is the main skill's; boots, gloves, body and belt have short lists.
                if matches!(d.kind, SlotKind::Weapon1 | SlotKind::Weapon2) {
                    continue;
                }
                let mut best: HashMap<String, (u8, Vec<String>)> = HashMap::default();
                for e in pom_item::modpool::enchants(game, &b)? {
                    if d.kind == SlotKind::Helmet && !e.skill.eq_ignore_ascii_case(&skill) {
                        continue;
                    }
                    let r = tier_rank(&e.tier);
                    if best.get(&e.skill).is_none_or(|(x, _)| r > *x) {
                        best.insert(e.skill, (r, e.lines));
                    }
                }
                for (_, (_, lines)) in best {
                    add(lines.join("\n"), i, Side::Enchant, "enchant", None);
                }
            }
        }
        Ok(parts)
    }

    /// Every gear part the unlocked slots can use, best first by gain in `st` plus the `prime` lines. Memoised per
    /// (prime, state), and the enumeration under it once per solver.
    pub(super) fn all_gear_parts(&self, st: &State, prime: &[&str]) -> Result<Vec<GearPart>, String> {
        let key = format!("{}|{}", prime.join("
"), self.render_with_probe(st, &[])?);
        if let Some(r) = self.gear_all_memo.borrow().get(&key) {
            return Ok(r.clone());
        }
        let cached = self.gear_enum_memo.borrow().clone();
        let mut parts = match cached {
            Some(p) => p,
            None => {
                let p = self.enumerate_gear_parts()?;
                *self.gear_enum_memo.borrow_mut() = Some(p.clone());
                p
            }
        };
        // Two batches: each part in the primed state, and in the state as it is.
        for primed in [true, false] {
            let pre: &[&str] = if primed { prime } else { &[] };
            let mut probes: Vec<Vec<&str>> = vec![pre.to_vec()];
            probes.extend(parts.iter().map(|p| pre.iter().copied().chain(p.text.split('\n')).collect()));
            let (_, gains, _) = self.probe_gains(st, &probes)?;
            for (p, g) in parts.iter_mut().zip(&gains[1..]) {
                let v = g - gains[0];
                if primed {
                    p.gain = v;
                } else {
                    p.root = v;
                }
            }
        }
        parts.sort_by(|a, b| b.gain.partial_cmp(&a.gain).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.text.cmp(&b.text)));
        self.gear_all_memo.borrow_mut().insert(key, parts.clone());
        Ok(parts)
    }

    /// The `n` build-defining gear parts for the primed state: half the best by primed gain, half the best by what the
    /// commitment adds (`gain - root`, which is how crit multiplier shows up behind life and ES), plus the main
    /// skill's enchants whatever they rank (a global probe line undersells a skill-specific one).
    pub(super) fn gear_parts(&self, st: &State, prime: &[&str], n: usize) -> Result<Vec<GearPart>, String> {
        let all = self.all_gear_parts(st, prime)?;
        let skill = gd::game_data().gems.get(self.main_gem).and_then(|g| g.name.clone()).unwrap_or_else(|| self.goal.skill.clone());
        let mine = |p: &GearPart| p.side == Side::Enchant && p.slots.iter().any(|&s| self.slots[s].kind == SlotKind::Helmet) && p.text.contains(&skill);
        let mut out: Vec<GearPart> = all.iter().filter(|p| mine(p)).cloned().collect();
        let rest: Vec<&GearPart> = all.iter().filter(|p| !mine(p) && p.gain > 0.0).collect();
        let by_gain = n.saturating_sub(out.len()) / 2;
        out.extend(rest.iter().take(by_gain).map(|p| (*p).clone()));
        let mut lift: Vec<&GearPart> = rest[by_gain.min(rest.len())..].to_vec();
        lift.sort_by(|a, b| (b.gain - b.root).partial_cmp(&(a.gain - a.root)).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.text.cmp(&b.text)));
        out.extend(lift.into_iter().take(n.saturating_sub(out.len())).cloned());
        out.sort_by(|a, b| b.gain.partial_cmp(&a.gain).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.text.cmp(&b.text)));
        Ok(out)
    }
}

/// Whether sets of gear parts fit a slot: some base the slot can hold, with the influence set the parts need, takes
/// them all under `CraftRules` (affix counts, at most two influences, eldritch xor influence, one corruption
/// implicit unless perfect). Plus one enchant per item. Answers are memoised per (slot, parts).
pub(super) struct SlotBudget<'a> {
    s: &'a Solver,
    memo: HashMap<String, bool>,
}

impl<'a> SlotBudget<'a> {
    pub(super) fn new(s: &'a Solver) -> Self {
        SlotBudget { s, memo: HashMap::default() }
    }

    pub(super) fn fits(&mut self, slot: usize, parts: &[&GearPart]) -> bool {
        let mut ids: Vec<String> = parts.iter().map(|p| format!("{:?}|{}|{:?}|{}", p.side, p.source, p.influence, p.text)).collect();
        ids.sort();
        let key = format!("{slot}#{}", ids.join("##"));
        if let Some(&r) = self.memo.get(&key) {
            return r;
        }
        let r = self.check(slot, parts);
        self.memo.insert(key, r);
        r
    }

    fn check(&self, slot: usize, parts: &[&GearPart]) -> bool {
        if self.s.slots[slot].locked || parts.iter().any(|p| !p.slots.contains(&slot)) || parts.iter().filter(|p| p.side == Side::Enchant).count() > 1 {
            return false;
        }
        let set: BTreeSet<&String> = parts.iter().filter_map(|p| p.influence.as_ref()).collect();
        if set.len() > 2 {
            return false;
        }
        let set: Vec<String> = set.into_iter().cloned().collect();
        let real: Vec<&&GearPart> = parts.iter().filter(|p| p.side != Side::Enchant).collect();
        self.s.slot_bases(slot).iter().any(|b| {
            let Ok(base) = self.s.base_craft(b, &set) else { return false };
            let mut held: Vec<usize> = Vec::new();
            for p in &real {
                let Some(f) = base.fams.iter().position(|f| f.source == p.source && f.influence == p.influence && f.implicit == (p.side == Side::Implicit) && f.lines.join("\n") == p.text) else { return false };
                if !CraftRules::legal(&base, &held, f) {
                    return false;
                }
                held.push(f);
            }
            true
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slayer_gear_parts_and_slot_budget() {
        let goal = r#"{"skill":"Boneshatter","ascendancy":"Slayer","level":90,"targets":[{"name":"DPS","value":1000000},{"name":"EHP","metric":"ehp","value":50000}],"items":{"rarities":["rare"],"mustUse":[],"neverUse":[],"lockSlots":["Ring 2"],"craft":"top"}}"#;
        let goal: Goal = serde_json::from_str(goal).unwrap();
        let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":600000,"maxEvals":400000,"threads":4}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
        let cands = s.candidates().unwrap();
        let mut st = s.initial_state(cands[0], None, None).unwrap();
        s.gem_layer(&mut st, false).unwrap();
        s.items_layer(&mut st, false).unwrap();
        s.rebase(&mut st).unwrap();

        // The crit-primed state: base crit and increased crit committed (the sensitivity test's crit package).
        let ai = |n: &str| sens::AXES.iter().find(|a| a.name == n).unwrap();
        let mut prime: Vec<&str> = ai("base crit chance").commit.to_vec();
        prime.extend(ai("increased crit chance").commit);

        let t = Instant::now();
        let all = s.all_gear_parts(&st, &prime).unwrap();
        let top = s.gear_parts(&st, &prime, 40).unwrap();
        eprintln!("{} candidate gear parts, {} kept, {:.1}s", all.len(), top.len(), t.elapsed().as_secs_f64());
        let t1 = Instant::now();
        let again = s.gear_parts(&st, &prime, 40).unwrap();
        eprintln!("TIMING first all_gear_parts+gear_parts {:.2}s, cached gear_parts {:.3}s", t.elapsed().as_secs_f64() - t1.elapsed().as_secs_f64(), t1.elapsed().as_secs_f64());
        assert!(again.len() == top.len() && again.iter().zip(&top).all(|(a, b)| a.text == b.text && a.gain == b.gain && a.slots == b.slots));
        for p in top.iter().take(10) {
            let slots: Vec<&str> = p.slots.iter().map(|&i| s.slots[i].name.as_str()).collect();
            eprintln!("{:+.4} (root {:+.4}) {:?} {} {:?} {:?} -> {slots:?}", p.gain, p.root, p.side, p.source, p.influence, p.text.replace('\n', " / "));
        }
        assert!(top.len() <= 40 + 1);

        // The main skill's helmet enchant, with the helmet in its slot set.
        let helm = s.slot_of(SlotKind::Helmet).unwrap();
        assert!(top.iter().any(|p| p.side == Side::Enchant && p.text.contains("Boneshatter") && p.slots.contains(&helm)), "no Boneshatter helmet enchant");
        // An influenced crit multiplier line, each with slots.
        let multi = top.iter().find(|p| matches!(p.source, "influence" | "elevated") && p.influence.is_some() && p.text.contains("Critical Strike Multiplier")).expect("an influenced crit multiplier line");
        assert!(!multi.slots.is_empty() && top.iter().all(|p| !p.slots.is_empty()));

        // SlotBudget: eldritch alone fits a helmet, influence alone fits, both on one helmet do not.
        let eld = all.iter().find(|p| matches!(p.source, "exarch" | "eater") && p.slots.contains(&helm)).expect("an eldritch helmet part");
        let inf = all.iter().find(|p| matches!(p.source, "influence") && p.slots.contains(&helm)).expect("an influenced helmet part");
        let mut b = SlotBudget::new(&s);
        let r = (b.fits(helm, &[eld]), b.fits(helm, &[inf]), b.fits(helm, &[eld, inf]));
        eprintln!("eldritch {r:?} (alone, influence alone, both): {} / {}", eld.text.replace('\n', " / "), inf.text.replace('\n', " / "));
        assert_eq!(r, (true, true, false));
    }
}
