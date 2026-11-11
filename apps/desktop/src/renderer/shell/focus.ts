export type FocusReturn = { restore: () => boolean };
export function captureFocus(root: Document = document): FocusReturn {
  const element = root.activeElement;
  if (!(element instanceof HTMLElement)) return { restore: () => false };
  const text = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element : null;
  const start = text?.selectionStart;
  const end = text?.selectionEnd;
  const direction = text?.selectionDirection;
  return { restore: () => {
    if (!element.isConnected) return false;
    element.focus({ preventScroll: true });
    if (text && start != null && end != null) text.setSelectionRange(start, end, direction ?? undefined);
    return root.activeElement === element;
  } };
}
