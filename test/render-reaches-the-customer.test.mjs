/**
 * ── 🚪⭐⭐⭐ `--design` WORKED, AND ONLY FOR US ──────────────────────────────
 *
 * MEASURED 2026-08-26. `acuvo --design page.html` is genuinely good: run against
 * a deliberately weak page it reported *"unreadable text (contrast 1.14:1,
 * needs 4.5): Buy"* and *"1.91:1"* for the body copy — both real, both measured,
 * and it refuses to describe a page it could not see.
 *
 * ⚠️ IT ONLY RAN BECAUSE `RENDER_AUDIT_URL` AND `MODAL_VIDEO_SECRET` WERE
 * EXPORTED FROM OUR OWN ENV FIRST. Those are our internal Modal credentials. A
 * customer who has paid for a plan cannot obtain them, so `--design` printed
 * "no render service is configured" and stopped — for everyone but us.
 *
 * ⭐ The capability was never missing; the door was. The gateway had exactly
 * three route groups — chat, device, engines — which is precisely the bug
 * `creative-engines.mjs` already records about `/engines`, repeating.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderVia } from '../lib/media.mjs';
import { renderEndpoint, enginesEndpoint } from '../lib/creative-engines.mjs';

/**
 * ── ⚠️⚠️ AN ISOLATED HOME, AND THE REASON IS A LEAK I CAUSED ────────────────
 *
 * The first version of these tests passed only an `env` and let `readAccount`
 * fall through to `~/.acuvo/credentials.json`. It read the REAL account, the
 * assertion failed, and node printed the live `xxi_live_…` token into the test
 * output. A test that can read the developer's credential can print it, and
 * test output goes into CI logs and pasted terminal dumps.
 *
 * ⭐ So every case here gets its own throwaway HOME. It also makes the tests
 * mean what they say: "a signed-in account" is now a fact this test creates,
 * not one it inherits from whoever happens to be logged in.
 */
function homeWith(credentials) {
  const home = mkdtempSync(join(tmpdir(), 'acuvo-render-test-'));
  if (credentials) {
    mkdirSync(join(home, '.acuvo'), { recursive: true });
    writeFileSync(join(home, '.acuvo', 'credentials.json'), JSON.stringify(credentials));
  }
  return home;
}

test('⭐ a local RENDER_AUDIT_URL still wins, and never touches the gateway', () => {
  const via = renderVia({ render: 'https://our-own.modal.run/measure', secret: 's' }, {}, homeWith(null));
  assert.equal(via.direct, true);
  assert.equal(via.url, 'https://our-own.modal.run/measure');
  // ⚠️ No token is resolved on this path — it must not read the account at all.
  assert.equal(via.token, undefined);
});

test('⭐⭐⭐ with no local renderer, a signed-in account routes to the gateway', () => {
  const home = homeWith({ token: 'xxi_live_test', gatewayUrl: 'https://acuvo.xxiautomate.com/api/cli/v1/chat/completions' });
  const via = renderVia({ render: null }, {}, home);
  assert.ok(via, 'a signed-in customer must have a way to render');
  assert.equal(via.direct, false);
  assert.match(via.url, /\/api\/cli\/v1\/render$/);
  assert.equal(via.token, 'xxi_live_test');
});

test('⚠️ with neither, it returns null rather than attempting an unauthenticated call', () => {
  /**
   * The caller turns this into a sentence naming BOTH ways in. Attempting the
   * request instead would produce a 401 the user cannot act on.
   */
  const via = renderVia({ render: null }, {}, homeWith(null));
  assert.equal(via, null);
});

test('⭐ the render endpoint is derived the same way the engines one is', () => {
  const gw = 'https://acuvo.xxiautomate.com/api/cli/v1/chat/completions';
  assert.equal(renderEndpoint(gw), 'https://acuvo.xxiautomate.com/api/cli/v1/render');
  // ⚠️ Same base, same shape — two doors that must never disagree about where
  // the gateway is. Pinned together so a change to one is visible against the other.
  assert.equal(enginesEndpoint(gw), 'https://acuvo.xxiautomate.com/api/cli/v1/engines');
});

test('⚠️ a gateway URL that is not the chat route still yields /render', () => {
  assert.equal(renderEndpoint('https://gw.example.com/api/cli/v1/'), 'https://gw.example.com/api/cli/v1/render');
  assert.equal(renderEndpoint(''), null);
  assert.equal(renderEndpoint(null), null);
});
