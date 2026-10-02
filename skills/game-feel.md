---
name: game-feel
description: Juice and presentation with real numbers — hitstop, trauma shake, easing, squash, particles, sprite sheets, and a HUD that looks designed
when: The mechanics work but it feels flat, floaty or cheap; adding impact feedback, animation, transitions or polish
---

# Game feel

⚠️ **The failure this exists to stop:** everything works — move, shoot, lose,
restart — and it still reads as a school project. Correct is not satisfying, and
the gap between them is about 80 lines.

Read `game-prototype` first: none of this rescues a broken loop or a missing
lose condition. This is the layer you add *after* it plays.

## ⭐ The order, by return per line. Do them top down and stop when it feels good.

| # | thing | lines | what it fixes |
|---|---|---|---|
| 1 | **Hitstop** | ~6 | hits have no weight |
| 2 | **Screen shake** | ~10 | nothing feels loud |
| 3 | **Hit flash + knockback** | ~8 | you cannot tell you were hit |
| 4 | **Death particles** | ~15 | things vanish instead of dying |
| 5 | **Tweened UI + state fades** | ~12 | menus snap like a slideshow |
| 6 | **Squash / stretch** | ~6 | the player is a rigid brick |
| 7 | **Camera lookahead** | ~5 | you cannot see what you are running into |

⚠️ Doing #4 before #1 is the common mistake. Particles are the *visible* one so
they get built first; hitstop is the one people actually feel.

---

## 1. Hitstop — freeze the simulation, never the loop

The trick: on impact, stop advancing time for a few frames while still drawing.
60–90ms on a normal hit, 120–180ms on a kill, 250ms on player death.

```js
let freeze = 0;                       // seconds of simulation to skip
export const hitstop = (s) => { freeze = Math.max(freeze, s); };  // max, not +=

function update(dt) {
  if (freeze > 0) { freeze -= dt; return; }   // ⚠️ RETURN — render still runs
  ...
}
```

- ⚠️ **`Math.max`, not `+=`.** Three enemies dying in one tick with `+=` gives a
  270ms lockup that reads as a crash.
- ⛔ **Never `setTimeout`, never a busy-wait, never `cancelAnimationFrame`.**
  Stopping the loop stops rendering, and a frozen game with a frozen screen is
  indistinguishable from a hang. Skipping `update` keeps the picture alive.
- Pair it with the shake: freeze, then release into the shake. Freeze alone reads
  as lag; shake alone reads as noise.

## 2. Screen shake — trauma squared, decaying, applied at render time

Do not add a random offset and decay it linearly: that reads as a wobble. Keep a
single `trauma` in 0–1, shake by **trauma²**, decay trauma at a constant rate.
The square is what makes a big hit feel disproportionately bigger than a small one.

```js
let trauma = 0;
export const addTrauma = (n) => { trauma = Math.min(1, trauma + n); };  // hit .3, kill .55, death 1

function shakeOffset(dt) {
  trauma = Math.max(0, trauma - 1.4 * dt);   // ~0.7s from full to zero
  const s = trauma * trauma;                 // ⭐ squared
  const r = () => (Math.random() * 2 - 1) * s;
  return { x: r() * 14, y: r() * 14, rot: r() * 0.02 };  // 14px, ~1.1° at full
}

// render, ONCE, around the world — not around the HUD
ctx.save(); ctx.translate(sx, sy); drawWorld(ctx); ctx.restore();
drawHUD(ctx);            // ⚠️ outside, or the score jitters and looks broken
```

- ⚠️⚠️ **Shake the CAMERA, never the entities.** Adding the offset to positions
  puts it through collision, so a big hit teleports the player into a wall.
- In Phaser this whole section is `this.cameras.main.shake(180, 0.008)` and
  `.flash(90, 255, 255, 255)` — use those, do not reimplement.

## 3. Damage feedback — three things, all cheap

- **Hit flash**: draw the sprite solid white for 60–80ms — on canvas,
  `ctx.globalCompositeOperation = 'lighter'` over it, or `ctx.filter =
  'brightness(3)'` for the frames where `flash > 0`.
- **Knockback**: `vx += Math.sign(dx) * 260; vy -= 90` — always a small upward
  component, or it looks like sliding rather than being hit.
- **Invulnerability frames**: ~800ms, *blinking at 10Hz* so the player can see it:
  `if (iframes > 0 && (elapsed * 10 | 0) % 2) skipDraw()`. ⚠️ i-frames with no
  visual read as "the hitbox is broken".
- **Damage numbers**: a `{x, y, vy: -60, life: 0.7, text}` drifting up and fading
  — the cheapest legibility win in an action game.

## 4. Particles — pooled, short-lived, and never per-frame `push`

```js
const P = Array.from({ length: 256 }, () => ({ life: 0 }));   // fixed pool
let head = 0;
function emit(x, y, n, hue) {
  for (let i = 0; i < n; i++) {
    const p = P[head = (head + 1) % P.length];                // overwrite oldest
    const a = Math.random() * Math.PI * 2, sp = 60 + Math.random() * 220;
    p.x = x; p.y = y; p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
    p.life = p.max = 0.35 + Math.random() * 0.35; p.hue = hue;
  }
}   // ⚠️ a fixed pool: never `push` per frame, never allocate in the loop
```

Numbers that look right: **10–16 particles** on a small death, 24–30 on a big one,
lifetime **0.3–0.7s**, initial speed 60–280px/s, gravity ~600, `alpha = life/max`
and `size = 1 + 3 * (life/max)` so they shrink as they fade. Draw **additively**
(`globalCompositeOperation = 'lighter'`) — the one line that makes them read as
light instead of confetti.

⛔ **Do not run an ambient emitter at 60Hz.** Continuous background particles
cost frames, add nothing, and are the tell of juice applied by the yard.

## 5. Tweens and easing — no library, and the durations matter

```js
const easeOutCubic  = (t) => 1 - (1 - t) ** 3;                 // things arriving
const easeOutBack   = (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2;  // pops
const easeInOutQuad = (t) => t < .5 ? 2*t*t : 1 - (-2*t + 2)**2 / 2;       // camera
const easeOutElastic = (t) => t === 0 || t === 1 ? t
  : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI / 3)) + 1;    // rewards
```

Durations, from things that ship: **120ms** for a button or HUD counter,
**180–260ms** for a panel or pop-in, **300ms** for a scene fade, **90ms** for
anything that must feel instant. ⚠️ Over 400ms on an interactive element reads as
lag, not polish.

- ⭐ **Stagger a list**: item `i` starts at `i * 40ms`. Ten menu items appearing
  together look generated; the same ten staggered look designed.
- **Score counts up, never jumps**: lerp the *displayed* value toward the real one
  and round for drawing. Two lines.
- ⚠️ **Never tween by a per-frame constant.** `x += (target - x) * 0.1` is
  framerate-dependent — 1.7× faster on a 144Hz monitor. Correct:
  `x += (target - x) * (1 - Math.pow(1 - 0.1, dt * 60))`. Same class of bug as
  the fixed-timestep one in `game-prototype` A1, and it hides in every "smooth
  follow" line anyone writes.

## 6. Squash, stretch and anticipation

```js
// on landing: squash, then release. Preserve volume — sy up means sx down.
p.sy = 0.72; p.sx = 1 / p.sy;
// each frame, ease both back to 1 over ~140ms
```

Also: scale the player **1.06× vertically while rising** and back at the apex, and
rotate a projectile to `Math.atan2(vy, vx)`. Three lines, and the difference
between a moving rectangle and a character.

⚠️ Scale around the sprite's **feet or centre**, not its top-left corner, or
squashing makes it sink through the floor.

## 7. Camera lookahead

Aim slightly ahead of the direction of travel — `target.x + vx * 0.22` — clamped
to the level bounds, using the framerate-independent lerp above. Too far ahead and
the player loses their own position; 0.15–0.3s of travel is the useful range. Add
~15% downward bias in a platformer so you see the ground you are landing on.

---

# Presentation — the part that decides if it looks finished

## Sprite sheets and atlases

```js
const img = new Image(); img.src = 'sheet.png';
await img.decode();          // ⚠️ drawImage on a half-loaded Image draws NOTHING
const FW = 32, FH = 32, COLS = 8;
function drawFrame(ctx, index, dx, dy, scale = 2) {
  const sx = (index % COLS) * FW, sy = ((index / COLS) | 0) * FH;
  ctx.drawImage(img, sx, sy, FW, FH, dx | 0, dy | 0, FW * scale, FH * scale);
}
// an animation is a lookup, not a timer:
const frame = anim.frames[(elapsed / anim.frameTime | 0) % anim.frames.length];
```

- ⚠️⚠️ **Texture bleeding** — at non-integer positions or scales the sampler pulls
  a row of pixels from the neighbouring frame, giving a bright seam along one edge.
  Fixes in order: floor the destination (`dx | 0`), integer scale,
  `ctx.imageSmoothingEnabled = false`, and 1px padding if you own the sheet.
- **Pixel art needs both** `ctx.imageSmoothingEnabled = false` **and**
  `image-rendering: pixelated` in CSS. One without the other still blurs, and
  `canvas.width = …` resets the context flag — re-apply after every resize.
- Store animations as data — `{ idle: {frames:[0,1], frameTime:0.25},
  run: {frames:[2,3,4,5], frameTime:0.08} }` — not a switch. A new state then
  costs one line.
- ⭐ **With no sheet, do not wait for one and do not generate one.** Generated
  sheets come back misaligned and cost a round each. Primitives on a committed
  palette, or emoji via `ctx.fillText('🚀', x, y)`, read fine.

## The HUD and menus

- ⛔ **Never ship default `10px sans-serif`.** One `ctx.font` line with a real size
  (`'700 28px system-ui, sans-serif'`) is the largest visual upgrade available
  and it costs nothing.
- **Readable over any background**: stroke first (`ctx.lineWidth = 4;
  ctx.strokeStyle = '#0009'; ctx.strokeText(...)`) then fill. A score that
  vanishes over a light tile reads as a bug.
- **Commit to 4–6 colours.** One accent for the player, one for danger, and never
  the danger colour for anything safe. See `colour-and-contrast`.
- **Layout with a margin**: HUD at least 16px from every edge, and centre the menu
  block rather than left-aligning it at 10,10.
- **Never hard-cut between states.** A 200–300ms crossfade — outgoing screen at
  `alpha`, incoming at `1 - alpha` — stops a game-over looking like a crash.
- **Every screen answers one question** (`game-prototype` B2 has the three).

## Motion accessibility — real, and one line

```js
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
```
When true: skip shake entirely, cut particle counts to ~25%, keep hitstop (not
motion), keep fades at half duration. ⚠️ Do **not** disable gameplay animation —
that is the game. Only the decoration.

---

## ⚠️ What earns nothing, and costs frames

- Drop shadows and glows on **everything**. Pick one element that matters.
- Ambient particles, rain, floating dust — noise competing with what the player
  must watch.
- Shake on every event. If everything shakes, nothing is loud. Reserve trauma for
  damage, kills and death.
- Rainbow-cycling hues. It reads as a screensaver.
- Motion blur or full-screen canvas filters — the frame cost is real and on a 2D
  game the effect is usually a smear.

## Verify it, and be specific about what you checked

1. Play until you take a hit and lose. Did you *feel* the hit, and could you tell
   why you lost?
2. Watch the frame rate with the particles going. Juice that drops the game to
   40fps is a downgrade, not polish.
3. Toggle reduced motion and play again — still playable, not lifeless and not
   seizure-inducing.
4. Look at one frozen screenshot of the menu, the play state and the game-over.
   Any that could pass for a debug view is not finished.
5. ⚠️ **Say what you could not check.** A browser proves it renders and the
   console is clean; it cannot tell you the jump feels floaty. Name which of
   the two you verified.

<!-- Every snippet here is original. The only third-party APIs referenced are
     Phaser 3.90 (MIT) — see `game-engines` for the URLs and their licences. -->

