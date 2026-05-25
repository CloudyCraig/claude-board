import { Manifest } from "./types";

/**
 * Polar auto-layout.
 *
 * Cards are placed in concentric rings around Odin. The ring a card
 * lands on encodes its urgency:
 *
 *   ring 0 (innermost)  — blocked_on_user (your attention required)
 *   ring 1              — active sessions
 *   ring 2              — blocked / idle
 *   ring 3 (outermost)  — done
 *
 * **Collision avoidance.** The old version put every status group in a
 * single ring with fixed radii. As soon as a ring had ≥ 3 cards the
 * cards overlapped each other because the arc length per card became
 * smaller than the card width. The new version computes, for each
 * ring, the *maximum* number of cards that fit at its radius (chord-
 * arc approximation), and overflows the rest onto the next ring out.
 *
 * Result: 8 cards on a typical desktop window land 4-and-4 in two
 * concentric rings, with breathing room between every card and a
 * clear empty zone around Odin's silhouette.
 *
 * Dragged-by-user overrides are applied in App.tsx *after* this
 * function runs, so this code stays a pure function of (manifests,
 * stage size).
 */

export interface LaidOutCard {
  manifest: Manifest;
  x: number;
  y: number;
  ring: number;          // 0..3 — semantic ring (status priority)
}

// Card geometry — kept in sync with `.card` width / typical height in
// styles.css. Used for collision math. A 24-pixel gap is enforced
// between cards both angularly and radially.
const CARD_W   = 280;
const CARD_H   = 170;
const GAP      = 28;

// Empty zone around Odin's silhouette so the inner ring doesn't
// overlap him. Odin's image is 260px square; the radius needs to
// clear that + leave the card body unstacked on top of him.
const ODIN_RADIUS = 170;

// Hard cap on rings so a misconfigured board with hundreds of
// manifests doesn't explode the layout.
const MAX_RINGS = 6;

export function ringFor(m: Manifest): number {
  if (m.blocked_on_user)                                 return 0;
  if (m.status === "active")                             return 1;
  if (m.status === "blocked" || m.status === "idle")     return 2;
  return 3;
}

function priorityKey(m: Manifest): number {
  // Lower = closer to Odin. Cards with the same ring sort by
  // project + session_id so order stays stable across refreshes.
  return ringFor(m);
}

/**
 * Max cards that fit at radius `r` without overlap. Approximation:
 * the chord between two cards at angular step θ has length 2r·sin(θ/2);
 * we require that length ≥ CARD_W + GAP. Solve for θ → divide 2π.
 */
function capacityAt(r: number): number {
  if (r <= 0) return 1;
  const minChord = CARD_W + GAP;
  // Guard against asin domain errors when r is tiny.
  const ratio = Math.min(1, minChord / (2 * r));
  const minStep = 2 * Math.asin(ratio);
  return Math.max(1, Math.floor((2 * Math.PI) / minStep));
}

export function layout(
  manifests: Manifest[],
  stageW: number,
  stageH: number,
): LaidOutCard[] {
  if (manifests.length === 0) return [];

  const cx = stageW / 2;
  const cy = stageH / 2;

  // Sort by status priority first, then by project+session for
  // stability so a refresh doesn't shuffle cards within the same
  // ring.
  const sorted = [...manifests].sort((a, b) => {
    const pa = priorityKey(a);
    const pb = priorityKey(b);
    if (pa !== pb) return pa - pb;
    const pp = (a.project ?? "").localeCompare(b.project ?? "");
    if (pp !== 0) return pp;
    return a.session_id.localeCompare(b.session_id);
  });

  const out: LaidOutCard[] = [];
  let placed = 0;
  let visualRing = 0;

  while (placed < sorted.length && visualRing < MAX_RINGS) {
    const r       = ODIN_RADIUS + visualRing * (CARD_H + GAP) + CARD_H / 2;
    const cap     = capacityAt(r);
    const remain  = sorted.length - placed;
    const inRing  = Math.min(cap, remain);
    const step    = (2 * Math.PI) / inRing;
    // Stagger every other ring by half-step so cards on adjacent
    // rings don't sit on the same radial line.
    const start   = -Math.PI / 2 + (visualRing % 2 ? step / 2 : 0);

    for (let i = 0; i < inRing; i++) {
      const angle = start + i * step;
      const m = sorted[placed + i];
      out.push({
        manifest: m,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        ring: ringFor(m),
      });
    }
    placed += inRing;
    visualRing++;
  }

  // If we hit MAX_RINGS and still have cards, drop them on the
  // outermost ring overlapping — better than dropping them entirely.
  if (placed < sorted.length) {
    const r = ODIN_RADIUS + (MAX_RINGS - 1) * (CARD_H + GAP) + CARD_H / 2;
    const remain = sorted.length - placed;
    const step = (2 * Math.PI) / remain;
    for (let i = 0; i < remain; i++) {
      const angle = -Math.PI / 2 + i * step;
      const m = sorted[placed + i];
      out.push({
        manifest: m,
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        ring: ringFor(m),
      });
    }
  }

  // Clamp so half-cards don't drift off-stage on very narrow
  // windows. Cards are anchored centre via translate(-50%, -50%),
  // so we just need half-width / half-height padding.
  const padX = CARD_W / 2 + 8;
  const padY = CARD_H / 2 + 8;
  return out.map((c) => ({
    ...c,
    x: Math.max(padX, Math.min(stageW - padX, c.x)),
    y: Math.max(padY, Math.min(stageH - padY, c.y)),
  }));
}
