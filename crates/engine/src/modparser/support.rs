//! Shared entry shape for modNameList/modFlagList/preFlagList/modTagList table values: in the
//! Lua original these are arbitrary tables scanned field-by-field (see parseMod's `for k, v in
//! pairs(data) do misc[k] = v end`); this struct enumerates exactly the fields parseMod actually
//! reads off them.
use crate::modifier::Tag;

#[derive(Clone, Debug, Default)]
pub struct Entry {
    /// Array part: one or more mod names (Lua: a bare string, or `{ "A", "B" }`).
    pub names: Vec<&'static str>,
    pub flags: u64,
    pub keyword_flags: u64,
    pub tag: Option<Tag>,
    pub tag_list: Option<Vec<Tag>>,
    pub mod_suffix: Option<&'static str>,
    pub add_to_aura: bool,
    pub only_add_to_banners: bool,
    pub new_aura: bool,
    pub new_aura_only_allies: bool,
    pub add_to_minion: bool,
    pub player_tag: Option<Tag>,
    pub add_to_minion_tag: Option<Tag>,
    pub player_tag_list: Option<Vec<Tag>>,
    pub add_to_skill: Option<Tag>,
    pub apply_to_enemy: bool,
    pub actor_enemy: bool,
}

impl Entry {
    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }
}
