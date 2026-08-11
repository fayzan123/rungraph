# rungraph — Frontend Navigation & Node Detail — Design Spec

**Date:** 2026-08-11
**Status:** Approved by Fayzan (brainstorming session, 2026-08-11)
**Parent spec:** `2026-08-11-rungraph-design.md` (v1). This spec is a UX improvement pass on the shipped v1 frontend; all v1 constraints (agent-first CLI, vendor-neutral IR, parser purity, never-blank-screen, localhost-only) carry over unchanged.

## Problem

On real sessions (hundreds of nodes, tall skinny layouts) the v1 frontend fails its own purpose — transparency into the run:

1. **Trackpad zoom is unusably slow.** The canvas treats every wheel event as a zoom scaled for mouse-wheel deltas; Mac trackpads emit deltas ~20–50× smaller, so pinch/scroll barely moves the scale.
2. **Clicking a node does nothing.** The SVG captures the pointer on pointer-down for drag-panning; in Chromium, pointer capture retargets the subsequent `click` to the capturing element, so node click handlers never fire and the click reads as "empty space → close inspector." The inspector (which already renders full tool inputs/outputs) is unreachable.
3. **No overview↔detail bridge.** Fit-all renders long runs as microscopic strips; there is no minimap to see where you are or jump elsewhere.
4. **Node labels are thin.** A tool node says `Bash ×12`, not *what* was run — even though the inputs are already parsed and served by the detail endpoint.

## Scope (approach B — approved)

Core fixes: click-selection fix, Figma-style trackpad navigation, readable initial zoom, minimap with draggable viewport, descriptive node labels. Extras: keyboard walk-through, minimap error beacons, double-click-to-zoom, inspector "why" context.

**Explicitly out:** search (cut in v1 spec; minimap + keyboard walk cover it), semantic zoom / level-of-detail rendering, collapsible tool clusters, any IR shape change. Deferred until B proves insufficient on real runs.

## 1. Navigation & input model

Wheel events on the canvas, Figma-style:

| Gesture | Behavior |
|---|---|
| Two-finger scroll | Pan (both axes) |
| Pinch (wheel event with `ctrlKey`) | Zoom centered on cursor, ~7× stronger factor than today |
| cmd+scroll (`metaKey`) | Zoom, same curve |
| Click-drag | Pan (unchanged) |
| Plain wheel on external mouse | Pan; `deltaMode` (line vs pixel) normalized |

Zoom clamps stay: min 0.08, max 2.5.

**Click-selection fix:** selection fires on pointer-up when total movement stayed under the drag threshold, targeting the element under the *original press* (recorded on pointer-down, before capture). Clicking true empty space still deselects. Pointer capture remains for drag-panning only.

**Initial view (replaces fit-all-on-open):** open at readable zoom — `min(1, viewportWidth / layoutWidth)` — positioned at the **top** (first prompt) for finished runs, at the **bottom** (latest activity) for live runs. Live follow mode unchanged. `fit` button stays for whole-graph overview.

**Keyboard & extras:**
- `↓`/`j` and `↑`/`k` — select next/previous node in chronological (IR array) order; viewport centers on it; inspector shows it.
- Double-click a node — zoom to 100% centered on it.
- `f` — fit whole graph. `Esc` — deselect / close inspector.
- Keys no-op when no graph is loaded or focus is in an input.

## 2. Minimap

- **Placement:** bottom-right of the canvas; `fit` button docks above it. ~160px wide, height capped ~220px; whole graph scaled to fit inside, aspect preserved.
- **Contents:** nodes as kind-colored rects (min 2px so 500-node runs keep visible structure); group boxes as faint outlines; **no edges** (noise at that scale; node positions alone show the shape).
- **Viewport rect:** bright-bordered rectangle showing the main view's slice; updates live on pan/zoom.
- **Interactions:** click minimap → center main view there at current zoom. Drag the viewport rect → continuous pan. No zoom gestures on the minimap.
- **Error beacons:** nodes with `status: error` or `errorCount > 0` render as oversized red dots; clicking one jumps to and selects that node.
- **Live:** new nodes stream in via the same delta path; follow mode visibly slides the viewport rect down the strip.
- **Auto-hide:** hidden when the entire graph already fits in the main view.

## 3. Descriptive node labels

Synthesized in `adapters/claude-code/` (format knowledge stays in the adapter) and emitted through the existing IR `label` field — no IR shape change, `irVersion` stays 1.

- `Bash` → `Bash · <description || command>` (prefer the human-readable `description` input when present).
- `Read`/`Edit`/`Write` → `<Tool> · <basename of file_path>`.
- `Grep` → pattern; `Agent` → its `description`; `WebFetch` → domain.
- Unknown tools or synthesis failure → today's plain tool name (try/catch fallback; never-blank-screen).
- Aggregated nodes keep aggregation: first call's summary + `×N` (`Bash · npm test ×12`); all calls remain in the inspector.
- Truncate ~40 chars; tool-node `maxW` in the layout sizing bumps to fit.

## 4. Inspector "why" context

Tool-node detail payload gains an optional `context` field: the assistant narration text emitted in the same turn immediately before the group's first tool call ("Now I'll run the tests to check X"). Sidebar renders it as a **why** section above the call list; omitted when there's no narration. Additive optional field, documented in `SCHEMA.md`; `irVersion` stays 1; old consumers unaffected.

## 5. Error handling

Every feature degrades to current behavior: layout failure → no minimap, existing error banner; label synthesis failure → plain tool name; keyboard handlers no-op without a graph; detail `context` absent → section not rendered. No new failure mode may blank the screen.

## 6. Testing

- **Adapter:** label synthesis + why-context via the existing fixture-driven snapshot suite; new fixture cases cover representative tool inputs (Bash with/without description, Read, Grep, unknown tool, aggregated group).
- **Server:** detail-endpoint tests for the `context` field.
- **Frontend view math:** zoom-at-point, readable-fit, minimap coordinate mapping, viewport-rect geometry extracted as pure functions and unit-tested with vitest (this is where the click-bug class of regression lives).
- **Gesture feel:** manual, per the v1 spec's frontend-testing stance; the implementation plan includes a short manual checklist (pinch speed, scroll-pan, click-select, minimap drag, live follow).
