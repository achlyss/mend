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

/** A file's text as lines, its line break and whether it ends with one (SPEC.md section 3). */
interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}
function splitFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], final: false };
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function joinFile(ft: FileText): string {
  if (ft.lines.length === 0) return '';
  return ft.lines.join(ft.br) + (ft.final ? ft.br : '');
}

/** Successful moves, for the `R` output lines (SPEC.md section 2). Cleared per run. */
const MOVES: { old: string; nw: string }[] = [];

const leadWs = (s: string): string => (/^[ \t]*/.exec(s) ?? [''])[0]!;
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const onlyWs = (s: string): boolean => /^[ \t]*$/.test(s);

/** Line equality at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O's lines match the file's lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; 0 only when strict) at which O occurs, or null. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const occ = occurrences(lines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/**
 * The lines N writes for a match at `at`, at `tier` (SPEC.md section 5). nSrc[j] is the index into O of the
 * context line N's j-th line is, or null for a new line. Context lines take the file's own matched line; at tier 2
 * the other lines are re-indented from O's first line's leading whitespace to the file's.
 */
function buildN(n: string[], nSrc: (number | null)[], fileLines: string[], at: number, o: string[], tier: number): string[] {
  const f = tier === 2 && o.length > 0 ? leadWs(fileLines[at]!) : '';
  const p = tier === 2 && o.length > 0 ? leadWs(o[0]!) : '';
  return n.map((line, j) => {
    const src = nSrc[j]!;
    if (src !== null) return fileLines[at + src]!;
    if (tier === 2 && !onlyWs(line) && line.startsWith(p)) return f + line.slice(p.length);
    return line;
  });
}

/** Replace the k lines at `at` with `replacement`, keeping the file's break and final-break flag. */
function spliceLines(ft: FileText, at: number, k: number, replacement: string[]): FileText {
  const lines = [...ft.lines];
  lines.splice(at, k, ...replacement);
  return { br: ft.br, lines, final: ft.final };
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** A unified hunk: the old start line and its body lines (SPEC.md section 6). */
interface Hunk {
  a: number;
  body: { kind: string; text: string }[];
}
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function headerPath(l: string): string {
  return l.slice(4).split('\t')[0]!.trim();
}
function stripPrefix(p: string): string | null {
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** Apply a section's hunks to a file's lines, in order (SPEC.md section 6). */
function applyUnifiedHunks(ft: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  let cur = ft;
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: string[] = [];
    const nSrc: (number | null)[] = [];
    let hasLast = false;
    let lastHasBackslash = false;
    for (let j = 0; j < h.body.length; j += 1) {
      const b = h.body[j]!;
      if (b.kind === ' ' || b.kind === '') {
        o.push(b.text);
        n.push(b.text);
        nSrc.push(o.length - 1);
        hasLast = true;
        lastHasBackslash = j + 1 < h.body.length && h.body[j + 1]!.kind === '\\';
      } else if (b.kind === '-') {
        o.push(b.text);
      } else if (b.kind === '+') {
        n.push(b.text);
        nSrc.push(null);
        hasLast = true;
        lastHasBackslash = j + 1 < h.body.length && h.body[j + 1]!.kind === '\\';
      }
    }
    if (o.length === 0) {
      const at = Math.min(h.a + d, cur.lines.length);
      const lines = [...cur.lines];
      lines.splice(at, 0, ...n);
      let final = cur.final;
      if (at === cur.lines.length) final = hasLast ? !lastHasBackslash : true;
      cur = { br: cur.br, lines, final };
      d += n.length;
    } else {
      const found = findTier(cur.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let at = found.occ[0]!;
      let best = Math.abs(at - target);
      for (const pos of found.occ) {
        const dist = Math.abs(pos - target);
        if (dist < best) {
          at = pos;
          best = dist;
        }
      }
      const replacement = buildN(n, nSrc, cur.lines, at, o, found.tier);
      const lines = [...cur.lines];
      lines.splice(at, o.length, ...replacement);
      let final = cur.final;
      if (at + o.length === cur.lines.length) final = hasLast ? !lastHasBackslash : true;
      cur = { br: cur.br, lines, final };
      d += n.length - o.length;
    }
  }
  return cur;
}

function unifiedSectionEdit(s: UniSection, strict: boolean): Edit {
  const isCreate = s.isCreate || s.oldPath === null;
  if (isCreate) {
    const p = s.newPath;
    if (p === null) return () => {};
    const plus: string[] = [];
    let lastHasBackslash = false;
    for (const h of s.hunks) {
      for (let j = 0; j < h.body.length; j += 1) {
        const b = h.body[j]!;
        if (b.kind === '+') {
          plus.push(b.text);
          lastHasBackslash = j + 1 < h.body.length && h.body[j + 1]!.kind === '\\';
        }
      }
    }
    const text = plus.length === 0 ? '' : plus.join('\n') + (lastHasBackslash ? '' : '\n');
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  const isDelete = s.isDelete || s.newPath === null;
  if (isDelete) {
    const p = s.oldPath;
    if (p === null) return () => {};
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (s.oldPath !== null && s.newPath !== null && s.oldPath !== s.newPath) {
    const oldP = s.oldPath;
    const newP = s.newPath;
    return (tree) => {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyUnifiedHunks(splitFile(before), s.hunks, strict, oldP);
      tree.now.set(newP, joinFile(out));
      tree.now.set(oldP, null);
      MOVES.push({ old: oldP, nw: newP });
    };
  }
  const p = s.oldPath!;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const out = applyUnifiedHunks(splitFile(before), s.hunks, strict, p);
    tree.now.set(p, joinFile(out));
  };
}

/** Read a unified diff patch (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;
  let sawPair = false;
  const finishHunk = (): void => {
    if (hunk === null || cur === null) return;
    while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === '') hunk.body.pop();
    cur.hunks.push(hunk);
    hunk = null;
  };
  const startSection = (oldP: string | null, newP: string | null): void => {
    finishHunk();
    cur = { oldPath: oldP, newPath: newP, isCreate: false, isDelete: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    sawPair = false;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (hunk !== null) {
      if (l.startsWith('diff --git') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        finishHunk();
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        hunk.body.push({ kind: l === '' ? '' : l[0]!, text: l === '' ? '' : l.slice(1) });
        continue;
      } else {
        finishHunk();
      }
    }
    if (l.startsWith('diff --git')) {
      const rest = l.slice('diff --git'.length).trim();
      const m = /^a\/(.+) b\/(.+)$/.exec(rest);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      continue;
    }
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        const oldP = stripPrefix(headerPath(l));
        const newP = stripPrefix(headerPath(lines[i + 1]!));
        if (inHeader && cur !== null && !sawPair) {
          cur.oldPath = oldP;
          cur.newPath = newP;
          sawPair = true;
        } else {
          startSection(oldP, newP);
          sawPair = true;
        }
        i += 1;
        continue;
      }
      if (inHeader) throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      hunk = { a: Number(m[1]), body: [] };
      continue;
    }
    if (inHeader && cur !== null) {
      if (l.startsWith('rename from ')) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.isCreate = true;
      else if (l.startsWith('deleted file mode')) cur.isDelete = true;
    }
  }
  finishHunk();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function searchReplaceEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  if (oldLines.length === 0) {
    const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const ft = splitFile(before);
    const found = findTier(ft.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const replacement = buildN(newLines, newLines.map(() => null), ft.lines, at, oldLines, found.tier);
    tree.now.set(p, joinFile(spliceLines(ft, at, oldLines.length, replacement)));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let p: string | null = null;
    for (let j = searchLine - 1; j >= prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      p = t;
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(p, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** A V4A chunk: its anchor, whether it is anchored to the end of the file, and its body lines. */
interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: { kind: string; text: string }[];
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    for (let i = from; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, with those occurrences, or null. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let tier = 0; tier <= max; tier += 1) {
    const occ = occurrences(lines, o, tier).filter((pos) => pos >= from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

function v4aAddEdit(p: string, fileLines: string[]): Edit {
  const text = fileLines.length === 0 ? '' : fileLines.join('\n') + '\n';
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, text);
  };
}
function v4aDeleteEdit(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

/** One V4A Update File section (SPEC.md section 8). */
function v4aUpdateEdit(p: string, moveTo: string | null, chunks: V4AChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let ft = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ft.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: string[] = [];
      const nSrc: (number | null)[] = [];
      for (const b of ch.body) {
        if (b.kind === ' ' || b.kind === '') {
          o.push(b.text);
          n.push(b.text);
          nSrc.push(o.length - 1);
        } else if (b.kind === '-') {
          o.push(b.text);
        } else if (b.kind === '+') {
          n.push(b.text);
          nSrc.push(null);
        }
      }
      if (o.length === 0) {
        const at = ch.eof ? ft.lines.length : cursor;
        const lines = [...ft.lines];
        lines.splice(at, 0, ...n);
        ft = { br: ft.br, lines, final: ft.final };
        cursor = at + n.length;
      } else {
        const found = findTierFrom(ft.lines, o, cursor, strict);
        if (found === null) throw new Fail('no-match', p);
        let at: number;
        if (ch.eof) {
          at = found.occ.find((pos) => pos + o.length === ft.lines.length) ?? -1;
          if (at < 0) throw new Fail('no-match', p);
        } else {
          at = found.occ[0]!;
        }
        const replacement = buildN(n, nSrc, ft.lines, at, o, found.tier);
        const lines = [...ft.lines];
        lines.splice(at, o.length, ...replacement);
        ft = { br: ft.br, lines, final: ft.final };
        cursor = at + replacement.length;
      }
    }
    const text = joinFile(ft);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(p, null);
      MOVES.push({ old: p, nw: moveTo });
    } else {
      tree.now.set(p, text);
    }
  };
}

const v4aSectionStart = (t: string): boolean =>
  t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ');

/** Read a V4A patch (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      const secLines: { text: string; idx: number }[] = [];
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j]!)) {
        secLines.push({ text: lines[j]!, idx: j });
        j += 1;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      const fileLines: string[] = [];
      for (const { text: t, idx } of secLines) {
        if (t.startsWith('+')) fileLines.push(t.slice(1));
        else if (t === '') fileLines.push('');
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aAddEdit(p, fileLines));
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last && !v4aSectionStart(lines[j]!)) {
        if (!blank(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      edits.push(v4aDeleteEdit(p));
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      let moveTo: string | null = null;
      let j = i + 1;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j += 1;
      }
      const secLines: { text: string; idx: number }[] = [];
      while (j < last && !v4aSectionStart(lines[j]!)) {
        secLines.push({ text: lines[j]!, idx: j });
        j += 1;
      }
      while (secLines.length > 0 && blank(secLines[secLines.length - 1]!.text)) secLines.pop();
      const chunks: V4AChunk[] = [];
      let cur: V4AChunk | null = null;
      const finishChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (const { text: t, idx } of secLines) {
        if (t.startsWith('@@')) {
          finishChunk();
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        } else if (t.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          finishChunk();
        } else if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || t === '') {
          if (cur === null) cur = { anchor: null, eof: false, body: [] };
          cur.body.push({ kind: t === '' ? '' : t[0]!, text: t === '' ? '' : t.slice(1) });
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      finishChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
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
  MOVES.length = 0;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, { key: string; line: string }>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of MOVES) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      changed.delete(m.old);
      changed.delete(m.nw);
      changed.set(m.nw, { key: m.nw, line: `R ${m.old} -> ${m.nw}` });
    }
  }
  const rows = [...changed.values()]
    .sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)))
    .map((r) => r.line);
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
