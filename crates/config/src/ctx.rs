use crate::types::OwnedOptionValue;
use pom_engine::data::GameData;
use pom_engine::modifier::Mod;
use pom_engine::fxhash::HashMap;
use std::sync::Arc;

/// Threaded through every apply handler. Mirrors the handful of `build.*` / `build.configTab.*`
/// reads the four build-taking apply functions and the two data-driven meta handlers
/// (enemyIsBoss, presetBossSkills, enemySizePreset, mapAffixDropDownFunction) need. Everything
/// else in the 539 handlers only touches `mods` / `enemy`.
pub struct ConfigCtx<'a> {
    pub mods: Vec<Mod>,
    pub enemy: Vec<Mod>,
    /// The build's saved `<Input>` values (immutable: this is the loaded/recorded config set).
    pub input: &'a HashMap<String, OwnedOptionValue>,
    /// Runtime overrides written mid-pass by a handler (only `presetBossSkills`, which does
    /// `build.configTab.input['enemyDamageType'] = bossData.DamageType`). Checked before `input`.
    pub input_override: HashMap<String, OwnedOptionValue>,
    pub placeholder: HashMap<String, OwnedOptionValue>,
    pub game: &'a GameData,
    pub character_level: i64,
    /// `configTab.enemyLevel`, recomputed by `update_level()` (Classes/ConfigTab.lua's
    /// `ConfigTabClass:UpdateLevel`), which several enemy-stat defaults read back.
    pub enemy_level: i64,
    /// `build.configTab.varControls['enemyIsBoss'].list[selIndex].val` — tracked directly as the
    /// resolved input value instead of modeling the UI control, since `presetBossSkills` only
    /// ever reads it to derive `isUber`.
    pub enemy_is_boss: Option<Arc<str>>,
}

impl<'a> ConfigCtx<'a> {
    pub fn new(input: &'a HashMap<String, OwnedOptionValue>, placeholder: HashMap<String, OwnedOptionValue>, game: &'a GameData, character_level: i64) -> Self {
        let mut ctx = ConfigCtx {
            mods: Vec::new(),
            enemy: Vec::new(),
            input,
            input_override: HashMap::default(),
            placeholder,
            game,
            character_level,
            enemy_level: 0,
            enemy_is_boss: None,
        };
        ctx.update_level();
        ctx
    }

    pub fn get_input(&self, var: &str) -> Option<&OwnedOptionValue> {
        self.input_override.get(var).or_else(|| self.input.get(var))
    }

    /// Port of `ConfigTabClass:UpdateLevel`.
    pub fn update_level(&mut self) {
        let max_enemy_level = self.game.misc.get("MaxEnemyLevel").unwrap_or(90.0) as i64;
        let input_lvl = self.get_input("enemyLevel").map(|v| v.as_f64()).filter(|v| *v > 0.0);
        let ph_lvl = self.placeholder.get("enemyLevel").map(|v| v.as_f64()).filter(|v| *v > 0.0);
        self.enemy_level = if let Some(v) = input_lvl {
            max_enemy_level.min(v as i64)
        } else if let Some(v) = ph_lvl {
            max_enemy_level.min(v as i64)
        } else {
            max_enemy_level.min(self.character_level)
        };
    }

    pub fn set_placeholder_num(&mut self, var: &str, value: Option<f64>) {
        match value {
            Some(v) => { self.placeholder.insert(var.to_string(), OwnedOptionValue::Num(v)); }
            None => { self.placeholder.remove(var); }
        }
    }
    pub fn set_input_str(&mut self, var: &str, value: &str) {
        self.input_override.insert(var.to_string(), OwnedOptionValue::Str(Arc::from(value)));
    }
}
