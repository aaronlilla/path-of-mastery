//! Wealth tiers (goal `wealth`): the gear a player at league start, mid league, rich or mirror can own. What each tier
//! allows is engine data (`engine-data/wealth_tiers.json`): modifier sources, item level (normal mod tiers), how many
//! influences and corruption implicits, the best eldritch tier, large cluster jewels, and unique price bands. Unique
//! prices come with the goal (the app's live poe.ninja prices, in divine orbs) or from `engine-data/wealth_prices.json`
//! (`tools/wealth-prices.mjs`); a unique with neither is not on the market and counts as `unpriced`.

use serde::Deserialize;
use std::collections::HashMap as StdMap;
use std::sync::OnceLock;

#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "kebab-case")]
pub enum Wealth {
    LeagueStart,
    MidLeague,
    Rich,
    Mirror,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Table {
    labels: StdMap<String, String>,
    item_level: StdMap<String, u32>,
    source: StdMap<String, Wealth>,
    influences: StdMap<String, usize>,
    corrupted_implicits: StdMap<String, usize>,
    unveil_cap: StdMap<String, usize>,
    eldritch_best_tier: StdMap<String, u8>,
    pool_floor: StdMap<String, f64>,
    large_cluster: Wealth,
    made_to_order: Wealth,
    made_to_order_divines: StdMap<String, f64>,
    unique_divines: StdMap<String, f64>,
    unpriced: Wealth,
    budget_divines: StdMap<String, f64>,
    rare: RarePrices,
    link_fusings: StdMap<String, f64>,
    socket_jewellers: StdMap<String, f64>,
    chromatic_cap: f64,
}

/// An ordinary line: life, an elemental or chaos resistance, or a single attribute, by its mod group (game data), not its
/// name. These spawn often and sell for chaos even at the top tier.
pub(super) fn is_ordinary(f: &super::items::Fam) -> bool {
    let g = f.group.strip_suffix("ForJewel").or_else(|| f.group.strip_suffix("Prefix")).unwrap_or(&f.group);
    f.lines.len() == 1 && matches!(g, "IncreasedLife" | "FireResistance" | "ColdResistance" | "LightningResistance" | "ChaosResistance" | "Strength" | "Dexterity" | "Intelligence")
}

/// A good-tier ordinary line: the first to step down when a craft is over budget (a lower tier of life or a resist is
/// nearly as good, and it is common), before any scarce line.
pub(super) fn steps_first(f: &super::items::Fam) -> bool {
    is_ordinary(f) && f.tier <= table().rare.good_tier
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RarePrices {
    tier_divines: Vec<f64>,
    weapon_tier_divines: Vec<f64>,
    good_tier: u32,
    good_factor: f64,
    line_factor: f64,
    rare_scale: StdMap<String, f64>,
    eldritch_divines: Vec<f64>,
    corrupted_divines: f64,
    multimod_divines: f64,
    bench_divines: f64,
    catalyst_divines: f64,
    anoint_divines: f64,
    magic_divines: f64,
    unveil_attempt_divines: f64,
    unveil_hit_chance: f64,
}

#[derive(Deserialize)]
struct Prices {
    league: String,
    #[serde(rename = "fetchedAt")]
    fetched_at: String,
    prices: StdMap<String, f64>,
    #[serde(default)]
    gems: StdMap<String, f64>,
    #[serde(default)]
    currency: StdMap<String, f64>,
}

fn table() -> &'static Table {
    static T: OnceLock<Table> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(include_str!("../../../engine-data/wealth_tiers.json")).expect("wealth_tiers.json"))
}

fn snapshot() -> &'static Prices {
    static P: OnceLock<Prices> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str(include_str!("../../../engine-data/wealth_prices.json")).expect("wealth_prices.json"))
}

impl Wealth {
    const ALL: [Wealth; 4] = [Wealth::LeagueStart, Wealth::MidLeague, Wealth::Rich, Wealth::Mirror];

    pub fn key(self) -> &'static str {
        match self {
            Wealth::LeagueStart => "league-start",
            Wealth::MidLeague => "mid-league",
            Wealth::Rich => "rich",
            Wealth::Mirror => "mirror",
        }
    }
    fn label(self) -> &'static str {
        table().labels.get(self.key()).map_or(self.key(), |s| s.as_str())
    }
    /// The highest item level a crafted rare has: caps normal modifier tiers (and cluster notables) by game data.
    pub fn item_level(self) -> u32 {
        table().item_level[self.key()]
    }
    /// The life-plus-energy-shield floor a goal that leaves the default gets at this tier.
    pub fn pool_floor(self) -> f64 {
        table().pool_floor[self.key()]
    }
    pub fn max_influences(self) -> usize {
        table().influences[self.key()]
    }
    /// Most veiled mods across the whole build.
    pub fn unveil_cap(self) -> usize {
        table().unveil_cap[self.key()]
    }
    pub fn max_corrupted(self) -> usize {
        table().corrupted_implicits[self.key()]
    }
    /// The best eldritch implicit tier (1 = perfect .. 6 = lesser) the tier can afford; 7: none.
    pub fn eldritch_floor(self) -> u8 {
        table().eldritch_best_tier[self.key()]
    }
    /// Whether a modifier from `source` (`Fam::source`) is in reach. Unknown sources only at mirror.
    pub fn allows_source(self, source: &str) -> bool {
        table().source.get(source).map_or(self == Wealth::Mirror, |t| *t <= self)
    }
    pub fn allows_large_cluster(self) -> bool {
        table().large_cluster <= self
    }
    /// The lowest tier for a unique whose mods the solver picks (Watcher's Eye, Megalomaniac, ...): its cheapest listing is
    /// a random roll, not the copy the build needs.
    pub fn made_to_order() -> Wealth {
        table().made_to_order
    }
    /// What a made-to-order unique with `mods` chosen mods costs in divine orbs.
    pub fn made_to_order_divines(mods: usize) -> f64 {
        table().made_to_order_divines.get(&mods.clamp(1, 3).to_string()).copied().unwrap_or(0.0)
    }
    /// The tier a unique costing `divines` belongs to (None: no price).
    pub fn of_price(divines: Option<f64>) -> Wealth {
        let Some(p) = divines else { return table().unpriced };
        Wealth::ALL.into_iter().find(|w| table().unique_divines.get(w.key()).is_none_or(|cap| p <= *cap)).unwrap_or(Wealth::Mirror)
    }
    /// A unique's price in divine orbs: the goal's live prices, else the snapshot.
    pub fn price(live: &StdMap<String, f64>, name: &str) -> Option<f64> {
        live.get(name).or_else(|| snapshot().prices.get(name)).copied()
    }
    /// A gem's price in divine orbs (snapshot: uncorrupted, at the highest level sold uncorrupted).
    pub fn gem_price(name: &str) -> Option<f64> {
        snapshot().gems.get(name).copied()
    }
    /// What linking `n` sockets costs on the crafting bench, in divine orbs (0 below 5 links).
    pub fn links_divines(n: usize) -> f64 {
        let fusings = table().link_fusings.get(&n.min(6).to_string()).copied().unwrap_or(0.0);
        fusings * snapshot().currency.get("fusing").copied().unwrap_or(0.0)
    }
    pub fn chromatic_cap() -> f64 {
        table().chromatic_cap
    }
    /// What one item's sockets cost in divine orbs: `used` sockets (Jeweller's Orbs from 5) and the `chromatics` its
    /// colours take (at most the cap).
    pub fn sockets_divines(used: usize, chromatics: f64) -> f64 {
        let price = |k: &str| snapshot().currency.get(k).copied().unwrap_or(0.0);
        table().socket_jewellers.get(&used.to_string()).copied().unwrap_or(0.0) * price("jewellers") + chromatics.min(table().chromatic_cap) * price("chrome")
    }
    /// What an anoint costs, in divine orbs (the rare estimate's flat anoint price).
    pub fn anoint_divines() -> f64 {
        table().rare.anoint_divines
    }
    /// The whole build's price cap in divine orbs (None: no cap).
    pub fn budget(self) -> Option<f64> {
        table().budget_divines.get(self.key()).copied()
    }
    /// A crafted item's estimated price in divine orbs (the formula is `_rare` in wealth_tiers.json):
    /// the sum of its line prices by tier + unveil gambles + implicits, crafts and the anoint at flat prices.
    pub(super) fn craft_divines(w: Option<Wealth>, base: &super::items::BaseInfo, mods: &[usize], anoint: bool) -> f64 {
        Self::fams_divines(w, base.magic, super::items::WEAPON_TYPES.contains(&base.item_type.as_str()), mods.iter().filter_map(|&i| base.fams.get(i)), anoint)
    }
    /// `craft_divines` of the families `fams` held on a base (`magic`: a flask; `weapon`: a weapon's lines have their own price table); `w`: the goal's wealth tier (its `rareScale` scales the lines).
    pub(super) fn fams_divines<'a>(w: Option<Wealth>, magic: bool, weapon: bool, fams: impl Iterator<Item = &'a super::items::Fam>, anoint: bool) -> f64 {
        let r = &table().rare;
        if magic {
            return r.magic_divines;
        }
        let by_tier = |list: &[f64], t: u32| list.get(t.max(1) as usize - 1).or(list.last()).copied().unwrap_or(0.0);
        let tiers = if weapon { &r.weapon_tier_divines } else { &r.tier_divines };
        let (mut lines, mut good, mut veiled, mut flat, mut live) = (0.0, 0i32, 0i32, 0.0, 0.0);
        if anoint {
            flat += r.anoint_divines;
        }
        for f in fams {
            match f.source {
                "bench" if f.group == "ItemGenerationCanHaveMultipleCraftedMods" => flat += r.multimod_divines,
                "bench" => flat += r.bench_divines,
                "enchant" => {}
                "catalyst" => flat += r.catalyst_divines,
                "exarch" | "eater" => live += by_tier(&r.eldritch_divines, f.tier),
                "corrupted" => live += r.corrupted_divines,
                // a gamble: three mods are offered per unveil, and the wanted one must be among them
                "veiled" => {
                    live += r.unveil_attempt_divines / r.unveil_hit_chance * r.good_factor.powi(veiled);
                    veiled += 1;
                }
                _ => {
                    lines += by_tier(tiers, f.tier);
                    good += (f.tier <= r.good_tier) as i32;
                }
            }
        }
        // each good line past the first multiplies the lines' price by lineFactor (fitted to live listings); the
        // wealth tier's rareScale (its era's chaos per divine against today's) scales the lines
        // (eldritch, corrupted and unveiled prices are live listing prices too, so they scale with the era like the lines)
        (lines * r.line_factor.powi((good - 1).max(0)) + live) * w.map_or(1.0, |w| r.rare_scale.get(w.key()).copied().unwrap_or(1.0)) + flat
    }
    /// The assumptions line.
    pub fn assumption(self, live_prices: bool) -> String {
        let t = table();
        let mut no: Vec<String> = Vec::new();
        match self.max_influences() {
            0 => no.push("no influenced mods".into()),
            1 => no.push("no double influence".into()),
            _ => {}
        }
        if !self.allows_source("exarch") {
            no.push("no eldritch implicits".into());
        } else if self.eldritch_floor() > 1 {
            no.push(format!("eldritch implicits tier {} at best", self.eldritch_floor()));
        }
        match self.max_corrupted() {
            0 => no.push("no corrupted implicits".into()),
            1 => no.push("no double corruption".into()),
            _ => {}
        }
        for (src, what) in [("delve", "fossil"), ("veiled", "veiled"), ("elevated", "elevated")] {
            if !self.allows_source(src) {
                no.push(format!("no {what} mods"));
            }
        }
        if !self.allows_large_cluster() {
            no.push("no cluster jewels".into());
        }
        if Wealth::made_to_order() > self {
            no.push("no Watcher's Eye, Megalomaniac, Forbidden jewels or Impossible Escape".into());
        }
        let uniques = match t.unique_divines.get(self.key()) {
            Some(d) => format!("uniques up to {d} divine"),
            None if t.budget_divines.contains_key(self.key()) => "uniques at their price inside that total".into(),
            None => "every unique".into(),
        };
        let src = if live_prices { "live poe.ninja prices where the goal fetched them, the snapshot for the rest".to_string() } else { let s = snapshot(); format!("poe.ninja {} prices from {}", s.league, s.fetched_at) };
        let unpriced = if t.unpriced > self { ", none that is not on the market" } else { "" };
        let mut s = format!("Wealth: {}: rares up to item level {}", self.label(), self.item_level());
        match self.budget() {
            Some(b) => s.push_str(&format!(", whole build about {b} divine at most (rares priced by their mod tiers)")),
            None => s.push_str(", no limit on the build's price"),
        }
        for n in no {
            s.push_str(", ");
            s.push_str(&n);
        }
        s.push_str(&format!(", {uniques} ({src}){unpriced}"));
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_reads_and_orders() {
        assert!(Wealth::LeagueStart < Wealth::Mirror);
        assert!(!Wealth::MidLeague.allows_source("corrupted") && Wealth::Rich.allows_source("corrupted"));
        assert_eq!(Wealth::of_price(Some(0.01)), Wealth::LeagueStart);
        // (mid league has no per-unique cap: any priced unique is in reach, the 10 divine total limits it)
        assert_eq!(Wealth::of_price(Some(500.0)), Wealth::MidLeague);
        assert_eq!(Wealth::of_price(None), Wealth::Mirror);
        assert!(Wealth::price(&StdMap::new(), "Goldrim").is_some());
        eprintln!("{}", Wealth::MidLeague.assumption(false));
    }

    /// Mid league is 10 divine in total at market prices and no separate cap per unique: a 1.5 divine
    /// unique is allowed (and is in the pool), a unique with no price still is not.
    #[test]
    fn mid_league_has_no_per_unique_cap() {
        assert_eq!(Wealth::of_price(Some(1.5)), Wealth::MidLeague);
        let mid = solver_at("mid-league");
        let live = StdMap::new();
        let in_pool = mid.uniques.iter().filter(|u| Wealth::price(&live, &u.name).is_some_and(|p| p > 1.0 && p <= 10.0)).count();
        assert!(in_pool > 0, "no unique between 1 and 10 divine in the mid-league pool");
        assert!(!mid.assumptions.iter().any(|a| a.contains("uniques up to 1 divine")));
    }

    fn flicker(wealth: &str) -> String {
        format!(r#"{{"assume":{{"playMode":"mapping"}},"skill":"Flicker Strike","level":90,"targets":[{{"name":"DPS"}}],"wealth":"{wealth}"}}"#)
    }

    fn solver_at(wealth: &str) -> super::super::Solver {
        use super::super::*;
        let goal: Goal = serde_json::from_str(&flicker(wealth)).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap()
    }

    /// The item pool a Flicker Strike goal gets: mid league has no corruption implicits (a tree jewel's either), no
    /// double influence and no unique above the mid-league price band; mirror still has all three.
    #[test]
    fn mid_league_pool_has_no_corruption_double_influence_or_dear_uniques() {
        let live = StdMap::new();
        let dear = |s: &super::super::Solver| s.uniques.iter().filter(|u| Wealth::of_price(Wealth::price(&live, &u.name)) > Wealth::MidLeague).map(|u| u.name.clone()).collect::<Vec<_>>();
        let pair = || vec!["elder".to_string(), "shaper".to_string()];
        let mid = solver_at("mid-league");
        let mirror = solver_at("mirror");
        let corrupted = |s: &super::super::Solver, base: &str| s.base_craft(base, &[]).unwrap().fams.iter().filter(|f| f.source == "corrupted").count();
        let (mid_dear, mirror_dear) = (dear(&mid), dear(&mirror));
        let (mid_jewel, mirror_jewel) = (corrupted(&mid, "Cobalt Jewel"), corrupted(&mirror, "Cobalt Jewel"));
        let (mid_pair, mirror_pair) = (mid.base_craft("Diamond Ring", &pair()).is_ok(), mirror.base_craft("Diamond Ring", &pair()).is_ok());
        eprintln!("uniques above mid league: mid {} (e.g. {:?}), mirror {} (e.g. {:?})", mid_dear.len(), mid_dear.first(), mirror_dear.len(), mirror_dear.first());
        eprintln!("jewel corruption implicits: mid {mid_jewel}, mirror {mirror_jewel}; double-influence ring: mid {mid_pair}, mirror {mirror_pair}");
        eprintln!("{}", mid.assumptions.iter().find(|a| a.starts_with("Wealth")).cloned().unwrap_or_default());
        assert!(mid_dear.is_empty() && !mirror_dear.is_empty());
        assert!(mid_jewel == 0 && mirror_jewel > 0);
        assert!(!mid_pair && mirror_pair);
    }

    /// A real day-3 rare (Dusk Flame Crimson Jewel, from a pconc Pathfinder on poe.ninja) prices within the
    /// good-line multiplier of the sum of its line prices, not 27x it.
    #[test]
    fn real_rare_prices_near_its_lines() {
        let s = solver_at("mirror");
        let b = s.base_craft("Crimson Jewel", &[]).unwrap();
        let norm = |l: &str| l.chars().filter(|c| !c.is_ascii_digit() && *c != '.').collect::<String>();
        let real = ["+10 to Strength and Intelligence", "16% increased Critical Strike Chance with Lightning Skills", "10% increased Projectile Damage", "7% increased Flask Effect Duration"];
        let mods: Vec<usize> = real.iter().map(|l| (0..b.fams.len()).find(|&f| b.fams[f].source == "normal" && b.fams[f].lines.len() == 1 && norm(&b.fams[f].lines[0]) == norm(l)).unwrap_or_else(|| panic!("no family for {l}"))).collect();
        let lines: f64 = mods.iter().map(|&f| Wealth::fams_divines(None, false, false, [&b.fams[f]].into_iter(), false)).sum();
        let cost = Wealth::craft_divines(None, &b, &mods, false);
        println!("Dusk Flame: {cost:.2} div, line prices {lines:.2} div (tiers {:?})", mods.iter().map(|&f| b.fams[f].tier).collect::<Vec<_>>());
        assert!(cost <= 3.5 * lines, "{cost} vs lines {lines}");
    }

    /// Calibrated to live trade listings (Allflame, 468 chaos per divine): an item with 2 tier-1
    /// ordinary lines sells near 0.05 divine (ours must be within 0.02-0.12); one with 4 sells from 0.05 to 0.5.
    /// Before: 0.8 and 1.6 divine.
    #[test]
    fn ordinary_lines_price_near_live_listings() {
        use super::super::items::addable;
        let s = solver_at("mirror");
        let b = s.base_craft("Astral Plate", &[]).unwrap();
        let mut got = Vec::new();
        for f in 0..b.fams.len() {
            if got.len() < 4 && b.fams[f].source == "normal" && b.fams[f].tier == 1 && is_ordinary(&b.fams[f]) && addable(&b, &got, f) {
                got.push(f);
            }
        }
        assert_eq!(got.len(), 4);
        let (two, four) = (Wealth::craft_divines(None, &b, &got[..2], false), Wealth::craft_divines(None, &b, &got, false));
        println!("2 tier-1 ordinary lines {two:.3} div, 4 lines {four:.3} div");
        assert!((0.02..=0.12).contains(&two), "{two}");
        assert!((0.05..=0.5).contains(&four), "{four}");
    }

    /// Filling an empty prefix with a mid-tier line is cheap, and unveil mods are a priced gamble that grows with repeats.
    #[test]
    fn cheap_prefix_and_priced_unveils() {
        use super::super::items::addable;
        let s = solver_at("mirror");
        let b = s.base_craft("Astral Plate", &[]).unwrap();
        let ordinary = |f: usize| is_ordinary(&b.fams[f]);
        let mut good = Vec::new();
        for f in 0..b.fams.len() {
            if b.fams[f].source == "normal" && b.fams[f].tier == 1 && !ordinary(f) && addable(&b, &good, f) && good.len() < 2 {
                good.push(f);
            }
        }
        assert_eq!(good.len(), 2);
        let mid = (0..b.fams.len()).find(|&f| b.fams[f].source == "normal" && ordinary(f) && addable(&b, &good, f)).expect("a life or resist line that still fits");
        // (the same line at a mid tier, tier 3 or below)
        let mut low = b.fams[mid].clone();
        while low.tier < 3 {
            low = low.stepped().expect("a lower tier");
        }
        let (base_cost, with_mid) = (Wealth::craft_divines(None, &b, &good, false), Wealth::fams_divines(None, false, false, good.iter().map(|&g| &b.fams[g]).chain([&low]), false));
        println!("2 good lines {base_cost:.2}, plus one ordinary line {with_mid:.2}");
        assert!(with_mid - base_cost <= 0.05 + 1e-9, "{base_cost} -> {with_mid}");
        let jun = (0..s.base_craft("Diamond Ring", &[]).unwrap().fams.len()).collect::<Vec<_>>();
        let ring = s.base_craft("Diamond Ring", &[]).unwrap();
        let v = jun.into_iter().find(|&f| ring.fams[f].source == "veiled").expect("a veiled family on rings");
        let (one, five) = (Wealth::craft_divines(None, &ring, &[v], false), Wealth::craft_divines(None, &ring, &[v; 5], false));
        println!("1 unveil {one:.2}, 5 unveils on one item {five:.2}");
        assert!((0.05..=0.5).contains(&one) && five > 5.0 * one, "{one} {five}");
    }

    /// Extras fitted to live Allflame listings (768 listings): an eldritch implicit, a corruption implicit and
    /// an unveiled mod each add cents to tenths of a divine, not the old 5 / 3 / 1.3 divine; a weapon's lines sit near the armour table.
    #[test]
    fn eldritch_corrupted_unveiled_and_weapon_prices_near_live_listings() {
        use super::super::items::addable;
        let s = solver_at("mirror");
        let h = s.base_craft("Divine Crown", &[]).unwrap();
        for src in ["exarch", "eater"] {
            let f = h.fams.iter().position(|f| f.source == src).unwrap();
            let p = Wealth::craft_divines(None, &h, &[f], false);
            println!("{src} tier {} implicit {p:.3} div", h.fams[f].tier);
            assert!((0.01..=0.2).contains(&p), "{src} {p}");
        }
        let j = s.base_craft("Cobalt Jewel", &[]).unwrap();
        let c = Wealth::craft_divines(None, &j, &[j.fams.iter().position(|f| f.source == "corrupted").unwrap()], false);
        assert!((0.005..=0.1).contains(&c), "corrupted {c}");
        let ring = s.base_craft("Diamond Ring", &[]).unwrap();
        let u = Wealth::craft_divines(None, &ring, &[ring.fams.iter().position(|f| f.source == "veiled").unwrap()], false);
        assert!((0.05..=0.4).contains(&u), "unveiled {u}");
        // a bow with three tier-1 lines: 0.0165 x 3 x 1.5^2 = 0.11 (a real Spine Bow with such lines lists near 0.05-0.3)
        let bow = s.base_craft("Spine Bow", &[]).unwrap();
        let mut got = Vec::new();
        for f in 0..bow.fams.len() {
            if got.len() < 3 && bow.fams[f].source == "normal" && bow.fams[f].tier == 1 && addable(&bow, &got, f) {
                got.push(f);
            }
        }
        assert_eq!(got.len(), 3);
        let w = Wealth::craft_divines(None, &bow, &got, false);
        println!("bow with 3 tier-1 lines {w:.3} div");
        assert!((0.05..=0.3).contains(&w), "bow {w}");
    }

    /// Veiled (Jun unveil) mods are capped across the whole build (mid league: 2), not per slot.
    #[test]
    fn unveils_are_capped_across_slots() {
        use super::super::items::{craft_piece, SlotKind};
        let taken = |w: &str| -> usize {
            let s = solver_at(w);
            let mut gear = (*s.start_gear).clone();
            let mut n = 0;
            for (kind, base) in [(SlotKind::Ring, "Diamond Ring"), (SlotKind::Amulet, "Onyx Amulet"), (SlotKind::Belt, "Stygian Vise"), (SlotKind::Gloves, "Sorcerer Gloves"), (SlotKind::Boots, "Sorcerer Boots")] {
                let Ok(b) = s.base_craft(base, &[]) else { continue };
                let Some(v) = (0..b.fams.len()).find(|&f| b.fams[f].source == "veiled") else { continue };
                for i in (0..s.slots.len()).filter(|&i| s.slots[i].kind == kind) {
                    if let Some(g) = s.with_piece(&gear, i, Some(craft_piece(&b, vec![v], None, s.item_level))) {
                        gear = g;
                        n += 1;
                    }
                }
            }
            n
        };
        let (mid, mirror) = (taken("mid-league"), taken("mirror"));
        println!("items with an unveil: mid league {mid}, mirror {mirror}");
        assert_eq!(mid, 2);
        assert!(mirror > 2);
    }

    /// One weapon with every top-tier line it can hold costs more than league start's whole budget (4 divine, the median day-3 level 85-90 kit; the live
    /// fit's lines times that tier's rareScale): there its lines step down to lower tiers until it fits; taken as it is at
    /// mirror (no cap).
    #[test]
    fn budget_caps_the_build_price() {
        use super::super::items::{addable, craft_piece, SlotKind};
        assert_eq!((Wealth::LeagueStart.budget(), Wealth::Mirror.budget()), (Some(4.0), None));
        for (w, top) in [("league-start", false), ("mirror", true)] {
            let s = solver_at(w);
            let b = s.base_craft("Apex Cleaver", &[]).unwrap();
            let mut mods = Vec::new();
            for f in 0..b.fams.len() {
                if b.fams[f].source == "normal" && b.fams[f].tier <= 2 && addable(&b, &mods, f) {
                    mods.push(f);
                }
            }
            let p = craft_piece(&b, mods.clone(), None, s.item_level);
            let cost = s.piece_cost(&p);
            let wi = s.slot_of(SlotKind::Weapon1).unwrap();
            let g = s.with_piece(&s.start_gear, wi, Some(p.clone())).expect("taken");
            let q = g.pieces[wi].clone().unwrap();
            println!("{w}: {} ({cost:.1} divine) taken as {} ({:.1})", p.label, q.label, s.piece_cost(&q));
            assert!(cost > if top { 0.3 } else { 3.0 }, "{cost}");
            assert_eq!(q.label == p.label, top || cost <= 4.0);
            assert!(top || s.piece_cost(&q) <= 4.0);
        }
    }

    /// A pconc solve at league start: the 6-link took
    /// 0.85 of the 1 divine (the budget is 4 now: the 6-link fits), six slots kept no line and lightning resistance sat at 35/75.
    /// The solve must fill every slot within budget and meet the resist limit.
    #[test]
    fn league_start_six_link_gives_way_to_failed_resists() {
        use super::super::items::SlotKind;
        use super::super::*;
        let goal: Goal = serde_json::from_str(r#"{"skill":"Poisonous Concoction","level":90,"wealth":"league-start","targets":[{"name":"DPS","metric":"combined","value":3000000},{"name":"EHP","metric":"ehp","value":80000}],"assume":{"playMode":"mapping"}}"#).unwrap();
        let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
        let mut s = Solver::new(blank_build_xml(90), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
        let c = s.candidates().unwrap();
        let main: Vec<&'static str> = ["Poisonous Concoction", "Unbound Ailments", "Void Manipulation", "Deadly Ailments", "Added Chaos Damage", "Vicious Projectiles"].iter().map(|n| find_gem(n).unwrap()).collect();
        let mut st = s.initial_state(c[0], Some((main, Vec::new())), None).unwrap();
        let cap = s.goal.wealth.and_then(|w| w.budget()).unwrap();
        assert!(Wealth::links_divines(6) < cap && Wealth::links_divines(5) < 0.1 * cap);
        s.items_layer(&mut st, false).unwrap();
        let lim = |st: &State, n: &str| s.scorer.limits.iter().position(|l| l.name.starts_with(n)).map(|k| s.scorer.deficits(&st.vals)[k]).unwrap();
        let bare = s.bare_slots(&st.gear);
        println!("main {} links, cost {:.2} (gems {:.2}), viol {:.2}, lightning short {:.2}, bare {bare}", st.main.len(), s.gear_cost(&st.gear), st.gear.gems, st.viol, lim(&st, "Lightning resistance"));
        for (k, p) in st.gear.pieces.iter().enumerate().filter(|(k, _)| !matches!(s.slots[*k].kind, SlotKind::Flask | SlotKind::TreeJewel | SlotKind::Abyss)) {
            println!("  {}: {}", s.slots[k].name, p.as_ref().map_or("-".to_string(), |p| p.label.clone()));
        }
        assert!(s.gear_cost(&st.gear) <= cap + 1e-9);
        assert_eq!(bare, 0, "slots left bare");
        assert!(lim(&st, "Lightning resistance") < 0.4, "lightning resistance still short {:.2}", lim(&st, "Lightning resistance"));
    }

    /// A real mid-league Flicker Strike solve: no result's crafted item carries a corruption implicit or two
    /// influences, and no unique above the mid-league band; the whole build costs at most the tier's 10 divine.
    #[test]
    fn mid_league_flicker_results_are_affordable() {
        use super::super::*;
        let mut h = start(blank_build_xml(90), &flicker("mid-league"), r#"{"timeBudgetMs":600000,"maxEvals":40000,"threads":2}"#).unwrap();
        h.join();
        let (snap, _) = h.step(0, 0);
        assert!(snap.get("error").is_none(), "{snap}");
        let res = snap["results"].as_array().unwrap();
        assert!(!res.is_empty());
        let live = StdMap::new();
        for r in res.iter().filter(|r| r["start"] != true) {
            let (cost, a) = (r["costDivines"].as_f64().unwrap(), &r["assumptions"]);
            println!("result {}: about {cost:.2} divine; {a}", r["index"]);
            assert!(cost <= 10.0 + 1e-6, "result {} costs {cost}", r["index"]);
        }
        let infl = ["Shaper Item", "Elder Item", "Warlord Item", "Hunter Item", "Crusader Item", "Redeemer Item"];
        for i in 0..res.len() {
            let x = h.result_xml(i).unwrap();
            if i == 0 {
                // (for a by-hand look at the best result)
                let _ = std::fs::write(std::env::temp_dir().join("pom-wealth-mid-league.xml"), &x);
            }
            for item in x.split("<Item id=\"").skip(1).map(|t| t.split("</Item>").next().unwrap_or("")) {
                let lines: Vec<&str> = item.lines().map(str::trim).collect();
                let name = lines.iter().position(|l| l.contains("Rarity:")).and_then(|r| lines.get(r + 1)).copied().unwrap_or("");
                if item.contains("Rarity: UNIQUE") {
                    let tier = Wealth::of_price(Wealth::price(&live, name));
                    println!("result {i}: unique {name} ({tier:?})");
                    assert!(tier <= Wealth::MidLeague, "result {i}: {name} is {tier:?}");
                    assert!(!["Watcher's Eye", "Megalomaniac", "Forbidden Flame", "Forbidden Flesh", "Impossible Escape"].contains(&name), "result {i}: made-to-order {name}");
                } else {
                    let n = lines.iter().filter(|l| infl.contains(l)).count();
                    assert!(!lines.contains(&"Corrupted"), "result {i}: corrupted {name}: {item:.300}");
                    assert!(n <= 1, "result {i}: {n} influences on {name}");
                }
            }
        }
    }

}
