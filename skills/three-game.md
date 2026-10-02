---
name: three-game
description: A 3D game to start from on the three-scenes stage: spline track, arcade car controller, chase camera, fixed-step physics, laps, boost with bloom, HUD over the canvas, touch pad
when: A game in three dimensions (racing, driving, flying, third-person). Read three-scenes first for js/stage.js, three-track for js/track.js
---

# A 3D game that looks finished

Uses `js/stage.js` from `three-scenes` unchanged, plus ⚠️ `js/track.js` from
`read_skill("three-track")` (sky, circuit, gantry, trees): copy all three files.
Change the GAME, not the plumbing. A character instead of a car: keep `c` and
the chase camera, set `c.lat = 0` (instant grip), add a jump (vertical speed +
gravity in the fixed step). Another world: move the spline's control points in
`track.js`; road, kerbs, laps and walls follow. Obstacles: circle-vs-circle in
XZ inside the fixed step, or cannon-es. Scores go in `AcuvoData`; sound is Tone
after a key press. Test like a player: Enter, hold W, the speed readout must move.

```html file=game.html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Apex Loop</title>
<style>
*{box-sizing:border-box;margin:0}
body{height:100vh;overflow:hidden;background:#0b0e13;color:#fff;font:600 14px/1 ui-sans-serif,system-ui,sans-serif}
#game{position:fixed;inset:0;background:#9fc4e4}
.hud{position:fixed;inset:22px 26px;pointer-events:none;display:flex;flex-direction:column;justify-content:space-between}
.row{display:flex;gap:10px}
.chip{background:#0b0e13b0;backdrop-filter:blur(8px);border:1px solid #ffffff1a;border-radius:12px;padding:10px 14px}
small{display:block;font-size:10px;letter-spacing:.18em;color:#ffffff99;margin-bottom:6px}
.chip b{font-size:22px;font-variant-numeric:tabular-nums}
.speedo{align-self:flex-end;text-align:right}
.speedo b{font-size:64px;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.bar{width:180px;height:6px;background:#ffffff22;border-radius:9px;margin:10px 0 0 auto;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#39d0ff,#b46bff);transform-origin:left}
#title{position:fixed;inset:0;display:grid;place-content:center;text-align:center;gap:16px;background:radial-gradient(#0b0e1340,#0b0e13c0)}
#title h1{font-size:clamp(44px,8vw,92px);letter-spacing:-.05em;font-style:italic;font-weight:800}
#title p{color:#ffffffc0;font-weight:500}
kbd{border:1px solid #ffffff55;border-radius:6px;padding:3px 7px;font:inherit;font-size:12px}
.hidden{display:none!important}
.pad{position:fixed;bottom:18px;display:none;gap:12px}
.pad button{width:74px;height:74px;border-radius:50%;border:1px solid #ffffff40;background:#0b0e1380;color:#fff;font-size:22px;touch-action:none}
@media (pointer:coarse){.pad{display:flex}}
</style>
</head>
<body>
<div id="game"></div>
<div class="hud">
  <div class="row">
    <div class="chip"><small>LAP</small><b id="lap">1/3</b></div>
    <div class="chip"><small>TIME</small><b id="time">0:00.00</b></div>
    <div class="chip"><small>BEST LAP</small><b id="best">—</b></div>
  </div>
  <div class="speedo"><b id="speed">0</b><small>KM/H</small><div class="bar"><i id="boost"></i></div></div>
</div>
<div id="title"><h1>APEX LOOP</h1><p><kbd>W A S D</kbd> or arrows to drive · <kbd>SPACE</kbd> boost</p><p>Press <kbd>ENTER</kbd> or tap to start</p></div>
<div class="pad" style="left:18px"><button data-k="ArrowLeft">◀</button><button data-k="ArrowRight">▶</button></div>
<div class="pad" style="right:18px"><button data-k="ArrowDown">■</button><button data-k="Space">⚡</button><button data-k="ArrowUp">▲</button></div>
<script src="/vendor/three@0.186.1/three.bundle.min.js"></script>
<script src="js/stage.js"></script>
<script src="js/track.js"></script>
<script src="js/game.js"></script>
</body>
</html>
```

```js file=js/game.js
/* game.js: a 3D arcade racer (car, chase camera, laps, boost, HUD). Needs stage.js + track.js. */
(function () {
  const S = Stage.stage({ el: '#game', background: 0xcfdde6, fog: { color: 0xcfdde6, near: 70, far: 360 }, fov: 58,
    sun: 2.8, shadowSize: 26, far: 900, studio: { wall: 0x8a9aa6 }, bloom: { strength: 0.7, radius: 0.5, threshold: 3 } });
  const { THREE: T, scene, camera, sun } = S;
  const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z), std = (o) => new T.MeshStandardMaterial(o);
  const { P, N, W } = Track(S), up = V(0, 1, 0); // js/track.js

  // CAR: an extruded side profile, clear-coat paint, lamps bright enough to bloom.
  const paint = new T.MeshPhysicalMaterial({ color: 0xc8102e, metalness: 0.35, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.06 });
  const glass = std({ color: 0x0a0f15, metalness: 0.9, roughness: 0.12 });
  const dark = std({ color: 0x14171b, roughness: 0.6 });
  const lamp = (c, k) => std({ color: c, emissive: c, emissiveIntensity: k });
  const extrude = (pts, depth, bevel) => new T.ExtrudeGeometry(new T.Shape(pts.map(([x, y]) => new T.Vector2(x, y))),
    { depth, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 5 }).translate(0, 0, -depth / 2);
  const car = new T.Group(), chassis = new T.Group(), shell = new T.Group();
  const part = (g, m, x = 0, y = 0, z = 0) => { const p = new T.Mesh(g, m); p.position.set(x, y, z); p.castShadow = true; shell.add(p); return p; };
  part(extrude([[-2.2, 0.3], [-2.28, 0.72], [-1.75, 0.96], [0.95, 0.98], [2.1, 0.8], [2.3, 0.5], [2.18, 0.3]], 1.64, 0.14), paint);
  part(extrude([[-1.5, 0.98], [-0.85, 1.4], [0.3, 1.42], [1.05, 0.98]], 1.36, 0.07), glass);
  part(new T.BoxGeometry(1.2, 0.07, 1.42), paint, -0.28, 1.47);
  part(new T.BoxGeometry(0.28, 0.06, 1.9), dark, -2.12, 1.16); // wing
  for (const z of [-0.62, 0.62]) {
    part(new T.BoxGeometry(0.08, 0.14, 0.42), lamp(0xfff4dc, 12), 2.36, 0.6, z);
    part(new T.BoxGeometry(0.08, 0.1, 0.5), lamp(0xff1a2a, 5), -2.4, 0.74, z);
  }
  const flame = part(new T.ConeGeometry(0.16, 1.2, 12), new T.MeshBasicMaterial({ color: new T.Color(0x7fd8ff).multiplyScalar(9) }), -2.9, 0.45);
  flame.rotation.z = Math.PI / 2;
  shell.rotation.y = -Math.PI / 2; // profile +X = car forward +Z
  chassis.add(shell); car.add(chassis);
  const wheels = [[0.92, 1.38], [-0.92, 1.38], [0.92, -1.38], [-0.92, -1.38]].map(([x, z]) => {
    const pivot = new T.Group(), spin = new T.Group();
    const tyre = new T.Mesh(new T.CylinderGeometry(0.37, 0.37, 0.32, 32), std({ color: 0x151515, roughness: 0.9 }));
    const rim = new T.Mesh(new T.CylinderGeometry(0.25, 0.25, 0.34, 10), std({ color: 0xbfc4ca, metalness: 1, roughness: 0.25 }));
    tyre.rotation.z = rim.rotation.z = Math.PI / 2; tyre.castShadow = true;
    spin.add(tyre, rim); pivot.add(spin); pivot.position.set(x, 0.37, z); car.add(pivot);
    return { pivot, spin, front: z > 0 };
  });
  scene.add(car);

  // DRIVING: arcade, fixed-step; grip bleeds slip, grass costs speed, a soft wall.
  const keys = Stage.input({ Enter: () => start(), Space: () => {} });
  document.querySelectorAll('.pad button').forEach((b) => {
    b.onpointerdown = () => keys.add(b.dataset.k); b.onpointerup = b.onpointerleave = () => keys.delete(b.dataset.k);
  });
  const held = (...k) => k.some((c) => keys.has(c));
  const c = { pos: V(), heading: 0, fs: 0, lat: 0, steer: 0, boost: 1, idx: 0, half: false, off: false, boosting: false };
  const fwd = V(), right = V();
  const reset = () => { const d = P[3].clone().sub(P[0]).normalize(); Object.assign(c, { pos: P[0].clone().addScaledVector(d, -6), heading: Math.atan2(d.x, d.z), fs: 0, lat: 0, idx: 0, half: false, boost: 1 }); };
  reset();
  const LAPS = 3; let state = 'title', raceT = 0, lapT = 0, lap = 1, count = 0;
  let best = Number(localStorage.getItem('apex.best')) || null; // Acuvo app: AcuvoData
  const physics = Stage.fixedStep((h) => {
    const on = state === 'race', thr = on && held('ArrowUp', 'KeyW'), brk = on && held('ArrowDown', 'KeyS');
    const steerIn = on ? held('ArrowLeft', 'KeyA') - held('ArrowRight', 'KeyD') : 0;
    c.boosting = on && held('Space', 'ShiftLeft') && c.boost > 0.02 && c.fs > 5;
    c.boost = T.MathUtils.clamp(c.boost + (c.boosting ? -0.4 : 0.1) * h, 0, 1);
    c.fs += thr * (c.boosting ? 34 : 22) * h * (1 - Math.max(0, c.fs) / (c.boosting ? 84 : 64));
    if (brk) c.fs -= (c.fs > 0 ? 42 : 10) * h;
    c.fs = Math.max(-12, c.fs - c.fs * (c.off ? 1.4 : 0.12) * h - (thr ? 0 : Math.sign(c.fs) * 0.8 * h));
    c.steer += (steerIn - c.steer) * Math.min(1, h * 7);
    const grip = Math.min(1, Math.abs(c.fs) / 10) * (1 - 0.45 * Math.min(1, Math.abs(c.fs) / 90));
    c.heading += c.steer * 2.1 * grip * Math.sign(c.fs) * h;
    c.lat = (c.lat - c.steer * c.fs * 0.05 * h) * Math.exp(-(c.boosting ? 3 : 7) * h); // drift
    fwd.set(Math.sin(c.heading), 0, Math.cos(c.heading)); right.set(fwd.z, 0, -fwd.x);
    c.pos.addScaledVector(fwd, c.fs * h).addScaledVector(right, c.lat * h * 6);
    let bi = c.idx, bd = Infinity; // nearest sample, near the last
    for (let k = -25; k <= 25; k++) { const i = (c.idx + k + N) % N, d = P[i].distanceToSquared(c.pos); if (d < bd) { bd = d; bi = i; } }
    c.off = bd > (W + 1.4) ** 2;
    if (bd > (W + 16) ** 2) { c.pos.lerp(P[bi], 0.08); c.fs *= 0.9; }
    if (Math.abs(bi - N / 2) < 30) c.half = true;
    if (on && c.half && c.idx > N - 30 && bi < 30) { c.half = false; lapDone(); }
    c.idx = bi;
  });
  const fmt = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
  const $ = (id) => document.getElementById(id), screen = $('title');
  const show = (html) => { screen.innerHTML = html; screen.classList.toggle('hidden', !html); };
  function lapDone() {
    if (!best || lapT < best) { best = lapT; try { localStorage.setItem('apex.best', best); } catch {} }
    lapT = 0; if (++lap > LAPS) { state = 'over'; lap = LAPS; show(`<h1>FINISH</h1><p>Total ${fmt(raceT)} · best lap ${fmt(best)}</p><p>Press <kbd>ENTER</kbd> or tap to race again</p>`); }
  }
  function start() { if (state === 'title' || state === 'over') { reset(); raceT = lapT = 0; lap = 1; count = 3; state = 'count'; } }
  screen.onclick = start;

  // PER FRAME: countdown, physics, visuals, chase camera (orbit on the title), HUD.
  const want = V(), look = V(); let spin = 0;
  S.onFrame((dt, t) => {
    if (state === 'count') { count -= dt; show(count > 0 ? `<h1>${Math.ceil(count)}</h1>` : ''); if (count <= 0) state = 'race'; }
    if (state === 'race') { raceT += dt; lapT += dt; }
    physics(dt);
    car.position.copy(c.pos); car.rotation.y = c.heading;
    chassis.rotation.z += (-c.steer * Math.min(1, Math.abs(c.fs) / 40) * 0.06 - chassis.rotation.z) * 0.2; // roll
    spin += (c.fs / 0.37) * dt;
    for (const w of wheels) { w.spin.rotation.x = spin; if (w.front) w.pivot.rotation.y = c.steer * 0.45; }
    flame.visible = c.boosting; flame.scale.setScalar(0.8 + Math.random() * 0.4);
    const sp = T.MathUtils.clamp(c.fs / 70, 0, 1);
    if (state === 'title') want.set(Math.sin(t * 0.25) * 9, 2.4, Math.cos(t * 0.25) * 9).add(c.pos);
    else want.copy(c.pos).addScaledVector(fwd, -(7 + sp * 2.2)).addScaledVector(up, 2.5 + sp * 0.4);
    camera.position.lerp(want, 1 - Math.exp(-dt * (state === 'title' ? 3 : 7)));
    camera.lookAt(look.copy(c.pos).addScaledVector(fwd, state === 'title' ? 0 : 5).addScaledVector(up, 1));
    camera.fov += (58 + sp * 12 + (c.boosting ? 8 : 0) - camera.fov) * (1 - Math.exp(-dt * 4)); camera.updateProjectionMatrix();
    sun.position.copy(c.pos).add(V(30, 50, 20)); sun.target.position.copy(c.pos);
    $('speed').textContent = Math.round(Math.abs(c.fs) * 3.6); $('lap').textContent = `${lap}/${LAPS}`;
    $('time').textContent = fmt(lapT); $('best').textContent = best ? fmt(best) : '—';
    $('boost').style.transform = `scaleX(${c.boost})`;
  });
})();
```
