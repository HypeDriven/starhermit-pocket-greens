'use strict';
(function () {

// Pocket Greens — render: Three.js scene graph, semantic entity views, camera, lighting,
// VFX, quality. Rendering consumes immutable snapshots plus interpolation data and never
// mutates rules state. World mapping: course (x, y) -> world (x, 0, z); y is up.

const RULES = (typeof module !== 'undefined' && module.exports) ? require('./rules') : window.PG.rules;

function three() { return (typeof window !== 'undefined') ? window.THREE : null; }

// Authored framing constants — no magic offsets sprinkled through the code.
const CAM = {
	elevationDeg: 52,          // low-distortion perspective, near-tabletop feel
	fov: 42,
	margin: 1.5,               // course-to-frame margin (leaves room for the HUD rails/tray)
	transitionMs: 700,         // hole-change swoop (disabled by reduced motion)
};

const QUALITY = {
	low: { dpr: 1, shadows: false, particles: 64, antialias: false, scale: 0.75 },
	medium: { dpr: 1.5, shadows: true, particles: 256, antialias: true, scale: 1 },
	high: { dpr: 2, shadows: true, particles: 1024, antialias: true, scale: 1 },
};

const R = {
	renderer: null, scene: null, camera: null, canvas: null,
	courseGroup: null, ballMeshes: {}, ghost: null, aimArrow: null,
	particles: null, particleData: [], ripples: [],
	movers: [], waterMats: [], course: null, theme: null,
	tier: 'medium', reducedMotion: false, highContrast: false,
	camFrom: null, camTo: null, camT: 1,
	trace: null, traceI: 0, traceSpeed: 1, traceDone: null, traceEvents: [],
	lastTick: 0, running: false, raf: 0, hidden: false,
	width: 0, height: 0,
};

// ---------- lifecycle ----------

function init(canvas, opts) {
	const THREE = three();
	if (!THREE) throw new Error('three-not-loaded');
	opts = opts || {};
	R.canvas = canvas;
	const q0 = QUALITY[opts.tier] || QUALITY.medium;
	R.renderer = new THREE.WebGLRenderer({ canvas, antialias: q0.antialias, powerPreference: 'high-performance' });
	R.renderer.outputColorSpace = THREE.SRGBColorSpace;
	R.renderer.toneMapping = THREE.ACESFilmicToneMapping;
	R.renderer.toneMappingExposure = 1.0;
	R.scene = new THREE.Scene();
	R.camera = new THREE.PerspectiveCamera(CAM.fov, 1, 0.1, 200);

	// one dominant key light + soft environment fill; contact grounding via shadow
	const key = new THREE.DirectionalLight(0xfff4e0, 1.6);
	key.position.set(6, 12, 4);
	key.castShadow = true;
	key.shadow.mapSize.set(1024, 1024);
	const fill = new THREE.HemisphereLight(0xcfe4ff, 0x33402a, 0.55);
	R.scene.add(key, fill);
	R.keyLight = key;

	// pooled particle system (Points); cosmetic only, never raycast
	const pgeo = new THREE.BufferGeometry();
	const max = 1024;
	pgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
	const pmat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.9, depthWrite: false });
	R.particles = new THREE.Points(pgeo, pmat);
	R.particles.frustumCulled = false;
	R.particles.raycast = function () {}; // effects never intercept picking
	R.scene.add(R.particles);
	for (let i = 0; i < max; i++) R.particleData.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });
	R.particleCursor = 0;

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

	setQuality(opts.tier || 'medium');
	R.reducedMotion = !!opts.reducedMotion;
	// a re-init (context restore) must not leave the previous rAF chain running
	if (R.raf) cancelAnimationFrame(R.raf);
	R.courseGroup = null;   // the old group belongs to the discarded scene
	R.flag = null;
	R.ballMeshes = {};
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
			if (c) init(R.canvas, { tier: R.tier, reducedMotion: R.reducedMotion }) && loadCourse(c, t);
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
	R.movers = [];
	R.waterMats = [];
	R.ripples = [];
	for (const k of Object.keys(R.ballMeshes)) { R.scene.remove(R.ballMeshes[k]); delete R.ballMeshes[k]; }
}

// ---------- course construction (procedural, inspectable meshes) ----------

function loadCourse(course, theme) {
	const THREE = three();
	disposeCourse();
	R.course = course; R.theme = theme;
	const P = theme.palette;
	const g = new THREE.Group();
	R.scene.background = new THREE.Color(P.sky);

	// green: subtle procedural texture via vertex-colored plane stripes
	const green = new THREE.Mesh(
		new THREE.BoxGeometry(course.w, 0.3, course.h),
		new THREE.MeshStandardMaterial({ color: P.green, roughness: 0.95 })
	);
	green.position.set(course.w / 2, -0.15, course.h / 2);
	green.receiveShadow = true;
	green.userData.layer = 'gameplay';
	g.add(green);
	// rough surround
	const rough = new THREE.Mesh(
		new THREE.BoxGeometry(course.w + 3, 0.2, course.h + 3),
		new THREE.MeshStandardMaterial({ color: P.rough, roughness: 1 })
	);
	rough.position.set(course.w / 2, -0.32, course.h / 2);
	rough.receiveShadow = true;
	rough.userData.layer = 'environment';
	g.add(rough);

	const wallMat = new THREE.MeshStandardMaterial({ color: P.wall, roughness: 0.8 });
	// boundary rails
	const railH = 0.34, railT = 0.28;
	[[course.w / 2, -railT / 2, course.w + railT * 2, railT], [course.w / 2, course.h + railT / 2, course.w + railT * 2, railT],
	 [-railT / 2, course.h / 2, railT, course.h], [course.w + railT / 2, course.h / 2, railT, course.h]].forEach(b => {
		const m = new THREE.Mesh(new THREE.BoxGeometry(b[2], railH, b[3]), wallMat);
		m.position.set(b[0], railH / 2, b[1]);
		m.castShadow = m.receiveShadow = true;
		m.userData.layer = 'gameplay';
		g.add(m);
	});

	for (const w of course.walls) {
		const m = new THREE.Mesh(new THREE.BoxGeometry(w.w, railH, w.h), wallMat);
		m.position.set(w.x + w.w / 2, railH / 2, w.y + w.h / 2);
		m.castShadow = m.receiveShadow = true;
		m.userData.layer = 'gameplay';
		g.add(m);
	}

	const obMat = new THREE.MeshStandardMaterial({ color: P.obstacle, roughness: 0.7 });
	for (const o of course.obstacles) {
		if (o.type === 'circle') {
			const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r, o.r * 1.1, 0.5, 20), obMat);
			m.position.set(o.x, 0.25, o.y);
			m.castShadow = m.receiveShadow = true;
			m.userData.layer = 'gameplay';
			g.add(m);
		} else {
			const m = new THREE.Mesh(new THREE.BoxGeometry(o.w, 0.45, o.h), obMat);
			m.position.set(o.x + o.w / 2, 0.225, o.y + o.h / 2);
			m.castShadow = m.receiveShadow = true;
			m.userData.layer = 'gameplay';
			g.add(m);
		}
	}

	// water: semi-transparent animated surface; interaction ripples are pooled ring meshes
	for (const z of course.water) {
		const w = z.w || z.r * 2, h = z.h || z.r * 2;
		const cx = z.type === 'circle' ? z.x : z.x + z.w / 2;
		const cy = z.type === 'circle' ? z.y : z.y + z.h / 2;
		const mat = new THREE.MeshStandardMaterial({
			color: P.water, transparent: true, opacity: 0.85, roughness: 0.15, metalness: 0.35,
		});
		const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.08, h), mat);
		m.position.set(cx, -0.02, cy);
		m.userData.layer = 'environment';
		g.add(m);
		R.waterMats.push(mat);
	}

	const sandMat = new THREE.MeshStandardMaterial({ color: P.sand, roughness: 1 });
	for (const z of course.sand) {
		const w = z.w || z.r * 2, h = z.h || z.r * 2;
		const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, h), sandMat);
		m.position.set(z.type === 'circle' ? z.x : z.x + z.w / 2, 0.01, z.type === 'circle' ? z.y : z.y + z.h / 2);
		m.receiveShadow = true;
		m.userData.layer = 'gameplay';
		g.add(m);
	}

	const mvMat = new THREE.MeshStandardMaterial({ color: P.mover, roughness: 0.5 });
	for (const mv of course.movers) {
		const m = new THREE.Mesh(new THREE.CylinderGeometry(mv.r, mv.r, 0.7, 18), mvMat);
		m.castShadow = true;
		m.userData.layer = 'gameplay';
		g.add(m);
		R.movers.push({ def: mv, mesh: m });
	}

	// cup: dark recessed ring + flag for readability at distance
	const cupM = new THREE.Mesh(
		new THREE.CylinderGeometry(RULES.CUP_R, RULES.CUP_R, 0.05, 24),
		new THREE.MeshStandardMaterial({ color: P.cup, roughness: 0.9 })
	);
	cupM.position.set(course.cup.x, 0.03, course.cup.y);
	cupM.userData.layer = 'gameplay';
	g.add(cupM);
	const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 8), new THREE.MeshStandardMaterial({ color: 0xf0f0f0 }));
	pole.position.set(course.cup.x, 0.55, course.cup.y);
	const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.26), new THREE.MeshBasicMaterial({ color: R.highContrast ? 0xffff00 : 0xe64545, side: THREE.DoubleSide }));
	flag.userData.layer = 'ui-anchor';
	g.add(pole, flag);
	R.flag = flag;

	R.courseGroup = g;
	R.scene.add(g);
	frameCamera(course, true);
}

function ballMesh(id, color) {
	const THREE = three();
	if (R.ballMeshes[id]) return R.ballMeshes[id];
	const m = new THREE.Mesh(
		new THREE.SphereGeometry(RULES.BALL_R, 24, 18),
		new THREE.MeshStandardMaterial({ color: color || 0xf5f6fa, roughness: 0.35 })
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
	const t = cameraTarget(course);
	R.azimuth = t.azimuth;
	// the flag is a single quad: turn it to face the camera so it never goes edge-on
	if (R.flag) {
		R.flag.rotation.y = t.azimuth;
		R.flag.position.set(course.cup.x + 0.21 * Math.cos(t.azimuth), 0.95, course.cup.y - 0.21 * Math.sin(t.azimuth));
	}
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
}

// Aim preview: direction arrow scaled by power. Legal targets preview before commit.
function setAim(ballPos, angle, power) {
	const THREE = three();
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
	const THREE = three();
	const budget = QUALITY[R.tier].particles;
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
	const budget = QUALITY[R.tier].particles;
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
	if (R.paused) return;
	const dt = dtMs / 1000;

	updateCamera(dtMs);

	// movers are a pure function of the simulation tick being displayed
	const shownTick = (R.trace && R.trace[R.traceI]) ? R.trace[R.traceI].t : R.lastTick;
	for (const mv of R.movers) {
		const p = RULES.moverPos(mv.def, shownTick);
		mv.mesh.position.set(p.x, 0.35, p.y);
	}

	// water shimmer: seeded slow opacity/roughness wave, cosmetic only
	for (let i = 0; i < R.waterMats.length; i++) {
		R.waterMats[i].opacity = 0.78 + Math.sin(t * 0.0012 + i * 1.7) * 0.07;
	}

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
	R.renderer.render(R.scene, R.camera);
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
	const d = R.traceDone; R.traceDone = null;
	if (d) d();
}

function resize(w, h) {
	if (!R.renderer || !w || !h) return;
	R.width = w; R.height = h;
	const q = QUALITY[R.tier];
	R.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.dpr) * q.scale);
	R.renderer.setSize(Math.floor(w), Math.floor(h), false);
	R.camera.aspect = w / h;
	R.camera.updateProjectionMatrix();
	// framing depends on the aspect ratio, so a resize/rotate has to re-frame the course
	if (R.course) frameCamera(R.course, true);
}

function setQuality(tier) {
	if (!QUALITY[tier]) tier = 'medium';
	const shrinking = R.particles && QUALITY[tier].particles < QUALITY[R.tier].particles;
	R.tier = tier;
	if (shrinking) {
		// particles above the new budget stop being updated: retire them so none freeze on screen
		const arr = R.particles.geometry.attributes.position.array;
		for (let i = 0; i < R.particleData.length; i++) { R.particleData[i].life = 0; arr[i * 3 + 1] = -10; }
		R.particleCursor = 0;
		R.particles.geometry.attributes.position.needsUpdate = true;
	}
	if (R.renderer) {
		R.renderer.shadowMap.enabled = QUALITY[tier].shadows;
		if (R.keyLight) R.keyLight.castShadow = QUALITY[tier].shadows;
		if (R.width) resize(R.width, R.height);
	}
}

function setHidden(h) {
	R.hidden = !!h;
	if (h) lastT = 0; // decorative motion pauses while hidden
}

function setReducedMotion(v) { R.reducedMotion = !!v; }
function setHighContrast(v) { R.highContrast = !!v; }

// Skip/fast-forward: settle the trace into its exact deterministic end state immediately.
function skipTrace() { finishTrace(); }

const api = {
	setPaused(v) { R.paused = !!v; },
	isPlaying() { return !!R.trace; },
	CAM, QUALITY, init, loadCourse, applySnapshot, setAim, playTrace, resize, courseDelta,
	setQuality, setHidden, setReducedMotion, setHighContrast, disposeCourse, skipTrace,
	set currentState(v) { R.currentState = v; },
	get currentState() { return R.currentState; },
	set onEvent(fn) { R.onEvent = fn; },
	set onFatal(fn) { R.onFatal = fn; },
	get ready() { return !!R.renderer; },
	get course() { return R.course; },
	get tier() { return R.tier; },
	get _R() { return R; },
};

if (typeof module !== 'undefined' && module.exports) module.exports = api;
else { window.PG = window.PG || {}; window.PG.render = api; }
})();
