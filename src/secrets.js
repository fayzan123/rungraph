/**
 * The secrets scan behind BOTH boundaries where content leaves this machine:
 * `rungraph export` (which blocks) and `rungraph mcp` (which redacts every
 * tool result on the way to the model provider). One pattern list, because two
 * could disagree about what a secret is and the weaker one would decide.
 *
 * GOVERNING RULE: precision over recall, exactly as for signals. Anchored,
 * prefix-keyed patterns only — no entropy heuristics, which flag every hash
 * and UUID and train users to reflexively type `--allow-secrets`, after which
 * the scanner protects no one. The block is cheap (a re-run); the failure it
 * prevents is irreversible (a live key in someone's Slack).
 *
 * The pattern list is CALIBRATED against the real local corpus (617 Claude
 * transcripts + 74 Codex rollouts on this machine), not reasoned into place —
 * see the discovery report. The bar: near-zero false positives. Notably
 * excluded on those grounds: bare `sk-…` (matches ordinary identifiers), JWTs
 * (transcripts are full of them, most expired or synthetic), and any
 * high-entropy-string heuristic.
 *
 * Pure: no I/O, no imports. Callers decide what text to scan and what to do
 * with findings; export FAILS CLOSED around this module — if scanning throws,
 * the bundle does not leave.
 */

/**
 * @typedef {Object} SecretPattern
 * @property {string} kind      Stable machine id, used in [REDACTED:<kind>].
 * @property {string} name      Human name for the findings listing.
 * @property {string} source    RegExp source (compiled fresh per scan — shared
 *                              RegExp objects carry lastIndex state).
 * @property {string} [flags]   Extra flags beyond 'g' (e.g. 'i').
 * @property {string} hint      The prefix shown in listings, e.g. "AKIA…".
 */

/**
 * The calibrated ship list (discovery report 2026-08-15, both corpora):
 * every pattern scored zero false positives as written, and three scored real
 * catches — the npm and Anthropic patterns each found live keys in Codex
 * transcripts that had captured `.npmrc` / `.env` reads verbatim.
 *
 * Two refinements exist because the measurement demanded them: AWS excludes
 * the `…EXAMPLE` documentation key (the corpus's entire AKIA population), and
 * the PEM pattern requires a ≥40-char base64 body — the corpus's four PEM
 * headers are all deliberate test fixtures with 3–24-char bodies, and the
 * body alternation accepts both real newlines and embedded literal `\n`
 * pairs (content that itself quotes JSON). Deliberately absent, from the same
 * measurement: JWTs (the only corpus hit is a public-by-design Supabase anon
 * key), bare `sk-` (fake test keys sit 1–2 chars under any workable floor),
 * and `sk_test_` (not a secret).
 *
 * @type {SecretPattern[]}
 */
export const SECRET_PATTERNS = [
  {
    kind: 'aws-access-key',
    name: 'AWS access key',
    source: '\\b(?:AKIA|ASIA)(?![0-9A-Z]{9}EXAMPLE\\b)[0-9A-Z]{16}\\b',
    hint: 'AKIA…',
  },
  {
    kind: 'aws-secret-key',
    name: 'AWS secret key',
    source: 'aws_secret_access_key(?:\\\\?["\'])?\\s*[=:]\\s*(?:\\\\?["\'])?[A-Za-z0-9/+=]{40}\\b',
    flags: 'i',
    hint: 'aws_secret_access_key=…',
  },
  {
    kind: 'github-token',
    name: 'GitHub token',
    source: '\\bgh[pousr]_[A-Za-z0-9]{36,}\\b',
    hint: 'ghp_…',
  },
  {
    kind: 'github-pat',
    name: 'GitHub fine-grained PAT',
    source: '\\bgithub_pat_[A-Za-z0-9_]{22,}\\b',
    hint: 'github_pat_…',
  },
  {
    kind: 'slack-token',
    name: 'Slack token',
    source: '\\bxox[baprs]-[0-9A-Za-z-]{10,}\\b',
    hint: 'xox…',
  },
  {
    kind: 'npm-token',
    name: 'npm token',
    source: '\\bnpm_[A-Za-z0-9]{36}\\b',
    hint: 'npm_…',
  },
  {
    kind: 'anthropic-key',
    name: 'Anthropic API key',
    source: '\\bsk-ant-[A-Za-z0-9_-]{20,}\\b',
    hint: 'sk-ant-…',
  },
  {
    kind: 'openai-key',
    name: 'OpenAI API key',
    source: '\\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}\\b',
    hint: 'sk-proj-…',
  },
  {
    kind: 'openai-legacy-key',
    name: 'OpenAI legacy key',
    // The T3BlbkFJ (= base64 "OpenAI") infix is in every legacy key and
    // nowhere else in 366MB of corpus — self-anchoring.
    source: '\\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\\b',
    hint: 'sk-…T3BlbkFJ…',
  },
  {
    kind: 'google-api-key',
    name: 'Google API key',
    // Lookbehind instead of \b: `AIza` occurs inside base64 blobs, where a
    // preceding `+` or `/` would satisfy \b and a third of blob tails would
    // satisfy the length — the lookbehind closes that edge. `=` is NOT in the
    // exclusion (unlike the discovery report's draft): base64 `=` is terminal
    // padding, so a blob cannot put one mid-run, while `KEY=AIza…` is exactly
    // how a real env-dump leak reads.
    source: '(?<![A-Za-z0-9+/])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])',
    hint: 'AIza…',
  },
  {
    kind: 'stripe-live-key',
    name: 'Stripe live key',
    source: '\\b[sr]k_live_[0-9a-zA-Z]{20,}\\b',
    hint: 'sk_live_…',
  },
  {
    kind: 'sendgrid-key',
    name: 'SendGrid key',
    source: '\\bSG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}\\b',
    hint: 'SG.…',
  },
  {
    kind: 'gitlab-pat',
    name: 'GitLab token',
    source: '\\bglpat-[0-9a-zA-Z_-]{20}',
    hint: 'glpat-…',
  },
  {
    kind: 'private-key-block',
    name: 'private key block',
    source: '-----BEGIN [A-Z ]*PRIVATE KEY-----(?:(?:\\\\[rn])+|[\\r\\n\\s]+)[A-Za-z0-9/+=]{40}',
    hint: '-----BEGIN…',
  },
];

/**
 * Field NAMES whose value is a secret by position, not by shape.
 *
 * Cursor keeps two live encryption keys on its records — `blobEncryptionKey`
 * (a bare 64-hex string on the CLI store, base64 on the IDE) and
 * `speculativeSummarizationEncryptionKey` — and `redactTree()` scored ZERO on
 * both: every entry in SECRET_PATTERNS is a vendor-prefixed token, and nothing
 * matches a bare hash. The obvious fix — a 64-hex pattern — is wrong on its
 * first day: Cursor's blob ids, its `latestRootBlobId`, and every
 * `agentKv:blob:<sha256>` key are 64-hex too, so that pattern would redact
 * thousands of harmless identifiers and make the export's redaction count
 * meaningless. Precision over recall, again.
 *
 * So the second line of defence is keyed by NAME: `walkStrings` already
 * carries the path, and a value sitting under one of these field names is
 * redacted wherever it is, whatever it looks like, reported as
 * `[REDACTED:key-name]`. Vendor-neutral — a list of field names, not of
 * vendors — and it cannot fire on a value that merely looks like a hash.
 * (The first line is the Cursor adapter never copying either field into the
 * IR, `details` or `ext` at all; this guards the day a future `details`
 * dumps a raw record.)
 *
 * A Set of exact names. Matched against the LAST path segment only.
 */
export const SECRET_KEY_NAMES = new Set(['blobEncryptionKey', 'speculativeSummarizationEncryptionKey']);
export const KEY_NAME_KIND = 'key-name';

/** Is this walk path's leaf a field whose value is a secret by position? */
export function isSecretKeyPath(path) {
  const leaf = Array.isArray(path) ? path[path.length - 1] : undefined;
  return typeof leaf === 'string' && SECRET_KEY_NAMES.has(leaf);
}

/**
 * Scan one string. Returns one entry per pattern kind that matched, with a
 * count — never the matched text itself, which the caller must not echo.
 *
 * @param {string} text
 * @returns {Array<{kind: string, name: string, hint: string, count: number}>}
 */
export function scanText(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const p of SECRET_PATTERNS) {
    const matches = text.match(new RegExp(p.source, 'g' + (p.flags ?? '')));
    if (matches) out.push({ kind: p.kind, name: p.name, hint: p.hint, count: matches.length });
  }
  return out;
}

/**
 * Replace every match with `[REDACTED:<kind>]`. The placeholder deliberately
 * cannot re-match any pattern, so redacted output re-scans clean — which the
 * export path verifies rather than assumes.
 *
 * @param {string} text
 * @returns {{ text: string, redacted: number }}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', redacted: 0 };
  let redacted = 0;
  let out = text;
  for (const p of SECRET_PATTERNS) {
    out = out.replace(new RegExp(p.source, 'g' + (p.flags ?? '')), () => {
      redacted += 1;
      return `[REDACTED:${p.kind}]`;
    });
  }
  return { text: out, redacted };
}

/**
 * Deep-walk every string in an object tree, giving the visitor a setter so it
 * can replace in place. Walking the object rather than the serialized JSON
 * keeps locations available to callers that want to report them.
 *
 * Lives here rather than in bundle.js because export is no longer the only
 * boundary that needs it: `rungraph mcp` redacts on the way out too, and
 * mcp.js must not import the export path to get a walker.
 *
 * @param {unknown} value
 * @param {Array<string|number>} path
 * @param {(path: Array<string|number>, text: string, set: (v: string) => void) => void} visit
 */
export function walkStrings(value, path, visit) {
  if (typeof value === 'string') return; // root string — no setter, callers pass objects
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      if (typeof v === 'string') visit([...path, i], v, (nv) => (value[i] = nv));
      else if (v && typeof v === 'object') walkStrings(v, [...path, i], visit);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'string') visit([...path, k], v, (nv) => (value[k] = nv));
      else if (v && typeof v === 'object') walkStrings(v, [...path, k], visit);
    }
  }
}

/**
 * Redact every secret anywhere in an object tree, IN PLACE, and return how
 * many matches were replaced. The count is the point as much as the
 * redaction: a caller that silently strips secrets leaves the reader thinking
 * it saw everything, which is the same failure `coverage` exists to prevent.
 *
 * @param {unknown} tree
 * @returns {number}
 */
export function redactTree(tree) {
  let redacted = 0;
  walkStrings(tree, [], (path, text, set) => {
    // By position first: a value under a secret field NAME is replaced whole,
    // whatever it looks like. An empty value is nothing to redact.
    if (isSecretKeyPath(path)) {
      if (text) {
        redacted += 1;
        set(`[REDACTED:${KEY_NAME_KIND}]`);
      }
      return;
    }
    const { text: out, redacted: n } = redactSecrets(text);
    if (n > 0) {
      redacted += n;
      set(out);
    }
  });
  return redacted;
}
