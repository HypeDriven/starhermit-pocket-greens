'use strict';
(function () {

// Pocket Greens — render: Three.js scene graph, semantic entity views, camera, lighting,
// VFX, quality. Rendering consumes immutable snapshots plus interpolation data and never
// mutates rules state. World mapping: course (x, y) -> world (x, 0, z); y is up.

const isNode = typeof module !== 'undefined' && module.exports;
const RULES = isNode ? require('./rules') : window.PG.rules;
const GFX = isNode ? require('./gfx') : window.PG.gfx;

function three() { return (typeof window !== 'undefined') ? window.THREE : null; }
// Same-revision post-processing/environment addons, loaded as ES modules by index.html.
function addons() { return (typeof window !== 'undefined') ? window.PG_ADDONS || null : null; }

// Authored framing constants — no magic offsets sprinkled through the code.
const CAM = {
	elevationDeg: 52,          // low-distortion perspective, near-tabletop feel
	fov: 42,
	margin: 1.5,               // course-to-frame margin (leaves room for the HUD rails/tray)
	transitionMs: 700,         // hole-change swoop (disabled by reduced motion)
};

const KEY_OFFSET = [6, 12, 4];   // key light direction relative to the course centre
const SURROUND = 1.5;           // rough band width around the course (world units)

const R = {
	renderer: null, scene: null, camera: null, canvas: null,
	courseGroup: null, ballMeshes: {}, ghost: null, aimArrow: null,
	particles: null, particleData: [], ripples: [], pollen: null,
	movers: [], waterMats: [], course: null, theme: null, flagGeo: null,
	reducedMotion: false, highContrast: false,
	camFrom: null, camTo: null, camT: 1,
	trace: null, traceI: 0, traceSpeed: 1, traceDone: null, traceEvents: [],
	lastTick: 0, running: false, raf: 0, hidden: false,
	width: 0, height: 0, pixelRatio: 0,
	// graphics settings
	saved: {}, q: null, gpu: '', detected: 'balanced', mobile: false,
	adaptiveScale: 1, frames: [], fps: 0, composer: null, passes: [], postKey: null, postFailed: false,
	envTex: null, dirty: true, tex: {},
};

// ---------- colour grade (display-space in, display-space out; runs after OutputPass) ----------

const GradeShader = {
	uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.2 } },
	vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
	fragmentShader: [
		'uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;',
		'varying vec2 vUv;',
		'void main() {',
		'  vec4 src = texture2D(tDiffuse, vUv);',
		'  vec3 c = clamp(src.rgb, 0.0, 1.0);',
		// gentle S-curve, a touch more saturation, warm highlights / cool shadows (garden light)
		'  vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);',
		'  float l = dot(s, vec3(0.299, 0.587, 0.114));',
		'  s = mix(vec3(l), s, 1.1);',
		'  s *= mix(vec3(0.97, 0.99, 1.04), vec3(1.04, 1.01, 0.95), smoothstep(0.2, 0.85, l));',
		'  c = mix(c, s, uAmount);',
		'  float d = length(vUv - 0.5);',
		'  c *= 1.0 - uVignette * smoothstep(0.4, 0.9, d);',
		'  gl_FragColor = vec4(c, src.a);',
		'}',
	].join('\n'),
};

// ---------- procedural textures (cached, shared across courses) ----------

function canvasTex(key, size, paint, opts) {
	if (R.tex[key]) return R.tex[key];
	const THREE = three();
	const c = document.createElement('canvas');
	c.width = c.height = size;
	const ctx = c.getContext('2d');
	const img = ctx.createImageData(size, size);
	paint(img.data, size);
	ctx.putImageData(img, 0, 0);
	const t = new THREE.CanvasTexture(c);
	t.wrapS = t.wrapT = THREE.RepeatWrapping;
	if (!(opts && opts.linear)) t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	R.tex[key] = t;
	return t;
}

// seeded value noise, tileable over `period` cells
function valueNoise(seed, period) {
	const rnd = RULES.mulberry32(seed);
	const g = [];
	for (let i = 0; i < period * period; i++) g.push(rnd());
	const at = (x, y) => g[((y % period + period) % period) * period + ((x % period + period) % period)];
	return (x, y) => {
		const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
		const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
		const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
		return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
	};
}

function grey(data, i, v) { v = Math.max(0, Math.min(255, v)); data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255; }

// mowing stripes (8 bands) + fine blade noise; multiplies the theme's green
function mowTex() {
	return canvasTex('mow', 256, (d, n) => {
		const nz = valueNoise(11, 32), fine = RULES.mulberry32(5);
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
			const band = Math.floor(x / 32) % 2 ? 236 : 255;
			grey(d, (y * n + x) * 4, band - 10 + nz(x / 8, y / 8) * 14 - fine() * 12);
		}
	});
}

function noiseTex(key, seed, lo, hi, scale) {
	return canvasTex(key, 128, (d, n) => {
		const nz = valueNoise(seed, 16), fine = RULES.mulberry32(seed + 1);
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
			const v = nz(x / scale, y / scale) * 0.7 + fine() * 0.3;
			grey(d, (y * n + x) * 4, lo + (hi - lo) * v);
		}
	});
}

function grainTex() {
	return canvasTex('grain', 128, (d, n) => {
		const nz = valueNoise(23, 16);
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
			const w = Math.sin((y + nz(x / 16, y / 4) * 10) * 0.9) * 0.5 + 0.5;
			grey(d, (y * n + x) * 4, 206 + w * 40 + nz(x / 4, y / 2) * 9);
		}
	});
}

// tileable ripple normal map for water (sum of integer-frequency waves)
function waterNormalTex() {
	return canvasTex('waterN', 128, (d, n) => {
		const H = (x, y) => {
			const u = x / n * Math.PI * 2, v = y / n * Math.PI * 2;
			return Math.sin(u * 3 + v * 2) * 0.5 + Math.sin(u * 5 - v * 4 + 1.3) * 0.3 + Math.sin(-u * 2 + v * 7 + 2.1) * 0.2;
		};
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
			const dx = (H(x + 1, y) - H(x - 1, y)) * 2.2, dy = (H(x, y + 1) - H(x, y - 1)) * 2.2;
			const l = Math.hypot(dx, dy, 1);
			const i = (y * n + x) * 4;
			d[i] = (-dx / l * 0.5 + 0.5) * 255; d[i + 1] = (-dy / l * 0.5 + 0.5) * 255; d[i + 2] = (1 / l * 0.5 + 0.5) * 255; d[i + 3] = 255;
		}
	}, { linear: true });
}

// soft round sprite for particles
function dotTex() {
	return canvasTex('dot', 32, (d, n) => {
		for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
			const r = Math.hypot(x - n / 2 + 0.5, y - n / 2 + 0.5) / (n / 2);
			const i = (y * n + x) * 4;
			d[i] = d[i + 1] = d[i + 2] = 255;
			d[i + 3] = Math.max(0, 1 - r * r) * 255;
		}
	});
}

function scaleUV(geo, sx, sy) {
	const uv = geo.attributes.uv;
	for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
	uv.needsUpdate = true;
	return geo;
}

// ---------- lifecycle ----------

function detectGpu(gl) {
	try {
		let s = gl.getParameter(gl.RENDERER) || '';
		// most browsers already return the unmasked string; ask the extension only if not
		if (!s || /^webkit webgl$/i.test(s)) {
			const ext = gl.getExtension('WEBGL_debug_renderer_info');
			if (ext) s = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || s;
		}
		return String(s);
	} catch (e) { return ''; }
}

function init(canvas, opts) {
	const THREE = three();
	if (!THREE) throw new Error('three-not-loaded');
	opts = opts || {};
	R.canvas = canvas;
	R.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	R.renderer.outputColorSpace = THREE.SRGBColorSpace;
	R.renderer.toneMapping = THREE.ACESFilmicToneMapping;
	R.renderer.toneMappingExposure = 1.0;
	R.renderer.shadowMap.type = THREE.PCFShadowMap;
	R.scene = new THREE.Scene();
	R.camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.1, 200);
	R.gpu = detectGpu(R.renderer.getContext());
	R.mobile = (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches) ||
		/Android|iPhone|iPad|Mobi/i.test(navigator.userAgent);
	R.detected = GFX.detectPreset(R.gpu, R.mobile);
	R.envTex = null;
	R.composer = null; R.passes = []; R.postKey = null;
	R.pixelRatio = 0;

	// one dominant key light + soft environment fill; contact grounding via shadow
	const key = new THREE.DirectionalLight(0xfff1d6, 1.7);
	key.position.set(KEY_OFFSET[0], KEY_OFFSET[1], KEY_OFFSET[2]);
	key.shadow.bias = -0.0004;
	key.shadow.normalBias = 0.02;
	const fill = new THREE.HemisphereLight(0xd6e8ff, 0x3a4a2c, 0.55);
	R.scene.add(key, key.target, fill);
	R.keyLight = key;
	R.fill = fill;

	// pooled particle system (Points); cosmetic only, never raycast
	const pgeo = new THREE.BufferGeometry();
	const max = GFX.PARTICLE_BUDGET.high;
	pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
	const pmat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, map: dotTex(), transparent: true, opacity: 0.9, depthWrite: false });
	R.particles = new THREE.Points(pgeo, pmat);
	R.particles.frustumCulled = false;
	R.particles.raycast = function () {}; // effects never intercept picking
	R.scene.add(R.particles);
	R.particleData = [];
	for (let i = 0; i < max; i++) R.particleData.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
	R.particleCursor = 0;
	R.particleBudget = GFX.PARTICLE_BUDGET.low;

	// aim arrow: line + head, selection layer only
	const amat = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 2 });
	const ageo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
	R.aimArrow = new THREE.Line(ageo, amat);
	R.aimArrow.visible = false;
	R.scene.add(R.aimArrow);

	// grounded selection marker (ring) — selection uses pose + marker, not bloom
	const rgeo = new THREE.RingGeometry(0.26, 0.34, 32);
	const rmat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
	R.marker = new THREE.Mesh(rgeo, rmat);
	R.marker.rotation.x = -Math.PI / 2;
	R.marker.visible = false;
	R.scene.add(R.marker);

	R.reducedMotion = !!opts.reducedMotion;
	// a re-init (context restore) must not leave the previous rAF chain running
	if (R.raf) cancelAnimationFrame(R.raf);
	R.courseGroup = null;   // the old group belongs to the discarded scene
	R.flag = null;
	R.pollen = null;
	R.ballMeshes = {};
	R.q = null;
	setGraphics(opts.gfx || R.saved || {});
	R.running = true;
	canvas.addEventListener('webglcontextlost', onContextLost, false);
	loop();
	return true;
}

function onContextLost(e) {
	e.preventDefault();
	// WebGL context recovery: GPU resources are rebuilt from retained CPU descriptors.
	const c = R.course, t = R.theme;
	setTimeout(() => {
		try {
			if (R.renderer) R.renderer.dispose();
			for (const k of Object.keys(R.tex)) { R.tex[k].dispose(); delete R.tex[k]; }
			if (c) init(R.canvas, { gfx: R.saved, reducedMotion: R.reducedMotion }) && loadCourse(c, t);
		} catch (err) { /* UI shows the compatibility message via onFatal */ if (R.onFatal) R.onFatal(err); }
	}, 100);
}

function disposeCourse() {
	if (!R.courseGroup) return;
	R.courseGroup.traverse(o => {
		if (o.geometry) o.geometry.dispose();
		if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
	});
	R.scene.remove(R.courseGroup);
	R.courseGroup = null;
	R.flag = null;
	R.flagGeo = null;
	R.pollen = null;
	R.movers = [];
	R.waterMats = [];
	R.ripples = [];
	R.scene.fog = null;
	for (const k of Object.keys(R.ballMeshes)) {
		const m = R.ballMeshes[k];
		R.scene.remove(m); m.geometry.dispose(); m.material.dispose();
		delete R.ballMeshes[k];
	}
}

// ---------- course construction (procedural, inspectable meshes) ----------

function loadCourse(course, theme) {
	const THREE = three();
	disposeCourse();
	R.course = course; R.theme = theme;
	const P = theme.palette;
	const detailed = !!(R.q && R.q.detail === 'detailed');
	const g = new THREE.Group();
	R.scene.background = new THREE.Color(P.sky);
	const cx = course.w / 2, cz = course.h / 2;

	// green: mowing-stripe texture in detailed mode, flat colour otherwise
	const greenGeo = new THREE.BoxGeometry(course.w, 0.3, course.h);
	if (detailed) scaleUV(greenGeo, course.w / 8, course.h / 8);
	const green = new THREE.Mesh(greenGeo, new THREE.MeshStandardMaterial({
		color: P.green, roughness: 0.95, map: detailed ? mowTex() : null,
	}));
	green.position.set(cx, -0.15, cz);
	green.receiveShadow = true;
	green.userData.layer = 'gameplay';
	g.add(green);
	// rough surround
	const roughGeo = new THREE.BoxGeometry(course.w + SURROUND * 2, 0.2, course.h + SURROUND * 2);
	if (detailed) scaleUV(roughGeo, (course.w + 3) / 3, (course.h + 3) / 3);
	const rough = new THREE.Mesh(roughGeo, new THREE.MeshStandardMaterial({
		color: P.rough, roughness: 1, map: detailed ? noiseTex('rough', 31, 205, 255, 3) : null,
	}));
	rough.position.set(cx, -0.32, cz);
	rough.receiveShadow = true;
	rough.userData.layer = 'environment';
	g.add(rough);

	const wood = detailed ? grainTex() : null;
	const wallMat = new THREE.MeshStandardMaterial({ color: P.wall, roughness: 0.8, map: wood });
	const capMat = detailed ? new THREE.MeshStandardMaterial({ color: new THREE.Color(P.wall).lerp(new THREE.Color(0xffffff), 0.28), roughness: 0.55, map: wood }) : null;
	// boundary rails
	const railH = 0.34, railT = 0.28;
	const addWall = (x, z, w, d) => {
		const geo = new THREE.BoxGeometry(w, railH, d);
		if (detailed) scaleUV(geo, Math.max(1, w / 2), 1);
		const m = new THREE.Mesh(geo, wallMat);
		m.position.set(x, railH / 2, z);
		m.castShadow = m.receiveShadow = true;
		m.userData.layer = 'gameplay';
		g.add(m);
		if (capMat) {
			// lighter bevelled cap strip: reads as a finished wooden rail
			const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.02, 0.04, d + 0.02), capMat);
			cap.position.set(x, railH + 0.02, z);
			cap.receiveShadow = true;
			cap.userData.layer = 'environment';
			g.add(cap);
		}
	};
	[[cx, -railT / 2, course.w + railT * 2, railT], [cx, course.h + railT / 2, course.w + railT * 2, railT],
	 [-railT / 2, cz, railT, course.h], [course.w + railT / 2, cz, railT, course.h]].forEach(b => addWall(b[0], b[1], b[2], b[3]));
	for (const w of course.walls) addWall(w.x + w.w / 2, w.y + w.h / 2, w.w, w.h);

	const obMat = new THREE.MeshStandardMaterial({ color: P.obstacle, roughness: 0.7, map: detailed ? noiseTex('stone', 41, 200, 255, 4) : null });
	for (const o of course.obstacles) {
		if (o.type === 'circle') {
			const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r * 1.1, 0.5, detailed ? 36 : 20), obMat);
			m.position.set(o.x, 0.25, o.y);
			m.castShadow = m.receiveShadow = true;
			m.userData.layer = 'gameplay';
			g.add(m);
			if (detailed) {
				// planter: a mossy crown on top of the stone drum
				const crown = new THREE.Mesh(new THREE.SphereGeometry(o.r * 0.82, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2),
					new THREE.MeshStandardMaterial({ color: new THREE.Color(P.rough).multiplyScalar(0.8), roughness: 1, map: noiseTex('rough', 31, 205, 255, 3) }));
				crown.scale.y = 0.55;
				crown.position.set(o.x, 0.5, o.y);
				crown.castShadow = true;
				crown.userData.layer = 'environment';
				g.add(crown);
			}
		} else {
			const m = new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.45, o.h), obMat);
			m.position.set(o.x + o.w / 2, 0.225, o.y + o.h / 2);
			m.castShadow = m.receiveShadow = true;
			m.userData.layer = 'gameplay';
			g.add(m);
		}
	}

	// water: semi-transparent animated surface; detailed mode adds a rippled, reflective normal map
	for (const z of course.water) {
		const w = z.w || z.r * 2, h = z.h || z.r * 2;
		const wx = z.type === 'circle' ? z.x : z.x + z.w / 2;
		const wz = z.type === 'circle' ? z.y : z.y + z.h / 2;
		const mat = detailed
			? new THREE.MeshStandardMaterial({
				color: new THREE.Color(P.water).lerp(new THREE.Color(0x9fd8ff), 0.18), transparent: true, opacity: 0.86,
				roughness: 0.08, metalness: 0.2, normalMap: waterNormalTex(), normalScale: new THREE.Vector2(0.35, 0.35),
				envMapIntensity: 1.3,
			})
			: new THREE.MeshStandardMaterial({ color: P.water, transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0.35 });
		const geo = z.type === 'circle' ? new THREE.CylinderGeometry(z.r, z.r, 0.08, 40) : new THREE.BoxGeometry(w, 0.08, h);
		if (detailed && z.type !== 'circle') scaleUV(geo, w / 2, h / 2);
		const m = new THREE.Mesh(geo, mat);
		m.position.set(wx, -0.02, wz);
		m.userData.layer = 'environment';
		g.add(m);
		R.waterMats.push(mat);
	}

	const sandMat = new THREE.MeshStandardMaterial({ color: P.sand, roughness: 1, map: detailed ? noiseTex('sand', 53, 215, 255, 1.5) : null });
	for (const z of course.sand) {
		const w = z.w || z.r * 2, h = z.h || z.r * 2;
		const geo = z.type === 'circle' ? new THREE.CylinderGeometry(z.r, z.r, 0.06, 40) : new THREE.BoxGeometry(w, 0.06, h);
		const m = new THREE.Mesh(geo, sandMat);
		m.position.set(z.type === 'circle' ? z.x : z.x + z.w / 2, 0.01, z.type === 'circle' ? z.y : z.y + z.h / 2);
		m.receiveShadow = true;
		m.userData.layer = 'gameplay';
		g.add(m);
	}

	const mvMat = new THREE.MeshStandardMaterial({ color: P.mover, roughness: 0.5 });
	const bandMat = detailed ? new THREE.MeshStandardMaterial({ color: 0xf4efe2, roughness: 0.4 }) : null;
	for (const mv of course.movers) {
		const m = new THREE.Mesh(new THREE.CylinderGeometry(mv.r, mv.r, 0.7, detailed ? 32 : 18), mvMat);
		m.castShadow = true;
		m.userData.layer = 'gameplay';
		if (bandMat) {
			// painted band: keepers read as moving machinery, not static posts
			const band = new THREE.Mesh(new THREE.CylinderGeometry(mv.r * 1.02, mv.r * 1.02, 0.12, 32), bandMat);
			band.position.y = 0.16;
			m.add(band);
		}
		g.add(m);
		R.movers.push({ def: mv, mesh: m });
	}

	// cup: dark recessed ring + flag for readability at distance
	const cupM = new THREE.Mesh(
		new THREE.CylinderGeometry(RULES.CUP_R, RULES.CUP_R, 0.05, 32),
		new THREE.MeshStandardMaterial({ color: P.cup, roughness: 0.9 })
	);
	cupM.position.set(course.cup.x, 0.03, course.cup.y);
	cupM.userData.layer = 'gameplay';
	g.add(cupM);
	if (detailed) {
		const liner = new THREE.Mesh(new THREE.RingGeometry(RULES.CUP_R * 0.84, RULES.CUP_R, 40),
			new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.4 }));
		liner.rotation.x = -Math.PI / 2;
		liner.position.set(course.cup.x, 0.057, course.cup.y);
		liner.userData.layer = 'gameplay';
		g.add(liner);
	}
	const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 8),
		detailed ? new THREE.MeshStandardMaterial({ color: 0xf0f0f0, roughness: 0.25, metalness: 0.6 }) : new THREE.MeshStandardMaterial({ color: 0xf0f0f0 }));
	pole.position.set(course.cup.x, 0.55, course.cup.y);
	pole.castShadow = detailed;
	const flagGeo = new THREE.PlaneGeometry(0.42, 0.26, detailed ? 10 : 1, 1);
	const flag = new THREE.Mesh(flagGeo, new THREE.MeshBasicMaterial({ color: R.highContrast ? 0xffff00 : 0xe64545, side: THREE.DoubleSide }));
	flag.userData.layer = 'ui-anchor';
	g.add(pole, flag);
	R.flag = flag;
	if (detailed) { R.flagGeo = flagGeo; flagGeo.userData.base = Float32Array.from(flagGeo.attributes.position.array); }

	if (detailed) buildGarden(g, course, P);

	R.courseGroup = g;
	R.scene.add(g);
	fitShadow(course);
	frameCamera(course, true);
	applyEnvironment();
	R.dirty = true;
}

// Garden surround (detail = detailed): a wide lawn fading into fog, hedges, flower borders,
// stones and a few trees — all outside the rails, so the playable area is untouched.
function buildGarden(g, course, P) {
	const THREE = three();
	const rnd = RULES.mulberry32(RULES.hashStr(String(course.id || 'course')));
	const cx = course.w / 2, cz = course.h / 2;
	const lawnCol = new THREE.Color(P.rough).multiplyScalar(0.68);
	const lawnGeo = scaleUV(new THREE.PlaneGeometry(course.w + 80, course.h + 80), (course.w + 80) / 4, (course.h + 80) / 4);
	const lawn = new THREE.Mesh(lawnGeo, new THREE.MeshStandardMaterial({ color: lawnCol, roughness: 1, map: noiseTex('rough', 31, 205, 255, 3) }));
	lawn.rotation.x = -Math.PI / 2;
	lawn.position.set(cx, -0.42, cz);
	lawn.receiveShadow = true;
	lawn.userData.layer = 'environment';
	g.add(lawn);

	const dummy = new THREE.Object3D();
	const col = new THREE.Color();
	// hedges: a ring of rounded bushes just beyond the rough band
	const off = SURROUND + 0.55;
	const spots = [];
	const perim = (x0, z0, x1, z1) => {
		const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(2, Math.round(len / 0.75));
		for (let i = 0; i <= n; i++) spots.push([x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n]);
	};
	perim(-off, -off, course.w + off, -off); perim(course.w + off, -off, course.w + off, course.h + off);
	perim(course.w + off, course.h + off, -off, course.h + off); perim(-off, course.h + off, -off, -off);
	const hedgeCol = new THREE.Color(P.rough).multiplyScalar(0.55);
	const hedges = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 2),
		new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, map: noiseTex('leaf', 61, 150, 255, 1.2) }), spots.length);
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
	hedges.userData.layer = 'environment';
	g.add(hedges);

	// flower borders inside the rough band (between the rail and the hedges)
	const petals = [0xf7a8c4, 0xffe27a, 0xffffff, 0xc9a7f0, 0xff9d6e];
	const flowerSpots = [];
	for (let i = 0; i < Math.round((course.w + course.h) * 5); i++) {
		const t = rnd(), side = Math.floor(rnd() * 4), band = 0.45 + rnd() * (SURROUND - 0.55);
		let x, z;
		if (side === 0) { x = -SURROUND + t * (course.w + SURROUND * 2); z = -band; }
		else if (side === 1) { x = -SURROUND + t * (course.w + SURROUND * 2); z = course.h + band; }
		else if (side === 2) { x = -band; z = -SURROUND + t * (course.h + SURROUND * 2); }
		else { x = course.w + band; z = -SURROUND + t * (course.h + SURROUND * 2); }
		flowerSpots.push([x, z]);
	}
	const flowers = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.07, 0),
		new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 }), flowerSpots.length);
	flowerSpots.forEach((s, i) => {
		dummy.position.set(s[0], -0.18 + rnd() * 0.08, s[1]);
		const k = 0.8 + rnd() * 0.6;
		dummy.scale.set(k, k * 0.7, k);
		dummy.rotation.set(rnd(), rnd() * 6.28, 0);
		dummy.updateMatrix();
		flowers.setMatrixAt(i, dummy.matrix);
		flowers.setColorAt(i, col.setHex(petals[Math.floor(rnd() * petals.length)]));
	});
	flowers.userData.layer = 'environment';
	g.add(flowers);

	// grass tufts scattered on the rough (fine blades read as texture at tabletop scale)
	const tuftN = Math.round((course.w + course.h) * 6);
	const tufts = new THREE.InstancedMesh(new THREE.ConeGeometry(0.035, 0.22, 4),
		new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }), tuftN);
	const tuftCol = new THREE.Color(P.rough);
	for (let i = 0; i < tuftN; i++) {
		const s = flowerSpots[i % flowerSpots.length];
		dummy.position.set(s[0] + (rnd() - 0.5) * 0.5, -0.14, s[1] + (rnd() - 0.5) * 0.5);
		dummy.scale.setScalar(0.7 + rnd() * 0.6);
		dummy.rotation.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5);
		dummy.updateMatrix();
		tufts.setMatrixAt(i, dummy.matrix);
		tufts.setColorAt(i, col.copy(tuftCol).multiplyScalar(0.75 + rnd() * 0.4));
	}
	tufts.userData.layer = 'environment';
	g.add(tufts);

	// trees at the corners, beyond the hedges (they never shade the green)
	const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.9, map: grainTex() });
	const canopyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(P.rough).multiplyScalar(0.62), roughness: 0.9, map: noiseTex('leaf', 61, 150, 255, 1.2), flatShading: true });
	const toff = off + 2.2;
	[[-toff, -toff], [course.w + toff, -toff], [-toff, course.h + toff], [course.w + toff, course.h + toff]].forEach(p => {
		const h = 1.6 + rnd() * 0.8;
		const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, h, 8), trunkMat);
		trunk.position.set(p[0], -0.42 + h / 2, p[1]);
		const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(1.1 + rnd() * 0.4, 1), canopyMat);
		canopy.position.set(p[0], -0.42 + h + 0.6, p[1]);
		trunk.userData.layer = canopy.userData.layer = 'environment';
		g.add(trunk, canopy);
	});

	// stepping stones on the lawn
	const stones = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.22, 0),
		new THREE.MeshStandardMaterial({ color: 0xb8b2a6, roughness: 0.85, map: noiseTex('stone', 41, 200, 255, 4) }), 10);
	for (let i = 0; i < 10; i++) {
		const side = i % 2 ? -1 : 1;
		dummy.position.set(cx + (rnd() - 0.5) * course.w * 1.2, -0.42, side > 0 ? course.h + off + 1 + rnd() * 1.5 : -off - 1 - rnd() * 1.5);
		dummy.scale.set(1 + rnd() * 0.6, 0.35, 1 + rnd() * 0.4);
		dummy.rotation.set(0, rnd() * 6.28, 0);
		dummy.updateMatrix();
		stones.setMatrixAt(i, dummy.matrix);
	}
	stones.receiveShadow = true;
	stones.userData.layer = 'environment';
	g.add(stones);

	// drifting pollen motes (cosmetic particles; hidden when particles are low or motion reduced)
	const n = 40;
	const pos = new Float32Array(n * 3), seed = [];
	for (let i = 0; i < n; i++) seed.push([rnd() * (course.w + 4) - 2, 0.3 + rnd() * 1.4, rnd() * (course.h + 4) - 2, rnd() * 6.28]);
	const pgeo = new THREE.BufferGeometry();
	pgeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
	const pollen = new THREE.Points(pgeo, new THREE.PointsMaterial({ color: 0xffe9a8, size: 0.05, map: dotTex(), transparent: true, opacity: 0.55, depthWrite: false }));
	pollen.frustumCulled = false;
	pollen.raycast = function () {};
	pollen.userData = { layer: 'effects', seed };
	g.add(pollen);
	R.pollen = pollen;
	updatePollen(0);
}

function updatePollen(t) {
	const p = R.pollen;
	if (!p) return;
	p.visible = !!(R.q && R.q.particles === 'high') && !R.reducedMotion;
	if (!p.visible) return;
	const arr = p.geometry.attributes.position.array, s = p.userData.seed;
	for (let i = 0; i < s.length; i++) {
		const a = s[i][3] + t * 0.00035;
		arr[i * 3] = s[i][0] + Math.sin(a * 1.3) * 0.6;
		arr[i * 3 + 1] = s[i][1] + Math.sin(a * 2.1) * 0.15;
		arr[i * 3 + 2] = s[i][2] + Math.cos(a) * 0.6;
	}
	p.geometry.attributes.position.needsUpdate = true;
}

// Fit the key light's shadow box tightly to the course plus its surround.
function fitShadow(course) {
	const key = R.keyLight;
	const cx = course.w / 2, cz = course.h / 2;
	key.position.set(cx + KEY_OFFSET[0], KEY_OFFSET[1], cz + KEY_OFFSET[2]);
	key.target.position.set(cx, 0, cz);
	key.target.updateMatrixWorld();
	const ext = Math.hypot(course.w, course.h) / 2 + SURROUND + 1;
	const cam = key.shadow.camera;
	cam.left = -ext; cam.right = ext; cam.top = ext; cam.bottom = -ext;
	cam.near = 1; cam.far = Math.hypot(KEY_OFFSET[0], KEY_OFFSET[1], KEY_OFFSET[2]) + ext * 2;
	cam.updateProjectionMatrix();
}

function ballMesh(id, color) {
	const THREE = three();
	if (R.ballMeshes[id]) return R.ballMeshes[id];
	const detailed = !!(R.q && R.q.detail === 'detailed');
	const m = new THREE.Mesh(
		new THREE.SphereGeometry(RULES.BALL_R, detailed ? 32 : 24, detailed ? 24 : 18),
		detailed
			? new THREE.MeshPhysicalMaterial({ color: color || 0xf5f6fa, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.12 })
			: new THREE.MeshStandardMaterial({ color: color || 0xf5f6fa, roughness: 0.35 })
	);
	m.castShadow = true;
	m.userData.layer = 'gameplay';
	R.scene.add(m);
	R.ballMeshes[id] = m;
	return m;
}

const PLAYER_COLORS = [0xf5f6fa, 0xf2c14e, 0x7ec8e3, 0xe08ab8];

// ---------- camera ----------

// Distance at which a spanX-by-spanZ footprint fits the frame. Width is fitted against the
// horizontal field of view and depth against the vertical one: measuring the widest course
// dimension against the vertical FOV alone pushes the camera much too far back.
function fitDistance(spanX, spanZ, aspect) {
	const vFov = CAM.fov * Math.PI / 180;
	const el = CAM.elevationDeg * Math.PI / 180;
	const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
	return Math.max(
		(spanX * CAM.margin) / (2 * Math.tan(hFov / 2)),
		(spanZ * CAM.margin * Math.sin(el)) / (2 * Math.tan(vFov / 2)));
}

function cameraTarget(course) {
	const THREE = three();
	const cx = course.w / 2, cz = course.h / 2;
	const el = CAM.elevationDeg * Math.PI / 180;
	const aspect = (R.camera && R.camera.aspect) || 1.6;
	// Courses are wide; on a portrait display, viewing them from the side lets the long axis
	// run down the screen instead of shrinking the whole green to fit the narrow one.
	const flat = fitDistance(course.w, course.h, aspect);
	const turned = fitDistance(course.h, course.w, aspect);
	const az = turned < flat * 0.95 ? Math.PI / 2 : 0;
	const dist = az ? turned : flat;
	const horiz = Math.cos(el) * dist;
	return {
		pos: new THREE.Vector3(cx + Math.sin(az) * horiz, Math.sin(el) * dist, cz + Math.cos(az) * horiz),
		look: new THREE.Vector3(cx, 0, cz),
		azimuth: az,
		dist,
	};
}

// Screen-space drag delta (pixels) -> course-space delta, undoing the camera's elevation
// foreshortening and quarter turn so a pull-back aims where the player sees it aim.
function courseDelta(px, py) {
	const el = CAM.elevationDeg * Math.PI / 180;
	const sx = px, sy = py / Math.sin(el);
	const c = Math.cos(R.azimuth || 0), s = Math.sin(R.azimuth || 0);
	return { x: sx * c + sy * s, y: -sx * s + sy * c };
}

function frameCamera(course, instant) {
	const THREE = three();
	const t = cameraTarget(course);
	R.azimuth = t.azimuth;
	// the flag is a single quad: turn it to face the camera so it never goes edge-on
	if (R.flag) {
		R.flag.rotation.y = t.azimuth;
		R.flag.position.set(course.cup.x + 0.21 * Math.cos(t.azimuth), 0.95, course.cup.y - 0.21 * Math.sin(t.azimuth));
	}
	// distance fog blends the far lawn into the sky; it starts beyond the course's far edge
	if (R.q && R.q.detail === 'detailed' && R.theme) {
		const diag = Math.hypot(course.w, course.h);
		R.scene.fog = new THREE.Fog(R.theme.palette.sky, t.dist + diag * 0.6, t.dist + diag * 2.6);
	} else R.scene.fog = null;
	R.dirty = true;
	if (instant || R.reducedMotion) {
		R.camera.position.copy(t.pos);
		R.camera.lookAt(t.look);
		R.camT = 1;
		return;
	}
	// authored duration/easing, interruptible — never cumulative per-frame lerp
	R.camFrom = { pos: R.camera.position.clone(), look: t.look.clone() };
	R.camTo = t;
	R.camT = 0;
}

function updateCamera(dtMs) {
	if (R.camT >= 1 || !R.camTo) return;
	R.camT = Math.min(1, R.camT + dtMs / CAM.transitionMs);
	const e = 1 - Math.pow(1 - R.camT, 3); // ease-out cubic
	R.camera.position.lerpVectors(R.camFrom.pos, R.camTo.pos, e);
	R.camera.lookAt(R.camTo.look);
}

// ---------- snapshots, aim, trace playback ----------

function applySnapshot(state) {
	if (!state || !R.course) return;
	state.players.forEach((p, i) => {
		const m = ballMesh(p.id, PLAYER_COLORS[i % PLAYER_COLORS.length]);
		m.position.set(p.ball.x, RULES.BALL_R, p.ball.y);
		m.visible = !p.holed;
	});
	const me = state.players[state.currentPlayer];
	if (me && state.phase === 'aim' && !state.terminal) {
		R.marker.visible = true;
		R.marker.position.set(me.ball.x, 0.02, me.ball.y);
	} else R.marker.visible = false;
	R.lastTick = state.tick;
	R.dirty = true;
}

// Aim preview: direction arrow scaled by power. Legal targets preview before commit.
function setAim(ballPos, angle, power) {
	const THREE = three();
	R.dirty = true;
	if (!ballPos || angle == null) { R.aimArrow.visible = false; return; }
	R.aimArrow.visible = true;
	const len = 0.6 + (power / 100) * 3.2;
	const pts = [new THREE.Vector3(ballPos.x, 0.1, ballPos.y),
		new THREE.Vector3(ballPos.x + Math.cos(angle) * len, 0.1, ballPos.y + Math.sin(angle) * len)];
	R.aimArrow.geometry.setFromPoints(pts);
	const hue = power < 40 ? 0x4ec96e : power < 75 ? 0xf2c14e : 0xe64545;
	R.aimArrow.material.color.setHex(R.highContrast ? 0xffffff : hue);
}

// Deterministic trace playback: ball position is a pure function of simulated tick.
// speed > 1 fast-forwards; every object still settles into the exact deterministic end state.
function playTrace(trace, events, speed, onDone) {
	R.trace = trace || [];
	R.traceI = 0;
	// Playback never exceeds ~3.5 s of screen time: long rolls fast-forward, and every
	// object still settles into the exact deterministic end state.
	const totalMs = R.trace.length * RULES.DT * 1000;
	const auto = Math.max(1, totalMs / 3500);
	R.traceSpeed = (R.reducedMotion ? 6 : (speed || 1)) * auto;
	R.traceDone = onDone || null;
	R.traceEvents = events || [];
	R.traceClock = 0;
	if (!R.trace.length && R.traceDone) { const d = R.traceDone; R.traceDone = null; d(); }
}

function spawnBurst(x, z, n, color, spread, up) {
	const budget = R.particleBudget;
	const pos = R.particles.geometry.attributes.position;
	for (let i = 0; i < n && i < budget; i++) {
		const d = R.particleData[R.particleCursor];
		R.particleCursor = (R.particleCursor + 1) % budget;
		d.life = 1;
		d.x = x; d.y = 0.15; d.z = z;
		const a = (i / n) * Math.PI * 2 + (R.particleCursor % 7) * 0.13;
		d.vx = Math.cos(a) * spread * (0.5 + (i % 3) * 0.3);
		d.vz = Math.sin(a) * spread * (0.5 + (i % 3) * 0.3);
		d.vy = up * (0.6 + (i % 5) * 0.18);
	}
	R.particles.material.color.setHex(color);
	pos.needsUpdate = true;
}

function updateParticles(dt) {
	const pos = R.particles.geometry.attributes.position;
	const arr = pos.array;
	const budget = R.particleBudget;
	for (let i = 0; i < budget; i++) {
		const d = R.particleData[i];
		if (d.life <= 0) { arr[i * 3 + 1] = -10; continue; }
		d.life -= dt * 1.4;
		d.vy -= dt * 4;
		d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
		if (d.y < 0) { d.y = 0; d.vy = 0; }
		arr[i * 3] = d.x; arr[i * 3 + 1] = d.y; arr[i * 3 + 2] = d.z;
	}
	pos.needsUpdate = true;
}

// Flag cloth: a gentle travelling wave, pinned at the pole edge. Cosmetic only.
function updateFlag(t) {
	const geo = R.flagGeo;
	if (!geo) return;
	const base = geo.userData.base, arr = geo.attributes.position.array;
	const still = R.reducedMotion;
	for (let i = 0; i < arr.length; i += 3) {
		const x = base[i];
		const k = (x + 0.21) / 0.42; // 0 at the pole, 1 at the free edge
		arr[i + 2] = still ? 0 : Math.sin(x * 14 - t * 0.004) * 0.035 * k;
	}
	geo.attributes.position.needsUpdate = true;
}

// ---------- main loop ----------

let lastT = 0;
function loop() {
	if (!R.running) return;
	R.raf = requestAnimationFrame(loop);
	if (R.hidden || !R.renderer) return;
	// performance.now() is monotonic and reliable even when rAF timestamps stall
	const t = performance.now();
	const dtMs = Math.min(64, Math.max(0, t - (lastT || t)));
	lastT = t;
	if (R.paused) {
		// paused: the scene is frozen, but graphics changes made from the pause menu still show
		if (R.dirty) renderFrame(0);
		return;
	}
	const dt = dtMs / 1000;

	updateCamera(dtMs);

	// movers are a pure function of the simulation tick being displayed
	const shownTick = (R.trace && R.trace[R.traceI]) ? R.trace[R.traceI].t : R.lastTick;
	for (const mv of R.movers) {
		const p = RULES.moverPos(mv.def, shownTick);
		mv.mesh.position.set(p.x, 0.35, p.y);
	}

	// water shimmer (and ripple drift in detailed mode): cosmetic only, still when static/reduced
	const waterMoves = R.q.water === 'animated' && !R.reducedMotion;
	for (let i = 0; i < R.waterMats.length; i++) {
		const m = R.waterMats[i];
		if (waterMoves) {
			m.opacity = 0.8 + Math.sin(t * 0.0012 + i * 1.7) * 0.06;
			if (m.normalMap) m.normalMap.offset.set(t * 0.00002, t * 0.000013);
		}
	}
	updateFlag(t);
	updatePollen(t);

	if (R.trace && R.trace.length) {
		R.traceClock += dtMs * R.traceSpeed;
		const tickDur = RULES.DT * 1000;
		while (R.traceI < R.trace.length - 1 && R.traceClock >= tickDur) {
			R.traceClock -= tickDur;
			R.traceI += 1;
		}
		const a = R.trace[R.traceI], b = R.trace[Math.min(R.traceI + 1, R.trace.length - 1)];
		const alpha = Math.min(1, R.traceClock / tickDur);
		const x = a.x + (b.x - a.x) * alpha, y = a.y + (b.y - a.y) * alpha;
		const state = R.currentState;
		if (state) {
			const me = state.players[state.currentPlayer];
			const m = ballMesh(me.id, PLAYER_COLORS[state.currentPlayer % PLAYER_COLORS.length]);
			m.visible = true;
			m.position.set(x, RULES.BALL_R, y);
		}
		// fire trace events at approximately their simulated time
		for (const e of R.traceEvents) {
			if (e._fired) continue;
			if (e.type === 'splash' && R.traceI >= R.trace.length - 3) { e._fired = true; if (R.onEvent) R.onEvent(e); spawnBurst(e.x, e.y, 22, 0x9fd4ff, 1.6, 2.2); }
			if (e.type === 'bounce' && !e._fired && R.traceI / R.trace.length > 0.02) { e._fired = true; if (R.onEvent) R.onEvent(e); spawnBurst(e.x, e.y, 5, 0xffffff, 0.5, 0.8); }
		}
		if (R.traceI >= R.trace.length - 1 && alpha >= 1) finishTrace();
	}

	updateParticles(dt);
	renderFrame(dtMs);
}

function renderFrame(dtMs) {
	if (dtMs > 0 && adapt(dtMs)) applySize();
	const key = postKey();
	if (key !== R.postKey) { R.postKey = key; buildPost(); }
	if (!R.envTex && R.q.reflections === 'on') applyEnvironment();
	if (R.composer) {
		try { R.composer.render(dtMs / 1000); }
		catch (e) { disposePost(); R.postFailed = true; R.renderer.render(R.scene, R.camera); }
	} else R.renderer.render(R.scene, R.camera);
	R.dirty = false;
}

// Settle the active ball into the trace's exact end state and fire the completion callback.
function finishTrace() {
	if (!R.trace) return;
	const last = R.trace[R.trace.length - 1];
	const state = R.currentState;
	if (state && last) {
		const me = state.players[state.currentPlayer];
		ballMesh(me.id, PLAYER_COLORS[state.currentPlayer % PLAYER_COLORS.length]).position.set(last.x, RULES.BALL_R, last.y);
	}
	for (const e of R.traceEvents) {
		if (!e._fired && (e.type === 'splash' || e.type === 'bounce')) { e._fired = true; if (R.onEvent) R.onEvent(e); }
	}
	R.trace = null;
	R.dirty = true;
	const d = R.traceDone; R.traceDone = null;
	if (d) d();
}

// ---------- resolution, adaptive scale, post-processing ----------

function targetRatio() {
	const q = R.q;
	const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
	return Math.min(4, Math.min(dpr, q.dprCap) * q.scale * R.adaptiveScale);
}

function applySize() {
	if (!R.renderer || !R.width || !R.height) return;
	const pr = targetRatio();
	R.pixelRatio = pr;
	R.renderer.setPixelRatio(pr);
	R.renderer.setSize(Math.floor(R.width), Math.floor(R.height), false);
	R.dirty = true;
}

function resize(w, h) {
	if (!R.renderer || !w || !h) return;
	R.width = w; R.height = h;
	applySize();
	R.camera.aspect = w / h;
	R.camera.updateProjectionMatrix();
	// framing depends on the aspect ratio, so a resize/rotate has to re-frame the course
	if (R.course) frameCamera(R.course, true);
}

// Adaptive resolution: average ~90 frames; step the scale down when slow, back up when fast.
function adapt(dtMs) {
	const f = R.frames;
	f.push(dtMs);
	if (f.length < 90) return false;
	const avg = f.reduce((a, b) => a + b, 0) / f.length;
	f.length = 0;
	R.fps = 1000 / Math.max(1, avg);
	const el = typeof document !== 'undefined' && document.getElementById('fps-meter');
	if (el && !el.hidden) el.textContent = Math.round(R.fps) + ' fps · ' + (Math.round(R.pixelRatio * 100) / 100) + '×';
	if (!R.q.adaptive) return false;
	const before = R.adaptiveScale;
	if (avg > 26) R.adaptiveScale = Math.max(0.6, R.adaptiveScale - 0.1);
	else if (avg < 14 && R.adaptiveScale < 1) R.adaptiveScale = Math.min(1, R.adaptiveScale + 0.05);
	return before !== R.adaptiveScale;
}

function postKey() {
	const q = R.q;
	if (!q.post || !R.width) return 'none';
	return [q.ao, q.bloom, q.grade, q.antialias, R.width, R.height, R.pixelRatio, addons() ? 1 : 0].join('|');
}

function disposePost() {
	for (const p of R.passes) { try { if (p.dispose) p.dispose(); } catch (e) { /* already gone */ } }
	if (R.composer) { try { R.composer.dispose(); } catch (e) { /* already gone */ } }
	R.composer = null;
	R.passes = [];
}

function buildPost() {
	const THREE = three();
	disposePost();
	const q = R.q;
	if (!q.post) return;
	const A = addons();
	if (!A) { R.postFailed = !!window.PG_ADDONS_FAILED; return; } // still loading, or failed to load
	try {
		const w = Math.floor(R.width), h = Math.floor(R.height), pr = R.pixelRatio;
		const pw = Math.max(1, Math.round(w * pr)), ph = Math.max(1, Math.round(h * pr));
		const target = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.HalfFloatType, samples: q.antialias === 'msaa' ? 4 : 0 });
		const composer = new A.EffectComposer(R.renderer, target);
		composer.setPixelRatio(pr);
		composer.setSize(w, h);
		const add = (p) => { composer.addPass(p); R.passes.push(p); return p; };
		add(new A.RenderPass(R.scene, R.camera));
		if (q.ao !== 'off') {
			const ao = new A.GTAOPass(R.scene, R.camera, pw, ph);
			ao.output = A.GTAOPass.OUTPUT.Default;
			ao.blendIntensity = 0.75;
			const hi = q.ao === 'high';
			ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: hi ? 16 : 8 });
			ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8 });
			add(ao);
		}
		// high threshold: only specular glints, the selection ring and bright highlights bloom
		if (q.bloom === 'on') add(new A.UnrealBloomPass(new THREE.Vector2(w, h), 0.4, 0.45, 0.9));
		add(new A.OutputPass());
		if (q.grade === 'on') {
			const grade = add(new A.ShaderPass(GradeShader));
			// high contrast mode keeps the grade neutral: no vignette dimming the edges
			grade.uniforms.uVignette.value = R.highContrast ? 0 : 0.2;
		}
		if (q.antialias === 'smaa') add(new A.SMAAPass());
		if (q.antialias === 'fxaa') add(new A.FXAAPass());
		R.composer = composer;
		R.postFailed = false;
	} catch (e) {
		// post-processing is an enhancement: render directly and let the settings panel say so
		disposePost();
		R.postFailed = true;
	}
}

// Image-based lighting from a procedural room environment (reflections on balls, water, poles).
function applyEnvironment() {
	if (!R.scene || !R.q) return;
	const on = R.q.reflections === 'on';
	if (on && !R.envTex) {
		const A = addons();
		if (A) {
			try {
				const pm = new (three().PMREMGenerator)(R.renderer);
				const room = new A.RoomEnvironment();
				R.envTex = pm.fromScene(room, 0.04).texture;
				room.dispose && room.dispose();
				pm.dispose();
			} catch (e) { R.envTex = null; }
		}
	}
	R.scene.environment = on ? R.envTex : null;
	R.scene.environmentIntensity = 0.45;
	// the environment already adds soft fill: lower the hemisphere so the green keeps its value
	if (R.fill) R.fill.intensity = on && R.envTex ? 0.38 : 0.55;
	if (on && !R.envTex) return; // addons not loaded yet: renderFrame retries
	R.dirty = true;
}

function markMaterialsDirty() {
	R.scene.traverse(o => {
		if (!o.material) return;
		(Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.needsUpdate = true; });
	});
}

function fpsVisible(on) {
	if (typeof document === 'undefined') return;
	let el = document.getElementById('fps-meter');
	if (on && !el) {
		el = document.createElement('div');
		el.id = 'fps-meter';
		el.setAttribute('aria-hidden', 'true');
		el.textContent = '… fps';
		document.body.append(el);
	}
	if (el) el.hidden = !on;
}

/** Apply saved graphics settings live (no reload). `saved` is the settings.graphics.gfx object. */
function setGraphics(saved) {
	const json = JSON.stringify(saved || {});
	if (R.q && R.renderer && json === R.gfxJson) return R.q; // an unrelated setting changed
	R.gfxJson = json;
	R.saved = Object.assign({}, saved || {});
	const prev = R.q;
	const q = GFX.resolve(R.saved, R.detected);
	R.q = q;
	if (!R.renderer) return q;
	const THREE = three();

	// shadows: enable + map size; materials recompile when the shadow state changes
	const size = q.shadowMap;
	const had = prev ? prev.shadowMap > 0 : null;
	R.renderer.shadowMap.enabled = size > 0;
	R.keyLight.castShadow = size > 0;
	if (size > 0 && R.keyLight.shadow.mapSize.x !== size) {
		R.keyLight.shadow.mapSize.set(size, size);
		if (R.keyLight.shadow.map) { R.keyLight.shadow.map.dispose(); R.keyLight.shadow.map = null; }
	}
	if (had !== null && had !== size > 0) markMaterialsDirty();

	// particle budget: particles above a smaller budget would freeze on screen, so retire them
	const budget = q.particleBudget;
	if (R.particles && budget !== R.particleBudget) {
		const arr = R.particles.geometry.attributes.position.array;
		for (let i = 0; i < R.particleData.length; i++) { R.particleData[i].life = 0; arr[i * 3 + 1] = -10; }
		R.particleCursor = 0;
		R.particles.geometry.attributes.position.needsUpdate = true;
	}
	R.particleBudget = budget;

	// scenery detail rebuilds the course views from their retained descriptors
	if (prev && prev.detail !== q.detail && R.course) {
		loadCourse(R.course, R.theme);
		if (R.currentState) applySnapshot(R.currentState);
	}
	if (prev && prev.water !== q.water) {
		for (const m of R.waterMats) m.opacity = m.normalMap ? 0.86 : 0.85;
	}
	applyEnvironment();

	R.adaptiveScale = 1;
	R.frames = [];
	R.postKey = null; // rebuild the post chain on the next frame
	R.postFailed = false;
	fpsVisible(q.showFps);
	if (R.canvas) { R.canvas.dataset.gfxPreset = q.preset; R.canvas.dataset.gfxAuto = q.auto ? '1' : '0'; }
	if (THREE && R.width) applySize();
	R.dirty = true;
	return q;
}

/** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
function graphicsInfo(t) {
	const q = R.q || GFX.resolve(R.saved, R.detected);
	const px = [Math.round((R.width || 0) * (R.pixelRatio || 1)), Math.round((R.height || 0) * (R.pixelRatio || 1))];
	return {
		gpu: R.gpu,
		detected: R.detected,
		resolved: q,
		summary: GFX.describe(q, R.width ? px : null, t),
		pixels: px,
		fps: Math.round(R.fps || 0),
		adaptiveScale: Math.round(R.adaptiveScale * 100) / 100,
		postFailed: !!R.postFailed,
	};
}

// Legacy entry point: a single tier maps onto a preset.
function setQuality(tier) { return setGraphics(Object.assign({}, R.saved, { preset: GFX.fromLegacyTier(tier) })); }

function setHidden(h) {
	R.hidden = !!h;
	if (h) lastT = 0; // decorative motion pauses while hidden
	R.frames = [];
}

function setReducedMotion(v) { R.reducedMotion = !!v; R.dirty = true; }
function setHighContrast(v) {
	const changed = R.highContrast !== !!v;
	R.highContrast = !!v;
	if (changed) R.postKey = null;
}

// Skip/fast-forward: settle the trace into its exact deterministic end state immediately.
function skipTrace() { finishTrace(); }

const api = {
	setPaused(v) { R.paused = !!v; R.dirty = true; },
	isPlaying() { return !!R.trace; },
	CAM, GFX, init, loadCourse, applySnapshot, setAim, playTrace, resize, courseDelta,
	setGraphics, graphicsInfo, setQuality,
	setHidden, setReducedMotion, setHighContrast, disposeCourse, skipTrace,
	set currentState(v) { R.currentState = v; },
	get currentState() { return R.currentState; },
	set onEvent(fn) { R.onEvent = fn; },
	set onFatal(fn) { R.onFatal = fn; },
	get ready() { return !!R.renderer; },
	get course() { return R.course; },
	get tier() { return R.q ? R.q.preset : null; },
	get _R() { return R; },
};

if (isNode) module.exports = api;
else { window.PG = window.PG || {}; window.PG.render = api; }
})();
