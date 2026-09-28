/**
 * Pocket Greens — end-to-end playthrough test (dev only, not shipped).
 *
 * Drives the real visible UI in headless Chrome via playwright-core:
 *   title → menu → Practice → hole j01 → set power on the real power slider
 *   → press Strike → the ball rolls and holes out → round completes → the
 *   Results overlay shows the score breakdown. Also exercises Pause/Resume,
 *   Settings open/close (enabling sound captions, which the stroke must then
 *   surface as an on-screen caption chip), Help open/close and the Hint button through the
 *   visible on-screen controls. A second, shorter pass drives the same
 *   practice flow with touch input (touchscreen.tap) on a mobile viewport.
 *
 * The game is an authoritative minigolf/course engine: `starhermit.txt`
 * declares `server=server.js` and the client boot-syncs clock time via
 * `GET /api/v1/time` (a real object with `now`), runs a presence heartbeat
 * and submits hosted sessions / scores to the same server. Because those
 * routes carry real payloads (nothing degrades the app if they are missing,
 * but `/api/v1/time` must return `{now}`, and presence/telemetry POSTs are
 * expected), this test launches the real `node server.js` backend on an
 * ephemeral port — the same approach the sibling authoritative titles use —
 * rather than the static-SPA `/api -> {}` stub. The page is pointed at it and
 * the child is killed in teardown.
 *
 * The test observes `window.PG.game` (bootstrap.js: `window.PG.game = G`)
 * read-only: it only reads the machine/phase, the current aim, the ball and
 * the round results, and it verifies the power slider actually updates the
 * game's aim. It never calls the game's move API — every stroke is a real
 * click/tap on the visible Strike button (or the canvas/keyboard) and the
 * aim is changed only through the real power slider. No game code is modified.
 *
 * Run: npm run test:e2e  (or: node tests/e2e.mjs)
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = (stage, vp) => `/tmp/pocket-greens-e2e-${stage}-${vp}.png`;
const SERVER_SRC = path.join(ROOT, 'server.js');
const NODE = process.execPath;

// benign GPU/swiftshader noise (mirrors tools/production_game_audit.mjs)
const browserNoise = /GL Driver Message|GPU stall due to ReadPixels|Automatic fallback to software WebGL|EnableWebGLDeveloperExtensions|WebGL: INVALID|GroupMarkerNotSet/i;

// ---------- helpers: pick a free port ----------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------- spawn the authoritative backend ----------
const PORT = await getFreePort();
const BASE = `http://127.0.0.1:${PORT}`;
const serverChild = spawn(NODE, [SERVER_SRC], {
  env: Object.assign({}, process.env, { PORT: String(PORT) }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

// wait until the server reports it is listening
async function waitForServer(proc, url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited early (code ${proc.exitCode})`);
    try {
      const r = await fetch(url + '/api/v1/time');
      if (r.ok) { await r.json(); return; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not become ready within 10s');
}
await waitForServer(serverChild, BASE);
console.log(`serving ${ROOT} at ${BASE} (backend pid ${serverChild.pid})`);

let failures = 0;
const ok = (name) => console.log(`ok - ${name}`);

// ---------- read-only observation of the game state handle ----------
// window.PG.game is the game's own inspectable state (bootstrap.js).
// Read only: machine/phase, current aim, ball + result counters.
const readState = (page) => page.evaluate(() => {
  const g = window.PG?.game;
  if (!g) return null;
  const st = g.session?.state;
  if (!st) return null;
  const me = st.players[st.currentPlayer];
  return {
    machine: g.machine,
    phase: st.phase,
    current: me.id,
    terminal: st.terminal || null,
    holeResults: st.holeResults.length,
    strokes: me.strokes,
    penalties: me.penalties,
    ball: { x: me.ball.x, y: me.ball.y },
    aimPower: g.aim ? g.aim.power : null,
    aimAngle: g.aim ? g.aim.angle : null,
  };
});

const waitPlayActive = (page) =>
  page.waitForFunction(() => {
    const g = window.PG?.game;
    return !!g && g.machine === 'active' && g.session && g.session.state &&
      g.session.state.phase === 'aim' &&
      g.session.state.players[g.session.state.currentPlayer].id !== 'ai';
  }, null, { timeout: 15000 });

// Start Practice on hole j01 (the first authored hole, par 2, no hazards).
async function startPractice(page) {
  await page.click('#m-practice');
  await page.waitForSelector('#screen-setup.open', { timeout: 8000 });
  // pick the first practice hole from the visible grid
  await page.click('#setup-body [data-idx="0"]');
  await page.click('#setup-start');
  await page.waitForSelector('#screen-title.open', { timeout: 8000 }).catch(() => {}); // may already be closed
  await waitPlayActive(page);
}

// Move the real power slider (min 1, max 100, default 50) to ~`frac` of its
// track, then confirm the displayed/aimed power via the read-only handle.
async function setPowerViaSlider(page, frac) {
  const box = await page.locator('#power').boundingBox();
  if (!box) throw new Error('power slider not visible');
  await page.locator('#power').click({ position: { x: box.width * frac, y: box.height / 2 } });
  // the authoritative value is the game's aimed power, set via the slider input event
  await page.waitForFunction(() => {
    const g = window.PG?.game;
    return !!g && g.aim && Number.isFinite(g.aim.power);
  }, null, { timeout: 3000 });
  const st = await readState(page);
  return st ? st.aimPower : null;
}

// ---------- one full pass ----------
async function runPass(browser, name, ctxOpts, { full, touch }) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type()) || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console ${m.type()}: ${m.text()}`);
  });
  page.on('response', (r) => {
    const p = r.url();
    if (r.status() >= 400 && !/\/api\/|\/favicon/.test(p)) errors.push(`http ${r.status()}: ${p}`);
  });

  const posTap = async (page, sel, xf, yf) => {
    const box = await page.locator(sel).boundingBox();
    if (!box) throw new Error(`${sel} not visible`);
    const x = box.x + box.width * xf, y = box.y + box.height * yf;
    if (touch) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
  };

  try {
    // load + title
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.open', { timeout: 15000 });
    await page.waitForFunction(() => !!window.PG?.game, null, { timeout: 15000 });
    await page.screenshot({ path: SHOT('title', name) });
    ok(`${name}: title screen visible`);

    // start Practice on hole j01
    await startPractice(page);
    const st0 = await readState(page);
    if (st0.phase !== 'aim' || st0.current !== 'you') throw new Error(`expected aim phase for you, got ${JSON.stringify(st0)}`);
    if (st0.strokes !== 0 || st0.penalties !== 0) throw new Error('unexpected starting score state');
    const hole = await page.textContent('#stat-hole');
    const par = await page.textContent('#stat-par');
    const objective = await page.textContent('#objective');
    if (!/Aim and strike/i.test(objective)) throw new Error(`unexpected objective: "${objective}"`);
    await page.screenshot({ path: SHOT('play', name) });
    ok(`${name}: practice hole active (${objective.trim()}, hole ${hole.trim()}, par ${par.trim()})`);

    if (full) {
      // pause / resume via the visible buttons
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause.open', { timeout: 5000 });
      await page.screenshot({ path: SHOT('pause', name) });
      await page.click('#p-resume');
      await page.waitForFunction(() => !document.getElementById('overlay-pause').classList.contains('open'));
      await waitPlayActive(page);
      ok(`${name}: pause (⏸ Pause) and resume work`);

      // settings open/close
      await page.click('#btn-settings');
      await page.waitForSelector('#overlay-settings.open', { timeout: 5000 });
      ok(`${name}: settings dialog opened`);
      await page.screenshot({ path: SHOT('settings', name) });
      // enable sound captions so the stroke acknowledgment chip is verified end-to-end below
      await page.locator('#settings-body [data-set="audio.captions"]').check();
      await page.click('#settings-close');
      await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('open'));

      // help open/close
      await page.click('#btn-help');
      await page.waitForSelector('#overlay-help.open', { timeout: 5000 });
      await page.click('#help-close');
      await page.waitForFunction(() => !document.getElementById('overlay-help').classList.contains('open'));
      ok(`${name}: settings + help overlays open and close`);

      // hint: sets the aim toward the cup (via the legal-action API) and updates the slider
      const beforeHint = await readState(page);
      await page.click('#btn-hint');
      const afterHint = await readState(page);
      if (!(afterHint.aimAngle != null && Number.isFinite(afterHint.aimAngle))) throw new Error('hint did not set an aim angle');
      if (afterHint.aimAngle === beforeHint.aimAngle && afterHint.strokes === beforeHint.strokes) {
        // aim may coincide with default; ensure slider moved to hint power
        const shown = Number(await page.textContent('#power-val'));
        if (shown === beforeHint.aimPower) throw new Error('hint had no observable effect on aim');
      }
      ok(`${name}: hint sets aim toward the cup (power ${Number(await page.textContent('#power-val'))}%)`);

      // set power high enough to hole j01 along the straight cup line, via the real slider
      const pwr = await setPowerViaSlider(page, 0.92);
      if (pwr < 85) throw new Error(`slider produced power ${pwr}, need >=85 to hole j01`);
      ok(`${name}: power slider set to ${pwr}%`);

      // strike through the real on-screen button
      await page.click('#btn-strike');
      // the strike is a captioned sound: the chip must appear while the ball rolls
      await page.waitForSelector('#captions.show', { timeout: 3000 });
      ok(`${name}: stroke caption shown (sound captions wired)`);
      await page.click('#btn-pause');
      await page.waitForSelector('#overlay-pause.open');
      await page.waitForTimeout(2500);
      if (await page.locator('#overlay-results.open').count()) throw new Error('ball playback finished behind pause');
      await page.getByRole('button', { name: 'Resume', exact: true }).click();
      await page.waitForSelector('#overlay-results.open', { timeout: 20000 });
      const stDone = await readState(page);
      if (!stDone || !stDone.terminal) throw new Error('round did not reach a terminal state');
      if (stDone.strokes < 1) throw new Error('strike was not counted');
      await page.screenshot({ path: SHOT('results', name) });

      // results breakdown: player 'you' total should be 1 (one-stroke hole-out)
      const headline = await page.textContent('#results-body') || '';
      if (!/par/i.test(headline)) throw new Error(`unexpected results headline: "${headline}"`);
      const rows = await page.locator('#results-body tr').count();
      if (rows < 2) throw new Error('score breakdown table is empty'); // header + ≥1 row
      const total = await page.evaluate(() => {
        const t = window.PG?.game?.session?.result?.results?.find((r) => r.id !== 'ai');
        return t ? t.total : null;
      });
      if (total !== 1) throw new Error(`expected one-stroke total, got ${total}`);
      ok(`${name}: struck and holed out — round complete, score breakdown shown (total ${total}, ${rows - 1} player row(s))`);

      // main menu return works from results
      await page.click('#r-menu');
      await page.waitForSelector('#screen-title.open', { timeout: 8000 });
      ok(`${name}: returned to main menu from results`);
    } else {
      // mobile: start the hole, set power on the slider, then tap Strike via touch
      const pwr = await setPowerViaSlider(page, 0.92);
      if (pwr < 85) throw new Error(`slider produced power ${pwr}, need >=85 to hole j01`);
      // tap the power slider directly, then the Strike button with the touchscreen
      await posTap(page, '#btn-strike', 0.5, 0.5);
      await page.waitForSelector('#overlay-results.open', { timeout: 20000 });
      const stDone = await readState(page);
      if (!stDone || !stDone.terminal) throw new Error('mobile round did not reach a terminal state');
      const total = await page.evaluate(() => {
        const t = window.PG?.game?.session?.result?.results?.find((r) => r.id !== 'ai');
        return t ? t.total : null;
      });
      if (total !== 1) throw new Error(`expected one-stroke mobile total, got ${total}`);
      await page.screenshot({ path: SHOT('mobile-results', name) });
      ok(`${name}: started practice and holed out via touchscreen.tap on Strike (total ${total})`);
    }
  } finally {
    await context.close();
  }

  if (errors.length) throw new Error(`${name} pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name}: no page errors`);
}

// ---------- modes pass: challenge (+ restart hole), hosted match, learn ----------
// These flows are not on the practice happy path but share the same round lifecycle,
// so they are where a lost challenge, a wrong seat id or a missing result envelope shows up.
async function runModesPass(browser) {
  const errors = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type()) || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console ${m.type()}: ${m.text()}`);
  });

  const strikeUntilResults = async (max) => {
    for (let i = 0; i < max; i++) {
      if (await page.locator('#overlay-results.open').count()) return true;
      try { await page.waitForSelector('#btn-strike:not([disabled])', { timeout: 8000 }); }
      catch { return !!(await page.locator('#overlay-results.open').count()); }
      await page.click('#btn-strike');
      await page.waitForTimeout(400);
    }
    return !!(await page.locator('#overlay-results.open').count());
  };

  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.open', { timeout: 15000 });

    // --- challenge: the constraint must survive "Restart hole" ---
    await page.click('#m-challenge');
    await page.waitForSelector('#screen-setup.open', { timeout: 8000 });
    await page.click('#setup-body [data-idx="0"]');
    await page.click('#setup-start');
    await waitPlayActive(page);
    const chBefore = await page.evaluate(() => window.PG?.game?.session?.challenge?.id || null);
    if (!chBefore) throw new Error('challenge round started without a challenge');
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause.open', { timeout: 5000 });
    await page.click('#p-restart');
    await waitPlayActive(page);
    const chAfter = await page.evaluate(() => window.PG?.game?.session?.challenge?.id || null);
    if (chAfter !== chBefore) throw new Error(`restart hole dropped the challenge: ${chBefore} -> ${chAfter}`);
    ok(`modes: restart hole keeps the challenge (${chAfter})`);

    // play it out — results must render the challenge verdict, not throw
    if (!await strikeUntilResults(8)) throw new Error('challenge round never reached results');
    const chBody = await page.textContent('#results-body') || '';
    if (!/Challenge/i.test(chBody)) throw new Error(`results missing challenge verdict: "${chBody}"`);
    ok('modes: challenge results show a verdict');
    await page.click('#r-menu');
    await page.waitForSelector('#screen-title.open', { timeout: 8000 });

    // leaving a round must retire the HUD (no live Pause button on the title screen)
    if (!await page.locator('#btn-pause[disabled]').count()) throw new Error('Pause stayed enabled after leaving the round');
    ok('modes: leaving a round resets the HUD');

    // --- hosted: the client must use the server-assigned seat id ---
    await page.click('#m-hosted');
    await page.waitForSelector('#screen-lobby.open', { timeout: 8000 });
    await page.waitForFunction(() => !!window.PG?.game?.hosted?.sessionId, null, { timeout: 10000 });
    const seat = await page.evaluate(() => window.PG.game.hosted.playerId);
    await page.click('#lobby-body button.primary'); // "Enter match"
    await waitPlayActive(page);
    const seats = await page.evaluate(() => window.PG.game.session.state.players.map((p) => p.id));
    if (!seats.includes(seat)) throw new Error(`local session seats ${JSON.stringify(seats)} exclude server seat ${seat}`);
    const turn0 = await readState(page);
    if (turn0.current !== seat) throw new Error(`expected to control seat ${seat}, current is ${turn0.current}`);
    await page.click('#btn-strike');
    // the server must accept the stroke: its tick advances and the turn passes on
    await page.waitForFunction((s) => {
      const st = window.PG?.game?.session?.state;
      return !!st && (st.players.find((p) => p.id === s)?.strokes ?? 0) >= 1;
    }, seat, { timeout: 20000 });
    ok(`modes: hosted match accepted an authoritative stroke as seat "${seat}"`);
    await page.click('#btn-pause').catch(() => {});
    await page.waitForSelector('#overlay-pause.open', { timeout: 5000 });
    await page.click('#p-leave');
    await page.waitForSelector('#screen-title.open', { timeout: 8000 });
    ok('modes: left the hosted match cleanly');

    // --- learn: the lesson objective must be on screen, and must not leak into the next mode ---
    await page.click('#m-learn');
    await waitPlayActive(page);
    const lessonObjective = await page.textContent('#objective');
    if (!/—/.test(lessonObjective)) throw new Error(`unexpected lesson objective: "${lessonObjective}"`);
    ok(`modes: learn lesson active (${lessonObjective.trim().slice(0, 48)}…)`);
    await page.click('#btn-pause');
    await page.waitForSelector('#overlay-pause.open', { timeout: 5000 });
    await page.click('#p-leave');
    await page.waitForSelector('#screen-title.open', { timeout: 8000 });
    await startPractice(page);
    const practiceObjective = await page.textContent('#objective');
    if (practiceObjective === lessonObjective) throw new Error('lesson objective leaked into the practice round');
    ok('modes: lesson state does not leak into the next round');
  } finally {
    await context.close();
  }
  if (errors.length) throw new Error(`modes pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log('ok - modes: no page errors');
}

// ---------- graphics pass: presets, an override, persistence (desktop + mobile) ----------
// Drives Settings → Graphics through the visible controls. Headless Chrome runs on a
// software GPU, so Auto must resolve to Low; Low and Ultra must both render without
// console output; a chosen preset and override must apply live and survive a reload.
async function runGraphicsPass(browser, name, ctxOpts) {
  const errors = [];
  const context = await browser.newContext(ctxOpts);
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (!['error', 'warning'].includes(m.type()) || browserNoise.test(m.text())) return;
    const url = m.location()?.url || '';
    if (/Failed to load resource/.test(m.text()) && /\/api\/|\/favicon/.test(url)) return;
    errors.push(`console ${m.type()}: ${m.text()}`);
  });
  const canvasPreset = () => page.getAttribute('#game-canvas', 'data-gfx-preset');
  const waitPreset = (p) => page.waitForFunction((p) => document.getElementById('game-canvas').dataset.gfxPreset === p, p, { timeout: 8000 });
  const openGraphics = async () => {
    await page.click('#btn-settings');
    await page.waitForSelector('#overlay-settings.open', { timeout: 5000 });
    await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
    if (!await page.locator('#gfx-preset').isVisible()) throw new Error('Graphics quality select not visible');
  };
  const closeSettings = async () => {
    await page.locator('#settings-close').scrollIntoViewIfNeeded();
    await page.click('#settings-close');
    await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('open'));
  };
  try {
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForSelector('#screen-title.open', { timeout: 15000 });
    await waitPreset('low');
    ok(`${name}: Auto graphics resolved to Low on the software GPU`);
    await startPractice(page);
    await openGraphics();
    const autoLabel = await page.locator('#gfx-preset option[value="auto"]').textContent();
    if (!/Low/.test(autoLabel)) throw new Error(`auto option does not name the detected tier: "${autoLabel}"`);

    await page.selectOption('#gfx-preset', 'ultra');
    await waitPreset('ultra');
    await page.waitForTimeout(1200); // let the full post chain (GTAO, bloom, grade, MSAA) render
    const ultraSummary = await page.textContent('#gfx-summary');
    if (!/4096² shadows/.test(ultraSummary) || !/px/.test(ultraSummary)) throw new Error(`unexpected Ultra summary: "${ultraSummary}"`);
    await page.selectOption('#gfx-preset', 'low');
    await waitPreset('low');
    await page.waitForTimeout(400);
    await page.selectOption('#gfx-preset', 'high');
    await waitPreset('high');
    ok(`${name}: presets Ultra → Low → High apply live (${ultraSummary.split(' · ').slice(-1)[0]})`);

    // one per-category override: bloom off
    if (await page.inputValue('#gfx-bloom') !== 'preset') throw new Error('choosing a preset did not reset the overrides');
    await page.locator('#gfx-bloom').scrollIntoViewIfNeeded();
    await page.selectOption('#gfx-bloom', 'off');
    await page.waitForFunction(() => !/bloom/.test(document.getElementById('gfx-summary').textContent), null, { timeout: 5000 });
    const applied = await page.evaluate(() => window.PG.render.graphicsInfo().resolved.bloom);
    if (applied !== 'off') throw new Error(`bloom override not applied (${applied})`);
    ok(`${name}: bloom override applied live`);
    await page.screenshot({ path: SHOT('graphics', name) });
    // the panel must fit: the Done button is reachable inside the scrolling card
    await closeSettings();

    // persistence across reload
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#screen-title.open', { timeout: 15000 });
    await waitPreset('high');
    await startPractice(page);
    await openGraphics();
    if (await page.inputValue('#gfx-preset') !== 'high') throw new Error('preset did not survive reload');
    if (await page.inputValue('#gfx-bloom') !== 'off') throw new Error('override did not survive reload');
    ok(`${name}: High preset + bloom override survive a reload`);
    // back to Auto so later passes in this context start clean
    await page.selectOption('#gfx-preset', 'auto');
    await waitPreset('low');
    await closeSettings();
  } finally {
    await context.close();
  }
  if (errors.length) throw new Error(`${name} graphics pass had page errors:\n  ${errors.join('\n  ')}`);
  console.log(`ok - ${name} graphics: no console errors or warnings`);
}

// ---------- main ----------
let browser = null;
try {
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--mute-audio'],
  });
  await runPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } }, { full: true, touch: false });
  await runPass(browser, 'mobile',
    { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, { full: false, touch: true });
  await runModesPass(browser);
  await runGraphicsPass(browser, 'desktop', { viewport: { width: 1280, height: 800 } });
  await runGraphicsPass(browser, 'mobile', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  console.log('\nE2E PASS — pocket-greens, desktop + mobile + modes + graphics, no page errors');
} catch (e) {
  failures++;
  console.error('\nE2E FAIL:', e.message || e);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  serverChild.kill('SIGTERM');
}
if (failures) process.exit(1);
