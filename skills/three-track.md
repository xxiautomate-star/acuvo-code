---
name: three-track
description: The circuit three-game drives on — sky, a closed spline track with asphalt, kerbs and grass, a start gantry, instanced trees — as js/track.js, canvas-drawn, no image files
when: Building the three-game racer, or any 3D world laid out along a closed path. Read three-scenes and three-game with it
---

# The track for `three-game`

`three-game`'s `js/game.js` calls `Track(S)` with the stage from `three-scenes`
and gets `{ P, N, W }`: `P` is `N` evenly spaced points round one closed
spline (road mesh, laps, grass and walls all read it), `W` the half road width.
Another world: move the spline's control points; road, kerbs, laps and walls
follow. Load it after `js/stage.js` and before `js/game.js`.

```js file=js/track.js
/* track.js: sky, a closed spline circuit with kerbs, start gantry, instanced trees. Needs stage.js. */
window.Track = function (S) {
  const { THREE: T, scene, renderer } = S;
  const V = (x = 0, y = 0, z = 0) => new T.Vector3(x, y, z), std = (o) => new T.MeshStandardMaterial(o);
  const tex = (w, h, draw, rep) => {   // canvas-drawn: no image files
    const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    if (rep) { t.wrapS = t.wrapT = T.RepeatWrapping; t.repeat.set(rep, rep); }
    return t;
  };
  const noise = (g, w, h, base, k, n) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < n; i++) { const l = (Math.random() - 0.5) * k; g.fillStyle = `rgba(${l > 0 ? '255,255,255' : '0,0,0'},${Math.abs(l)})`; g.fillRect(Math.random() * w, Math.random() * h, 2, 2); }
  };

  // Sky gradient + matching fog, hemisphere fill; the sun follows the car.
  scene.background = tex(4, 256, (g, w, h) => {
    const s = g.createLinearGradient(0, 0, 0, h); s.addColorStop(0, '#4f86c6'); s.addColorStop(0.62, '#a9c8e2'); s.addColorStop(1, '#dfe8ec');
    g.fillStyle = s; g.fillRect(0, 0, w, h);
  });
  scene.add(new T.HemisphereLight(0xcfe3ff, 0x4a6b35, 0.9));
  scene.environmentIntensity = 0.7;

  // TRACK: one closed spline sampled once; mesh, laps, grass and walls all read P[].
  const W = 7, N = 700;
  const P = new T.CatmullRomCurve3([[0, 0], [60, -10], [110, 30], [100, 95], [40, 120], [-20, 90], [-10, 45], [-70, 30], [-95, -30], [-40, -70]]
    .map(([x, z]) => V(x, 0, z)), true, 'centripetal').getSpacedPoints(N).slice(0, N);
  const side = P.map((p, i) => { const t = P[(i + 1) % N].clone().sub(P[(i + N - 1) % N]).normalize(); return V(-t.z, 0, t.x); });
  const strip = (a, b, y, vs) => { // ribbon between offsets a > b
    const pos = [], uv = [], idx = []; let d = 0;
    for (let i = 0; i <= N; i++) {
      const p = P[i % N], s = side[i % N]; if (i) d += p.distanceTo(P[i - 1]);
      pos.push(p.x + s.x * a, y, p.z + s.z * a, p.x + s.x * b, y, p.z + s.z * b); uv.push(0, d / vs, 1, d / vs);
      if (i < N) idx.push(2 * i, 2 * i + 2, 2 * i + 1, 2 * i + 1, 2 * i + 2, 2 * i + 3);
    }
    const g = new T.BufferGeometry(); g.setIndex(idx);
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals(); return g;
  };
  const ground = (g, map, y = 0) => { const m = new T.Mesh(g, std({ map, roughness: 0.85 })); m.position.y = y; m.receiveShadow = true; scene.add(m); return m; };
  const asphalt = tex(256, 512, (g, w, h) => { noise(g, w, h, '#34373c', 0.22, 9000); g.fillStyle = '#eae9e4'; g.fillRect(10, 0, 5, h); g.fillRect(w - 15, 0, 5, h); g.fillRect(w / 2 - 3, 0, 6, h * 0.45); });
  asphalt.wrapT = T.RepeatWrapping;
  ground(strip(W, -W, 0.02, 24), asphalt);
  const kerb = tex(8, 64, (g, w, h) => { g.fillStyle = '#f2f2ee'; g.fillRect(0, 0, w, h); g.fillStyle = '#d4252f'; g.fillRect(0, 0, w, h / 2); }, 1);
  ground(strip(W + 1.4, W, 0.05, 3), kerb); ground(strip(-W, -W - 1.4, 0.05, 3), kerb);
  ground(new T.PlaneGeometry(1400, 1400), tex(256, 256, (g, w, h) => noise(g, w, h, '#5f8a3e', 0.18, 14000), 140)).rotation.x = -Math.PI / 2;

  // Start gantry; instanced trees off the tarmac.
  const steel = std({ color: 0x2a2f36, roughness: 0.5, metalness: 0.6 });
  const flag = std({ map: tex(256, 32, (g) => { for (let i = 0; i < 32; i++) { g.fillStyle = (i + (i >> 4)) % 2 ? '#111' : '#f4f4f4'; g.fillRect((i % 16) * 16, (i >> 4) * 16, 16, 16); } }) });
  const gantry = new T.Group();
  for (const s of [-1, 1]) gantry.add(new T.Mesh(new T.BoxGeometry(0.5, 7, 0.5), steel).translateX(s * (W + 2)).translateY(3.5));
  gantry.add(new T.Mesh(new T.BoxGeometry(2 * W + 4.5, 1.4, 0.3), [steel, steel, steel, steel, flag, flag]).translateY(6.6));
  gantry.traverse((m) => (m.castShadow = true)); gantry.position.copy(P[0]); gantry.lookAt(P[1]); scene.add(gantry);
  const far = (x, z) => P.every((p, i) => i % 4 || (p.x - x) ** 2 + (p.z - z) ** 2 > (W + 7) ** 2);
  const trunks = new T.InstancedMesh(new T.CylinderGeometry(0.25, 0.35, 2, 6), std({ color: 0x5a4030 }), 420);
  const crowns = new T.InstancedMesh(new T.ConeGeometry(2.2, 6, 7), std({ flatShading: true }), 420);
  const m4 = new T.Matrix4(), q = new T.Quaternion(), up = V(0, 1, 0);
  for (let n = 0, k = 0; n < 420 && k < 6000; k++) {
    const x = (Math.random() - 0.4) * 420, z = (Math.random() - 0.4) * 420, s = 0.7 + Math.random() * 0.8;
    if (!far(x, z)) continue;
    q.setFromAxisAngle(up, Math.random() * 6.3);
    trunks.setMatrixAt(n, m4.compose(V(x, s, z), q, V(s, s, s))); crowns.setMatrixAt(n, m4.compose(V(x, s * 4.6, z), q, V(s, s, s)));
    crowns.setColorAt(n++, new T.Color().setHSL(0.26 + Math.random() * 0.06, 0.45, 0.2 + Math.random() * 0.1));
  }
  trunks.castShadow = crowns.castShadow = true; scene.add(trunks, crowns);
  return { P, N, W };
};
```
