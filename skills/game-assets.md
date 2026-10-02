---
name: game-assets
description: Real CC0 art and sound we host — pixel sprite sheets, low-poly 3D models (trees, coins, cars, a rigged person), sky lighting, textures and sound effects — with the exact URLs and the loading code that works under our policy
when: A game, a 3D scene or an app that should have real sprites, models, skies, textures or sounds instead of coloured boxes and beeps
---

# Real assets, hosted by us, free to ship

Everything under `/vendor/acuvo-cc0@1/` is **CC0 1.0** (Kenney, Poly Haven):
no credit owed, fine in a paid product. Copy a URL **exactly** — a wrong name
is a 404 that reads as "the game has no art". Only these files exist.

Three rules decide how each kind loads, because a published app cannot
`fetch` from `/vendor/`:

- **Images** (sprite sheets, textures, skies): an `Image`, an `<img>` or
  `THREE.TextureLoader` — all fine. ⚠️ Not Phaser's default loader (it uses
  XHR): build the texture from an `Image` yourself (below).
- **Sounds**: `new Audio(url)` or Howler with **`html5: true`**. Howler's
  default Web Audio path uses XHR and will be refused.
- **3D models are scripts**, not `.glb` files: each one is a `<script>` that
  puts base64 in `window.ACUVO_MODELS[name]`; parse it with
  `THREE.GLTFLoader().parse` (below). `GLTFLoader.load(url)` is refused.

## Sprites on a canvas (and on `game/kit.js`)

Sheets are packed square tiles with **no spacing**: frame `i` sits at column
`i % cols`, row `Math.floor(i / cols)`. Keep pixel art crisp.

```js
const sheet = new Image();
sheet.src = '/vendor/acuvo-cc0@1/sprites/platformer-tiles.png'; // 18px tiles, 20 columns
function tile(ctx, i, x, y, size, T = 18, cols = 20) {
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(sheet, (i % cols) * T, Math.floor(i / cols) * T, T, T, x, y, size, size);
}
// in GameKit.start({ draw(g) { tile(g.ctx, 0, 100, 400, 54); } })
```

Walk cycles in `platformer-characters.png` come in PAIRS (0-1, 2-3, …): swap
every ~150 ms while moving. Pick indices by LOOKING: draw the whole sheet
with each index written on its tile in a scratch page, screenshot it, choose.

**Phaser**: `const img = new Image(); img.onload = () => game.textures.addSpriteSheet('tiles', img, { frameWidth: 18, frameHeight: 18 }); img.src = URL;`
then `this.add.sprite(x, y, 'tiles', 12)`.

## Sounds

```js
const sfx = { click: new Audio('/vendor/acuvo-cc0@1/sfx/ui-click.mp3') };
function play(name) { const a = sfx[name].cloneNode(); a.volume = 0.5; a.play().catch(() => {}); }
// Howler: new Howl({ src: ['/vendor/acuvo-cc0@1/sfx/laser.mp3'], html5: true, volume: 0.4 })
```

Play after the first tap or key (browsers block sound before one). Ship a mute
toggle. No file at all? `jsfxr` synthesises retro sounds in the page
(`vendor-shelf`); a `game/kit.js` game already has it through `g.sfx`.

## 3D models (three r186)

Load three, then each model's script, then parse:

```html
<script src="/vendor/three@0.186.1/three.bundle.min.js"></script>
<script src="/vendor/acuvo-cc0@1/models/tree.js"></script>
<script src="/vendor/acuvo-cc0@1/models/coin.js"></script>
```

```js
function cc0Model(name) {
  const bin = Uint8Array.from(atob(window.ACUVO_MODELS[name]), (c) => c.charCodeAt(0));
  return new Promise((ok, fail) => new THREE.GLTFLoader().parse(bin.buffer, '', ok, fail));
}
const tree = (await cc0Model('tree')).scene;           // one unit ≈ one metre; scale to taste
tree.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
scene.add(tree);
const coin = (await cc0Model('coin')).scene;
for (let i = 0; i < 12; i++) { const c = coin.clone(); c.position.set(i * 2, 1, 0); scene.add(c); }
```

Colours are **vertex colours** (no texture to load): recolour by setting
`material.color`, which multiplies them. Many copies of one model →
`clone()` it (geometry is shared) or an `InstancedMesh` from its geometry.

**The rigged people** (`character`, `character-b`) carry animation clips:

```js
const gltf = await cc0Model('character');
const mixer = new THREE.AnimationMixer(gltf.scene);
const clip = (n) => mixer.clipAction(THREE.AnimationClip.findByName(gltf.animations, n));
clip('idle').play();                  // crossfade to 'walk' / 'sprint' when moving
// every frame: mixer.update(dt)
```

## Skies and textures

A sky is an equirectangular JPG: it lights the scene AND is the background.

```js
new THREE.TextureLoader().load('/vendor/acuvo-cc0@1/sky/sky-day.jpg', (t) => {
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  scene.background = t; scene.environment = t;
});
```

Textures are 512² tiling colour maps: `t.wrapS = t.wrapT = THREE.RepeatWrapping;
t.repeat.set(8, 8); t.colorSpace = THREE.SRGBColorSpace;` then
`new THREE.MeshStandardMaterial({ map: t })`. In CSS they are just
`background: url(/vendor/acuvo-cc0@1/textures/brick.jpg)`.

## Everything on the shelf

<!-- CC0-TABLE:START (generated from lib/cc0-assets.generated.ts by scripts/build-cc0-asset-shelf.mts — do not edit by hand) -->
**Sprite sheets**

- `/vendor/acuvo-cc0@1/sprites/platformer-tiles.png` — ground, bricks, ladders, spikes, coins, keys, flags, doors — 18px tiles, 20×9 (6 KB)
- `/vendor/acuvo-cc0@1/sprites/platformer-characters.png` — player and enemy frames in pairs (idle, walk) — 24px tiles, 9×3 (2 KB)
- `/vendor/acuvo-cc0@1/sprites/platformer-backgrounds.png` — sky, hills and cloud tiles to repeat behind a level — 24px tiles, 8×3 (1 KB)
- `/vendor/acuvo-cc0@1/sprites/dungeon-tiles.png` — top-down walls, floors, heroes, monsters, potions, chests, weapons — 16px tiles, 12×11 (5 KB)
- `/vendor/acuvo-cc0@1/sprites/shmup-ships.png` — player and enemy ships for a shooter — 32px tiles, 4×6 (2 KB)
- `/vendor/acuvo-cc0@1/sprites/shmup-tiles.png` — bullets, explosions, pickups and ground tiles — 16px tiles, 12×10 (4 KB)

**3D models (script per model)**

- `/vendor/acuvo-cc0@1/models/tree.js` — a round leafy tree (9 KB)
- `/vendor/acuvo-cc0@1/models/tree-pine.js` — a pine tree (16 KB)
- `/vendor/acuvo-cc0@1/models/rock.js` — a large rock (8 KB)
- `/vendor/acuvo-cc0@1/models/bush.js` — a bush (4 KB)
- `/vendor/acuvo-cc0@1/models/flower.js` — a red flower (7 KB)
- `/vendor/acuvo-cc0@1/models/coin.js` — a gold coin to spin and collect (11 KB)
- `/vendor/acuvo-cc0@1/models/heart.js` — a heart pickup (6 KB)
- `/vendor/acuvo-cc0@1/models/star.js` — a star pickup (6 KB)
- `/vendor/acuvo-cc0@1/models/jewel.js` — a jewel pickup (3 KB)
- `/vendor/acuvo-cc0@1/models/key.js` — a key (13 KB)
- `/vendor/acuvo-cc0@1/models/chest.js` — a treasure chest — clips: open, close, open-close (23 KB)
- `/vendor/acuvo-cc0@1/models/crate.js` — a wooden crate (15 KB)
- `/vendor/acuvo-cc0@1/models/barrel.js` — a barrel (13 KB)
- `/vendor/acuvo-cc0@1/models/flag.js` — a goal flag (11 KB)
- `/vendor/acuvo-cc0@1/models/spikes.js` — a spike trap — clips: show, hide, show-hide (19 KB)
- `/vendor/acuvo-cc0@1/models/platform.js` — a floating platform (10 KB)
- `/vendor/acuvo-cc0@1/models/car-race.js` — a race car (wheels are separate nodes) (81 KB)
- `/vendor/acuvo-cc0@1/models/car-sedan.js` — a family car (wheels are separate nodes) (98 KB)
- `/vendor/acuvo-cc0@1/models/character.js` — a rigged person — clips: static, idle, walk, sprint, jump, fall, crouch, sit, drive, die, pick-up, emote-yes … (32 in all: `gltf.animations`) (162 KB)
- `/vendor/acuvo-cc0@1/models/character-b.js` — a rigged person — clips: static, idle, walk, sprint, jump, fall, crouch, sit, drive, die, pick-up, emote-yes … (32 in all: `gltf.animations`) (182 KB)

**Skies**

- `/vendor/acuvo-cc0@1/sky/studio.jpg` — soft studio light for a product on a turntable (117 KB)
- `/vendor/acuvo-cc0@1/sky/sky-day.jpg` — open blue sky with clouds, no ground (81 KB)
- `/vendor/acuvo-cc0@1/sky/sunset.jpg` — warm low sun over a city (178 KB)

**Textures**

- `/vendor/acuvo-cc0@1/textures/wood-floor.jpg` — decking planks — tiling colour map (38 KB)
- `/vendor/acuvo-cc0@1/textures/planks.jpg` — rough brown planks — tiling colour map (39 KB)
- `/vendor/acuvo-cc0@1/textures/brick.jpg` — red brick wall — tiling colour map (42 KB)
- `/vendor/acuvo-cc0@1/textures/concrete.jpg` — concrete floor — tiling colour map (54 KB)
- `/vendor/acuvo-cc0@1/textures/grass-rock.jpg` — grass and rock ground seen from above — tiling colour map (38 KB)

**Sounds**

- `/vendor/acuvo-cc0@1/sfx/ui-click.mp3` — a button press (1 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-select.mp3` — choosing an option (1 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-toggle.mp3` — a switch flipping (2 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-confirm.mp3` — success, saved, done (3 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-error.mp3` — a refusal or wrong answer (1 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-open.mp3` — a panel or menu opening (2 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-close.mp3` — a panel or menu closing (2 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-drop.mp3` — dropping a card or tile (2 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-tick.mp3` — a timer tick (1 KB)
- `/vendor/acuvo-cc0@1/sfx/ui-bong.mp3` — a timer finishing, a notification (1 KB)
- `/vendor/acuvo-cc0@1/sfx/laser.mp3` — a shot (9 KB)
- `/vendor/acuvo-cc0@1/sfx/laser-heavy.mp3` — a heavy shot (8 KB)
- `/vendor/acuvo-cc0@1/sfx/zap.mp3` — an electric hit (8 KB)
- `/vendor/acuvo-cc0@1/sfx/power-up.mp3` — a power-up or level up (9 KB)
- `/vendor/acuvo-cc0@1/sfx/pickup.mp3` — collecting a coin or item (5 KB)
- `/vendor/acuvo-cc0@1/sfx/jump.mp3` — a jump (4 KB)
- `/vendor/acuvo-cc0@1/sfx/win.mp3` — level complete (7 KB)
- `/vendor/acuvo-cc0@1/sfx/lose.mp3` — game over (7 KB)
- `/vendor/acuvo-cc0@1/sfx/hit.mp3` — a punch or a body hit (4 KB)
- `/vendor/acuvo-cc0@1/sfx/hit-heavy.mp3` — a heavy hit (6 KB)
- `/vendor/acuvo-cc0@1/sfx/metal.mp3` — metal clang (3 KB)
- `/vendor/acuvo-cc0@1/sfx/wood.mp3` — wood knock (3 KB)
- `/vendor/acuvo-cc0@1/sfx/glass.mp3` — glass clink (2 KB)
- `/vendor/acuvo-cc0@1/sfx/footstep-grass.mp3` — a footstep on grass (7 KB)
- `/vendor/acuvo-cc0@1/sfx/footstep-wood.mp3` — a footstep on wood (3 KB)
<!-- CC0-TABLE:END -->
