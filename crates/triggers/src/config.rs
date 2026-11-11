//! Port of `configTable` and `getUniqueItemTriggerName` (CalcTriggers.lua lines 902-1601,
//! 1584-1600). Each entry is a small closure-building function, matching the Lua source
//! function-for-function. Entries whose setup needs a ModStore query or player/enemy condition
//! flag this crate's recorder does not yet capture return `None` (not "no config": the
//! original has a config there, the recording just lacks the fact).

use crate::*;

fn melee_or_attack(s: &Skill) -> bool { s.has_skill_type(MELEE) || s.has_skill_type(ATTACK) }
fn damage_or_attack(s: &Skill) -> bool { s.has_skill_type(DAMAGE) || s.has_skill_type(ATTACK) }

/// `for _, skill in ipairs(env.player.activeSkillList) do if skill.activeEffect.grantedEffect.name
/// == name then return skill.activeEffect.grantedEffect end end` (CalcTriggers.lua's automation/
/// autoexertion/call to arms handlers): the matched skill's own `levelCooldown`, used in place of
/// the generic support-gem triggeredBy target's (which has none).
fn find_skill_level_cooldown(skills: &[Skill], name: &str) -> Option<f64> {
    skills.iter().find(|s| s.ge.name.as_deref() == Some(name)).and_then(|s| s.ge.level_cooldown)
}

/// Port of `getUniqueItemTriggerName` (CalcTriggers.lua:1585).
pub fn get_unique_item_trigger_name(skill: &Skill) -> Option<String> {
    if let Some(src) = s(&skill.skill_data, "triggerSource") { return Some(src); }
    for sup in &skill.support_list {
        if sup.from_item && !sup.support { return Some(sup.name.clone()); }
    }
    // socketGroup.source:find(".*:.*:(.*),.*") - a "a:b:name,rest" triple; take the 3rd field up
    // to the next comma.
    if let Some(src) = skill.socket_group.as_ref().and_then(|sg| sg.source.as_deref()) {
        // `source:find(".*:.*:(.*),.*")` with Lua's greedy matching: the capture runs to the last comma
        if let Ok(Some(f)) = pom_engine::luapat::find(src.as_bytes(), b".*:.*:(.*),.*", None, false) {
            if let Some(pom_engine::luapat::Cap::S(b)) = f.caps.first() {
                return Some(String::from_utf8_lossy(b).into_owned());
            }
        }
    }
    None
}

#[derive(Default)]
pub struct SetupEffects {
    pub global_trigger: bool,
    pub trigger_rate_cap_override: Option<f64>,
    pub ignores_tick_rate: bool,
    pub source_rate_is_final: bool,
    pub skip_effective_rate: bool,
    pub disable_reason: Option<String>,
    pub cwdt: bool,
    /// `env.player.mainSkill.skillData.cooldown = N` written by the configTable step (Lioneye's Paws, Moonbender's Wing).
    pub skill_data_cooldown: Option<f64>,
    /// Snipe: `output.ChannelTimeToTrigger` (the source Snipe's HitTime).
    pub channel_time: Option<f64>,
    /// Snipe: the main skill gets the per-stage Damage MORE mods.
    pub snipe_mods: bool,
    /// `env.player.mainSkill.skillFlags.disable = true` written by a configTable step (The Hidden Blade without Phasing);
    /// `disable_reason` above is `mainSkill.disableReason`.
    pub disable: bool,
    /// `env.player.breakdown.<key> = {...}` written by a configTable step before the handler runs (the handler keeps a
    /// `TriggerRateCap` table that is already there, and a later write of another handler branch replaces the others).
    pub preset_tables: Vec<(String, J)>,
    /// `env.player.modDB:NewMod("UsesCurseOverlaps", "FLAG", true, "Config")` (Doom Blast); only the Config tab's visibility reads it.
    pub uses_curse_overlaps: bool,
    /// `mainSkill.infoMessage` / `infoMessage2` a configTable step wrote before returning nothing (the sidebar's lines).
    pub info_message: Option<String>,
    pub info_message2: Option<String>,
    /// `mainSkill.infoTrigger = ""` (Snipe without enough stages).
    pub info_trigger_empty: bool,
}

pub struct TrigFacts<'a> {
    pub gc: &'a GlobalCache,
    pub enemy_ignited: bool,
    pub doom_blast_source: Option<String>,
    pub gloves_title_has_vixen: bool,
    pub main_slot_item_name: Option<String>,
    /// `#modDB:Tabulate("BASE", nil, "Multiplier:CurseOverlaps") > 0 and max(sum, 1)` (None = false).
    pub curse_overlaps: Option<f64>,
    /// `data.skills.SupportUniqueCastCurseOnCurse.levels[1].cooldown`.
    pub vixens_base_cooldown: Option<f64>,
    pub kitava_required_mana_cost: f64,
    pub kitava_trigger_chance: f64,
    pub foulborn_kitava_required_life_cost: f64,
    pub foulborn_kitava_trigger_chance: f64,
    /// `min(Sum BASE Multiplier:SnipeStage, Sum BASE Multiplier:SnipeStagesMax)`.
    pub snipe_stages: f64,
    /// `env.modDB:Sum("BASE", nil, "IntuitiveLinkSourceRate")`.
    pub intuitive_link_rate: f64,
    /// `env.player.modDB:Flag(nil, "Condition:Phasing")`.
    pub phasing: bool,
    /// `env.player.modDB:Flag(nil, "Condition:KilledRecently")`.
    pub killed_recently: bool,
    /// `env.player.modDB:Sum("BASE", nil, "BloodShrineExplodingToadTriggerChance")`.
    pub blood_shrine_toad_chance: f64,
}

/// Port of `calcs.triggers`' configTable lookup+dispatch (CalcTriggers.lua lines 1602-1627),
/// minus the config keys in `NOT_YET_PORTED_KEYS` (those return `None` here,
/// which this crate's `no_trigger_found` path reports the same as "no config recognized" -
/// a visible, bucketed mismatch for the affected builds, not a silent wrong number).
///
/// Every entry writes its side effects (`skillFlags`, `skillData`, `breakdown`) into the shared `fx`, whether or not it returns a
/// config: upstream writes them on the main skill itself, and the next key of the lookup chain runs after them.
pub fn resolve_config(key: &str, main: &Skill, skills: &[Skill], facts: &TrigFacts<'_>, fx: &mut SetupEffects) -> Option<Config> {
    let mut cfg = Config::default();
    match key {
        "law of the wilds" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| {
                !sk.has_skill_type(SUMMONS_TOTEM) && melee_or_attack(sk) && sk.mod_flags(MF_CLAW)
            }));
        }
        "the rippling thoughts" => {
            if main.name() != "Storm Cascade" { return None; }
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        "the surging thoughts" => {
            if main.name() != "Storm Cascade" { return None; }
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        "the hidden blade" => {
            fx.global_trigger = true;
            fx.trigger_rate_cap_override = Some(2.0);
            if facts.phasing {
                if breakdown_on() {
                    fx.preset_tables.push((
                        "TriggerRateCap".into(),
                        J::Array(vec![
                            J::String(pom_offence::sf!("%.2f ^8(Unseen Strike from The Hidden Blade has no cooldown but is still triggered)", 2.0)),
                            J::String(pom_offence::sf!("= %.2f", 2.0)),
                        ]),
                    ));
                }
                cfg.source_is_main = true;
            } else {
                fx.disable = true;
                fx.disable_reason = Some("This skill is requires you to be phasing".into());
                return None;
            }
        }
        "flames of judgement" | "storm of judgement" => {
            fx.source_rate_is_final = true;
            cfg.trigger_name = main.ge.name.clone();
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.name() == "Queen's Demand"));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByUnique") && slot_group_eq_opt(&m.socket_group, &sk.socket_group)));
        }
        "replica eternity shroud" | "shroud of the lightless" => {
            fx.global_trigger = true;
            cfg.source_is_main = true; // sentinel: "source = main" resolved by caller
        }
        "limbsplit" | "the cauteriser" => {
            cfg.trigger_name = Some("Gore Shockwave".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        "duskblight" => {
            cfg.trigger_name = Some("Stalking Pustule".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk)));
        }
        "lioneye's paws" | "replica lioneye's paws" => {
            fx.skill_data_cooldown = Some(1.0);
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(ATTACK) && sk.mod_flags(MF_BOW)));
        }
        "moonbender's wing" => {
            fx.skill_data_cooldown = Some(1.0);
            cfg.trigger_name = Some("Lightning Warp".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        "ngamahu's flame" => {
            cfg.trigger_name = Some("Molten Burst".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        "cameria's avarice" => {
            cfg.trigger_name = Some("Icicle Burst".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk)));
        }
        "starcaller" => {
            cfg.trigger_name = Some("Starfall".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        "uul-netol's embrace" => {
            cfg.trigger_name = Some("Bone Nova".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk)));
        }
        "rigwald's crest" | "jorrhast's blacksteel" | "ashcaller" => {
            fx.source_rate_is_final = true;
            cfg.assuming_every_hit_kills = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk)));
        }
        "arakaali's fang" | "sporeguard" | "mark of the elder" | "mark of the shaper" => {
            cfg.assuming_every_hit_kills = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk)));
        }
        "poet's pen" => {
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk) && sk.mod_flags(MF_WAND)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| {
                flag(&sk.skill_data, "triggeredByUnique") && slot_group_eq_opt(&m.socket_group, &sk.socket_group) && sk.has_skill_type(SPELL)
            }));
        }
        "maloney's mechanism" => {
            // `modSource:find(".*:.*:(.*),.*")`: the item name up to its last comma ("Title, Base").
            let name = facts.main_slot_item_name.as_deref()?;
            let unique_name = name[..name.rfind(',')?].to_string();
            let is_replica = unique_name.find("Replica").is_some_and(|i| unique_name[i + 7..].chars().next().is_some());
            cfg.trigger_on_use = true;
            cfg.trigger_name = Some(unique_name);
            cfg.use_cast_rate = is_replica;
            cfg.trigger_skill_cond = Some(Box::new(move |_m, sk| {
                let attack = sk.has_skill_type(ATTACK) && sk.mod_flags(MF_BOW) && !is_replica;
                let spell = sk.has_skill_type(SPELL) && is_replica;
                attack || spell
            }));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| {
                flag(&sk.skill_data, "triggeredByUnique") && slot_group_eq_opt(&m.socket_group, &sk.socket_group) && sk.has_skill_type(RANGED_ATTACK)
            }));
        }
        "asenath's chant" => {
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk) && sk.mod_flags(MF_BOW)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| {
                flag(&sk.skill_data, "triggeredByUnique") && slot_group_eq_opt(&m.socket_group, &sk.socket_group) && sk.has_skill_type(SPELL)
            }));
        }
        "vixen's entrapment" => {
            cfg.use_cast_rate = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(HEX)));
        }
        "trigger craft" => {
            if !flag(&main.skill_data, "triggeredByCraft") { return None; }
            // The config function itself scans activeSkillList and calls findTriggerSkill (CalcTriggers.lua:1063-1085).
            let mut source: Option<&Skill> = None;
            let mut trig_rate: Option<f64> = None;
            for skill in skills {
                if (skill.has_skill_type(DAMAGE) || skill.has_skill_type(ATTACK) || skill.has_skill_type(SPELL))
                    && !flag(&skill.skill_flags, "aura")
                    && !std::ptr::eq(skill, main)
                    && !flag(&skill.skill_data, "triggeredByCraft")
                    && !skill.ge.from_item
                    && !is_triggered(skill)
                {
                    let (s2, r2) = find_trigger_skill(facts.gc, skill, source, trig_rate, default_comparer);
                    source = s2;
                    trig_rate = r2;
                    let kind = ["totem", "golem", "banner", "ballista"].iter().any(|f| flag(&skill.skill_flags, f));
                    if kind {
                        if let Some(ct) = skill.ge.cast_time {
                            trig_rate = Some(1.0 / (ct + skill.ge.level_cooldown.unwrap_or(0.0)));
                            cfg.use_cast_rate = true;
                        }
                    }
                }
            }
            cfg.source_idx = source.and_then(|src| skills.iter().position(|s| std::ptr::eq(s, src)));
            cfg.trig_rate = trig_rate;
            // (upstream returns `triggeredSkills` from the config itself, never `triggeredSkillCond`: the
            // handler's rotation is the main skill alone)
        }
        "kitava's thirst" => {
            cfg.trigger_chance = Some(facts.kitava_trigger_chance);
            cfg.trigger_name = Some("Kitava's Thirst".into());
            cfg.comparer = Some(ComparerKind::Kitava);
            cfg.trigger_skill_cond = Some(Box::new(|_m, _sk| true));
        }
        "foulborn kitava's thirst" => {
            cfg.trigger_chance = Some(facts.foulborn_kitava_trigger_chance);
            cfg.trigger_name = Some("Foulborn Kitava's Thirst".into());
            cfg.comparer = Some(ComparerKind::FoulbornKitava);
            cfg.trigger_skill_cond = Some(Box::new(|_m, _sk| true));
        }
        "mjolner" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| {
                damage_or_attack(sk) && sk.mod_flags(MF_MACE | MF_WEAPON1H) && !slot_match(m, sk)
            }));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByMjolner") && slot_match(m, sk)));
        }
        "wing of the wyvern" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| damage_or_attack(sk) && sk.mod_flags(MF_BOW) && !slot_match(m, sk)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByUnique") && slot_match(m, sk)));
        }
        "cospri's malice" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(MELEE) && sk.mod_flags(MF_SWORD | MF_WEAPON1H)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| {
                flag(&sk.skill_data, "triggeredByCospris") && slot_group_eq_opt(&m.socket_group, &sk.socket_group)
            }));
        }
        "seven teachings" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(MELEE) && (sk.skill_cfg_flags & (MF_UNARMED | MF_MELEE)) == (MF_UNARMED | MF_MELEE)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredBySevenTeachings") && slot_match(m, sk)));
        }
        "squirming terror" => {
            if !facts.killed_recently {
                fx.info_message2 = Some("DPS reported assuming Self-Cast".into());
                fx.info_message = Some("Squirming Terror requires recent kills".into());
                return None;
            }
            cfg.assuming_every_hit_kills = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(ATTACK) && sk.has_skill_type(MELEE)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredBySquirmingTerror") && slot_match(m, sk)));
        }
        "cast on melee kill" => {
            if !facts.killed_recently {
                fx.info_message2 = Some("DPS reported assuming Self-Cast".into());
                fx.info_message = Some("Cast on Melee Kill requires recent kills".into());
                return None;
            }
            cfg.assuming_every_hit_kills = true;
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(ATTACK) && sk.has_skill_type(MELEE) && slot_match(m, sk)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByMeleeKill") && slot_match(m, sk)));
        }
        "kinetic flux" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(ATTACK) && slot_match(m, sk)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByKineticFlux") && slot_match(m, sk)));
        }
        "cast on critical strike" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(ATTACK) && slot_match(m, sk)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByCoc") && slot_match(m, sk)));
        }
        "nova" => {
            // Holy Relic's Nova (minion actor): `actor = env.minion`, fired by any player attack.
            cfg.trigger_name = Some("Summon Holy Relic".into());
            cfg.actor_is_minion = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(ATTACK)));
        }
        "cast when damage taken" => {
            if !flag(&main.skill_data, "triggeredByDamageTaken") { return None; }
            fx.cwdt = true;
            fx.global_trigger = true;
            cfg.source_is_main = true;
        }
        "cast when stunned" => {
            fx.global_trigger = true;
            cfg.trigger_chance = num(&main.skill_data, "chanceToTriggerOnStun");
            cfg.source_is_main = true;
        }
        "cast on ward break" => {
            fx.global_trigger = true;
            cfg.trigger_chance = num(&main.skill_data, "chanceToTriggerOnWardBreak");
            cfg.source_is_main = true;
        }
        "spellslinger" => {
            if main.name() == "Spellslinger" { fx.skip_effective_rate = true; }
            fx.source_rate_is_final = true;
            cfg.trigger_name = Some("Spellslinger".into());
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| {
                sk.has_skill_type(ATTACK) && sk.has_skill_type(PROJECTILE) && sk.mod_flags(MF_WAND) && !flag(&sk.skill_data, "triggeredBySpellSlinger")
            }));
        }
        "call to arms" => {
            let is_self = main.name() == "Call to Arms";
            fx.global_trigger = is_self;
            fx.skip_effective_rate = is_self;
            if !is_self { cfg.trigger_cd_override = find_skill_level_cooldown(skills, "Call to Arms"); }
            fx.source_rate_is_final = true;
            fx.ignores_tick_rate = true;
            cfg.trigger_on_use = true;
            cfg.use_cast_rate = true;
            cfg.source_is_main = true;
        }
        "automation" => {
            // Unlike "call to arms", Automation does not set sourceRateIsFinal/ignoresTickRate.
            let is_self = main.name() == "Automation";
            fx.global_trigger = is_self;
            fx.skip_effective_rate = is_self;
            if !is_self { cfg.trigger_cd_override = find_skill_level_cooldown(skills, "Automation"); }
            cfg.trigger_on_use = true;
            cfg.use_cast_rate = true;
            cfg.source_is_main = true;
        }
        "autoexertion" => {
            let is_self = main.name() == "Autoexertion";
            fx.global_trigger = is_self;
            fx.skip_effective_rate = is_self;
            if !is_self { cfg.trigger_cd_override = find_skill_level_cooldown(skills, "Autoexertion"); }
            fx.source_rate_is_final = true;
            fx.ignores_tick_rate = true;
            cfg.trigger_on_use = true;
            cfg.use_cast_rate = true;
            cfg.source_is_main = true;
        }
        "seize the flesh" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(WARCRY) && slot_match(m, sk)));
        }
        "fissure" => {
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(SLAM) && slot_match(m, sk)));
        }
        "mark on hit" => { cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(ATTACK))); }
        "hextouch" | "oskarm" => {
            fx.source_rate_is_final = true;
            if key == "hextouch" {
                cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(ATTACK) && slot_match(m, sk)));
            } else {
                cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(ATTACK)));
            }
        }
        "tempest shield" => { fx.global_trigger = true; cfg.source_is_main = true; }
        "shattershard" => {
            fx.global_trigger = true;
            // `GlobalCache.cachedData[env.mode][uuid].Env.player.output.Duration` of the main skill itself (built when it is not cached yet)
            let uuid = main.uuid.as_deref().unwrap_or("");
            let entry = facts.gc.get(uuid);
            if entry.is_none() { crate::GC_MISSES.with(|m| m.borrow_mut().push(uuid.to_string())); }
            let duration = entry.and_then(|e| e.duration).unwrap_or(f64::NAN);
            let cap = 1.0 / duration;
            fx.trigger_rate_cap_override = Some(cap);
            if breakdown_on() {
                fx.preset_tables.push((
                    "SkillTriggerRate".into(),
                    J::Array(vec![
                        J::String("Shattershard uses duration as pseudo cooldown".into()),
                        J::String(pom_offence::sf!("1 / %.2f ^8(Shattershard duration)", duration)),
                        J::String(pom_offence::sf!("= %.2f ^8per second", cap)),
                    ]),
                ));
            }
            cfg.source_is_main = true;
        }
        "battlemage's cry" => {
            if main.name() == "Battlemage's Cry" { return None; }
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(MELEE)));
            cfg.comparer = Some(ComparerKind::BattlemageUptime);
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByBattleMageCry") && slot_match(m, sk)));
        }
        "arcanist brand" => {
            if main.name() == "Arcanist Brand" { return None; }
            let bi = skills.iter().position(|sk| sk.name() == "Arcanist Brand")?;
            let brand = &skills[bi];
            let inc = brand.brand_activation_freq_inc;
            let more = brand.brand_activation_freq_more;
            let rf = num_or(&brand.skill_data, "repeatFrequency", 0.0);
            let count = num_or(&brand.skill_data, "attachedBrandCount", 0.0);
            fx.source_rate_is_final = true;
            cfg.trigger_ignores_tick_rate = true;
            cfg.brand_trigger_cd = Some(rf / more / inc);
            cfg.brand_attached_count = count;
            cfg.trig_rate = Some(rf * inc * more * count);
            cfg.source_idx = Some(bi);
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByBrand") && slot_match(m, sk)));
        }
        // Upstream's ["cast on death"] handler sets globalTrigger/triggered/infoMessage as
        // side effects but has no `return` statement, so it yields nil like every other
        // unmatched candidate; calcs.triggers's `if config then ... else actor.mainSkill.
        // skillData.triggered = nil end` then clobbers that triggered=true side effect back to
        // nil. Net effect (a genuine bug in upstream): this key always resolves as "no
        // trigger found".
        "cast on death" => {
            fx.info_message = Some(format!("{} Triggered on Death", main.ge.name.as_deref().unwrap_or("")));
            return None;
        }
        "combust" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(MELEE)));
            cfg.comparer = Some(ComparerKind::InfernalUptime);
        }
        "prismatic burst" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(ATTACK) && slot_match(m, sk)));
        }
        "voidstorm" => {
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(ATTACK) && sk.has_skill_type(RAIN) && slot_match(m, sk)));
        }
        "shockwave" | "void shockwave" | "falling crystal" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(MELEE) && slot_match(m, sk)));
        }
        "call the pyre" => {
            if !facts.enemy_ignited {
                fx.info_message = Some("Call the Pyre requires Ignited enemies".into());
                return None;
            }
            cfg.trigger_chance = Some(50.0);
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(MELEE) && slot_match(m, sk)));
        }
        "manaforged arrows" => {
            cfg.trigger_on_use = true;
            cfg.trigger_name = Some("Manaforged Arrows".into());
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(ATTACK) && sk.mod_flags(MF_BOW)));
        }
        "doom blast" => {
            match facts.doom_blast_source.as_deref() {
                Some("vixen") => {
                    cfg.vixen_base_cooldown = facts.vixens_base_cooldown;
                    cfg.vixen_no_gloves = !facts.gloves_title_has_vixen;
                }
                Some("replacement") => fx.uses_curse_overlaps = true,
                _ => {}
            }
            cfg.doom_blast_source = facts.doom_blast_source.clone();
            fx.ignores_tick_rate = true;
            cfg.use_cast_rate = true;
            cfg.overlaps = facts.curse_overlaps;
            cfg.custom_trigger_name = Some("Doom Blast triggering Hex: ".into());
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| sk.has_skill_type(HEX) && slot_match(m, sk)));
        }
        // CWCHandler's source selection needs calcLib.canGrantedEffectSupportActiveSkill (a
        // support-gem compatibility check owned by the setup/gem-data side, not recorded).
        // helmetFocusHandler needs a "FocusCooldownRecovery"-scoped ICDR the recorder does not
        // capture (only the generic "CooldownRecovery" scope is recorded per skill). Both custom
        // handlers are therefore not yet ported.
        "cast while channelling" => {
            cfg.custom_handler = Some(CustomHandler::Cwc);
        }
        "focus" => {
            cfg.custom_handler = Some(CustomHandler::Focus);
        }
        "snipe" => {
            // CalcTriggers.lua ["snipe"]: a standalone Snipe (main) resolves no config; a Snipe-triggered main
            // takes the fastest Snipe in its slot as the source (its cached HitSpeed/HitTime).
            if main.ge.name.as_deref() == Some("Snipe") { return None; }
            let stages = facts.snipe_stages;
            let same_slot = |sk: &Skill| sk.socket_group.as_ref().and_then(|g| g.slot.as_deref()) == main.socket_group.as_ref().and_then(|g| g.slot.as_deref());
            let idx = skills.iter().filter(|sk| flag(&sk.skill_data, "triggeredBySnipe") && sk.socket_group.is_some() && same_slot(sk)).position(|sk| std::ptr::eq(sk, main));
            // Not enough stages to trigger this skill (the handler's else branch; also when the skill is not one of the Snipe-triggered).
            let not_enough = |fx: &mut SetupEffects| {
                fx.info_message2 = Some("DPS reported assuming Self-Cast".into());
                fx.info_message = Some("Not enough Snipe stages to trigger this skill".into());
                fx.info_trigger_empty = true;
            };
            let Some(idx) = idx else { not_enough(fx); return None };
            if (idx as f64 + 1.0) > stages { not_enough(fx); return None; }
            let mut source: Option<usize> = None;
            let mut trig_rate: Option<f64> = None;
            let mut ctt = None;
            for (i, sk) in skills.iter().enumerate() {
                if sk.ge.name.as_deref() == Some("Snipe") && sk.socket_group.is_some() && same_slot(sk) {
                    let uuid = sk.uuid.as_deref().unwrap_or("");
                    let entry = facts.gc.get(uuid);
                    if entry.is_none() { crate::GC_MISSES.with(|m| m.borrow_mut().push(uuid.to_string())); }
                    let cached = entry.and_then(|e| e.hit_speed);
                    if !sk.disabled() && !sk.used_by_mirage() && !sk.has_skill_type(OTHER_THING_USES_SKILL)
                        && ((source.is_none() && cached.is_some()) || cached.map_or(false, |c| c > trig_rate.unwrap_or(0.0))) {
                        trig_rate = cached;
                        ctt = entry.and_then(|e| e.hit_time);
                        source = Some(i);
                    }
                }
            }
            fx.channel_time = ctt;
            fx.snipe_mods = true;
            cfg.trig_rate = trig_rate;
            cfg.source_idx = source;
        }
        "avenging flame" => {
            cfg.trigger_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_flags, "totem") && slot_match(m, sk)));
            cfg.comparer = Some(ComparerKind::AvengingFlame);
            cfg.ignore_source_rate = true;
        }
        "intuitive link" => {
            // CalcTriggers.lua ["intuitive link"]: the Intuitive Link skill is the source; every other spell in the slot is triggered.
            if main.ge.name.as_deref() == Some("Intuitive Link") { return None; }
            let src = skills.iter().position(|sk| sk.ge.name.as_deref() == Some("Intuitive Link"));
            let src_uuid = src.and_then(|i| skills[i].uuid.clone());
            cfg.triggered_skill_cond = Some(Box::new(move |m, sk| {
                sk.has_skill_type(SPELL) && slot_match(m, sk) && !(src_uuid.is_some() && sk.uuid == src_uuid)
            }));
            cfg.trig_rate = Some(facts.intuitive_link_rate);
            cfg.source_idx = src;
            cfg.source_name = Some("Custom source".into());
            cfg.use_cast_rate = true;
        }
        "svalinn cast on block" | "festering resentment cast on block" => {
            fx.global_trigger = true;
            cfg.source_is_main = true;
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| {
                slot_match(m, sk) && sk.triggered_by.is_some() // calcLib.canGrantedEffectSupportActiveSkill not ported; approximated by presence of triggeredBy
            }));
        }
        "hex on trap" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(TRAPPED)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredByTrapTrigger") && slot_match(m, sk)));
        }
        "supporttriggerfirespellonhit" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(MELEE)));
            cfg.triggered_skill_cond = Some(Box::new(|m, sk| flag(&sk.skill_data, "triggeredBySettlersEnchantTrigger") && slot_match(m, sk)));
        }
        "ghostly artillery" => {
            cfg.source_weapon = true;
            cfg.trigger_on_use = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| sk.has_skill_type(ATTACK)));
        }
        "fieryimpactheistmaceimplicit" => {
            cfg.source_weapon = true;
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        "replica gifts from above" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| !sk.has_skill_type(SUMMONS_TOTEM) && sk.has_skill_type(ATTACK)));
        }
        "bloodshrineuniquetriggeredexplodingtoad" => {
            let chance = main.src_instance.as_ref().and_then(|si| si.trigger_chance).unwrap_or(f64::NAN) + facts.blood_shrine_toad_chance;
            cfg.assuming_every_hit_kills = true;
            cfg.trigger_chance = Some(chance.min(100.0));
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| damage_or_attack(sk)));
        }
        "bursting toad" => {
            // All gems in the socket group return the same interval, even with several Hextoad supports slotted.
            let mut interval = f64::INFINITY;
            for sk in skills {
                if let Some(h) = num(&sk.skill_data, "hextoadTriggerInterval") { interval = interval.min(h); }
            }
            if interval < f64::INFINITY {
                fx.global_trigger = true;
                fx.trigger_rate_cap_override = Some(1.0 / interval);
                if breakdown_on() {
                    fx.preset_tables.push((
                        "TriggerRateCap".into(),
                        J::Array(vec![
                            J::String(pom_offence::sf!("1 / %.2f ^8(Hextoad trigger interval)", interval)),
                            J::String(pom_offence::sf!("= %.2f", 1.0 / interval)),
                        ]),
                    ));
                }
                cfg.source_is_main = true;
            } else {
                return None;
            }
        }
        "triggeredmoltenstrike" => {
            cfg.trigger_skill_cond = Some(Box::new(|_m, sk| melee_or_attack(sk)));
        }
        _ => return None,
    }
    Some(cfg)
}

fn slot_group_eq_opt(a: &Option<SocketGroupInfo>, b: &Option<SocketGroupInfo>) -> bool {
    a.as_ref().and_then(|x| x.slot.as_deref()) == b.as_ref().and_then(|x| x.slot.as_deref())
}


/// Every string key `configTable` defines in upstream (CalcTriggers.lua lines 902-1581),
/// lowercase, for classifying which config a build's main skill would resolve to without
/// needing to actually run `resolve_config`'s side effects.
const ALL_CONFIG_KEYS: &[&str] = &[
    "law of the wilds", "the rippling thoughts", "the surging thoughts", "the hidden blade",
    "replica eternity shroud", "shroud of the lightless", "limbsplit", "the cauteriser",
    "duskblight", "lioneye's paws", "replica lioneye's paws", "moonbender's wing",
    "ngamahu's flame", "cameria's avarice", "starcaller", "uul-netol's embrace",
    "rigwald's crest", "jorrhast's blacksteel", "ashcaller", "arakaali's fang", "sporeguard",
    "mark of the elder", "mark of the shaper", "poet's pen", "maloney's mechanism",
    "asenath's chant", "vixen's entrapment", "flames of judgement", "storm of judgement", "trigger craft", "kitava's thirst",
    "foulborn kitava's thirst", "mjolner", "wing of the wyvern", "cospri's malice",
    "seven teachings", "squirming terror", "kinetic flux", "cast on critical strike", "nova",
    "cast when damage taken", "cast when stunned", "cast on ward break", "cast on melee kill", "spellslinger",
    "call to arms", "automation", "autoexertion", "seize the flesh", "fissure", "mark on hit",
    "hextouch", "oskarm", "tempest shield", "shattershard", "battlemage's cry",
    "arcanist brand", "cast on death", "combust", "prismatic burst", "voidstorm", "shockwave",
    "void shockwave", "falling crystal", "call the pyre", "manaforged arrows", "doom blast",
    "cast while channelling", "focus", "snipe", "avenging flame", "intuitive link",
    "svalinn cast on block", "festering resentment cast on block", "hex on trap",
    "supporttriggerfirespellonhit", "ghostly artillery", "replica gifts from above",
    "bloodshrineuniquetriggeredexplodingtoad", "bursting toad", "triggeredmoltenstrike",
    "fieryimpactheistmaceimplicit",
];

/// True when `key` is a `configTable` key of upstream.
pub fn is_config_key(key: &str) -> bool { ALL_CONFIG_KEYS.contains(&key) }

/// Keys resolvable in `configTable` for which this crate's `resolve_config` returns `None`
/// because a required recorded fact (a ModStore query, a condition flag, or a nested-calc
/// result) is not yet captured by the recorder - not because upstream has no config there.
const NOT_YET_PORTED_KEYS: &[&str] = &[
    "the hidden blade", "maloney's mechanism", "asenath's chant", "trigger craft",
    "squirming terror", "cast on melee kill",
    "nova", "shattershard", "doom blast", "snipe",
    "bloodshrineuniquetriggeredexplodingtoad", "bursting toad", "cast while channelling", "focus",
];

/// The same key-precedence order `calcs.triggers` uses (CalcTriggers.lua lines 1606-1616):
/// granted-effect id, skill name, the skill that triggers this one, that name with an "awakened
/// " prefix stripped, then the unique item that grants this skill.
pub fn candidate_keys(main: &Skill) -> Vec<String> {
    let mut keys = Vec::new();
    if let Some(id) = &main.ge.id { keys.push(id.to_lowercase()); }
    if main.ge.name.is_some() { keys.push(main.name_lower()); }
    if let Some(tb) = &main.triggered_by {
        if let Some(name) = &tb.name {
            let lower = name.to_lowercase();
            if let Some(stripped) = lower.strip_prefix("awakened ") {
                keys.push(lower.clone());
                keys.push(stripped.to_string());
            } else {
                keys.push(lower);
            }
        }
    }
    if is_triggered(main) {
        if let Some(u) = get_unique_item_trigger_name(main) { keys.push(u.to_lowercase()); }
    }
    keys
}

/// True when this build's main skill either resolves to no config at all (a case this crate
/// grades as "no trigger found", matching upstream) or to a config key this crate has
/// actually ported. False only for the keys in `NOT_YET_PORTED_KEYS`.
pub fn resolve_config_key_supported(main: &Skill) -> bool {
    for k in candidate_keys(main) {
        if ALL_CONFIG_KEYS.contains(&k.as_str()) {
            return !NOT_YET_PORTED_KEYS.contains(&k.as_str());
        }
    }
    true
}
