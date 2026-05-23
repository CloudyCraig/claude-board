import { Manifest } from "./types";

/**
 * Polar layout maths.
 *
 * We arrange session cards in concentric rings around Odin. The
 * "ring" a card lands on encodes its urgency:
 *
 *   ring 0 (innermost)  — blocked_on_user (your attention required)
 *   ring 1              — active sessions
 *   ring 2              — blocked / idle
 *   ring 3 (outermost)  — done
 *
 * Within a ring the cards are spaced evenly around the circle, with
 * a small angular offset so identical-status cards from different
 * projects don't stack visually.
 *
 * Ring radii are picked relative to the stage so the layout
 * stretches gracefully on big monitors and compresses on laptops.
 */

export interface LaidOutCard {
  manifest: Manifest;
  x: number;
  y: number;
  ring: number;
}

const RING_FACTORS = [0.22, 0.34, 0.46, 0.58];   // fraction of min(stageW, stageH)/2

export function ringFor(m: Manifest): number {
  if (m.blocked_on_user) return 0;
  if (m.status === "active") return 1;
  if (m.status === "blocked" || m.status === "idle") return 2;
  return 3;   // done
}

export function layout(
  manifests: Manifest[],
  stageW: number,
  stageH: number,
): LaidOutCard[] {
  const cx = stageW / 2;
  const cy = stageH / 2;
  const halfMin = Math.min(stageW, stageH) / 2;

  // Group by ring so we can space evenly within each.
  const buckets: Manifest[][] = [[], [], [], []];
  for (const m of manifests) buckets[ringFor(m)].push(m);

  const out: LaidOutCard[] = [];
  for (let ring = 0; ring < buckets.length; ring++) {
    const bucket = buckets[ring];
    if (bucket.length === 0) continue;
    const r = halfMin * RING_FACTORS[ring];
    // Stable start angle per ring so cards don't shuffle on every
    // refresh. -π/2 puts the first card at 12 o'clock.
    const start = -Math.PI / 2 + ring * 0.15;
    const step = (Math.PI * 2) / bucket.length;
    bucket.forEach((m, i) => {
      const angle = start + i * step;
      out.push({
        manifest: m,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        ring,
      });
    });
  }
  return out;
}
