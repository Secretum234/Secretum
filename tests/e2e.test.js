// End-to-end: drives the real website in headless Chrome against the sandbox (real programs in
// LiteSVM): launch a coin with a dev buy, buy, sell, fill the curve, graduate, verify certificate.
// Needs Chrome; set CHROME_PATH if it isn't at /usr/bin/google-chrome. Skips if Chrome is missing.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://localhost:${PORT}`;
let sandbox, browser, page;
const consoleErrors = [];

before(async () => {
  if (!fs.existsSync(CHROME)) return;
  sandbox = spawn(process.execPath, [path.join(__dirname, '../devtools/sandbox.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    sandbox.stdout.on('data', (d) => String(d).includes('running at') && resolve());
    sandbox.on('exit', (c) => reject(new Error('sandbox exited ' + c)));
  });
  const puppeteer = require('puppeteer-core');
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));
});
after(async () => { await browser?.close(); sandbox?.kill(); });

async function waitText(sel, text, timeout = 20000) {
  try {
    await page.waitForFunction((s, t) => [...document.querySelectorAll(s)].some((e) => e.textContent.includes(t)), { timeout }, sel, text);
  } catch (e) {
    const toasts = await page.evaluate(() => window.__toasts || []);
    const btn = await page.evaluate(() => document.querySelector('.trade .btn')?.textContent);
    throw new Error(`Timed out waiting for "${text}" in ${sel}. Toasts: ${JSON.stringify(toasts)} Button: ${btn} Console: ${JSON.stringify(consoleErrors.slice(-5))}`);
  }
}
async function clickText(sel, text) {
  await waitText(sel, text);
  await page.evaluate((s, t) => [...document.querySelectorAll(s)].find((e) => e.textContent.includes(t) && !e.disabled).click(), sel, text);
}
async function typeAmount(v) {
  const input = await page.waitForSelector('.amount input');
  await input.click({ clickCount: 3 });
  await input.type(String(v));
  await new Promise((r) => setTimeout(r, 400));
}

test('website: launch, buy, sell, fill, graduate, verify, change settings, pay out fees', { skip: !fs.existsSync(CHROME) && 'Chrome not found' }, async () => {
  await page.evaluateOnNewDocument(() => {
    window.__toasts = [];
    new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => n.classList?.contains('toast') && window.__toasts.push(n.textContent))))
      .observe(document, { childList: true, subtree: true });
  });
  await page.goto(BASE + '/');
  await page.waitForFunction(() => document.querySelectorAll('.registry .row').length >= 5, { timeout: 20000 });

  // Launch with a dev buy
  await clickText('button', 'Launch a coin');
  await page.type('#launch-form [name=name]', 'Endtoend Coin');
  await page.type('#launch-form [name=symbol]', 'ezee');
  await page.type('#launch-form [name=devBuy]', '0.5');
  await page.click('#launch-submit');
  await page.waitForFunction(() => location.hash.startsWith('#/coin/'), { timeout: 20000 });
  await waitText('h1', 'Endtoend Coin');
  await waitText('.coin-head .sym', '$EZEE');
  await waitText('.trades td', 'Buy'); // the dev buy shows in history

  // Buy
  await typeAmount(1);
  await clickText('.trade button', 'Buy EZEE');
  await waitText('.toast', 'Buy confirmed');

  // Sell half
  await clickText('.side button', 'Sell');
  await page.waitForFunction(() => /Balance: [1-9]/.test(document.querySelector('.trade .note')?.textContent || ''), { timeout: 20000 });
  await clickText('.quick button', '50%');
  await new Promise((r) => setTimeout(r, 300));
  await clickText('.trade button', 'Sell EZEE');
  await waitText('.toast', 'Sell confirmed');

  // Fill the curve (charged only what's needed), then graduate
  await clickText('.side button', 'Buy');
  await typeAmount(150);
  await waitText('.quote .warn', 'fills the curve');
  await clickText('.trade button', 'Buy EZEE');
  await waitText('.toast', 'Buy confirmed');
  await clickText('.trade button', 'Graduate to Raydium');
  await waitText('.toast', 'Graduation confirmed', 30000);
  await waitText('.trade h2', 'On Raydium');
  await waitText('.bar-label', 'Graduated');

  // Certificate recomputes in the browser
  await clickText('button', 'Verify in your browser');
  await waitText('.verify-result', 'Match');

  // Back on the registry, the new coin is listed as graduated
  await page.goto(BASE + '/#/');
  await clickText('.tabs button', 'Graduated');
  await waitText('.registry .name', 'Endtoend Coin');

  // Settings page: the sandbox wallet is the admin
  await page.goto(BASE + '/#/admin');
  await page.waitForSelector('.admin-form [name=tradeFeePct]:not([disabled])', { timeout: 20000 });
  const fee = await page.$('.admin-form [name=tradeFeePct]');
  await fee.click({ clickCount: 3 });
  await fee.type('1.5');
  await waitText('.admin li', 'Trading fee: 1% → 1.5%');
  await clickText('.admin button', 'Save changes');
  await waitText('.toast', 'Settings update confirmed');
  await page.waitForFunction(() => document.querySelector('.admin-form [name=tradeFeePct]')?.value === '1.5', { timeout: 20000 });
  await clickText('.admin button', 'Pay out fees');
  await waitText('.toast', 'Fee payout confirmed');

  const real = consoleErrors.filter((e) => !/favicon|ws:\/\/|WebSocket/i.test(e));
  assert.deepEqual(real, [], 'no console errors');
});
