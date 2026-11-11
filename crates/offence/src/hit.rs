// Port of the "Calculate hit chance" block, the first per-pass section of CalcOffence.lua's
// second passList loop (2189-2266): Accuracy, AccuracyHitChance, enemy block chance, and the final
// HitChance. Pure function of the pass's skillModList/cfg plus the enemy's own modDB - no
// cross-pass state (the `storedMainHandAccuracy` Mastery interaction and the combine step after
// both passes run are left to the caller/golden bin, same as `combineStat` elsewhere in this crate).
use crate::area::round;
use crate::tools::calc_lib_mod;
use crate::tools::calc_lib_mod_s;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

#[derive(Debug, Default, Clone, Copy)]
pub struct HitChanceOutput {
    pub accuracy: f64,
    pub accuracy_vs_enemy: f64,
    pub accuracy_hit_chance: f64,
    pub enemy_block_chance: f64,
    pub hit_chance: f64,
    /// Breakdown inputs (Calcs tab): the Accuracy sums and the evasion read.
    pub bd_base: f64,
    pub bd_inc: f64,
    pub bd_more: f64,
    pub bd_base_vs_enemy: f64,
    pub bd_inc_vs_enemy: f64,
    pub bd_more_vs_enemy: f64,
    /// The pass's own Accuracy / vs-enemy value before the main-hand override.
    pub bd_own_accuracy: f64,
    pub bd_own_accuracy_vs_enemy: f64,
    pub bd_enemy_evasion: Option<f64>,
}

/// `calcs.hitChance(evasion, accuracy)` (Modules/CalcDefence.lua:57-64).
pub fn hit_chance_formula(evasion: f64, accuracy: f64) -> f64 {
    if accuracy < 0.0 {
        return 5.0;
    }
    let raw_chance = accuracy / (accuracy + (evasion / 5.0).powf(0.9)) * 125.0;
    round(raw_chance).max(5.0).min(100.0)
}

/// The "Calculate hit chance" block (CalcOffence.lua:2189-2249). `cfg` is the pass's own cfg
/// (`weapon1Cfg`/`weapon2Cfg` for an attack, `skillCfg` for a spell/DoT "Skill" pass).
/// `cannot_be_evaded` is `skillModList:Flag(cfg, "CannotBeEvaded") or skillData.cannotBeEvaded or
/// (env.mode_effective and enemyDB:Flag(nil, "CannotEvade"))`, folded by the caller since it mixes
/// a `SkillView` read with two ModStore flag reads at different cfgs.
#[allow(clippy::too_many_arguments)]
pub fn calc_hit_chance(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    cfg: Option<&Cfg>,
    is_attack: bool,
    cannot_be_evaded: bool,
) -> HitChanceOutput {
    calc_hit_chance_ov(skill_mod_list, enemy_db, cfg, is_attack, cannot_be_evaded, None)
}

/// Same as `calc_hit_chance`, with the `Condition:OffHandAccuracyIsMainHandAccuracy` override
/// (CalcOffence.lua:2222-2233): `Some((accuracy, accuracy_vs_enemy))` replaces the off-hand pass's
/// own computed pair with the stored main-hand one.
pub fn calc_hit_chance_ov(
    skill_mod_list: &ModStore,
    enemy_db: &ModStore,
    cfg: Option<&Cfg>,
    is_attack: bool,
    cannot_be_evaded: bool,
    accuracy_override: Option<(f64, f64)>,
) -> HitChanceOutput {
    let base = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("Accuracy")]);
    let base_vs_enemy = skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("Accuracy"), pom_engine::sym!("AccuracyVsEnemy")]);
    let inc = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("Accuracy")]);
    let inc_vs_enemy = skill_mod_list.sum(ModType::Inc, cfg, &[pom_engine::sym!("Accuracy"), pom_engine::sym!("AccuracyVsEnemy")]);
    // `skillModList:More("MORE", cfg, "Accuracy")` (CalcOffence.lua:2194-2195): a genuine bug in
    // upstream - `More(cfg, ...)` takes no leading modType, so the literal "MORE" string lands
    // in the `cfg` parameter (a truthy but fieldless value: `cfg.flags`/`.keywordFlags`/`.source`
    // all read nil off a Lua string, i.e. cfg is effectively `nil`) and the real `cfg` table is
    // shifted into the name-vararg list (as a first, never-matching name; the real names after it still match). Net effect: this
    // query always runs as `More(nil, "Accuracy")`/`More(nil, "AccuracyVsEnemy")`, ignoring the
    // pass's real flags entirely. Ported as-is, not fixed.
    let more = skill_mod_list.more(None, &[pom_engine::sym!("Accuracy")]);
    // `More("MORE", cfg, "Accuracy", "AccuracyVsEnemy")`: the shifted vararg list keeps both real names.
    let more_vs_enemy = skill_mod_list.more(None, &[pom_engine::sym!("Accuracy"), pom_engine::sym!("AccuracyVsEnemy")]);

    let mut accuracy = (base * (1.0 + inc / 100.0) * more).max(0.0).floor();
    let mut accuracy_vs_enemy = (base_vs_enemy * (1.0 + inc_vs_enemy / 100.0) * more_vs_enemy).max(0.0).floor();
    let (bd_own_accuracy, bd_own_accuracy_vs_enemy) = (accuracy, accuracy_vs_enemy);
    if let Some((a, v)) = accuracy_override {
        accuracy = a;
        accuracy_vs_enemy = v;
    }

    let mut bd_enemy_evasion = None;
    let accuracy_hit_chance = if !is_attack || cannot_be_evaded {
        100.0
    } else {
        let enemy_evasion = round(crate::tools::calc_lib_val(enemy_db, "Evasion", None)).max(0.0);
        bd_enemy_evasion = Some(enemy_evasion);
        { let hc = hit_chance_formula(enemy_evasion, accuracy_vs_enemy); if pom_engine::env::var("POM_DEBUG_HIT").is_ok() { eprintln!("HIT ev={enemy_evasion} acc={accuracy_vs_enemy} hc={hc} mod={}", calc_lib_mod_s(skill_mod_list, cfg, &[pom_engine::sym!("HitChance")])); } hc * calc_lib_mod_s(skill_mod_list, cfg, &[pom_engine::sym!("HitChance")]) }
    };

    let mut enemy_block_chance = (enemy_db.sum(ModType::Base, cfg, &[pom_engine::sym!("BlockChance")]).min(100.0) - skill_mod_list.sum(ModType::Base, cfg, &[pom_engine::sym!("reduceEnemyBlock")])).max(0.0);
    if is_attack && enemy_db.flag(None, &[pom_engine::sym!("CannotBlockAttacks")]) {
        enemy_block_chance = 0.0;
    }

    let hit_chance = accuracy_hit_chance * (1.0 - enemy_block_chance / 100.0);

    HitChanceOutput { accuracy, accuracy_vs_enemy, accuracy_hit_chance, enemy_block_chance, hit_chance, bd_base: base, bd_inc: inc, bd_more: more, bd_base_vs_enemy: base_vs_enemy, bd_inc_vs_enemy: inc_vs_enemy, bd_more_vs_enemy: more_vs_enemy, bd_own_accuracy, bd_own_accuracy_vs_enemy, bd_enemy_evasion }
}
