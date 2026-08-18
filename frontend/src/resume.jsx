import { useEffect, useState } from 'preact/hooks';
import { postResume } from './api.js';

/**
 * The edge from the canvas back to the terminal: two actions plus one fork
 * checkbox. "Open in terminal" launches on macOS via POST /api/resume;
 * "copy command" works everywhere. The command text is always on screen, so
 * the affordance also teaches the CLI incantation — and nothing is ever
 * silent: the command shown is exactly the command that runs.
 *
 * Failures are toasts, never crashes: a stale runId (session file deleted
 * since the index was built) says so; a launch failure degrades to copying
 * the command with an explanatory note.
 */

const WIDTH = 320;
const EST_HEIGHT = 200; // clamp estimate — enough to keep the card on screen

export function ResumePopover({ entry, anchor, onClose, onNote }) {
  const resume = entry.resume;
  const forkable = Boolean(resume.forkCopyCommand);
  // A live run pre-checks the fork (concurrent writers interleave transcripts;
  // forking makes that opt-in) — but forking an OLD conversation is first-class
  // too, so the checkbox is always offered where the vendor supports it.
  const [fork, setFork] = useState(() => Boolean(entry.active && forkable));
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const cmd = fork ? resume.forkCopyCommand : resume.copyCommand;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      () => onNote(`could not copy — run: ${cmd}`),
    );
  };

  const launch = () => {
    setBusy(true);
    postResume(entry.runId, fork).then(
      (r) => {
        if (r.launched) {
          onNote('opened a terminal window — the session is resuming there');
          onClose();
          return;
        }
        // The launcher declined (platform, spawn, or automation permission) —
        // degrade to the copy tier, with the server's own command string.
        const fallback = r.copyCommand || cmd;
        navigator.clipboard?.writeText(fallback).then(
          () => onNote("couldn't open a terminal — command copied, paste it to resume"),
          () => onNote(`couldn't open a terminal — run: ${fallback}`),
        );
        onClose();
      },
      (e) => {
        const msg = String(e?.message ?? e);
        onNote(/\b404\b/.test(msg) ? 'that session is no longer on disk' : `resume failed — ${msg}`);
        onClose();
      },
    );
  };

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const left = Math.max(8, Math.min(anchor.left, vw - WIDTH - 8));
  const top = Math.max(8, Math.min(anchor.bottom + 6, vh - EST_HEIGHT - 8));

  return (
    <div class="resume-layer">
      <div class="resume-overlay" onClick={onClose} />
      <div
        class="resume-popover"
        role="dialog"
        aria-label={`resume ${entry.title || 'this session'}`}
        style={{ left: `${left}px`, top: `${top}px` }}
      >
        <div class="microlabel">resume in your terminal</div>
        <code class="resume-cmd">{cmd}</code>
        {forkable && (
          <label class="resume-fork">
            <input
              type="checkbox"
              checked={fork}
              onChange={(e) => setFork(e.currentTarget.checked)}
            />
            <span>fork — resume as a new session</span>
          </label>
        )}
        {entry.active && fork && (
          <div class="resume-warn fork">session is active elsewhere — resuming a fork</div>
        )}
        {entry.active && !fork && (
          <div class="resume-warn">active — resuming may interleave with the running session</div>
        )}
        <div class="resume-actions">
          {resume.canLaunch && (
            <button class="ghost primary" onClick={launch} disabled={busy}>
              {busy ? 'opening…' : 'open in terminal'}
            </button>
          )}
          <button class="ghost" onClick={copy}>
            {copied ? 'copied ✓' : 'copy command'}
          </button>
        </div>
      </div>
    </div>
  );
}
