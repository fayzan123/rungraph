import { useEffect, useRef } from 'preact/hooks';
import { fmtClock, nextRate, rateLabel, readoutFor } from './replay.js';

/**
 * The replay bar: "when", one line, along the BOTTOM of the centre column.
 *
 * It is the strip's bottom-edge sibling — one line of mono, hairline-topped,
 * and it costs zero height when closed because App does not render it at all
 * (`replay === null`). The strip answers "what is wrong in this run"; this
 * answers "when". Two questions, two surfaces, and the strip's zero-height-
 * when-clean rule is untouched.
 *
 * The bar OWNS nothing. The playhead lives in App (the FocusSet pattern) and
 * every consumer — canvas, inspector, strip, minimap, this bar — derives what
 * it shows from the same cursor, so no two of them can describe different
 * moments. Everything here is a producer of App transitions: seek, step, play,
 * rate, live. The scrub's own drag is the one piece of transient state, and it
 * is reported outward too (`onScrubState`) so the inspector can hold its
 * transcript fetch until the playhead rests.
 *
 * Keys are NOT handled here. ←/→/space/r/Esc live in the canvas's one keyboard
 * map, beside f and /, so there is exactly one map and one activeElement
 * check. The four control buttons are real <button>s for the same reason: a
 * focused one takes its own click on space, and the canvas map skips space
 * while a button is focused — one press, one action, never both.
 */

/**
 * Label per control. Words, not a row of triangles: the first cut drew
 * `⏮ ◀ ▶ ▶` and the two ▶ — step forward and play — were told apart by
 * nothing but their order, which is no way to learn a transport. Named once
 * so the title and the label cannot drift apart.
 */
const LABEL = {
  toStart: '⏮',
  stepBack: '‹ step',
  stepFwd: 'step ›',
  play: '▶ play',
  pause: '❚❚ pause',
};

export function ReplayBar({
  timeline,
  cursor,
  replay,
  playing,
  rate,
  tick,
  live,
  disabled,
  markers,
  onSeek,
  onStep,
  onToStart,
  onTogglePlay,
  onSetRate,
  onLive,
  onClose,
  onScrubState,
}) {
  const scrubRef = useRef(null);
  // The drag in flight, or null. A ref, not state: a pointer move must not
  // re-render the bar just to remember that it is captured, and the release
  // handlers (pointerup AND lostpointercapture both fire on a normal release)
  // use it to run the release exactly once.
  const dragRef = useRef(null);

  const events = timeline?.events ?? [];
  const total = events.length;
  const at = clamp(Number.isFinite(cursor) ? cursor : total, 0, total);
  const pct = total > 0 ? (at / total) * 100 : 0;
  const readout = readoutFor(events, at, Boolean(timeline?.timed));
  const off = Boolean(disabled);

  // The clock RUNS during play. Between two events the readout would sit on
  // the last event's time and then jump — by ten compressed minutes, at
  // times — which reads as a stopped clock, not a time-lapse. So while a
  // tick is pending (`tick` = { fromT, toT, at, delayMs } from App's play
  // loop) the run's time is interpolated across the wait and written
  // straight into the span from a rAF loop: the bar does not re-render sixty
  // times a second for a string. When the tick clears, the span is put back
  // to the rendered readout by hand, because Preact patches text against its
  // last VNODE, not the DOM, and would leave the interpolated value standing
  // when the two happen to agree.
  const clockRef = useRef(null);
  const clockText = useRef(readout.clock);
  clockText.current = readout.clock;
  useEffect(() => {
    const el = clockRef.current;
    if (!tick || !el || !timeline?.timed) return;
    let raf = 0;
    const draw = () => {
      const k = tick.delayMs > 0 ? Math.min(1, (Date.now() - tick.at) / tick.delayMs) : 1;
      el.textContent = fmtClock(tick.fromT + (tick.toT - tick.fromT) * k);
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = clockText.current;
    };
  }, [tick, timeline]);

  /**
   * Pointer x → cursor. Uniform spacing per EVENT index, not wall time: a
   * ten-minute idle gap is a hairline here, not half the bar — gap compression
   * in the bar itself. Rounded, so the playhead lands on the nearest event
   * boundary rather than always the one before the pointer.
   */
  const cursorAt = (clientX) => {
    const el = scrubRef.current;
    const rect = el?.getBoundingClientRect?.();
    if (!rect || !(rect.width > 0) || total === 0) return at;
    return clamp(Math.round(((clientX - rect.left) / rect.width) * total), 0, total);
  };

  const onPointerDown = (e) => {
    if (off || e.button !== 0) return; // right/middle press must never arm a drag
    dragRef.current = { last: cursorAt(e.clientX) };
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onScrubState?.(true);
    // Transient: the selection follows, but the discrete-move counter does
    // not bump until release — the camera reveals once, where the drag ends.
    onSeek?.(dragRef.current.last, { transient: true });
  };
  const onPointerMove = (e) => {
    const d = dragRef.current;
    if (!d) return;
    const c = cursorAt(e.clientX);
    if (c === d.last) return; // same event boundary — nothing to re-derive
    d.last = c;
    onSeek?.(c, { transient: true });
  };
  const release = (e) => {
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    // pointerup carries a position; lostpointercapture / pointercancel may
    // not. The last position the drag saw is the honest fallback — never
    // recompute from a coordinate the event did not supply.
    const c = Number.isFinite(e?.clientX) && e.type === 'pointerup' ? cursorAt(e.clientX) : d.last;
    onScrubState?.(false);
    onSeek?.(c, { transient: false });
  };

  const mode = replay?.mode === 'at' ? 'at' : 'edge';
  const valuetext = `${readout.clock} · ${readout.step} / ${readout.total}`;
  // Pad the step readout to its widest possible string so the digits do not
  // shove the rate button around while playing (tabular-nums handles width
  // per digit; this handles the digit COUNT).
  const stepWidth = `${String(total).length * 2 + 3}ch`;

  return (
    <div
      class="replay-bar"
      role="group"
      aria-label="replay"
      data-disabled={String(off)}
      data-playing={String(Boolean(playing))}
      data-mode={mode}
    >
      <div class="controls">
        <button
          class="ghost to-start"
          disabled={off}
          onClick={() => onToStart?.()}
          title="to the start"
          aria-label="to the start"
        >
          {LABEL.toStart}
        </button>
        <button
          class="ghost step-back"
          disabled={off}
          onClick={() => onStep?.(-1)}
          title="step back  ( ← )"
          aria-label="step back"
        >
          {LABEL.stepBack}
        </button>
        <button
          class="ghost step-fwd"
          disabled={off}
          onClick={() => onStep?.(1)}
          title="step forward  ( → )"
          aria-label="step forward"
        >
          {LABEL.stepFwd}
        </button>
        <button
          class="ghost play"
          disabled={off}
          onClick={() => onTogglePlay?.()}
          title="play / pause  ( space )"
          aria-label={playing ? 'pause' : 'play'}
          aria-pressed={String(Boolean(playing))}
        >
          {playing ? LABEL.pause : LABEL.play}
        </button>
      </div>

      {/* The scrub is the POINTER surface; the slider ROLE sits on the empty
          track alone. ARIA 1.2 makes `slider` childrenPresentational — a
          button inside one loses its accessible name — and the markers are
          named buttons, so they must be the slider's siblings, not its
          children. Not in the tab order, and it handles NO keys: the buttons
          are the keyboard surface, and ←/→ belong to the canvas's one map — a
          slider that also stepped on arrows would move the playhead twice. */}
      <div
        ref={scrubRef}
        class="scrub"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={release}
        onPointerCancel={release}
        onLostPointerCapture={release}
      >
        <div
          class="track"
          role="slider"
          aria-label="playhead"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={at}
          aria-valuetext={valuetext}
          aria-disabled={off ? 'true' : undefined}
          tabIndex={-1}
        />
        <div class="played" style={{ width: `${pct}%` }} />
        {/* Markers are placed by position only — a few absolutely placed
            buttons, never one DOM node per event. A press on a marker stops
            at the marker: if it reached the scrub, capture would retarget
            the click to the scrub (Chromium) and the jump would never fire. */}
        {(markers ?? []).map((m) => (
          <button
            key={`${m.kind}:${m.id}`}
            class="marker"
            data-kind={m.kind}
            data-cursor={m.cursor}
            disabled={off}
            style={{ left: `${total > 0 ? (m.idx / total) * 100 : 0}%` }}
            title={m.label}
            aria-label={m.label}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSeek?.(m.cursor, { transient: false });
            }}
          >
            {m.glyph}
          </button>
        ))}
        <div class="playhead" style={{ left: `${pct}%` }} />
      </div>

      <div class="readout">
        <span class="clock" ref={clockRef} title="the run's own clock at the playhead">{readout.clock}</span>
        <span class="step" style={{ minWidth: stepWidth }}>
          {readout.step} / {readout.total}
        </span>
      </div>

      <button
        class="ghost rate"
        disabled={off}
        onClick={() => onSetRate?.(nextRate(rate))}
        title={`${rateLabel(timeline?.sched, rate)} real time — click to change speed`}
        aria-label={`playback speed ${rateLabel(timeline?.sched, rate)} real time`}
      >
        {rateLabel(timeline?.sched, rate)}
      </button>

      {/* Only on a running run: `live` is the way back to the edge after a
          drag detached the graph at a moment while events kept arriving. */}
      {live && (
        <button
          class="ghost live"
          disabled={off}
          data-on={String(mode === 'edge')}
          aria-pressed={String(mode === 'edge')}
          onClick={() => onLive?.()}
          title="follow the live edge"
        >
          live
        </button>
      )}

      {/* The way OUT lives on the bar itself. The header's `replay` button
          is the other way, and the landing page hides the header — which
          left a phone visitor with no way to close it at all — and "r
          replay" in a caption never said that r also closes. The key hint
          rides on the button; a phone has no keys, so CSS drops it there. */}
      <button
        class="ghost close"
        disabled={off}
        onClick={() => onClose?.()}
        title="close replay  ( r )"
        aria-label="close replay"
      >
        × close<span class="key" aria-hidden="true">r</span>
      </button>
    </div>
  );
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
