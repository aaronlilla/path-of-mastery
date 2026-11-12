import type { StepId } from '@pom/mastery-contracts';
import type { AtlasWindow, LevelInterval, LevelWindow } from './types.js';

export function medianActiveSecondsPerLevel(intervals: readonly LevelInterval[]): number | null {
  const seen = new Set<number>();
  const samples = intervals.flatMap(interval => {
    if (!interval.reliable || !Number.isInteger(interval.fromLevel) || interval.fromLevel < 1 ||
      interval.toLevel !== interval.fromLevel + 1 || interval.toLevel > 100 ||
      !Number.isFinite(interval.elapsedSeconds) || interval.elapsedSeconds <= 0 ||
      interval.inactivitySeconds.some(seconds => !Number.isFinite(seconds) || seconds < 0)) return [];
    const inactive = interval.inactivitySeconds.reduce((sum, seconds) => sum + (seconds > 600 ? seconds : 0), 0);
    const active = interval.elapsedSeconds - inactive;
    if (active <= 0 || seen.has(interval.fromLevel)) return [];
    seen.add(interval.fromLevel);
    return [active];
  });
  if (samples.length < 3) return null;
  samples.sort((a, b) => a - b);
  const middle = Math.floor(samples.length / 2);
  return samples.length % 2 ? samples[middle]! : (samples[middle - 1]! + samples[middle]!) / 2;
}

function earlySize(pace: readonly LevelInterval[]): 4 | 6 | 8 | 10 {
  const seconds = medianActiveSecondsPerLevel(pace);
  if (seconds === null) return 10;
  const target = 240 / seconds;
  return ([10, 8, 6, 4] as const).reduce((best, size) =>
    Math.abs(size - target) < Math.abs(best - target) ? size : best, 10 as 4 | 6 | 8 | 10);
}

function partition(start: number, end: number, size: number, cap: number, landmarks: readonly number[]): LevelWindow[] {
  const result: LevelWindow[] = [];
  while (start < end) {
    const remaining = end - start;
    if (remaining < 4) throw new Error('Presented boundaries leave fewer than four levels.');
    if (remaining <= size || remaining < size + 4 && remaining <= cap) {
      result.push({ start, endExclusive: end });
      break;
    }
    let boundary = Math.min(start + size, end);
    const landmark = landmarks.find(level => level >= start + 4 && level <= boundary);
    if (landmark !== undefined) boundary = landmark;
    if (end - boundary < 4) boundary = end - 4;
    result.push({ start, endExclusive: boundary });
    start = boundary;
  }
  return result;
}

export function characterWindows(options: {
  size?: 4 | 6 | 8 | 10; pace?: readonly LevelInterval[]; landmarks?: readonly number[];
  presented?: readonly LevelWindow[];
} = {}): LevelWindow[] {
  if (options.size !== undefined && ![4, 6, 8, 10].includes(options.size)) throw new Error('Invalid character chunk size.');
  const landmarks = [...new Set(options.landmarks ?? [])].sort((a, b) => a - b);
  if (landmarks.some(level => !Number.isInteger(level) || level < 1 || level > 101)) throw new Error('Invalid landmark level.');
  const frozen = structuredClone([...(options.presented ?? [])]).sort((a, b) => a.start - b.start);
  for (const [i, window] of frozen.entries()) {
    if (!Number.isInteger(window.start) || !Number.isInteger(window.endExclusive) || window.start < 1 || window.endExclusive > 101 ||
      window.endExclusive - window.start < 4 || i > 0 && frozen[i - 1]!.endExclusive > window.start ||
      [68, 80].some(boundary => window.start < boundary && boundary < window.endExclusive)) throw new Error('Invalid presented level window.');
  }
  const result: LevelWindow[] = [];
  const phases = [{ start: 1, end: 68, size: options.size ?? earlySize(options.pace ?? []), cap: 10 },
    { start: 68, end: 80, size: Math.min(options.size ?? 6, 6), cap: 6 },
    { start: 80, end: 101, size: 4, cap: 5 }];
  for (const phase of phases) {
    let cursor = phase.start;
    for (const window of frozen.filter(window => window.start >= phase.start && window.endExclusive <= phase.end)) {
      result.push(...partition(cursor, window.start, phase.size, phase.cap, phase.start === 1 ? landmarks : []), window);
      cursor = window.endExclusive;
    }
    result.push(...partition(cursor, phase.end, phase.size, phase.cap, phase.start === 1 ? landmarks : []));
  }
  return result;
}

export function atlasWindows(stepId: StepId, fromPoints: number, toPoints: number, maxWindows: number): AtlasWindow[] {
  if (![fromPoints, toPoints].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid allocated point span.');
  if (!Number.isSafeInteger(maxWindows) || maxWindows < 1 || Math.max(1, Math.ceil(Math.abs(toPoints - fromPoints) / 10)) > maxWindows) {
    throw new Error('Atlas chunk count exceeds the configured limit.');
  }
  if (fromPoints === toPoints) return [{ stepId, fromPoints, toPoints }];
  const direction = Math.sign(toPoints - fromPoints), result: AtlasWindow[] = [];
  while (fromPoints !== toPoints) {
    const next = fromPoints + direction * Math.min(10, Math.abs(toPoints - fromPoints));
    result.push({ stepId, fromPoints, toPoints: next });
    fromPoints = next;
  }
  return result;
}
