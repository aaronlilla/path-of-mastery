//! Shared trigger-rate math: `isTriggered`/`findTriggerSkill`/`calcMultiSpellRotationImpact`/
//! `defaultTriggerHandler`/`CWCHandler`/`helmetFocusHandler` (CalcTriggers.lua). The Calcs tab's breakdown tables
//! (`TriggerRateCap`, `EffectiveSourceRate`, `SkillTriggerRate`, `SimData`, `AddedCastTime`) are written into
//! `TriggerResult::tables` while the Calcs mode asks for them (`set_breakdown`).

use crate::*;
use pom_offence::sf;
use serde_json::Map as JMap;

fn lines(v: Vec<String>) -> J {
    J::Array(v.into_iter().map(J::String).collect())
}

fn bdnum(v: f64) -> J {
    pom_offence::bd::num(v)
}

/// `processAddedCastTime(skill, breakdown)`'s `breakdown.AddedCastTime` lines (CalcTriggers.lua:54-59).
fn added_cast_time_table(skill: &Skill) -> Option<Vec<String>> {
    if !skill.core_calc.flag_adds_cast_time_to_cd {
        return None;
    }
    let base = num(&skill.skill_data, "castTimeOverride").or(skill.ge.cast_time).unwrap_or(1.0);
    let inc = skill.core_calc.inc_speed;
    let more = skill.core_calc.more_speed;
    let adds = base / round2((1.0 + inc / 100.0) * more);
    Some(vec![
        sf!("%.2f ^8(base cast time of %s)", base, skill.name()),
        sf!("%.2f ^8(increased/reduced)", 1.0 + inc / 100.0),
        sf!("%.2f ^8(more/less)", more),
        sf!("= %.2f ^8cast time", adds),
    ])
}

/// `breakdown.SimData` (CalcTriggers.lua:355-377, 847-870): one row per skill of the rotation, named from the skill's
/// `cacheSkillUUID` split on "_" (so a skill with no slot shows "NO" and "SLOT").
fn sim_data_table(skills: &[Skill], main: &Skill, rates: &[SimRateEntry], sim_time: Option<f64>) -> J {
    let col = |label: &str, key: &str| {
        let mut m = JMap::new();
        m.insert("label".into(), J::String(label.into()));
        m.insert("key".into(), J::String(key.into()));
        J::Object(m)
    };
    let mut rows = Vec::new();
    for r in rates {
        let uuid = skills.iter().chain(std::iter::once(main)).find(|s| s.uuid.as_deref() == Some(r.uuid.as_str())).map(|s| s.lua_uuid.as_str()).unwrap_or(r.uuid.as_str());
        let t: Vec<&str> = uuid.split('_').filter(|p| !p.is_empty()).collect();
        let mut row = JMap::new();
        row.insert("rate".into(), bdnum(pom_offence::bd::round(r.rate, 2)));
        for (k, i) in [("skillName", 0usize), ("slotName", 1), ("gemIndex", 2)] {
            if let Some(v) = t.get(i) {
                row.insert(k.into(), J::String((*v).into()));
            }
        }
        rows.push(J::Object(row));
    }
    let mut m = JMap::new();
    if let Some(st) = sim_time {
        m.insert("1".into(), J::String(sf!("Simulation duration: %.2f ^8(In game source skill usage duration in seconds)", st)));
    }
    m.insert("rowList".into(), J::Array(rows));
    m.insert("colList".into(), J::Array(vec![col("Rate", "rate"), col("Skill Name", "skillName"), col("Slot Name", "slotName"), col("Gem Index", "gemIndex")]));
    J::Object(m)
}

/// Port of `defaultComparer` (CalcTriggers.lua:69).
pub fn default_comparer(entry: Option<&GcEntry>, has_source: bool, trigger_rate: Option<f64>) -> bool {
    let cached_speed = entry.and_then(|e| e.cached_speed());
    (!has_source && cached_speed.is_some()) || (cached_speed.is_some() && cached_speed.unwrap() > trigger_rate.unwrap_or(0.0))
}

/// Port of `findTriggerSkill` (CalcTriggers.lua:75). `comparer` mirrors the Lua signature
/// `(entry, had_source, trigger_rate) -> bool`; `calcs.buildActiveSkill` is not invoked here -
/// the recorder snapshots GlobalCache after the whole calcs.triggers/mirages call, so a hit that
/// would have been a cache-miss-then-build in upstream is already present in `gc`.
pub fn find_trigger_skill<'a>(
    gc: &GlobalCache,
    skill: &'a Skill,
    source: Option<&'a Skill>,
    trigger_rate: Option<f64>,
    comparer: impl Fn(Option<&GcEntry>, bool, Option<f64>) -> bool,
) -> (Option<&'a Skill>, Option<f64>) {
    let uuid = skill.uuid.as_deref().unwrap_or("");
    let entry = gc.get(uuid);
    if entry.is_none() { GC_MISSES.with(|m| m.borrow_mut().push(uuid.to_string())); }
    if entry.is_some()
        && comparer(entry, source.is_some(), trigger_rate)
        && !skill.disabled()
        && !skill.used_by_mirage()
        && !skill.has_skill_type(OTHER_THING_USES_SKILL)
    {
        (Some(skill), entry.and_then(|e| e.cached_speed()))
    } else {
        (source, trigger_rate)
    }
}

#[derive(Debug, Clone)]
pub struct SimSkill {
    pub uuid: String,
    pub cd: f64,
    pub cd_override: Option<f64>,
    pub adds_cast_time: Option<f64>,
    pub icdr: f64,
    pub added_cooldown: f64,
}

/// Port of `packageSkillDataForSimulation` (CalcTriggers.lua:65), minus `processAddedCastTime`'s
/// breakdown text (numeric-only; see `process_added_cast_time`).
pub fn package_skill_for_sim(skill: &Skill) -> SimSkill {
    SimSkill {
        uuid: skill.uuid.clone().unwrap_or_default(),
        cd: num_or(&skill.skill_data, "cooldown", 0.0),
        cd_override: skill.core_calc.cooldown_override,
        adds_cast_time: process_added_cast_time(skill),
        icdr: skill.core_calc.icdr,
        added_cooldown: skill.core_calc.added_cooldown_base,
    }
}

/// Port of `processAddedCastTime` (CalcTriggers.lua:45), numeric result only.
pub fn process_added_cast_time(skill: &Skill) -> Option<f64> {
    if !skill.core_calc.flag_adds_cast_time_to_cd { return None; }
    let base_cast_time = num(&skill.skill_data, "castTimeOverride").or(skill.ge.cast_time).unwrap_or(1.0);
    let inc = skill.core_calc.inc_speed;
    let more = skill.core_calc.more_speed;
    let csi = round2((1.0 + inc / 100.0) * more);
    Some(base_cast_time / csi)
}
fn round2(v: f64) -> f64 { (v * 100.0 + 0.5).floor() / 100.0 }

#[derive(Debug, Clone, Default)]
pub struct SimRateEntry { pub uuid: String, pub rate: f64 }

/// Port of `calcMultiSpellRotationImpact` (CalcTriggers.lua:91). `main_uuid` is the uuid whose
/// rate should be returned as `mainRate` (the actor's mainSkill in upstream).
pub fn calc_multi_spell_rotation_impact(
    skill_rotation: &[SimSkill],
    source_rate: f64,
    trigger_cd: f64,
    chance: Option<f64>,
    main_uuid: &str,
) -> (f64, Vec<SimRateEntry>) {
    let chance = chance.unwrap_or(100.0);
    if pom_engine::env::var("POM_DEBUG_TRIG").is_ok() { eprintln!("ROT sr={source_rate} cd={trigger_cd} ch={chance} rot={:?}", skill_rotation); }
    let skill_count = skill_rotation.len();
    if skill_count == 0 || source_rate == 0.0 { return (0.0, Vec::new()); }
    let trigger_increment = 1.0 / source_rate;
    let sim_time = trigger_increment * 1000.0;

    let mut cd = vec![0.0; skill_count];
    let mut next_trig = vec![0.0; skill_count];
    let mut count = vec![0u64; skill_count];
    for (i, sk) in skill_rotation.iter().enumerate() {
        let base = sk.cd_override.unwrap_or(((sk.cd) + sk.added_cooldown) / if sk.icdr != 0.0 { sk.icdr } else { 1.0 });
        let alt = (trigger_cd + sk.adds_cast_time.unwrap_or(0.0)) / if sk.icdr != 0.0 { sk.icdr } else { 1.0 };
        cd[i] = base.max(alt);
    }

    let mut rotation_index = 0usize; // 0-based; Lua is 1-based
    let mut next_trigger = 0.0;
    while next_trigger < sim_time {
        let mut current_index = rotation_index;
        loop {
            if next_trig[current_index] <= next_trigger {
                count[current_index] += 1;
                next_trig[current_index] = ceil_b(floor_b(next_trigger, SERVER_TICK_TIME) + cd[current_index], SERVER_TICK_TIME);
                break;
            }
            current_index = (current_index + 1) % skill_count;
            if current_index == rotation_index { break; }
        }
        rotation_index = (rotation_index + 1) % skill_count;
        next_trigger += trigger_increment;
    }

    let mut rates = Vec::with_capacity(skill_count);
    let mut main_rate = 0.0;
    for (i, sk) in skill_rotation.iter().enumerate() {
        let rate = 1.0 / (sim_time / (count[i] as f64) + (trigger_increment / chance * 100.0) - trigger_increment);
        rates.push(SimRateEntry { uuid: sk.uuid.clone(), rate });
        if sk.uuid == main_uuid { main_rate = rate; }
    }
    (main_rate, rates)
}

/// A resolved `configTable[...]()` result (CalcTriggers.lua configTable entries). All fields
/// default to the Lua "nil"/false equivalent. `custom_handler` selects CWCHandler/helmetFocus
/// over `defaultTriggerHandler`.
type SkillPred = Box<dyn Fn(&Skill, &Skill) -> bool>;

#[derive(Default)]
pub struct Config {
    pub trigger_skill_cond: Option<SkillPred>,
    pub triggered_skill_cond: Option<SkillPred>,
    pub trigger_name: Option<String>,
    pub trigger_chance: Option<f64>,
    pub trig_rate: Option<f64>,
    pub source_idx: Option<usize>,
    /// "automation"/"autoexertion"/"call to arms", when the main skill isn't the triggering gem
    /// itself: upstream reassigns `actor.mainSkill.triggeredBy.grantedEffect` to the matching
    /// active skill instance found by name in activeSkillList (its generic support-gem
    /// triggeredBy target carries no level cooldown), so the trigger cooldown that later math uses
    /// comes from that instance's own level, not `main.triggeredBy.levelCooldown` as recorded.
    pub trigger_cd_override: Option<f64>,
    /// `source = env.player.mainSkill` (or `actor.mainSkill`) in the Lua config - resolved
    /// against `main` directly rather than an index into the shared skills slice.
    pub source_is_main: bool,
    pub actor_is_minion: bool,
    pub sequence_source_name: Option<String>,
    pub use_cast_rate: bool,
    pub trigger_on_use: bool,
    pub source_weapon: bool,
    pub allow_triggered: bool,
    pub ignore_source_rate: bool,
    pub assuming_every_hit_kills: bool,
    pub overlaps: Option<f64>,
    pub stages_are_overlaps: Option<f64>,
    pub custom_trigger_name: Option<String>,
    /// `config.sourceName` ("Custom source" for Intuitive Link): the name the EffectiveSourceRate table gives the source.
    pub source_name: Option<String>,
    /// `skillData.sourceRateIsFinal` as the configTable step set it: no "= x (Effective source rate)" line.
    pub source_rate_is_final: bool,
    pub custom_handler: Option<CustomHandler>,
    pub comparer: Option<ComparerKind>,
    /// Doom Blast in "vixen" mode: Vixen's Entrapment's base cooldown (`Some`).
    pub vixen_base_cooldown: Option<f64>,
    /// Arcanist Brand (`triggeredBy.mainSkill` = the brand): `repeatFrequency / activationFreqMore / activationFreqInc`.
    pub brand_trigger_cd: Option<f64>,
    /// `triggeredBy.attachedBrandCount` of an Arcanist Brand trigger.
    pub brand_attached_count: f64,
    /// `triggeredBy.ignoresTickRate = true` (set by the Arcanist Brand config).
    pub trigger_ignores_tick_rate: bool,
    /// `env.player.itemList["Gloves"]` is not Vixen's Entrapment (drives `VixenModeNoVixenGlovesWarn`).
    pub vixen_no_gloves: bool,
    /// `env.build.configTab.input["doomBlastSource"]` ("expiration" and "hexblast" change the source rate of Doom Blast).
    pub doom_blast_source: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CustomHandler { Cwc, Focus }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComparerKind { Default, Kitava, FoulbornKitava, BattlemageUptime, InfernalUptime, AvengingFlame }

/// The result `calcs.triggers` writes onto the actor's `mainSkill`/`output` (the fields this
/// crate grades). Breakdown text is not produced.
#[derive(Debug, Clone, Default)]
pub struct TriggerResult {
    pub trigger_rate_cap: Option<f64>,
    pub skill_trigger_rate: Option<f64>,
    pub effective_source_rate: Option<f64>,
    pub channel_time_to_trigger: Option<f64>,
    pub cwdt_threshold: Option<f64>,
    pub speed: Option<f64>,
    pub triggered: Option<bool>,
    pub global_trigger: Option<bool>,
    pub has_override: Option<bool>,
    pub has_seals: Option<bool>,
    pub skip_effective_rate: Option<bool>,
    pub trigger_rate_cap_override: Option<f64>,
    pub no_trigger_found: bool,
    /// uuid of the chosen trigger source skill (live callers only).
    pub source_uuid: Option<String>,
    /// `output.addsCastTime` (only when the skill adds its cast time to the trigger cooldown).
    pub adds_cast_time: Option<f64>,
    /// `mainSkill.skillFlags.addsCastTime`: `processAddedCastTime` ran on the main skill itself (it is packaged as a triggered skill).
    pub main_adds_cast_time_flag: bool,
    /// `mainSkill.infoTrigger` (the trigger's display name), set by `calcs.triggers` for the default handler.
    pub info_trigger: Option<String>,
    /// `mainSkill.infoMessage` / `infoMessage2`: the sidebar's message lines under the skill.
    pub info_message: Option<String>,
    pub info_message2: Option<String>,
    /// `output.VixensTooMuchCastSpeedWarn` (Doom Blast in vixen mode).
    pub vixens_too_much_cast_speed_warn: Option<bool>,
    pub vixen_mode_no_vixen_gloves_warn: Option<bool>,
    /// `mainSkill.skillData.cooldown` as rewritten by the configTable step.
    pub skill_data_cooldown: Option<f64>,
    /// Snipe: add the per-stage Damage MORE mods to the main skill.
    pub snipe_mods: bool,
    /// `mainSkill.skillFlags.disable` / `disableReason` written by the configTable step (The Hidden Blade without Phasing).
    pub disable_reason: Option<String>,
    /// Doom Blast set the `UsesCurseOverlaps` flag (it only shows the Config tab's "Curse overlaps" option).
    pub uses_curse_overlaps: bool,
    /// The `actor.breakdown` tables the handler wrote, in the order it wrote them (only while `set_breakdown(true)`).
    pub tables: Vec<(String, J)>,
}

fn resolve_comparer<'a>(kind: Option<ComparerKind>, kitava_life_or_mana_req: f64) -> impl Fn(Option<&GcEntry>, bool, Option<f64>) -> bool + 'a {
    move |entry, had_source, rate| match kind {
        None | Some(ComparerKind::Default) => default_comparer(entry, had_source, rate),
        Some(ComparerKind::Kitava) => {
            default_comparer(entry, had_source, rate) && entry.and_then(|e| e.mana_cost).unwrap_or(0.0) >= kitava_life_or_mana_req
        }
        Some(ComparerKind::FoulbornKitava) => {
            default_comparer(entry, had_source, rate) && entry.and_then(|e| e.life_cost).unwrap_or(0.0) >= kitava_life_or_mana_req
        }
        Some(ComparerKind::BattlemageUptime) => {
            default_comparer(entry, had_source, rate) && entry.and_then(|e| e.battlemage_up_time_ratio).is_some()
        }
        Some(ComparerKind::InfernalUptime) => {
            default_comparer(entry, had_source, rate) && entry.and_then(|e| e.infernal_up_time_ratio).is_some()
        }
        Some(ComparerKind::AvengingFlame) => {
            let totem_life = entry.and_then(|e| e.totem_life);
            (!had_source && totem_life.is_some()) || (totem_life.is_some() && totem_life.unwrap() > rate.unwrap_or(0.0))
        }
    }
}

/// Extra numeric corrections that `defaultTriggerHandler` applies to `trigRate` before the main
/// cooldown math (CalcTriggers.lua lines 456-561): Unleash, multi-projectile hits, the
/// ManaSpent/Manaforged thresholds, and the Battlemage's/Infernal Cry uptime caps. Not yet
/// ported. Each one is a no-op below, so builds
/// that rely on these specific mechanics get the uncorrected base rate: a bounded, visible gap
/// rather than a silently wrong number folded into the core math.
pub struct TriggerRateCorrectionInputs<'a> {
    pub source: Option<&'a Skill>,
    pub source_entry: Option<&'a GcEntry>,
    pub main: &'a Skill,
}

/// Port of `defaultTriggerHandler` (CalcTriggers.lua lines 394-900), numeric fields only (no
/// breakdown text). `main` is `actor.mainSkill` (the caller resolves player vs. minion).
/// `global_trigger_before` mirrors whatever a configTable setup step already wrote to
/// `actor.mainSkill.skillFlags.globalTrigger` before calling this handler.
pub fn default_trigger_handler(
    skills: &[Skill],
    main: &Skill,
    gc: &GlobalCache,
    cfg: &Config,
    global_trigger_before: bool,
    weapon1_present: bool,
    weapon2_present: bool,
    have_trigger_bots: bool,
    kitava_req: f64,
    // configTable setup steps mutate `env.player.mainSkill.skillData.ignoresTickRate`/
    // `skillFlags.skipEffectiveRate` directly, ahead of calling defaultTriggerHandler in the same
    // call (e.g. "automation"/"autoexertion"/"call to arms"); the recorded skillData snapshot
    // predates that mutation, so these carry the configTable step's own writes.
    ignores_tick_rate_cfg: bool,
    skip_effective_rate_cfg: bool,
    // `actor.breakdown` tables a configTable step wrote before this handler ran.
    preset_tables: &[(String, J)],
) -> TriggerResult {
    let mut source: Option<&Skill> = if cfg.source_is_main { Some(main) } else { cfg.source_idx.map(|i| &skills[i]) };
    let mut trig_rate = cfg.trig_rate;
    let mut triggered_skills: Vec<SimSkill> = Vec::new();
    // `processAddedCastTime` sets `skillFlags.addsCastTime` on every skill it packages: here possibly the main skill.
    let mut main_packaged = false;
    let mut global_trigger = global_trigger_before;
    // `uuid` in upstream: only ever assigned by the `findTriggerSkill` scan (never from `config.source`).
    let mut scan_uuid: Option<String> = None;

    if cfg.trigger_skill_cond.is_some() || cfg.triggered_skill_cond.is_some() {
        let comparer = resolve_comparer(cfg.comparer, kitava_req);
        for skill in skills {
            // The `skill ~= actor.mainSkill` exclusion (CalcTriggers.lua:409) applies only to the
            // triggerSkillCond scan; triggeredSkillCond has no such exclusion, so the main skill
            // itself can be its own "triggered skill" (e.g. Manabond triggered by Mjolner, where
            // Manabond is both the actor's mainSkill and the skill flagged triggeredByMjolner).
            if let Some(cond) = &cfg.trigger_skill_cond {
                if !std::ptr::eq(skill, main) {
                    let source_weapon_ok = if cfg.source_weapon {
                        let slot = main.socket_group.as_ref().and_then(|s| s.slot.as_deref()).unwrap_or("");
                        let flagname = if slot.starts_with("Weapon 2") { "weapon2Attack" } else { "weapon1Attack" };
                        flag(&skill.skill_flags, flagname)
                    } else { true };
                    if cond(main, skill) && source_weapon_ok && (!is_triggered(skill) || global_trigger || cfg.allow_triggered) {
                        let (s2, r2) = find_trigger_skill(gc, skill, source, trig_rate, &comparer);
                        source = s2;
                        trig_rate = r2;
                        scan_uuid = source.and_then(|s| s.uuid.clone());
                    }
                }
            }
            if let Some(tcond) = &cfg.triggered_skill_cond {
                if tcond(main, skill) {
                    main_packaged |= std::ptr::eq(skill, main);
                    triggered_skills.push(package_skill_for_sim(skill));
                }
            }
        }
    }

    let mut result = TriggerResult::default();
    result.tables.extend(preset_tables.iter().cloned());
    let preset_trc = preset_tables.iter().any(|(k, _)| k == "TriggerRateCap");
    // The setup step wrote this skill flag before the handler ran (CalcTriggers.lua:1207-1255), whatever the handler finds.
    if skip_effective_rate_cfg {
        result.skip_effective_rate = Some(true);
    }
    result.main_adds_cast_time_flag = main_packaged && process_added_cast_time(main).is_some();
    let have_triggered_skills = !triggered_skills.is_empty();
    if have_triggered_skills || cfg.triggered_skill_cond.is_none() {
        if source.is_none() && !(global_trigger && cfg.triggered_skill_cond.is_some()) {
            result.triggered = Some(false); // skillData.triggered = nil ("no trigger found")
            result.info_trigger = Some(String::new());
            result.info_message2 = Some("DPS reported assuming Self-Cast".to_string());
            result.info_message = Some(format!("No {} Triggering Skill Found", cfg.trigger_name.as_deref().unwrap_or("")));
            result.no_trigger_found = true;
            return result;
        }
        result.triggered = Some(true);
        result.source_uuid = source.and_then(|s| s.uuid.clone());

        // The tables the Calcs tab shows (`breakdown` exists only in the Calcs mode).
        let bd = breakdown_on();
        let mut esr: Option<Vec<String>> = None; // breakdown.EffectiveSourceRate
        let mut trc: Option<Vec<String>> = None; // breakdown.TriggerRateCap
        let mut srt: Option<Vec<String>> = None; // breakdown.SkillTriggerRate
        let mut sim: Option<J> = None; // breakdown.SimData
        let mut added: Option<Vec<String>> = None; // breakdown.AddedCastTime
        if bd && flag(&main.skill_data, "triggeredByBrand") {
            // Arcanist Brand: its activation frequency stands in for an attack rate (CalcTriggers.lua:428-435).
            if let Some(brand) = source {
                esr = Some(vec![
                    sf!("%.2f ^8(base activation cooldown of %s)", num_or(&brand.skill_data, "repeatFrequency", 0.0), cfg.trigger_name.as_deref().unwrap_or("")),
                    sf!("* %.2f ^8(more activation frequency)", brand.brand_activation_freq_more),
                    sf!("* %.2f ^8(increased activation frequency)", brand.brand_activation_freq_inc),
                    sf!("* %d ^8(attached Brands)", num_or(&brand.skill_data, "attachedBrandCount", 0.0)),
                    sf!("= %.2f ^8(activation rate of %s)", trig_rate.unwrap_or(0.0), brand.name()),
                ]);
            }
        } else if bd {
            let mut v = Vec::new();
            if let (Some(tr), Some(src)) = (trig_rate, source) {
                if cfg.assuming_every_hit_kills {
                    v.push("Assuming every attack kills".to_string());
                }
                v.push(sf!("%.2f ^8(%s %s)", tr, cfg.source_name.as_deref().unwrap_or_else(|| src.name()), if cfg.use_cast_rate { "cast rate" } else { "attack rate" }));
            }
            esr = Some(v);
        }

        // Dual wield: a source that hits with both weapons at once triggers at half rate.
        let source_weapon_trigger = cfg.source_weapon && source.map(|s| flag(&s.skill_flags, "bothWeaponAttack")).unwrap_or(false);
        let item_support_trigger = main.triggered_by.as_ref().map(|tb| tb.support && tb.from_item).unwrap_or(false);
        if let (Some(tr), Some(src)) = (trig_rate, source) {
            if weapon1_present && weapon2_present && !flag(&src.skill_data, "doubleHitsWhenDualWielding")
                && (src.has_skill_type(MELEE) || src.has_skill_type(ATTACK))
                && (source_weapon_trigger || item_support_trigger)
            {
                trig_rate = Some(tr / 2.0);
                if let Some(v) = esr.as_mut() {
                    v.insert(1.min(v.len()), "/ 2 ^8(due to dual wielding)".to_string());
                }
            }
        }

        let mut src_entry = scan_uuid.as_deref().and_then(|u| gc.get(u));

        // Unleash / ManaSpent(Kitava) / Manaforged threshold corrections (CalcTriggers.lua
        // lines 458-467, 478-486) are not yet applied.
        let _ = TriggerRateCorrectionInputs { source, source_entry: src_entry, main };

        // Account for source unleash (CalcTriggers.lua:458-467).
        let mut unleash_ignores_tick_rate = false;
        if let (Some(src), Some(entry), Some(tr)) = (source, src_entry, trig_rate) {
            if src.core_calc.flag_has_seals && src.has_skill_type(CAN_RAPID_FIRE) {
                trig_rate = Some(tr * entry.dps_multiplier.unwrap_or(1.0));
                result.has_seals = Some(true);
                unleash_ignores_tick_rate = true;
                if let Some(v) = esr.as_mut() {
                    v.push(sf!("x %.2f ^8(multiplier from Unleash)", entry.dps_multiplier.unwrap_or(1.0)));
                }
            }
        }

        // Skills that can hit multiple times per use (CalcTriggers.lua:469-476): a source whose
        // chosen skill part is the "hits with all projectiles" variant triggers once per
        // projectile, not once per use.
        if let (Some(src), Some(entry), Some(tr)) = (source, src_entry, trig_rate) {
            let part_name = src.skill_part_name.as_deref().unwrap_or("");
            if let Some(all_idx) = part_name.find("All") {
                if part_name[all_idx..].contains("Projectiles") && flag(&src.skill_flags, "projectile") {
                    trig_rate = Some(tr * entry.projectile_count.unwrap_or(1.0));
                    if let Some(v) = esr.as_mut() {
                        v.push(sf!("x %.2f ^8(%d projectiles hit)", entry.projectile_count.unwrap_or(1.0), entry.projectile_count.unwrap_or(1.0)));
                    }
                }
            }
        }

        // Special handling for Kitava's Thirst (CalcTriggers.lua:478-486): repeated hits do not consume mana, so they do not trigger it.
        if let (Some(src), Some(tr)) = (source, trig_rate) {
            if flag(&main.skill_data, "triggeredByManaSpent") {
                let repeats = 1.0 + src.core_calc.sum_repeat_count_base;
                trig_rate = Some(tr / repeats);
                if repeats > 1.0 {
                    if let Some(v) = esr.as_mut() {
                        v.push(sf!("/%d ^8(repeated attacks/casts do not count as they don't use mana)", repeats));
                    }
                }
            }
        }

        // Battlemage's Cry / Infernal Cry uptime capping (CalcTriggers.lua:488-524): the number
        // of exerted hits during the cry's duration is capped by its exert count, then converted
        // back to a rate over (cast time + cooldown).
        if let (Some(src), Some(entry), Some(tr)) = (source, src_entry, trig_rate) {
            if flag(&main.skill_data, "triggeredByBattleMageCry") && src.has_skill_type(MELEE) {
                if let (Some(exerts), Some(duration), Some(cast_time), Some(cooldown)) =
                    (entry.battle_cry_exerts_count, entry.battle_mage_cry_duration, entry.battle_mage_cry_cast_time, entry.battle_mage_cry_cooldown)
                {
                    let duration = ceil_b(duration, SERVER_TICK_TIME);
                    let cooldown = ceil_b(cooldown, SERVER_TICK_TIME);
                    let hits = (tr * duration).min(exerts).max(0.0);
                    if let Some(v) = esr.as_mut() {
                        v.push(sf!("^8(min(%.2f * %.2f, %d) = %.2f average number of exerted attacks capped by exerted count)", tr, duration, exerts, hits));
                        v.push(sf!("= %.2f / (%.2f + %.2f) ^8(the calculated number of exerted attacks happens every cooldown + duration)", hits, cast_time, cooldown));
                    }
                    trig_rate = Some(hits / (cast_time + cooldown));
                }
            }
        }
        if let (Some(src), Some(entry), Some(tr)) = (source, src_entry, trig_rate) {
            if main.name() == "Combust" && src.has_skill_type(MELEE) {
                if let (Some(exerts), Some(duration), Some(cast_time), Some(cooldown)) =
                    (entry.infernal_exerts_count, entry.infernal_cry_duration, entry.infernal_cry_cast_time, entry.infernal_cry_cooldown)
                {
                    let duration = ceil_b(duration, SERVER_TICK_TIME);
                    let cooldown = ceil_b(cooldown, SERVER_TICK_TIME);
                    let hits = (tr * duration).min(exerts).max(0.0);
                    if let Some(v) = esr.as_mut() {
                        v.push(sf!("^8(min(%.2f * %.2f, %d) = %.2f average number of exerted attacks capped by exerted count)", tr, duration, exerts, hits));
                        v.push(sf!("= %.2f / (%.2f + %.2f) ^8(the calculated number of exerted attacks happens every cooldown + duration)", hits, cast_time, cooldown));
                    }
                    trig_rate = Some(hits / (cast_time + cooldown));
                }
            }
        }

        // Manaforged Arrows Support (CalcTriggers.lua:526-561): the triggered skill only fires
        // once enough mana has been spent by the trigger source, expressed as a ceil'd number of
        // source-skill usages dividing the rate down.
        if let Some(tr) = trig_rate {
            if flag(&main.skill_data, "triggeredByManaforged") && tr > 0.0 {
                let triggered_mana_cost = main.uuid.as_deref().and_then(|u| { let e = gc.get(u); if e.is_none() { GC_MISSES.with(|m| m.borrow_mut().push(u.to_string())); } e }).and_then(|e| e.mana_cost_raw).unwrap_or(0.0);
                // Upstream reads `GlobalCache.cachedData[CALCULATOR][uuid].Env.player.output.ManaCostRaw`; a Mirage Archer
                // run of this very skill (calculateMirage, mode CALCULATOR, HasNoCost) overwrote that entry: no ManaCostRaw.
                let triggered_mana_cost = if SELF_CACHE_STALE.with(|c| c.get()) { 0.0 } else { triggered_mana_cost };
                if triggered_mana_cost > 0.0 {
                    let threshold_mult = num_or(&main.skill_data, "ManaForgedArrowsPercentThreshold", 0.0);
                    let mana_spent_threshold = triggered_mana_cost * threshold_mult;
                    let source_mana_cost = src_entry.and_then(|e| e.mana_cost_raw).unwrap_or(0.0);
                    if pom_engine::env::var("POM_DEBUG_TRIG").is_ok() { eprintln!("MF tr={tr} trigCost={triggered_mana_cost} thr={threshold_mult} srcCost={source_mana_cost}"); }
                    if source_mana_cost > 0.0 {
                        if let Some(v) = esr.as_mut() {
                            let first = v.first().cloned().unwrap_or_default();
                            *v = vec![
                                sf!("%.4f ^8(Mana cost of trigger source)", source_mana_cost),
                                String::new(),
                                sf!("%.4f ^8(Mana Cost of triggered)", triggered_mana_cost),
                                sf!("%.2f ^8(Manaforged threshold multiplier)", threshold_mult),
                                sf!("= %.4f ^8(Manaforged trigger threshold)", mana_spent_threshold),
                                String::new(),
                                sf!("%.4f ^8(Manaforged trigger threshold)", mana_spent_threshold),
                                sf!("/ %.4f ^8(Mana cost of trigger source)", source_mana_cost),
                                sf!("= %.2f ^8(Skill usages required)", mana_spent_threshold / source_mana_cost),
                                String::new(),
                                first,
                                sf!("/ ceil(%.2f) ^8(%d Skill usages required)", mana_spent_threshold / source_mana_cost, (mana_spent_threshold / source_mana_cost).ceil()),
                            ];
                        }
                    } else if let Some(v) = esr.as_mut() {
                        // `s_format("Source skill has no mana cost", output.EffectiveSourceRate)`: no placeholder, the argument is ignored
                        v.push("Source skill has no mana cost".to_string());
                    }
                    trig_rate = Some(if source_mana_cost > 0.0 { tr / (mana_spent_threshold / source_mana_cost).ceil() } else { 0.0 });
                }
            }
        }

        let icdr = main.core_calc.icdr;
        let added_cooldown = if main.core_calc.added_cooldown_base != 0.0 { Some(main.core_calc.added_cooldown_base) } else { None };
        let cooldown_override = main.core_calc.cooldown_override;
        let mut trigger_cd = cfg.trigger_cd_override.or_else(|| main.triggered_by.as_ref().and_then(|tb| tb.level_cooldown));
        if trigger_cd.is_none() {
            trigger_cd = source.and_then(|s| s.triggered_by.as_ref()).and_then(|tb| tb.level_cooldown);
        }
        if flag(&main.skill_data, "triggeredByBrand") {
            if let Some(bcd) = cfg.brand_trigger_cd {
                // cancels out the division by icdr below: brand activation rate is not affected by icdr
                trigger_cd = Some(bcd * icdr);
            }
        }
        let triggered_cd = num(&main.skill_data, "cooldown");

        let adds_cast_time = process_added_cast_time(main);
        result.adds_cast_time = adds_cast_time;
        if bd {
            added = added_cast_time_table(main);
        }
        let triggered_cd_adjusted = (triggered_cd.unwrap_or(0.0) + added_cooldown.unwrap_or(0.0)) / icdr;
        let trigger_cd_adjusted = (trigger_cd.unwrap_or(0.0) + adds_cast_time.unwrap_or(0.0)) / icdr;
        let ignores_tick_rate_main = flag(&main.skill_data, "ignoresTickRate")
            || ignores_tick_rate_cfg
            || unleash_ignores_tick_rate
            || num(&main.skill_data, "storedUses").map(|n| n > 1.0).unwrap_or(false);
        let triggered_cd_tick_rounded = if ignores_tick_rate_main { triggered_cd_adjusted } else { ceil_b(triggered_cd_adjusted, SERVER_TICK_TIME) };
        // `actor.mainSkill.triggeredBy.ignoresTickRate` (a separate flag from the triggered
        // skill's own) is not tracked in the recording; tick-round unconditionally here, a
        // narrow gap only for the rare skills that set that specific flag.
        let trigger_cd_tick_rounded = if trigger_cd_adjusted == 0.0 || cfg.trigger_ignores_tick_rate { trigger_cd_adjusted } else { ceil_b(trigger_cd_adjusted, SERVER_TICK_TIME) };
        let action_cooldown_tick_rounded = if let Some(co) = cooldown_override {
            ceil_b(co, SERVER_TICK_TIME)
        } else {
            triggered_cd_tick_rounded.max(trigger_cd_tick_rounded)
        };

        result.trigger_rate_cap = Some(if action_cooldown_tick_rounded != 0.0 {
            1.0 / action_cooldown_tick_rounded
        } else if source.map(|s| std::ptr::eq(s, main)).unwrap_or(false) {
            num(&main.skill_data, "triggerRateCapOverride").unwrap_or(f64::INFINITY)
        } else {
            f64::INFINITY
        });

        // Doom Blast fed by a curse that expires, or by a Hexblast replacing it (CalcTriggers.lua:592-617).
        if cfg.trigger_name.as_deref() == Some("Doom Blast") && cfg.doom_blast_source.as_deref() == Some("expiration") {
            let duration = src_entry.and_then(|e| e.duration).unwrap_or(f64::NAN);
            let expiration_rate = 1.0 / duration;
            if let Some(v) = esr.as_mut() {
                let line = sf!("1 / %.2f ^8(source curse duration)", duration);
                if v.is_empty() { v.push(line); } else { v[0] = line; }
            }
            let tr = trig_rate.unwrap_or(f64::NAN);
            if expiration_rate > tr {
                // UsesCurseOverlaps (a flag only the Config tab reads)
                result.uses_curse_overlaps = true;
                if let Some(v) = esr.as_mut() {
                    v.insert(1.min(v.len()), sf!("max(%.2f, %.2f) ^8(If a curse expires instantly curse expiration is equivalent to curse replacement)", expiration_rate, tr));
                    v.insert(1.min(v.len()), sf!("%.2f ^8(%s cast rate)", tr, source.map(|s| s.name()).unwrap_or("")));
                }
            } else {
                trig_rate = Some(expiration_rate);
            }
        } else if cfg.trigger_name.as_deref() == Some("Doom Blast") && cfg.doom_blast_source.as_deref() == Some("hexblast") {
            let mut hex_blast: Option<&Skill> = None;
            let mut rate: Option<f64> = None;
            let mut looped = false;
            for skill in skills {
                if skill.name() == "Hexblast" && !is_triggered(skill) && !std::ptr::eq(skill, main) {
                    let (h2, r2) = find_trigger_skill(gc, skill, hex_blast, rate, default_comparer);
                    hex_blast = h2;
                    rate = r2;
                    looped = true;
                }
            }
            // `uuid` is overwritten by the last findTriggerSkill call: the Hexblast found, or nil
            if looped { src_entry = hex_blast.and_then(|h| h.uuid.as_deref()).and_then(|u| gc.get(u)); }
            if hex_blast.is_some() {
                let tr = trig_rate.unwrap_or(f64::NAN);
                let r = rate.unwrap_or(f64::NAN);
                if let Some(v) = esr.as_mut() {
                    let line = sf!("1 / (%.2f + %.2f) ^8(sum of triggered curse and hexblast cast time)", 1.0 / tr, 1.0 / r);
                    if v.is_empty() { v.push(line); } else { v[0] = line; }
                }
                trig_rate = Some(1.0 / (1.0 / tr + 1.0 / r));
            }
        }

        if bd && !preset_trc {
            // `breakdown.TriggerRateCap` (CalcTriggers.lua:621-703)
            let triggered_name = if cfg.actor_is_minion { "Triggered skill" } else { main.name() };
            let trigger_name = cfg.trigger_name.as_deref().unwrap_or("");
            let action_cooldown = cooldown_override.unwrap_or_else(|| (trigger_cd.unwrap_or(0.0) + adds_cast_time.unwrap_or(0.0)).max(triggered_cd.unwrap_or(0.0) + added_cooldown.unwrap_or(0.0)));
            let action_cooldown_adjusted = cooldown_override.unwrap_or_else(|| trigger_cd_adjusted.max(triggered_cd_adjusted));
            let mut t: Vec<String> = Vec::new();
            if let Some(co) = cooldown_override {
                t.push(sf!("%.2f ^8(hard override of cooldown of %s)", co, triggered_name));
            } else if triggered_cd_adjusted == 0.0 {
                t.push(format!("{triggered_name} has no base cooldown or cooldown override"));
            } else {
                match triggered_cd {
                    Some(c) => t.push(sf!("%.2f ^8(base cooldown of triggered skill)", c)),
                    None => t.push(format!("{triggered_name} has no base cooldown or cooldown override")),
                }
                if let Some(ac) = added_cooldown {
                    t.push(sf!("+ %.2f ^8(flat added cooldown)", ac));
                }
                t.push(sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr));
                t.push(sf!("= %.4f ^8(final cooldown of triggered skill)", triggered_cd_adjusted));
            }
            t.push(String::new());
            if !cfg.actor_is_minion {
                if trigger_cd_adjusted == 0.0 {
                    t.push(format!("Trigger rate based on {triggered_name} cooldown"));
                } else {
                    match trigger_cd {
                        Some(c) => t.push(sf!("%.2f ^8(base cooldown of %s)", c, trigger_name)),
                        None => t.push(format!("{trigger_name} has no base cooldown")),
                    }
                    if let Some(a) = adds_cast_time {
                        t.push(sf!("+ %.2f ^8(this skill adds cast time to cooldown when triggered)", a));
                    }
                    t.push(sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr));
                    t.push(sf!("= %.4f ^8(final cooldown of trigger)", trigger_cd_adjusted));
                }
            }
            t.push(String::new());
            if triggered_cd_adjusted != 0.0 && trigger_cd_adjusted != 0.0 {
                t.push(sf!("%.3f ^8(biggest of trigger cooldown and triggered skill cooldown)", action_cooldown_adjusted));
            }
            let display_rounding = (!ignores_tick_rate_main && triggered_cd_adjusted != 0.0) || (main.triggered_by.is_some() && !cfg.trigger_ignores_tick_rate && trigger_cd_adjusted != 0.0);
            if display_rounding {
                t.push(sf!("%.3f ^8(adjusted for server tick rate)", action_cooldown_tick_rounded));
            }
            let extra_increase_needed = |affected: f64| -> Option<f64> {
                if cooldown_override.is_some() {
                    return None;
                }
                let next_breakpoint = action_cooldown_tick_rounded - SERVER_TICK_TIME;
                let time_over = action_cooldown_adjusted - next_breakpoint;
                let already_reduced = action_cooldown - action_cooldown_adjusted;
                if time_over < affected {
                    let div_needed = affected / (affected - time_over - already_reduced);
                    let inc_total = ((div_needed - 1.0) * 100.0).ceil();
                    return Some(inc_total - (icdr - 1.0) * 100.0);
                }
                None
            };
            if let Some(n) = extra_increase_needed(action_cooldown) {
                t.push(sf!("^8(extra ICDR of %d%% would reach next breakpoint)", n));
            }
            if let Some(n) = adds_cast_time.and_then(|a| extra_increase_needed(a)) {
                t.push(sf!("^8(extra ICS  of %d%% would reach next breakpoint)", n));
            }
            t.push(String::new());
            if triggered_cd.is_none() && trigger_cd.is_none() && cooldown_override.is_none() {
                t.push("Assuming cast on every kill/attack/hit".to_string());
            } else {
                t.push("Trigger rate:".to_string());
                t.push(sf!("1 / %.3f", action_cooldown_tick_rounded));
                t.push(sf!("= %.2f ^8per second", result.trigger_rate_cap.unwrap_or(0.0)));
            }
            trc = Some(t);
        }

        let effective_source_rate = if let (Some(vcd), Some(tr), true) = (cfg.vixen_base_cooldown, trig_rate, main.name() == "Doom Blast") {
            // Doom Blast fed by Vixen's Entrapment (CalcTriggers.lua:~700): a one-skill rotation with Vixen's cooldown.
            let vixens_cd = vcd / icdr;
            let rot = vec![SimSkill { uuid: main.uuid.clone().unwrap_or_default(), cd: 0.0, cd_override: None, adds_cast_time: None, icdr, added_cooldown: 0.0 }];
            result.vixens_too_much_cast_speed_warn = Some(vixens_cd > 1.0 / tr);
            if cfg.vixen_no_gloves { result.vixen_mode_no_vixen_gloves_warn = Some(true); }
            let rate = calc_multi_spell_rotation_impact(&rot, tr, vixens_cd, None, main.uuid.as_deref().unwrap_or("")).0;
            if let Some(v) = esr.as_mut() {
                v.push(sf!("%.2f / %.2f = %.2f ^8(Vixen's trigger cooldown)", vixens_cd * icdr, icdr, vixens_cd));
                v.push(sf!("%.2f ^8(Simulated trigger rate of a curse socketed in Vixen's given ^7%.2f ^8CD and ^7%.2f ^8source rate)", rate, vixens_cd, tr));
            }
            rate
        } else if let Some(tr) = trig_rate {
            if !global_trigger && !cfg.ignore_source_rate { tr } else {
                // Lua's `else` branch (CalcTriggers.lua:743) also sets globalTrigger
                global_trigger = true;
                result.trigger_rate_cap.unwrap_or(0.0)
            }
        } else {
            global_trigger = true;
            result.trigger_rate_cap.unwrap_or(0.0)
        };
        result.effective_source_rate = Some(effective_source_rate);
        if !cfg.source_rate_is_final {
            if let Some(v) = esr.as_mut() {
                v.push(sf!("= %.2f ^8(Effective source rate)", effective_source_rate));
            }
        }

        if effective_source_rate != 0.0 && !skip_effective_rate_cfg {
            let mut trigger_chance = 100.0;
            let mut chance_lines: Vec<String> = Vec::new(); // triggerChanceBreakdown
            let mut cfg_trigger_chance = cfg.trigger_chance;
            if let (Some(src), Some(entry)) = (source, src_entry) {
                if (src.has_skill_type(MELEE) || src.has_skill_type(ATTACK)) && !cfg.trigger_on_use {
                    let hit_chance = entry.hit_chance.unwrap_or(0.0);
                    if hit_chance != 100.0 {
                        if weapon1_present && weapon2_present && flag(&src.skill_data, "doubleHitsWhenDualWielding") {
                            let mh = entry.main_hand_hit_chance.unwrap_or(0.0);
                            let oh = entry.off_hand_hit_chance.unwrap_or(0.0);
                            let both = mh * oh / 100.0;
                            let eff = both + mh * (100.0 - oh) / 100.0 + (100.0 - mh) * oh / 100.0;
                            trigger_chance *= eff / 100.0;
                            chance_lines.push(sf!("x %.2f%% ^8(%s effective hit chance for skills that hit with both weapons)", eff, src.name()));
                        } else {
                            trigger_chance *= hit_chance / 100.0;
                            chance_lines.push(sf!("x %.2f%% ^8(%s hit chance)", hit_chance, src.name()));
                        }
                    }
                    if flag(&main.skill_data, "triggerOnCrit") {
                        // config.triggerChance = config.triggerChance or main's own
                        // chanceToTriggerOnCrit or the source's nested-calc mainSkill's (i.e.
                        // main's own skill, recalculated as part of building the source's cache
                        // entry) chanceToTriggerOnCrit (CalcTriggers.lua:760-762).
                        cfg_trigger_chance = cfg_trigger_chance
                            .or_else(|| num(&main.skill_data, "chanceToTriggerOnCrit"))
                            .or(entry.main_skill_chance_to_trigger_on_crit);
                        let crit_chance = entry.crit_chance.unwrap_or(0.0);
                        if crit_chance != 100.0 {
                            if weapon1_present && weapon2_present && flag(&src.skill_data, "doubleHitsWhenDualWielding") {
                                let mh = entry.main_hand_crit_chance.unwrap_or(0.0);
                                let oh = entry.off_hand_crit_chance.unwrap_or(0.0);
                                let both = mh * oh / 100.0;
                                let eff = both + mh * (100.0 - oh) / 100.0 + (100.0 - mh) * oh / 100.0;
                                trigger_chance *= eff / 100.0;
                                chance_lines.push(sf!("x %.2f%% ^8(%s effective crit chance for skills that hit with both weapons)", eff, src.name()));
                            } else {
                                trigger_chance *= crit_chance / 100.0;
                                chance_lines.push(sf!("x %.2f%% ^8(%s crit chance)", crit_chance, src.name()));
                            }
                        }
                    }
                }
            }
            if let Some(tc) = cfg_trigger_chance {
                if tc != 100.0 {
                    trigger_chance *= tc / 100.0;
                    chance_lines.push(sf!("x %.2f%% ^8(chance to trigger)", tc));
                }
            }

            let single_and_matches_main = triggered_skills.len() == 1 && cfg.triggered_skill_cond.is_some()
                && triggered_skills[0].uuid == main.uuid.clone().unwrap_or_default();
            if ignores_tick_rate_main && (cfg.triggered_skill_cond.is_none() || single_and_matches_main) {
                let overlaps = cfg.overlaps.unwrap_or(1.0);
                result.skill_trigger_rate = Some(result.trigger_rate_cap.unwrap_or(0.0).min(effective_source_rate * overlaps));
                if bd {
                    srt = Some(match cfg.overlaps {
                        Some(o) => vec![sf!("min(%.2f, %.2f *  %d) ^8(%d overlaps)", result.trigger_rate_cap.unwrap_or(0.0), effective_source_rate, o, o)],
                        None => vec![sf!("min(%.2f, %.2f)", result.trigger_rate_cap.unwrap_or(0.0), effective_source_rate)],
                    });
                }
            } else if global_trigger && cfg.triggered_skill_cond.is_none() {
                // Triggerbots make every triggered spell trigger twice, global triggers included. Upstream differs here.
                let bots = pom_offence::data::pom_fixes_on() && have_trigger_bots && main.has_skill_type(SPELL);
                result.skill_trigger_rate = Some(if bots { effective_source_rate * 2.0 } else { effective_source_rate });
            } else {
                main_packaged |= cfg.triggered_skill_cond.is_none();
                let rotation = if cfg.triggered_skill_cond.is_some() { triggered_skills } else { vec![package_skill_for_sim(main)] };
                let brand_trig_cd = if flag(&main.skill_data, "triggeredByBrand") { 0.0 } else { trigger_cd.or(triggered_cd).unwrap_or(0.0) };
                let (rate, rates) = calc_multi_spell_rotation_impact(&rotation, effective_source_rate, brand_trig_cd, Some(trigger_chance), main.uuid.as_deref().unwrap_or(""));
                let mut rate = rate;
                let trigger_bots_effective = have_trigger_bots && main.has_skill_type(SPELL);
                if trigger_bots_effective { rate *= 2.0; }
                // `stagesAreOverlaps`'s hits-per-cast multiplier (skillPart-driven) is not
                // tracked in the recording; only the `overlaps` scalar path above is ported.
                result.skill_trigger_rate = Some(rate);
                if bd {
                    let skill_name = source.map(|s| s.name().to_string()).or_else(|| main.triggered_by.as_ref().and_then(|t| t.name.clone())).unwrap_or_else(|| main.name().to_string());
                    let by_brand = flag(&main.skill_data, "triggeredByBrand");
                    let what = if by_brand {
                        sf!("%s activations per second", source.map(|s| s.name()).unwrap_or(""))
                    } else if trig_rate.is_none() {
                        sf!("%s triggers per second", skill_name.as_str())
                    } else {
                        "Effective source rate".to_string()
                    };
                    let mut t = vec![
                        sf!("%.2f ^8(%s)", effective_source_rate, what),
                        sf!("/ %.2f ^8(Estimated impact of skill rotation, cooldown alignment and trigger chance)", (effective_source_rate / rate).max(1.0)),
                        sf!("= %.2f ^8per second", rate),
                    ];
                    if trigger_bots_effective {
                        t.insert(2, "x 2 ^8(Trigger bots effectively cause the skill to trigger twice)".to_string());
                    }
                    if trigger_chance != 100.0 {
                        t.insert(0, String::new());
                        t.insert(0, sf!("= %.2f%% ^8(Effective chance to trigger)", trigger_chance));
                        // each `t_insert(breakdown.SkillTriggerRate, 1, line)` goes to the front, so the lines end up reversed
                        for line in chance_lines.iter() {
                            t.insert(0, line.clone());
                        }
                        t.insert(0, "100% ^8(Base chance)".to_string());
                    }
                    srt = Some(t);
                    sim = Some(sim_data_table(skills, main, &rates, Some(1.0 / effective_source_rate * 1000.0)));
                }
            }
        } else {
            result.skill_trigger_rate = Some(0.0);
            if bd {
                srt = Some(vec!["The trigger needs to be triggered for any skill to be triggered.".to_string()]);
            }
        }
        if bd {
            if let Some(v) = esr {
                result.tables.push(("EffectiveSourceRate".into(), lines(v)));
            }
            if let Some(v) = trc {
                result.tables.push(("TriggerRateCap".into(), lines(v)));
            }
            if let Some(v) = srt {
                result.tables.push(("SkillTriggerRate".into(), lines(v)));
            }
            if let Some(v) = sim {
                result.tables.push(("SimData".into(), v));
            }
            if let Some(v) = added {
                result.tables.push(("AddedCastTime".into(), lines(v)));
            }
        }

        result.speed = result.skill_trigger_rate;
        // `actor.mainSkill.infoMessage` (CalcTriggers.lua:887-895).
        {
            let trigger_name = cfg.trigger_name.as_deref().unwrap_or("");
            let mut msg = match source.filter(|s| !std::ptr::eq(*s, main)) {
                Some(src) => {
                    let triggered_name = if cfg.actor_is_minion { "Triggered skill" } else { main.name() };
                    let prefix = match &cfg.custom_trigger_name {
                        Some(c) => c.clone(),
                        None => format!("{}{}", if trigger_name != src.name() { trigger_name } else { triggered_name }, if cfg.actor_is_minion { "'s attack Trigger: " } else { "'s Trigger: " }),
                    };
                    format!("{}{}", prefix, src.name())
                }
                None => main.triggered_by.as_ref().and_then(|t| t.name.clone()).unwrap_or_else(|| format!("{trigger_name} Trigger")),
            };
            if flag(&main.skill_data, "triggeredByBrand") {
                let n = cfg.brand_attached_count;
                msg.push_str(&format!(":{} attached Brand{}", n as i64, if n == 1.0 { "" } else { "s" }));
            }
            result.info_message = Some(msg);
        }
        result.main_adds_cast_time_flag = main_packaged && process_added_cast_time(main).is_some();
        result.global_trigger = Some(global_trigger);
        result.has_override = if cooldown_override.is_some() { Some(true) } else { None };
    } else {
        // CalcTriggers.lua's `if #triggeredSkills > 0 or not config.triggeredSkillCond then ...
        // end` has no else: when triggeredSkillCond is set but matched nothing, the whole block is
        // skipped and actor.mainSkill.skillData.triggered/output fields are left untouched (i.e.
        // whatever they were before this call - effectively "not triggered" from a fresh calc).
        // (leave `triggered` untouched: `result.triggered` stays None)
    }
    result
}

/// Port of `CWCHandler` (CalcTriggers.lua:222-392), numeric fields only.
pub fn cwc_handler(skills: &[Skill], main: &Skill, have_trigger_bots: bool) -> TriggerResult {
    let mut result = TriggerResult::default();
    if flag(&main.skill_flags, "minion") || main.disabled() {
        return result;
    }
    let mut triggered_skills: Vec<SimSkill> = Vec::new();
    let mut source: Option<&Skill> = None;
    for skill in skills {
        let sm = slot_match(main, skill);
        if source.is_none() {
            if num(&skill.skill_data, "triggerTime").is_some() && skill.can_support_by_main_trigger && !std::ptr::eq(skill, main) && sm && !is_triggered(skill) {
                source = Some(skill);
            }
        }
        if flag(&skill.skill_data, "triggeredWhileChannelling") && sm {
            triggered_skills.push(package_skill_for_sim(skill));
        }
    }
    let Some(source) = source.filter(|_| !triggered_skills.is_empty()) else {
        result.info_trigger = Some(String::new());
        result.info_message2 = Some("DPS reported assuming Self-Cast".to_string());
        result.info_message = Some("No Cast While Channeling Triggering Skill Found".to_string());
        result.triggered = Some(false);
        return result;
    };
    result.info_message = Some(format!("Cast While Channeling's Trigger: {}", source.name()));
    let adds_cast_time = process_added_cast_time(main);
    result.adds_cast_time = adds_cast_time;
    let icdr = main.core_calc.icdr;
    let trigger_interval = num(&source.skill_data, "triggerTime").unwrap_or(0.0);
    let trigger_rate_of_trigger = 1.0 / trigger_interval;
    let triggered_cd = num(&main.skill_data, "cooldown");
    let cooldown_override = main.core_calc.cooldown_override;
    if cooldown_override.is_some() {
        result.has_override = Some(true);
    }
    let triggered_total_cooldown = cooldown_override.unwrap_or_else(|| triggered_cd.unwrap_or(0.0).max(adds_cast_time.unwrap_or(0.0)) / icdr);
    let triggered_cd_adjusted = (triggered_total_cooldown * SERVER_TICK_RATE).ceil() / SERVER_TICK_RATE;
    let eff_cd = (triggered_cd_adjusted * trigger_rate_of_trigger).ceil() / trigger_rate_of_trigger;
    result.trigger_rate_cap = Some((1.0 / eff_cd).min(trigger_rate_of_trigger));
    let (mut rate, rates) = calc_multi_spell_rotation_impact(&triggered_skills, trigger_rate_of_trigger, 0.0, None, main.uuid.as_deref().unwrap_or(""));
    let trigger_bots_effective = have_trigger_bots && main.has_skill_type(SPELL);
    if trigger_bots_effective {
        rate *= 2.0;
    }
    result.skill_trigger_rate = Some(rate);
    if breakdown_on() {
        // `breakdown.AddedCastTime`, `TriggerRateCap`, `SkillTriggerRate` and `SimData` (CalcTriggers.lua:250-376)
        let triggered_name = main.ge.name.as_deref().unwrap_or("Triggered");
        let trigger_cap = result.trigger_rate_cap.unwrap_or(0.0);
        let mut t: Vec<String>;
        if triggered_cd.is_some() || cooldown_override.is_some() {
            t = vec![
                sf!("Cast While Channeling triggers %s every %.2fs while channeling %s ", triggered_name, trigger_interval, source.name()),
                String::new(),
                sf!("%.2f ^8(base cooldown of triggered skill)", triggered_cd.unwrap_or(0.0)),
                sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr),
                sf!("= %.4f ^8(final cooldown of triggered skill)", triggered_cd.unwrap_or(0.0) / icdr),
                String::new(),
            ];
            if let Some(co) = cooldown_override {
                t[3] = sf!("%.2f ^8(hard override of cooldown of %s)", co, triggered_name);
                t.remove(4);
                t.remove(4);
            }
        } else {
            t = vec![
                sf!("Cast While Channeling triggers %s every %.2fs while channeling %s ", triggered_name, trigger_interval, source.name()),
                String::new(),
                format!("{triggered_name} has no base cooldown or cooldown override"),
                String::new(),
            ];
        }
        let extra_increase_needed = |affected: f64| -> Option<f64> {
            if cooldown_override.is_some() {
                return None;
            }
            let next_breakpoint = eff_cd - trigger_interval;
            let time_over = triggered_total_cooldown - next_breakpoint;
            let already_reduced = triggered_total_cooldown * icdr - triggered_total_cooldown;
            if time_over < affected {
                let div_needed = affected / (affected - time_over - already_reduced);
                let inc_total = ((div_needed - 1.0) * 100.0).ceil();
                return Some(inc_total - (icdr - 1.0) * 100.0);
            }
            None
        };
        if let Some(a) = adds_cast_time {
            t.push("Cast While Channeling had no base cooldown".to_string());
            t.push(sf!("+ %.2f ^8(%s adds cast time as cooldown to trigger)", a, triggered_name));
            t.push(sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr));
            t.push(sf!("= %.4f ^8(final cooldown of triggered skill)", a / icdr));
            t.push(String::new());
            t.push(sf!("%.3f ^8(adjusted for server tick rate)", triggered_cd_adjusted));
            t.push(String::new());
            let extra_csi = extra_increase_needed(a);
            let extra_icdr = extra_increase_needed(triggered_total_cooldown * icdr);
            if let Some(n) = extra_icdr {
                t.push(sf!("^8(extra ICDR of %d%% would reach next breakpoint)", n));
            }
            if let Some(n) = extra_csi {
                t.push(sf!("^8(extra Cast Rate Increase of %d%% would reach next breakpoint)", n));
                t.push(String::new());
            }
        } else if let Some(n) = extra_increase_needed(triggered_total_cooldown * icdr) {
            t.push(sf!("^8(extra ICDR of %d%% would reach next breakpoint)", n));
            t.push(String::new());
        }
        t.push("Trigger rate:".to_string());
        t.push(sf!("1 / %.3f ^8(trigger rate adjusted for triggering interval)", 1.0 / trigger_cap));
        t.push(sf!("= %.2f ^8 %s casts per second", trigger_cap, triggered_name));
        result.tables.push(("TriggerRateCap".into(), lines(t)));
        if triggered_skills.len() > 1 {
            let mut s = vec![
                sf!("%.2f ^8(%s triggers per second)", trigger_rate_of_trigger, "Cast While Channeling"),
                sf!("/ %.2f ^8(Estimated impact of linked spells)", trigger_rate_of_trigger / rate),
                sf!("= %.2f ^8%s casts per second", rate, triggered_name),
            ];
            if trigger_bots_effective {
                s.insert(2, "x 2 ^8(Trigger bots effectively cause the skill to trigger twice)".to_string());
            }
            result.tables.push(("SkillTriggerRate".into(), lines(s)));
            result.tables.push(("SimData".into(), sim_data_table(skills, main, &rates, None)));
        }
        if let Some(a) = added_cast_time_table(main) {
            result.tables.push(("AddedCastTime".into(), lines(a)));
        }
    }
    result.channel_time_to_trigger = Some(trigger_interval);
    result.triggered = Some(true);
    result.global_trigger = Some(true);
    // (`addTriggerIncMoreMods(mainSkill, mainSkill)`: the mods are read against the main skill's own cfg)
    result
}

/// Port of `helmetFocusHandler` (CalcTriggers.lua:131-196): a spell triggered by the helmet's "Trigger Socketed Spells when
/// you Focus", assumed to be used the moment Focus comes off cooldown. `focus_duration` is `Focus.constantStats[1][2] / 1000`
/// and `focus_base_cooldown` is `Focus.levels[1].cooldown`.
pub fn focus_handler(main: &Skill, focus_duration: f64, focus_base_cooldown: f64) -> TriggerResult {
    let mut result = TriggerResult::default();
    if flag(&main.skill_flags, "minion") || main.disabled() {
        return result;
    }
    let Some(tb) = main.triggered_by.as_ref() else { return result };
    result.triggered = Some(true);
    let trigger_cd = tb.level_cooldown;
    let triggered_cd = num(&main.skill_data, "cooldown");
    let icdr_focus = main.core_calc.focus_icdr.unwrap_or(1.0);
    let icdr_skill = main.core_calc.icdr;
    let focus_cd = focus_base_cooldown / icdr_focus;
    let focus_total_cd = focus_duration + focus_cd;
    let mod_action_cooldown = triggered_cd.unwrap_or(0.0).max(trigger_cd.unwrap_or(0.0) / icdr_skill);
    let rate_cap_adjusted = (mod_action_cooldown * SERVER_TICK_RATE).ceil() / SERVER_TICK_RATE;
    let trigger_rate = if rate_cap_adjusted != 0.0 { 1.0 / rate_cap_adjusted } else { f64::INFINITY };
    result.trigger_rate_cap = Some(trigger_rate);
    result.skill_trigger_rate = Some(1.0 / focus_total_cd);
    if breakdown_on() {
        let tcd = trigger_cd.unwrap_or(f64::NAN);
        let ignores = flag(&main.skill_data, "ignoresTickRate");
        let tick_line = if ignores { String::new() } else { sf!("%.3f ^8(adjusted for server tick rate)", rate_cap_adjusted) };
        let t = if let Some(tc) = triggered_cd {
            vec![
                sf!("%.2f ^8(base cooldown of triggered skill)", tc),
                sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr_skill),
                sf!("= %.4f ^8(final cooldown of triggered skill)", tc / icdr_skill),
                String::new(),
                sf!("%.2f ^8(base cooldown of trigger)", tcd),
                sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr_skill),
                sf!("= %.4f ^8(final cooldown of trigger)", tcd / icdr_skill),
                String::new(),
                sf!("%.3f ^8(biggest of trigger cooldown and triggered skill cooldown)", mod_action_cooldown),
                String::new(),
                tick_line,
                String::new(),
                "Trigger rate:".to_string(),
                sf!("1 / %.3f", rate_cap_adjusted),
                sf!("= %.2f ^8per second", trigger_rate),
            ]
        } else {
            vec![
                "Triggered skill has no base cooldown".to_string(),
                String::new(),
                sf!("%.2f ^8(base cooldown of trigger)", tcd),
                sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr_skill),
                sf!("= %.4f ^8(final cooldown of trigger)", tcd / icdr_skill),
                String::new(),
                tick_line,
                String::new(),
                "Trigger rate:".to_string(),
                sf!("1 / %.3f", rate_cap_adjusted),
                sf!("= %.3f ^8per second", trigger_rate),
            ]
        };
        result.tables.push(("TriggerRateCap".into(), lines(t)));
        result.tables.push((
            "SkillTriggerRate".into(),
            lines(vec![
                sf!("%.2f ^8(focus base cooldown)", focus_base_cooldown),
                sf!("/ %.2f ^8(increased/reduced cooldown recovery)", icdr_focus),
                sf!("+ %.2f ^8(skills are only triggered on activation thus we add focus duration)", focus_duration),
                sf!("= %.2f ^8(effective skill cooldown for trigger purposes)", focus_total_cd),
                String::new(),
                sf!("%.3f casts per second ^8(Assuming player uses focus exactly when its cooldown of %.2fs expires)", 1.0 / focus_total_cd, focus_total_cd),
            ]),
        ));
    }
    // `addTriggerIncMoreMods(mainSkill, mainSkill)` is applied by the caller: the mods are read against the main skill's own cfg.
    result.info_trigger = Some("Focus".into());
    result.info_message = Some("Assuming perfect focus Re-Use".into());
    result.global_trigger = Some(true);
    result
}
