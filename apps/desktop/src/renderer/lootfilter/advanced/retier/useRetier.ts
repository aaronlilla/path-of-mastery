import { useMemo } from 'react';
import { computeRetier, type RetierResult } from './compute';
import { useLf } from '../../lfStore';

export * from './compute';

export function useRetier(): RetierResult {
  const lf = useLf();
  const rules = lf.doc.rules;
  const cat = lf.catalog;
  const prices = lf.prices;
  return useMemo<RetierResult>(() => computeRetier(cat, prices, rules), [cat, prices, rules]);
}
