import { useCallback } from 'react';
import { useToast, type ToastSpec } from '../../ui';

/** The Simple screens show one message at a time: a new one replaces the old one instead of stacking under it. */
export function useSay(): (s: ToastSpec) => void {
  const toast = useToast();
  return useCallback((s: ToastSpec) => toast({ key: 'lf-simple', ...s }), [toast]);
}
