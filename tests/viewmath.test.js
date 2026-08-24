import { describe, expect, it } from 'vitest';
import {
  MIN_SCALE,
  MAX_SCALE,
  zoomAtPoint,
  normalizeWheel,
  wheelZoomFactor,
  fitView,
  initialView,
  READABLE_FLOOR,
  centerOn,
  minimapFrame,
  minimapToLayout,
  viewportRect,
  graphFullyVisible,
  panToReveal,
} from '../frontend/src/viewmath.js';

const box = { width: 1000, height: 700 };

/** screen position of a layout point under a view */
const toScreen = (v, x, y) => ({ x: x * v.scale + v.tx, y: y * v.scale + v.ty });

describe('zoomAtPoint', () => {
  it('keeps the layout point under the cursor fixed', () => {
    const v = { tx: 40, ty: 30, scale: 1 };
    const mx = 300;
    const my = 200;
    // layout point currently under the cursor
    const lx = (mx - v.tx) / v.scale;
    const ly = (my - v.ty) / v.scale;
    const z = zoomAtPoint(v, mx, my, 1.4);
    const p = toScreen(z, lx, ly);
    expect(p.x).toBeCloseTo(mx);
    expect(p.y).toBeCloseTo(my);
    expect(z.scale).toBeCloseTo(1.4);
  });

  it('clamps to [0.08, 2.5] and stays anchored at the clamp', () => {
    const v = { tx: 0, ty: 0, scale: 2.4 };
    const z = zoomAtPoint(v, 100, 100, 10);
    expect(z.scale).toBe(MAX_SCALE);
    const out = zoomAtPoint({ tx: 0, ty: 0, scale: 0.1 }, 100, 100, 0.001);
    expect(out.scale).toBe(MIN_SCALE);
    // at the clamp, zooming further must not translate
    const same = zoomAtPoint({ tx: 33, ty: 44, scale: MAX_SCALE }, 500, 300, 2);
    expect(same).toEqual({ tx: 33, ty: 44, scale: MAX_SCALE });
  });
});

describe('wheel normalization and zoom curve', () => {
  it('scales line-mode deltas to pixels, passes pixel-mode through', () => {
    expect(normalizeWheel(0, 3, 1).dy).toBe(48);
    expect(normalizeWheel(-2, 5, 0)).toEqual({ dx: -2, dy: 5 });
    expect(normalizeWheel(0, 1, 2, 700).dy).toBe(700);
  });

  it('is ~7× stronger than the old 0.0015 curve for trackpad deltas', () => {
    const old = Math.exp(-10 * 0.0015);
    const now = wheelZoomFactor(10);
    expect(Math.log(now) / Math.log(old)).toBeCloseTo(6.67, 1);
  });

  it('clamps a full mouse notch to a sane per-event step', () => {
    expect(wheelZoomFactor(120)).toBeCloseTo(Math.exp(-0.6));
    expect(wheelZoomFactor(-120)).toBeCloseTo(Math.exp(0.6));
    // zoom in for negative deltas, out for positive
    expect(wheelZoomFactor(-5)).toBeGreaterThan(1);
    expect(wheelZoomFactor(5)).toBeLessThan(1);
  });
});

describe('initialView (readable zoom)', () => {
  it('opens at 1:1 when the layout is narrower than the viewport', () => {
    const v = initialView({ width: 600, height: 5000 }, box, false);
    expect(v.scale).toBe(1);
    expect(v.tx).toBe(200); // horizontally centered
    expect(v.ty).toBe(40); // top of the run
  });

  it('scales down to fit width for wide layouts', () => {
    const v = initialView({ width: 2000, height: 5000 }, box, false);
    expect(v.scale).toBeCloseTo(0.5);
  });

  it('opens at the bottom (latest activity) for live runs', () => {
    const layout = { width: 600, height: 5000 };
    const v = initialView(layout, box, true);
    // bottom edge of the layout sits just above the bottom of the box
    expect((layout.height + 40) * v.scale + v.ty).toBeCloseTo(box.height);
  });

  it('never opens below the readable floor: a too-wide run opens on its anchor instead', () => {
    const v = initialView({ width: 100000, height: 100 }, box, false);
    expect(v.scale).toBe(READABLE_FLOOR);
    expect(v.tx).toBe(40); // no anchor: left edge, padded
    // With an anchor (the first node's center), that node sits mid-viewport.
    const a = initialView({ width: 100000, height: 100 }, box, false, 40, 50000);
    expect(a.scale).toBe(READABLE_FLOOR);
    expect(a.tx + 50000 * a.scale).toBeCloseTo(box.width / 2);
    // A layout that fits at the floor is still centered; the anchor is ignored.
    const fits = initialView({ width: 1500, height: 100 }, box, false, 40, 0);
    expect(fits.scale).toBeCloseTo(box.width / 1500);
    expect(fits.tx).toBeCloseTo(0);
  });
});

describe('fitView', () => {
  it('fits both axes with padding', () => {
    const layout = { width: 2000, height: 4000 };
    const v = fitView(layout, box);
    expect(layout.width * v.scale).toBeLessThanOrEqual(box.width - 80);
    expect(layout.height * v.scale).toBeLessThanOrEqual(box.height - 80);
  });
});

describe('centerOn', () => {
  it('puts the target layout point at the box center', () => {
    const v = centerOn(0.7, 500, 1200, box);
    const p = toScreen(v, 500, 1200);
    expect(p.x).toBeCloseTo(box.width / 2);
    expect(p.y).toBeCloseTo(box.height / 2);
    expect(v.scale).toBe(0.7);
  });
});

describe('minimap mapping', () => {
  it('fits tall skinny layouts by height, preserving aspect', () => {
    const f = minimapFrame(800, 8800, 160, 220);
    expect(f.s).toBeCloseTo(0.025);
    expect(f.h).toBe(220);
    expect(f.w).toBe(Math.round(800 * f.s));
  });

  it('fits wide layouts by width', () => {
    const f = minimapFrame(3200, 400, 160, 220);
    expect(f.s).toBeCloseTo(0.05);
    expect(f.w).toBe(160);
  });

  it('minimapToLayout inverts the frame scale (production path)', () => {
    const f = minimapFrame(800, 8800);
    // center of the minimap strip maps to the center of the layout
    const p = minimapToLayout(f, f.w / 2, f.h / 2);
    expect(p.x).toBeCloseTo(400, 0);
    expect(p.y).toBeCloseTo(4400, 0);
    // fixed-value case: 0.025 scale → 1 minimap px = 40 layout px
    expect(minimapToLayout(f, 1, 1)).toEqual({ x: 1 / f.s, y: 1 / f.s });
    expect(1 / f.s).toBeCloseTo(40);
  });
});

describe('viewportRect', () => {
  it('inverts the view transform', () => {
    const v = { tx: -100, ty: -2000, scale: 0.5 };
    const r = viewportRect(v, box);
    expect(r).toEqual({ x: 200, y: 4000, w: 2000, h: 1400 });
    // and the rect's origin maps back to screen (0,0)
    const p = toScreen(v, r.x, r.y);
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(0);
  });
});

describe('graphFullyVisible (minimap auto-hide)', () => {
  const layout = { width: 800, height: 8800 };

  it('hides the minimap when the whole graph fits', () => {
    const small = { width: 800, height: 1000 };
    const v = fitView(small, box);
    expect(graphFullyVisible(v, box, small)).toBe(true);
  });

  it('keeps the minimap when the min-scale clamp prevents a true fit', () => {
    // 8800px tall at the 0.08 floor is 704px — taller than the 700px box.
    const v = fitView(layout, box);
    expect(graphFullyVisible(v, box, layout)).toBe(false);
  });

  it('shows the minimap when zoomed into a slice', () => {
    const v = initialView(layout, box, false);
    expect(graphFullyVisible(v, box, layout)).toBe(false);
  });

  it('shows the minimap when panned partly off-screen', () => {
    const fit = fitView(layout, box);
    const panned = { ...fit, ty: fit.ty - 200 };
    expect(graphFullyVisible(panned, box, layout)).toBe(false);
  });
});

describe('panToReveal (replay follow-camera)', () => {
  // A 1000×700 box: the inner 70% region is x ∈ [150, 850], y ∈ [105, 595].
  const v = { tx: 0, ty: 0, scale: 1 };
  const node = (x, y, w = 100, h = 40) => ({ x, y, w, h });
  const screen = (view, r) => ({
    x: r.x * view.scale + view.tx,
    y: r.y * view.scale + view.ty,
    w: r.w * view.scale,
    h: r.h * view.scale,
  });
  // Half a pixel of slack: the camera treats a sub-pixel shift as "inside"
  // (see panToReveal), and 700 × 0.7 is not exact in floating point.
  const inside = (view, r) => {
    const s = screen(view, r);
    return s.x >= 149.5 && s.x + s.w <= 850.5 && s.y >= 104.5 && s.y + s.h <= 595.5;
  };

  it('a node inside the inner 70% never moves the view', () => {
    expect(panToReveal(v, node(400, 300), box)).toBeNull();
    // Right up against the region's edges still counts as inside.
    expect(panToReveal(v, node(150, 105), box)).toBeNull();
    expect(panToReveal(v, node(750, 555), box)).toBeNull();
  });

  it('a node just outside moves by the minimum amount on that axis alone, and is then inside', () => {
    const cases = [
      { r: node(140, 300), d: { tx: 10, ty: 0 } }, // left
      { r: node(400, 95), d: { tx: 0, ty: 10 } }, // top
      { r: node(760, 300), d: { tx: -10, ty: 0 } }, // right (x + w = 860 > 850)
      { r: node(400, 560), d: { tx: 0, ty: -5 } }, // bottom (y + h = 600 > 595)
    ];
    for (const { r, d } of cases) {
      const next = panToReveal(v, r, box);
      expect(next.scale).toBe(1);
      expect(next.tx).toBeCloseTo(v.tx + d.tx);
      expect(next.ty).toBeCloseTo(v.ty + d.ty);
      expect(inside(next, r)).toBe(true);
      // And the SAME node against the moved view needs no further move —
      // the camera settles instead of oscillating.
      expect(panToReveal(next, r, box)).toBeNull();
    }
  });

  it('a node straddling the region edge moves', () => {
    const r = node(120, 300); // spans 120–220: partly inside
    const next = panToReveal(v, r, box);
    expect(next.scale).toBe(1);
    expect(next.tx).toBeCloseTo(30);
    expect(next.ty).toBe(0);
    expect(inside(next, r)).toBe(true);
  });

  it('a node far off-screen on both axes moves on both, by the minimum on each', () => {
    const r = node(-500, 2000);
    const next = panToReveal(v, r, box);
    expect(next.tx).toBeCloseTo(650); // −500 → 150
    expect(next.ty).toBeCloseTo(-1445); // 2040 → 595
    expect(inside(next, r)).toBe(true);
  });

  it('a node larger than the region centres on that axis', () => {
    // Wider than 700 screen px: no position fits, so centre horizontally.
    // Vertically it fits and is already inside, so ty does not move.
    const wide = node(0, 300, 900, 40);
    const next = panToReveal(v, wide, box);
    expect(next.ty).toBe(0);
    expect(next.tx + 450).toBeCloseTo(500); // centre of the node at the box centre
    // Taller than 490: centre vertically.
    const tall = node(400, 900, 100, 600);
    const t = panToReveal(v, tall, box);
    expect(t.tx).toBe(0);
    expect(t.ty + 900 + 300).toBeCloseTo(350);
  });

  it('scale never changes, and the screen math honours the view scale', () => {
    const zoomed = { tx: -300, ty: -200, scale: 0.5 };
    const r = node(100, 100); // screen: (−250, −150), 50×20 → off to the top-left
    const next = panToReveal(zoomed, r, box);
    expect(next.scale).toBe(0.5);
    expect(next.tx).toBeCloseTo(-300 + 400); // −250 → 150
    expect(next.ty).toBeCloseTo(-200 + 255); // −150 → 105
    expect(inside(next, r)).toBe(true);
    expect(panToReveal(next, r, box)).toBeNull();
  });

  it('a custom inner fraction is honoured, and garbage inputs are null', () => {
    // inner = 1: the region is the whole box, so a node at (0, 0) is inside.
    expect(panToReveal(v, node(0, 0), box, 1)).toBeNull();
    // inner = 0.5: region x ∈ [250, 750]; a node at 200 is now outside.
    const half = panToReveal(v, node(200, 300), box, 0.5);
    expect(half.tx).toBeCloseTo(50);
    expect(half.ty).toBe(0);
    expect(panToReveal(v, null, box)).toBeNull();
    expect(panToReveal(null, node(0, 0), box)).toBeNull();
    expect(panToReveal(v, node(0, 0), null)).toBeNull();
  });
});
