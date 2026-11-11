import { memo } from 'react';
import { codeColour, parseNotes } from '../shared/notesColour';

/** Text with colour codes (`^7`, `^xE05030`) drawn as coloured spans. `base` colours the text before the first code. */
export const ColorText = memo(function ColorText({ text, base }: { text: string; base?: string }) {
  const segs = parseNotes(text);
  if (segs.length === 1 && !segs[0]!.code) return <>{segs[0]!.text}</>;
  return (
    <>
      {segs.map((s, i) => {
        const c = codeColour(s.code);
        return c || base ? (
          <span key={i} style={{ color: c ?? base }}>
            {s.text}
          </span>
        ) : (
          s.text
        );
      })}
    </>
  );
});
