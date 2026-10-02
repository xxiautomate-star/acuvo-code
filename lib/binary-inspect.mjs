/**
 * ── ⭐⭐ `inspect_binary` — THE QUESTION THE AGENT COULD NOT ASK ─────────────
 *
 * MEASURED across this repository's 139 stored Terminal-Bench transcripts
 * (`bench/terminal-bench/results/`), 2026-08-29:
 *
 *     18 runs reached for binary forensics, 57 calls between them
 *     11 × `/bin/sh: 1: file: not found`
 *      7 × `xxd: not found`
 *      5 runs had `file …` as their DECLARED VERIFICATION COMMAND, and it
 *        exited 127 — the run's own pass/fail gate died on a missing binary
 *
 * Verbatim, `deep100/extract-elf`, the first three rounds of the run:
 *
 *     round 1  $ file a.out && ls -la a.out     ✖ exit 127 · file: not found
 *     round 2  $ ls -la a.out && xxd a.out …    ✔
 *     round 3  $ od -A x -t x1z a.out | head    ✔
 *
 * Two paid rounds to discover which hexdumper the container happened to ship,
 * then five more hand-decoding ELF program headers inside `evaluate` — offsets
 * read out of an `od` dump by eye, in prose, with a "Wait, let me re-read"
 * halfway through. That is the whole first third of a 29-round run.
 *
 * ⚠️⚠️ AND ON THE DEFAULT SURFACE THE QUESTION IS NOT MERELY UNANSWERED, IT IS
 * UNASKABLE. `run_program`'s allowlist is node/npm/npx/tsc, so there is no
 * `file`, no `xxd`, no `od` — and `workspace.mjs`'s binary refusal ends
 * *"there is no text form and re-reading it returns this same refusal — get what
 * you need from a text file instead."* An instruction to give up, given to a
 * model that was asked to read a compiled program.
 *
 * ── ⭐ WHAT IS WRAPPED AND WHAT IS OURS ─────────────────────────────────────
 *
 * WRAPPED: `lib/vendor/magic-bytes.mjs` — 205 file signatures under MIT, the
 * `file(1)` magic table without `file(1)`. We wrote none of it and the NOTICE
 * beside it is the condition of taking it.
 *
 * OURS, because it cannot be integrated: the STRUCTURAL half. A signature match
 * says "ELF"; `file` says "ELF 64-bit LSB executable, x86-64" and the bench run
 * above needed more than either — it needed the program header table. So on top
 * of the signature this module decodes the header of the four container formats
 * that actually appeared in the transcripts (ELF, PE, Mach-O, SQLite) and
 * returns the segment table, which is the thing five rounds were spent
 * reconstructing by hand.
 *
 * ── ⚠️ WHY THE OFFER IS GATED, AND WHY THAT IS NOT A DODGE ──────────────────
 *
 * `declared-tools-are-named.test.mjs` pins the raw 16-round offer under
 * 60,000 B. Measured immediately before this verb existed: **59,513 B — 487
 * bytes of headroom**, and this schema is larger than that. Raising the ceiling
 * to fit a new verb is the move that ceiling exists to prevent, so the offer is
 * gated on evidence exactly as `inspect_db` and `profile_table` are: a
 * repository with no binary in it pays **0**, and one with a compiled artifact
 * pays for the verb it can use. That is not a way around the ceiling, it is the
 * honest description of the tool — there is nothing here to point at an
 * all-TypeScript repository.
 */

import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { basename, join } from 'node:path';

import { resolveInWorkspace } from './workspace.mjs';
import { refusedCommitPath } from './secret-paths.mjs';
import { filetypeinfo } from './vendor/magic-bytes.mjs';

/** How many bytes of the head are read for identification. Enough for an ELF
 *  header (64 B), a PE header behind its stub, and a SQLite header (100 B). */
export const HEAD_BYTES = 4096;

/** `hex` mode. A dump is for orientation, not for exfiltrating a file one round
 *  at a time — 4 KB is 256 lines, already past the point of usefulness. */
export const DEFAULT_HEX_BYTES = 256;
export const MAX_HEX_BYTES = 4096;

/** `strings` mode. */
export const DEFAULT_MIN_STRING = 4;
export const MAX_STRING_RESULTS = 200;
/** How far into the file `strings` will scan. `strings(1)` reads the whole
 *  thing; a tool result that must survive a context window cannot. */
export const MAX_STRING_SCAN = 4 * 1024 * 1024;

/** Program headers reported for an ELF. A stripped `a.out` has 8-13. */
export const MAX_PROGRAM_HEADERS = 24;

/**
 * ── ⚠️ THE GATE, PART ONE: EXTENSIONS THAT MEAN "NOT TEXT" ──────────────────
 *
 * ⚠️ `.dat` IS DELIBERATELY ABSENT even though it is very often binary:
 * `table-profile.mjs` claims it for `profile_table`, and two verbs whose gates
 * both fire on the same file is how a model gets offered the wrong one. A `.dat`
 * that is genuinely binary still reaches this verb through part two below, on
 * its content.
 */
export const BINARY_EXTENSIONS = Object.freeze([
  // compiled objects and images
  '.out', '.bin', '.o', '.a', '.so', '.dylib', '.dll', '.exe', '.elf', '.obj', '.lib',
  '.wasm', '.class', '.pyc', '.pyo', '.ko', '.efi', '.img', '.iso', '.rom', '.hex',
  // containers a build or a task hands you
  '.zip', '.jar', '.war', '.apk', '.7z', '.gz', '.bz2', '.xz', '.zst', '.tgz', '.rar',
  // databases and dumps
  '.db', '.sqlite', '.sqlite3', '.mdb', '.dmp', '.core', '.wal', '.pack', '.idx',
]);

const EVIDENCE_PROBE_DIRS = 12;
/**
 * ⚠️ THIS IS `tableEvidence`'S SKIP LIST MINUS THREE ENTRIES, AND THE THREE ARE
 * THE POINT. `dist/`, `build/` and `target/` are skipped over there because a
 * build output directory is not where anybody keeps a CSV — and they are exactly
 * and only where a compiled artifact lives. Copying that list unchanged is the
 * first thing I did and it made the gate blind to `build/app.wasm`, which is the
 * commonest shape this verb exists for.
 */
const EVIDENCE_SKIP = new Set(['node_modules', 'vendor', 'coverage', '.git']);
/** Part two of the gate opens files. Bounded, because it runs once per turn. */
const EVIDENCE_SNIFF_LIMIT = 24;
const SNIFF_BYTES = 8;

const evidenceCache = new Map();

function hasBinaryExtension(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && BINARY_EXTENSIONS.includes(name.slice(dot).toLowerCase());
}

/**
 * ── ⚠️ THE GATE, PART TWO: THE FILE WITH NO EXTENSION ───────────────────────
 *
 * `a.out` is caught by its extension. `hi`, `main`, `program`, `solver` — the
 * names a `gcc -o` actually produces in these tasks — have none, and an
 * extension list can never catch them. So an extension-less regular file gets
 * its first EIGHT bytes read, and that is the entire test: a NUL byte, or a
 * signature the vendored table recognises.
 *
 * ⚠️ EIGHT BYTES, NOT EIGHT KILOBYTES, and never more than 24 files. A gate that
 * costs half a second is worse than a missing tool — `dbEvidence`'s first
 * version walked the tree for .sql files, cost 478ms per turn, and took the CLI
 * suite from 111s to 285s. This one is capped in both dimensions and memoised
 * per root on top.
 */
function sniffLooksBinary(absolute) {
  let fd = -1;
  try {
    fd = openSync(absolute, 'r');
    const buf = Buffer.alloc(SNIFF_BYTES);
    const n = readSync(fd, buf, 0, SNIFF_BYTES, 0);
    if (n <= 0) return false;
    const head = buf.subarray(0, n);
    if (head.includes(0)) return true;
    return filetypeinfo(head).length > 0;
  } catch {
    return false;
  } finally {
    if (fd >= 0) { try { closeSync(fd); } catch { /* already gone */ } }
  }
}

/**
 * Does this workspace contain a binary file at all?
 *
 * ⚠️ IT IS NOT `!looksLikeText`. Everything this returns true for is something
 * the verb can actually describe. A repository of TypeScript gets no offer and
 * pays no bytes, which is the whole reason the gate exists.
 */
export function binaryEvidence(root) {
  if (typeof root !== 'string' || root === '' || root.startsWith('(')) return false;
  const cached = evidenceCache.get(root);
  if (cached !== undefined) return cached;

  let found = false;
  let sniffed = 0;
  const dirs = [];
  const sniffQueue = [];

  const scan = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (dir === root && !e.name.startsWith('.') && !EVIDENCE_SKIP.has(e.name) && dirs.length < EVIDENCE_PROBE_DIRS) {
          dirs.push(join(dir, e.name));
        }
        continue;
      }
      if (!e.isFile()) continue;
      if (hasBinaryExtension(e.name)) return true;
      if (!e.name.startsWith('.') && e.name.indexOf('.') < 0 && sniffQueue.length < EVIDENCE_SNIFF_LIMIT) {
        sniffQueue.push(join(dir, e.name));
      }
    }
    return false;
  };

  try {
    found = scan(root);
    if (!found) for (const dir of dirs) { if (scan(dir)) { found = true; break; } }
    /**
     * ⚠️ THE SNIFF RUNS LAST, DELIBERATELY. An extension match is free and an
     * open() is not, so a workspace with an obvious `.so` in it never opens
     * anything at all.
     */
    if (!found) {
      for (const abs of sniffQueue) {
        if (sniffed >= EVIDENCE_SNIFF_LIMIT) break;
        sniffed += 1;
        if (sniffLooksBinary(abs)) { found = true; break; }
      }
    }
  } catch {
    // An unreadable root is not evidence, and must not be an exception either.
  }

  evidenceCache.set(root, found);
  return found;
}

/** Test seam — the cache is keyed by root and a test creates and deletes roots. */
export function resetBinaryEvidenceCache() { evidenceCache.clear(); }

/**
 * The names to OFFER this turn.
 *
 * ⚠️ MULTI-ROUND ONLY, like every other read: it describes a file so the NEXT
 * round can act on it. NOT gated on `allowRun` — it spawns nothing, and the
 * shell-less surface is the one with no `xxd` to fall back to, so withholding it
 * there would remove the capability from exactly the place it is the only one.
 */
export function binaryInspectToolNames(root, { maxRounds = 2 } = {}) {
  if (maxRounds <= 1) return [];
  return binaryEvidence(root) ? ['inspect_binary'] : [];
}

// ── the structural decoders ────────────────────────────────────────────────

const ELF_TYPES = { 0: 'none', 1: 'relocatable', 2: 'executable', 3: 'shared object / PIE', 4: 'core dump' };
const ELF_MACHINES = {
  0x02: 'SPARC', 0x03: 'x86', 0x08: 'MIPS', 0x14: 'PowerPC', 0x15: 'PowerPC 64',
  0x16: 'S390', 0x28: 'ARM', 0x2a: 'SuperH', 0x32: 'IA-64', 0x3e: 'x86-64',
  0xb7: 'AArch64', 0xf3: 'RISC-V', 0x101: 'WDC 65C816',
};
const ELF_OSABI = { 0: 'System V', 1: 'HP-UX', 2: 'NetBSD', 3: 'Linux', 6: 'Solaris', 9: 'FreeBSD', 12: 'OpenBSD' };
const PH_TYPES = {
  0: 'NULL', 1: 'LOAD', 2: 'DYNAMIC', 3: 'INTERP', 4: 'NOTE', 5: 'SHLIB', 6: 'PHDR', 7: 'TLS',
  0x6474e550: 'GNU_EH_FRAME', 0x6474e551: 'GNU_STACK', 0x6474e552: 'GNU_RELRO', 0x6474e553: 'GNU_PROPERTY',
};

const flagsToRWX = (f) => `${f & 4 ? 'r' : '-'}${f & 2 ? 'w' : '-'}${f & 1 ? 'x' : '-'}`;

/**
 * ⭐ THE PROGRAM HEADER TABLE IS THE POINT. `deep100/extract-elf` spent five
 * rounds reconstructing exactly this list from an `od` dump in prose, and got
 * the `vaddr` of one segment wrong on the way ("Wait, let me re-read").
 *
 * ⚠️ 64-bit offsets are read as BigInt and returned as Number, because a JSON
 * tool result cannot carry a BigInt and every real vaddr here is far inside
 * 2^53. Anything that genuinely exceeds it is reported as a hex string rather
 * than silently rounded — a wrong address that looks right is the failure this
 * verb exists to end.
 */
function num64(buf, off, le) {
  const v = le ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off);
  return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : `0x${v.toString(16)}`;
}

function decodeElf(head) {
  if (head.length < 20) return null;
  const cls = head[4];          // 1 = 32-bit, 2 = 64-bit
  const data = head[5];         // 1 = LSB, 2 = MSB
  const is64 = cls === 2;
  const le = data !== 2;
  const u16 = (o) => (le ? head.readUInt16LE(o) : head.readUInt16BE(o));
  const u32 = (o) => (le ? head.readUInt32LE(o) : head.readUInt32BE(o));
  const word = (o) => (is64 ? num64(head, o, le) : u32(o));

  const eType = u16(16);
  const eMachine = u16(18);
  const out = {
    format: 'ELF',
    class: is64 ? '64-bit' : '32-bit',
    endian: le ? 'LSB (little-endian)' : 'MSB (big-endian)',
    osabi: ELF_OSABI[head[7]] ?? `unknown (${head[7]})`,
    type: ELF_TYPES[eType] ?? `unknown (${eType})`,
    machine: ELF_MACHINES[eMachine] ?? `unknown (0x${eMachine.toString(16)})`,
  };

  const phOff = is64 ? 32 : 28;
  const need = is64 ? 64 : 52;
  if (head.length < need) return out;

  out.entry = word(24);
  const phoff = word(phOff);
  const phentsize = u16(is64 ? 54 : 42);
  const phnum = u16(is64 ? 56 : 44);
  out.sectionCount = u16(is64 ? 60 : 48);

  /**
   * ⚠️ THE TABLE IS ONLY DECODED IF IT IS INSIDE THE BYTES WE READ. A truncated
   * or hostile header can name a phoff past the end of the file; reporting
   * whatever happens to be at that address in our buffer would be inventing
   * segments. Absent is honest, wrong is not.
   */
  if (typeof phoff !== 'number' || phnum === 0 || phentsize === 0) return out;
  const last = phoff + phnum * phentsize;
  if (last > head.length) {
    out.programHeaders = `${phnum} program headers at file offset ${phoff}, past the first ${head.length} bytes — not decoded`;
    return out;
  }

  const segs = [];
  for (let i = 0; i < Math.min(phnum, MAX_PROGRAM_HEADERS); i++) {
    const p = phoff + i * phentsize;
    const pType = u32(p);
    segs.push(is64
      ? {
        type: PH_TYPES[pType] ?? `0x${pType.toString(16)}`,
        flags: flagsToRWX(u32(p + 4)),
        offset: num64(head, p + 8, le),
        vaddr: num64(head, p + 16, le),
        filesz: num64(head, p + 32, le),
        memsz: num64(head, p + 40, le),
      }
      : {
        type: PH_TYPES[pType] ?? `0x${pType.toString(16)}`,
        flags: flagsToRWX(u32(p + 24)),
        offset: u32(p + 4),
        vaddr: u32(p + 8),
        filesz: u32(p + 16),
        memsz: u32(p + 20),
      });
  }
  out.programHeaders = segs;
  if (phnum > MAX_PROGRAM_HEADERS) out.programHeadersNotShown = phnum - MAX_PROGRAM_HEADERS;
  return out;
}

const PE_MACHINES = { 0x014c: 'x86', 0x8664: 'x86-64', 0x01c0: 'ARM', 0xaa64: 'AArch64', 0x0200: 'IA-64' };
const PE_SUBSYSTEMS = { 1: 'native', 2: 'Windows GUI', 3: 'Windows console', 9: 'Windows CE GUI', 10: 'EFI application' };

function decodePe(head) {
  if (head.length < 0x40) return null;
  const lfanew = head.readUInt32LE(0x3c);
  if (lfanew + 24 > head.length) return { format: 'PE', note: 'the PE header is past the first bytes read' };
  if (head.readUInt32LE(lfanew) !== 0x00004550) return null; // "PE\0\0"
  const machine = head.readUInt16LE(lfanew + 4);
  const characteristics = head.readUInt16LE(lfanew + 22);
  const out = {
    format: 'PE',
    machine: PE_MACHINES[machine] ?? `unknown (0x${machine.toString(16)})`,
    sections: head.readUInt16LE(lfanew + 6),
    type: characteristics & 0x2000 ? 'DLL' : 'executable',
  };
  const optOff = lfanew + 24;
  const optMagic = optOff + 2 <= head.length ? head.readUInt16LE(optOff) : 0;
  if (optMagic === 0x10b || optMagic === 0x20b) {
    out.class = optMagic === 0x20b ? '64-bit (PE32+)' : '32-bit (PE32)';
    const subOff = optOff + (optMagic === 0x20b ? 68 : 68);
    if (subOff + 2 <= head.length) {
      const sub = head.readUInt16LE(subOff);
      out.subsystem = PE_SUBSYSTEMS[sub] ?? `unknown (${sub})`;
    }
  }
  return out;
}

const MACHO_MAGICS = {
  0xfeedface: { class: '32-bit', endian: 'little-endian' },
  0xfeedfacf: { class: '64-bit', endian: 'little-endian' },
  0xcefaedfe: { class: '32-bit', endian: 'big-endian' },
  0xcffaedfe: { class: '64-bit', endian: 'big-endian' },
};
const MACHO_CPUS = { 7: 'x86', 0x01000007: 'x86-64', 12: 'ARM', 0x0100000c: 'AArch64' };

function decodeMachO(head) {
  if (head.length < 16) return null;
  const magic = head.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    return { format: 'Mach-O', type: 'universal ("fat") binary', architectures: head.readUInt32BE(4) };
  }
  const shape = MACHO_MAGICS[magic];
  if (!shape) return null;
  const le = shape.endian === 'little-endian';
  const cpu = le ? head.readUInt32LE(4) : head.readUInt32BE(4);
  return { format: 'Mach-O', class: shape.class, endian: shape.endian, cpu: MACHO_CPUS[cpu] ?? `unknown (0x${cpu.toString(16)})` };
}

const SQLITE_ENCODINGS = { 1: 'UTF-8', 2: 'UTF-16le', 3: 'UTF-16be' };

/** ⭐ Two of the eighteen forensics runs were `db-wal-recovery`, hexdumping a
 *  SQLite file to find its page size. It is a 100-byte big-endian header. */
function decodeSqlite(head) {
  if (head.length < 100 || head.subarray(0, 15).toString('latin1') !== 'SQLite format 3') return null;
  const rawPageSize = head.readUInt16BE(16);
  return {
    format: 'SQLite 3 database',
    pageSize: rawPageSize === 1 ? 65536 : rawPageSize,
    pages: head.readUInt32BE(28),
    encoding: SQLITE_ENCODINGS[head.readUInt32BE(56)] ?? 'unset',
    writeMode: head[18] === 2 ? 'WAL' : 'rollback journal',
    schemaVersion: head.readUInt32BE(40),
  };
}

/**
 * ── ⚠️⚠️ THE VENDORED TABLE REGISTERS SEVEN ONE-BYTE SIGNATURES ─────────────
 *
 * Found by reading the table rather than by trusting it, and it is the single
 * defect in what we wrapped. Grepped out of `lib/vendor/magic-bytes.mjs`:
 *
 *     ["0x00"]  → pic · pif · sea · ytr · mpeg
 *     ["0x7b"]  → Json      ("{")
 *     ["0x5b"]  → Json      ("[")
 *
 * So EVERY file whose first byte is NUL — which is most object files, most
 * cursors, most of everything this verb is pointed at — comes back claiming to
 * be five things, none of them true. `file(1)` says `data`.
 *
 * ⭐ THEY ARE NOT DELETED FROM THE TABLE. Editing a vendored signature list is
 * how a cut stops matching the fixture that proves it faithful, and upstream is
 * not wrong for a browser doing upload validation — one byte is a real, if weak,
 * signal there. They are moved OUT of `types` and into `weakMatches`, so the
 * information survives and the model is not told that an arbitrary binary is a
 * Macintosh PICT file.
 *
 * ⚠️ AND `mpeg` IS ON THIS LIST DESPITE BEING A REAL FORMAT. The question is not
 * whether the format is real, it is whether ONE BYTE identified it.
 */
export const ONE_BYTE_SIGNATURE_TYPES = Object.freeze(new Set(['pic', 'pif', 'sea', 'ytr', 'mpeg', 'Json']));

/**
 * @param {Buffer} head the first `HEAD_BYTES` of the file
 * @returns {object|null} the structural decode, or null for a format with none
 */
export function structureOf(head) {
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return decodeElf(head);
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return decodePe(head);
  const sqlite = decodeSqlite(head);
  if (sqlite) return sqlite;
  return decodeMachO(head);
}

// ── hex and strings ────────────────────────────────────────────────────────

/**
 * `xxd`'s layout, because it is the one the model already writes by hand:
 * `00000000: 7f45 4c46 0201 0100 …  .ELF....`
 */
export function hexdump(buf, startOffset = 0) {
  const lines = [];
  for (let i = 0; i < buf.length; i += 16) {
    const row = buf.subarray(i, i + 16);
    const groups = [];
    for (let j = 0; j < 16; j += 2) {
      groups.push(j < row.length ? row.subarray(j, j + 2).toString('hex').padEnd(4, ' ') : '    ');
    }
    let ascii = '';
    for (const b of row) ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
    lines.push(`${(startOffset + i).toString(16).padStart(8, '0')}: ${groups.join(' ')}  ${ascii}`);
  }
  return lines;
}

/**
 * `strings(1)`: runs of printable ASCII at least `min` long.
 *
 * ⚠️ THE OFFSET IS RETURNED WITH EVERY HIT and `strings(1)` needs `-t` for that.
 * The whole reason the transcripts reach for `strings` is to then look at what is
 * AROUND a hit, and a string with no address cannot be followed up.
 */
export function findStrings(buf, { min = DEFAULT_MIN_STRING, limit = MAX_STRING_RESULTS, startOffset = 0 } = {}) {
  const out = [];
  let start = -1;
  const flush = (end) => {
    if (start >= 0 && end - start >= min) {
      out.push({ offset: startOffset + start, text: buf.subarray(start, end).toString('latin1') });
    }
    start = -1;
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const printable = (b >= 0x20 && b < 0x7f) || b === 0x09;
    if (printable) { if (start < 0) start = i; } else { flush(i); if (out.length >= limit) return out; }
  }
  flush(buf.length);
  return out.slice(0, limit);
}

// ── the verb ───────────────────────────────────────────────────────────────

function readHead(absolute, size, want) {
  const n = Math.min(want, size);
  const buf = Buffer.alloc(n);
  const fd = openSync(absolute, 'r');
  try {
    let got = 0;
    while (got < n) {
      const r = readSync(fd, buf, got, n - got, got);
      if (r <= 0) break;
      got += r;
    }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

function readRange(absolute, offset, length) {
  const buf = Buffer.alloc(length);
  const fd = openSync(absolute, 'r');
  try {
    let got = 0;
    while (got < length) {
      const r = readSync(fd, buf, got, length - got, offset + got);
      if (r <= 0) break;
      got += r;
    }
    return buf.subarray(0, got);
  } finally { closeSync(fd); }
}

/**
 * @param {string} root the workspace root
 * @param {{ path?: unknown, mode?: unknown, offset?: unknown, length?: unknown, min_length?: unknown }} args
 */
export function inspectBinary(root, args = {}) {
  const rawPath = typeof args?.path === 'string' ? args.path.trim() : '';
  if (!rawPath) return { ok: false, error: 'name a path — inspect_binary takes one workspace-relative file, e.g. {"path":"a.out"}' };

  const r = resolveInWorkspace(root, rawPath, 'read');
  if (!r.ok) return { ok: false, error: r.reason };

  /**
   * ⚠️ THE SAME REFUSAL `profile_table` CARRIES, and for a sharper reason here:
   * `strings` on a `.env` is a credential dump wearing the costume of forensics.
   */
  if (refusedCommitPath(basename(r.relative)) !== null) {
    return { ok: false, error: `this tool does not return credential files, and "${basename(r.relative)}" is one — inspect the program that reads the variable instead.` };
  }

  let stat;
  try { stat = statSync(r.absolute); } catch {
    return { ok: false, error: `no such file: ${r.relative} — use find_files to locate it before inspecting it.` };
  }
  if (stat.isDirectory()) return { ok: false, error: `${r.relative} is a directory — use list_dir.` };
  if (stat.size === 0) return { ok: false, error: `${r.relative} is empty — there is nothing to inspect.` };

  const mode = typeof args?.mode === 'string' ? args.mode.trim().toLowerCase() : 'identify';
  if (!['identify', 'hex', 'strings'].includes(mode)) {
    return { ok: false, error: `mode must be "identify", "hex" or "strings" (got ${JSON.stringify(args?.mode)}).` };
  }

  if (mode === 'hex') {
    let offset = Number.isInteger(args?.offset) ? args.offset : 0;
    if (offset < 0) offset = 0;
    if (offset >= stat.size) {
      return { ok: false, error: `offset ${offset} is at or past the end of ${r.relative}, which is ${stat.size} bytes.` };
    }
    let length = Number.isInteger(args?.length) ? args.length : DEFAULT_HEX_BYTES;
    if (length <= 0) length = DEFAULT_HEX_BYTES;
    if (length > MAX_HEX_BYTES) length = MAX_HEX_BYTES;
    length = Math.min(length, stat.size - offset);
    const buf = readRange(r.absolute, offset, length);
    return {
      ok: true, path: r.relative, bytes: stat.size, mode: 'hex', offset, length: buf.length, dump: hexdump(buf, offset),
      ...(offset + buf.length < stat.size ? { more: `${stat.size - offset - buf.length} bytes follow; call again with offset ${offset + buf.length}.` } : {}),
    };
  }

  if (mode === 'strings') {
    let min = Number.isInteger(args?.min_length) ? args.min_length : DEFAULT_MIN_STRING;
    if (min < 2) min = 2;
    const scan = Math.min(stat.size, MAX_STRING_SCAN);
    const buf = readRange(r.absolute, 0, scan);
    const found = findStrings(buf, { min });
    return {
      ok: true, path: r.relative, bytes: stat.size, mode: 'strings', minLength: min, count: found.length, strings: found,
      ...(found.length >= MAX_STRING_RESULTS ? { truncated: `only the first ${MAX_STRING_RESULTS} are returned; raise min_length to narrow.` } : {}),
      ...(scan < stat.size ? { scannedBytes: scan, sampled: true } : {}),
    };
  }

  const head = readHead(r.absolute, stat.size, HEAD_BYTES);
  const all = filetypeinfo(head);
  const guesses = all.filter((g) => !ONE_BYTE_SIGNATURE_TYPES.has(g.typename));
  const weak = all.filter((g) => ONE_BYTE_SIGNATURE_TYPES.has(g.typename)).map((g) => g.typename);
  const structure = structureOf(head);
  const nul = head.includes(0);

  return {
    ok: true,
    path: r.relative,
    bytes: stat.size,
    mode: 'identify',
    /**
     * ⚠️ EVERY MATCH, NOT THE FIRST. A `.jar` is a ZIP and an `.apk` is a JAR;
     * showing one name and hiding the others is how a caller concludes the wrong
     * thing about a container format.
     */
    types: guesses.map((g) => ({ name: g.typename, ...(g.mime ? { mime: g.mime } : {}), ...(g.extension ? { extension: g.extension } : {}) })),
    /**
     * ⚠️ REPORTED, NEVER SILENT — the rule `profile_table` states about a sampled
     * row count. Dropping these entirely would be a second kind of lie.
     */
    ...(weak.length > 0
      ? { weakMatches: weak, weakMatchNote: 'matched on a ONE-BYTE signature, which is not identification — treat as noise unless something else agrees.' }
      : {}),
    ...(structure ? { structure } : {}),
    /**
     * ⭐ A NEGATIVE IS AN ANSWER. `file` on an unrecognised file says "data", and
     * a model told only `types: []` will call the tool again with another mode
     * to find out whether that meant "failed" or "no signature".
     */
    ...(guesses.length === 0 && !structure
      ? { note: nul ? 'no signature matched, and it contains NUL bytes — unrecognised binary data. Try mode "strings" to see what is embedded in it.' : 'no signature matched and there are no NUL bytes in the head — this is probably plain text. read_file or read_lines will read it.' }
      : {}),
    head: hexdump(head.subarray(0, 64), 0),
  };
}

/**
 * ⚠️ THE DESCRIPTION IS THE FEATURE, and this one has two jobs. The model does
 * not know this verb exists — it reaches for `file`, `xxd`, `od` and `strings`,
 * so those four words are IN the description and are the reason it will be
 * found. And it names the state the model will be in when it needs this: a
 * `read_file` that was refused as binary, or a shell command that exited 127.
 */
export function binaryInspectToolSchemas() {
  return [
    {
      type: 'function',
      function: {
        name: 'inspect_binary',
        description: [
          'Identify and read a BINARY file — what `file`, `xxd`, `od` and `strings` do, in-process,',
          'so it works when those are not installed and on the surface with no shell at all.',
          'mode "identify" (default) gives the file type plus the decoded header of an ELF/PE/Mach-O/SQLite',
          'file, including the ELF program header table; "hex" dumps any byte range; "strings" lists',
          'printable text with its offset. Use it whenever read_file refused a file as binary.',
        ].join(' '),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Workspace-relative path, e.g. "a.out".' },
            mode: { type: 'string', enum: ['identify', 'hex', 'strings'], description: 'Defaults to "identify".' },
            offset: { type: 'number', description: 'hex mode only. Byte to start at. Defaults to 0.' },
            length: { type: 'number', description: `hex mode only. Bytes to dump, up to ${MAX_HEX_BYTES}. Defaults to ${DEFAULT_HEX_BYTES}.` },
            min_length: { type: 'number', description: `strings mode only. Shortest run to report. Defaults to ${DEFAULT_MIN_STRING}.` },
          },
          required: ['path'],
        },
      },
    },
  ];
}
