// Graphics benchmark hook for tools/gfx-bench.mjs (dev-only): picks a preset in Settings → Graphics,
// starts a Practice hole with water and sand and keeps playing it through the real controls — Hint,
// the power slider and Strike — retrying from the results screen, so the ball rolls, splashes and
// bursts while the water, flag and pollen animate.
export const presets = ['low', 'balanced', 'high', 'ultra'];
export const levels = { low: 0, balanced: 4, high: 10, ultra: 17 };

export async function setPreset(page, preset) {
  await page.waitForSelector('#screen-title.open', { timeout: 30000 });
  await page.locator('#m-settings').scrollIntoViewIfNeeded();
  await page.click('#m-settings');
  await page.waitForSelector('#overlay-settings.open');
  await page.locator('#gfx-preset').scrollIntoViewIfNeeded();
  await page.selectOption('#gfx-preset', preset);
  await page.waitForFunction((p) => document.getElementById('game-canvas').dataset.gfxPreset === p, preset);
  await page.locator('#settings-close').scrollIntoViewIfNeeded();
  await page.click('#settings-close');
  await page.waitForFunction(() => !document.getElementById('overlay-settings').classList.contains('open'));
}

const phase = (page) => page.evaluate(() => {
  if (document.getElementById('overlay-results')?.classList.contains('open')) return 'results';
  const g = window.PG?.game, st = g?.session?.state;
  if (!g || g.machine !== 'active' || !st) return '';
  return st.phase === 'aim' && st.players[st.currentPlayer].id !== 'ai' ? 'aim' : st.phase;
});

let n = 0;
async function step(page) {
  const p = await phase(page);
  if (p === 'results') return page.click('#r-retry', { timeout: 3000 });
  if (p !== 'aim') return;
  await page.click('#btn-hint', { timeout: 2000 }).catch(() => {});
  const box = await page.locator('#power').boundingBox();
  if (box) await page.locator('#power').click({ position: { x: box.width * (0.55 + 0.1 * (n++ % 4)), y: box.height / 2 } });
  await page.click('#btn-strike', { timeout: 2000 });
}

export async function start(page) {
  await page.click('#m-practice');
  await page.waitForSelector('#screen-setup.open');
  const holes = page.locator('#setup-body [data-idx]');
  await holes.nth(Math.min(5, (await holes.count()) - 1)).click();
  await page.click('#setup-start');
  await page.waitForFunction(() => window.PG?.game?.machine === 'active', null, { timeout: 15000 });
  let open = true;
  page.once('close', () => { open = false; });
  (async () => {
    while (open) {
      try { await step(page); } catch (e) { if (!open) return; if (process.env.BENCH_DEBUG) console.error(e.message); }
      await page.waitForTimeout(500).catch(() => {});
    }
  })();
  await page.waitForTimeout(1500);
}
