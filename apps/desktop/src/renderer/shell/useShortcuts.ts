/** True when a key event's target is a text field, where a shortcut must leave typing alone. The app's one shortcut table
 *  lives in App.tsx; this helper is all that is left of the second, unused table. */
export function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const input = target.closest('input');
  if (input) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(input.type);
  return !!target.closest('textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
}
