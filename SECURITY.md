# Security policy

## Reporting

Please report vulnerabilities privately via GitHub:
**Security → Report a vulnerability** on this repository
(https://github.com/fayzan123/rungraph/security/advisories/new).
Don't open a public issue for anything exploitable. You'll get a response
within a few days, and credit in the fix's release notes unless you'd rather
not.

## Supported versions

The latest published minor release. rungraph is pre-1.0; fixes ship as a new
release rather than backports.

## Threat model — what counts

rungraph handles your complete agent transcripts: every prompt, tool output,
and file path from every session on the machine. The design promises:

- The server binds `127.0.0.1` only and makes **zero outbound requests**.
- Every request is Host-header-guarded (DNS-rebinding defense) and the two
  write endpoints — `POST /api/focus` and `POST /api/resume` — additionally
  reject non-localhost `Origin`s. Neither executes or persists
  request-supplied strings: resume takes a runId (a lookup key into the
  server's own scan) and a boolean, and the command it launches is built
  entirely server-side, so a forged local request can at worst open a
  terminal with a legitimately-resumed session sitting at its prompt.
- Nothing leaves the machine except an explicit `rungraph export`, which
  prints an inventory every time and hard-blocks on detected secrets.
- The port registry directory is created `0o700` and ownership-verified
  before any read or write, so another local user can't plant entries.
- `.rungraph` bundles are parsed defensively: a hostile bundle may not crash
  the viewer, escape its own bundle's data, or reach local runs.

A violation of any of those promises is a security bug — for example: any
way a web page or remote host can read transcript data or drive the server;
a bundle crafted to read outside itself; registry trust bypass; the export
path writing something the inventory didn't disclose.

**Not** in scope: secrets-scan misses (the scan is a calibrated consent
surface, not a guarantee — `--structure-only` exists for when it matters),
and anything requiring an attacker who can already run code as your user,
who could simply read `~/.claude/projects` directly.
