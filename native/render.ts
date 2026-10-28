// The garden course on starhermit:scene, as the browser build's render.js
// drew it with three.js r185: the green (mowing stripes on Detailed), the
// rough surround, wooden rails (with lighter cap strips), stone drums with
// mossy planter crowns, sand traps, translucent water (rippled and
// reflective on Detailed), banded keepers (movers) placed from the
// simulation tick, the cup with its liner, a waving flag, the balls, the aim
// arrow coloured by power and the ring under the ball to play, splash and
// bounce particle bursts, and on Detailed the garden around the rails
// (lawn fading into the sky's fog, hedges, flower borders, grass tufts,
// corner trees, stepping stones, drifting pollen). The theme sets the
// colours; the graphics level (quality.ts) sets the look: materials, texture
// size and foliage budgets, shadows, reflections (a RoomEnvironment), post
// effects (renderer.ao / bloom / grade / antialias replace the old
// EffectComposer chain) and particle budgets. Reduced motion stills the
// water, flag and pollen; high contrast (or a colour-vision palette) paints
// the flag yellow and the aim arrow white and drops the vignette.
//
// The course shows in a rectangle of the window (the old canvas under the
// status bar; the full window behind the menus): the camera's view offset
// puts the image the camera would fill exactly there, framed by the old
// fitDistance (the long axis turned down the screen on portrait views).
// Light intensities are the old r185 values ÷ π (the engine's punctual
// lights use three's legacy scale).
import {
  ACESFilmicToneMapping, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry, CylinderGeometry,
  DirectionalLight, DodecahedronGeometry, DoubleSide, Fog, Group, HemisphereLight, IcosahedronGeometry, InstancedMesh, Line,
  LineBasicMaterial, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial, MeshStandardMaterial, Object3D,
  PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, RepeatWrapping, RingGeometry,
  RoomEnvironment, SRGBColorSpace, SphereGeometry, Vector2, Vector3, renderer, scene, type Material, type Texture,
} from "starhermit:scene";
import { ImageData, OffscreenCanvas } from "starhermit:canvas";
import { Rules, type Course, type State, type Theme } from "./classic.ts";
import { POLLEN_MAX, SPARK_MAX, type Look } from "./quality.ts";

const PI = Math.PI;
const CAM = { elevationDeg: 52, fov: 42, margin: 1.5 };
const KEY_OFFSET = [6, 12, 4] as const;
const SURROUND = 1.5;
export const PLAYER_COLORS = [0xf5f6fa, 0xf2c14e, 0x7ec8e3, 0xe08ab8];

const camera = new PerspectiveCamera(CAM.fov, 1, 0.1, 200);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.camera = null;

let look: Look | null = null;
let highContrast = false;
let reducedMotion = false;
let course: Course | null = null;
let theme: Theme | null = null;
let azimuth = 0;

// ---------------------------------------------------------------- procedural textures (cached)
const texCache = new Map<string, Texture>();
function canvasTex(key: string, size: number, paint: (d: Uint8ClampedArray, n: number) => void, linear = false): Texture {
  const hit = texCache.get(key);
  if (hit) return hit;
  const data = new Uint8ClampedArray(size * size * 4);
  paint(data, size);
  let c = new OffscreenCanvas(size, size);
  c.getContext("2d").putImageData(new ImageData(data, size, size), 0, 0);
  // painted at the authored size (the tileable noise depends on it), then resampled to the level's texScale
  const k = look?.budget.texScale ?? 1;
  if (k !== 1) {
    const n = Math.max(16, Math.round(size * k));
    const out = new OffscreenCanvas(n, n);
    out.getContext("2d").drawImage(c, 0, 0, n, n);
    c = out;
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  if (!linear) t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}
function valueNoise(seed: number, period: number): (x: number, y: number) => number {
  const rnd = Rules.mulberry32(seed);
  const g: number[] = [];
  for (let i = 0; i < period * period; i++) g.push(rnd());
  const at = (x: number, y: number): number => g[(((y % period) + period) % period) * period + (((x % period) + period) % period)]!;
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function grey(d: Uint8ClampedArray, i: number, v: number): void { d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
function mowTex(): Texture {
  return canvasTex("mow", 256, (d, n) => {
    const nz = valueNoise(11, 32), fine = Rules.mulberry32(5);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const band = Math.floor(x / 32) % 2 ? 236 : 255;
      grey(d, (y * n + x) * 4, band - 10 + nz(x / 8, y / 8) * 14 - fine() * 12);
    }
  });
}
function noiseTex(key: string, seed: number, lo: number, hi: number, scale: number): Texture {
  return canvasTex(key, 128, (d, n) => {
    const nz = valueNoise(seed, 16), fine = Rules.mulberry32(seed + 1);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const v = nz(x / scale, y / scale) * 0.7 + fine() * 0.3;
      grey(d, (y * n + x) * 4, lo + (hi - lo) * v);
    }
  });
}
function grainTex(): Texture {
  return canvasTex("grain", 128, (d, n) => {
    const nz = valueNoise(23, 16);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const w = Math.sin((y + nz(x / 16, y / 4) * 10) * 0.9) * 0.5 + 0.5;
      grey(d, (y * n + x) * 4, 206 + w * 40 + nz(x / 4, y / 2) * 9);
    }
  });
}
function waterNormalTex(): Texture {
  return canvasTex("waterN", 128, (d, n) => {
    const H = (x: number, y: number): number => {
      const u = (x / n) * PI * 2, v = (y / n) * PI * 2;
      return Math.sin(u * 3 + v * 2) * 0.5 + Math.sin(u * 5 - v * 4 + 1.3) * 0.3 + Math.sin(-u * 2 + v * 7 + 2.1) * 0.2;
    };
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2, dy = (H(x, y + 1) - H(x, y - 1)) * 2.2;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (-dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  }, true);
}
function dotTex(): Texture {
  return canvasTex("dot", 32, (d, n) => {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
      const i = (y * n + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = Math.max(0, 1 - r * r) * 255;
    }
  });
}
function scaleUV(geo: BufferGeometry, sx: number, sy: number): BufferGeometry {
  const uv = geo.getAttribute("uv") as BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
  uv.needsUpdate = true;
  return geo;
}

// ---------------------------------------------------------------- materials
interface MatParams {
  color?: number | Color; map?: Texture | null; roughness?: number; metalness?: number; transparent?: boolean; opacity?: number;
  normalMap?: Texture; normalScale?: Vector2; flatShading?: boolean;
}
/** Course surfaces: Lambert on Low (no roughness/metalness), standard otherwise. */
function stdMat(p: MatParams): Material {
  const base = {
    color: p.color ?? 0xffffff, map: p.map ?? null,
    ...(p.transparent ? { transparent: true, opacity: p.opacity ?? 1 } : {}),
    ...(p.flatShading ? { flatShading: true } : {}),
  };
  if (look?.budget.material === "lambert") return new MeshLambertMaterial(base);
  return new MeshStandardMaterial({
    ...base, roughness: p.roughness ?? 1, metalness: p.metalness ?? 0,
    ...(p.normalMap ? { normalMap: p.normalMap, normalScale: p.normalScale ?? new Vector2(1, 1) } : {}),
  });
}

// ---------------------------------------------------------------- lights, pooled effects, aim
const keyLight = new DirectionalLight(0xfff1d6, 1.7 / PI);
keyLight.shadow.bias = -0.0004;
keyLight.shadow.normalBias = 1;
const fill = new HemisphereLight(0xd6e8ff, 0x3a4a2c, 0.55 / PI);
scene.add(keyLight, keyLight.target, fill);

interface Particle { life: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
const particlePos = new Float32Array(SPARK_MAX * 3);
const pgeo = new BufferGeometry();
pgeo.setAttribute("position", new BufferAttribute(particlePos, 3));
const pmat = new PointsMaterial({ color: 0xffffff, size: 0.12, map: dotTex(), transparent: true, opacity: 0.9, depthWrite: false });
const particles = new Points(pgeo, pmat);
particles.frustumCulled = false;
scene.add(particles);
const particleData: Particle[] = [];
for (let i = 0; i < SPARK_MAX; i++) { particleData.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }); particlePos[i * 3 + 1] = -10; }
let particleCursor = 0;
let particleBudget = 64;

const aimGeo = new BufferGeometry();
const aimPos = new Float32Array(6);
aimGeo.setAttribute("position", new BufferAttribute(aimPos, 3));
const aimMat = new LineBasicMaterial({ color: 0xffffff });
const aimArrow = new Line(aimGeo, aimMat);
aimArrow.visible = false;
scene.add(aimArrow);

const marker = new Mesh(new RingGeometry(0.26, 0.34, 32), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: DoubleSide }));
marker.rotation.x = -PI / 2;
marker.visible = false;
scene.add(marker);

let envTex: Texture | null = null;
function ensureEnv(): Texture | null {
  if (envTex) return envTex;
  try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
  catch (e) { console.warn("environment:", e instanceof Error ? e.message : String(e)); }
  return envTex;
}

// ---------------------------------------------------------------- the course
let courseGroup: Group | null = null;
let flag: Mesh | null = null;
let flagBase: Float32Array | null = null;
let pollen: Points | null = null;
let pollenSeed: number[][] = [];
let movers: { def: Course["movers"][number]; mesh: Mesh }[] = [];
let waterMats: Material[] = [];
const ballMeshes = new Map<string, Mesh>();

function disposeObject(o: Object3D): void {
  const m = o as Mesh;
  if (m.geometry) m.geometry.dispose();
  if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x: Material) => x.dispose());
  for (const c of o.children) disposeObject(c);
}
function disposeCourse(): void {
  if (courseGroup) { scene.remove(courseGroup); disposeObject(courseGroup); }
  courseGroup = null;
  flag = null; flagBase = null; pollen = null; movers = []; waterMats = [];
  scene.fog = null;
  for (const m of ballMeshes.values()) { scene.remove(m); m.geometry.dispose(); (m.material as Material).dispose(); }
  ballMeshes.clear();
}

function buildCourse(): void {
  disposeCourse();
  if (!course || !theme || !look) return;
  const c = course, P = theme.palette;
  const detailed = look.detailed;
  const g = new Group();
  scene.background = new Color(P.sky);
  const cx = c.w / 2, cz = c.h / 2;
  const add = (m: Mesh, cast = false, receive = false): Mesh => { m.castShadow = cast; m.receiveShadow = receive; g.add(m); return m; };

  const greenGeo = new BoxGeometry(c.w, 0.3, c.h);
  if (detailed) scaleUV(greenGeo, c.w / 8, c.h / 8);
  add(new Mesh(greenGeo, stdMat({ color: P.green, roughness: 0.95, map: detailed ? mowTex() : null })), false, true).position.set(cx, -0.15, cz);
  const roughGeo = new BoxGeometry(c.w + SURROUND * 2, 0.2, c.h + SURROUND * 2);
  if (detailed) scaleUV(roughGeo, (c.w + 3) / 3, (c.h + 3) / 3);
  add(new Mesh(roughGeo, stdMat({ color: P.rough, roughness: 1, map: detailed ? noiseTex("rough", 31, 205, 255, 3) : null })), false, true).position.set(cx, -0.32, cz);

  const wood = detailed ? grainTex() : null;
  const wallMat = stdMat({ color: P.wall, roughness: 0.8, map: wood });
  const capMat = detailed ? stdMat({ color: new Color(P.wall).lerp(new Color(0xffffff), 0.28), roughness: 0.55, map: wood }) : null;
  const railH = 0.34, railT = 0.28;
  const addWall = (x: number, z: number, w: number, d: number): void => {
    const geo = new BoxGeometry(w, railH, d);
    if (detailed) scaleUV(geo, Math.max(1, w / 2), 1);
    add(new Mesh(geo, wallMat), true, true).position.set(x, railH / 2, z);
    if (capMat) add(new Mesh(new BoxGeometry(w + 0.02, 0.04, d + 0.02), capMat), false, true).position.set(x, railH + 0.02, z);
  };
  for (const b of [[cx, -railT / 2, c.w + railT * 2, railT], [cx, c.h + railT / 2, c.w + railT * 2, railT], [-railT / 2, cz, railT, c.h], [c.w + railT / 2, cz, railT, c.h]] as const) addWall(b[0], b[1], b[2], b[3]);
  for (const w of c.walls) addWall(w.x + w.w! / 2, w.y + w.h! / 2, w.w!, w.h!);

  const obMat = stdMat({ color: P.obstacle, roughness: 0.7, map: detailed ? noiseTex("stone", 41, 200, 255, 4) : null });
  for (const o of c.obstacles) {
    if (o.type === "circle") {
      const r = o.r!;
      add(new Mesh(new CylinderGeometry(r, r * 1.1, 0.5, detailed ? 36 : 20), obMat), true, true).position.set(o.x, 0.25, o.y);
      if (detailed) {
        const crown = add(new Mesh(new SphereGeometry(r * 0.82, 20, 10, 0, PI * 2, 0, PI / 2),
          stdMat({ color: new Color(P.rough).multiplyScalar(0.8), roughness: 1, map: noiseTex("rough", 31, 205, 255, 3) })), true);
        crown.scale.y = 0.55;
        crown.position.set(o.x, 0.5, o.y);
      }
    } else add(new Mesh(new BoxGeometry(o.w!, 0.45, o.h!), obMat), true, true).position.set(o.x + o.w! / 2, 0.225, o.y + o.h! / 2);
  }

  for (const z of c.water) {
    const w = z.w ?? z.r! * 2, h = z.h ?? z.r! * 2;
    const wx = z.type === "circle" ? z.x : z.x + w / 2, wz = z.type === "circle" ? z.y : z.y + h / 2;
    const mat = detailed
      ? stdMat({ color: new Color(P.water).lerp(new Color(0x9fd8ff), 0.18), transparent: true, opacity: 0.86, roughness: 0.08, metalness: 0.2, normalMap: waterNormalTex(), normalScale: new Vector2(0.35, 0.35) })
      : stdMat({ color: P.water, transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0.35 });
    const geo = z.type === "circle" ? new CylinderGeometry(z.r!, z.r!, 0.08, 40) : new BoxGeometry(w, 0.08, h);
    if (detailed && z.type !== "circle") scaleUV(geo, w / 2, h / 2);
    add(new Mesh(geo, mat)).position.set(wx, -0.02, wz);
    waterMats.push(mat);
  }

  const sandMat = stdMat({ color: P.sand, roughness: 1, map: detailed ? noiseTex("sand", 53, 215, 255, 1.5) : null });
  for (const z of c.sand) {
    const w = z.w ?? z.r! * 2, h = z.h ?? z.r! * 2;
    const geo = z.type === "circle" ? new CylinderGeometry(z.r!, z.r!, 0.06, 40) : new BoxGeometry(w, 0.06, h);
    add(new Mesh(geo, sandMat), false, true).position.set(z.type === "circle" ? z.x : z.x + w / 2, 0.01, z.type === "circle" ? z.y : z.y + h / 2);
  }

  const mvMat = stdMat({ color: P.mover, roughness: 0.5 });
  const bandMat = detailed ? stdMat({ color: 0xf4efe2, roughness: 0.4 }) : null;
  for (const mv of c.movers) {
    const m = add(new Mesh(new CylinderGeometry(mv.r, mv.r, 0.7, detailed ? 32 : 18), mvMat), true);
    if (bandMat) {
      const band = new Mesh(new CylinderGeometry(mv.r * 1.02, mv.r * 1.02, 0.12, 32), bandMat);
      band.position.y = 0.16;
      m.add(band);
    }
    movers.push({ def: mv, mesh: m });
  }

  add(new Mesh(new CylinderGeometry(Rules.CUP_R, Rules.CUP_R, 0.05, 32), stdMat({ color: P.cup, roughness: 0.9 }))).position.set(c.cup.x, 0.03, c.cup.y);
  if (detailed) {
    const liner = add(new Mesh(new RingGeometry(Rules.CUP_R * 0.84, Rules.CUP_R, 40), stdMat({ color: 0xf2f2ee, roughness: 0.4 })));
    liner.rotation.x = -PI / 2;
    liner.position.set(c.cup.x, 0.057, c.cup.y);
  }
  const pole = add(new Mesh(new CylinderGeometry(0.02, 0.02, 1.1, 8), detailed ? stdMat({ color: 0xf0f0f0, roughness: 0.25, metalness: 0.6 }) : stdMat({ color: 0xf0f0f0 })), detailed);
  pole.position.set(c.cup.x, 0.55, c.cup.y);
  const flagGeo = new PlaneGeometry(0.42, 0.26, detailed ? 10 : 1, 1);
  flag = add(new Mesh(flagGeo, new MeshBasicMaterial({ color: highContrast ? 0xffff00 : 0xe64545, side: DoubleSide })));
  if (detailed) flagBase = Float32Array.from((flagGeo.getAttribute("position") as BufferAttribute).array as Float32Array);

  if (detailed) buildGarden(g, c, P);
  courseGroup = g;
  scene.add(g);
  fitShadow();
  frameCamera();
  applyEnvironment();
}

function buildGarden(g: Group, c: Course, P: Theme["palette"]): void {
  const b = look!.budget;
  const rnd = Rules.mulberry32(Rules.hashStr(String(c.id || "course")));
  const cx = c.w / 2;
  const lawnGeo = scaleUV(new PlaneGeometry(c.w + 80, c.h + 80), (c.w + 80) / 4, (c.h + 80) / 4);
  const lawn = new Mesh(lawnGeo, stdMat({ color: new Color(P.rough).multiplyScalar(0.68), roughness: 1, map: noiseTex("rough", 31, 205, 255, 3) }));
  lawn.rotation.x = -PI / 2;
  lawn.position.set(cx, -0.42, c.h / 2);
  lawn.receiveShadow = true;
  g.add(lawn);

  const dummy = new Object3D();
  const col = new Color();
  const off = SURROUND + 0.55;
  const spots: [number, number][] = [];
  const perim = (x0: number, z0: number, x1: number, z1: number): void => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(2, Math.round(len / 0.75));
    for (let i = 0; i <= n; i++) spots.push([x0 + ((x1 - x0) * i) / n, z0 + ((z1 - z0) * i) / n]);
  };
  perim(-off, -off, c.w + off, -off); perim(c.w + off, -off, c.w + off, c.h + off);
  perim(c.w + off, c.h + off, -off, c.h + off); perim(-off, c.h + off, -off, -off);
  const hedgeCol = new Color(P.rough).multiplyScalar(0.55);
  const hedges = new InstancedMesh(new IcosahedronGeometry(1, b.hedge), stdMat({ color: 0xffffff, roughness: 0.95, map: noiseTex("leaf", 61, 150, 255, 1.2) }), spots.length);
  spots.forEach((s, i) => {
    const r = 0.42 + rnd() * 0.18;
    dummy.position.set(s[0] + (rnd() - 0.5) * 0.2, -0.3 + r * 0.6, s[1] + (rnd() - 0.5) * 0.2);
    dummy.scale.set(r, r * (0.8 + rnd() * 0.25), r);
    dummy.rotation.set(0, rnd() * 6.28, 0);
    dummy.updateMatrix();
    hedges.setMatrixAt(i, dummy.matrix);
    hedges.setColorAt(i, col.copy(hedgeCol).multiplyScalar(0.85 + rnd() * 0.3));
  });
  hedges.castShadow = true; hedges.receiveShadow = true;
  g.add(hedges);

  const petals = [0xf7a8c4, 0xffe27a, 0xffffff, 0xc9a7f0, 0xff9d6e];
  const flowerSpots: [number, number][] = [];
  for (let i = 0; i < Math.round((c.w + c.h) * 5 * b.foliage); i++) {
    const t = rnd(), side = Math.floor(rnd() * 4), band = 0.45 + rnd() * (SURROUND - 0.55);
    let x: number, z: number;
    if (side === 0) { x = -SURROUND + t * (c.w + SURROUND * 2); z = -band; }
    else if (side === 1) { x = -SURROUND + t * (c.w + SURROUND * 2); z = c.h + band; }
    else if (side === 2) { x = -band; z = -SURROUND + t * (c.h + SURROUND * 2); }
    else { x = c.w + band; z = -SURROUND + t * (c.h + SURROUND * 2); }
    flowerSpots.push([x, z]);
  }
  const flowers = new InstancedMesh(new IcosahedronGeometry(0.07, 0), stdMat({ color: 0xffffff, roughness: 0.6 }), flowerSpots.length);
  flowerSpots.forEach((s, i) => {
    dummy.position.set(s[0], -0.18 + rnd() * 0.08, s[1]);
    const k = 0.8 + rnd() * 0.6;
    dummy.scale.set(k, k * 0.7, k);
    dummy.rotation.set(rnd(), rnd() * 6.28, 0);
    dummy.updateMatrix();
    flowers.setMatrixAt(i, dummy.matrix);
    flowers.setColorAt(i, col.setHex(petals[Math.floor(rnd() * petals.length)]!));
  });
  g.add(flowers);

  const tuftN = Math.round((c.w + c.h) * 6 * b.foliage);
  const tufts = new InstancedMesh(new ConeGeometry(0.035, 0.22, 4), stdMat({ color: 0xffffff, roughness: 1 }), tuftN);
  const tuftCol = new Color(P.rough);
  for (let i = 0; i < tuftN; i++) {
    const s = flowerSpots[i % flowerSpots.length]!;
    dummy.position.set(s[0] + (rnd() - 0.5) * 0.5, -0.14, s[1] + (rnd() - 0.5) * 0.5);
    dummy.scale.setScalar(0.7 + rnd() * 0.6);
    dummy.rotation.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5);
    dummy.updateMatrix();
    tufts.setMatrixAt(i, dummy.matrix);
    tufts.setColorAt(i, col.copy(tuftCol).multiplyScalar(0.75 + rnd() * 0.4));
  }
  g.add(tufts);

  const trunkMat = stdMat({ color: 0x6b4a33, roughness: 0.9, map: grainTex() });
  const canopyMat = stdMat({ color: new Color(P.rough).multiplyScalar(0.62), roughness: 0.9, map: noiseTex("leaf", 61, 150, 255, 1.2), flatShading: true });
  const toff = off + 2.2;
  for (const p of [[-toff, -toff], [c.w + toff, -toff], [-toff, c.h + toff], [c.w + toff, c.h + toff]] as const) {
    const h = 1.6 + rnd() * 0.8;
    const trunk = new Mesh(new CylinderGeometry(0.12, 0.18, h, 8), trunkMat);
    trunk.position.set(p[0], -0.42 + h / 2, p[1]);
    const canopy = new Mesh(new IcosahedronGeometry(1.1 + rnd() * 0.4, 1), canopyMat);
    canopy.position.set(p[0], -0.42 + h + 0.6, p[1]);
    g.add(trunk, canopy);
  }

  const stones = new InstancedMesh(new DodecahedronGeometry(0.22, 0), stdMat({ color: 0xb8b2a6, roughness: 0.85, map: noiseTex("stone", 41, 200, 255, 4) }), 10);
  for (let i = 0; i < 10; i++) {
    const side = i % 2 ? -1 : 1;
    dummy.position.set(cx + (rnd() - 0.5) * c.w * 1.2, -0.42, side > 0 ? c.h + off + 1 + rnd() * 1.5 : -off - 1 - rnd() * 1.5);
    dummy.scale.set(1 + rnd() * 0.6, 0.35, 1 + rnd() * 0.4);
    dummy.rotation.set(0, rnd() * 6.28, 0);
    dummy.updateMatrix();
    stones.setMatrixAt(i, dummy.matrix);
  }
  stones.receiveShadow = true;
  g.add(stones);

  const n = Math.min(POLLEN_MAX, b.pollen);
  pollenSeed = [];
  for (let i = 0; i < n; i++) pollenSeed.push([rnd() * (c.w + 4) - 2, 0.3 + rnd() * 1.4, rnd() * (c.h + 4) - 2, rnd() * 6.28]);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(new Float32Array(n * 3), 3));
  pollen = new Points(geo, new PointsMaterial({ color: 0xffe9a8, size: 0.05, map: dotTex(), transparent: true, opacity: 0.55, depthWrite: false }));
  pollen.frustumCulled = false;
  g.add(pollen);
  updatePollen(0);
}

function updatePollen(t: number): void {
  const p = pollen;
  if (!p) return;
  p.visible = look?.particles === "high" && !reducedMotion;
  if (!p.visible) return;
  const attr = p.geometry.getAttribute("position") as BufferAttribute;
  const arr = attr.array as Float32Array;
  for (let i = 0; i < pollenSeed.length; i++) {
    const s = pollenSeed[i]!;
    const a = s[3]! + t * 0.00035;
    arr[i * 3] = s[0]! + Math.sin(a * 1.3) * 0.6;
    arr[i * 3 + 1] = s[1]! + Math.sin(a * 2.1) * 0.15;
    arr[i * 3 + 2] = s[2]! + Math.cos(a) * 0.6;
  }
  attr.needsUpdate = true;
}

function fitShadow(): void {
  if (!course) return;
  const cx = course.w / 2, cz = course.h / 2;
  keyLight.position.set(cx + KEY_OFFSET[0], KEY_OFFSET[1], cz + KEY_OFFSET[2]);
  keyLight.target.position.set(cx, 0, cz);
  keyLight.target.updateMatrixWorld();
  keyLight.shadow.distance = Math.hypot(KEY_OFFSET[0], KEY_OFFSET[1], KEY_OFFSET[2]) + (Math.hypot(course.w, course.h) / 2 + SURROUND + 1) * 2;
}

function ballMesh(id: string, color: number): Mesh {
  let m = ballMeshes.get(id);
  if (m) return m;
  const detailed = !!look?.detailed;
  m = new Mesh(
    new SphereGeometry(Rules.BALL_R, detailed ? 32 : 24, detailed ? 24 : 18),
    detailed && look?.budget.material === "physical"
      ? new MeshPhysicalMaterial({ color, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.12 })
      : stdMat({ color, roughness: 0.35 }),
  );
  m.castShadow = true;
  scene.add(m);
  ballMeshes.set(id, m);
  return m;
}

// ---------------------------------------------------------------- camera and view
function fitDistance(spanX: number, spanZ: number, aspect: number): number {
  const vFov = (CAM.fov * PI) / 180, el = (CAM.elevationDeg * PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  return Math.max((spanX * CAM.margin) / (2 * Math.tan(hFov / 2)), (spanZ * CAM.margin * Math.sin(el)) / (2 * Math.tan(vFov / 2)));
}
let aspect = 1.6;
let camDist = 20;
function frameCamera(): void {
  if (!course) return;
  const cx = course.w / 2, cz = course.h / 2;
  const el = (CAM.elevationDeg * PI) / 180;
  const flat = fitDistance(course.w, course.h, aspect);
  const turned = fitDistance(course.h, course.w, aspect);
  azimuth = turned < flat * 0.95 ? PI / 2 : 0;
  const dist = azimuth ? turned : flat;
  camDist = dist;
  const horiz = Math.cos(el) * dist;
  camera.position.set(cx + Math.sin(azimuth) * horiz, Math.sin(el) * dist, cz + Math.cos(azimuth) * horiz);
  camera.lookAt(cx, 0, cz);
  if (flag) {
    flag.rotation.y = azimuth;
    flag.position.set(course.cup.x + 0.21 * Math.cos(azimuth), 0.95, course.cup.y - 0.21 * Math.sin(azimuth));
  }
  if (look?.detailed && theme) {
    const diag = Math.hypot(course.w, course.h);
    scene.fog = new Fog(theme.palette.sky, dist + diag * 0.6, dist + diag * 2.6);
  } else scene.fog = null;
}
/** Re-frames the course (the camera key). */
export function resetCamera(): void { frameCamera(); }

let view: { x: number; y: number; w: number; h: number } | null = null;
let win = { w: 0, h: 0 };
/** Where the course shows (window pixels), or null: nothing 3D drawn. */
export function setView(rect: { x: number; y: number; w: number; h: number } | null, winW: number, winH: number): void {
  if (!rect || rect.w < 2 || rect.h < 2) { view = null; renderer.camera = null; return; }
  renderer.camera = camera;
  if (view && view.x === rect.x && view.y === rect.y && view.w === rect.w && view.h === rect.h && win.w === winW && win.h === winH) return;
  view = { ...rect };
  win = { w: winW, h: winH };
  camera.setViewOffset(rect.w, rect.h, -rect.x, -rect.y, winW, winH);
  aspect = rect.w / rect.h;
  camera.aspect = aspect;
  camera.updateProjectionMatrix();
  frameCamera();
}

/** A screen-space drag (logical px) → course-space delta, undoing the camera's elevation and quarter turn. */
export function courseDelta(px: number, py: number): { x: number; y: number } {
  const el = (CAM.elevationDeg * PI) / 180;
  const sx = px, sy = py / Math.sin(el);
  const c = Math.cos(azimuth), s = Math.sin(azimuth);
  return { x: sx * c + sy * s, y: -sx * s + sy * c };
}
/** Window pixel position of a course point (for the screen-reader target of the ball). */
export function project(x: number, y: number): { x: number; y: number } | null {
  if (!view) return null;
  const v = new Vector3(x, 0, y).project(camera);
  return { x: view.x + ((v.x + 1) / 2) * view.w, y: view.y + ((1 - v.y) / 2) * view.h };
}

// ---------------------------------------------------------------- the look
function applyEnvironment(): void {
  const on = !!look?.reflections;
  scene.environment = on ? ensureEnv() : null;
  scene.environmentIntensity = 0.45;
  fill.intensity = (on && envTex ? 0.38 : 0.55) / PI;
}
function applyPost(): void {
  if (!look) return;
  const size = look.shadows;
  renderer.shadowMap.enabled = size > 0;
  keyLight.castShadow = size > 0;
  if (size > 0) keyLight.shadow.mapSize = size;
  const hi = look.ao === "high";
  renderer.ao = look.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: hi ? 16 : 8, resolution: look.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8, radiusExponent: 2 },
  };
  // high threshold: only specular glints, the selection ring and bright highlights bloom
  renderer.bloom = look.bloom ? { strength: 0.4, radius: 0.45, threshold: 0.9, resolution: look.budget.bloomRes } : null;
  // the old grade pass in display space: a 0.22 S-curve, +10 % saturation, warm highlights / cool shadows, the 0.2 vignette
  renderer.grade = look.grade ? {
    space: "display", contrast: 0.11, saturation: 1.1,
    shadows: [0.97, 0.99, 1.04], highlights: [1.04, 1.01, 0.95], split: [0.2, 0.85],
    vignette: { amount: highContrast ? 0 : 0.2, inner: 0.4, outer: 0.9 },
  } : null;
  renderer.antialias = look.antialias;
}
export function applyLook(next: Look): void {
  const prev = look;
  if (prev && JSON.stringify(prev) === JSON.stringify(next)) return;
  look = next;
  if (prev && prev.budget.texScale !== next.budget.texScale) {
    for (const [k, t] of texCache) { if (k !== "dot") { t.dispose(); texCache.delete(k); } }
  }
  if (particleBudget !== next.particleBudget) {
    for (let i = 0; i < SPARK_MAX; i++) { particleData[i]!.life = 0; particlePos[i * 3 + 1] = -10; }
    particleCursor = 0;
    (pgeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
    particleBudget = next.particleBudget;
  }
  applyPost();
  buildCourse();
  if (lastState) applySnapshot(lastState);
}
/** The course and its theme (rebuilt when either changes). */
export function loadCourse(c: Course, t: Theme): void {
  course = c; theme = t;
  lastState = null;
  buildCourse();
}
export function setHighContrast(on: boolean): void {
  if (highContrast === on) return;
  highContrast = on;
  applyPost();
  if (flag) (flag.material as MeshBasicMaterial).color.setHex(on ? 0xffff00 : 0xe64545);
}
export function setReducedMotion(on: boolean): void { reducedMotion = on; }

// ---------------------------------------------------------------- state → course
let lastState: State | null = null;
let shownTick = 0;
export function applySnapshot(state: State | null): void {
  lastState = state;
  if (!state || !course) { marker.visible = false; return; }
  state.players.forEach((p, i) => {
    const m = ballMesh(p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]!);
    m.position.set(p.ball.x, Rules.BALL_R, p.ball.y);
    m.visible = !p.holed;
  });
  const me = state.players[state.currentPlayer];
  if (me && state.phase === "aim" && !state.terminal) {
    marker.visible = true;
    marker.position.set(me.ball.x, 0.02, me.ball.y);
  } else marker.visible = false;
  shownTick = state.tick;
}
/** The rolling ball of the player to play at a trace position (and the movers at its tick). */
export function placeRolling(state: State, x: number, y: number, tick: number): void {
  const i = state.currentPlayer;
  const m = ballMesh(state.players[i]!.id, PLAYER_COLORS[i % PLAYER_COLORS.length]!);
  m.visible = true;
  m.position.set(x, Rules.BALL_R, y);
  marker.visible = false;
  shownTick = tick;
}
/** The aim arrow (null hides it): length by power, green / amber / red by power. */
export function setAim(ball: { x: number; y: number } | null, angle = 0, power = 0): void {
  if (!ball) { aimArrow.visible = false; return; }
  aimArrow.visible = true;
  const len = 0.6 + (power / 100) * 3.2;
  aimPos.set([ball.x, 0.1, ball.y, ball.x + Math.cos(angle) * len, 0.1, ball.y + Math.sin(angle) * len]);
  (aimGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
  const hue = power < 40 ? 0x4ec96e : power < 75 ? 0xf2c14e : 0xe64545;
  aimMat.color.setHex(highContrast ? 0xffffff : hue);
}
export function spawnBurst(x: number, z: number, n: number, color: number, spread: number, up: number): void {
  const budget = particleBudget;
  for (let i = 0; i < n && i < budget; i++) {
    const d = particleData[particleCursor]!;
    particleCursor = (particleCursor + 1) % budget;
    d.life = 1;
    d.x = x; d.y = 0.15; d.z = z;
    const a = (i / n) * PI * 2 + (particleCursor % 7) * 0.13;
    d.vx = Math.cos(a) * spread * (0.5 + (i % 3) * 0.3);
    d.vz = Math.sin(a) * spread * (0.5 + (i % 3) * 0.3);
    d.vy = up * (0.6 + (i % 5) * 0.18);
  }
  pmat.color.setHex(color);
}

/** Each frame (not while paused): movers, water shimmer, flag, pollen, particles. */
export function update(dtIn: number, timeMs: number, paused: boolean): void {
  // Attenuated points are sized by the window's height; the old canvas was the course view.
  const k = view && win.h ? view.h / win.h : 1;
  pmat.size = 0.12 * k;
  if (pollen) (pollen.material as PointsMaterial).size = 0.05 * k;
  for (const mv of movers) {
    const p = Rules.moverPos(mv.def, shownTick);
    mv.mesh.position.set(p.x, 0.35, p.y);
  }
  if (paused) return;
  const t = timeMs;
  const waterMoves = !!look?.waterAnimated && !reducedMotion;
  waterMats.forEach((m, i) => {
    if (!waterMoves) return;
    m.opacity = 0.8 + Math.sin(t * 0.0012 + i * 1.7) * 0.06;
    const nm = (m as MeshStandardMaterial).normalMap;
    if (nm) nm.offset.set(t * 0.00002, t * 0.000013);
  });
  if (flag && flagBase) {
    const attr = flag.geometry.getAttribute("position") as BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = flagBase[i]!;
      const kk = (x + 0.21) / 0.42;
      arr[i + 2] = reducedMotion ? 0 : Math.sin(x * 14 - t * 0.004) * 0.035 * kk;
    }
    attr.needsUpdate = true;
  }
  updatePollen(t);
  const dt = Math.min(0.064, Math.max(0, dtIn));
  for (let i = 0; i < particleBudget; i++) {
    const d = particleData[i]!;
    if (d.life <= 0) { particlePos[i * 3 + 1] = -10; continue; }
    d.life -= dt * 1.4;
    d.vy -= dt * 4;
    d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
    if (d.y < 0) { d.y = 0; d.vy = 0; }
    particlePos[i * 3] = d.x; particlePos[i * 3 + 1] = d.y; particlePos[i * 3 + 2] = d.z;
  }
  (pgeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
}
export function cameraDistance(): number { return camDist; }
