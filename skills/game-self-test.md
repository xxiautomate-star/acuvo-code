---
name: game-self-test
description: Proving a game is PLAYABLE before saying so — an asset manifest that fails loudly, a seeded input fuzz, an FPS probe and a stuck-state detector
when: Any game, before you report it working — especially after playtest said "checked" but nobody actually played it
triggers: game, playable, playtest, fps, frame rate, stutter, lag, input fuzz, fuzz, self test, asset manifest, sprites not loading, game crashes, game freezes, softlock, phaser, physics, platformer, shooter, arcade
version: 2
applies-to: both
---

# Game self-test

Measured: three games built in one session, ONE playable — and both broken ones
had shipped "checked". The check loaded the page and saw a canvas. A canvas is
not a game. This skill is what "checked" has to mean. Engine, loop and feel live
in `game-prototype`, `game-engines`, `game-feel`; art in `game-assets`.

## 1. An asset manifest — every file named once, verified before play

A missing sprite in Phaser is a green box, and in a raw canvas it is nothing at
all. Name every asset in one object, load from it, and refuse to start with a
visible list of what failed.

```js
const ASSETS = {
  images: { player: 'assets/player.png', coin: 'assets/coin.png' },
  sounds: { jump: 'assets/jump.ogg' },
};
// Phaser: in preload()
//   for (const [k, u] of Object.entries(ASSETS.images)) this.load.image(k, u);
//   this.load.on('loaderror', (f) => failed.push(f.key));
// then in create(): if (failed.length) show the list and stop.
```

```js
// @selftest — the manifest check is pure: which keys are missing or duplicated?
function checkManifest(manifest, loadedKeys) {
  const want = Object.values(manifest).flatMap((group) => Object.keys(group));
  const dupes = want.filter((k, i) => want.indexOf(k) !== i);
  const missing = want.filter((k) => !loadedKeys.has(k));
  return { ok: !missing.length && !dupes.length, missing, dupes };
}
const manifest = { images: { player: 'p.png', coin: 'c.png' }, sounds: { jump: 'j.ogg' } };
assert.deepEqual(checkManifest(manifest, new Set(['player', 'coin', 'jump'])), { ok: true, missing: [], dupes: [] });
assert.deepEqual(checkManifest(manifest, new Set(['player', 'jump'])).missing, ['coin']);
```

## 2. A seeded input fuzz — press everything, for a while, and watch

The two broken games died on inputs nobody tried: jumping while already in the
air, pausing during the game-over transition. A fuzz presses real keys in a
seeded, repeatable order, so a crash can be replayed exactly.

```js
// @selftest — a seeded RNG and a fuzz script are deterministic, so a failure replays
function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function fuzzScript(seed, keys, steps) {
  const rnd = mulberry32(seed);
  return Array.from({ length: steps }, () => ({ key: keys[Math.floor(rnd() * keys.length)], holdMs: 16 + Math.floor(rnd() * 300) }));
}
const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space', 'KeyP', 'Escape'];
const a = fuzzScript(7, keys, 50), b = fuzzScript(7, keys, 50);
assert.deepEqual(a, b);                                   // same seed, same run
assert.ok(new Set(a.map((s) => s.key)).size >= 4);        // it actually covers the keys
assert.ok(a.every((s) => s.holdMs >= 16 && s.holdMs < 316));
```

In the page, replay it by dispatching real events, and record what breaks:

```js
async function runFuzz(script) {
  const errors = [];
  addEventListener('error', (e) => errors.push(e.message));
  for (const { key, holdMs } of script) {
    dispatchEvent(new KeyboardEvent('keydown', { code: key, key }));
    await new Promise((r) => setTimeout(r, holdMs));
    dispatchEvent(new KeyboardEvent('keyup', { code: key, key }));
  }
  return errors;
}
```

⚠️ Listen for `code` in the game (`e.code === 'Space'`), not `keyCode`, or the
fuzz and real players will disagree.

## 3. An FPS probe — the median lies, read the slow frames

```js
// @selftest — frame-time stats: p95 and the count of long frames catch stutter the average hides
function frameStats(deltasMs) {
  const s = [...deltasMs].sort((x, y) => x - y);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { fps: Math.round(1000 / pct(0.5)), p95: pct(0.95), long: deltasMs.filter((d) => d > 50).length };
}
const smooth = Array(120).fill(16.7);
const stutter = [...Array(110).fill(16.7), ...Array(10).fill(80)];
assert.equal(frameStats(smooth).fps, 60);
assert.equal(frameStats(stutter).fps, 60);               // the median looks fine…
assert.equal(frameStats(stutter).long, 10);              // …the long frames do not
```

Collect `deltasMs` in the game's own `requestAnimationFrame` loop for five
seconds of play. **Pass: p95 ≤ 33 ms and no frame over 100 ms** after loading.

## 4. Stuck-state detection — alive is not the same as playing

A game can run at 60 fps while the player is stuck in a wall or the state is
frozen on a transition. Sample a small fingerprint every second of the fuzz:

```js
// @selftest — if nothing that matters changed across the fuzz, the game is soft-locked
function softLocked(samples) {
  const fp = samples.map((s) => `${s.state}|${Math.round(s.x)}|${Math.round(s.y)}|${s.score}`);
  return fp.length > 3 && new Set(fp).size === 1;
}
assert.equal(softLocked([{ state: 'play', x: 1, y: 2, score: 0 }, { state: 'play', x: 9, y: 2, score: 0 }, { state: 'play', x: 9, y: 2, score: 1 }, { state: 'play', x: 3, y: 2, score: 1 }]), false);
assert.equal(softLocked(Array(5).fill({ state: 'over', x: 0, y: 0, score: 3 })), true);
```

Expose the fingerprint as `window.__game = { state, x, y, score }` so a probe can
read it without knowing the engine.

## 5. What to report

Only say "playable" with all four numbers: assets `ok`, fuzz errors `0`,
p95 frame time, soft-lock `false` — and which seed. Anything else is
"it loads", and say exactly that.
