//! Port of `Modules/CalcActiveSkill.lua`'s active-skill construction
//! (`calcs.createActiveSkill`/`calcs.buildActiveSkillModList`) and the non-UI part of
//! `Classes/SkillsTab.lua`'s socket-group/gem loading, graded against
//! the recorded sample builds.
pub mod active_skill;
pub mod assemble;
pub mod cfg;
pub mod data;
pub mod modlist;
pub mod skill_type;
pub mod xmlskills;
