//! Damage scaling a seasoned player takes that the solver once missed, on the
//! Pathfinder and Assassin results of "Poisonous Concoction, league start, 3M DPS, 80k EHP" (the old solver's own output).

use super::*;

const GOAL: &str = r#"{"skill":"Poisonous Concoction","level":90,"wealth":"league-start","targets":[{"name":"DPS","metric":"combined","value":3000000},{"name":"EHP","metric":"ehp","value":80000}],"assume":{"playMode":"mapping"}}"#;
const PF_MAIN: [&str; 6] = ["Poisonous Concoction", "Unbound Ailments", "Void Manipulation", "Deadly Ailments", "Added Chaos Damage", "Vicious Projectiles"];
const PF_UTILS: [&str; 6] = ["Clarity", "Precision", "Summon Flame Golem", "Phase Run", "Purity of Fire", "Enfeeble"];
const AS_MAIN: [&str; 6] = ["Poisonous Concoction", "Unbound Ailments", "Critical Strike Affliction", "Void Manipulation", "Added Chaos Damage", "Pierce"];
const AS_UTILS: [&str; 5] = ["Clarity", "Purity of Lightning", "Summon Flame Golem", "Phase Run", "Wither"];
// (tree node ids, 3_29)
const MASTER_SURGEON: i64 = 63293;
const NATURES_REPRISAL: i64 = 40813;
const ETERNAL_SUFFERING: i64 = 11995;
const DEATHMARKED: i64 = 48239;
const OPPORTUNISTIC: i64 = 19083;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// The result build as a solver state: its own class, tree, gems and items.
fn open(name: &str, main: &[&str], utils: &[&str]) -> (Solver, State) {
    let goal: Goal = serde_json::from_str(GOAL).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(fixture(name), goal, Options::default(), shared, Arc::new(AtomicBool::new(false))).unwrap();
    let c = s.candidates().unwrap();
    let g = |n: &&str| find_gem(n).unwrap_or_else(|| panic!("gem {n}"));
    let mut st = s.initial_state(c[0], Some((main.iter().map(g).collect(), utils.iter().map(g).collect())), None).unwrap();
    let mut gear = (*st.gear).clone();
    gear.pieces = s.player_pieces.clone();
    gear.ready = true;
    st.gear = Arc::new(gear);
    s.rebase(&mut st).unwrap();
    (s, st)
}

fn swapped(st: &State, out: i64, add: &[i64]) -> Vec<i64> {
    st.nodes.iter().copied().filter(|&n| n != out).chain(add.iter().copied()).collect()
}

/// The scored damage (a bare DPS target scores single target, even in mapping).
fn dps(s: &Solver, v: &Vals) -> f64 {
    v[s.scorer.names.iter().position(|n| n == "CombinedDPS").unwrap()].unwrap_or(0.0)
}

/// Single-target CombinedDPS of the state's text (what upstream's sidebar shows).
fn single(s: &Solver, st: &State) -> f64 {
    eval_one(&mut None, &Cand::Xml(Arc::new(s.render(st).unwrap())), &["CombinedDPS"]).unwrap()[0].unwrap_or(0.0)
}

/// Poisonous Concoction's "Life" part adds the worn life flask's recovery as damage. The old result was scored on
/// "No Flask" (no skillPart) and loses about 30% to it; the solver now scores the part the flask feeds and offers the
/// life flask base that recovers the most.
#[test]
fn flask_fed_part_is_scored() {
    let x = fixture("pconc-pathfinder.xml");
    assert!(!x.contains("skillPart"), "the old result set a part");
    let (s, st) = open("pconc-pathfinder.xml", &PF_MAIN, &PF_UTILS);
    assert_eq!(s.main_part.get().map(|p| (p.0, p.1.as_str())), Some((2, "Life")));
    assert!(s.render(&st).unwrap().contains("<Gem skillPart=\"2\" nameSpec=\"Poisonous Concoction\""));
    let flasks = s.life_flasks().unwrap();
    assert!(flasks.iter().any(|p| p.xml.contains("Divine Life Flask")), "the most-recovery base is offered");
}

/// Withered from the build's own chance on hit (the gem's quality, Nature's Reprisal, Eternal Suffering) was never
/// counted: only a Wither totem set stacks.
#[test]
fn withered_from_chance_on_hit() {
    let l = |t: &str| vec![t.to_string()];
    assert!((config::wither_gen(&l("25% chance to inflict Withered for 2 seconds on Hit"), 0.2, 1.6) - 1.44).abs() < 1e-9);
    assert_eq!(config::wither_gen(&l("50% chance to inflict Withered for two seconds on Hit if there are 5 or fewer Withered Debuffs on Enemy"), 0.0, 10.0), 6.0);
    assert_eq!(config::wither_gen(&l("Inflict Withered for 2 seconds on Hit"), 0.0, 10.0), 15.0);
    assert!((config::gem_wither_chance(find_gem("Poisonous Concoction").unwrap()) - 0.2).abs() < 1e-9);
    let (s, st) = open("pconc-pathfinder.xml", &PF_MAIN, &PF_UTILS);
    let nodes = swapped(&st, MASTER_SURGEON, &[NATURES_REPRISAL, ETERNAL_SUFFERING]);
    let n = s.wither_on_hit(&st, &nodes, &st.vals);
    let mut t = st.clone();
    t.nodes = nodes;
    let cfg = s.setup_config(&t);
    assert!(n >= 2.0, "gem 20% + Reprisal 25% + Eternal Suffering 50% at {:.2} hits a second", n);
    assert!(cfg.contains("multiplierWitheredStackCount"));
}

/// The ascendancy step scores each node by its real gain while mapping. Pathfinder: Nature's Reprisal (Withered)
/// beats Master Surgeon (less flask recovery); Assassin: Opportunistic (25% more with at most one rare nearby, the map
/// pack) beats Deathmarked (rares only).
#[test]
fn ascendancy_nodes_scored_by_their_gain() {
    let (s, st) = open("pconc-pathfinder.xml", &PF_MAIN, &PF_UTILS);
    let r = s.eval_nodes(&st, &[(st.nodes.clone(), None), (swapped(&st, MASTER_SURGEON, &[NATURES_REPRISAL]), None)]);
    let (a, b) = (r[0].as_ref().unwrap(), r[1].as_ref().unwrap());
    assert!(b.0 > a.0, "Nature's Reprisal scores below Master Surgeon");
    let mut t = st.clone();
    t.nodes = swapped(&st, MASTER_SURGEON, &[NATURES_REPRISAL]);
    let (s, st) = open("pconc-assassin.xml", &AS_MAIN, &AS_UTILS);
    // (Deathmarked's mark fires only on rares: upstream keeps it on every enemy, so it is out while mapping)
    let without = swapped(&st, DEATHMARKED, &[]);
    let path = s.ctx[st.class].path_to(&s.ctx[st.class].bfs(&without.iter().copied().collect(), true), OPPORTUNISTIC);
    let r = s.eval_nodes(&st, &[(without.clone(), None), (without.iter().copied().chain(path).collect(), None)]);
    let (a, b) = (r[0].as_ref().unwrap(), r[1].as_ref().unwrap());
    assert!(dps(&s, &b.2) > 1.2 * dps(&s, &a.2), "Opportunistic adds no damage while mapping");
    assert!(s.node_dead(&st, DEATHMARKED), "Deathmarked's rare-only mark counted while mapping");
    assert!(!s.node_dead(&st, OPPORTUNISTIC));
}

/// With a DPS target the curse is the one that raises the skill's damage type taken (read from the
/// gems' stats), not the defensive one the log score prefers. Poisonous Concoction deals chaos: Despair over Enfeeble.
#[test]
fn dps_goal_picks_the_damage_curse() {
    let (mut s, mut st) = open("pconc-pathfinder.xml", &PF_MAIN, &PF_UTILS);
    let (e, d) = (find_gem("Enfeeble").unwrap(), find_gem("Despair").unwrap());
    assert!(st.utils.contains(&e));
    s.gem_layer(&mut st, false).unwrap();
    assert!(st.utils.contains(&d) && !st.utils.contains(&e), "curse is {:?}", st.utils);
}

/// The part fed by the life flask scales with its amount recovered, so the life slot also offers
/// the most-recovery base with the modifier that raises it (read from mod data), and it out-damages the plain base.
#[test]
fn life_flask_recovery_modifier_offered() {
    let (s, st) = open("pconc-pathfinder.xml", &PF_MAIN, &PF_UTILS);
    let flasks = s.life_flasks().unwrap();
    let i = s.life_flask_slot().unwrap();
    let wear = |p: &items::Piece| {
        let mut t = st.clone();
        t.gear = Arc::new(s.with_piece(&st.gear, i, Some(p.clone())).unwrap());
        single(&s, &t)
    };
    let plain = flasks.iter().find(|p| p.xml.contains("Divine Life Flask") && !p.xml.contains("Amount Recovered")).expect("plain most-recovery base");
    let rec = flasks.iter().find(|p| p.xml.contains("increased Amount Recovered") && p.xml.contains("Bleeding")).expect("no flask with the amount-recovered modifier");
    let (a, b) = (wear(plain), wear(rec));
    assert!(b > 1.1 * a, "the modifier adds little: {a:.0} -> {b:.0}");
}

/// A config switch whose rule reads a defence the build has only while that switch is
/// off ("maximum Chance to Block Spell Damage if you have not Blocked Recently") flipped on every other render, so each
/// re-rendered gem or item move was judged against the other phase (EHP 68k against 39k) and the Wither totem lost.
/// The switch now holds, and Wither is a debuff skill by its game data (skill data `debuff`, no damage, totemable).
#[test]
fn config_holds_and_wither_totem_wins() {
    let (s, mut st) = open("pconc-pathfinder.xml", &PF_MAIN, &PF_UTILS);
    let w = find_gem("Wither").unwrap();
    assert!(s.gems.iter().any(|g| g.id == w && g.kind == Kind::Debuff), "Wither is not a debuff skill");
    assert_eq!(s.totem, find_gem("Spell Totem"));
    let ehp = |v: &Vals| v[s.scorer.names.iter().position(|n| n == "TotalEHP").unwrap()].unwrap_or(0.0);
    s.rebase(&mut st).unwrap();
    let e1 = ehp(&st.vals);
    s.rebase(&mut st).unwrap();
    let e2 = ehp(&st.vals);
    assert!((e1 - e2).abs() < 1.0, "config flips between renders: EHP {e1:.0} then {e2:.0}");
    let mut u = st.utils.clone();
    u.push(w);
    let n = s.try_setups(&st, vec![(st.main.clone(), u)]).unwrap().expect("Wither totem rejected");
    assert!(dps(&s, &n.vals) > 1.2 * dps(&s, &st.vals));
    assert!((ehp(&n.vals) - e2).abs() < 0.02 * e2, "the move changed EHP: {e2:.0} -> {:.0}", ehp(&n.vals));
}

/// An item that grants a curse aura was tried only beside the curse gem holding the
/// curse limit. The unique pass now also tries it with the curse gems taken out (one move), and the item's aura counts as
/// a curse for the config ("Is the enemy Cursed?"), so that move is not marked down for losing the gem's switches. Here
/// the gem stays: its Despair is always up, the flask's only during its effect.
#[test]
fn curse_aura_item_weighed_against_the_curse_gem() {
    let (mut s, mut st) = open("pconc-pathfinder.xml", &PF_MAIN, &PF_UTILS);
    // (a DPS goal wears the damage curse: Despair, `dps_goal_picks_the_damage_curse`)
    let (e, d) = (find_gem("Enfeeble").unwrap(), find_gem("Despair").unwrap());
    st.utils = st.utils.iter().map(|&u| if u == e { d } else { u }).collect();
    s.rebase(&mut st).unwrap();
    let auras: Vec<_> = s.uniques.iter().filter(|u| items::grants_curse_aura(&items::unique_piece(u).xml)).cloned().collect();
    assert!(!auras.is_empty(), "no unique grants a curse aura");
    s.uniques = auras;
    s.unique_pass(&mut st).unwrap();
    assert!(st.gear.pieces.iter().flatten().any(|p| items::grants_curse_aura(&p.xml)), "the curse-aura item is not worn");
    let mut j = st.clone();
    j.utils.retain(|&u| u != d);
    s.rebase(&mut j).unwrap();
    assert!(j.base.contains("<Input name=\"conditionEnemyCursed\" boolean=\"true\""), "the item's curse aura does not count as a curse");
    assert_eq!(st.utils.contains(&d), j.score < st.score - EPS, "the better of gem and item-only was not kept");
}

/// Flask charge sustain: Poisonous Concoction's Life part spends life-flask charges on every throw, so the part is fed
/// only as long as the worn life flasks hold charges (solver_drain.rs). With no charge generation, 3 life flasks feed it
/// three times as long as 1 in a pinnacle fight, and the 3-flask build scores higher.
#[test]
fn flask_drain_extra_life_flasks_feed_the_part() {
    let x = fixture("pconc-assassin-player.xml");
    // (slots 2 and 3 empty against a second and third life flask: only the life flasks differ)
    let one = x.replace(r#"<Slot name="Flask 2" itemId="11" active="true"/><Slot name="Flask 3" itemId="12" active="true"/>"#, "");
    let three = x.replace(r#"Slot name="Flask 2" itemId="11""#, r#"Slot name="Flask 2" itemId="10""#).replace(r#"Slot name="Flask 3" itemId="12""#, r#"Slot name="Flask 3" itemId="10""#);
    assert_ne!(one, three);
    let names = ["CombinedDPS", DRAIN_BOSS];
    let read = |x: &str| eval_one(&mut None, &Cand::Xml(Arc::new(x.to_string())), &names).unwrap();
    let raw = |x: &str| Session::new(x.to_string(), pom_calc::data::game_data()).eval_xml(x, false, |e| crate::stat_value(e, "CombinedDPS")).unwrap().unwrap();
    let (a, b) = (read(&one), read(&three));
    assert!(a[1].unwrap() > 0.0 && a[1].unwrap() < b[1].unwrap(), "uptime should rise with the flasks");
    assert!(a[0].unwrap() < b[0].unwrap(), "the 3-flask build must score higher");
    assert!(a[0].unwrap() < raw(&one), "the part is not always fed");
}

/// The two pconc references: boss and mapping uptime of the Life part, and the DPS before (always fed)
/// and after the drain.
#[test]
fn flask_drain_references() {
    for name in ["pconc-pathfinder-player.xml", "pconc-assassin-player.xml", "pconc-pathfinder-real-1.xml", "pconc-pathfinder-real-2.xml", "pconc-pathfinder-real-3.xml"] {
        let x = fixture(name);
        let names = ["CombinedDPS", DRAIN_BOSS, DRAIN_MAP];
        let v = eval_one(&mut None, &Cand::Xml(Arc::new(x.clone())), &names).unwrap();
        let before = Session::new(x.clone(), pom_calc::data::game_data()).eval_xml(&x, false, |e| crate::stat_value(e, "CombinedDPS")).unwrap().unwrap();
        assert!(v[1].unwrap() > 0.0 && v[1].unwrap() <= 1.0 && v[0].unwrap() <= before + 1.0);
    }
}
