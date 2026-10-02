/**
 * ── ⭐⭐ `inspect_binary` — WHAT `file`, `xxd`, `od` AND `strings` DID ───────
 *
 * The measurement this verb exists for, from `bench/terminal-bench/results`
 * (139 stored runs, 2026-08-29):
 *
 *     18 runs reached for binary forensics, 57 calls between them
 *     11 × `file: not found` · 7 × `xxd: not found`
 *      5 runs had `file …` as their DECLARED VERIFICATION COMMAND and it exited 127
 *
 * ⚠️ THE FIXTURE IN SECTION 2 IS THE ONE THAT MATTERS AND IT IS THE ONE THAT
 * COULD MOST EASILY PASS WHILE CHECKING NOTHING. 1,018 upstream cases of which
 * 407 legitimately produce `[]`; a broken vendored table would still satisfy
 * every one of those. So the count of NON-EMPTY expectations is asserted
 * explicitly — 611 — and a cut that detected nothing would fail on that line
 * before it reached any comparison.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TOOL_NAMES, toolNamesForRounds, toolSchemasFor, executeToolCall } from '../lib/tools.mjs';
import { shortlistTools, TOOL_GROUPS } from '../lib/tool-shortlist.mjs';
import { createLocalExecutor } from '../lib/workspace.mjs';
import { filetypeinfo, filetypename, filetypemime, filetypeextension } from '../lib/vendor/magic-bytes.mjs';
import {
  inspectBinary, binaryEvidence, resetBinaryEvidenceCache, binaryInspectToolNames,
  binaryInspectToolSchemas, structureOf, hexdump, findStrings,
  BINARY_EXTENSIONS, MAX_HEX_BYTES, MAX_STRING_RESULTS,
} from '../lib/binary-inspect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const NO_ACCOUNT_HOME = '/acuvo-test-no-such-home';

function tmp(prefix) { return mkdtempSync(join(tmpdir(), prefix)); }
const clean = (...roots) => { for (const r of roots) rmSync(r, { recursive: true, force: true }); };

/**
 * ⭐ A REAL ELF64, BUILT FROM THE NUMBERS IN THE TRANSCRIPT rather than from
 * plausible ones. `deep100/extract-elf` spent rounds 4-8 hand-reading these four
 * values out of an `od` dump, in prose, and misread one on the way ("Wait, let
 * me re-read"): segment at file offset 0x1000, vaddr 0x400000, filesz 0x175;
 * and a second at 0x2000 / 0x402000 / 0xf4. If this decoder is right, that whole
 * detour is one tool call.
 */
function elf64({ phnum = 2, phoff = 64, entry = 0x401040, type = 2, machine = 0x3e } = {}) {
  const PH = 56;
  const body = Buffer.alloc(PH * phnum);
  const seg = (i, t, flags, off, vaddr, filesz, memsz) => {
    const b = body.subarray(i * PH);
    b.writeUInt32LE(t, 0); b.writeUInt32LE(flags, 4);
    b.writeBigUInt64LE(BigInt(off), 8); b.writeBigUInt64LE(BigInt(vaddr), 16);
    b.writeBigUInt64LE(BigInt(filesz), 32); b.writeBigUInt64LE(BigInt(memsz), 40);
  };
  if (phnum >= 1) seg(0, 1, 5, 0x1000, 0x400000, 0x175, 0x175);
  if (phnum >= 2) seg(1, 1, 6, 0x2000, 0x402000, 0xf4, 0xf4);
  for (let i = 2; i < phnum; i++) seg(i, 1, 4, 0x3000 + i, 0x403000 + i, 8, 8);

  const head = Buffer.alloc(64);
  head.write('\x7fELF', 0, 'latin1');
  head[4] = 2; head[5] = 1; head[6] = 1; head[7] = 0;
  head.writeUInt16LE(type, 16);
  head.writeUInt16LE(machine, 18);
  head.writeUInt32LE(1, 20);
  head.writeBigUInt64LE(BigInt(entry), 24);
  head.writeBigUInt64LE(BigInt(phoff), 32);
  head.writeUInt16LE(64, 52);
  head.writeUInt16LE(PH, 54);
  head.writeUInt16LE(phnum, 56);
  head.writeUInt16LE(29, 60);
  return Buffer.concat([head, body]);
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1. THE VERB IS DECLARED, OFFERED ON EVIDENCE, AND REACHABLE THROUGH THE
 *    DISPATCHER. "Only the end-to-end run proves reach."
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ inspect_binary is declared, offered on a repo with a binary, and dispatches', async () => {
  assert.ok(TOOL_NAMES.includes('inspect_binary'), 'the verb is not declared at all');
  const root = tmp('bi-reach-');
  try {
    writeFileSync(join(root, 'index.js'), 'console.log(1);');
    writeFileSync(join(root, 'a.out'), elf64());
    resetBinaryEvidenceCache();

    const names = toolNamesForRounds(16, { root, env: {}, allowRun: true, home: NO_ACCOUNT_HOME });
    assert.ok(names.includes('inspect_binary'), 'a repository with a compiled artifact is not offered the verb');

    /**
     * ⚠️ NOT GATED ON `allowRun`. The shell-less surface is the one with no
     * `xxd`, `od` or `file` to fall back to — withholding it there removes the
     * capability from precisely the place it is the only one.
     */
    const noRun = toolNamesForRounds(16, { root, allowRun: false, env: {}, home: NO_ACCOUNT_HOME });
    assert.ok(noRun.includes('inspect_binary'), 'inspect_binary must survive --no-run: it reads, it does not execute');

    const out = await executeToolCall(
      { id: 'c1', function: { name: 'inspect_binary', arguments: JSON.stringify({ path: 'a.out' }) } },
      createLocalExecutor(root),
    );
    assert.equal(out.result.ok, true, `dispatcher did not reach the verb: ${JSON.stringify(out.result)}`);
    assert.equal(out.result.structure.machine, 'x86-64');
    assert.equal(out.mutated, false, 'a read verb must never report a mutation');
  } finally { clean(root); }
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. THE VENDORED CUT IS FAITHFUL TO THE PUBLISHED PACKAGE
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐⭐ the vendored magic-bytes cut matches upstream 1.13.1 on every captured case', () => {
  const cases = JSON.parse(readFileSync(join(HERE, 'fixtures', 'magic-bytes-1.13.1-upstream-cases.json'), 'utf8'));

  /**
   * ⚠️⚠️ THE GUARD THAT STOPS THIS PASSING WHILE CHECKING NOTHING. A cut that
   * detected NO type would agree with every one of the 407 empty expectations
   * and the loop below would be green. These two lines are the reason it cannot.
   */
  assert.equal(cases.length, 1018, 'the fixture changed size — recapture it from the published tarball, do not edit it');
  const nonEmpty = cases.filter((c) => c.expect.length > 0).length;
  assert.equal(nonEmpty, 611, 'the fixture no longer contains 611 POSITIVE cases; a table that detects nothing would pass without them');

  /**
   * ⚠️ COMPARED THROUGH JSON, because the fixture WAS CAPTURED through JSON.
   * Upstream returns `{typename, mime: undefined, extension: undefined}` for the
   * handful of signatures registered with no `additionalInfo`, and
   * `JSON.stringify` drops an undefined value. A raw `deepEqual` against the
   * parsed fixture therefore fails on a difference that does not exist — my first
   * run failed on exactly that and the "mismatch" was `mime: undefined`.
   */
  let compared = 0;
  for (const c of cases) {
    const buf = Buffer.from(c.hex, 'hex');
    const ours = JSON.parse(JSON.stringify(filetypeinfo(buf)));
    assert.deepEqual(ours, c.expect, `our cut disagrees with upstream on ${c.hex.slice(0, 24) || '(empty)'}`);
    compared += 1;
  }
  assert.equal(compared, cases.length);
});

test('⚠️ …and the three derived views are the ones upstream defines, not re-implementations', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(filetypename(png), filetypeinfo(png).map((e) => e.typename));
  assert.deepEqual(filetypemime(png), filetypeinfo(png).map((e) => e.mime).filter((x) => x));
  assert.deepEqual(filetypeextension(png), filetypeinfo(png).map((e) => e.extension).filter((x) => x));
  assert.ok(filetypename(png).includes('png'), 'the vendored table does not recognise a PNG, so it recognises nothing');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. THE STRUCTURAL HALF — the part `file` does and a signature table does not
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐⭐ the ELF program header table is decoded — the five rounds extract-elf spent by hand', () => {
  const s = structureOf(elf64());
  assert.equal(s.format, 'ELF');
  assert.equal(s.class, '64-bit');
  assert.equal(s.endian, 'LSB (little-endian)');
  assert.equal(s.type, 'executable');
  assert.equal(s.machine, 'x86-64');
  assert.equal(s.entry, 0x401040);
  assert.equal(s.sectionCount, 29);
  /**
   * ⭐ THE LITERAL NUMBERS FROM THE TRANSCRIPT. 0x400000 is 4194304 — the first
   * key in that task's own example output — and 0x175 is the 373 the model
   * derived on round 7 after getting it wrong on round 4.
   */
  assert.deepEqual(s.programHeaders, [
    { type: 'LOAD', flags: 'r-x', offset: 0x1000, vaddr: 4194304, filesz: 373, memsz: 373 },
    { type: 'LOAD', flags: 'rw-', offset: 0x2000, vaddr: 4202496, filesz: 244, memsz: 244 },
  ]);
});

test('⚠️ a program header table outside the bytes we read is REPORTED, never invented', () => {
  /**
   * ⚠️ THE FAILURE THIS PREVENTS IS THE WORST ONE THIS VERB COULD SHIP: a
   * truncated or hostile header names a phoff past the end, and a decoder that
   * reads whatever happens to sit at that address in its own buffer returns
   * segments that do not exist. A wrong address that looks right is worse than
   * no address.
   */
  const s = structureOf(elf64({ phoff: 900_000 }));
  assert.equal(typeof s.programHeaders, 'string');
  assert.match(s.programHeaders, /not decoded/);
  assert.equal(s.machine, 'x86-64', 'the rest of the header must still decode');
});

test('⚠️ a big-endian and a 32-bit ELF are not read with little-endian 64-bit offsets', () => {
  const be = elf64();
  be[5] = 2;                       // EI_DATA = MSB
  const s = structureOf(be);
  assert.equal(s.endian, 'MSB (big-endian)');
  /**
   * ⚠️ THE POINT OF THE ASSERTION: read big-endian, e_machine 0x3e becomes
   * 0x3e00. A decoder that ignored EI_DATA would still say "x86-64" here, so
   * asserting the endian string alone would pass while checking nothing.
   */
  assert.match(s.machine, /^unknown/, 'e_machine was read little-endian on a big-endian file');

  const e32 = Buffer.alloc(52 + 32 * 2);
  e32.write('\x7fELF', 0, 'latin1');
  e32[4] = 1; e32[5] = 1; e32[6] = 1;
  e32.writeUInt16LE(2, 16); e32.writeUInt16LE(0x03, 18);
  e32.writeUInt32LE(0x8048000, 24); e32.writeUInt32LE(52, 28);
  e32.writeUInt16LE(32, 42); e32.writeUInt16LE(1, 44); e32.writeUInt16LE(20, 48);
  e32.writeUInt32LE(1, 52); e32.writeUInt32LE(0x1000, 56); e32.writeUInt32LE(0x8048000, 60);
  e32.writeUInt32LE(0x200, 68); e32.writeUInt32LE(0x200, 72); e32.writeUInt32LE(5, 76);
  const t = structureOf(e32);
  assert.equal(t.class, '32-bit');
  assert.equal(t.machine, 'x86');
  assert.deepEqual(t.programHeaders, [{ type: 'LOAD', flags: 'r-x', offset: 0x1000, vaddr: 0x8048000, filesz: 0x200, memsz: 0x200 }]);
});

test('⭐ PE, Mach-O and SQLite decode too — the other three containers in the archive', () => {
  const pe = Buffer.alloc(0x200);
  pe.write('MZ', 0, 'latin1');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.writeUInt32LE(0x00004550, 0x80);
  pe.writeUInt16LE(0x8664, 0x84);
  pe.writeUInt16LE(6, 0x86);
  pe.writeUInt16LE(0x2000, 0x96);
  pe.writeUInt16LE(0x20b, 0x98);
  pe.writeUInt16LE(3, 0x98 + 68);
  const p = structureOf(pe);
  assert.equal(p.format, 'PE');
  assert.equal(p.machine, 'x86-64');
  assert.equal(p.type, 'DLL');
  assert.equal(p.class, '64-bit (PE32+)');
  assert.equal(p.subsystem, 'Windows console');
  assert.equal(p.sections, 6);

  const mach = Buffer.alloc(32);
  mach.writeUInt32BE(0xfeedfacf, 0);
  mach.writeUInt32LE(0x01000007, 4);
  const m = structureOf(mach);
  assert.equal(m.format, 'Mach-O');
  assert.equal(m.class, '64-bit');
  assert.equal(m.cpu, 'x86-64');

  /** ⭐ Two of the eighteen forensics runs were `db-wal-recovery`, hexdumping a
   *  SQLite file to find the page size this reads directly. */
  const db = Buffer.alloc(100);
  Buffer.from('SQLite format 3\0').copy(db, 0);
  db.writeUInt16BE(4096, 16);
  db[18] = 2; db[19] = 2;
  db.writeUInt32BE(11, 28);
  db.writeUInt32BE(1, 56);
  const d = structureOf(db);
  assert.equal(d.format, 'SQLite 3 database');
  assert.equal(d.pageSize, 4096);
  assert.equal(d.pages, 11);
  assert.equal(d.encoding, 'UTF-8');
  assert.equal(d.writeMode, 'WAL');
});

test('⚠️ a file with no structure returns null rather than a confident wrong answer', () => {
  assert.equal(structureOf(Buffer.from('hello world, plain text\n')), null);
  assert.equal(structureOf(Buffer.alloc(0)), null);
  assert.equal(structureOf(Buffer.from([0x7f, 0x45])), null, 'two bytes of an ELF magic is not an ELF');
});

/* ════════════════════════════════════════════════════════════════════════════
 * 4. hex AND strings — the two shapes the transcripts asked a shell for
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐ the dump is xxd\'s layout, because that is the one the model already writes by hand', () => {
  const lines = hexdump(Buffer.from('\x7fELF\x02\x01\x01\x00abcdefgh', 'latin1'), 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '00000000: 7f45 4c46 0201 0100 6162 6364 6566 6768  .ELF....abcdefgh');

  /** ⚠️ A SHORT LAST LINE MUST STILL LINE UP, or an offset read off the ASCII
   *  column is wrong by however many bytes were missing. */
  const short = hexdump(Buffer.from([0xff, 0x00, 0x41]), 0x2000);
  assert.equal(short[0], '00002000: ff00 41                                  ..A');
  assert.equal(short[0].indexOf('..A'), lines[0].indexOf('.ELF'), 'the ASCII gutter moved on a short row');
});

test('⭐ strings carry their OFFSET — a hit with no address cannot be followed up', () => {
  const buf = Buffer.concat([
    Buffer.from([0, 0, 0]),
    Buffer.from('launchcode'),
    Buffer.from([0, 1]),
    Buffer.from('ab'),
    Buffer.from([0]),
    Buffer.from('GLIBC_2.2.5'),
  ]);
  const found = findStrings(buf, { min: 4 });
  assert.deepEqual(found, [
    { offset: 3, text: 'launchcode' },
    { offset: 18, text: 'GLIBC_2.2.5' },
  ]);
  assert.equal(buf.subarray(3, 13).toString(), 'launchcode', 'the reported offset does not point at the reported text');
  /** "ab" is two characters and min is four — a run shorter than min is not a string. */
  assert.ok(!found.some((f) => f.text === 'ab'));
});

test('⚠️ hex and strings are both capped, and the caps are honest about what was cut', () => {
  const root = tmp('bi-caps-');
  try {
    const big = Buffer.alloc(20000);
    for (let i = 0; i < big.length; i++) big[i] = 0x41 + (i % 26);
    writeFileSync(join(root, 'big.bin'), big);
    resetBinaryEvidenceCache();

    const hex = inspectBinary(root, { path: 'big.bin', mode: 'hex', length: 999999 });
    assert.equal(hex.length, MAX_HEX_BYTES, 'the length cap did not apply');
    assert.match(hex.more, /call again with offset 4096/);

    const at = inspectBinary(root, { path: 'big.bin', mode: 'hex', offset: 16, length: 16 });
    assert.equal(at.dump.length, 1);
    assert.ok(at.dump[0].startsWith('00000010: '), `a hex window must be labelled with the FILE offset, got ${at.dump[0]}`);

    const past = inspectBinary(root, { path: 'big.bin', mode: 'hex', offset: 999999 });
    assert.equal(past.ok, false);
    assert.match(past.error, /past the end/);

    /** One 20,000-character printable run — `strings` must not return it whole. */
    const str = inspectBinary(root, { path: 'big.bin', mode: 'strings' });
    assert.equal(str.count, 1);
    assert.ok(str.strings[0].text.length <= 20000);

    const bad = inspectBinary(root, { path: 'big.bin', mode: 'disassemble' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /mode must be/);
  } finally { clean(root); }
});

test('⚠️ a run of MAX_STRING_RESULTS hits reports that it was truncated', () => {
  const parts = [];
  for (let i = 0; i < MAX_STRING_RESULTS + 20; i++) parts.push(Buffer.from(`str${i}xxxx`), Buffer.from([0]));
  const found = findStrings(Buffer.concat(parts), { min: 4 });
  assert.equal(found.length, MAX_STRING_RESULTS);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 5. THE OFFER GATE — "offered on evidence, and only on evidence"
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the gate: a code repository pays nothing, a repository with a binary pays for the verb', () => {
  const plain = tmp('bi-plain-');
  const withBin = tmp('bi-bin-');
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    writeFileSync(join(plain, 'README.md'), '# hello');
    writeFileSync(join(withBin, 'index.js'), 'console.log(1);');
    writeFileSync(join(withBin, 'a.out'), elf64());
    resetBinaryEvidenceCache();

    assert.equal(binaryEvidence(plain), false, 'a plain JS project claims binary evidence');
    assert.equal(binaryEvidence(withBin), true, 'an a.out is not recognised');

    const HOME = NO_ACCOUNT_HOME;
    const off = toolNamesForRounds(16, { root: plain, env: {}, allowRun: true, home: HOME });
    const on = toolNamesForRounds(16, { root: withBin, env: {}, allowRun: true, home: HOME });
    assert.ok(!off.includes('inspect_binary'), 'the verb is offered where it has nothing to point at');
    assert.ok(on.includes('inspect_binary'));

    /**
     * ⭐ THE NUMBERS, MEASURED. The ceiling in `declared-tools-are-named.test.mjs`
     * is 60,000 B and the plain offer sits at 59,513 — 487 bytes of headroom for
     * a 1,071-byte schema. This is why the gate exists and it is asserted rather
     * than described.
     */
    const bytesOff = JSON.stringify(toolSchemasFor(off)).length;
    const bytesOn = JSON.stringify(toolSchemasFor(on)).length;
    const delta = bytesOn - bytesOff;
    assert.ok(delta > 900 && delta < 1300, `the verb costs ${delta} B on a binary repo; 1,070 was measured`);
    assert.ok(
      delta > 60_000 - bytesOff,
      `the schema (${delta} B) now fits inside the ${60_000 - bytesOff} B of headroom, so the gate is no longer `
      + 'load-bearing — say so deliberately rather than leaving this comment stale.',
    );
  } finally { clean(plain, withBin); }
});

test('⭐ the extension-less binary is caught by its BYTES — a.out is the lucky case', () => {
  /**
   * ⚠️ `gcc -o solver` produces a file with no extension at all, and that is what
   * these tasks actually build. An extension list can never catch it, which is
   * why the gate has a second half that opens eight bytes.
   */
  const exe = tmp('bi-noext-');
  const script = tmp('bi-script-');
  try {
    writeFileSync(join(exe, 'solver'), elf64());
    writeFileSync(join(script, 'configure'), '#!/bin/sh\nexit 0\n');
    writeFileSync(join(script, 'Makefile'), 'all:\n\techo hi\n');
    resetBinaryEvidenceCache();
    assert.equal(binaryEvidence(exe), true, 'an extension-less ELF is not recognised — the sniff half of the gate is dead');
    assert.equal(binaryEvidence(script), false, 'an extension-less shell script was called a binary');
  } finally { clean(exe, script); }
});

test('⚠️ the gate looks one level down, skips node_modules, and does not leak between roots', () => {
  const nested = tmp('bi-nested-');
  const noise = tmp('bi-noise-');
  try {
    mkdirSync(join(nested, 'build'), { recursive: true });
    writeFileSync(join(nested, 'index.js'), 'console.log(1);');
    writeFileSync(join(nested, 'build', 'app.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));

    mkdirSync(join(noise, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(noise, 'index.js'), 'console.log(1);');
    writeFileSync(join(noise, 'node_modules', 'x', 'binding.node'), Buffer.from([0, 1, 2, 3]));
    resetBinaryEvidenceCache();

    assert.equal(binaryEvidence(nested), true, 'a binary in build/ is not found');
    assert.equal(binaryEvidence(noise), false, 'node_modules is not skipped — every JS repo would be offered the verb');
    assert.equal(binaryEvidence(nested), true, 'the second lookup disturbed the first');

    /** ⚠️ `build` is on the skip list for `tableEvidence` and NOT for this one,
     *  deliberately: `build/` is exactly where a compiled artifact lives. This
     *  line is here so that changing it is a decision. */
    assert.ok(binaryEvidence(nested));
  } finally { clean(nested, noise); }
});

test('⚠️ the gate is cheap enough to run every turn — the 478ms lesson', () => {
  const root = tmp('bi-cost-');
  try {
    for (let i = 0; i < 40; i++) writeFileSync(join(root, `f${i}`), 'plain text file\n');
    writeFileSync(join(root, 'index.js'), 'console.log(1);');
    resetBinaryEvidenceCache();
    const started = process.hrtime.bigint();
    for (let i = 0; i < 200; i++) binaryEvidence(root);
    const perCallMs = Number(process.hrtime.bigint() - started) / 1e6 / 200;
    assert.ok(
      perCallMs < 1,
      `binaryEvidence costs ${perCallMs.toFixed(2)}ms per call — it runs once per turn, and the dbEvidence `
      + 'version that walked the tree cost 478ms and cancelled a whole test run.',
    );
  } finally { clean(root); }
});

test('⚠️ a single-round turn is offered nothing — a description with no round after it has nowhere to go', () => {
  const root = tmp('bi-rounds-');
  try {
    writeFileSync(join(root, 'a.out'), elf64());
    resetBinaryEvidenceCache();
    assert.deepEqual(binaryInspectToolNames(root, { maxRounds: 1 }), []);
    assert.deepEqual(binaryInspectToolNames(root, { maxRounds: 2 }), ['inspect_binary']);
  } finally { clean(root); }
});

/* ════════════════════════════════════════════════════════════════════════════
 * 6. THE SECOND GATE — "is this brief ABOUT a binary"
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the verb is CLASSIFIED, so an unsignalled brief pays 0 even on a repository full of binaries', () => {
  const root = tmp('bi-short-');
  try {
    writeFileSync(join(root, 'index.js'), 'console.log(1);');
    writeFileSync(join(root, 'a.out'), elf64());
    resetBinaryEvidenceCache();
    const available = toolNamesForRounds(16, { root, env: {}, allowRun: true, home: NO_ACCOUNT_HOME });
    assert.ok(available.includes('inspect_binary'));

    assert.ok(!shortlistTools('hi', available).includes('inspect_binary'), 'an unclassified verb rides along on "hi" for ever');
    assert.ok(!shortlistTools('fix the failing test', available).includes('inspect_binary'));

    /** ⭐ The real brief, verbatim from `deep100/extract-elf`. */
    const real = 'I have provided a file a.out that\'s a compiled C binary. Write me a program extract.js';
    assert.ok(shortlistTools(real, available).includes('inspect_binary'), 'the brief this verb was built for does not reach it');

    /** ⭐ And the other four families that hit `file: not found`. */
    for (const brief of [
      'perform a digital forensic recovery task ... recover the PASSWORD from the deleted file',
      'the WAL file appears to be corrupted or encrypted',
      'run a hexdump of the firmware image',
      'the gpt-2 weights stored as a TF .ckpt',
    ]) {
      assert.ok(shortlistTools(brief, available).includes('inspect_binary'), `no signal found in: ${brief}`);
    }
  } finally { clean(root); }
});

test('⚠️⚠️ no group word is a substring of ordinary English — the "elf" inside "yourself" trap', () => {
  const words = TOOL_GROUPS.binary.words;
  assert.ok(!words.includes('elf'), 'bare "elf" matches yourself/shelf/twelve — it must never be on this list');
  assert.ok(!words.includes('.so'), 'bare ".so" matches array.sort and .source');
  assert.ok(!words.includes('hex'), 'bare "hex" matches hexagon');
  assert.ok(!words.includes('strings'), 'bare "strings" is ordinary programming vocabulary');

  /**
   * ⭐ AND THE ASSERTION IS RUN, not merely stated. Prose that contains none of
   * the intended concepts must match none of the words — a list that fires here
   * is a list that adds 1,071 B to every ordinary brief in a repo with a binary.
   */
  const innocent = [
    'refactor this yourself and put the result on the shelf',
    'sort the array with array.sort and read .source',
    'draw a hexagon and label twelve vertices',
    'the config has a list of strings for each environment',
  ];
  for (const text of innocent) {
    const hits = words.filter((w) => text.toLowerCase().includes(w));
    assert.deepEqual(hits, [], `"${text}" matched ${JSON.stringify(hits)}`);
  }

  /** ⚠️ …and the converse, or the four lines above pass because the list is empty. */
  assert.ok(words.length > 10, 'the word list emptied out; the innocent-prose assertions above now prove nothing');
  assert.ok('this is a compiled binary'.includes('binary'));
});

test('⚠️ one tool, one group — inspect_binary is not claimed twice', () => {
  const owners = Object.entries(TOOL_GROUPS).filter(([, g]) => g.tools.includes('inspect_binary')).map(([n]) => n);
  assert.deepEqual(owners, ['binary'], `inspect_binary is in ${owners.length} groups; its offer would depend on which words matched`);
});

/* ════════════════════════════════════════════════════════════════════════════
 * 7. THE REFUSALS
 * ════════════════════════════════════════════════════════════════════════════ */

test('⚠️⚠️ strings on a .env is a credential dump wearing the costume of forensics', () => {
  const root = tmp('bi-secret-');
  try {
    writeFileSync(join(root, '.env'), 'OPENROUTER_API_KEY=sk-or-v1-not-a-real-key\n');
    writeFileSync(join(root, 'a.out'), elf64());
    resetBinaryEvidenceCache();
    const out = inspectBinary(root, { path: '.env', mode: 'strings' });
    assert.equal(out.ok, false);
    assert.match(out.error, /credential/);
    assert.ok(!JSON.stringify(out).includes('sk-or-v1'), 'the refusal leaked the value it refused');
  } finally { clean(root); }
});

test('⚠️ the ordinary refusals name the next move', () => {
  const root = tmp('bi-refuse-');
  try {
    writeFileSync(join(root, 'a.out'), elf64());
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'empty.bin'), '');
    resetBinaryEvidenceCache();

    assert.match(inspectBinary(root, {}).error, /name a path/);
    assert.match(inspectBinary(root, { path: 'nope.bin' }).error, /find_files/);
    assert.match(inspectBinary(root, { path: 'sub' }).error, /list_dir/);
    assert.match(inspectBinary(root, { path: 'empty.bin' }).error, /empty/);
    assert.equal(inspectBinary(root, { path: '../../etc/passwd' }).ok, false, 'a path escaped the workspace');
  } finally { clean(root); }
});

test('⭐ a negative is an answer — "no signature" must not read as "the call failed"', () => {
  const root = tmp('bi-neg-');
  try {
    writeFileSync(join(root, 'a.out'), elf64());
    writeFileSync(join(root, 'notes.txt'), 'just some prose, nothing binary about it at all\n');
    writeFileSync(join(root, 'weird.bin'), Buffer.from([0x00, 0x11, 0x22, 0x33, 0x00, 0xff]));
    resetBinaryEvidenceCache();

    const text = inspectBinary(root, { path: 'notes.txt' });
    assert.equal(text.ok, true);
    assert.deepEqual(text.types, []);
    assert.match(text.note, /probably plain text/);

    const weird = inspectBinary(root, { path: 'weird.bin' });
    assert.equal(weird.ok, true);
    /**
     * ⚠️⚠️ THIS ASSERTION FAILED ON THE FIRST RUN AND THE TEST WAS RIGHT. The
     * vendored table registers `pic`, `pif`, `sea`, `ytr` and `mpeg` on the
     * SINGLE byte 0x00, so every file starting with a NUL — most object files —
     * came back claiming to be five formats. `file(1)` says `data`.
     */
    assert.deepEqual(weird.types, [], 'a one-byte signature was reported as identification');
    assert.deepEqual(weird.weakMatches, ['pic', 'pif', 'sea', 'ytr'], 'the one-byte matches were dropped instead of demoted');
    assert.match(weird.weakMatchNote, /ONE-BYTE/);
    assert.match(weird.note, /unrecognised binary data/);
    assert.match(weird.note, /strings/, 'the note must name the next move');

    /** ⭐ And the demotion is not a blanket "hide everything": a REAL signature
     *  in the same result is untouched. */
    writeFileSync(join(root, 'p.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]));
    const png = inspectBinary(root, { path: 'p.png' });
    assert.ok(png.types.some((t) => t.name === 'png'), 'the demotion swallowed a genuine match');
  } finally { clean(root); }
});

test('⚠️ every match is reported, not just the first — a .jar is a ZIP', () => {
  const root = tmp('bi-multi-');
  try {
    const zip = Buffer.alloc(64);
    Buffer.from([0x50, 0x4b, 0x03, 0x04]).copy(zip, 0);
    writeFileSync(join(root, 'lib.jar'), zip);
    resetBinaryEvidenceCache();
    const out = inspectBinary(root, { path: 'lib.jar' });
    assert.equal(out.ok, true);
    assert.ok(out.types.length >= 1, 'a PK\\x03\\x04 header matched nothing at all');
    assert.ok(out.types.some((t) => /zip/i.test(t.name)), `no ZIP in ${JSON.stringify(out.types)}`);
    assert.ok(Array.isArray(out.head) && out.head[0].startsWith('00000000: 504b'), 'identify does not include the head dump that saves the second round');
  } finally { clean(root); }
});

/* ════════════════════════════════════════════════════════════════════════════
 * 8. THE SCHEMA SAYS THE WORDS THE MODEL IS ABOUT TO TYPE
 * ════════════════════════════════════════════════════════════════════════════ */

test('⭐⭐ the description names the four commands the transcripts actually reached for', () => {
  const [schema] = binaryInspectToolSchemas();
  const d = schema.function.description;
  for (const word of ['file', 'xxd', 'od', 'strings']) {
    assert.ok(d.includes(word), `the description does not contain "${word}" — that is the word the model types`);
  }
  assert.match(d, /read_file refused/, 'it must name the state the model will be in when it needs this');
  assert.deepEqual(schema.function.parameters.required, ['path']);
  assert.deepEqual(schema.function.parameters.properties.mode.enum, ['identify', 'hex', 'strings']);

  const bytes = JSON.stringify(binaryInspectToolSchemas()).length;
  assert.ok(bytes < 1400, `the schema is ${bytes} B; 1,071 was measured and it is re-sent every round of a binary task`);
});

test('⭐ the doctor says WHY it is dark — "not offered in this configuration" is the non-answer', async () => {
  const { toolOffer } = await import('../lib/doctor.mjs');
  const plain = tmp('bi-doc-');
  const withBin = tmp('bi-doc2-');
  try {
    writeFileSync(join(plain, 'index.js'), 'console.log(1);');
    writeFileSync(join(withBin, 'index.js'), 'console.log(1);');
    writeFileSync(join(withBin, 'a.out'), elf64());
    resetBinaryEvidenceCache();

    const cold = toolOffer({ root: plain, env: {}, allowRun: true, maxRounds: 8, home: NO_ACCOUNT_HOME });
    const dark = cold.withheld.find((t) => t.name === 'inspect_binary');
    assert.ok(dark, 'the doctor does not report the verb as withheld on a workspace where it is dark');
    assert.ok(!/not offered in this configuration/.test(dark.why), `the doctor gives the generic non-answer: ${dark.why}`);
    assert.match(dark.why, /no binary file was found/);
    assert.match(dark.fix, /compiled artifact/);

    const warm = toolOffer({ root: withBin, env: {}, allowRun: true, maxRounds: 8, home: NO_ACCOUNT_HOME });
    assert.ok(warm.offered.includes('inspect_binary'), 'the doctor reports the verb dark on a workspace where it is live');
    assert.ok(!warm.withheld.some((t) => t.name === 'inspect_binary'));
  } finally { clean(plain, withBin); }
});

test('⚠️ .dat is NOT on the binary extension list — profile_table owns it', () => {
  assert.ok(!BINARY_EXTENSIONS.includes('.dat'), 'two verbs whose gates fire on the same file is how a model gets offered the wrong one');
  assert.ok(BINARY_EXTENSIONS.includes('.out') && BINARY_EXTENSIONS.includes('.so') && BINARY_EXTENSIONS.includes('.sqlite'));
});
