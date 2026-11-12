// Data/Global.lua ModFlag / KeywordFlag bit values.
#[allow(non_upper_case_globals, dead_code)]
pub mod mod_flag {
    pub const Attack: u64 = 0x00000001;
    pub const Spell: u64 = 0x00000002;
    pub const Hit: u64 = 0x00000004;
    pub const Dot: u64 = 0x00000008;
    pub const Cast: u64 = 0x00000010;
    pub const Melee: u64 = 0x00000100;
    pub const Area: u64 = 0x00000200;
    pub const Projectile: u64 = 0x00000400;
    pub const SourceMask: u64 = 0x00000600;
    pub const Ailment: u64 = 0x00000800;
    pub const MeleeHit: u64 = 0x00001000;
    pub const Weapon: u64 = 0x00002000;
    pub const Axe: u64 = 0x00010000;
    pub const Bow: u64 = 0x00020000;
    pub const Claw: u64 = 0x00040000;
    pub const Dagger: u64 = 0x00080000;
    pub const Mace: u64 = 0x00100000;
    pub const Staff: u64 = 0x00200000;
    pub const Sword: u64 = 0x00400000;
    pub const Wand: u64 = 0x00800000;
    pub const Unarmed: u64 = 0x01000000;
    pub const Fishing: u64 = 0x02000000;
    pub const WeaponMelee: u64 = 0x04000000;
    pub const WeaponRanged: u64 = 0x08000000;
    pub const Weapon1H: u64 = 0x10000000;
    pub const Weapon2H: u64 = 0x20000000;
    pub const WeaponMask: u64 = 0x2FFF0000;
}
#[allow(non_upper_case_globals, dead_code)]
pub mod keyword_flag {
    pub const Aura: u64 = 0x00000001;
    pub const Curse: u64 = 0x00000002;
    pub const Warcry: u64 = 0x00000004;
    pub const Movement: u64 = 0x00000008;
    pub const Physical: u64 = 0x00000010;
    pub const Fire: u64 = 0x00000020;
    pub const Cold: u64 = 0x00000040;
    pub const Lightning: u64 = 0x00000080;
    pub const Chaos: u64 = 0x00000100;
    pub const Vaal: u64 = 0x00000200;
    pub const Bow: u64 = 0x00000400;
    pub const Arrow: u64 = 0x00000800;
    pub const Trap: u64 = 0x00001000;
    pub const Mine: u64 = 0x00002000;
    pub const Totem: u64 = 0x00004000;
    pub const Minion: u64 = 0x00008000;
    pub const Attack: u64 = 0x00010000;
    pub const Spell: u64 = 0x00020000;
    pub const Hit: u64 = 0x00040000;
    pub const Ailment: u64 = 0x00080000;
    pub const Brand: u64 = 0x00100000;
    pub const Poison: u64 = 0x00200000;
    pub const Bleed: u64 = 0x00400000;
    pub const Ignite: u64 = 0x00800000;
    pub const PhysicalDot: u64 = 0x01000000;
    pub const LightningDot: u64 = 0x02000000;
    pub const ColdDot: u64 = 0x04000000;
    pub const FireDot: u64 = 0x08000000;
    pub const ChaosDot: u64 = 0x10000000;
    pub const MatchAll: u64 = 0x40000000;
}
