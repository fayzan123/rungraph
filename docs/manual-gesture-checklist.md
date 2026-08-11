# Manual gesture checklist — frontend navigation pass

Per the 2026-08-11 frontend-navigation spec §6, gesture *feel* is verified by
hand (view math is unit-tested in `tests/viewmath.test.js`). Run through this
on a real, tall session (`npx rungraph`) — ideally on a Mac trackpad, since
trackpad deltas are what the old zoom curve got wrong.

## Navigation

- [ ] **Pinch zoom speed** — pinch on the trackpad zooms briskly (a full pinch
      spans roughly min→max zoom, not a barely-perceptible crawl) and stays
      centered on the cursor.
- [ ] **cmd+scroll zoom** — same curve as pinch; one mouse-wheel notch is a
      noticeable but controlled step.
- [ ] **Two-finger scroll pans** both axes; an external mouse wheel pans too
      (line-mode deltas don't feel 16× slower).
- [ ] **Click-drag pans**; cursor shows grab/grabbing.
- [ ] **Right-click (two-finger tap), dismiss the menu, then move the mouse**
      — the canvas must NOT pan on hover. Same on the minimap.

## Selection

- [ ] **Click a node** → inspector opens with its detail (the v1 bug).
- [ ] **Click an edge** → edge detail.
- [ ] **Click empty space** → deselects / closes the inspector.
- [ ] **Double-click a node** → zoom to 100%, node centered.
- [ ] A small hand-jitter during a click still selects (drag threshold).

## Keyboard

- [ ] `j`/`↓` and `k`/`↑` walk nodes in run order (agents appear at their
      spawn time, not at the end), centering each; inspector follows.
- [ ] `f` fits the whole graph; `Esc` deselects.
- [ ] Keys do nothing with no run open.

## Minimap

- [ ] Appears bottom-right (~160px wide) only when the graph doesn't fit;
      `fit` button docks above it.
- [ ] Click anywhere → main view centers there at current zoom.
- [ ] Drag the bright viewport rect → continuous pan, no snapping.
- [ ] Red beacons on error nodes; clicking one jumps to + selects the node.
- [ ] Open at `fit` → minimap hides; zoom in → it returns.

## Live tail

- [ ] A live run opens at the **bottom** (latest activity); a finished run at
      the **top** at readable zoom.
- [ ] Follow mode slides the view (and the minimap viewport rect) down as
      nodes stream in; any manual pan/scroll turns follow off.

## Labels & inspector

- [ ] Tool nodes read `Bash · npm test ×N`-style labels, truncated ~40 chars.
- [ ] Tool detail shows a **why** section when the assistant narrated before
      the call; absent otherwise.
