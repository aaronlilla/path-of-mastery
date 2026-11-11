/**
 * The stat rows upstream shows for a build (Modules/BuildDisplayStats.lua `displayStats`): which output stat, its
 * label, format and colour, and when it is shown. Ported row by row. Upstream decides some rows by the main skill's
 * flags; the engine's output carries no flags, so `skillFlags` reads them from stats that only exist for that kind of
 * skill (an attack has `MainHand`, a spell has `CastRate`). Flags nothing in the output can reveal (brand, impale, warcry,
 * channelling, monster explosions, PvP) count as present when the row's own stat has a value.
 */

export type StatOut = Record<string, unknown>;

export interface DisplayStat {
  stat?: string;
  childStat?: string;
  label?: string;
  /** C-style format: "d", ".1f", ".2f%%", "+d%%", ".3fs", ".1fm". */
  fmt?: string;
  /** A token colour for the label. */
  color?: string;
  flag?: string;
  notFlag?: string;
  cond?: (v: number, o: Out) => boolean;
  compact?: boolean;
  lowerIsBetter?: boolean;
  /** Fractional value shown as a percentage. */
  pc?: boolean;
  /** Value is a multiplier; shown as its +/- percentage. */
  mod?: boolean;
  hide?: boolean;
  /** Offence, defence, or resistances and utility (the Compare summary's groups). */
  group: 'o' | 'd' | 'u';
}

/** Output with numbers read as numbers ("Inf" is infinity) and lookups that say what they hold. */
export interface Out {
  [k: string]: unknown;
}

const COLOUR = {
  life: 'var(--pool-life)',
  mana: 'var(--pool-mana)',
  es: 'var(--pool-es)',
  ward: 'var(--pool-ward)',
  rage: 'var(--pool-rage)',
  str: 'var(--attr-str)',
  dex: 'var(--attr-dex)',
  int: 'var(--attr-int)',
  rare: 'var(--rarity-rare)',
  phys: 'var(--dmg-physical)',
  fire: 'var(--dmg-fire)',
  cold: 'var(--dmg-cold)',
  lightning: 'var(--dmg-lightning)',
  chaos: 'var(--dmg-chaos)',
  evasion: 'var(--stat-evasion)',
  currency: 'var(--rarity-currency)',
};

const num = (o: Out, k: string): number => {
  const v = o[k];
  return typeof v === 'number' ? v : 0;
};
const has = (o: Out, k: string): boolean => o[k] !== undefined && o[k] !== null && o[k] !== false;
const eq = (o: Out, a: string, b: string): boolean => o[a] === o[b];
const noTrigger = (o: Out): boolean => ((o.TriggerTime as number | undefined) ?? 0) === 0;

type Row = Omit<DisplayStat, 'group'>;
const rows = (group: DisplayStat['group'], list: Row[]): DisplayStat[] => list.map((r) => ({ ...r, group }));

/** The offence rows, down to the skill costs. */
function offence(): DisplayStat[] {
  const c = true;
  return rows('o', [
    { stat: 'ActiveMinionLimit', label: 'Active Minion Limit', fmt: 'd' },
    { stat: 'AverageHit', label: 'Average Hit', fmt: '.1f', compact: c },
    { stat: 'PvpAverageHit', label: 'PvP Average Hit', fmt: '.1f', compact: c, flag: 'isPvP' },
    { stat: 'AverageDamage', label: 'Average Damage', fmt: '.1f', compact: c, flag: 'attack' },
    { stat: 'AverageDamage', label: 'Average Damage', fmt: '.1f', compact: c, flag: 'monsterExplode', cond: (_v, o) => o.HitChance !== 100 },
    { stat: 'AverageBurstDamage', label: 'Average Burst Damage', fmt: '.1f', compact: c, cond: (v, o) => num(o, 'AverageBurstHits') > 1 && v > 0 },
    { stat: 'PvpAverageDamage', label: 'PvP Average Damage', fmt: '.1f', compact: c, flag: 'attackPvP' },
    { stat: 'Speed', label: 'Attack Rate', fmt: '.2f', flag: 'attack', cond: (v, o) => v > 0 && noTrigger(o) },
    { stat: 'KineticFusilladeMaxEffectiveAPS', label: 'Max Eff. KF Attack Rate', fmt: '.2f', flag: 'attack', cond: (v) => v > 0 },
    { stat: 'Speed', label: 'Cast Rate', fmt: '.2f', flag: 'spell', cond: (v, o) => v > 0 && noTrigger(o) },
    { stat: 'Speed', label: 'Effective Trigger Rate', fmt: '.2f', notFlag: 'skipEffectiveRate', cond: (_v, o) => !noTrigger(o) },
    { stat: 'WarcryCastTime', label: 'Cast Time', fmt: '.2fs', lowerIsBetter: true, flag: 'warcry' },
    { stat: 'HitSpeed', label: 'Hit Rate', fmt: '.2f', cond: (_v, o) => o.TriggerTime === undefined },
    { stat: 'HitTime', label: 'Channel Time', fmt: '.2fs', flag: 'channelRelease', lowerIsBetter: true, cond: (_v, o) => o.TriggerTime === undefined },
    { stat: 'ChannelTimeToTrigger', label: 'Channel Time', fmt: '.2fs', lowerIsBetter: true },
    { stat: 'TrapThrowingTime', label: 'Trap Throwing Time', fmt: '.2fs', lowerIsBetter: true },
    { stat: 'TrapCooldown', label: 'Trap Cooldown', fmt: '.3fs', lowerIsBetter: true },
    { stat: 'MineLayingTime', label: 'Mine Throwing Time', fmt: '.2fs', lowerIsBetter: true },
    { stat: 'TrapThrowCount', label: 'Avg. Traps per Throw', fmt: '.2f' },
    { stat: 'MineThrowCount', label: 'Avg. Mines per Throw', fmt: '.2f' },
    { stat: 'TotemPlacementTime', label: 'Totem Placement Time', fmt: '.2fs', lowerIsBetter: true, cond: (_v, o) => o.TriggerTime === undefined },
    { stat: 'PreEffectiveCritChance', label: 'Crit Chance', fmt: '.2f%%', flag: 'hit' },
    { stat: 'CritChance', label: 'Effective Crit Chance', fmt: '.2f%%', flag: 'hit', cond: (v, o) => v !== o.PreEffectiveCritChance },
    { stat: 'CritMultiplier', label: 'Crit Multiplier', fmt: 'd%%', pc: true, cond: (_v, o) => num(o, 'CritChance') > 0 },
    { stat: 'HitChance', label: 'Hit Chance', fmt: '.0f%%', flag: 'attack' },
    { stat: 'HitChance', label: 'Hit Chance', fmt: '.0f%%', cond: (_v, o) => has(o, 'enemyHasSpellBlock') },
    { stat: 'TotalDPS', label: 'Hit DPS', fmt: '.1f', compact: c, flag: 'notAverage' },
    { stat: 'PvpTotalDPS', label: 'PvP Hit DPS', fmt: '.1f', compact: c, flag: 'notAveragePvP' },
    { stat: 'TotalDPS', label: 'Hit DPS', fmt: '.1f', compact: c, flag: 'showAverage', cond: (_v, o) => !noTrigger(o) },
    { stat: 'TotalDot', label: 'DoT DPS', fmt: '.1f', compact: c },
    { stat: 'WithDotDPS', label: 'Total DPS inc. DoT', fmt: '.1f', compact: c, flag: 'notAverage', cond: (v, o) => v !== o.TotalDPS && num(o, 'PoisonDPS') === 0 && num(o, 'IgniteDPS') === 0 && num(o, 'ImpaleDPS') === 0 && num(o, 'BleedDPS') === 0 },
    { stat: 'BleedDPS', label: 'Bleed DPS', fmt: '.1f', compact: c },
    { stat: 'CorruptingBloodDPS', label: 'Corrupting Blood DPS', fmt: '.1f', compact: c },
    { stat: 'BleedDamage', label: 'Total Damage per Bleed', fmt: '.1f', compact: c, flag: 'showAverage' },
    { stat: 'WithBleedDPS', label: 'Total DPS inc. Bleed', fmt: '.1f', compact: c, flag: 'notAverage', cond: (v, o) => v !== o.TotalDPS && num(o, 'TotalDot') === 0 && num(o, 'PoisonDPS') === 0 && num(o, 'ImpaleDPS') === 0 && num(o, 'IgniteDPS') === 0 },
    { stat: 'IgniteDPS', label: 'Ignite DPS', fmt: '.1f', compact: c },
    { stat: 'IgniteDamage', label: 'Total Damage per Ignite', fmt: '.1f', compact: c, flag: 'showAverage' },
    { stat: 'BurningGroundDPS', label: 'Burning Ground DPS', fmt: '.1f', compact: c },
    { stat: 'MirageBurningGroundDPS', label: 'Mirage Burning Ground DPS', fmt: '.1f', compact: c, cond: (v, o) => v !== o.BurningGroundDPS },
    { stat: 'WithIgniteDPS', label: 'Total DPS inc. Ignite', fmt: '.1f', compact: c, flag: 'notAverage', cond: (v, o) => v !== o.TotalDPS && num(o, 'TotalDot') === 0 && num(o, 'PoisonDPS') === 0 && num(o, 'ImpaleDPS') === 0 && num(o, 'BleedDPS') === 0 },
    { stat: 'WithIgniteAverageDamage', label: 'Average Dmg. inc. Ignite', fmt: '.1f', compact: c },
    { stat: 'PoisonDPS', label: 'Single Poison DPS', fmt: '.1f', compact: c },
    { stat: 'CausticGroundDPS', label: 'Caustic Ground DPS', fmt: '.1f', compact: c },
    { stat: 'MirageCausticGroundDPS', label: 'Mirage Caustic Ground DPS', fmt: '.1f', compact: c, cond: (v, o) => v !== o.CausticGroundDPS },
    { stat: 'PoisonDamage', label: 'Total Damage per Poison', fmt: '.1f', compact: c },
    { stat: 'WithPoisonDPS', label: 'Total DPS inc. Poison', fmt: '.1f', compact: c, flag: 'notAverage', cond: (v, o) => v !== o.TotalDPS && num(o, 'TotalDot') === 0 && num(o, 'IgniteDPS') === 0 && num(o, 'ImpaleDPS') === 0 && num(o, 'BleedDPS') === 0 },
    { stat: 'DecayDPS', label: 'Decay DPS', fmt: '.1f', compact: c },
    {
      stat: 'TotalDotDPS',
      label: 'Total DoT DPS',
      fmt: '.1f',
      compact: c,
      cond: (v, o) => has(o, 'showTotalDotDPS') || (v !== o.TotalDot && v !== o.TotalPoisonDPS && v !== o.CausticGroundDPS && v !== (o.TotalIgniteDPS ?? o.IgniteDPS) && v !== o.BurningGroundDPS && v !== o.BleedDPS && v !== o.CorruptingBloodDPS && v !== o.MirageCausticGroundDPS && v !== o.MirageBurningGroundDPS),
    },
    { stat: 'ImpaleDPS', label: 'Impale Damage', fmt: '.1f', compact: c, flag: 'showAverage' },
    { stat: 'WithImpaleDPS', label: 'Damage inc. Impale', fmt: '.1f', compact: c, flag: 'showAverage', cond: (v, o) => v !== o.TotalDPS && num(o, 'TotalDot') === 0 && num(o, 'IgniteDPS') === 0 && num(o, 'PoisonDPS') === 0 && num(o, 'BleedDPS') === 0 },
    { stat: 'ImpaleDPS', label: 'Impale DPS', fmt: '.1f', compact: c, flag: 'notAverage' },
    { stat: 'WithImpaleDPS', label: 'Total DPS inc. Impale', fmt: '.1f', compact: c, flag: 'notAverage', cond: (v, o) => v !== o.TotalDPS && num(o, 'TotalDot') === 0 && num(o, 'IgniteDPS') === 0 && num(o, 'PoisonDPS') === 0 && num(o, 'BleedDPS') === 0 },
    { stat: 'MirageDPS', label: 'Total Mirage DPS', fmt: '.1f', compact: c, flag: 'mirageArcher', cond: (v) => v > 0 },
    { stat: 'CullingDPS', label: 'Culling DPS', fmt: '.1f', compact: c, cond: (_v, o) => num(o, 'CullingDPS') > 0 },
    { stat: 'ReservationDPS', label: 'Reservation DPS', fmt: '.1f', compact: c, cond: (_v, o) => num(o, 'ReservationDPS') > 0 },
    {
      stat: 'CombinedDPS',
      label: 'Combined DPS',
      fmt: '.1f',
      compact: c,
      flag: 'notAverage',
      cond: (v, o) => v !== num(o, 'TotalDPS') + num(o, 'TotalDot') && v !== o.WithImpaleDPS && (has(o, 'showTotalDotDPS') || (v !== o.WithPoisonDPS && v !== o.WithIgniteDPS && v !== o.WithBleedDPS)),
    },
    { stat: 'CombinedAvg', label: 'Combined Total Damage', fmt: '.1f', compact: c, flag: 'showAverage', cond: (v, o) => v !== o.AverageDamage && num(o, 'TotalDot') === 0 && (v !== o.WithPoisonDPS || v !== o.WithIgniteDPS || v !== o.WithBleedDPS) },
    { stat: 'ExplodeChance', label: 'Total Explode Chance', fmt: '.0f%%' },
    { stat: 'CombinedAvgToMonsterLife', label: 'Enemy Life Equivalent', fmt: '.1f%%' },
    { stat: 'Cooldown', label: 'Skill Cooldown', fmt: '.3fs', notFlag: 'skipEffectiveRate', lowerIsBetter: true },
    { stat: 'SealCooldown', label: 'Seal Gain Frequency', fmt: '.2fs', lowerIsBetter: true },
    { stat: 'SealMax', label: 'Max Number of Seals', fmt: 'd' },
    { stat: 'TimeMaxSeals', label: 'Time to Gain Max Seals', fmt: '.2fs', lowerIsBetter: true },
    { stat: 'AreaOfEffectRadiusMetres', label: 'AoE Radius', fmt: '.1fm' },
    { stat: 'BrandAttachmentRangeMetre', label: 'Attachment Range', fmt: '.1fm', flag: 'brand' },
    { stat: 'BrandTicks', label: 'Activations per Brand', fmt: 'd', flag: 'brand' },
    { stat: 'ManaCost', label: 'Mana Cost', fmt: 'd', color: COLOUR.mana, lowerIsBetter: true, cond: (_v, o) => has(o, 'ManaHasCost') },
    { stat: 'ManaPercentCost', label: 'Mana Cost', fmt: 'd%%', color: COLOUR.mana, lowerIsBetter: true, cond: (_v, o) => has(o, 'ManaPercentHasCost') },
    { stat: 'ManaPerSecondCost', label: 'Mana Cost per second', fmt: '.2f', color: COLOUR.mana, lowerIsBetter: true, cond: (_v, o) => has(o, 'ManaPerSecondHasCost') },
    { stat: 'ManaPercentPerSecondCost', label: 'Mana Cost per second', fmt: '.2f%%', color: COLOUR.mana, lowerIsBetter: true, cond: (_v, o) => has(o, 'ManaPercentPerSecondHasCost') },
    { stat: 'LifeCost', label: 'Life Cost', fmt: 'd', color: COLOUR.life, lowerIsBetter: true, cond: (_v, o) => has(o, 'LifeHasCost') },
    { stat: 'LifePercentCost', label: 'Life Cost', fmt: 'd%%', color: COLOUR.life, lowerIsBetter: true, cond: (_v, o) => has(o, 'LifePercentHasCost') },
    { stat: 'LifePerSecondCost', label: 'Life Cost per second', fmt: '.2f', color: COLOUR.life, lowerIsBetter: true, cond: (_v, o) => has(o, 'LifePerSecondHasCost') },
    { stat: 'LifePercentPerSecondCost', label: 'Life Cost per second', fmt: '.2f%%', color: COLOUR.life, lowerIsBetter: true, cond: (_v, o) => has(o, 'LifePercentPerSecondHasCost') },
    { stat: 'ESCost', label: 'Energy Shield Cost', fmt: 'd', color: COLOUR.es, lowerIsBetter: true, cond: (_v, o) => has(o, 'ESHasCost') },
    { stat: 'ESPerSecondCost', label: 'ES Cost per second', fmt: '.2f', color: COLOUR.es, lowerIsBetter: true, cond: (_v, o) => has(o, 'ESPerSecondHasCost') },
    { stat: 'ESPercentPerSecondCost', label: 'ES Cost per second', fmt: '.2f%%', color: COLOUR.es, lowerIsBetter: true, cond: (_v, o) => has(o, 'ESPercentPerSecondHasCost') },
    { stat: 'RageCost', label: 'Rage Cost', fmt: 'd', color: COLOUR.rage, lowerIsBetter: true, cond: (_v, o) => has(o, 'RageHasCost') },
    { stat: 'RagePerSecondCost', label: 'Rage Cost per second', fmt: '.2f', color: COLOUR.rage, lowerIsBetter: true, cond: (_v, o) => has(o, 'RagePerSecondHasCost') },
    { stat: 'SoulCost', label: 'Soul Cost', fmt: 'd', color: COLOUR.rage, lowerIsBetter: true, cond: (_v, o) => has(o, 'SoulHasCost') },
    { stat: 'MainHand', childStat: 'Accuracy', label: 'MH Accuracy', fmt: 'd', cond: (_v, o) => has(o, 'PreciseTechnique') },
    { stat: 'OffHand', childStat: 'Accuracy', label: 'OH Accuracy', fmt: 'd', cond: (_v, o) => has(o, 'PreciseTechnique') },
  ]);
}

function utility(): DisplayStat[] {
  return rows('u', [
    { stat: 'Str', label: 'Strength', color: COLOUR.str, fmt: 'd' },
    { stat: 'ReqStr', label: 'Strength Required', color: COLOUR.str, fmt: 'd', lowerIsBetter: true, cond: (v, o) => v > num(o, 'Str') },
    { stat: 'Dex', label: 'Dexterity', color: COLOUR.dex, fmt: 'd' },
    { stat: 'ReqDex', label: 'Dexterity Required', color: COLOUR.dex, fmt: 'd', lowerIsBetter: true, cond: (v, o) => v > num(o, 'Dex') },
    { stat: 'Int', label: 'Intelligence', color: COLOUR.int, fmt: 'd' },
    { stat: 'ReqInt', label: 'Intelligence Required', color: COLOUR.int, fmt: 'd', lowerIsBetter: true, cond: (v, o) => v > num(o, 'Int') },
    { stat: 'Omni', label: 'Omniscience', color: COLOUR.rare, fmt: 'd' },
    { stat: 'ReqOmni', label: 'Omniscience Required', color: COLOUR.rare, fmt: 'd', lowerIsBetter: true, cond: (v, o) => v > num(o, 'Omni') },
    { stat: 'Devotion', label: 'Devotion', color: COLOUR.rare, fmt: 'd' },
  ]);
}

function defence(): DisplayStat[] {
  const c = true;
  const maxHit = (): boolean => true;
  const elemEqual = (o: Out): boolean => eq(o, 'LightningMaximumHitTaken', 'ColdMaximumHitTaken') && eq(o, 'LightningMaximumHitTaken', 'FireMaximumHitTaken');
  return [
    ...rows('d', [
      { stat: 'TotalEHP', label: 'Effective Hit Pool', fmt: '.0f', compact: c },
      { stat: 'PvPTotalTakenHit', label: 'PvP Hit Taken', fmt: '.1f', flag: 'isPvP', compact: c, lowerIsBetter: true },
      { stat: 'PhysicalMaximumHitTaken', label: 'Phys Max Hit', fmt: '.0f', compact: c, color: COLOUR.phys, cond: maxHit },
      { stat: 'LightningMaximumHitTaken', label: 'Elemental Max Hit', fmt: '.0f', compact: c, color: COLOUR.lightning, cond: (_v, o) => elemEqual(o) },
      { stat: 'FireMaximumHitTaken', label: 'Fire Max Hit', fmt: '.0f', compact: c, color: COLOUR.fire, cond: (_v, o) => !elemEqual(o) },
      { stat: 'ColdMaximumHitTaken', label: 'Cold Max Hit', fmt: '.0f', compact: c, color: COLOUR.cold, cond: (_v, o) => !elemEqual(o) },
      { stat: 'LightningMaximumHitTaken', label: 'Lightning Max Hit', fmt: '.0f', compact: c, color: COLOUR.lightning, cond: (_v, o) => !elemEqual(o) },
      { stat: 'ChaosMaximumHitTaken', label: 'Chaos Max Hit', fmt: '.0f', compact: c, color: COLOUR.chaos },
      { stat: 'Life', label: 'Total Life', fmt: 'd', compact: c, color: COLOUR.life },
      { stat: 'Spec:LifeInc', label: '%Inc Life from Tree', fmt: 'd%%', color: COLOUR.life, cond: (v, o) => v > 0 && num(o, 'Life') > 1 },
      { stat: 'LifeUnreserved', label: 'Unreserved Life', fmt: 'd', color: COLOUR.life, cond: (v, o) => v < num(o, 'Life') },
      { stat: 'LifeRecoverable', label: 'Life Recoverable', fmt: 'd', color: COLOUR.life, cond: (v, o) => v < num(o, 'LifeUnreserved') },
      { stat: 'LifeUnreservedPercent', label: 'Unreserved Life', fmt: 'd%%', color: COLOUR.life, cond: (v) => v < 100 },
      { stat: 'LifeRegenRecovery', label: 'Life Regen', fmt: '.1f', color: COLOUR.life, cond: (v, o) => num(o, 'LifeRecovery') <= 0 && v !== 0 },
      { stat: 'LifeRegenRecovery', label: 'Life Recovery', fmt: '.1f', color: COLOUR.life, cond: (v, o) => num(o, 'LifeRecovery') > 0 && v !== 0 },
      { stat: 'LifeRecharge', label: 'Life Recharge', fmt: '.1f', color: COLOUR.life, cond: (v) => v > 0 },
      { stat: 'LifeLeechGainRate', label: 'Life Leech/On Hit Rate', fmt: '.1f', color: COLOUR.life },
      { stat: 'LifeLeechGainPerHit', label: 'Life Leech/Gain per Hit', fmt: '.1f', color: COLOUR.life },
      { stat: 'Mana', label: 'Total Mana', fmt: 'd', compact: c, color: COLOUR.mana },
      { stat: 'Spec:ManaInc', label: '%Inc Mana from Tree', color: COLOUR.mana, fmt: 'd%%' },
      { stat: 'ManaUnreserved', label: 'Unreserved Mana', fmt: 'd', color: COLOUR.mana, cond: (v, o) => v < num(o, 'Mana') },
      { stat: 'ManaUnreservedPercent', label: 'Unreserved Mana', fmt: 'd%%', color: COLOUR.mana, cond: (v) => v < 100 },
      { stat: 'ManaRegenRecovery', label: 'Mana Regen', fmt: '.1f', color: COLOUR.mana, cond: (v, o) => num(o, 'ManaRecovery') <= 0 && v !== 0 },
      { stat: 'ManaRegenRecovery', label: 'Mana Recovery', fmt: '.1f', color: COLOUR.mana, cond: (v, o) => num(o, 'ManaRecovery') > 0 && v !== 0 },
      { stat: 'ManaLeechGainRate', label: 'Mana Leech/On Hit Rate', fmt: '.1f', color: COLOUR.mana },
      { stat: 'ManaLeechGainPerHit', label: 'Mana Leech/Gain per Hit', fmt: '.1f', color: COLOUR.mana },
      { stat: 'EnergyShield', label: 'Energy Shield', fmt: 'd', compact: c, color: COLOUR.es },
      { stat: 'EnergyShieldRecoveryCap', label: 'Recoverable ES', color: COLOUR.es, fmt: 'd', cond: (_v, o) => has(o, 'CappingES') },
      { stat: 'Spec:EnergyShieldInc', label: '%Inc ES from Tree', color: COLOUR.es, fmt: 'd%%' },
      { stat: 'EnergyShieldRegenRecovery', label: 'ES Regen', color: COLOUR.es, fmt: '.1f', cond: (v, o) => num(o, 'EnergyShieldRecovery') <= 0 && v !== 0 },
      { stat: 'EnergyShieldRegenRecovery', label: 'ES Recovery', color: COLOUR.es, fmt: '.1f', cond: (v, o) => num(o, 'EnergyShieldRecovery') > 0 && v !== 0 },
      { stat: 'EnergyShieldLeechGainRate', label: 'ES Leech/On Hit Rate', color: COLOUR.es, fmt: '.1f' },
      { stat: 'EnergyShieldLeechGainPerHit', label: 'ES Leech/Gain per Hit', color: COLOUR.es, fmt: '.1f' },
      { stat: 'Ward', label: 'Ward', fmt: 'd', compact: c, color: COLOUR.ward },
      { stat: 'Rage', label: 'Rage', fmt: 'd', color: COLOUR.rage },
      { stat: 'RageRegenRecovery', label: 'Rage Regen', fmt: '.1f', color: COLOUR.rage },
      { stat: 'TotalBuildDegen', label: 'Total Degen', fmt: '.1f', lowerIsBetter: true },
      { stat: 'TotalNetRegen', label: 'Total Net Recovery', fmt: '+.1f' },
      { stat: 'NetLifeRegen', label: 'Net Life Recovery', fmt: '+.1f', color: COLOUR.life },
      { stat: 'NetManaRegen', label: 'Net Mana Recovery', fmt: '+.1f', color: COLOUR.mana },
      { stat: 'NetEnergyShieldRegen', label: 'Net ES Recovery', fmt: '+.1f', color: COLOUR.es },
      { stat: 'Evasion', label: 'Evasion rating', fmt: 'd', color: COLOUR.evasion },
      { stat: 'Spec:EvasionInc', label: '%Inc Evasion from Tree', color: COLOUR.evasion, fmt: 'd%%' },
      { stat: 'MeleeEvadeChance', label: 'Evade Chance', fmt: 'd%%', color: COLOUR.evasion, cond: (v, o) => v > 0 && eq(o, 'MeleeEvadeChance', 'ProjectileEvadeChance') },
      { stat: 'MeleeEvadeChance', label: 'Melee Evade Chance', fmt: 'd%%', color: COLOUR.evasion, cond: (v, o) => v > 0 && !eq(o, 'MeleeEvadeChance', 'ProjectileEvadeChance') },
      { stat: 'ProjectileEvadeChance', label: 'Projectile Evade Chance', fmt: 'd%%', color: COLOUR.evasion, cond: (v, o) => v > 0 && !eq(o, 'MeleeEvadeChance', 'ProjectileEvadeChance') },
      { stat: 'Armour', label: 'Armour', fmt: 'd' },
      { stat: 'Spec:ArmourInc', label: '%Inc Armour from Tree', fmt: 'd%%' },
      { stat: 'PhysicalDamageReduction', label: 'Phys. Damage Reduction', fmt: 'd%%', cond: () => true },
      { stat: 'EffectiveBlockChance', label: 'Block Chance', fmt: '.3f%%' },
      { stat: 'EffectiveSpellBlockChance', label: 'Spell Block Chance', fmt: '.3f%%' },
      { stat: 'AttackDodgeChance', label: 'Attack Dodge Chance', fmt: 'd%%' },
      { stat: 'SpellDodgeChance', label: 'Spell Dodge Chance', fmt: 'd%%' },
      { stat: 'EffectiveSpellSuppressionChance', label: 'Spell Suppression Chance', fmt: '.2f%%' },
    ]),
  ];
}

function resistances(): DisplayStat[] {
  return rows('u', [
    { stat: 'FireResist', label: 'Fire Resistance', fmt: 'd%%', color: COLOUR.fire, cond: () => true },
    { stat: 'ColdResist', label: 'Cold Resistance', fmt: 'd%%', color: COLOUR.cold, cond: () => true },
    { stat: 'LightningResist', label: 'Lightning Resistance', fmt: 'd%%', color: COLOUR.lightning, cond: () => true },
    { stat: 'ChaosResist', label: 'Chaos Resistance', fmt: 'd%%', color: COLOUR.chaos },
    { stat: 'EffectiveMovementSpeedMod', label: 'Movement Speed Modifier', fmt: '+d%%', mod: true, cond: () => true },
  ]);
}

function fullDps(): DisplayStat[] {
  return rows('o', [
    { stat: 'FullDPS', label: 'Full DPS', fmt: '.1f', compact: true, color: COLOUR.currency },
    { stat: 'FullDotDPS', label: 'Full Dot DPS', fmt: '.1f', compact: true, color: COLOUR.currency, cond: (v) => v >= 35791394 },
  ]);
}

export const DISPLAY_STATS: DisplayStat[] = [...offence(), ...utility(), ...defence(), ...resistances(), ...fullDps()];

/** The output as the rows read it: numbers, with "Inf" and "-Inf" as infinities. */
export function toOut(stats: Record<string, unknown>): Out {
  const out: Out = {};
  for (const [k, v] of Object.entries(stats)) out[k] = v === 'Inf' ? Infinity : v === '-Inf' ? -Infinity : v;
  return out;
}

/** The skill flags the output reveals (see the file comment). */
export function skillFlags(o: Out): Set<string> {
  const f = new Set<string>();
  const attack = typeof o.MainHand === 'object' && o.MainHand !== null;
  if (attack) f.add('attack');
  if (typeof o.CastRate === 'number') f.add('spell');
  if (attack || f.has('spell') || o.AverageHit !== undefined) f.add('hit');
  const rate = num(o, 'Speed') > 0;
  f.add(rate ? 'notAverage' : 'showAverage');
  if (rate) f.add('notAveragePvP');
  return f;
}

const UNKNOWN_FLAGS = new Set(['isPvP', 'attackPvP', 'notAveragePvP', 'monsterExplode', 'channelRelease', 'warcry', 'brand', 'impale', 'mirageArcher', 'wisp', 'poison']);

function flagOk(d: DisplayStat, flags: Set<string>, ownValue: boolean): boolean {
  if (d.flag && !(flags.has(d.flag) || (UNKNOWN_FLAGS.has(d.flag) && ownValue))) return false;
  if (d.notFlag && flags.has(d.notFlag)) return false;
  return true;
}

export interface StatLine {
  /** Index into DISPLAY_STATS. */
  key: string;
  stat: string;
  label: string;
  color: string | undefined;
  group: DisplayStat['group'];
  a: number;
  b: number;
  fmt: string;
  compact: boolean;
  lowerIsBetter: boolean;
  /** Multiplier applied to a value before it is shown (100 for percentages held as fractions). */
  scale: number;
  /** For `mod` stats the amount taken off the scaled value. */
  offset: number;
}

function valueOf(d: DisplayStat, o: Out): number {
  let v = o[d.stat ?? ''];
  if (d.childStat) v = typeof v === 'object' && v !== null ? (v as Record<string, unknown>)[d.childStat] : 0;
  return typeof v === 'number' && !Number.isNaN(v) ? v : 0;
}

/**
 * The rows both builds show: a row appears when either build's value is not zero, its condition holds for either,
 * and its flags fit either build's main skill (upstream's `DrawStatList`).
 */
export function statLines(a: Out, b: Out): StatLine[] {
  const fa = skillFlags(a);
  const fb = skillFlags(b);
  const out: StatLine[] = [];
  DISPLAY_STATS.forEach((d, i) => {
    if (!d.stat || d.hide || d.stat === 'SkillDPS') return;
    // A row gated on a flag the output cannot reveal is upstream's alternative to an earlier row of the same name
    // (Average Damage for attacks, then for exploding monsters): it only adds a second identical line, so it stays out.
    if (d.flag && UNKNOWN_FLAGS.has(d.flag) && out.some((l) => l.stat === d.stat && l.label === (d.label ?? d.stat))) return;
    const va = valueOf(d, a);
    const vb = valueOf(d, b);
    if (!flagOk(d, fa, va !== 0) && !flagOk(d, fb, vb !== 0)) return;
    if (va === 0 && vb === 0) return;
    if (d.cond && !d.cond(va, a) && !d.cond(vb, b)) return;
    out.push({
      key: String(i),
      stat: d.stat,
      label: d.label ?? d.stat,
      color: d.color,
      group: d.group,
      a: va,
      b: vb,
      fmt: d.fmt ?? 'd',
      compact: !!d.compact,
      lowerIsBetter: !!d.lowerIsBetter,
      scale: d.pc || d.mod ? 100 : 1,
      offset: d.mod ? 100 : 0,
    });
  });
  return out;
}

// ---- Formatting -----------------------------------------------------------------------------------------------------

const SEP = /\B(?=(\d{3})+(?!\d))/g;

function withSep(s: string): string {
  const [int, frac] = s.split('.');
  return (int ?? '').replace(SEP, ',') + (frac !== undefined ? '.' + frac : '');
}

/** "712.3k" or "4.29M" for large numbers; the number itself otherwise. */
export function compactNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e5) return Math.round(n / 1e3) + 'k';
  if (a >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return withSep(String(Math.round(n * 100) / 100));
}

/** A value with the row's C-style format ("d", ".2f%%", "+.1f", ".3fs"); an infinity reads as ∞. */
export function formatStat(value: number, fmt: string, scale = 1, offset = 0, compact = false): string {
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '-∞';
  const m = /^(\+?)(?:\.(\d+))?([df])(.*)$/.exec(fmt);
  const plus = m?.[1] === '+';
  const decimals = m?.[3] === 'd' ? 0 : Number(m?.[2] ?? 6);
  const suffix = (m?.[4] ?? '').replace(/%%/g, '%');
  const v = value * scale - offset;
  const body = compact && Math.abs(v) >= 1e4 ? compactNumber(v) : withSep(v.toFixed(decimals));
  return (plus && v > 0 ? '+' : '') + body.replace(/^-/, '−') + suffix;
}

/** The exact value, for a tooltip. */
export function exactStat(value: number, fmt: string, scale = 1, offset = 0): string {
  return formatStat(value, fmt, scale, offset, false);
}

export interface StatDelta {
  /** "+1.2M (+14%)", or "—" when equal. */
  text: string;
  /** 1 when A is better than B, -1 when worse, 0 when equal. */
  better: -1 | 0 | 1;
  /** Relative size of the difference, for ordering. */
  magnitude: number;
}

/** A minus B, with a percentage of B when B is not zero. */
export function statDelta(l: StatLine): StatDelta {
  const d = (l.a - l.b) * l.scale;
  if (!Number.isFinite(d) || Math.abs(d) < 1e-9 || (Math.abs(d) < 0.001 && l.scale === 1)) return { text: '—', better: 0, magnitude: 0 };
  const sign = d > 0 ? '+' : '−';
  const m = /^\+?(?:\.(\d+))?([df])(.*)$/.exec(l.fmt);
  const decimals = m?.[2] === 'd' ? 0 : Number(m?.[1] ?? 1);
  const suffix = (m?.[3] ?? '').replace(/%%/g, '%');
  const abs = Math.abs(d);
  const body = l.compact && abs >= 1e4 ? compactNumber(abs) : withSep(abs.toFixed(decimals));
  // A change that rounds to zero in the shown precision is no change ("−0%"), not a signed zero.
  if (!l.compact && Number(abs.toFixed(decimals)) === 0) return { text: '—', better: 0, magnitude: 0 };
  const percentStat = suffix === '%';
  const pct = !percentStat && l.b !== 0 ? Math.round(((l.a - l.b) / Math.abs(l.b)) * 1000) / 10 : null;
  const text = `${sign}${body}${suffix}${pct !== null ? ` (${pct > 0 ? '+' : '−'}${Math.abs(pct)}%)` : ''}`;
  const better = (l.lowerIsBetter ? d < 0 : d > 0) ? 1 : -1;
  return { text, better, magnitude: l.b !== 0 ? Math.abs((l.a - l.b) / l.b) : abs > 0 ? 9 : 0 };
}
