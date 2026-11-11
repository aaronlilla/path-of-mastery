//! Armour base stats read off an item for `calcs.defence`.

/// A raw armour-slot line: `{Armour, Evasion, EnergyShield, Ward, BlockChance, ...}`. Extra keys
/// the recorder captured (`ArmourBase`, `EvasionBasePercentile`, ...) are ignored; the four
/// pre-mod base stats plus block chance are all `calcs.defence` reads off `item.armourData`.
#[derive(Default, Clone, Copy, Debug)]
pub struct ArmourData {
    pub armour: f64,
    pub evasion: f64,
    pub energy_shield: f64,
    pub ward: f64,
    pub block_chance: f64,
}
