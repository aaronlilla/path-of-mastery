import { useEffect, useState } from 'react';

const sheets = new Map<string, Promise<[number, number] | null>>();

/** A passive node's own icon, cut from the tree's skill sheet (as the Compare tab does). Nothing drawn when the sheet is not installed. */
export function NodeIcon({ sprite, size = 20 }: { version?: string; sprite: [number, number, number]; size?: number }) {
  // The bundled skill sheet is shared by every tree version.
  const url = 'game/tree/skills-3.jpg';
  const [dims, setDims] = useState<[number, number] | null>(null);
  useEffect(() => {
    let live = true;
    let p = sheets.get(url);
    if (!p) {
      p = new Promise((res) => {
        const im = new Image();
        im.onload = () => res([im.naturalWidth, im.naturalHeight]);
        im.onerror = () => res(null);
        im.src = url;
      });
      sheets.set(url, p);
    }
    void p.then((d) => live && setDims(d));
    return () => {
      live = false;
    };
  }, [url]);
  if (!dims) return <span style={{ flex: 'none', width: size, height: size }} />;
  const k = size / sprite[2];
  return (
    <span
      style={{
        flex: 'none',
        width: size,
        height: size,
        borderRadius: '50%',
        backgroundImage: `url(${url})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${(dims[0] * k).toFixed(1)}px ${(dims[1] * k).toFixed(1)}px`,
        backgroundPosition: `${(-sprite[0] * k).toFixed(1)}px ${(-sprite[1] * k).toFixed(1)}px`,
        boxShadow: '0 0 0 1px rgba(var(--accent-rgb),.45)',
      }}
    />
  );
}
