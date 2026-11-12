// Port of "Calculate crit chance, crit multiplier, and their combined effect"
// (CalcOffence.lua:3041-3272), the per-pass crit block inside the second passList loop. Omits the
// `actor.parent`/`actor.partyMembers` cross-actor crit-link special cases
// (`MainHandCritIsEqualToParent(PartyMember)`, `AttackCritIsEqualToParentMainHand` - minion/mirage
// only, CalcOffence.lua:3078-3090) since this crate's isolation layer has no parent-actor concept;
// `BaseCritFromMainHand` (the one same-actor link) is kept since it only needs the actor's own
// weapon 1 crit chance, already available to every caller. Also omits the `BifurcateCrit` *extra
// damage* bonus (CalcOffence.lua:3224-3259: needs `output.PreBifurcateCritChance` state that isn't
// otherwise part of this function's inputs, and is purely descriptive regardless - its own `NewMod`
// call is commented "doesn't affect output").
use crate::area::round;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

#[derive(Debug, Default, Clone, Copy)]
pub struct CritOutput {
    pub pre_effective_crit_chance: f64,
    pub pre_bifurcate_crit_chance: f64,
    pub crit_chance: f64,
    pub crit_multiplier: f64,
    pub bonus_crit_dot_multiplier: f64,
    pub crit_effect: f64,
    pub crit_bifurcates: Option<f64>,
}

pub struct CritInput<'a> {
    pub skill_mod_list: &'a ModStore,
    pub enemy_db: &'a ModStore,
    pub actor_db: &'a ModStore,
    pub cfg: Option<&'a Cfg>,
    pub skill_cfg: Option<&'a Cfg>,
    pub source_crit_chance: f64,
    /// `actor.weaponData1.CritChance` (CalcOffence.lua:3088), for `BaseCritFromMainHand`.
    pub weapon1_crit_chance: f64,
    /// `actor.parent.weaponData1.CritChance` (CalcOffence.lua:3090, `AttackCritIsEqualToParentMainHand`): `None` outside minion passes.
    pub parent_weapon1_crit_chance: Option<f64>,
    /// `actor.partyMembers.output.MainHand.CritChance` (0 when the party member has none), for
    /// `MainHandCritIsEqualToPartyMember` (CalcOffence.lua:3081).
    pub party_main_hand_crit: f64,
    pub mode_effective: bool,
    pub repeats: f64,
    /// `env.configInput.repeatMode` ("None"/"AVERAGE"/"FINAL"/absent).
    pub repeat_mode: Option<&'a str>,
    pub accuracy_hit_chance: f64,
}

/// The `if not output.CritEffect then ... end` block (CalcOffence.lua:3203-3271): CritMultiplier +
/// CritEffect + BonusCritDotMultiplier, run once `crit_chance` (the post-hit-check value) is known.
fn crit_multiplier_and_effect(i: &CritInput, crit_chance: f64, pre_bifurcate: Option<f64>) -> (f64, f64, f64, Option<f64>) {
    let sml = i.skill_mod_list;
    let mut crit_bifurcates = None;
    let crit_multiplier = if sml.flag(i.cfg, &[pom_engine::sym!("NoCritMultiplier")]) {
        1.0
    } else {
        let mut extra_damage = sml.sum(ModType::Base, i.cfg, &[pom_engine::sym!("CritMultiplier")]) / 100.0;
        if let Some(multi_override) = sml.override_(i.skill_cfg, &[pom_engine::sym!("CritMultiplier")]).and_then(|v| v.num()) {
            extra_damage = (multi_override - 100.0) / 100.0;
        }
        if i.mode_effective {
            let enemy_inc = 1.0 + i.enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfCritMultiplier")]) / 100.0;
            extra_damage += i.enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("SelfCritMultiplier")]) / 100.0;
            extra_damage = round(extra_damage * enemy_inc * 100.0) / 100.0;
        }
        let crit_override = sml.override_(i.cfg, &[pom_engine::sym!("CritChance")]).and_then(|v| v.num());
        if i.mode_effective && sml.flag(i.cfg, &[pom_engine::sym!("BifurcateCrit")]) && pre_bifurcate.is_some() && crit_override != Some(100.0) {
            let pct = pre_bifurcate.unwrap();
            let mut multi_chance = pct.powi(2) / 100.0;
            let mut use_chance = 1.0;
            if sml.flag(i.skill_cfg, &[pom_engine::sym!("Every3UseCrit")]) {
                use_chance = use_chance * 2.0 / 3.0;
            }
            if sml.flag(i.skill_cfg, &[pom_engine::sym!("Every5UseCrit")]) {
                use_chance = use_chance * 4.0 / 5.0;
            }
            multi_chance *= use_chance;
            let cond = if crit_chance > 0.0 { multi_chance / crit_chance } else { 0.0 };
            crit_bifurcates = Some(1.0 + cond);
            extra_damage = extra_damage + cond * extra_damage;
        }
        1.0 + extra_damage.max(0.0)
    };
    let p = crit_chance / 100.0;
    let crit_effect = 1.0 - p + p * crit_multiplier;
    let bonus_crit_dot_multiplier = (sml.sum(ModType::Base, i.cfg, &[pom_engine::sym!("CritMultiplier")]) - 50.0) * sml.sum(ModType::Base, i.cfg, &[pom_engine::sym!("CritMultiplierAppliesToDegen")]) / 10000.0;
    (crit_multiplier, crit_effect, bonus_crit_dot_multiplier, crit_bifurcates)
}

pub fn calc_crit(i: &CritInput) -> CritOutput {
    let sml = i.skill_mod_list;

    if sml.flag(i.cfg, &[pom_engine::sym!("NeverCrit")]) {
        return CritOutput { crit_effect: 1.0, ..Default::default() };
    }
    if sml.flag(i.cfg, &[pom_engine::sym!("SpellSkillsCannotDealCriticalStrikesExceptOnFinalRepeat")]) {
        if i.repeats == 1.0 {
            return CritOutput { crit_effect: 1.0, ..Default::default() };
        }
        if sml.flag(i.cfg, &[pom_engine::sym!("SpellSkillsAlwaysDealCriticalStrikesOnFinalRepeat")]) {
            let (pre, cc) = match i.repeat_mode {
                Some("None") => (0.0, 0.0),
                Some("AVERAGE") => (100.0 / i.repeats, 100.0 / i.repeats),
                _ => (100.0, 100.0),
            };
            let (crit_multiplier, crit_effect, bonus, crit_bifurcates) = crit_multiplier_and_effect(i, cc, Some(pre));
            return CritOutput { pre_effective_crit_chance: pre, pre_bifurcate_crit_chance: pre, crit_chance: cc, crit_multiplier, crit_effect, bonus_crit_dot_multiplier: bonus, crit_bifurcates };
        }
        // "this shouldn't ever be a case but leaving this here if someone wants to implement it" -
        // the Lua sets nothing in this remaining branch; reproduced as all-zero/default.
        return CritOutput::default();
    }

    let mut crit_override = sml.override_(i.cfg, &[pom_engine::sym!("CritChance")]).and_then(|v| v.num());
    if sml.flag(i.cfg, &[pom_engine::sym!("MainHandCritIsEqualToPartyMember")]) {
        crit_override = Some(i.party_main_hand_crit);
    }
    let base_crit_from_main_hand = sml.flag(i.cfg, &[pom_engine::sym!("BaseCritFromMainHand")]);
    let base_crit_from_parent_main_hand = sml.flag(i.cfg, &[pom_engine::sym!("AttackCritIsEqualToParentMainHand")]);
    let mut base_crit = crit_override.unwrap_or(i.source_crit_chance);
    if base_crit_from_main_hand {
        base_crit = i.weapon1_crit_chance;
    } else if base_crit_from_parent_main_hand {
        base_crit = i.parent_weapon1_crit_chance.unwrap_or(base_crit);
    }

    if crit_override == Some(100.0) {
        let (crit_multiplier, crit_effect, bonus, crit_bifurcates) = crit_multiplier_and_effect(i, 100.0, Some(100.0));
        return CritOutput { pre_effective_crit_chance: 100.0, pre_bifurcate_crit_chance: 100.0, crit_chance: 100.0, crit_multiplier, crit_effect, bonus_crit_dot_multiplier: bonus, crit_bifurcates };
    }

    let (base, inc, more) = if crit_override.is_none() {
        let base = sml.sum(ModType::Base, i.cfg, &[pom_engine::sym!("CritChance")]) + if i.mode_effective { i.enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("SelfCritChance")]) } else { 0.0 };
        let inc = sml.sum(ModType::Inc, i.cfg, &[pom_engine::sym!("CritChance")]) + if i.mode_effective { i.enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfCritChance")]) } else { 0.0 };
        let more = sml.more(i.cfg, &[pom_engine::sym!("CritChance")]) * if i.mode_effective { i.enemy_db.more(None, &[pom_engine::sym!("SelfCritChance")]) } else { 1.0 };
        (base, inc, more)
    } else {
        (0.0, 0.0, 1.0)
    };

    let mut crit_chance = round((base_crit + base) * (1.0 + inc / 100.0) * more * 100.0) / 100.0;
    let cap = sml.override_(None, &[pom_engine::sym!("CritChanceCap")]).and_then(|v| v.num()).unwrap_or_else(|| sml.sum(ModType::Base, i.cfg, &[pom_engine::sym!("CritChanceCap")]));
    crit_chance = crit_chance.min(cap);
    if base_crit + base > 0.0 {
        crit_chance = crit_chance.max(0.0);
    }
    let pre_effective_crit_chance = crit_chance;

    let mut crit_rolls: i32 = 0;
    if i.mode_effective && sml.flag(i.cfg, &[pom_engine::sym!("CritChanceLucky")]) {
        crit_rolls += 1;
    }
    if sml.flag(i.skill_cfg, &[pom_engine::sym!("ExtremeLuck")]) {
        crit_rolls *= 2;
    }
    if crit_rolls != 0 {
        if i.actor_db.flag(None, &[pom_engine::sym!("Unexciting")]) {
            let p = crit_chance / 100.0;
            crit_chance = (3.0 * p.powi(2) - 2.0 * p.powi(3)) * 100.0;
        } else {
            crit_chance = (1.0 - (1.0 - crit_chance / 100.0).powi(crit_rolls + 1)) * 100.0;
        }
    }
    let pre_bifurcate_crit_chance = crit_chance;
    if i.mode_effective && sml.flag(i.cfg, &[pom_engine::sym!("BifurcateCrit")]) {
        crit_chance = (1.0 - (1.0 - crit_chance / 100.0).powi(2)) * 100.0;
    }
    if i.mode_effective {
        if sml.flag(i.skill_cfg, &[pom_engine::sym!("Every3UseCrit")]) {
            crit_chance = (2.0 * crit_chance + 100.0) / 3.0;
        }
        if sml.flag(i.skill_cfg, &[pom_engine::sym!("Every5UseCrit")]) {
            crit_chance = (4.0 * crit_chance + 100.0) / 5.0;
        }
        crit_chance = crit_chance * i.accuracy_hit_chance / 100.0;
    }

    let (crit_multiplier, crit_effect, bonus_crit_dot_multiplier, crit_bifurcates) = crit_multiplier_and_effect(i, crit_chance, Some(pre_bifurcate_crit_chance));
    CritOutput { pre_effective_crit_chance, pre_bifurcate_crit_chance, crit_chance, crit_multiplier, crit_effect, bonus_crit_dot_multiplier, crit_bifurcates }
}

/// Calcs-mode breakdown of the crit block (CalcOffence.lua:3041-3272): `breakdown.CritChance`, `PreEffectiveCritChance`,
/// `CritMultiplier`, `CritBifurcates`, `CritEffect`, written into the current pass table. Recomputes the block's locals
/// from the same inputs `calc_crit` uses (the stat code is untouched).
pub fn write_breakdown(i: &CritInput, out: &CritOutput) {
    use crate::bd::{self, ins_s};
    use crate::sf;
    if !bd::on() {
        return;
    }
    let sml = i.skill_mod_list;
    let flag = |c: Option<&Cfg>, n: &str| sml.flag(c, &[Sym::new(n)]);
    if flag(i.cfg, "NeverCrit") {
        return;
    }
    let mut pre_bifurcate: Option<f64> = None;
    if flag(i.cfg, "SpellSkillsCannotDealCriticalStrikesExceptOnFinalRepeat") {
        if i.repeats == 1.0 || !flag(i.cfg, "SpellSkillsAlwaysDealCriticalStrikesOnFinalRepeat") {
            return;
        }
        if i.repeat_mode == Some("AVERAGE") {
            bd::cur(|b| {
                let t = bd::reset(b, "CritChance");
                ins_s(t, "100%");
                ins_s(t, sf!("/ %d ^8(number of repeats)", i.repeats));
                ins_s(t, sf!("= %.2f%% average critical strike chance", out.crit_chance));
            });
        }
    } else {
        pre_bifurcate = Some(out.pre_bifurcate_crit_chance);
        let mut crit_override = sml.override_(i.cfg, &[pom_engine::sym!("CritChance")]).and_then(|v| v.num());
        if flag(i.cfg, "MainHandCritIsEqualToPartyMember") {
            crit_override = Some(i.party_main_hand_crit);
        }
        let from_main = flag(i.cfg, "BaseCritFromMainHand");
        let from_parent = flag(i.cfg, "AttackCritIsEqualToParentMainHand");
        let mut base_crit = crit_override.unwrap_or(i.source_crit_chance);
        if from_main {
            base_crit = i.weapon1_crit_chance;
        } else if from_parent {
            base_crit = i.parent_weapon1_crit_chance.unwrap_or(base_crit);
        }
        if crit_override == Some(100.0) {
            pre_bifurcate = Some(100.0);
        } else if out.crit_chance != base_crit {
            let (base, inc, more) = if crit_override.is_none() {
                (
                    sml.sum(ModType::Base, i.cfg, &[pom_engine::sym!("CritChance")]) + if i.mode_effective { i.enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("SelfCritChance")]) } else { 0.0 },
                    sml.sum(ModType::Inc, i.cfg, &[pom_engine::sym!("CritChance")]) + if i.mode_effective { i.enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfCritChance")]) } else { 0.0 },
                    sml.more(i.cfg, &[pom_engine::sym!("CritChance")]) * if i.mode_effective { i.enemy_db.more(None, &[pom_engine::sym!("SelfCritChance")]) } else { 1.0 },
                )
            } else {
                (0.0, 0.0, 1.0)
            };
            let pre_cap = round((base_crit + base) * (1.0 + inc / 100.0) * more * 100.0) / 100.0;
            let pre_lucky = out.pre_effective_crit_chance;
            let mut crit_rolls: i32 = 0;
            if i.mode_effective && flag(i.cfg, "CritChanceLucky") {
                crit_rolls += 1;
            }
            if flag(i.skill_cfg, "ExtremeLuck") {
                crit_rolls *= 2;
            }
            let pre_bif = out.pre_bifurcate_crit_chance;
            let bifurcate = i.mode_effective && flag(i.cfg, "BifurcateCrit");
            let pre_skill_use = if bifurcate { (1.0 - (1.0 - pre_bif / 100.0).powi(2)) * 100.0 } else { pre_bif };
            let mut pre_hit_check = pre_skill_use;
            if i.mode_effective {
                if flag(i.skill_cfg, "Every3UseCrit") {
                    pre_hit_check = (2.0 * pre_hit_check + 100.0) / 3.0;
                }
                if flag(i.skill_cfg, "Every5UseCrit") {
                    pre_hit_check = (4.0 * pre_hit_check + 100.0) / 5.0;
                }
            }
            bd::cur(|b| {
                let t = bd::reset(b, "CritChance");
                let suffix = if from_main { " from main weapon" } else if from_parent { " from parent main weapon" } else { "" };
                if base != 0.0 {
                    ins_s(t, sf!("(%g + %g) ^8(base%s)", base_crit, base, suffix));
                } else {
                    ins_s(t, sf!("%g ^8(base%s)", base_crit + base, suffix));
                }
                if inc != 0.0 {
                    ins_s(t, format!("{} ^8(increased/reduced)", sf!("x %.2f", 1.0 + inc / 100.0)));
                }
                if more != 1.0 {
                    ins_s(t, format!("{} ^8(more/less)", sf!("x %.2f", more)));
                }
                ins_s(t, sf!("= %.2f%% ^8(crit chance)", out.pre_effective_crit_chance));
                if pre_cap > 100.0 {
                    let over = pre_cap - 100.0;
                    ins_s(t, sf!("Crit is overcapped by %.2f%% (%d%% increased Critical Strike Chance)", over, over / more / (base_crit + base) * 100.0));
                }
                let copy = t.clone();
                if i.mode_effective {
                    if crit_rolls != 0 {
                        if flag(i.skill_cfg, "Unexciting") {
                            ins_s(t, "Crit Chance is Unexciting:");
                            ins_s(t, sf!("(3 x %.4f^ 2) - (2 x %.4f^ 3)", pre_lucky / 100.0, pre_lucky / 100.0));
                        } else {
                            ins_s(t, "Crit Chance is Lucky:");
                            ins_s(t, sf!("1 - (1 - %.4f)^ %d", pre_lucky / 100.0, crit_rolls + 1));
                        }
                        ins_s(t, sf!("= %.2f%%", pre_bif));
                    }
                    if flag(i.cfg, "BifurcateCrit") {
                        ins_s(t, "Critical Strike Bifurcates:");
                        ins_s(t, sf!("1 - (1 - %.4f) x (1 - %.4f)", pre_bif / 100.0, pre_bif / 100.0));
                        ins_s(t, sf!("= %.2f%%", pre_skill_use));
                    }
                    if flag(i.skill_cfg, "Every3UseCrit") {
                        ins_s(t, sf!("+ %.2f%% ^8(crit every 3rd use)", (2.0 * pre_skill_use + 100.0) / 3.0 - pre_skill_use));
                    }
                    if flag(i.skill_cfg, "Every5UseCrit") {
                        ins_s(t, sf!("+ %.2f%% ^8(crit every 5th use)", (4.0 * pre_skill_use + 100.0) / 5.0 - pre_skill_use));
                    }
                    if flag(i.skill_cfg, "Every3UseCrit") || flag(i.skill_cfg, "Every5UseCrit") {
                        ins_s(t, sf!("= %.2f%%", pre_hit_check));
                    }
                }
                if i.mode_effective && i.accuracy_hit_chance < 100.0 {
                    ins_s(t, "Crit confirmation roll:");
                    ins_s(t, sf!("%.2f%%", pre_hit_check));
                    ins_s(t, sf!("x %.2f ^8(chance to hit)", i.accuracy_hit_chance / 100.0));
                    ins_s(t, sf!("= %.2f%%", out.crit_chance));
                }
                bd::set(b, "PreEffectiveCritChance", copy);
            });
        }
    }
    // `if not output.CritEffect` block (CalcOffence.lua:3203-3271)
    if flag(i.cfg, "NoCritMultiplier") {
        return;
    }
    let skill_crit_multi = sml.sum(ModType::Base, i.cfg, &[pom_engine::sym!("CritMultiplier")]);
    let mut extra_damage = skill_crit_multi / 100.0;
    if let Some(mo) = sml.override_(i.skill_cfg, &[pom_engine::sym!("CritMultiplier")]).and_then(|v| v.num()) {
        extra_damage = (mo - 100.0) / 100.0;
    }
    if i.mode_effective {
        let enemy_inc = 1.0 + i.enemy_db.sum(ModType::Inc, None, &[pom_engine::sym!("SelfCritMultiplier")]) / 100.0;
        let enemy_base = i.enemy_db.sum(ModType::Base, None, &[pom_engine::sym!("SelfCritMultiplier")]);
        extra_damage += enemy_base / 100.0;
        extra_damage = round(extra_damage * enemy_inc * 100.0) / 100.0;
        if enemy_inc != 1.0 {
            bd::cur(|b| {
                let t = bd::reset(b, "CritMultiplier");
                ins_s(t, sf!("%d%% ^8(additional extra damage)", (enemy_base + skill_crit_multi) / 100.0));
                ins_s(t, sf!("x %.2f ^8(increased/reduced extra crit damage taken by enemy)", enemy_inc));
                ins_s(t, sf!("= %d%% ^8(extra crit damage)", extra_damage * 100.0));
            });
        }
    }
    let crit_override = sml.override_(i.cfg, &[pom_engine::sym!("CritChance")]).and_then(|v| v.num());
    if i.mode_effective && flag(i.cfg, "BifurcateCrit") && pre_bifurcate.is_some() && crit_override != Some(100.0) {
        let pct = pre_bifurcate.unwrap();
        let mut multi_chance = pct.powi(2) / 100.0;
        let mut use_chance = 1.0;
        if flag(i.skill_cfg, "Every3UseCrit") {
            use_chance = use_chance * 2.0 / 3.0;
        }
        if flag(i.skill_cfg, "Every5UseCrit") {
            use_chance = use_chance * 4.0 / 5.0;
        }
        multi_chance *= use_chance;
        let eff = out.crit_chance;
        let cond = if eff > 0.0 { multi_chance / eff } else { 0.0 };
        bd::cur(|b| {
            let t = bd::reset(b, "CritBifurcates");
            ins_s(t, sf!("%.2f%% ^8(pre-bifurcate crit chance)", pct));
            ins_s(t, sf!("x %.2f%%", pct));
            if use_chance < 1.0 {
                ins_s(t, sf!("x %.2f%% ^8(uses that can bifurcate)", use_chance * 100.0));
            }
            ins_s(t, sf!("= %.2f%% ^8(chance both crit rolls succeed)", multi_chance));
            ins_s(t, sf!("/ %.2f%% ^8(effective crit chance)", eff));
            ins_s(t, sf!("= %.2f ^8(crit Bifurcates effect)", 1.0 + cond));
        });
    }
    if out.crit_effect != 1.0 {
        let p = out.crit_chance / 100.0;
        bd::cur(|b| {
            let t = bd::reset(b, "CritEffect");
            ins_s(t, sf!("(1 - %.4f) ^8(portion of damage from non-crits)", p));
            ins_s(t, sf!("+ [ (%.4f x %g) ^8(portion of damage from crits)", p, out.crit_multiplier));
            ins_s(t, sf!("= %.3f", out.crit_effect));
        });
    }
}
