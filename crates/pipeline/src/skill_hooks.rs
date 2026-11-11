//! Granted effects whose `Data/Skills/*.lua` entry defines a runtime function hook
//! (`preDamageFunc`/`initialFunc`/`preSkillTypeFunc`/`postCritFunc`/`preDotFunc`/`explosiveArrowFunc`,
//! called from `runSkillFunc` in CalcOffence.lua). None of those hooks is ported, so a main skill
//! using one of these does not get the damage/DPS stage at all (its keys stay unproduced rather
//! than being computed without the hook). Generated from upstream's `Data/Skills`.

pub const HOOKED_SKILLS: &[&str] = &[
    "ArmageddonBrand", "ArmageddonBrandAltY", "AvengingFlame", "AzmeriHydraBarrage", "BallLightning", "BallLightningAltX",
    "BallLightningAltY", "Bane", "BaneAltX", "Barrage", "BarrageAltX", "BladeBlast",
    "BladeBlastAltX", "BladeFlurry", "BladeFlurryAltX", "BladeVortex", "BladefallAltZ", "BlastRain",
    "BlazingSalvo", "BloodSacramentUnique", "Bodyswap", "BodyswapAltX", "BrandSupport", "ChargedDash",
    "ChargedDashAltX", "Cremation", "CremationAltX", "CremationAltY", "Cyclone", "CycloneAltX",
    "DarkPact", "DarkPactAltX", "DeathWish", "DivineIre", "DivineIreAltX", "DivineIreAltY",
    "Earthquake", "EnemyExplode", "ExplosiveArrow", "ExplosiveTrap", "ExplosiveTrapAltX", "EyeOfWinter", "EyeOfWinterAltX",
    "EyeOfWinterAltY", "Flameblast", "FlameblastAltX", "FlameblastAltY", "FlamethrowerTrap", "FlamethrowerTrapAltX",
    "ForbiddenRite", "ForbiddenRiteAltX", "FreezingPulse", "FrostBombAltY", "FrozenSweep", "FrozenSweepAltX",
    "GAZombieCorpseGroundImpact", "GalvanicField", "GalvanicFieldAltX", "HeraldOfAsh", "HeraldOfTheBreach", "HeraldOfThunder",
    "Hydrosphere", "IceSpear", "IceSpearAltX", "Incinerate", "IncinerateAltX", "IncinerateAltY",
    "InfernalBlow", "InfernalBlowAltX", "KineticFusillade", "KineticFusilladeAltX", "LancingSteel", "LancingSteelAltX",
    "LightningBolt", "LightningSpireTrap", "LightningSpireTrapAltX", "LightningSpireTrapAltY", "LightningTendrilsAltX", "Manabond",
    "MinionInstability", "MoltenShell", "MoltenStrike", "MoltenStrikeAltX", "OrbOfStorms", "PenanceBrand",
    "PenanceBrandAltX", "PenanceBrandAltY", "Perforate", "PerforateAltX", "PerforateAltY", "PoisonousConcoction",
    "PoisonousConcoctionAltX", "RageVortex", "RighteousFire", "RighteousFireAltX", "ScourgeArrow", "SeismicTrap",
    "SeismicTrapAltX", "ShrapnelBallista", "ShrapnelBallistaAltX", "Spark", "SparkAltX", "SparkAltY",
    "StaticStrike", "StormBrand", "StormBrandAltX", "StormBurst", "StormBurstAltX", "StormRain",
    "StormRainAltX", "StormRainAltY", "Tornado", "TornadoAltY", "TornadoShot", "ToxicRain", "ToxicRainAltX",
    "ToxicRainAltY", "VaalBladeVortex", "VaalCyclone", "VaalLightningArrow", "VaalMoltenShell", "VaalRighteousFire",
    "VoidSphere", "VoidSphereAltX", "VoltaxicBurst", "Vortex", "VortexAltX", "WaveOfConviction",
    "WaveOfConvictionAltY", "WinterOrb", "WintertideBrand",
];

pub fn has_hook(id: &str) -> bool {
    HOOKED_SKILLS.contains(&id)
}
