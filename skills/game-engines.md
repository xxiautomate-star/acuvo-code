---
name: game-engines
description: Choosing and driving a game engine — Phaser 3.90, PIXI 7, Matter 0.20, Howler — and the removed APIs that throw. The URLs themselves are in vendor-shelf
when: Building a game, a physics toy or an arcade prototype, or deciding whether an engine is worth it at all
---

# Using a game engine

The plumbing: how to reach an engine, and where the API you remember is the
wrong major version. Read it **with** `game-prototype` (loop, input, state,
collision) and `game-feel` (making it look finished).

**Yes** to an engine for an arcade game, a platformer, a shooter — many entities
plus physics — and *always* for stacking, ragdolls or joints: never hand-write a
rigid-body solver. **No** for a toy, a visualiser, one mechanic, a jam-sized
idea: a working 300-line canvas game beats a beautiful Phaser game that never loads.

**The `<script src>` lines are in `vendor-shelf`** — all seventeen libraries
(Phaser, PIXI, Matter, Howl among them), the CSP rule that blocks every CDN, the
per-library version traps. ⚠️ Never paraphrase a URL from memory: a version typo
404s silently and looks exactly like a logic bug. Each trap below is an API from
a **different major version** than the one at that URL, and none errors with
"wrong version".

## Default: the raw 2D canvas — Phaser only when asked

Measured over 19 shipped games (2026-09-27): raw-canvas games played **9 of 10**,
Phaser games **1 of 9** (invented APIs, a Scene with no Game, AUTO with a custom
canvas). A 2D game is a `requestAnimationFrame` loop with a fixed-step
`update(dt)` and a `draw()` into one `<canvas>` whose backing store matches its
CSS size. Phaser only when the user asks — then follow the next section exactly.

⭐ **If `game/kit.js` is in the workspace (seeded on every new game), build on it.**
It is tested: the loop, a full-screen DPR-correct canvas, keyboard + touch
actions, title / pause / game-over screens drawn from frame one. You write
`GameKit.start({ title, controls, init(g), update(g, dt), draw(g, ctx) })` and
nothing else of the frame; its header lists the whole `g` API. Hand-written, it
shipped empty three ways, all plumbing: a shared field one file used and none
defined (every coordinate `NaN`, drawn as nothing), a boot that threw on a
constructor another file never exported, a container with no size (a 2x2 board).

## Phaser 3.90 — when the user asks for it

```js
const game = new Phaser.Game({
  type: Phaser.AUTO, width: 800, height: 600,
  parent: 'app',                         // ⚠️ or it appends wherever it likes
  backgroundColor: '#12141c',
  pixelArt: true,                        // for pixel art — see game-feel
  physics: { default: 'arcade', arcade: { gravity: { y: 900 }, debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [BootScene, GameScene],         // classes, not one big object
});
```

### ⚠️⚠️ `createEmitter` was REMOVED and throws — this is the single biggest one

Phaser 3.60 rewrote particles; the pre-3.60 shape everyone writes from memory
throws on 3.90, verbatim:

> `Error: createEmitter removed. See ParticleEmitter docs for info`

```js
// ⛔ pre-3.60 — throws the error above
this.add.particles('spark').createEmitter({ speed: 200, lifespan: 400 });

// ✅ 3.60+ — add.particles IS the emitter, and takes x, y, texture, config
const burst = this.add.particles(0, 0, 'spark', {
  speed: { min: 60, max: 220 }, lifespan: 420, quantity: 12,
  scale: { start: 1, end: 0 }, blendMode: 'ADD', emitting: false,
});
burst.explode(14, x, y);                 // one-shot at a point
```

⚠️ **And a particle needs a texture** — with no art you get
`Error: Particle has no texture frame`. Make one in `create()` (the same four
lines give you every other primitive):

```js
const g = this.make.graphics({ x: 0, y: 0, add: false });
g.fillStyle(0xffffff, 1).fillCircle(4, 4, 4);
g.generateTexture('spark', 8, 8);        // now 'spark' is a real texture key
g.destroy();
```

### The rest, in the order they bite

- ⚠️⚠️ **`update(time, delta)` — `delta` is MILLISECONDS.** `x += speed * delta`
  runs **sixty times too fast**. Use `delta / 1000`, or `setVelocityX()` and
  let arcade physics integrate.
- ⚠️ **You need no art.** `this.add.rectangle(x, y, w, h, 0x44ccff)` plus
  `this.physics.add.existing(rect)` is a physics-enabled primitive. A game of
  rectangles is a real game; a game waiting on sprites is not.
- **Held vs one-shot:** `cursors.left.isDown` is held;
  `Phaser.Input.Keyboard.JustDown(spaceKey)` is the edge — confuse them and the
  jump fires every frame. WASD: `this.keys = this.input.keyboard.addKeys('W,A,S,D')`.
- **Grounded** is `sprite.body.blocked.down` (`.touching.down` against a
  body) — never a flag you maintain.
- `physics.add.collider(a, b)` blocks; `overlap(a, b, cb)` detects without
  blocking. Pickups need `overlap`; floors need `collider`.
- ⚠️ **The HUD scrolls away with the camera** unless pinned:
  `text.setScrollFactor(0)` + `setDepth(1000)`. No second camera needed.
- **Camera follow**, once the level is bigger than the screen:
  ```js
  this.cameras.main.setBounds(0, 0, levelW, levelH);
  this.physics.world.setBounds(0, 0, levelW, levelH);
  this.cameras.main.startFollow(player, true, 0.08, 0.08);  // lerp, not snap
  this.cameras.main.setDeadzone(120, 80);                   // no jitter when idle
  ```
  ⚠️ Camera and **world** bounds are separate: set only the camera and the
  player walks out of the level while the view stops.
- **Scenes are the state machine.** `this.scene.start('Game')`,
  `pause()` / `resume()`, `this.scene.launch('Pause')` for an overlay *over* a
  paused scene, and `this.scene.restart()` — re-runs `create`, the correct
  reset. Never hand-write a `reset()` that must remember every mutable field.
- ⚠️ Arcade bodies are **axis-aligned rectangles**. `setRotation` turns the
  sprite and not its body. Rotated collision means Matter, not arcade.
- **Bullets: pool, do not allocate.** `const bullets = this.physics.add.group({
  maxSize: 40 })`, then `bullets.get(x, y, 'bullet')` — `null` when full, the
  correct backpressure. `killAndHide(b)` returns one to the pool.

## PIXI 7.4.3 — a renderer, not a game framework

⚠️⚠️ **v8's startup is the one models emit, and this shelf is v7.** v8 code
throws `app.init is not a function`; the fix is not a shim, it is writing v7:

```js
// ✅ 7.4.3 — SYNCHRONOUS constructor, and the canvas is `app.view`
const app = new PIXI.Application({
  width: 800, height: 600, background: 0x101018,
  antialias: true, resolution: devicePixelRatio, autoDensity: true,  // HiDPI
});
document.getElementById('app').appendChild(app.view);
```

- ⚠️ **`app.ticker.add((delta) => …)` — `delta` is FRAMES, not ms** (1.0 at
  60fps); real time is `app.ticker.deltaMS`. Phaser's 60× bug, reversed.
- `PIXI.Loader` is gone in v7; assets load through `await PIXI.Assets.load(url)`.
  v6 code fails with "Loader is not a constructor".
- No assets: `PIXI.Texture.from(canvas)` from an offscreen canvas (Phaser's
  `generateTexture` trick).
- Thousands of same-texture sprites go in a `PIXI.ParticleContainer`: no
  per-sprite tint or filters, one batched draw.
- PIXI has **no physics, input, collision or scenes** — you still write all of
  `game-prototype`. Use it for tens of thousands of sprites, not as a framework.

## Matter 0.20 — real rigid-body physics

```js
const { Engine, Runner, Bodies, Composite, Body, Events } = Matter;
const engine = Engine.create();
Composite.add(engine.world, [
  Bodies.rectangle(400, 590, 800, 20, { isStatic: true }),
  Bodies.circle(400, 100, 20, { restitution: 0.8 }),
]);
Runner.run(Runner.create(), engine);
```

- ⚠️ **`Engine.run()` still WORKS — a deprecated alias of `Runner.run`, not a
  removal.** It logs a deprecation line and runs; do not spend a round
  "fixing" it. The real decision is the next bullet.
- ⚠️⚠️ **Pick ONE clock.** `Runner.run` starts its own rAF loop; also call
  `Engine.update(engine, …)` from your loop and every body integrates twice
  (gravity looks doubled). Let the Runner drive, or skip it and call
  `Engine.update(engine, 1000 / 60)` inside your fixed-timestep `update()` —
  deterministic and replayable (`game-prototype` A1).
- Collisions are **events, not return values**:
  `Events.on(engine, 'collisionStart', (e) => e.pairs.forEach(p => …))`, each
  pair with `bodyA` / `bodyB`. Tag bodies with `label` (or a `plugin` field) at
  creation so the handler can tell what hit what.
- ⚠️ Bodies are positioned by their **centre**, not their top-left corner. A
  ground rectangle at `y = height` is half below the screen.
- Static scenery is `{ isStatic: true }`. Forgetting it is why the floor falls.
- Move a body with `Body.setVelocity` / `applyForce`, never by assigning
  `body.position` — that teleports past the solver: tunnelling, stuck pairs.
- Matter simulates; it does not draw your game. `Matter.Render` is a **debug**
  view — ship your own rendering from `body.position` and `body.angle`.
- Resting bodies twitch by design (`slop`); enable `engine.enableSleeping = true`
  for stacks that should settle and stay settled.

## Howler 2.2.4 — audio

`new Howl({ src: ['sfx.mp3'], volume: 0.4 })`. It does the autoplay-unlock
dance for you — the whole reason to use it over raw WebAudio (`game-prototype`
B5 explains the locked-context failure).

- ⚠️ `src` must be an **array**, and a URL with no file extension needs
  `format: ['mp3']` — otherwise it silently plays nothing.
- One `Howl` per sound, reused; one per shot re-decodes the file and stutters.
- `sprite: { jump: [0, 300], hit: [400, 250] }` cuts many effects from one file
  (one request, not a dozen); `s.play('jump')` plays a slice.
- `Howler.volume(0)` is a global mute. Ship the mute key.
- ⚠️ It needs **audio files**. We host CC0 ones (`read_skill("game-assets")`:
  clicks, confirms, impacts, lasers, pickups). With no files at all, use
  **jsfxr** (`/vendor/jsfxr@1.4.1/jsfxr.min.js`, `window.jsfxr`): real retro
  SFX synthesised in the page — `jsfxr.sfxr.toWebAudio(jsfxr.sfxr.generate('laserShoot'), ctx)`,
  render once, keep `.buffer`, replay through a GainNode at ~0.4 (sfxr peaks
  reach ~2 and clip). A game on `game/kit.js` already has it:
  `g.sfx('shoot')` plays the sfxr version when the tag is on the page.

## A game in three dimensions — three r186 + cannon-es

One tag, `/vendor/three@0.186.1/three.bundle.min.js` (loaders, controls, bloom
inside). Never write the stage from memory: `read_skill("three-game")` is a
finished 3D racer — lit, shadowed, fixed-step, chase camera, HUD — on the
`three-scenes` stage. 3D rigid bodies are cannon-es (`window.CANNON`); Phaser,
PIXI and Matter are 2D and have no place in a 3D game.

## ⚠️ Prove the engine actually loaded — the step that gets skipped

A game that failed to load looks identical to one with a logic bug. In order:

1. Open it in a real browser (`playtest`, or `check-the-site-you-built`).
2. Read the console. `Phaser is not defined`, or `Cannot read properties of
   undefined` on line 1 of your script, is the **script tag** — not your game.
3. Network list, engine URL: **404** = a wrong `/vendor/` path (re-copy it from
   `vendor-shelf`); **blocked by CSP** = you reached for a CDN. Same blank
   screen, opposite fixes.
4. `console.log(Phaser.VERSION)` prints `3.90.0`. Writing against another
   major? Stop and re-read the section above.
5. Only then debug your game.

⭐ Say in your handover **which engine and which version** you built against,
or the next editor writes for the version they remember and every trap here
happens again.
