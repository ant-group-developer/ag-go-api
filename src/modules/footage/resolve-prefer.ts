/**
 * Which file a preview render reads when the caller says what it prefers (AG Studio sends `{ short_edge: 480,
 * clean: true }` for previews): a clean rendition first when the viewer may see one, then the short edge equal to the
 * target, else the smallest above it, else the largest below. Between files of the same size the smallest kind wins
 * (a preview variant before the analysis proxy before the original).
 */
export type RenditionKind = 'preview' | 'proxy' | 'original';

export interface Rendition<T> {
  kind: RenditionKind;
  /** Short edge in pixels; null when not known (it is then taken only when no size is known). */
  shortEdge: number | null;
  watermarked: boolean;
  ref: T;
}

export interface ResolvePrefer {
  short_edge?: number;
  clean?: boolean;
}

const KIND_ORDER: Record<RenditionKind, number> = { preview: 0, proxy: 1, original: 2 };
const byKind = <T>(a: Rendition<T>, b: Rendition<T>) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind];

export function pickRendition<T>(
  candidates: readonly Rendition<T>[],
  prefer: ResolvePrefer,
): Rendition<T> | undefined {
  if (!candidates.length) return undefined;
  const clean = candidates.filter((c) => !c.watermarked);
  const pool = prefer.clean && clean.length ? clean : [...candidates];
  const known = pool.filter((c) => c.shortEdge !== null && c.shortEdge > 0);
  if (!known.length) return [...pool].sort(byKind)[0];
  const target = prefer.short_edge ?? Number.POSITIVE_INFINITY;
  const exact = known.filter((c) => c.shortEdge === target).sort(byKind);
  if (exact.length) return exact[0];
  const above = known
    .filter((c) => c.shortEdge! > target)
    .sort((a, b) => a.shortEdge! - b.shortEdge! || byKind(a, b));
  if (above.length) return above[0];
  return known.sort((a, b) => b.shortEdge! - a.shortEdge! || byKind(a, b))[0];
}

/** Short edge of a width × height, null when unknown. */
export function shortEdgeOf(width: unknown, height: unknown): number | null {
  const w = typeof width === 'number' && width > 0 ? width : null;
  const h = typeof height === 'number' && height > 0 ? height : null;
  if (w && h) return Math.min(w, h);
  return w ?? h;
}
