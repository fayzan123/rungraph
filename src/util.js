import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

/**
 * Stream a JSONL file line by line, yielding parsed objects.
 * Malformed / truncated lines (normal mid-write during live tail) are
 * skipped and counted via `onBadLine`, never thrown.
 *
 * @param {string} filePath
 * @param {{ onBadLine?: (line: string, lineNo: number) => void }} [opts]
 * @returns {AsyncGenerator<{ obj: any, lineNo: number }>}
 */
export async function* readJsonLines(filePath, opts = {}) {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo += 1;
    if (line.trim() === '') continue;
    const obj = safeParseJson(line);
    if (obj === undefined) {
      opts.onBadLine?.(line, lineNo);
      continue;
    }
    yield { obj, lineNo };
  }
}

/** JSON.parse that returns undefined instead of throwing. */
export function safeParseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/**
 * Read whole lines from the start of a file without a full read. Starts with
 * a 64KB chunk and doubles (up to `maxBytes`) until at least one complete
 * line is found — real transcripts contain single lines >1MB.
 */
export async function headLines(filePath, bytes = 65536, maxBytes = 8 * 1024 * 1024) {
  const st = await stat(filePath);
  for (let size = bytes; ; size *= 4) {
    const capped = Math.min(size, st.size, maxBytes);
    const text = await readChunk(filePath, 0, capped);
    const lines = text.split('\n');
    const complete = st.size > capped; // last element may be partial
    if (complete) lines.pop();
    const out = lines.filter((l) => l.trim() !== '');
    if (out.length > 0 || capped >= Math.min(st.size, maxBytes)) return out;
  }
}

/**
 * Read whole lines from the end of a file, growing the chunk like headLines.
 */
export async function tailLines(filePath, bytes = 65536, maxBytes = 8 * 1024 * 1024) {
  const st = await stat(filePath);
  for (let size = bytes; ; size *= 4) {
    const capped = Math.min(size, st.size, maxBytes);
    const start = st.size - capped;
    const text = await readChunk(filePath, start, capped);
    const lines = text.split('\n');
    if (start > 0) lines.shift(); // first element may be partial
    const out = lines.filter((l) => l.trim() !== '');
    if (out.length > 0 || capped >= Math.min(st.size, maxBytes)) return out;
  }
}

async function readChunk(filePath, position, length) {
  const fh = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** stat() that returns null instead of throwing on missing paths. */
export async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * POSIX single-quote escaping for one shell word. Clearly-safe strings stay
 * unquoted so the commands users copy or read stay clean (`claude --resume
 * <uuid>`, not a wall of quotes); anything else — spaces, quotes, an empty
 * string — is wrapped and internal quotes escaped, so a pasted command never
 * splits or injects.
 */
export function shellQuote(s) {
  if (/^[A-Za-z0-9_\-./:@%+=,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
