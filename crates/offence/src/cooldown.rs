// Port of Modules/CalcOffence.lua: the standalone calcSkillCooldown (296-309) and
// calcSkillDuration (322-335) helpers, the inline "Skill duration" block that actually produces
// `output.Duration`/`DurationSecondary`/`DurationTertiary`/`AuraDuration` (1490-1593), and
// calcs.calcTotemLife (338-342). All pure functions of skillModList/skillCfg/skillData plus a
// handful of scalar env/enemy inputs - no passList/weapon dependency, so these are gradable
// end-to-end against the golden recordings.
use crate::data;
use crate::tools::calc_lib_mod;
use crate::tools::calc_lib_mod_s;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::Cfg;
use pom_engine::sym::Sym;

/// `calcSkillCooldown(skillModList, skillCfg, skillData)` (CalcOffence.lua:296-309).
/// `skill_data_cooldown`/`stored_uses`/`vaal_stored_uses` are `skillData.cooldown`/`.storedUses`/
/// `.VaalStoredUses` (absent -> `None`, matching Lua `nil`). Returns `(cooldown, rounded)`; the
/// Lua's third `addedCooldown` return is breakdown-only text.
pub fn calc_skill_cooldown(
    skill_mod_list: &ModStore,
    skill_cfg: Option<&Cfg>,
    skill_data_cooldown: Option<f64>,
    stored_uses: Option<f64>,
    vaal_stored_uses: Option<f64>,
) -> (f64, bool) {
    let cooldown_recovery = [pom_engine::sym!("CooldownRecovery")];
    let cooldown_override = skill_mod_list.override_(skill_cfg, &cooldown_recovery).and_then(|v| v.num());
    let added_cooldown = skill_mod_list.sum(ModType::Base, skill_cfg, &cooldown_recovery);
    let cooldown = cooldown_override.unwrap_or_else(|| {
        (skill_data_cooldown.unwrap_or(0.0) + added_cooldown) / calc_lib_mod_s(skill_mod_list, skill_cfg, &[pom_engine::sym!("CooldownRecovery")]).max(0.0)
    });
    let stored_uses_gt1 = stored_uses.unwrap_or(0.0) > 1.0;
    let vaal_stored_uses_gt1 = vaal_stored_uses.unwrap_or(0.0) > 1.0;
    let additional_uses = skill_mod_list.sum(ModType::Base, skill_cfg, &[pom_engine::sym!("AdditionalCooldownUses")]);
    if stored_uses_gt1 || vaal_stored_uses_gt1 || additional_uses > 0.0 {
        (cooldown, false)
    } else {
        let tick = data::misc("ServerTickRate");
        ((cooldown * tick).ceil() / tick, true)
    }
}

/// `calcSkillDuration(skillModList, skillCfg, skillData, env, enemyDB)` (CalcOffence.lua:
/// 322-335): the Warcry-uptime helper (`full_duration` at line 1220), distinct from the inline
/// block below that actually sets `output.Duration`. `skill_data_duration` is `skillData.duration`
/// (absent -> 0).
pub fn calc_skill_duration_helper(
    skill_mod_list: &ModStore,
    skill_cfg: Option<&Cfg>,
    skill_data_duration: Option<f64>,
    mine_duration_applies_to_skill: bool,
    debuff: bool,
    mode_effective: bool,
    enemy_db: &ModStore,
) -> f64 {
    let mut names = vec!["Duration", "PrimaryDuration"];
    if mine_duration_applies_to_skill {
        names.push("MineDuration");
    }
    let duration_mod = calc_lib_mod(skill_mod_list, skill_cfg, &names).max(0.0);
    let duration_base = skill_data_duration.unwrap_or(0.0) + skill_mod_list.sum(ModType::Base, skill_cfg, &[pom_engine::sym!("Duration"), pom_engine::sym!("PrimaryDuration")]);
    let mut duration = duration_base * duration_mod;
    if mode_effective {
        let debuff_expire_faster = calc_lib_mod_s(enemy_db, skill_cfg, &[pom_engine::sym!("BuffExpireFaster")]);
        let debuff_duration_mult = 1.0 / data::misc("BuffExpirationSlowCap").max(debuff_expire_faster);
        if debuff {
            duration *= debuff_duration_mult;
        }
    }
    duration
}

/// The result of the inline "Skill duration" block (CalcOffence.lua:1490-1593): every `output.*`
/// field it can set. `None` means the Lua branch's guard failed and that field was never
/// assigned (matching "absent from `output`", not "zero").
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct DurationOutput {
    pub duration_mod: f64,
    pub duration: Option<f64>,
    pub duration_secondary: Option<f64>,
    pub duration_tertiary: Option<f64>,
    pub aura_duration: Option<f64>,
}

/// Inputs from `skillData` this block reads besides the `Duration`/`*Duration` mod sums.
pub struct DurationSkillData {
    pub duration: f64,
    pub duration_secondary: f64,
    pub duration_tertiary: f64,
    pub aura_duration: f64,
    pub debuff: bool,
    pub debuff_secondary: bool,
    pub debuff_tertiary: bool,
    pub mine_duration_applies_to_skill: bool,
    /// `activeSkill.minion and skillModList:Flag(skillCfg, minion.type.."PermanentDuration")`
    /// (CalcOffence.lua:1505) - the minion-permanent-duration exemption on the primary duration
    /// only. Pass `false` when there's no minion.
    pub minion_permanent_duration: bool,
}

pub fn calc_duration_output(
    skill_mod_list: &ModStore,
    skill_cfg: Option<&Cfg>,
    skill_data: &DurationSkillData,
    mode_effective: bool,
    enemy_db: &ModStore,
) -> DurationOutput {
    let mine = skill_data.mine_duration_applies_to_skill;
    let mut names = vec!["Duration", "PrimaryDuration"];
    if mine {
        names.push("MineDuration");
    }
    let duration_mod = calc_lib_mod(skill_mod_list, skill_cfg, &names).max(0.0);

    let debuff_duration_mult = if mode_effective {
        1.0 / data::misc("BuffExpirationSlowCap").max(calc_lib_mod_s(enemy_db, skill_cfg, &[pom_engine::sym!("BuffExpireFaster")]))
    } else {
        1.0
    };
    let tick = data::misc("ServerTickRate");

    let mut out = DurationOutput { duration_mod, ..Default::default() };

    let primary_base = skill_data.duration + skill_mod_list.sum(ModType::Base, skill_cfg, &[pom_engine::sym!("Duration"), pom_engine::sym!("PrimaryDuration")]);
    if primary_base > 0.0 && !skill_data.minion_permanent_duration {
        let mut d = primary_base * duration_mod;
        if skill_data.debuff {
            d *= debuff_duration_mult;
        }
        out.duration = Some((d * tick).ceil() / tick);
    }

    let secondary_base = skill_data.duration_secondary + skill_mod_list.sum(ModType::Base, skill_cfg, &[pom_engine::sym!("Duration"), pom_engine::sym!("SecondaryDuration")]);
    if secondary_base > 0.0 {
        let mut names2 = vec!["Duration", "SecondaryDuration"];
        if mine {
            names2.push("MineDuration");
        }
        let dmod = calc_lib_mod(skill_mod_list, skill_cfg, &names2).max(0.0);
        let mut d = secondary_base * dmod;
        if skill_data.debuff_secondary {
            d *= debuff_duration_mult;
        }
        out.duration_secondary = Some((d * tick).ceil() / tick);
    }

    let tertiary_base = skill_data.duration_tertiary + skill_mod_list.sum(ModType::Base, skill_cfg, &[pom_engine::sym!("Duration"), pom_engine::sym!("TertiaryDuration")]);
    if tertiary_base > 0.0 {
        let mut names3 = vec!["Duration", "TertiaryDuration"];
        if mine {
            names3.push("MineDuration");
        }
        let dmod = calc_lib_mod(skill_mod_list, skill_cfg, &names3).max(0.0);
        let mut d = tertiary_base * dmod;
        if skill_data.debuff_tertiary {
            d *= debuff_duration_mult;
        }
        out.duration_tertiary = Some((d * tick).ceil() / tick);
    }

    if skill_data.aura_duration > 0.0 {
        let dmod = calc_lib_mod_s(skill_mod_list, skill_cfg, &[pom_engine::sym!("Duration")]).max(0.0);
        let d = skill_data.aura_duration * dmod;
        out.aura_duration = Some((d * tick).ceil() / tick);
    }

    out
}

/// `calcs.calcTotemLife(env, activeSkill)` (CalcOffence.lua:338-342).
pub fn calc_totem_life(skill_mod_list: &ModStore, skill_cfg: Option<&Cfg>, totem_level: i64, totem_id: i64) -> (f64, f64) {
    let life_mod = calc_lib_mod_s(skill_mod_list, skill_cfg, &[pom_engine::sym!("TotemLife")]);
    let life = crate::area::round((data::monster_ally_life_table(totem_level) * data::totem_life_mult(totem_id)).floor() * life_mod);
    (life, life_mod)
}
