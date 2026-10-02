/**
 * ── MCP SCHEMAS GO THROUGH A SHORTLIST — and the two doors stay separate ─────
 *
 * The leak this closes, measured 2026-08-31 against all eleven catalogue
 * servers: 31 tools, 34,890 B, re-sent every round of every task including
 * "hi" — +54% on the 64,710 B default offer.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { namespacedName } from '../lib/mcp.mjs';
import {
  shortlistMcpSchemas, mcpRevealTarget, useToolsetSchema, schemaBytes, USE_TOOLSET_TOOL_NAME,
} from '../lib/mcp-shortlist.mjs';

/** ⚠️ Names are BUILT with namespacedName, never typed — same rule as
 *  test/mcp-widen-namespace.test.mjs, so a separator change fails here too. */
const tool = (server, name) => ({
  type: 'function',
  function: { name: namespacedName(server, name), description: `[${server}] does ${name}`, parameters: { type: 'object', properties: {} } },
});

const SCHEMAS = [
  tool('deepwiki', 'ask_question'),
  tool('deepwiki', 'read_wiki'),
  tool('awsdocs', 'search_documentation'),
  tool('svelte', 'get_documentation'),
  tool('tavily', 'search'),
];
const SERVERS = ['deepwiki', 'awsdocs', 'svelte', 'tavily'];

describe('🔌 the MCP shortlist', () => {
  test('⭐ an unsignalled brief gets NO server schemas', () => {
    const { schemas, withheld } = shortlistMcpSchemas('fix the padding on the pricing card', SCHEMAS);
    assert.equal(schemas.length, 0);
    assert.deepEqual(withheld, ['awsdocs', 'deepwiki', 'svelte', 'tavily']);
  });

  test('⭐ a brief naming a server gets that server ONLY', () => {
    const { schemas } = shortlistMcpSchemas('check the svelte docs for runes', SCHEMAS);
    assert.equal(schemas.length, 1);
    assert.match(schemas[0].function.name, /svelte/);
  });

  test('⭐ a brief naming a TOOL reaches its server without naming it', () => {
    // "ask_question" is deepwiki's tool; the brief never says "deepwiki".
    const { schemas } = shortlistMcpSchemas('use ask question on the repo', SCHEMAS);
    assert.ok(schemas.some((s) => /deepwiki/.test(s.function.name)));
  });

  test('⚠️ an EMPTY brief offers everything — absence of a brief is not a narrow brief', () => {
    const { schemas, withheld } = shortlistMcpSchemas('', SCHEMAS);
    assert.equal(schemas.length, SCHEMAS.length);
    assert.deepEqual(withheld, []);
  });

  test('⚠️ word BOUNDARY, not substring — "shelf" must not signal "hf"', () => {
    const hf = [tool('hf', 'model_search')];
    const { schemas } = shortlistMcpSchemas('put it on the shelf', hf);
    assert.equal(schemas.length, 0, '"shelf" must not contain-match the hf server');
  });

  test('⭐ revealed servers are sticky and absolute', () => {
    const { schemas } = shortlistMcpSchemas('fix the padding', SCHEMAS, { revealed: ['awsdocs'] });
    assert.equal(schemas.length, 1);
    assert.match(schemas[0].function.name, /awsdocs/);
  });

  test('⚠️ disabled ⇒ byte-identical to before this module existed', () => {
    const { schemas, withheld } = shortlistMcpSchemas('anything', SCHEMAS, { enabled: false });
    assert.deepEqual(schemas, SCHEMAS);
    assert.deepEqual(withheld, []);
  });

  test('⚠️ an UNPARSEABLE name is kept, never dropped — fail open', () => {
    const odd = [...SCHEMAS, { type: 'function', function: { name: 'not_namespaced', parameters: {} } }];
    const { schemas } = shortlistMcpSchemas('fix the padding', odd);
    assert.equal(schemas.length, 1);
    assert.equal(schemas[0].function.name, 'not_namespaced');
  });
});

describe('🚪 the two doors stay separate', () => {
  test('⭐ a call to a WITHHELD server reveals that server', () => {
    assert.equal(mcpRevealTarget([namespacedName('awsdocs', 'search_documentation')], SERVERS), 'awsdocs');
  });

  test('⚠️⚠️ a HALLUCINATED server reveals nothing', () => {
    /**
     * The registry-widen comment records why: widening cannot conjure a server
     * that is not connected, so answering `mcp__nope__x` with anything at all
     * buys nothing and costs bytes.
     */
    assert.equal(mcpRevealTarget([namespacedName('nope', 'x')], SERVERS), null);
  });

  test('⚠️ a plain registry verb is NOT an MCP reveal', () => {
    assert.equal(mcpRevealTarget(['read_file', 'edit_file'], SERVERS), null);
  });
});

describe('🚪 the door itself', () => {
  test('⭐ use_toolset lists exactly the withheld servers', () => {
    const s = useToolsetSchema(['deepwiki', 'awsdocs']);
    assert.equal(s.function.name, USE_TOOLSET_TOOL_NAME);
    assert.deepEqual(s.function.parameters.properties.server.enum, ['awsdocs', 'deepwiki']);
  });

  test('⚠️ nothing withheld ⇒ NO door — an empty door is pure cost', () => {
    assert.equal(useToolsetSchema([]), null);
    assert.equal(useToolsetSchema(undefined), null);
  });

  test('⭐⭐ THE SAVING IS REAL, and this is the number', () => {
    const before = schemaBytes(SCHEMAS);
    const { schemas, withheld } = shortlistMcpSchemas('fix the padding on the pricing card', SCHEMAS);
    const after = schemaBytes(schemas) + schemaBytes([useToolsetSchema(withheld)]);
    assert.ok(after < before / 2, `door (${after} B) must cost far less than the schemas (${before} B)`);
  });
});
