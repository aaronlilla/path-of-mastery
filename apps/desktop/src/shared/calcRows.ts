/**
 * The Compare tab's Calcs view: the build's calculation results in upstream's section groups, side by side. Each
 * row is one output stat of the engine, with upstream's label and number format. The section rows with the
 * breakdowns behind each number (CalcSections.lua) arrive with the Calcs tab; this view compares the results only.
 */
export interface CalcRow {
  label: string;
  stat: string;
  fmt: string;
  /** Percentages the engine holds as fractions. */
  pc?: boolean;
  icon?: string;
  colour?: string;
}

export interface CalcSection {
  title: string;
  icon: string;
  colour: string;
  rows: CalcRow[];
}

export const CALC_SECTIONS: CalcSection[] = [
  {
    title: 'Skill Hit Damage',
    icon: 'melee',
    colour: 'var(--stat-dps)',
    rows: [
      { label: 'Physical Hit', stat: 'PhysicalHitAverage', fmt: '.1f', icon: 'physical', colour: 'var(--dmg-physical)' },
      { label: 'Lightning Hit', stat: 'LightningHitAverage', fmt: '.1f', icon: 'lightning', colour: 'var(--dmg-lightning)' },
      { label: 'Cold Hit', stat: 'ColdHitAverage', fmt: '.1f', icon: 'cold', colour: 'var(--dmg-cold)' },
      { label: 'Fire Hit', stat: 'FireHitAverage', fmt: '.1f', icon: 'fire', colour: 'var(--dmg-fire)' },
      { label: 'Chaos Hit', stat: 'ChaosHitAverage', fmt: '.1f', icon: 'chaos', colour: 'var(--dmg-chaos)' },
      { label: 'Average Hit', stat: 'AverageHit', fmt: '.1f' },
      { label: 'Average Damage', stat: 'AverageDamage', fmt: '.1f' },
    ],
  },
  {
    title: 'Damage per second',
    icon: 'melee',
    colour: 'var(--stat-dps)',
    rows: [
      { label: 'Hit DPS', stat: 'TotalDPS', fmt: '.1f' },
      { label: 'Total DoT DPS', stat: 'TotalDot', fmt: '.1f' },
      { label: 'Bleed DPS', stat: 'BleedDPS', fmt: '.1f' },
      { label: 'Ignite DPS', stat: 'IgniteDPS', fmt: '.1f' },
      { label: 'Poison DPS', stat: 'PoisonDPS', fmt: '.1f' },
      { label: 'Combined DPS', stat: 'CombinedDPS', fmt: '.1f' },
      { label: 'Full DPS', stat: 'FullDPS', fmt: '.1f' },
    ],
  },
  {
    title: 'Attack/Cast Rate',
    icon: 'speed',
    colour: 'var(--stat-speed)',
    rows: [
      { label: 'Attacks or casts per second', stat: 'Speed', fmt: '.2f', icon: 'speed', colour: 'var(--stat-speed)' },
      { label: 'Hit Rate', stat: 'HitSpeed', fmt: '.2f' },
      { label: 'Skill Cooldown', stat: 'Cooldown', fmt: '.3fs' },
      { label: 'Hit Chance', stat: 'HitChance', fmt: '.0f%%' },
    ],
  },
  {
    title: 'Crits',
    icon: 'crit',
    colour: 'var(--stat-crit)',
    rows: [
      { label: 'Crit Chance', stat: 'PreEffectiveCritChance', fmt: '.2f%%', icon: 'crit', colour: 'var(--stat-crit)' },
      { label: 'Effective Crit Chance', stat: 'CritChance', fmt: '.2f%%' },
      { label: 'Crit Multiplier', stat: 'CritMultiplier', fmt: 'd%%', pc: true },
    ],
  },
  {
    title: 'Life',
    icon: 'life',
    colour: 'var(--pool-life)',
    rows: [
      { label: 'Total Life', stat: 'Life', fmt: 'd', icon: 'life', colour: 'var(--pool-life)' },
      { label: 'Unreserved Life', stat: 'LifeUnreserved', fmt: 'd' },
      { label: 'Regen', stat: 'LifeRegenRecovery', fmt: '.1f' },
      { label: 'Leech Rate', stat: 'LifeLeechGainRate', fmt: '.1f', icon: 'leech', colour: 'var(--pool-life)' },
    ],
  },
  {
    title: 'Mana',
    icon: 'mana',
    colour: 'var(--pool-mana)',
    rows: [
      { label: 'Total Mana', stat: 'Mana', fmt: 'd' },
      { label: 'Unreserved Mana', stat: 'ManaUnreserved', fmt: 'd' },
      { label: 'Regen', stat: 'ManaRegenRecovery', fmt: '.1f' },
      { label: 'Leech Rate', stat: 'ManaLeechGainRate', fmt: '.1f' },
    ],
  },
  {
    title: 'Energy Shield',
    icon: 'energy-shield',
    colour: 'var(--pool-es)',
    rows: [
      { label: 'Energy Shield', stat: 'EnergyShield', fmt: 'd' },
      { label: 'Regen', stat: 'EnergyShieldRegenRecovery', fmt: '.1f' },
      { label: 'Leech Rate', stat: 'EnergyShieldLeechGainRate', fmt: '.1f' },
    ],
  },
  {
    title: 'Resists',
    icon: 'resist',
    colour: 'var(--dmg-fire)',
    rows: [
      { label: 'Fire Resistance', stat: 'FireResist', fmt: 'd%%', icon: 'fire', colour: 'var(--dmg-fire)' },
      { label: 'Cold Resistance', stat: 'ColdResist', fmt: 'd%%', icon: 'cold', colour: 'var(--dmg-cold)' },
      { label: 'Lightning Resistance', stat: 'LightningResist', fmt: 'd%%', icon: 'lightning', colour: 'var(--dmg-lightning)' },
      { label: 'Chaos Resistance', stat: 'ChaosResist', fmt: 'd%%', icon: 'chaos', colour: 'var(--dmg-chaos)' },
    ],
  },
  {
    title: 'Armour and Evasion',
    icon: 'armour',
    colour: 'var(--stat-armour)',
    rows: [
      { label: 'Armour', stat: 'Armour', fmt: 'd', icon: 'armour', colour: 'var(--stat-armour)' },
      { label: 'Evasion Rating', stat: 'Evasion', fmt: 'd', icon: 'evasion', colour: 'var(--stat-evasion)' },
      { label: 'Evade Chance', stat: 'MeleeEvadeChance', fmt: 'd%%' },
      { label: 'Phys. Damage Reduction', stat: 'PhysicalDamageReduction', fmt: 'd%%' },
    ],
  },
  {
    title: 'Block and Suppression',
    icon: 'shield',
    colour: 'var(--stat-block)',
    rows: [
      { label: 'Block Chance', stat: 'EffectiveBlockChance', fmt: '.3f%%' },
      { label: 'Spell Block Chance', stat: 'EffectiveSpellBlockChance', fmt: '.3f%%' },
      { label: 'Attack Dodge Chance', stat: 'AttackDodgeChance', fmt: 'd%%' },
      { label: 'Spell Dodge Chance', stat: 'SpellDodgeChance', fmt: 'd%%' },
      { label: 'Spell Suppression Chance', stat: 'EffectiveSpellSuppressionChance', fmt: '.2f%%' },
    ],
  },
  {
    title: 'Damage Taken',
    icon: 'shield',
    colour: 'var(--stat-neutral)',
    rows: [
      { label: 'Effective Hit Pool', stat: 'TotalEHP', fmt: '.0f', icon: 'ehp', colour: 'var(--stat-armour)' },
      { label: 'Phys Max Hit', stat: 'PhysicalMaximumHitTaken', fmt: '.0f', icon: 'physical', colour: 'var(--dmg-physical)' },
      { label: 'Fire Max Hit', stat: 'FireMaximumHitTaken', fmt: '.0f', icon: 'fire', colour: 'var(--dmg-fire)' },
      { label: 'Cold Max Hit', stat: 'ColdMaximumHitTaken', fmt: '.0f', icon: 'cold', colour: 'var(--dmg-cold)' },
      { label: 'Lightning Max Hit', stat: 'LightningMaximumHitTaken', fmt: '.0f', icon: 'lightning', colour: 'var(--dmg-lightning)' },
      { label: 'Chaos Max Hit', stat: 'ChaosMaximumHitTaken', fmt: '.0f', icon: 'chaos', colour: 'var(--dmg-chaos)' },
    ],
  },
  {
    title: 'Attributes',
    icon: 'user',
    colour: 'var(--text-2)',
    rows: [
      { label: 'Strength', stat: 'Str', fmt: 'd', colour: 'var(--attr-str)' },
      { label: 'Dexterity', stat: 'Dex', fmt: 'd', colour: 'var(--attr-dex)' },
      { label: 'Intelligence', stat: 'Int', fmt: 'd', colour: 'var(--attr-int)' },
    ],
  },
];
