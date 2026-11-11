//! Passive tree and ascendancy search misses found against a reference (a player's
//! league-start Poisonous Concoction builds, each choice swapped into the solver's own build). Fixtures are the solver's
//! builds the swaps were measured on (testdata/pconc-*-base.xml).

use super::*;

const GOAL: &str = r#"{"skill":"Poisonous Concoction","level":90,"wealth":"league-start","targets":[{"name":"DPS","metric":"combined","value":3000000},{"name":"EHP","metric":"ehp","value":80000}],"assume":{"playMode":"mapping"},"ascendancy":"ASC"}"#;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!("{}/testdata/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

/// The solver opened on the fixture, its one candidate (the fixture's ascendancy), and the fixture's tree as a state.
fn open(file: &str, asc: &str) -> (Solver, State) {
    let goal: Goal = serde_json::from_str(&GOAL.replace("ASC", asc)).unwrap();
    let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":3600000,"threads":2}"#).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(fixture(file), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
    let ci = s.candidates().unwrap()[0];
    let st = s.initial_state(ci, None, None).unwrap();
    (s, st)
}

/// Assassination Style carries a pick that costs no point (Knife in the Back measured +53% on the reference Assassin).
/// The ascendancy search dropped every multiple-choice option, so it could take the notable but never its pick. From the
/// reference Assassin with the ascendancy cleared, grow takes an option, and the option costs no point.
#[test]
fn ascendancy_grow_takes_a_choice_option() {
    let (mut s, mut st) = open("pconc-assassin-base.xml", "Assassin");
    let ci = st.class;
    st.nodes.retain(|&n| !s.ctx[ci].is_asc(n));
    s.rebase(&mut st).unwrap();
    s.grow(&mut st, true).unwrap();
    let c = &s.ctx[ci];
    let picks: Vec<i64> = st.nodes.iter().copied().filter(|&n| c.is_asc(n) && c.is_option(n)).collect();
    assert!(!picks.is_empty(), "no multiple-choice option taken");
    assert_eq!(s.used(&st).1, s.asc_points, "an option counted as a point");
}

/// The player's Pathfinder ascendancy (Nature's Reprisal, Master Toxicist, Nature's Boon, Master Alchemist) measured
/// +12% over the solver's (Master Surgeon, Nature's Adrenaline). Grown from an empty ascendancy on the reference Pathfinder,
/// the search scores at least what the player's picks score.
#[test]
fn ascendancy_grow_matches_the_players_pathfinder() {
    let (mut s, mut st) = open("pconc-pathfinder-base.xml", "Pathfinder");
    let ci = st.class;
    st.nodes.retain(|&n| !s.ctx[ci].is_asc(n));
    s.rebase(&mut st).unwrap();
    let mut player = st.clone();
    player.nodes.extend([32662, 40813, 20480, 1697, 32640, 65296, 40631, 61805]);
    player.score = f64::NEG_INFINITY;
    s.rebase(&mut player).unwrap();
    s.grow(&mut st, true).unwrap();
    assert!(st.score >= player.score - 1e-6, "the grown ascendancy scores below the player's");
}

/// The reference's main-tree swaps: the player's clusters traded in for the solver's defence and attribute nodes, same
/// points. refine_tree gave back one group of at most 8 nodes and regrew by gain per point, so a cluster further away
/// than that (the chaos DoT path is 13 nodes) or one past a cheap plain node stayed out of reach. On each reference build,
/// refine ends at least as high as the best swap the solver's own score ranks above its tree.
#[test]
fn refine_reaches_the_players_tree_swaps() {
    let rows = fixture("pconc-tree-swaps.tsv");
    let mut short = Vec::new();
    for (file, asc) in [("pconc-pathfinder-base.xml", "Pathfinder"), ("pconc-assassin-base.xml", "Assassin")] {
        let (mut s, st) = open(file, asc);
        let mut best = (st.score, "base".to_string());
        for row in rows.lines().map(|l| l.split('\t').collect::<Vec<_>>()).filter(|r| r[0].eq_ignore_ascii_case(asc) && (r[1].starts_with("tree-") || r[1].starts_with("mastery-"))) {
            let c = &s.ctx[st.class];
            let mut t = st.clone();
            t.nodes = row[2].split(',').filter_map(|x| x.parse().ok()).filter(|&n| c.is_main(n) || c.is_asc(n)).collect();
            t.masteries = row.get(3).map_or(Vec::new(), |m| {
                m.split("},{")
                    .filter_map(|p| {
                        let mut it = p.trim_matches(|ch| ch == '{' || ch == '}').split(',').filter_map(|x| x.parse::<i64>().ok());
                        Some((it.next()?, it.next()?))
                    })
                    .collect()
            });
            if s.used(&t).0 > s.points {
                continue;
            }
            t.score = f64::NEG_INFINITY;
            s.rebase(&mut t).unwrap();
            if t.score > best.0 {
                best = (t.score, row[1].to_string());
            }
        }
        let mut r = st.clone();
        s.refine_tree(&mut r, false).unwrap();
        if r.score < best.0 - 1e-6 {
            short.push(format!("{asc} below {}", best.1));
        }
    }
    assert!(short.is_empty(), "refine stopped short: {short:?}");
}

/// Nodes that pay only with a gem the setup lacks (a second curse, another aura) measure nothing alone, so gain per
/// point never takes them. Their class comes from the engine's modifiers of their lines (a curse limit; less
/// reservation or more reservation efficiency), and `slot_moves` measures each within reach as one move: its path paid
/// by the cheapest groups, the gem tried in.
#[test]
fn slot_moves_try_a_second_curse_and_another_aura() {
    let (mut s, st) = open("pconc-pathfinder-base.xml", "Pathfinder");
    let c = &s.ctx[st.class];
    let ids: Vec<i64> = c.paths.nodes.keys().copied().filter(|&n| c.is_main(n) && matches!(c.kind(n), "Notable" | "Keystone")).collect();
    let of = |k: Kind| -> Vec<String> { ids.iter().filter(|&&n| s.slot_kind(n) == Some(k)).map(|&n| s.node_info(n).0.clone()).collect() };
    let (curse, aura) = (of(Kind::Curse), of(Kind::Aura));
    assert!(!curse.is_empty() && !aura.is_empty(), "a move class read nothing");
    let mut t = st.clone();
    let before = s.evals.load(Ordering::Relaxed);
    s.slot_moves(&mut t).unwrap();
    assert!(s.evals.load(Ordering::Relaxed) > before, "no move measured");
    assert!(t.score >= st.score - 1e-9);
}

/// Righteous Fire burns 1,941/s against 230/s regeneration: with shield regeneration the engine puts the burn on the
/// shield (NetLifeRegen reads 229.6, NetEnergyShieldRegen -1,791), which cannot pay it, so it lands on life.
#[test]
fn life_regen_net_counts_the_build_degen() {
    let m: std::collections::HashMap<&str, f64> = [("TotalBuildDegen", 1941.2), ("TotalNetRegen", -1545.6), ("NetManaRegen", 16.0), ("NetLifeRegen", 229.6), ("NetEnergyShieldRegen", -1791.2), ("LifeRegenRecovery", 229.6)].into();
    let o = |k: &str| m.get(k).copied();
    assert!(life_regen_net(&o).unwrap() < -1500.0, "{:?}", life_regen_net(&o));
    let n: std::collections::HashMap<&str, f64> = [("LifeRegenRecovery", 35.0)].into();
    assert_eq!(life_regen_net(&|k| n.get(k).copied()), Some(35.0));
}

/// RF solve: RF burns 1,220/s; Mind Over Matter puts 488/s of it on a 110-mana
/// pool that regenerates 18/s (NetManaRegen -470), so the mana share lands on life: net -334/s, not the +136 of life
/// regeneration plus the mana share. And break-even is no sustain: the SRS replay's Lifetap spam takes 265 of its
/// 269.5 life regeneration a second, under the margin.
#[test]
fn sustain_counts_only_pools_that_pay_their_share() {
    let m: std::collections::HashMap<&str, f64> = [("TotalBuildDegen", 1220.0), ("LifeRegenRecovery", 868.0), ("NetLifeRegen", 136.0), ("NetManaRegen", -470.0), ("NetEnergyShieldRegen", 0.0), ("TotalNetRegen", -334.0)].into();
    let o = |k: &str| m.get(k).copied();
    let net = life_regen_net(&o).unwrap();
    assert!(net <= -334.0 + 1e-6, "life net {net}: a mana pool that cannot pay its share still counted");
    let l: std::collections::HashMap<&str, f64> = [("LifeRegenRecovery", 269.5), ("LifePerSecondCost", 265.0)].into();
    let o = |k: &str| l.get(k).copied();
    assert!(life_regen_net(&o).unwrap() - 265.0 < super::sustain_margin("Life", &o), "Lifetap spam at 98% of the regeneration passes as sustained");
}

#[test]
fn attr_node_reads_only_attribute_nodes() {
    assert_eq!(basics::attr_node("+10 to strength"), Some([10.0, 0.0, 0.0]));
    assert_eq!(basics::attr_node("+10 to strength and dexterity"), Some([10.0, 10.0, 0.0]));
    assert_eq!(basics::attr_node("+10 to strength\n+5% increased life"), None);
    assert_eq!(basics::attr_node("8% increased damage"), None);
}

/// A small attribute node the build has far more of than its gems and items need goes back; the tree has no loss left
/// to show for it.
#[test]
fn attr_prune_drops_surplus_attribute_leaf() {
    let (mut s, mut st) = open("pconc-pathfinder-base.xml", "Pathfinder");
    let c = &s.ctx[st.class];
    let have: HashSet<i64> = st.nodes.iter().copied().collect();
    let leaf = c.paths.nodes.iter().filter(|(id, n)| c.is_main(**id) && !have.contains(id) && n.linked.iter().any(|l| have.contains(l))).map(|(id, _)| *id).filter(|&id| s.attr_node(id).is_some()).min();
    let leaf = leaf.expect("an attribute node next to the tree");
    st.nodes.push(leaf);
    s.rebase(&mut st).unwrap();
    s.attr_prune(&mut st).unwrap();
    assert!(!st.nodes.contains(&leaf), "the surplus attribute node stayed");
}

const FS_GOAL: &str = r#"{"skill":"Flicker Strike","level":90,"wealth":"league-start","targets":[{"name":"DPS","metric":"combined"}],"assume":{"playMode":"mapping"},"ascendancy":"ASC"}"#;
const RF_GOAL: &str = r#"{"skill":"Righteous Fire","level":90,"wealth":"league-start","targets":[{"name":"DPS","metric":"combined"}],"assume":{"playMode":"mapping"},"ascendancy":"ASC"}"#;

fn open_goal(goal: &str, file: &str, asc: &str) -> (Solver, State) {
    let goal: Goal = serde_json::from_str(&goal.replace("ASC", asc)).unwrap();
    let opts: Options = serde_json::from_str(r#"{"timeBudgetMs":3600000,"threads":2}"#).unwrap();
    let shared = Arc::new((Mutex::new(Shared { snapshot: json!({}), results: Vec::new(), by_id: Default::default(), version: 0, done: false }), std::sync::Condvar::new()));
    let mut s = Solver::new(fixture(file), goal, opts, shared, Arc::new(AtomicBool::new(false))).unwrap();
    let ci = s.candidates().unwrap()[0];
    let st = s.initial_state(ci, None, None).unwrap();
    (s, st)
}

/// attr_prune on a solved build (the FS and RF results): small attribute nodes before and after, score kept.
fn attr_run(goal: &str, file: &str, asc: &str) -> (usize, usize, f64, f64) {
    let (mut s, mut st) = open_goal(goal, file, asc);
    let count = |s: &Solver, st: &State| st.nodes.iter().filter(|&&n| s.attr_node(n).is_some()).count();
    let (n0, s0) = (count(&s, &st), st.score);
    s.attr_prune(&mut st).unwrap();
    (n0, count(&s, &st), s0, st.score)
}

/// The chain phase of attr_prune on the solver's own Righteous Fire result (Chieftain, 26 attribute nodes) and Flicker
/// Strike result (Champion, 40): fewer attribute nodes, the score kept to a hair.
#[test]
fn attr_prune_swaps_attribute_chains_on_solved_builds() {
    for (goal, file, asc) in [(FS_GOAL, "attr-fs.xml", "Champion"), (RF_GOAL, "attr-rf.xml", "Chieftain")] {
        let (n0, n1, s0, s1) = attr_run(goal, file, asc);
        assert!(n1 < n0, "{asc}: attribute nodes {n0} -> {n1}");
        assert!(s1 >= s0 - 0.01, "{asc}: score {s0} -> {s1}");
    }
}
