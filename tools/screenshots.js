// Takes screenshots of every main screen for the documentation.
// Self-contained: creates the fictional sample data from tools/sample-data.js (people use
// the sample.test email domain), takes the screenshots, then deletes everything it created.
// Needs the app running (npm start).
// Usage: node tools/screenshots.js
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { seed, clean, PASSWORD, BASE } = require('./sample-data');
const { launch } = require('./render');

const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => { const d = new Date(Date.now() + offset * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const data = await seed();
  const resA = data.rooms[0];

  const browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });
  page.on('dialog', (d) => d.accept());
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function login(who) {
    if (page.url().startsWith(BASE)) await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await page.type('#login-email', `${who}@sample.test`);
    await page.type('#login-password', PASSWORD);
    await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#login-form button')]);
  }
  async function shot(name, url, prepare) {
    if (url) await page.goto(`${BASE}/${url}`, { waitUntil: 'networkidle0' });
    await pause(500);
    if (prepare) { await prepare(); await pause(500); }
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('  ', name);
  }

  try {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
    await shot('01-login', null);
    await shot('02-register', null, async () => {
      await page.click('#tab-register');
      await page.type('#reg-name', 'Lindiwe Zulu');
      await page.type('#reg-number', '224100199');
      await page.type('#reg-email', 'lindiwe@sample.test');
      await page.select('#reg-area', String(resA.id));
    });

    // ---------- student
    await login('thandi');
    await shot('03-my-laundry', 'bookings.html');
    // Tomorrow evening is busy in Residence A: scroll the grid to the evening slots.
    await shot('04-book-grid', `book.html?room=${resA.id}&date=${day(1)}`, () =>
      page.evaluate(() => { document.getElementById('grid').scrollLeft = 99999; }));
    await shot('05-book-confirm', `book.html?room=${data.rooms[1].id}&date=${day(2)}`, async () => {
      await page.click('button.cell.free[data-start="17:00:00"]');
    });
    await shot('07-notifications', 'notifications.html');
    await shot('08-tips', 'tips.html');
    await shot('09-feedback', 'feedback.html', async () => {
      await page.click('[data-kind="issue"]');
      await page.select('#f-machine', String(resA.machineIds.D2));
      await page.type('#f-comment', 'D2 stops halfway through the cycle and shows error E5.');
    });
    await shot('10-profile', 'profile.html');

    // A student on the waiting list for a dryer tomorrow.
    await login('lerato');
    await shot('06-waitlist', 'bookings.html', () =>
      page.evaluate(() => document.getElementById('waitlist-section').scrollIntoView({ block: 'center' })));

    // ---------- administrator
    await login('admin');
    await shot('11-dashboard', 'dashboard.html');
    await shot('12-machines', 'machines.html', () => page.select('#room-filter', String(resA.id)));
    await shot('13-rooms', 'machines.html', () => page.click('[data-tab="rooms"]'));
    await shot('14-admin-feedback', 'feedback.html');
    await shot('15-admin-bookings', 'admin-bookings.html');
    await shot('16-people', 'admin.html');
    await shot('17-tips-admin', 'tips.html', async () => {
      await page.click('#new-tip');
      await page.select('#f-category', 'fabrics');
      await page.type('#f-title', 'Wash new jeans inside out');
      await page.type('#f-body', 'Turn jeans inside out and wash them cold on their own for the first few washes, so the dye does not run.');
      await page.evaluate(() => scrollTo(0, 0));
    });
  } finally {
    await browser.close();
    await clean();
    await pool.end();
  }
  console.log(`Screenshots saved to ${OUT}. Sample data removed.`);
}

main().catch(async (err) => { console.error(err); process.exit(1); });
