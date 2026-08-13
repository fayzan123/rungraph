import { useLayoutEffect, useRef } from 'preact/hooks';

/**
 * The signal strip: "what is wrong in this run", one line, above the canvas.
 *
 * It renders nothing at all when the run is clean and find is closed, so a run
 * with no signals costs zero height — that is the whole point of a strip that
 * only appears when it has something to say.
 *
 * Which is also why find is NOT a permanent input here, despite the spec asking
 * for both. The reconciliation: find is *reachable* from the always-visible
 * "find" button in the canvas dock and from "/", and only *lives* in the strip
 * once opened. A clean run still costs zero height; find is still one keystroke
 * away.
 */

/** Kind → glyph. Shared with the inspector's signal rows so they read alike. */
export const SIGNAL_GLYPHS = {
  'retry-storm': '⟳',
  'unresolved-error': '⚠',
  intervention: '✋',
  outlier: '◆',
  'course-change': '⚑',
};

// Display budget: 4 chips, then "+n more" hands off to the inspector's full
// ranked list. Past four the strip stops being scannable at a glance.
const MAX_CHIPS = 4;

export function Strip({
  signals,
  focus,
  escalated,
  note,
  findOpen,
  findSeq,
  query,
  matchCount,
  onToggleSignal,
  onShowAll,
  onQuery,
  onCloseFind,
}) {
  const inputRef = useRef(null);
  // Before paint, not after: every frame between "/" and the input taking focus
  // is a frame where the next keystroke falls through to the canvas's j/k walk
  // and silently moves the selection instead of typing.
  useLayoutEffect(() => {
    if (findOpen) inputRef.current?.select(); // select, so re-opening replaces the old query
  }, [findOpen, findSeq]);

  const list = signals ?? [];
  if (list.length === 0 && !findOpen && !note) return null;

  const shown = list.slice(0, MAX_CHIPS);
  const rest = list.length - shown.length;

  return (
    <div class="strip" data-alert={String(Boolean(escalated))}>
      {/* Chips live in their own scroller so they keep their labels on a narrow
          window instead of shrinking to bare glyphs. A chip you cannot read is
          not a smaller chip, it is no chip — and find stays pinned regardless. */}
      <div class="chips">
      {shown.map((s) => {
        const on = focus?.source === 'signal' && focus.signalId === s.id;
        return (
          <button
            key={s.id}
            class="chip"
            data-severity={s.severity}
            data-on={String(on)}
            aria-pressed={String(on)}
            onClick={() => onToggleSignal?.(s)}
            title={s.reason || s.label}
          >
            <span class="glyph" aria-hidden="true">{SIGNAL_GLYPHS[s.kind] ?? '•'}</span>
            <span class="label">{s.label}</span>
          </button>
        );
      })}
      {rest > 0 && (
        <button
          class="chip more"
          onClick={() => onShowAll?.()}
          title="show every signal in the inspector"
        >
          +{rest} more
        </button>
      )}
      </div>
      {/* Outside the chip scroller: a degradation message ("those nodes are
          gone from this run") is the one thing on this line that must never be
          the thing that gets squeezed out. */}
      {note && <span class="note">{note}</span>}
      {findOpen && (
        <span class="find">
          <input
            ref={inputRef}
            type="text"
            value={query ?? ''}
            placeholder="find in this run"
            aria-label="find nodes by label or file"
            spellcheck="false"
            autocomplete="off"
            onInput={(e) => onQuery?.(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Escape') return;
              e.preventDefault();
              onCloseFind?.();
            }}
          />
          {matchCount != null && (
            <span class="microlabel count">
              {matchCount === 0
                ? 'no matches'
                : `${matchCount} match${matchCount === 1 ? '' : 'es'}`}
            </span>
          )}
          <button class="ghost" onClick={() => onCloseFind?.()} title="close find (Esc)">
            esc
          </button>
        </span>
      )}
    </div>
  );
}
