/**
 * Pure view math for the canvas: zoom, fit, minimap mapping. No DOM, no
 * preact — unit-tested with vitest (this is where the click-bug class of
 * regression lives).
 *
 * A view is { tx, ty, scale }: screen = layout * scale + t.
 * A box is { width, height }: the canvas viewport in screen px.
 */

export const MIN_SCALE = 0.08;
export const MAX_SCALE = 2.5;

export function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/**
 * Zoom about a fixed screen point: the layout coordinate under (mx, my)
 * stays under it after scaling.
 */
export function zoomAtPoint(view, mx, my, factor) {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { scale, tx: mx - (mx - view.tx) * k, ty: my - (my - view.ty) * k };
}

/**
 * Normalize wheel deltas to pixels. deltaMode: 0 = pixels, 1 = lines
 * (external mice on Firefox), 2 = pages.
 */
export function normalizeWheel(dx, dy, deltaMode, pageH = 800) {
  const f = deltaMode === 1 ? 16 : deltaMode === 2 ? pageH : 1;
  return { dx: dx * f, dy: dy * f };
}

/**
 * Exponential zoom curve for pinch / cmd+scroll — ~7× the old 0.0015
 * strength so Mac trackpad deltas (20–50× smaller than mouse notches)
 * actually move the scale. Per-event delta is clamped so a single mouse
 * notch (~120px) stays a sane step instead of a 3× jump.
 */
export function wheelZoomFactor(dy) {
  return Math.exp(-Math.max(-60, Math.min(60, dy)) * 0.01);
}

/** Whole-graph overview (the `fit` button). */
export function fitView(layout, box, pad = 40) {
  const scale = clampScale(
    Math.min(1, (box.width - pad * 2) / layout.width, (box.height - pad * 2) / layout.height),
  );
  return {
    scale,
    tx: (box.width - layout.width * scale) / 2,
    ty: pad,
  };
}

/**
 * Opening view: readable zoom — min(1, viewportWidth / layoutWidth) — at the
 * top (first prompt) for finished runs, at the bottom (latest activity) for
 * live runs.
 */
export function initialView(layout, box, live, pad = 40) {
  const scale = clampScale(Math.min(1, box.width / layout.width));
  return {
    scale,
    tx: (box.width - layout.width * scale) / 2,
    ty: live ? box.height - (layout.height + pad) * scale : pad,
  };
}

/** View that puts layout point (cx, cy) at the center of the box. */
export function centerOn(scale, cx, cy, box) {
  return {
    scale,
    tx: box.width / 2 - cx * scale,
    ty: box.height / 2 - cy * scale,
  };
}

/**
 * Minimap frame: scale + pixel size that fits the whole layout inside
 * maxW × maxH, aspect preserved.
 */
export function minimapFrame(layoutW, layoutH, maxW = 160, maxH = 220) {
  const s = Math.min(maxW / Math.max(1, layoutW), maxH / Math.max(1, layoutH));
  return {
    s,
    w: Math.max(1, Math.round(layoutW * s)),
    h: Math.max(1, Math.round(layoutH * s)),
  };
}

/** A pixel position inside the minimap → the layout point it represents. */
export function minimapToLayout(frame, px, py) {
  return { x: px / frame.s, y: py / frame.s };
}

/** The main view's visible slice, in layout coordinates. */
export function viewportRect(view, box) {
  return {
    x: -view.tx / view.scale,
    y: -view.ty / view.scale,
    w: box.width / view.scale,
    h: box.height / view.scale,
  };
}

/** True when the whole layout is already visible — the minimap auto-hides. */
export function graphFullyVisible(view, box, layout) {
  const r = viewportRect(view, box);
  return r.x <= 0 && r.y <= 0 && r.x + r.w >= layout.width && r.y + r.h >= layout.height;
}
