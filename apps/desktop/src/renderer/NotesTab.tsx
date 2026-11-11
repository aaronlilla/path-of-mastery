import { useCallback, useEffect, useRef, useState } from 'react';
import { codeColour, NAMED_COLOURS, parseNotes, serializeNotes, type Segment } from '../shared/notesColour';
import { getNotes } from '../shared/buildXml';
import { Icon, Switch } from './ui';
import { tr } from './i18n';

const clampFs = (n: number) => Math.max(10, Math.min(32, n));
const PLACEHOLDER = tr('NotesTab.write_notes_for_this_build');

function makeSpan(code: string | null, text: string): HTMLElement | Text {
  const colour = codeColour(code);
  if (!code || !colour) return document.createTextNode(text);
  const sp = document.createElement('span');
  sp.dataset.c = code;
  sp.style.color = colour;
  sp.textContent = text;
  return sp;
}

/** Fills the editor from a build file's notes text. Built with text nodes only, so notes can never inject markup. */
function fill(el: HTMLElement, text: string): void {
  const nodes = parseNotes(text).map((s) => makeSpan(s.code, s.text));
  el.replaceChildren(...nodes);
}

/** Reads the editor back into notes text, keeping each run's original colour code. */
function read(el: HTMLElement): string {
  const segs: Segment[] = [];
  const walk = (n: Node, code: string | null, lineStart: { v: boolean }) => {
    if (n.nodeType === Node.TEXT_NODE) {
      const t = n.textContent ?? '';
      if (t) {
        segs.push({ text: t, code });
        lineStart.v = t.endsWith('\n');
      }
      return;
    }
    if (!(n instanceof HTMLElement)) return;
    if (n.tagName === 'BR') {
      segs.push({ text: '\n', code });
      lineStart.v = true;
      return;
    }
    const isBlock = n.tagName === 'DIV' || n.tagName === 'P';
    if (isBlock && !lineStart.v && segs.length) segs.push({ text: '\n', code });
    const c = n.dataset.c ?? (n.style.color ? colourToCode(n.style.color) : code);
    n.childNodes.forEach((ch) => walk(ch, c, lineStart));
    if (isBlock && !lineStart.v) {
      segs.push({ text: '\n', code });
      lineStart.v = true;
    }
  };
  const lineStart = { v: true };
  el.childNodes.forEach((ch) => walk(ch, null, lineStart));
  let out = serializeNotes(segs, true);
  // A block-level line break at the very end is not part of the notes.
  if (out.endsWith('\n') && !(el.lastChild instanceof Text && (el.lastChild.textContent ?? '').endsWith('\n'))) out = out.slice(0, -1);
  return out;
}

/** An inline colour we did not set ourselves (pasted content): keep it as a hex code. */
function colourToCode(css: string): string | null {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css);
  if (!m) return null;
  const hex = [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase();
  return '^x' + hex;
}


/** The selected content as markup with every colour taken off: text (escaped) and line breaks only. */
function plainHtml(frag: DocumentFragment): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const walk = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return esc(n.textContent ?? '');
    if (n instanceof HTMLElement && n.tagName === 'BR') return '<br>';
    return [...n.childNodes].map(walk).join('');
  };
  return walk(frag);
}

/** A colour span never sits inside another colour span: split the outer one around it, so the new colour really replaces the old. */
function liftOut(sp: HTMLElement, root: HTMLElement): void {
  let parent = sp.parentElement;
  while (parent && parent !== root && parent.dataset.c !== undefined) {
    const after = parent.cloneNode(false) as HTMLElement;
    while (sp.nextSibling) after.appendChild(sp.nextSibling);
    parent.after(sp);
    if (after.childNodes.length) sp.after(after);
    if (!parent.childNodes.length) parent.remove();
    parent = sp.parentElement;
  }
}

export interface NotesTabProps {
  buildId: string;
  xml: string;
  rev: number;
  onNotes: (text: string) => void;
}

export function NotesTab({ buildId, xml, rev, onNotes }: NotesTabProps) {
  const ed = useRef<HTMLDivElement>(null);
  // The colour codes as raw text (^xRRGGBB, ^7), editable, as upstream's Show Color Codes does.
  const [raw, setRaw] = useState(false);
  // The legend of colour names is shown until Hide Color Codes is pressed (the design); the codes written out in the text are a switch under it.
  const [legend, setLegend] = useState(true);
  const rawRef = useRef(false);
  rawRef.current = raw;
  const [empty, setEmpty] = useState(true);
  const isEmpty = (t: string) => t.replace(/[\s\u200b]/g, '') === '';
  const [fs, setFs] = useState(() => {
    try {
      return clampFs(Number(localStorage.getItem('pom-notes-zoom')) || 16);
    } catch {
      return 16;
    }
  });
  const lastText = useRef<string | null>(null);
  const timer = useRef<number>(0);
  const pending = useRef(false);

  // Load the notes when a build opens, and again when its XML is replaced from outside (an import).
  useEffect(() => {
    const el = ed.current;
    if (!el) return;
    const text = getNotes(xml);
    if (lastText.current === null || text !== lastText.current) {
      if (rawRef.current) el.replaceChildren(document.createTextNode(text));
      else fill(el, text);
      lastText.current = text;
      setEmpty(isEmpty(text));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildId, rev]);

  const flush = useCallback(() => {
    window.clearTimeout(timer.current);
    if (!pending.current) return;
    pending.current = false;
    const el = ed.current;
    if (!el) return;
    const text = read(el);
    lastText.current = text;
    setEmpty(isEmpty(text));
    onNotes(text);
  }, [onNotes]);
  useEffect(() => () => flush(), [flush]);

  const schedule = () => {
    pending.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 250);
  };

  const zoom = useCallback((d: number) => {
    setFs((cur) => {
      const n = d === 0 ? 16 : clampFs(cur + d);
      try {
        localStorage.setItem('pom-notes-zoom', String(n));
      } catch {
        /* storage unavailable */
      }
      return n;
    });
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !ed.current?.offsetParent) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom(1); }
      else if (e.key === '-') { e.preventDefault(); zoom(-1); }
      else if (e.key === '0') { e.preventDefault(); zoom(0); }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [zoom]);

  useEffect(() => {
    const el = ed.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      zoom(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoom]);

  /** Typing ^x and six hex digits, or ^ and a digit, turns that into colour for the text that follows. */
  const convertTypedCode = () => {
    const el = ed.current;
    const sel = window.getSelection();
    if (!el || !sel || !sel.rangeCount) return;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return;
    const t = node.textContent ?? '';
    const m = /\^(x[0-9a-fA-F]{6}|[0-9])/.exec(t);
    if (!m) return;
    const code = m[1] === '7' ? null : '^' + (m[1]![0] === 'x' ? 'x' + m[1]!.slice(1).toUpperCase() : m[1]!);
    const before = (node as Text).splitText(m.index);
    const after = before.splitText(m[0].length);
    before.remove();
    const rest = after.textContent ?? '';
    const colour = codeColour(code);
    const sp = document.createElement('span');
    if (colour && code) {
      sp.dataset.c = code;
      sp.style.color = colour;
    }
    sp.textContent = rest || '​';
    after.replaceWith(sp);
    liftOut(sp, el);
    const r = document.createRange();
    r.setStart(sp.firstChild!, rest ? 0 : 1);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };

  const wrap = (code: string) => {
    const el = ed.current;
    if (!el) return;
    const sel = window.getSelection();
    if (!sel) return;
    if (!sel.rangeCount || !el.contains(sel.anchorNode)) {
      el.focus();
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    const r = sel.getRangeAt(0);
    const colour = codeColour(code);
    const sp = document.createElement('span');
    sp.dataset.c = code;
    sp.style.color = colour ?? 'var(--text)';
    if (r.collapsed) {
      sp.textContent = '​';
      r.insertNode(sp);
      liftOut(sp, el);
      const n = document.createRange();
      n.setStart(sp.firstChild!, 1);
      n.collapse(true);
      sel.removeAllRanges();
      sel.addRange(n);
    } else {
      // Written through the browser's own editing command, so Ctrl+Z takes the colour off again as one step.
      sp.dataset.fresh = '1';
      sp.innerHTML = plainHtml(r.cloneContents());
      el.focus();
      document.execCommand('insertHTML', false, sp.outerHTML);
      const made = el.querySelector<HTMLElement>('[data-fresh]');
      if (made) {
        delete made.dataset.fresh;
        const n = document.createRange();
        n.selectNodeContents(made);
        sel.removeAllRanges();
        sel.addRange(n);
      }
    }
    schedule();
  };

  /** Show Color Codes / Hide Color Codes: the same text with its codes written out, or coloured again. */
  const toggleRaw = () => {
    const el = ed.current;
    if (!el) return;
    const text = read(el);
    if (raw) fill(el, text);
    else el.replaceChildren(document.createTextNode(text));
    lastText.current = text;
    setRaw(!raw);
    el.focus();
  };

  /** In the raw view a colour button writes its code at the caret, or around the selection (`NotesTab:SetColor`). */
  const insertCode = (code: string) => {
    const el = ed.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    const selected = sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode) ? sel.toString() : '';
    if (!selected) return void document.execCommand('insertText', false, code);
    const last = /^[\s\S]*(\^x[0-9A-Fa-f]{6})/.exec(selected)?.[1] ?? '^7';
    document.execCommand('insertText', false, code + selected.replace(/\^x[0-9A-Fa-f]{6}/g, '') + last);
  };

  return (
    <div className="tabroot" data-screen-label="Notes / Tab / Content">
    <div className="panel" data-lg="panel">
      <div className="notes-grid" data-r="notes-grid">
        <aside className="notes-help" aria-label={tr('NotesTab.formatting_help')}>
          <span className="h"><Icon name="palette" size={13} />{tr('NotesTab.colours_and_zoom')}</span>
          <div className="p">
            <span>
              {tr('NotesTab.you_can_use')} <kbd>Ctrl +/-</kbd> {tr('NotesTab.or')} <kbd>Ctrl</kbd>{tr('NotesTab.scroll_to_zoom_in_and')} <kbd>Ctrl 0</kbd> {tr('NotesTab.to_reset')}
              <br />
              {tr('NotesTab.this_field_also_supports_different')}
              <br />
              {tr('NotesTab.below_are_some_common_color')}
            </span>
            {legend && (
              <div className="codes" onMouseDown={(e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); }}>
                {NAMED_COLOURS.map((c) => {
                  const colour = c.token === '--text' ? 'var(--text)' : `var(${c.token})`;
                  return (
                    <button key={c.label} type="button" style={{ color: colour }} onClick={() => (raw ? insertCode(c.code) : wrap(c.code))}>
                      <i style={{ background: colour }} />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            )}
            <button type="button" className="btn" data-lg="control" style={{ width: '100%' }} aria-pressed={!legend} title={legend ? tr('NotesTab.hide_the_list_of_colour') : tr('NotesTab.show_the_list_of_colour')} onClick={() => setLegend((v) => !v)}>
              <Icon name="eye" size={16} />
              {legend ? tr('NotesTab.hide_color_codes') : tr('NotesTab.show_color_codes')}
            </button>
            <label className="notes-raw" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }} title={tr('NotesTab.write_the_colour_codes_x')}>
              <Switch checked={raw} onChange={toggleRaw} label={tr('NotesTab.show_the_codes_in_the')} />
              <span>{tr('NotesTab.show_the_codes_in_the')}</span>
            </label>
          </div>
        </aside>
        <div className="notes-edbox">
        {empty && !raw && <span className="notes-ph" aria-hidden="true">{PLACEHOLDER}</span>}
        <div
          ref={ed}
          className="notes-ed"
          data-lg="tile"
          data-raw={raw ? '1' : undefined}
          role="textbox"
          aria-multiline="true"
          aria-label={tr('NotesTab.build_notes')}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          style={{ fontSize: fs }}
          onInput={() => {
            const el = ed.current;
            if (el && !(el.textContent ?? '').replace(/​/g, '').trim() && !el.querySelector('br')) el.replaceChildren();
            if (el) setEmpty(isEmpty(el.textContent ?? ''));
            if (!rawRef.current) convertTypedCode();
            schedule();
          }}
          onBlur={flush}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              e.preventDefault();
              document.execCommand('insertText', false, '    ');
            } else if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
              e.preventDefault();
              document.execCommand('insertText', false, '\n');
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
          }}
        />
        </div>
      </div>
    </div>
    </div>
  );
}
