import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { flushSync } from 'react-dom';
import { PassiveTree, type NodeSummary, type PassiveTreeOptions } from './PassiveTree.js';
import { useTreeBundled, versionOfBase } from '../treeVersions';
import type { JewelInfo, TreeState } from './treeTypes.js';
import { tr } from '../i18n';

export interface NodeHoverDetail {
  id: number;
  node: NodeSummary;
  sx: number;
  sy: number;
  r: number;
  /** Where the pointer is, when the pointer is what hovers the node (host pixels). */
  cx?: number;
  cy?: number;
  path: number[];
  alloc: boolean;
  dist: number;
  dependents: number[];
}

export interface AllocChangeDetail {
  count: number;
  added: number[];
  removed: number[];
  id?: number;
  mastery?: number;
}

export interface PassiveTreeViewProps extends PassiveTreeOptions {
  /** The build's tree from the engine (`treeState`). */
  state?: TreeState | null;
  /** The compared build's tree: draws the difference (green only there, red only here, blue changed). */
  compare?: TreeState | null;
  search?: string;
  /** Rings and recoloured connectors for a host-supplied difference (the design's overlay). */
  overlay?: { added?: number[]; removed?: number[]; ringsOnly?: boolean } | null;
  heat?: boolean;
  heatSingle?: boolean;
  heatTheme?: 'red-blue' | 'red-green' | 'green-blue';
  power?: Record<number, { offence: number; defence: number }> | null;
  jewelInfo?: Record<number, JewelInfo>;
  className?: string;
  style?: React.CSSProperties;
  onReady?: (tree: PassiveTree) => void;
  onNodeHover?: (detail: NodeHoverDetail) => void;
  onNodeLeave?: () => void;
  onNodeClick?: (detail: { id: number; node: NodeSummary; alloc: boolean; path: number[]; dependents: number[]; trace?: number[] }) => void;
  /** Right button released over a node (Ctrl+right click zooms out instead and sends nothing). */
  onNodeRightClick?: (detail: { id: number; node: NodeSummary; alloc: boolean; sx: number; sy: number }) => void;
  onAllocChange?: (detail: AllocChangeDetail) => void;
  onMasteryClick?: (detail: ReturnType<PassiveTree['masteryDetail']>) => void;
}

/** React mount for the WebGL2 passive tree. The ref is the PassiveTree instance (set once it exists). */
export const PassiveTreeView = forwardRef<PassiveTree | null, PassiveTreeViewProps>(function PassiveTreeView(props, ref) {
  const version = versionOfBase(props.base);
  const bundled = useTreeBundled(props.data ? null : version);
  if (bundled === null) return <div className={props.className} style={{ position: 'relative', width: '100%', height: '100%', ...props.style }} />;
  if (!bundled) {
    return (
      <div className={props.className} style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5, lineHeight: 1.55, ...props.style }} data-testid="tree-not-installed">
        <span>{tr('tree_PassiveTreeView.this_build_uses_passive_tree', { version: version?.replace('_', '.') })}</span>
      </div>
    );
  }
  return <PassiveTreeViewInner {...props} ref={ref} />;
});

const PassiveTreeViewInner = forwardRef<PassiveTree | null, PassiveTreeViewProps>(function PassiveTreeViewInner(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<PassiveTree | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  useImperativeHandle(ref, () => treeRef.current as PassiveTree, []);

  useEffect(() => {
    const host = hostRef.current!;
    const { base, fit, frame, zoom, scale, center, dx, dy, minFitScale, interactive, searchColor, masteryPicker, autoApply, maxDpr, background, data } = propsRef.current;
    const tree = new PassiveTree(host, { base, fit, frame, zoom, scale, center, dx, dy, minFitScale, interactive, searchColor, masteryPicker, autoApply, maxDpr, background, data });
    treeRef.current = tree;
    const on = <T,>(name: string, pick: (p: PassiveTreeViewProps) => ((d: T) => void) | undefined) =>
      host.addEventListener(name, (e) => pick(propsRef.current)?.((e as CustomEvent<T>).detail));
    // A hover or leave caused by the pointer or the wheel is drawn in the same frame: React renders an update from a
    // continuous event (pointermove, wheel) a frame or two later, so the tooltip trailed the tree's own highlight. Only
    // while the tree's own pointer handlers run (flagged between a capture listener and a bubble listener added once the
    // tree has bound its handlers, so it runs after them), never when a hover comes from inside a React effect, where
    // flushSync is not allowed.
    let pointer = false;
    let bound = false;
    const POINTER = ['pointerdown', 'pointermove', 'pointerup', 'pointerleave', 'wheel'];
    for (const t of POINTER) host.addEventListener(t, () => { pointer = bound; }, { capture: true, passive: true });
    void tree.ready.then(() => {
      bound = true;
      for (const t of POINTER) host.addEventListener(t, () => { pointer = false; }, { passive: true });
    });
    const now = (fn: () => void) => (pointer ? flushSync(fn) : fn());
    host.addEventListener('nodehover', (e) => { const cb = propsRef.current.onNodeHover; if (cb) now(() => cb((e as CustomEvent<NodeHoverDetail>).detail)); });
    host.addEventListener('nodeleave', () => { const cb = propsRef.current.onNodeLeave; if (cb) now(() => cb()); });
    on('nodeclick', (p) => p.onNodeClick);
    on('noderightclick', (p) => p.onNodeRightClick);
    on<AllocChangeDetail>('allocchange', (p) => p.onAllocChange);
    on('masteryclick', (p) => p.onMasteryClick);
    tree.ready.then(() => {
      if (treeRef.current !== tree) return; // torn down (the version changed) before its data arrived
      const p = propsRef.current;
      if (p.jewelInfo) tree.setJewelInfo(p.jewelInfo);
      if (p.power !== undefined) tree.setPower(p.power);
      if (p.state) tree.setState(p.state);
      if (p.compare) tree.setCompare(p.compare);
      if (p.search) tree.search = p.search;
      if (p.overlay) tree.overlay = p.overlay;
      if (p.heat) tree.heat = p.heat;
      p.onReady?.(tree);
    });
    return () => {
      tree.destroy();
      treeRef.current = null;
    };
  }, []);

  const when = (fn: (t: PassiveTree) => void) => {
    const t = treeRef.current;
    if (t) t.ready.then(() => treeRef.current === t && fn(t));
  };
  useEffect(() => when((t) => props.jewelInfo && t.setJewelInfo(props.jewelInfo)), [props.jewelInfo]);
  useEffect(() => when((t) => t.setPower(props.power ?? null)), [props.power]);
  useEffect(() => when((t) => props.state && t.setState(props.state)), [props.state]);
  useEffect(() => when((t) => t.setCompare(props.compare ?? null)), [props.compare]);
  useEffect(() => when((t) => { t.search = props.search ?? ''; }), [props.search]);
  useEffect(() => when((t) => { t.overlay = props.overlay ?? null; }), [props.overlay]);
  useEffect(() => when((t) => t.setHeatStyle(!!props.heatSingle, props.heatTheme ?? 'red-blue')), [props.heatSingle, props.heatTheme]);
  useEffect(() => when((t) => { t.heat = !!props.heat; }), [props.heat]);

  return <div ref={hostRef} className={props.className} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden', cursor: 'grab', userSelect: 'none', ...props.style }} />;
});
