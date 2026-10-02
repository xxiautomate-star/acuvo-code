#!/usr/bin/env node
/**
 * ── A BLENDER MCP SERVER WITHOUT BLENDER ────────────────────────────────────
 *
 * ⚠️⚠️ THIS IS NOT BLENDER, AND NOTHING THAT USES IT MAY SAY IT IS. Blender is
 * not installed on the machine this was written on (checked 2026-09-27), and a
 * test may not install a 300MB application on the owner's laptop. What this
 * serves is the REAL tool surface — `blender-mcp-tools.json` is `tools/list`
 * from `mcp-for-blender` 2.1.1, captured off the wire through our own
 * `connectServer` — so the half that is ours (config, spawn, shortlist, the
 * `use_toolset` door, the call path, what the model sees) is exercised against
 * the exact names and schemas a real session gets.
 *
 * What is simulated is Blender's side:
 *   · `execute_blender_code` does not run Python. It records the code and, if
 *     the code exports glTF (`bpy.ops.export_scene.gltf(filepath=…)`), writes a
 *     PLACEHOLDER GLB at that path — one triangle, valid glTF 2.0 — the way
 *     Blender would leave a file there.
 *   · `export_scene` does the same for its `filepath`.
 *   · every call is appended to $BLENDER_STUB_LOG (JSON lines) so a proof can
 *     show exactly what the agent sent.
 *
 * ⚠️ So a GLB produced through this stub proves the agent drove the export to
 * the right place with the right call — NOT that its geometry is a tree.
 * The recorded Python is the evidence for the modelling half.
 *
 * Zero dependencies; newline-delimited JSON-RPC over stdio, like the real one.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const BLENDER_TOOLS = JSON.parse(readFileSync(join(here, 'blender-mcp-tools.json'), 'utf8')).tools;

/** A valid one-triangle glTF 2.0 binary. Placeholder geometry, on purpose. */
export function placeholderGlb() {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const bin = Buffer.from(positions.buffer);
  const gltf = {
    asset: { version: '2.0', generator: 'acuvo blender-mcp-stub (placeholder geometry)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'placeholder' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  };
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + json.length + 8 + bin.length;
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.write('BIN\0', 4, 'ascii');
  return Buffer.concat([header, jh, json, bh, bin]);
}

function writeGlb(filepath) {
  const target = resolve(process.cwd(), filepath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, placeholderGlb());
  return target;
}

const scene = new Set();

function answer(name, args) {
  switch (name) {
    case 'get_addon_status':
      return JSON.stringify({ connected: true, blender_version: '4.2.0', addon_version: '2.1.1', telemetry_consent: false });
    case 'get_scene_info':
      return JSON.stringify({ name: 'Scene', object_count: scene.size, objects: [...scene].map((n) => ({ name: n })) });
    case 'execute_blender_code': {
      const code = String(args?.code ?? '');
      for (const m of code.matchAll(/\.name\s*=\s*["']([^"']+)["']/g)) scene.add(m[1]);
      const exp = code.match(/export_scene\.gltf\([^)]*filepath\s*=\s*r?["']([^"']+)["']/);
      if (exp) writeGlb(exp[1]);
      return 'Code executed successfully';
    }
    case 'export_scene': {
      if (!args?.filepath) return 'Error: filepath is required';
      const out = writeGlb(args.filepath);
      return `Exported scene to ${out} (${args.format ?? 'glb'})`;
    }
    case 'get_viewport_screenshot':
      return 'Error: viewport screenshots are not available in this environment';
    default:
      return `Error: ${name} needs an online asset service, which is not configured`;
  }
}

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'BlenderMCP', version: '2.1.1-stub' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: BLENDER_TOOLS } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params ?? {};
    if (process.env.BLENDER_STUB_LOG) {
      appendFileSync(process.env.BLENDER_STUB_LOG, `${JSON.stringify({ at: new Date().toISOString(), tool: name, args })}\n`);
    }
    const known = BLENDER_TOOLS.some((t) => t.name === name);
    const text = known ? answer(name, args) : `Unknown tool: ${name}`;
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }], isError: !known } });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* not a frame */ }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
