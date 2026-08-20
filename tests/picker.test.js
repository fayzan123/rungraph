import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOOSE_BUCKET,
  adapterChips,
  groupKeyFor,
  groupRuns,
} from '../frontend/src/picker-groups.js';
import { ADAPTERS } from '../src/scanner.js';
import { adapterName } from '../frontend/src/focus.js';

// Index entries as /api/index (and list --json) deliver them — only the
// fields the grouping reads, with the rest of the entry shape irrelevant here.
let seq = 0;
const entry = (over = {}) => ({
  runId: over.runId ?? `t:run-${String(++seq).padStart(3, '0')}`,
  adapter: 'claude-code',
  kind: 'session',
  title: 't',
  project: '/home/dev/acme',
  modifiedAt: '2026-08-01T13:00:00.000Z',
  active: false,
  loose: false,
  ...over,
});
const at = (minute) => `2026-08-01T13:${String(minute).padStart(2, '0')}:00.000Z`;

describe('groupKeyFor precedence', () => {
  it('bundle > loose > path — provenance wins even over a loose flag', () => {
    expect(groupKeyFor(entry({ provenance: { bundle: 'team.rungraph' }, loose: true }))).toBe(
      '📦 team.rungraph',
    );
    expect(groupKeyFor(entry({ loose: true, project: '✦ Hermes tasks' }))).toBe(LOOSE_BUCKET);
    expect(groupKeyFor(entry({ project: '/Users/dev/GitHub/Chox' }))).toBe(
      '/users/dev/github/chox',
    );
  });

  it('tolerates a server too old to send `loose`', () => {
    const e = entry({ project: '/home/dev/acme' });
    delete e.loose;
    expect(groupKeyFor(e)).toBe('/home/dev/acme');
  });
});

describe('groupRuns', () => {
  it('groups by project in recency order, each group placed by its newest run', () => {
    const runs = [
      entry({ project: '/dev/old', modifiedAt: at(1) }),
      entry({ project: '/dev/new', modifiedAt: at(30) }),
      entry({ project: '/dev/old', modifiedAt: at(20) }),
    ];
    const groups = groupRuns(runs);
    expect(groups.map((g) => g.key)).toEqual(['/dev/new', '/dev/old']);
    expect(groups[1].runs.map((r) => r.modifiedAt)).toEqual([at(20), at(1)]);
    expect(groups.every((g) => g.kind === 'project')).toBe(true);
  });

  it('every loose run gathers under one ✦ loose runs bucket, whatever its adapter', () => {
    const runs = [
      entry({ project: '/dev/app', modifiedAt: at(10) }),
      entry({ adapter: 'hermes', project: '✦ Hermes tasks', loose: true, modifiedAt: at(20) }),
      entry({ adapter: 'claude-code', project: '/Users/me', loose: true, modifiedAt: at(5) }),
      entry({ adapter: 'codex', project: '(unknown project)', loose: true, modifiedAt: at(1) }),
    ];
    const groups = groupRuns(runs);
    expect(groups.map((g) => g.key)).toEqual([LOOSE_BUCKET, '/dev/app']);
    const bucket = groups[0];
    expect(bucket.kind).toBe('bucket');
    expect(bucket.label).toBe(LOOSE_BUCKET);
    expect(bucket.runs).toHaveLength(3);
    expect(bucket.runs.map((r) => r.adapter)).toEqual(['hermes', 'claude-code', 'codex']);
  });

  it('bundle runs group under their 📦 file and never fall into the bucket', () => {
    const runs = [
      entry({ provenance: { bundle: 'team.rungraph' }, modifiedAt: at(9) }),
      entry({ provenance: { bundle: 'team.rungraph' }, loose: true, modifiedAt: at(8) }),
    ];
    const groups = groupRuns(runs);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '📦 team.rungraph', kind: 'bundle', total: 2 });
  });

  it('case-duplicate projects merge, displaying the casing most runs use', () => {
    const runs = [
      entry({ project: '/gh/Chox', modifiedAt: at(30) }),
      entry({ project: '/gh/chox', modifiedAt: at(20) }),
      entry({ project: '/gh/chox', modifiedAt: at(10) }),
    ];
    const groups = groupRuns(runs);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('/gh/chox');
    expect(groups[0].label).toBe('/gh/chox'); // 2 of 3 runs spell it lower-case
    expect(groups[0].total).toBe(3);
  });

  it('a casing tie goes to the spelling seen first (the most recent run)', () => {
    const runs = [
      entry({ project: '/gh/Chox', modifiedAt: at(30) }),
      entry({ project: '/gh/chox', modifiedAt: at(20) }),
    ];
    expect(groupRuns(runs)[0].label).toBe('/gh/Chox');
  });

  it('bucket and bundle labels never case-merge', () => {
    const runs = [
      entry({ provenance: { bundle: 'Team.rungraph' } }),
      entry({ provenance: { bundle: 'team.rungraph' } }),
    ];
    expect(groupRuns(runs).map((g) => g.key)).toEqual(['📦 Team.rungraph', '📦 team.rungraph']);
  });

  it('filter: zero-match groups disappear, mixed groups keep matching rows and the full total', () => {
    const runs = [
      entry({ adapter: 'claude-code', project: '/dev/mixed', modifiedAt: at(30) }),
      entry({ adapter: 'hermes', project: '/dev/mixed', modifiedAt: at(20) }),
      entry({ adapter: 'claude-code', project: '/dev/claude-only', modifiedAt: at(10) }),
    ];
    const groups = groupRuns(runs, { filter: 'hermes' });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('/dev/mixed');
    expect(groups[0].runs.map((r) => r.adapter)).toEqual(['hermes']); // k…
    expect(groups[0].total).toBe(2); // …of n
  });

  it('filter keeps group positions stable — a group sits by its newest run, matching or not', () => {
    const runs = [
      entry({ adapter: 'claude-code', project: '/dev/a', modifiedAt: at(30) }),
      entry({ adapter: 'hermes', project: '/dev/b', modifiedAt: at(25) }),
      entry({ adapter: 'hermes', project: '/dev/a', modifiedAt: at(20) }),
    ];
    expect(groupRuns(runs, { filter: 'hermes' }).map((g) => g.key)).toEqual(['/dev/a', '/dev/b']);
  });

  it('the live count on a filtered group counts matching live runs only', () => {
    const runs = [
      entry({ adapter: 'claude-code', project: '/dev/a', active: true, modifiedAt: at(30) }),
      entry({ adapter: 'hermes', project: '/dev/a', active: true, modifiedAt: at(20) }),
      entry({ adapter: 'hermes', project: '/dev/a', modifiedAt: at(10) }),
    ];
    expect(groupRuns(runs)[0].live).toBe(2);
    expect(groupRuns(runs, { filter: 'hermes' })[0].live).toBe(1);
  });

  it('tolerates an empty or absent index', () => {
    expect(groupRuns([])).toEqual([]);
    expect(groupRuns(undefined)).toEqual([]);
    expect(groupRuns(null, { filter: 'hermes' })).toEqual([]);
  });
});

describe('adapterChips', () => {
  it('one chip per adapter, descending count, display names, live dots', () => {
    const runs = [
      entry({ adapter: 'hermes' }),
      entry({ adapter: 'claude-code' }),
      entry({ adapter: 'claude-code', active: true }),
      entry({ adapter: 'codex' }),
      entry({ adapter: 'claude-code' }),
      entry({ adapter: 'hermes' }),
    ];
    expect(adapterChips(runs)).toEqual([
      { adapter: 'claude-code', name: 'claude', count: 3, live: true },
      { adapter: 'hermes', name: 'hermes', count: 2, live: false },
      { adapter: 'codex', name: 'codex', count: 1, live: false },
    ]);
  });

  it('equal counts tie-break on adapter id — stable for a given corpus', () => {
    const runs = [entry({ adapter: 'hermes' }), entry({ adapter: 'codex' })];
    expect(adapterChips(runs).map((c) => c.adapter)).toEqual(['codex', 'hermes']);
  });

  it('tolerates an empty index', () => {
    expect(adapterChips([])).toEqual([]);
    expect(adapterChips(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adapter identity is a COLOUR, worn everywhere. A new adapter that ships
// without one renders in --ink-faint at some of these points and in a real hue
// at others, so the same agent looks like two different things depending on
// which pane you are reading — and the agent rail, whose whole job is telling
// vendors apart, is the pane that loses most.
// ---------------------------------------------------------------------------

describe('adapter accents', () => {
  const CSS = readFile(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'frontend', 'src', 'styles.css'),
    'utf8',
  );

  // The four places identity appears: header tag, picker row, inspector line,
  // rail chip.
  const SELECTORS = ['.adapter-tag', '.run-item .sub .adapter', '.kv dd', '.agent-rail .chip'];

  it('every registered adapter has an accent at all four identity points', async () => {
    const css = await CSS;
    expect(ADAPTERS.length).toBeGreaterThan(3);
    for (const adapter of ADAPTERS) {
      for (const selector of SELECTORS) {
        expect(
          css.includes(`${selector}[data-adapter="${adapter.name}"]`),
          `${adapter.name} has no rule for ${selector}[data-adapter="${adapter.name}"]`,
        ).toBe(true);
      }
      // …and the display name the chip actually renders is non-empty, since a
      // blank chip is a colour nobody can attach a vendor to.
      expect(adapterName(adapter.name)).toBeTruthy();
    }
  });

  it('no two adapters share a hue', async () => {
    const css = await CSS;
    // Each accent resolves through a custom property; read the hue off its
    // definition rather than the usage, so a var renamed in one place cannot
    // silently collapse two agents onto one colour.
    const hues = new Map();
    for (const adapter of ADAPTERS) {
      const use = css.match(
        new RegExp(`\\.agent-rail \\.chip\\[data-adapter="${adapter.name}"\\][^}]*color:\\s*var\\((--[a-z-]+)\\)`),
      );
      expect(use, `${adapter.name}'s rail chip does not resolve through a custom property`).toBeTruthy();
      const def = css.match(new RegExp(`${use[1]}:\\s*oklch\\([0-9.]+ [0-9.]+ ([0-9.]+)\\)`));
      expect(def, `${use[1]} is used but never defined`).toBeTruthy();
      const hue = Number(def[1]);
      for (const [other, otherHue] of hues) {
        // 30° is the floor at which two accents stay tellable apart side by
        // side in the rail. The shipped set clears it comfortably: the tightest
        // pair is 43° (opencode↔steel).
        expect(
          Math.min(Math.abs(hue - otherHue), 360 - Math.abs(hue - otherHue)),
          `${adapter.name} (${hue}°) and ${other} (${otherHue}°) are too close to tell apart`,
        ).toBeGreaterThan(30);
      }
      hues.set(adapter.name, hue);
    }
  });
});
