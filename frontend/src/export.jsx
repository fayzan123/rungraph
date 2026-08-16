import { useEffect, useMemo, useState } from 'preact/hooks';

/**
 * The dashboard's export dialog — the human end of `rungraph export`.
 *
 * The consent surface must not fork: this shows the SAME inventory the CLI
 * prints to stderr, and a scan hit renders the same findings with the same
 * three resolutions (redact / structure-only / allow), with identical
 * defaults. Two frontends teaching two privacy postures would be worse than
 * either alone. `GET /api/export` runs the same export module the CLI uses;
 * the browser's own downloader writes the file, so rungraph itself still
 * writes nothing to disk.
 */
export function ExportDialog({ runs, onClose }) {
  const runIds = useMemo(() => runs.map((r) => r.runId), [runs]);
  const [dry, setDry] = useState(null); // { blocked, findings, inventory }
  const [dryError, setDryError] = useState(null);
  const [tier, setTier] = useState('full');
  const [allow, setAllow] = useState(false);
  const [sharedBy, setSharedBy] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/export?runs=${encodeURIComponent(runIds.join(','))}&dry=1`)
      .then(async (r) => {
        const body = await r.json();
        if (!alive) return;
        if (!r.ok) setDryError(body?.error ?? `export refused (${r.status})`);
        else setDry(body);
      })
      .catch((e) => alive && setDryError(String(e?.message ?? e)));
    return () => {
      alive = false;
    };
  }, [runIds.join(',')]);

  const findings = dry?.findings ?? [];
  const inv = dry?.inventory;
  // The same rule as the CLI/server: findings block every tier except
  // redact-secrets, unless the user takes the named allow act.
  const blocked = findings.length > 0 && tier !== 'redact-secrets' && !allow;

  const download = async () => {
    setBusy(true);
    setFailure(null);
    const params = new URLSearchParams();
    params.set('runs', runIds.join(','));
    params.set('redaction', tier);
    if (allow && tier !== 'redact-secrets') params.set('allow', '1');
    if (sharedBy.trim()) params.set('as', sharedBy.trim());
    try {
      const res = await fetch(`/api/export?${params.toString()}`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        // A blocking scan result IS the consent surface — show the server's
        // findings, don't collapse them into a failure string.
        if (body?.blocked) setDry(body);
        setFailure(body?.blocked ? 'blocked by the findings below — pick a resolution' : (body?.error ?? `export failed (${res.status})`));
        return;
      }
      const name =
        res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ??
        'runs.rungraph';
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      onClose?.();
    } catch (e) {
      setFailure(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const asName = sharedBy.trim();
  // Shell-quote a name the shell would otherwise split or interpret.
  const asArg = !asName ? '' : /^[A-Za-z0-9_.-]+$/.test(asName) ? ` --as ${asName}` : ` --as '${asName.replace(/'/g, `'\\''`)}'`;
  const incantation = `rungraph export --last ${runIds.length}${asArg}`;
  const copyIncantation = () => {
    navigator.clipboard?.writeText(incantation).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div class="export-overlay" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class="export-dialog" role="dialog" aria-label="export runs as a bundle">
        <div class="microlabel">share {runIds.length} run{runIds.length === 1 ? '' : 's'}</div>
        <h2>export a .rungraph bundle</h2>

        {dryError && <p class="export-error">{dryError}</p>}
        {!dry && !dryError && <div class="loading">taking inventory…</div>}

        {inv && (
          <>
            {/* What is about to leave the machine — visible before anything does. */}
            <div class="export-inventory">
              <div class="line">
                {inv.runCount} run{inv.runCount === 1 ? '' : 's'} · {inv.nodeCount} nodes ·{' '}
                {tier === 'structure-only' ? 0 : inv.promptCount} of your prompts included
              </div>
              {inv.runs.map((r) => (
                <div class="line run" key={r.runId}>
                  <span class="tag">{r.kind === 'workflow' ? 'wf' : 'ses'}</span>
                  <span class="grow">{r.title}</span>
                  {r.snapshot && <span class="snap">live — exported as a snapshot</span>}
                </div>
              ))}
              {inv.files.length > 0 && (
                <div class="line">files touched: {inv.files.length}</div>
              )}
              {inv.sensitiveFiles.map((f) => (
                <div class="line sensitive" key={f} title={f}>
                  ! {f} — credential-looking path
                </div>
              ))}
            </div>

            {findings.length > 0 && (
              <div class="export-findings">
                <div class="head">
                  ✗ {findings.reduce((t, f) => t + f.count, 0)} high-confidence secret
                  {findings.reduce((t, f) => t + f.count, 0) === 1 ? '' : 's'} found — resolve below
                </div>
                {findings.map((f, i) => (
                  <div class="finding" key={i}>
                    run {(f.runId ?? '?').split(':').pop()} ·{' '}
                    {f.nodeId ? `node ${f.nodeId} · ` : ''}
                    {f.where} · {f.name} ({f.hint}){f.count > 1 ? ` ×${f.count}` : ''}
                  </div>
                ))}
              </div>
            )}

            <div class="export-tiers">
              <label>
                <input type="radio" name="tier" checked={tier === 'full'} onChange={() => setTier('full')} />
                <span><b>full content</b> — prompts, tool outputs, diffs. What "help me debug this" needs.</span>
              </label>
              <label>
                <input type="radio" name="tier" checked={tier === 'redact-secrets'} onChange={() => setTier('redact-secrets')} />
                <span><b>redact secrets</b> — each match becomes a placeholder, everything else verbatim.</span>
              </label>
              <label>
                <input type="radio" name="tier" checked={tier === 'structure-only'} onChange={() => setTier('structure-only')} />
                <span><b>structure only</b> — graph shape, tool names, files, timings. No authored text.</span>
              </label>
              {findings.length > 0 && tier !== 'redact-secrets' && (
                <label class="allow">
                  <input type="checkbox" checked={allow} onChange={(e) => setAllow(e.currentTarget.checked)} />
                  <span>export anyway — I've confirmed these findings are fine to share</span>
                </label>
              )}
            </div>

            <label class="export-as">
              <span class="microlabel">shared by</span>
              <input
                type="text"
                value={sharedBy}
                placeholder="your name (recipients see this)"
                onInput={(e) => setSharedBy(e.currentTarget.value)}
              />
            </label>

            {failure && <p class="export-error">{failure}</p>}

            <div class="export-actions">
              <button class="ghost" onClick={() => onClose?.()}>cancel</button>
              <button class="ghost primary" disabled={blocked || busy} onClick={download}
                title={blocked ? 'resolve the findings first: redact, strip, or allow' : 'download the bundle'}>
                {busy ? 'exporting…' : blocked ? 'blocked by findings' : 'download bundle'}
              </button>
            </div>

            <p class="export-foot">
              or ask your agent:{' '}
              <button class="incantation" onClick={copyIncantation} title="copy">
                <code>{incantation}</code> {copied ? '✓' : '⧉'}
              </button>
              <br />
              send the file however you already send files — rungraph never touches a network.
              Recipients: <code>npx rungraph open &lt;file&gt;</code>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
