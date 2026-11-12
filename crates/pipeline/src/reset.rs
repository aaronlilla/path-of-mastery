//! Clears every per-build thread-local (mirage / trigger / FullDPS scratch state) so a build never sees a previous
//! build's leftovers when several run in one process. Call once before each top-level `build_env`.
use crate::{buffs, offence, offence_dps, offence_prep, triggers_wire};

pub fn reset_build_state() {
    offence::MIRAGE_ACTOR_OUT.with(|m| *m.borrow_mut() = None);
    offence::SUMMON_SPEED.with(|c| c.set(None));
    offence::MIRAGE_RUN.with(|m| *m.borrow_mut() = None);
    offence::MIRAGE_RESULT.with(|m| *m.borrow_mut() = None);
    offence::MIRAGE_MAIN.with(|m| *m.borrow_mut() = None);
    offence::MIRAGE_ARCHER_SEEN.with(|m| m.borrow_mut().clear());
    offence::MIRAGE_CHOSEN.with(|m| m.borrow_mut().clear());
    offence::UNLEASH_DPSMULT.with(|c| c.set(None));
    offence_dps::PART_OVERRIDE.with(|c| c.set(None));
    offence_dps::MAIN_OVERRIDE.with(|c| c.set(None));
    offence_dps::FD_ENEMY_MULTS_WIPED.with(|c| c.set(false));
    offence_prep::MINION_MODS.with(|v| v.borrow_mut().clear());
    buffs::FULLDPS_PARENT.with(|p| *p.borrow_mut() = None);
    triggers_wire::NESTED.with(|c| c.set(false));
    triggers_wire::SNIPE_STAGES.with(|c| c.set(None));
    triggers_wire::SNIPE_HTM.with(|c| c.set(None));
    pom_triggers::SELF_CACHE_STALE.with(|c| c.set(false));
    let _ = pom_triggers::take_gc_misses();
    pom_offence::dot::NO_BREAKDOWN.with(|c| c.set(false));
    pom_skills::assemble::RAW_ACTIVE_GEMS.with(|c| c.set(false));
    pom_skills::active_skill::SUMMON.with(|c| *c.borrow_mut() = None);
}
