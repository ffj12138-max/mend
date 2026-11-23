// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Section 5: three-tier line matching, and the file line model (section 3).
// ---------------------------------------------------------------------------

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br: '\n', final: false };
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => s.match(/^[ \t]*/)![0];

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

interface TierHit {
  tier: number;
  positions: number[];
}

/** Every occurrence of O in `lines` at the first tier that has one, at or after `from`. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, keep?: (pos: number) => boolean): TierHit | null {
  if (o.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (keep !== undefined && !keep(i)) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (normLine(lines[i + k]!, tier) !== normLine(o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** Re-indent one written line at tier 2 (section 5); other tiers write lines as they are. */
function reindent(line: string, tier: number, fileFirst: string, oldFirst: string): string {
  if (tier !== 2) return line;
  if (line === '' || line.trim() === '') return line;
  const f = leadWs(fileFirst);
  const p = leadWs(oldFirst);
  return line.startsWith(p) ? f + line.slice(p.length) : line;
}

/**
 * The lines a replacement writes. `parts` walks O and N together: a context part copies the
 * file's own matched line; any other part is a new line (subject to tier-2 re-indentation).
 */
type Part = { ctx: number } | { add: string };

function writtenLines(parts: Part[], fileLines: string[], pos: number, o: string[], tier: number): string[] {
  return parts.map((part) => {
    if ('ctx' in part) return fileLines[pos + part.ctx]!;
    return reindent(part.add, tier, fileLines[pos] ?? '', o[0] ?? '');
  });
}

function checkSafe(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface BodyEntry {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  noNl: boolean;
}

interface Hunk {
  a: number;
  entries: BodyEntry[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  isNew: boolean;
  isDel: boolean;
  headerOpen: boolean;
  hunks: Hunk[];
}

function newSection(): Section {
  return { gitOld: null, gitNew: null, dashOld: null, dashNew: null, renameFrom: null, renameTo: null, isNew: false, isDel: false, headerOpen: true, hunks: [] };
}

/** The path on a --- / +++ line: after the four characters, up to a tab, spaces removed, a/ or b/ stripped. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl[0] === ' ' || bl[0] === '-' || bl[0] === '+' || bl[0] === '\\') {
          raw.push(bl);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const entries: BodyEntry[] = [];
      for (const bl of raw) {
        if (bl.startsWith('\\')) {
          if (entries.length > 0) entries[entries.length - 1]!.noNl = true;
        } else if (bl === '') entries.push({ kind: 'ctx', text: '', noNl: false });
        else if (bl[0] === ' ') entries.push({ kind: 'ctx', text: bl.slice(1), noNl: false });
        else if (bl[0] === '-') entries.push({ kind: 'del', text: bl.slice(1), noNl: false });
        else entries.push({ kind: 'add', text: bl.slice(1), noNl: false });
      }
      cur.hunks.push({ a: Number(m[1]), entries });
      cur.headerOpen = false;
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.headerOpen && cur.dashOld === null) {
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1]!);
      } else {
        cur = newSection();
        cur.dashOld = headerPath(line);
        cur.dashNew = headerPath(lines[i + 1]!);
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (cur !== null && cur.headerOpen) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.isNew = true;
      else if (line.startsWith('deleted file mode')) cur.isDel = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** Whether a hunk that touches the end of the file leaves it ending with a line break. */
function endBreak(entries: BodyEntry[], fallback: boolean): boolean {
  for (let k = entries.length - 1; k >= 0; k -= 1) {
    if (entries[k]!.kind !== 'del') return !entries[k]!.noNl;
  }
  return fallback;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.dashOld ?? s.renameFrom ?? s.gitOld;
  const newPath = s.dashNew ?? s.renameTo ?? s.gitNew;
  const creation = s.isNew || s.dashOld === '/dev/null';
  const deletion = s.isDel || s.dashNew === '/dev/null';
  return (tree) => {
    if (creation) {
      const p = newPath;
      if (p === null) throw new Fail('missing', '');
      checkSafe(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let lastAdd: BodyEntry | null = null;
      for (const h of s.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'add') {
            out.push(e.text);
            lastAdd = e;
          }
        }
      }
      const fin = out.length > 0 && !(lastAdd !== null && lastAdd.noNl);
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (deletion) {
      const p = oldPath;
      if (p === null) throw new Fail('missing', '');
      checkSafe(p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldPath === null || newPath === null) throw new Fail('missing', oldPath ?? newPath ?? '');
    checkSafe(oldPath);
    checkSafe(newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const isMove = oldPath !== newPath;
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    if (s.hunks.length === 0) {
      if (isMove) {
        tree.now.set(newPath, before);
        tree.now.set(oldPath, null);
        tree.moves.push([oldPath, newPath]);
      }
      return;
    }
    const f = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const o: string[] = [];
      const parts: Part[] = [];
      for (const e of h.entries) {
        if (e.kind === 'ctx') {
          parts.push({ ctx: o.length });
          o.push(e.text);
        } else if (e.kind === 'del') o.push(e.text);
        else parts.push({ add: e.text });
      }
      if (o.length === 0) {
        let at = h.a + d;
        if (at < 0) at = 0;
        if (at > f.lines.length) at = f.lines.length;
        const adds = parts.map((part) => ('add' in part ? part.add : ''));
        const atEnd = at === f.lines.length;
        f.lines.splice(at, 0, ...adds);
        if (atEnd && f.lines.length > 0) f.final = endBreak(h.entries, f.final);
        d += adds.length;
        continue;
      }
      const hit = findTier(f.lines, o, strict);
      if (hit === null) throw new Fail('no-match', oldPath);
      const target = h.a - 1 + d;
      let pos = hit.positions[0]!;
      for (const cand of hit.positions) {
        if (Math.abs(cand - target) < Math.abs(pos - target)) pos = cand;
      }
      const seg = writtenLines(parts, f.lines, pos, o, hit.tier);
      const reachesEnd = pos + o.length === f.lines.length;
      f.lines.splice(pos, o.length, ...seg);
      if (reachesEnd) f.final = f.lines.length === 0 ? false : endBreak(h.entries, true);
      d += seg.length - o.length;
    }
    tree.now.set(newPath, joinFile(f));
    if (isMove) {
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= regionStart; j -= 1) {
      const cand = lines[j]!;
      if (blank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    prevPath = path;
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    regionStart = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    checkSafe(p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const hit = findTier(f.lines, oldLines, strict);
    if (hit === null) throw new Fail('no-match', p);
    if (hit.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = hit.positions[0]!;
    const parts: Part[] = newLines.map((t) => ({ add: t }));
    const seg = writtenLines(parts, f.lines, pos, oldLines, hit.tier);
    f.lines.splice(pos, oldLines.length, ...seg);
    if (f.lines.length === 0) f.final = false;
    tree.now.set(p, joinFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

interface VSection {
  kind: 'add' | 'del' | 'update';
  path: string;
  line: number;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let curChunk: VChunk | null = null;
  let bodyStarted = false;
  const closeSection = (): void => {
    if (cur === null) return;
    // Blank lines at the end of a section are not part of it: for an Add section they were
    // already collected as empty lines, so drop the trailing ones; for an Update section a
    // trailing empty context line is likewise dropped.
    if (cur.kind === 'add') {
      while (cur.addLines.length > 0 && cur.addLines[cur.addLines.length - 1] === '') cur.addLines.pop();
    }
    if (cur.kind === 'update' && cur.chunks.length > 0) {
      const ch = cur.chunks[cur.chunks.length - 1]!;
      while (ch.entries.length > 0) {
        const tail = ch.entries[ch.entries.length - 1]!;
        if (tail.kind === 'ctx' && tail.text === '') ch.entries.pop();
        else break;
      }
      if (cur.chunks.length > 0 && cur.chunks[cur.chunks.length - 1]!.entries.length === 0 && cur.chunks[cur.chunks.length - 1]!.anchor === null && !cur.chunks[cur.chunks.length - 1]!.eof) cur.chunks.pop();
    }
    if (cur.kind === 'update' && cur.chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.line}`);
    sections.push(cur);
    cur = null;
    curChunk = null;
  };
  for (let idx = first + 1; idx < last; idx += 1) {
    const line = lines[idx]!;
    const num = idx + 1;
    let kind: VSection['kind'] | null = null;
    let rest = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      rest = line.slice('*** Add File: '.length);
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      rest = line.slice('*** Delete File: '.length);
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      rest = line.slice('*** Update File: '.length);
    }
    if (kind !== null) {
      closeSection();
      cur = { kind, path: rest.trim(), line: num, moveTo: null, addLines: [], chunks: [] };
      curChunk = null;
      bodyStarted = false;
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${num}`);
    }
    if (cur.kind === 'add') {
      if (line.startsWith('+')) cur.addLines.push(line.slice(1));
      else if (line === '') cur.addLines.push('');
      else throw new Exit2(`error: parse ${num}`);
      continue;
    }
    if (cur.kind === 'del') {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${num}`);
    }
    // Update File section.
    if (!bodyStarted && cur.chunks.length === 0 && curChunk === null && line.startsWith('*** Move to: ')) {
      cur.moveTo = line.slice('*** Move to: '.length).trim();
      continue;
    }
    if (line.startsWith('@@')) {
      curChunk = { anchor: line.slice(2).trim() === '' ? null : line.slice(2).trim(), eof: false, entries: [] };
      cur.chunks.push(curChunk);
      bodyStarted = true;
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (curChunk === null) {
        curChunk = { anchor: null, eof: true, entries: [] };
        cur.chunks.push(curChunk);
      } else curChunk.eof = true;
      bodyStarted = true;
      // A body line after End of File starts a fresh chunk.
      const done = curChunk;
      curChunk = null;
      void done;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (curChunk === null) {
        curChunk = { anchor: null, eof: false, entries: [] };
        cur.chunks.push(curChunk);
      }
      bodyStarted = true;
      if (line === '') curChunk.entries.push({ kind: 'ctx', text: '', noNl: false });
      else if (line[0] === ' ') curChunk.entries.push({ kind: 'ctx', text: line.slice(1), noNl: false });
      else if (line[0] === '-') curChunk.entries.push({ kind: 'del', text: line.slice(1), noNl: false });
      else curChunk.entries.push({ kind: 'add', text: line.slice(1), noNl: false });
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  closeSection();
  return sections.map((s) => v4aEdit(s, strict));
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    checkSafe(s.path);
    if (s.moveTo !== null) checkSafe(s.moveTo);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'del') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        const anchorHit = findTier(f.lines, [ch.anchor], strict, cursor);
        if (anchorHit === null) throw new Fail('no-match', s.path);
        cursor = anchorHit.positions[0]! + 1;
      }
      const o: string[] = [];
      const parts: Part[] = [];
      for (const e of ch.entries) {
        if (e.kind === 'ctx') {
          parts.push({ ctx: o.length });
          o.push(e.text);
        } else if (e.kind === 'del') o.push(e.text);
        else parts.push({ add: e.text });
      }
      if (o.length === 0) {
        const adds = parts.map((part) => ('add' in part ? part.add : ''));
        const at = ch.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(at, 0, ...adds);
        cursor = at + adds.length;
        continue;
      }
      const hit = findTier(f.lines, o, strict, cursor, ch.eof ? (pos) => pos + o.length === f.lines.length : undefined);
      if (hit === null) throw new Fail('no-match', s.path);
      const pos = hit.positions[0]!;
      const seg = writtenLines(parts, f.lines, pos, o, hit.tier);
      f.lines.splice(pos, o.length, ...seg);
      if (f.lines.length === 0) f.final = false;
      cursor = pos + seg.length;
    }
    const dest = s.moveTo ?? s.path;
    tree.now.set(dest, joinFile(f));
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    }
  };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Section 2 rows: a successful move whose old path is gone and whose new path is new
  // replaces that pair's D and A rows with one R row, sorting by the new path.
  const movedFrom = new Set<string>();
  const movedTo = new Map<string, string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) != null) {
      movedFrom.add(oldP);
      movedTo.set(newP, oldP);
    }
  }
  const keyed: { key: string; row: string }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p) || movedTo.has(p)) continue;
    keyed.push({ key: p, row: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of movedTo) keyed.push({ key: newP, row: `R ${oldP} -> ${newP}` });
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((k) => k.row);
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
