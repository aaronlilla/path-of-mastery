//! Calcs-tab breakdown tables for CalcOffence.lua:1000-1700 (effect mods, trap / mine / totem / brand / corpse speed and
//! time chains, cooldown, stored uses, the skill duration block and uptime). Every write is behind `bd::on()`; the values
//! are the ones upstream reads at that point (`output.*` as already produced by the pipeline, mod sums off the skill's
//! own mod list). The tables belong to the actor (`breakdown` outside the pass loops), hence `bd::root`.
use crate::Env;
use pom_engine::modifier::ModType;
use pom_engine::modstore::store::ModStore;
use pom_engine::modstore::types::{Cfg, ScalarValue};
use pom_engine::sym::Sym;
use pom_engine::fxhash::HashMap;
use pom_offence::bd::{self, ins_s, num, set};
use pom_offence::bdbuild::{self, Chain, Link};
use pom_offence::sf;
use pom_offence::tools::{calc_lib_mod, calc_lib_mods};
use pom_skills::assemble::ComputedSkill;
use pom_skills::skill_type;
use serde_json::Value;

type Sd = HashMap<String, ScalarValue>;

fn sy(names: &[&str]) -> Vec<Sym> {
    names.iter().map(|n| Sym::new(n)).collect()
}
fn sum(m: &ModStore, cfg: &Cfg, ty: ModType, names: &[&str]) -> f64 {
    m.sum(ty, Some(cfg), &sy(names))
}
fn more(m: &ModStore, cfg: &Cfg, names: &[&str]) -> f64 {
    m.more(Some(cfg), &sy(names))
}
fn sd_num(sd: &Sd, k: &str) -> Option<f64> {
    match sd.get(k) {
        Some(ScalarValue::Num(n)) => Some(*n),
        _ => None,
    }
}
fn sd_truthy(sd: &Sd, k: &str) -> bool {
    match sd.get(k) {
        Some(ScalarValue::Bool(b)) => *b,
        Some(_) => true,
        None => false,
    }
}
fn out(env: &Env, k: &str) -> f64 {
    env.output.get(k).copied().unwrap_or(0.0)
}
/// `breakdown.<key> = tbl` (a nil result leaves the key absent).
fn put(key: &str, v: Option<Value>) {
    if let Some(v) = v {
        bd::root(|b| set(b, key, v));
    }
}
fn put_list(key: &str, lines: Vec<String>) {
    bd::root(|b| {
        let t = bd::reset(b, key);
        for l in lines {
            ins_s(t, l);
        }
    });
}
/// `t_insert(tbl, 1, line)`.
fn ins_front(key: &str, line: &str) {
    bd::root(|b| {
        if let Some(t) = bd::get(b, key) {
            match t {
                Value::Array(a) => a.insert(0, Value::String(line.to_string())),
                Value::Object(m) => {
                    let n = m.keys().filter(|k| k.parse::<usize>().is_ok()).count();
                    for i in (1..=n).rev() {
                        if let Some(v) = m.remove(&i.to_string()) {
                            m.insert((i + 1).to_string(), v);
                        }
                    }
                    m.insert("1".to_string(), Value::String(line.to_string()));
                }
                _ => {}
            }
        }
    });
}

/// `calcRadiusBreakpoints(baseRadius, incArea, moreArea, radiusMod)` (CalcOffence.lua:198-229): `(inc, more, red, less)`.
pub fn calc_radius_breakpoints(base: f64, inc: f64, more: f64, radius_mod: Option<f64>) -> Option<(f64, f64, f64, f64)> {
    use pom_offence::area::{calc_area_mod, calc_radius};
    let r = |i: f64, m: f64| calc_radius(base, calc_area_mod(i, m), radius_mod);
    let radius = r(inc, more);
    if !(radius > 0.0) {
        return None;
    }
    let find = |f: &dyn Fn(f64) -> f64, up: bool| -> f64 {
        let mut n = 0.0;
        loop {
            n += 1.0;
            let nr = f(n);
            if (up && nr > radius) || (!up && nr < radius) || n > 100000.0 {
                return n;
            }
        }
    };
    let i = find(&|n| r(inc + n / 100.0, more), true);
    let red = find(&|n| r(inc - n / 100.0, more), false);
    let m = find(&|n| r(inc, more * (1.0 + n / 100.0)), true);
    let less = find(&|n| r(inc, more * (1.0 - n / 100.0)), false);
    Some((i, m, red, less))
}

/// `breakdown.area(base, areaMod, total, inc, more, red, less)` with a nil label (the trap / mine call sites pass none).
fn area_nolabel(base: f64, area_mod: f64, total: f64, bp: Option<(f64, f64, f64, f64)>) -> Value {
    let mut o = bdbuild::area(base, area_mod, total, bp, "", None);
    // drop the empty label the shared code inserts first (a nil label inserts nothing)
    match &mut o {
        Value::Array(a) => {
            a.remove(0);
        }
        Value::Object(m) => {
            let n = m.keys().filter(|k| k.parse::<usize>().is_ok()).count();
            m.remove("1");
            for i in 2..=n {
                if let Some(v) = m.remove(&i.to_string()) {
                    m.insert((i - 1).to_string(), v);
                }
            }
        }
        _ => {}
    }
    o
}

fn radius_table(radius: f64) -> Value {
    bd::row(vec![("radius", num(radius))])
}

/// Lines 1187-1236 of upstream: effect mods, reservation mods, warcry effect.
pub fn effect_mods(env: &Env, main: &ComputedSkill, cfg: &Cfg, sd: &Sd, sml: &ModStore) {
    if !bd::on() {
        return;
    }
    let t = |ty: i64| main.skill_types.contains(&ty);
    if t(skill_type::AURA) {
        let on_self = !(sd_truthy(sd, "auraCannotAffectSelf") || t(skill_type::AURA_AFFECTS_ENEMIES));
        let names: Vec<&str> = if on_self { vec!["AuraEffect", "SkillAuraEffectOnSelf"] } else { vec!["AuraEffect"] };
        put("AuraEffectMod", bdbuild::mod_(sml, Some(cfg), &names));
    }
    if t(skill_type::HAS_RESERVATION) && !t(skill_type::RESERVATION_BECOMES_COST) {
        for pool in ["Life", "Mana"] {
            let reserved = format!("{pool}Reserved");
            let names = [reserved.as_str(), "Reserved", "SupportManaMultiplier"];
            let inc = sum(sml, cfg, ModType::Inc, &names);
            let mr = more(sml, cfg, &names);
            if inc != 0.0 && mr != 1.0 {
                let eff = format!("{pool}ReservationEfficiency");
                let lines = vec![
                    sf!("%.2f ^8(increased/reduced)", 1.0 + inc / 100.0),
                    sf!("x %.2f ^8(more/less)", mr),
                    sf!("/ %.2f ^8(reservation efficiency)", calc_lib_mod(sml, Some(cfg), &[eff.as_str(), "ReservationEfficiency"])),
                    sf!("= %.2f", out(env, &format!("{pool}ReservedMod"))),
                ];
                put_list(&format!("{pool}ReservedMod"), lines);
            }
        }
    }
    if t(skill_type::HEX) || t(skill_type::MARK) {
        put("CurseEffectMod", bdbuild::mod_(sml, Some(cfg), &["CurseEffect"]));
    }
    if t(skill_type::LINK) {
        put("LinkEffectMod", bdbuild::mod_(sml, Some(cfg), &["LinkEffect", "BuffEffect"]));
    }
    if t(skill_type::BUFF) && t(skill_type::HERALD) {
        put("HeraldBuffEffectMod", bdbuild::mod_(&env.player, Some(cfg), &["BuffEffect", "BuffEffectOnSelf"]));
    }
}

/// `breakdown.WarcryEffectMod` (CalcOffence.lua:1228-1239).
pub fn warcry_effect(env: &Env, unscaled: f64, uptime: f64, effect_mod: f64) {
    if !bd::on() {
        return;
    }
    let max_hit = env.player.flag(None, &[pom_engine::sym!("Condition:WarcryMaxHit")]);
    let mut lines = vec![sf!("%.2f ^8(effect modifiers)", unscaled)];
    if max_hit || uptime != 1.0 {
        if max_hit {
            lines.push("* 100% uptime (WarcryMaxHit Override)".to_string());
        } else if uptime != 1.0 {
            lines.push(sf!("* %.2f%% ^8(uptime)", uptime * 100.0));
        }
        lines.push(sf!("= %.1f%%", effect_mod * 100.0));
    }
    put_list("WarcryEffectMod", lines);
}

/// Everything else of the slice (projectile speed, weapon range, trap / mine / totem / brand / corpse, cooldown, stored uses,
/// durations, uptime). Call once the pipeline has produced the matching `output.*` fields.
pub fn skill_blocks(env: &Env, main: &ComputedSkill, cfg: &Cfg, sd: &Sd, sml: &ModStore, cooldown_rounded: bool) {
    if !bd::on() {
        return;
    }
    let has = |f: &str| main.skill_flags.contains(f);
    let t = |ty: i64| main.skill_types.contains(&ty);
    let action_speed = out(env, "ActionSpeedMod");
    let tick = pom_offence::data::misc("ServerTickRate");

    if has("projectile") {
        put("ProjectileSpeedMod", bdbuild::mod_(sml, Some(cfg), &["ProjectileSpeed"]));
    }
    if has("melee") && t(skill_type::MELEE_SINGLE_TARGET) {
        put("WeaponRange", Some(radius_table(out(env, "WeaponRange"))));
    }

    if has("trap") {
        let mut base_speed = 1.0 / sum(sml, cfg, ModType::Base, &["TrapThrowingTime"]);
        let time_mod = calc_lib_mod(sml, Some(cfg), &["SkillTrapThrowingTime"]);
        if time_mod > 0.0 {
            base_speed *= 1.0 / time_mod;
        }
        let speed = out(env, "TrapThrowingSpeed");
        let mut c = Chain::new();
        c.label = Some("Throwing rate:".into());
        c.base = Some(Link::n("%.2f ^8(base throwing rate)", base_speed));
        c.links = vec![
            Link::n("%.2f ^8(increased/reduced throwing speed)", 1.0 + sum(sml, cfg, ModType::Inc, &["TrapThrowingSpeed"]) / 100.0),
            Link::n("%.2f ^8(more/less throwing speed)", more(sml, cfg, &["TrapThrowingSpeed"])),
            Link::n("%.2f ^8(action speed modifier)", action_speed),
        ];
        c.total = Some(sf!("= %.2f ^8per second", speed));
        bd::root(|b| bdbuild::multi_chain(bd::reset(b, "TrapThrowingSpeed"), &c));
        if time_mod > 0.0 {
            let mut c = Chain::new();
            c.label = Some("Throwing time:".into());
            c.base = Some(Link::n("%.2f ^8(base throwing time)", 1.0 / (speed * time_mod)));
            c.links = vec![Link::n("%.2f ^8(total modifier)", time_mod)];
            c.total = Some(sf!("= %.2f ^8seconds per throw", out(env, "TrapThrowingTime")));
            bd::root(|b| bdbuild::multi_chain(bd::reset(b, "TrapThrowingTime"), &c));
        }
        let base_cd = sd_num(sd, "trapCooldown").or_else(|| sd_num(sd, "cooldown"));
        if base_cd.is_some() || sum(sml, cfg, ModType::Base, &["CooldownRecovery"]) != 0.0 {
            put_list(
                "TrapCooldown",
                vec![
                    sf!("%.2fs ^8(base)", base_cd.unwrap_or(4.0)),
                    sf!("/ %.2f ^8(increased/reduced cooldown recovery)", 1.0 + sum(sml, cfg, ModType::Inc, &["CooldownRecovery"]) / 100.0),
                    "rounded up to nearest server tick".to_string(),
                    sf!("= %.3fs", out(env, "TrapCooldown")),
                ],
            );
        }
        let (inc, mr) = calc_lib_mods(sml, Some(cfg), &["TrapTriggerAreaOfEffect"]);
        let base_r = pom_offence::data::misc("TrapTriggerRadiusBase");
        let area_mod = pom_offence::area::calc_area_mod(inc, mr);
        let bp = calc_radius_breakpoints(base_r, inc, mr, None);
        put("TrapTriggerRadius", Some(area_nolabel(base_r, area_mod, out(env, "TrapTriggerRadius"), bp)));
    } else if sd_num(sd, "cooldown").is_some() || sum(sml, cfg, ModType::Base, &["CooldownRecovery"]) != 0.0 {
        let added = sum(sml, cfg, ModType::Base, &["CooldownRecovery"]);
        let mut lines = vec![
            sf!("%.2fs ^8(base)", sd_num(sd, "cooldown").unwrap_or(0.0 + added)),
            sf!("/ %.2f ^8(increased/reduced cooldown recovery)", 1.0 + sum(sml, cfg, ModType::Inc, &["CooldownRecovery"]) / 100.0),
        ];
        if cooldown_rounded {
            lines.push("rounded up to nearest server tick".to_string());
        }
        lines.push(sf!("= %.3fs", out(env, "Cooldown")));
        put_list("Cooldown", lines);
    }

    if let Some(base_uses) = sd_num(sd, "storedUses") {
        let additional = sum(sml, cfg, ModType::Base, &["AdditionalCooldownUses", "AdditionalUses"]);
        let total = base_uses + additional;
        let plural = |n: f64| if n == 1.0 { "" } else { "s" };
        let mut lines = vec![sf!("%d ^8(skill use%s)", base_uses, plural(base_uses))];
        if additional != 0.0 {
            lines.push(sf!("+ %d ^8(additional use%s)", additional, plural(additional)));
            lines.push(sf!("= %d ^8(total use%s)", total, plural(total)));
        }
        put_list("StoredUses", lines);
    }

    if has("mine") {
        let mut base_speed = 1.0 / sum(sml, cfg, ModType::Base, &["MineLayingTime"]);
        let time_mod = calc_lib_mod(sml, Some(cfg), &["SkillMineThrowingTime"]);
        if time_mod > 0.0 {
            base_speed *= 1.0 / time_mod;
        }
        let throw_count = out(env, "MineThrowCount");
        let mut c = Chain::new();
        c.label = Some("Throwing rate:".into());
        c.base = Some(Link::n("%.2f ^8(base throwing rate)", base_speed));
        c.links = vec![
            Link::n("%.2f ^8(increased/reduced throwing speed)", 1.0 + sum(sml, cfg, ModType::Inc, &["MineLayingSpeed"]) / 100.0),
            Link::n("%.2f ^8(more/less throwing speed)", more(sml, cfg, &["MineLayingSpeed"])),
            Link::n("%.2f ^8(action speed modifier)", action_speed),
            Link::n("%.2f ^8(additional mine thrown)", 1.0 / (1.0 + (throw_count - 1.0) * 0.1)),
        ];
        c.total = Some(sf!("= %.2f ^8per second", out(env, "MineLayingSpeed")));
        bd::root(|b| bdbuild::multi_chain(bd::reset(b, "MineLayingTime"), &c));
        if time_mod > 0.0 {
            let mut c = Chain::new();
            c.label = Some("Throwing time:".into());
            c.base = Some(Link::n("%.2f ^8(base throwing time)", 1.0 / (out(env, "MineLayingSpeed") * time_mod)));
            c.links = vec![Link::n("%.2f ^8(total modifier)", time_mod)];
            c.total = Some(sf!("= %.2f ^8seconds per throw", out(env, "MineLayingTime")));
            bd::root(|b| bdbuild::multi_chain(bd::reset(b, "MineThrowingTime"), &c));
        }
        let (inc, mr) = calc_lib_mods(sml, Some(cfg), &["MineDetonationAreaOfEffect"]);
        let base_r = pom_offence::data::misc("MineDetonationRadiusBase");
        let area_mod = pom_offence::area::calc_area_mod(inc, mr);
        let bp = calc_radius_breakpoints(base_r, inc, mr, None);
        put("MineDetonationRadius", Some(area_nolabel(base_r, area_mod, out(env, "MineDetonationRadius"), bp)));
        if t(skill_type::AURA) {
            let (inc, mr) = calc_lib_mods(sml, Some(cfg), &["AreaOfEffect"]);
            let base_r = pom_offence::data::misc("MineAuraRadiusBase");
            let bp = calc_radius_breakpoints(base_r, inc, mr, None);
            put("MineAuraRadius", Some(area_nolabel(base_r, out(env, "AreaOfEffectMod"), out(env, "MineAuraRadius"), bp)));
        }
    }

    if has("totem") {
        let ballista = has("ballista");
        let base_speed = 1.0 / sum(sml, cfg, ModType::Base, &[if ballista { "BallistaPlacementTime" } else { "TotemPlacementTime" }]);
        let mut c = Chain::new();
        c.label = Some("Placement speed:".into());
        c.base = Some(Link::n("%.2f ^8(base placement speed)", base_speed));
        c.links = vec![
            Link::n("%.2f ^8(increased/reduced placement speed)", 1.0 + sum(sml, cfg, ModType::Inc, &["TotemPlacementSpeed"]) / 100.0),
            Link::n("%.2f ^8(more/less placement speed)", more(sml, cfg, &["TotemPlacementSpeed"])),
            Link::n("%.2f ^8(action speed modifier)", action_speed),
        ];
        c.total = Some(sf!("= %.2f ^8per second", out(env, "TotemPlacementSpeed")));
        bd::root(|b| bdbuild::multi_chain(bd::reset(b, "TotemPlacementTime"), &c));
        put_list(
            "ActiveTotemLimit",
            vec![format!(
                "Totems Summoned: {}{}",
                bd::tostr(out(env, "TotemsSummoned")),
                if env.config_input.contains_key("TotemsSummoned") { " ^8(overridden from the Configuration tab)" } else { " ^8(can be overridden in the Configuration tab)" }
            )],
        );
        put("TotemLifeMod", bdbuild::mod_(sml, Some(cfg), &["TotemLife"]));
        if let (Some(level), Some(ge)) = (sd_num(sd, "totemLevel"), pom_skills::data::granted_effect_by_skill_id(&main.granted_effect_id)) {
            let id = match ge.extra.get("skillTotemId").and_then(|v| v.as_i64()) {
                Some(i) => i,
                None => match ge.color {
                    Some(2) => 2,
                    Some(3) => 3,
                    _ => 1,
                },
            };
            let lvl = level as i64;
            put_list(
                "TotemLife",
                vec![
                    format!("Totem level: {}", bd::tostr(level)),
                    format!("{} ^8(base life for a level {} monster)", bd::tostr(pom_offence::data::monster_ally_life_table(lvl)), bd::tostr(level)),
                    format!("x {} ^8(life multiplier for this totem type)", bd::tostr(pom_offence::data::totem_life_mult(id))),
                    format!("x {} ^8(totem life modifier)", bd::tostr(out(env, "TotemLifeMod"))),
                    format!("= {}", bd::tostr(out(env, "TotemLife"))),
                ],
            );
        }
        put("TotemEnergyShield", bdbuild::mod_(sml, Some(cfg), &["TotemEnergyShield"]));
        put("TotemBlockChance", bdbuild::mod_(sml, Some(cfg), &["TotemBlockChance"]));
        put("TotemArmour", bdbuild::mod_(sml, Some(cfg), &["TotemArmour"]));
    }

    if t(skill_type::BRAND) {
        put("BrandAttachmentRange", Some(radius_table(out(env, "BrandAttachmentRange"))));
    }

    if has("corpse") {
        let level = out(env, "CorpseLevel") as i64;
        let variety = match sd.get("corpseMonsterVariety") {
            Some(ScalarValue::Str(s)) => Some(s.to_string()),
            _ => None,
        };
        let enemy_level = env.enemy_level;
        put_list(
            "CorpseLife",
            vec![
                sf!("%d ^8(base life of a level %d monster)", pom_offence::data::monster_life_table(level), level),
                sf!("x %.2f ^8(%s variety multiplier)", variety.as_deref().map(pom_offence::data::monster_variety_life_mult).unwrap_or(1.0), variety.clone().unwrap_or_else(|| "nil".into())),
                sf!("x %.2f ^8(map level %d monster life multiplier from config)", pom_offence::data::map_level_life_mult(enemy_level as i64), enemy_level),
                sf!(" = %d ^8(base corpse life)", out(env, "BaseCorpseLife")),
                String::new(),
                sf!("x %.2f ^8(corpse maximum life increases)", out(env, "CorpseLifeInc")),
                sf!(" = %d", out(env, "CorpseLife")),
            ],
        );
    }

    durations(env, cfg, sd, sml, tick);

    // Skill uptime (1662-1690). `reserveDuration` (lower case) is never an output key.
    if !t(skill_type::VAAL) {
        let cooldown = out(env, "Cooldown");
        let no_rec = sml.flag(Some(cfg), &[pom_engine::sym!("NoCooldownRecoveryInDuration")]);
        for dt in ["Duration", "DurationSecondary", "DurationTertiary", "AuraDuration"] {
            let d = out(env, dt);
            if d != 0.0 && cooldown != 0.0 {
                let up = out(env, &format!("{dt}Uptime"));
                let first = if no_rec { sf!("%.2fs / (%.2fs + %.2fs)", d, cooldown, d) } else { sf!("%.2fs / %.2fs", d, cooldown) };
                put_list(&format!("{dt}Uptime"), vec![first, sf!("= %d%%", up)]);
            }
        }
    }
}

/// The "Skill duration" block (1490-1655).
fn durations(env: &Env, cfg: &Cfg, sd: &Sd, sml: &ModStore, tick: f64) {
    let debuff_mult = if pom_calc::setup::buff_mode().effective { 1.0 / pom_offence::data::misc("BuffExpirationSlowCap").max(calc_lib_mod(&env.enemy, Some(cfg), &["BuffExpireFaster"])) } else { 1.0 };
    let mine = sd_truthy(sd, "mineDurationAppliesToSkill");
    let with_mine = |mut v: Vec<&'static str>| -> Vec<&'static str> {
        if mine {
            v.push("MineDuration");
        }
        v
    };
    let duration_mod = out(env, "DurationMod");
    put("DurationMod", bdbuild::mod_(sml, Some(cfg), &with_mine(vec!["Duration", "PrimaryDuration"])));
    if sd_truthy(sd, "durationSecondary") {
        let has_it = bd::root(|b| bd::get(b, "DurationMod").is_some()).unwrap_or(false);
        if has_it {
            ins_front("DurationMod", "Primary duration:");
        }
    }
    let primary_base = sd_num(sd, "duration").unwrap_or(0.0) + sum(sml, cfg, ModType::Base, &["Duration", "PrimaryDuration"]);
    if primary_base > 0.0 && env.output.contains_key("Duration") {
        let d = out(env, "Duration");
        if d != primary_base {
            let mut lines = vec![sf!("%.2fs ^8(base)", primary_base)];
            if duration_mod != 1.0 {
                lines.push(sf!("x %.4f ^8(duration modifier)", duration_mod));
            }
            if sd_truthy(sd, "debuff") && debuff_mult != 1.0 {
                lines.push(sf!("/ %.3f ^8(debuff expires slower/faster)", 1.0 / debuff_mult));
            }
            lines.push("rounded up to nearest server tick".to_string());
            lines.push(sf!("= %.3fs", d));
            put_list("Duration", lines);
        }
    }
    for (kind, sd_key, out_key, mod_key, label, debuff_key) in [
        ("SecondaryDuration", "durationSecondary", "DurationSecondary", "SecondaryDurationMod", "Secondary duration:", "debuffSecondary"),
        ("TertiaryDuration", "durationTertiary", "DurationTertiary", "TertiaryDurationMod", "Tertiary duration:", "debuffTertiary"),
    ] {
        let base = sd_num(sd, sd_key).unwrap_or(0.0) + sum(sml, cfg, ModType::Base, &["Duration", kind]);
        if base > 0.0 && env.output.contains_key(out_key) {
            let names = with_mine(vec!["Duration", kind]);
            let dmod = calc_lib_mod(sml, Some(cfg), &names).max(0.0);
            let d = out(env, out_key);
            if d != base {
                put(mod_key, bdbuild::mod_(sml, Some(cfg), &names));
                let has_it = bd::root(|b| bd::get(b, mod_key).is_some()).unwrap_or(false);
                if has_it {
                    ins_front(mod_key, label);
                }
                let mut lines = vec![sf!("%.2fs ^8(base)", base)];
                if duration_mod != 1.0 {
                    lines.push(sf!("x %.4f ^8(duration modifier)", dmod));
                }
                if sd_truthy(sd, debuff_key) && debuff_mult != 1.0 {
                    lines.push(sf!("/ %.3f ^8(debuff expires slower/faster)", 1.0 / debuff_mult));
                }
                lines.push("rounded up to nearest server tick".to_string());
                lines.push(sf!("= %.3fs", d));
                put_list(out_key, lines);
            }
        }
    }
    for (sd_key, out_key) in [("auraDuration", "AuraDuration"), ("reserveDuration", "ReserveDuration")] {
        let base = sd_num(sd, sd_key).unwrap_or(0.0);
        if base > 0.0 && env.output.contains_key(out_key) {
            let d = out(env, out_key);
            if d != base {
                let dmod = calc_lib_mod(sml, Some(cfg), &["Duration"]).max(0.0);
                put_list(out_key, vec![sf!("%.2fs ^8(base)", base), sf!("x %.4f ^8(duration modifier)", dmod), "rounded up to nearest server tick".to_string(), sf!("= %.3fs", d)]);
            }
        }
    }
    let soul_base = sd_num(sd, "soulPreventionDuration").unwrap_or(0.0);
    if soul_base > 0.0 && env.output.contains_key("SoulGainPreventionDuration") {
        let mut names = vec!["SoulGainPreventionDuration"];
        if sd_truthy(sd, "skillEffectAppliesToSoulGainPrevention") {
            names.push("Duration");
        }
        if mine {
            names.push("MineDuration");
        }
        let dmod = calc_lib_mod(sml, Some(cfg), &names).max(0.0);
        let d = out(env, "SoulGainPreventionDuration");
        if d != soul_base {
            put_list("SoulGainPreventionDuration", vec![sf!("%.2fs ^8(base)", soul_base), sf!("x %.4f ^8(duration modifier)", dmod), "rounded up to nearest server tick".to_string(), sf!("= %.3fs", d)]);
        }
    }
    let totem_mod = out(env, "TotemDurationMod");
    put("TotemDurationMod", bdbuild::mod_(sml, Some(cfg), &["TotemDuration"]));
    let mut lines = vec![sf!("%.2fs ^8(base)", sum(sml, cfg, ModType::Base, &["TotemDuration"]))];
    if totem_mod != 1.0 {
        lines.push(sf!("x %.4f ^8(duration modifier)", totem_mod));
    }
    lines.push("rounded up to nearest server tick".to_string());
    lines.push(sf!("= %.3fs", out(env, "TotemDuration")));
    put_list("TotemDuration", lines);

    let impale_mod = out(env, "ImpaleDurationMod");
    put("ImpaleDurationMod", bdbuild::mod_(sml, Some(cfg), &["ImpaleDuration"]));
    let mut lines = vec![sf!("%.2fs ^8(base)", pom_offence::data::character_constant("impaled_debuff_base_duration_ms") / 1000.0)];
    if debuff_mult != 1.0 {
        lines.push(sf!("/ %.3f ^8(debuff expires slower/faster)", 1.0 / debuff_mult));
    }
    if impale_mod != 1.0 {
        lines.push(sf!("x %.4f ^8(duration modifier)", impale_mod));
    }
    lines.push("rounded up to nearest server tick".to_string());
    lines.push(sf!("= %.3fs", out(env, "ImpaleDuration")));
    put_list("ImpaleDuration", lines);
    let _ = tick;
}
