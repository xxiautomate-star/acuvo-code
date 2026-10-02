---
name: three-viewer
description: A 3D product viewer to start from on the three-scenes stage: damped orbit, turntable that yields to the user, colourway swaps that tween, hotspots pinned to the model, contact shadow, an entrance glide
when: A product page, a configurator, a showroom, a model on a page that people turn around. Read three-scenes first for js/stage.js
---

# A 3D product viewer that reads as a product page

Uses `js/stage.js` from `three-scenes`, unchanged. The product is PROCEDURAL
(`LatheGeometry` profiles) so it runs with no file: bottles, cups, lamps,
speakers, watches and vases are a lathe profile plus one or two parts. Replace
`product` and `COLOURWAYS`; keep everything around them. With a real model,
parse it into `product` (see `three-scenes`) and point the colourways at its
material names.

```html file=viewer.html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Arc Bottle</title>
<style>
*{box-sizing:border-box;margin:0}
body{font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#11151c;background:#f4f2ee}
.product{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(300px,1fr);min-height:100vh}
#viewer{height:100vh;overflow:hidden;background:radial-gradient(120% 90% at 50% 38%,#fff 0%,#eeebe5 48%,#d9d4cb 100%)}
.copy{padding:clamp(28px,6vw,72px);display:flex;flex-direction:column;justify-content:center;gap:22px;border-left:1px solid #e3e1dc;background:#faf9f6}
.eyebrow,.cw{font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:#6b7380}
h1{font-size:clamp(34px,4.4vw,56px);line-height:1;letter-spacing:-.03em;font-weight:650}
.price{font-size:20px;font-weight:600}
.lede{color:#434a55;max-width:36ch}
#swatches{display:flex;gap:12px;margin-bottom:10px}
.swatch{width:34px;height:34px;border-radius:50%;border:0;cursor:pointer;box-shadow:inset 0 0 0 1px #0002;outline:2px solid transparent;outline-offset:3px;transition:outline-color .2s}
.swatch[aria-pressed=true]{outline-color:#11151c}
.buy{align-self:flex-start;padding:14px 26px;border-radius:999px;border:0;background:#11151c;color:#fff;font:600 15px/1 inherit;cursor:pointer}
.hint{position:absolute;left:50%;bottom:22px;transform:translateX(-50%);font-size:12px;letter-spacing:.1em;color:#0008;pointer-events:none}
.hs{position:absolute;left:0;top:0;transition:opacity .25s}
.hs button{width:18px;height:18px;border-radius:50%;border:2px solid #fff;background:#11151ccc;cursor:pointer;animation:pulse 2.4s infinite}
.hs span{position:absolute;left:26px;top:50%;transform:translateY(-50%);white-space:nowrap;background:#fff;padding:7px 11px;border-radius:8px;font-size:12.5px;box-shadow:0 6px 24px #0001;opacity:0;transition:opacity .2s;pointer-events:none}
.hs:hover span,.hs.open span{opacity:1}
.hs.away{opacity:0;pointer-events:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 #11151c55}70%,100%{box-shadow:0 0 0 12px #11151c00}}
@media (max-width:820px){.product{grid-template-columns:1fr}#viewer{height:62vh}.copy{border-left:0}}
</style>
</head>
<body>
<main class="product">
  <div id="viewer"><p class="hint">DRAG TO TURN · SCROLL TO ZOOM</p></div>
  <section class="copy">
    <p class="eyebrow">Insulated · 750 ml</p>
    <h1>Arc Bottle</h1>
    <p class="price">A$59</p>
    <p class="lede">Double-wall steel that keeps ice for a full day, a brushed-steel collar and a cap turned from bamboo.</p>
    <div><div id="swatches"></div><p class="cw" id="cw-name"></p></div>
    <button class="buy">Add to bag</button>
  </section>
</main>
<script src="/vendor/three@0.186.1/three.bundle.min.js"></script>
<script src="js/stage.js"></script>
<script src="js/viewer.js"></script>
</body>
</html>
```

```js file=js/viewer.js
/* viewer.js — product viewer: turntable, damped orbit, colourways, hotspots. Needs stage.js. */
(function () {
  const S = Stage.stage({ el: '#viewer', transparent: true, fov: 30, exposure: 1.05, shadowSize: 1.6 });
  const { THREE: T, scene, camera, renderer, sun, host } = S;

  // ── The product. With a real model: new THREE.GLTFLoader().parse(buffer, '', (g) => product.add(g.scene))
  //    and point COLOURWAYS at its material names. Procedural here so the starter runs with no file.
  const COLOURWAYS = [
    { name: 'Midnight', body: '#1c2431', cap: '#c49a6c' },
    { name: 'Sage',     body: '#8c9f86', cap: '#d8b98f' },
    { name: 'Clay',     body: '#b8633f', cap: '#2a2522' },
    { name: 'Bone',     body: '#e6e0d3', cap: '#8a6a4a' },
  ];
  const mat = {
    body: new T.MeshPhysicalMaterial({ color: COLOURWAYS[0].body, roughness: 0.48, metalness: 0.15, clearcoat: 0.6, clearcoatRoughness: 0.35 }),
    steel: new T.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.2, metalness: 1 }),
    cap: new T.MeshStandardMaterial({ color: COLOURWAYS[0].cap, roughness: 0.62, metalness: 0 }),
  };
  const lathe = (pts, m, seg = 96) => {
    const g = new T.LatheGeometry(pts.map(([r, y]) => new T.Vector2(r, y)), seg);
    const mesh = new T.Mesh(g, m); mesh.castShadow = true; mesh.receiveShadow = true; return mesh;
  };
  const round = (r0, y0, rad, from, to, n = 10) => Array.from({ length: n + 1 }, (_, i) => {
    const a = from + (to - from) * (i / n); return [r0 + Math.cos(a) * rad, y0 + Math.sin(a) * rad];
  });
  const product = new T.Group();
  product.add(lathe([[0, 0], ...round(0.34, 0.08, 0.08, -Math.PI / 2, 0), [0.42, 0.3], [0.42, 1.9],
    ...round(0.3, 1.9, 0.12, 0, Math.PI / 2), [0.3, 2.06]], mat.body));
  product.add(lathe([[0.3, 2.05], [0.315, 2.07], [0.315, 2.19], [0.3, 2.21]], mat.steel));
  product.add(lathe([[0, 2.2], [0.3, 2.2], [0.305, 2.24], [0.305, 2.52], ...round(0.245, 2.52, 0.06, 0, Math.PI / 2), [0, 2.58]], mat.cap));
  const loop = new T.Mesh(new T.TorusGeometry(0.13, 0.028, 16, 48, Math.PI), mat.steel);
  loop.position.set(0, 2.58, 0); loop.castShadow = true; product.add(loop);
  scene.add(product);

  // Contact shadow (soft, always) + the sun's real shadow (crisp, directional).
  const blob = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(0,0,0,.55)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    const m = new T.Mesh(new T.PlaneGeometry(1.5, 1.5), new T.MeshBasicMaterial({ map: new T.CanvasTexture(c), transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2; m.position.y = 0.002; return m;
  })();
  const floor = new T.Mesh(new T.PlaneGeometry(8, 8), new T.ShadowMaterial({ opacity: 0.16 }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(blob, floor);
  sun.position.set(2.5, 5, 3); sun.target.position.set(0, 1, 0);

  // Frame it, then a damped orbit with a turntable that yields to the user.
  const fit = Stage.frameObject(camera, product, 1.25);
  const target = fit.center.clone().setY(fit.center.y * 0.95);
  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.target.copy(target);
  controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.enablePan = false;
  controls.minDistance = fit.distance * 0.55; controls.maxDistance = fit.distance * 1.6;
  controls.minPolarAngle = 0.35; controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.autoRotate = true; controls.autoRotateSpeed = 0.7;
  let idle;
  controls.addEventListener('start', () => { controls.autoRotate = false; clearTimeout(idle); });
  controls.addEventListener('end', () => { idle = setTimeout(() => (controls.autoRotate = true), 2500); });

  // Entrance: glide in from further out once the first frame is up.
  const dir = new T.Vector3(0.9, 0.42, 1).normalize();
  camera.position.copy(target).addScaledVector(dir, fit.distance * 1.7);
  let intro = 0;
  S.onFrame((dt) => {
    if (intro < 1) {
      intro = Math.min(1, intro + dt / 1.6);
      const e = 1 - Math.pow(1 - intro, 3);
      camera.position.copy(target).addScaledVector(dir, fit.distance * (1.7 - 0.7 * e));
    }
    controls.update();
  });

  // Colourways: tween toward the target so a swap feels physical, not a cut.
  const want = { body: new T.Color(mat.body.color), cap: new T.Color(mat.cap.color) };
  S.onFrame((dt) => {
    const k = 1 - Math.exp(-dt * 9);
    mat.body.color.lerp(want.body, k); mat.cap.color.lerp(want.cap, k);
  });
  const sw = document.getElementById('swatches'), cwName = document.getElementById('cw-name');
  COLOURWAYS.forEach((cw, i) => {
    const b = document.createElement('button');
    b.className = 'swatch'; b.style.background = cw.body; b.setAttribute('aria-label', cw.name);
    b.setAttribute('aria-pressed', String(i === 0));
    b.onclick = () => {
      want.body.set(cw.body); want.cap.set(cw.cap); cwName.textContent = cw.name;
      sw.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    };
    sw.appendChild(b);
  });
  cwName.textContent = COLOURWAYS[0].name;

  // Hotspots: DOM labels pinned to points on the model; hidden when that side faces away.
  const HOTSPOTS = [
    { at: [0.3, 2.4, 0.12], n: [1, 0, 0.4], text: 'Bamboo cap, hand-finished' },
    { at: [0.28, 2.13, -0.1], n: [1, 0, -0.35], text: 'Brushed steel collar' },
    { at: [0, 1.1, 0.42], n: [0, 0, 1], text: 'Double-wall vacuum · 24 h cold' },
  ].map((h) => {
    const el = document.createElement('div'); el.className = 'hs';
    el.innerHTML = `<button aria-label="${h.text}"></button><span>${h.text}</span>`;
    el.querySelector('button').onclick = () => el.classList.toggle('open');
    host.appendChild(el);
    return { el, p: new T.Vector3(...h.at), n: new T.Vector3(...h.n).normalize() };
  });
  const v = new T.Vector3(), toCam = new T.Vector3();
  S.onFrame(() => {
    const w = host.clientWidth, h = host.clientHeight;
    for (const hs of HOTSPOTS) {
      v.copy(hs.p).applyMatrix4(product.matrixWorld);
      toCam.copy(camera.position).sub(v).normalize();
      hs.el.classList.toggle('away', hs.n.dot(toCam) < 0.15);
      v.project(camera);
      hs.el.style.transform = `translate(${(v.x * 0.5 + 0.5) * w - 9}px, ${(-v.y * 0.5 + 0.5) * h - 9}px)`;
    }
  });
})();
```
