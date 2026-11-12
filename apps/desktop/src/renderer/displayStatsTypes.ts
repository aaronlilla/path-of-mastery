// Types for the sidebar's display stats (upstream's Modules/BuildDisplayStats.lua `DisplayStat`).

/** An actor's output: the engine's stat map (numbers, booleans, text, and tables such as `MainHand`). */
export type Output = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Upstream's colorCodes names the display stats use. */
export type ColorName =
  | 'CHAOS' | 'COLD' | 'CURRENCY' | 'DEXTERITY' | 'ES' | 'EVASION' | 'FIRE' | 'INTELLIGENCE' | 'LIFE'
  | 'LIGHTNING' | 'MANA' | 'PHYS' | 'RAGE' | 'RARE' | 'STRENGTH' | 'WARD';

export interface DisplayStat {
  stat?: string;
  childStat?: string;
  label?: string;
  fmt?: string;
  breakdown?: string;
  modNames?: string[];
  ignoredSections?: string[];
  color?: ColorName;
  flag?: string;
  notFlag?: string;
  condFunc?: (v: any, o: Output) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
  warnFunc?: (v: any, o: Output) => string | false | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  warnColor?: boolean;
  suffix?: string | ((v: number, o: Output) => string | undefined);
  suffixCondFunc?: (v: any, o: Output) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
  overCapStat?: string;
  overCapStatCondFunc?: (v: any, o: Output) => boolean; // eslint-disable-line @typescript-eslint/no-explicit-any
  compactValue?: boolean;
  compPercent?: boolean;
  lowerIsBetter?: boolean;
  pc?: boolean;
  mod?: boolean;
  hideStat?: boolean;
  chaosInoc?: boolean;
  pool?: string;
  labelStat?: string;
  val?: string;
}
