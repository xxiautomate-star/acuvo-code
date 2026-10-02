/**
 * A REAL MCP server, in 40 lines, with zero dependencies.
 *
 * ⭐ WHY A REAL ONE RATHER THAN A MOCK. The defect it exists to catch lived in
 * the seam between the loaded config and `spawn` — a mocked `spawnImpl` would
 * have been handed the same broken env and cheerfully agreed with it. The only
 * witness that cannot be fooled is a process that reports what it ACTUALLY
 * received in `process.env`.
 *
 * Speaks newline-delimited JSON-RPC over stdio, which is what `stdioTransport`
 * frames. Exposes one tool, `read_env`, returning the value of the variable it
 * is asked about. It touches no network and reads no file.
 */

import { createInterface } from 'node:readline';

const TOOLS = [{
  name: 'read_env',
  description: 'Return the value of an environment variable as this process actually received it.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string', description: 'the variable to read' } },
    required: ['name'],
  },
}];

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let req;
  try { req = JSON.parse(text); } catch { return; }
  // A notification (no id) is acknowledged by saying nothing, per JSON-RPC.
  if (req.id === undefined || req.id === null) return;

  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo-env', version: '1.0.0' },
      },
    });
    return;
  }

  if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
    return;
  }

  if (req.method === 'tools/call' && req.params?.name === 'read_env') {
    const name = String(req.params?.arguments?.name ?? '');
    const value = process.env[name];
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [{ type: 'text', text: value === undefined ? '<undefined>' : String(value) }],
        isError: false,
      },
    });
    return;
  }

  send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `no such method: ${req.method}` } });
});
