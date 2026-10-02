---
name: three-scenes
description: The premium three.js r186 stage every 3D build starts from (studio light, soft shadows, filmic tone mapping, bloom, resize, loading) and the rules for real .glb models under our policy
when: Anything in three dimensions. Read this first, then three-viewer (products, configurators) or three-game (anything played)
---

# Premium 3D with three.js r186

A default three.js scene reads as a tech demo: black void, one light, grey
plastic, jagged edges, clipped colours. Every one of those is a default, and
`js/stage.js` below overrides all of them. **Copy it verbatim** and build on
it; do not rewrite it from memory. Then start from `three-viewer` or
`three-game`.

What makes it look expensive, in order:

1. **Image-based light**: `scene.environment` from a PMREM-filtered studio.
   Metal and clear-coat need something to reflect or they render black.
2. **Filmic tone mapping** (`ACESFilmicToneMapping`): highlights roll off
   instead of clipping. Output is sRGB by default in r186; CSS hex colours stay
   true. Canvas/image colour maps need `texture.colorSpace = THREE.SRGBColorSpace`.
3. **One shadow-casting sun with a TIGHT frustum** (`shadowBox(half)`, moved
   with the subject), plus a soft contact shadow under an object.
4. **Physical materials, never the default grey**: `MeshPhysicalMaterial` +
   `clearcoat` for paint, `metalness: 1, roughness: 0.2` for steel, roughness
   0.6+ for wood, rubber, fabric.
5. **Damped motion**: ease with `1 - Math.exp(-dt * k)`, `enableDamping` on
   orbit, tween colour changes. Nothing snaps.
6. **Bloom only where light is**: the scene is HDR, so a sunlit white wall is
   already above 1. `bloom: {}` (threshold 2.5) glows lamps and neon with
   `emissiveIntensity` ~10 and leaves painted surfaces crisp.
7. **A world around it**: a CSS gradient behind a transparent canvas, or fog
   matching the sky.

Runtime rules: ONE tag, `/vendor/three@0.186.1/three.bundle.min.js`; loaders,
controls and post-processing are inside it (`THREE.GLTFLoader`,
`THREE.OrbitControls`, `THREE.EffectComposer`, `THREE.UnrealBloomPass`,
`THREE.RoomEnvironment`, `THREE.Sky`, `THREE.RoundedBoxGeometry`). No CDN, no
`import`. r186 has no `sRGBEncoding`, no `PCFSoftShadowMap`, and `THREE.Clock`
warns: use the stage's `onFrame(dt, t)`. Scale all motion by `dt`; simulate in
`Stage.fixedStep`. For 3D physics, cannon-es (`window.CANNON`) from the shelf.

## js/stage.js (copy verbatim)

```js file=js/stage.js
/* stage.js: a premium three.js stage. Needs /vendor/three@0.186.1/three.bundle.min.js first. */
(function () {
  const T = window.THREE;

  // A photo studio of softboxes, pre-filtered (PMREM) into image-based light for every material.
  function studioEnvironment(renderer, o = {}) {
    const env = new T.Scene();
    const room = new T.Mesh(new T.BoxGeometry(40, 18, 40), new T.MeshStandardMaterial({ side: T.BackSide, color: o.wall ?? 0x5c6068, roughness: 1 }));
    room.position.y = 8; env.add(room, new T.AmbientLight(0xffffff, 1.4));
    const panel = (w, h, x, y, z, k, tint = 0xffffff) => {
      const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: new T.Color(tint).multiplyScalar(k), side: T.DoubleSide }));
      m.position.set(x, y, z); m.lookAt(0, 1, 0); env.add(m);
    };
    panel(12, 5, 0, 16, 0, o.top ?? 4);               // overhead
    panel(7, 10, -15, 6, 6, o.key ?? 9, 0xfff1e0);    // warm key
    panel(6, 10, 15, 5, -4, o.fill ?? 3, 0xdce8ff);   // cool fill
    panel(22, 2.5, 0, 3, -18, o.rim ?? 5);            // rim strip
    const pmrem = new T.PMREMGenerator(renderer), tex = pmrem.fromScene(env, 0.04).texture;
    pmrem.dispose(); env.traverse((n) => { n.geometry?.dispose(); n.material?.dispose(); });
    return tex;
  }

  function stage(o = {}) {
    const host = typeof o.el === 'string' ? document.querySelector(o.el) : o.el || document.body;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const renderer = new T.WebGLRenderer({ antialias: true, alpha: !!o.transparent, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.toneMapping = T.ACESFilmicToneMapping;       // highlights roll off instead of clipping
    renderer.toneMappingExposure = o.exposure ?? 1;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFShadowMap;             // soft via shadow.radius in r186
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
    host.prepend(renderer.domElement);

    const scene = new T.Scene();
    scene.environment = studioEnvironment(renderer, o.studio);
    if (!o.transparent) scene.background = new T.Color(o.background ?? 0x0d1015);
    if (o.fog) scene.fog = new T.Fog(o.fog.color ?? o.background, o.fog.near ?? 40, o.fog.far ?? 220);
    const camera = new T.PerspectiveCamera(o.fov ?? 40, 1, 0.1, o.far ?? 600);
    camera.position.set(4, 3, 6);

    // ONE shadow-casting sun with a TIGHT frustum: that is what makes shadows crisp.
    const sun = new T.DirectionalLight(0xffffff, o.sun ?? 2.4);
    sun.position.set(6, 10, 5); sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.02; sun.shadow.radius = 3;
    scene.add(sun, sun.target);
    const shadowBox = (half) => {
      Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 0.1, far: half * 4 });
      sun.shadow.camera.updateProjectionMatrix();
    };
    shadowBox(o.shadowSize ?? 6);

    // Loading veil: stays up until the first frames (or until you call ready()).
    const veil = document.createElement('div');
    veil.style.cssText = 'position:absolute;inset:0;display:grid;place-content:center;background:inherit;color:#cfd6e0;font:500 12px system-ui;letter-spacing:.2em;transition:opacity .6s';
    veil.textContent = 'LOADING'; host.appendChild(veil);
    T.DefaultLoadingManager.onProgress = (_u, done, all) => { veil.textContent = `LOADING ${Math.round((done / all) * 100)}%`; };
    const ready = () => { veil.style.opacity = 0; veil.style.pointerEvents = 'none'; };

    // Optional bloom: only what is brighter than `threshold` (HDR) glows: lamps, neon, emissiveIntensity ~10.
    let composer = null;
    if (o.bloom) {
      composer = new T.EffectComposer(renderer, new T.WebGLRenderTarget(1, 1, { type: T.HalfFloatType, samples: 4 }));
      composer.addPass(new T.RenderPass(scene, camera));
      composer.addPass(new T.UnrealBloomPass(new T.Vector2(1, 1), o.bloom.strength ?? 0.6, o.bloom.radius ?? 0.4, o.bloom.threshold ?? 2.5));
      composer.addPass(new T.OutputPass());               // tone mapping + sRGB after the glow
    }
    const fit = () => {
      const w = host.clientWidth || innerWidth, h = host.clientHeight || innerHeight;
      renderer.setSize(w, h, false);
      if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); }
      camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    new ResizeObserver(fit).observe(host); fit();

    const updates = [];
    let last = performance.now(), t = 0, frames = 0;
    const frame = (now) => {
      const dt = Math.min(Math.max(0, now - last) / 1000, 1 / 20); last = now; t += dt;   // no teleport after a stall
      for (const fn of updates) fn(dt, t);
      composer ? composer.render(dt) : renderer.render(scene, camera);
      if (++frames === 2 && o.autoReady !== false) ready();
    };
    renderer.setAnimationLoop(frame);
    document.addEventListener('visibilitychange', () => { renderer.setAnimationLoop(document.hidden ? null : frame); last = performance.now(); });
    return { THREE: T, host, scene, camera, renderer, sun, shadowBox, ready, onFrame: (fn) => updates.push(fn) };
  }

  // Fixed-step simulation: identical physics at 30, 60 or 144 fps.
  function fixedStep(step, hz = 120) {
    const h = 1 / hz; let acc = 0;
    return (dt) => { acc += dt; let n = 0; while (acc >= h && n++ < 8) { step(h); acc -= h; } if (n >= 8) acc = 0; };
  }
  // Camera distance that frames an object's bounding sphere for this lens.
  function frameObject(camera, object, pad = 1.2) {
    const s = new T.Box3().setFromObject(object).getBoundingSphere(new T.Sphere());
    return { center: s.center, radius: s.radius, distance: (s.radius * pad) / Math.sin(T.MathUtils.degToRad(camera.fov) / 2) };
  }
  // Held keys in one Set (`keys.has('KeyW')`); `bind` maps a key code to a press handler.
  function input(bind = {}) {
    const keys = new Set();
    addEventListener('keydown', (e) => { keys.add(e.code); if (bind[e.code]) { e.preventDefault(); bind[e.code](); } });
    addEventListener('keyup', (e) => keys.delete(e.code));
    addEventListener('blur', () => keys.clear());
    return keys;
  }
  window.Stage = { stage, studioEnvironment, fixedStep, frameObject, input };
})();
```

`Stage.stage(options)` returns `{ THREE, host, scene, camera, renderer, sun,
shadowBox(half), ready(), onFrame(fn(dt, t)) }`. Options: `el`, `transparent`,
`background`, `fog: {color, near, far}`, `fov`, `far`, `exposure`, `sun`,
`shadowSize`, `bloom: {strength, radius, threshold}`, `autoReady: false`
(call `ready()` once your model is in), `studio: {wall, key, fill, top, rim}`.

## A real .glb model: what works under our policy

- A project cannot hold a `.glb` (binary files are refused), and `.load(url)`
  FETCHES: the shared link's `connect-src` names only the app's data endpoints
  and the Projects preview's is `'none'`. So
  `new THREE.GLTFLoader().load('model.glb')` is **refused**. Draco, KTX2 and
  meshopt need WebAssembly and are not on the shelf.
- What works everywhere: bytes the page already has. A small UNcompressed model
  as a `.js` file holding base64, then
  `new THREE.GLTFLoader().parse(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer, '', (g) => group.add(g.scene))`.
  Keep it well under 150 KB; the whole project has a size cap.
- We already host ready models in exactly that shape — trees, rocks, coins,
  chests, cars, a rigged person with walk/run clips — plus sky lighting and
  tiling textures: `read_skill("game-assets")`.
- Otherwise model the object from geometry (lathe profiles, extruded shapes,
  rounded boxes). A well-lit procedural object beats a broken model tag.
- Any loaded model: `traverse` to set `castShadow`/`receiveShadow`, frame it
  with `Stage.frameObject`, swap colours by material NAME, never by index.

## Performance

One renderer, one loop (`onFrame`), never a second `requestAnimationFrame`.
Many copies of one thing → `InstancedMesh`. Only what needs it casts shadows.
DPR is capped at 2 and the loop pauses on a hidden tab: keep both. Dispose what
you remove.
