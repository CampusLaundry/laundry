// Browser (user interface) tests: drives the real pages in Microsoft Edge, clicking and
// typing like a student and an administrator, including on a phone-sized screen.
// Self-contained: creates its own laundry room, accounts and data, and removes all of it.
// Needs the app running (npm start) and the dev tools installed (npm install).
// Usage: node tools/test-ui.js
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { launch } = require('./render');

const BASE = `http://localhost:${process.env.PORT || 3003}`;
const tag = Date.now().toString(36).slice(-6);
const DOMAIN = '@uitest.test';
const PASSWORD = 'Test-pass-123';
const STUDENT_NUMBER = `7${String(Date.now()).slice(-8)}`;
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => { const d = new Date(Date.now() + offset * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(area, name, fn) {
  try {
    const detail = await fn();
    results.push({ area, name, pass: true });
    console.log(`PASS  [${area}] ${name}${typeof detail === 'string' ? `  (${detail})` : ''}`);
  } catch (err) {
    results.push({ area, name, pass: false });
    console.log(`FAIL  [${area}] ${name}  (${err.message.split('\n')[0]})`);
  }
}
const assert = (ok, message) => { if (!ok) throw new Error(message); };

let roomId = null;
const pageErrors = [];

function watch(page, who) {
  page.on('pageerror', (err) => pageErrors.push(`${who}: ${err.message}`));
  // Prompts get a reason; confirms are accepted.
  page.on('dialog', (d) => (d.type() === 'prompt' ? d.accept('Drum not spinning, waiting for repair') : d.accept()));
}
const text = (page, selector) => page.$eval(selector, (el) => el.innerText);
// Waits up to 8 seconds for an element's text to contain (or no longer contain) a value.
async function has(page, selector, needle, timeout = 8000) {
  try {
    await page.waitForFunction((sel, n) => document.querySelector(sel)?.innerText.includes(n), { timeout, polling: 100 }, selector, needle);
    return true;
  } catch { return false; }
}
async function lacks(page, selector, needle, timeout = 8000) {
  try {
    await page.waitForFunction((sel, n) => !document.querySelector(sel)?.innerText.includes(n), { timeout, polling: 100 }, selector, needle);
    return true;
  } catch { return false; }
}
async function go(page, path) { await page.goto(`${BASE}/${path}`, { waitUntil: 'networkidle0' }); await pause(300); }
async function login(page, login) {
  await go(page, '');
  await page.type('#login-email', login);
  await page.type('#login-password', PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle0' }), page.click('#login-form button')]);
  await pause(300);
}

async function main() {
  // Setup: an administrator in the database; the room and machines through the admin UI later.
  await pool.query("INSERT INTO users (full_name, email, password_hash, role) VALUES ('UI Test Admin', ?, ?, 'admin')",
    [`admin.${tag}${DOMAIN}`, await bcrypt.hash(PASSWORD, 10)]);

  const browser = await launch();
  const studentCtx = await browser.createBrowserContext();
  const adminCtx = await browser.createBrowserContext();
  const s = await studentCtx.newPage();
  const a = await adminCtx.newPage();
  await s.setViewport({ width: 1280, height: 900 });
  await a.setViewport({ width: 1280, height: 900 });
  watch(s, 'student');
  watch(a, 'admin');

  try {
    // ---------------- administrator sets up a room and machines
    await step('Admin', 'Log in as administrator → Dashboard', async () => {
      await login(a, `admin.${tag}${DOMAIN}`);
      assert(a.url().endsWith('/dashboard.html'), `landed on ${a.url()}`);
      assert((await a.$$('#now .stat')).length === 6, 'dashboard tiles missing');
    });
    await step('Machines', 'Add a laundry room with the form', async () => {
      await go(a, 'machines.html');
      await a.click('[data-tab="rooms"]');
      await a.type('#r-name', `UI Test Room ${tag}`);
      await a.type('#r-location', 'Test block');
      await a.click('#room-save');
      const listed = await has(a, '#rooms', `UI Test Room ${tag}`);
      [[{ id: roomId } = {}]] = await pool.query('SELECT id FROM laundry_rooms WHERE name = ?', [`UI Test Room ${tag}`]);
      assert(listed && roomId, 'room not listed');
    });
    await step('Machines', 'Add a washer and a dryer with the form', async () => {
      await a.click('[data-tab="machines"]');
      for (const [code, kind, cycle] of [['W1', 'washer', '45'], ['D1', 'dryer', '60']]) {
        await a.select('#m-room', String(roomId));
        await a.$eval('#m-code', (el) => { el.value = ''; });
        await a.type('#m-code', code);
        await a.select('#m-kind', kind);
        await a.$eval('#m-cycle', (el, v) => { el.value = v; }, cycle);
        await a.click('#machine-save');
        assert(await lacks(a, '#machine-form-title', 'Edit') && await has(a, '#banner', 'added'), `${code} not saved`);
        await a.evaluate(() => { document.getElementById('banner').innerHTML = ''; });
      }
      await a.select('#room-filter', String(roomId));
      await pause(600);
      const t = await text(a, '#machines');
      assert(t.includes('W1') && t.includes('D1'), 'machines not listed');
    });
    await step('Machines', 'Form validation: a cycle longer than the slot is refused with a message', async () => {
      await a.select('#m-room', String(roomId));
      await a.$eval('#m-code', (el) => { el.value = 'W9'; });
      await a.$eval('#m-cycle', (el) => { el.value = '120'; });
      await a.click('#machine-save');
      await pause(600);
      assert(await has(a, '#machine-error', 'must fit'), 'no validation message');
    });

    // ---------------- student registers and books
    await step('Accounts', 'Register as a student with the form → My laundry', async () => {
      await go(s, '');
      await s.click('#tab-register');
      await s.type('#reg-name', 'UI Test Student');
      await s.type('#reg-number', STUDENT_NUMBER);
      await s.type('#reg-email', `student.${tag}${DOMAIN}`);
      await s.type('#reg-password', PASSWORD);
      await s.select('#reg-area', String(roomId));
      await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0' }), s.click('#register-form button[type="submit"]')]);
      await pause(300);
      assert(s.url().endsWith('/bookings.html'), `landed on ${s.url()}`);
      assert(await has(s, '#upcoming', 'You have no bookings'), 'empty state missing');
    });
    await step('Accounts', 'Wrong password shows an error and stays on the login page', async () => {
      await s.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
      await go(s, '');
      await s.type('#login-email', STUDENT_NUMBER);
      await s.type('#login-password', 'wrong-password');
      await s.click('#login-form button');
      await pause(800);
      assert(await has(s, '#login-error', 'Wrong'), 'no error shown');
    });
    await step('Accounts', 'Log in with the student number', async () => {
      await login(s, STUDENT_NUMBER);
      assert(s.url().endsWith('/bookings.html'), `landed on ${s.url()}`);
    });
    await step('Booking', 'Booking grid shows the room\'s machines and slots for tomorrow', async () => {
      await go(s, `book.html?room=${roomId}&date=${day(1)}`);
      assert((await s.$$('table.slots tr')).length === 3, 'expected 2 machine rows');
      assert((await s.$$('button.cell.free')).length === 32, 'expected 32 free slots (2 machines × 16)');
    });
    await step('Booking', 'Click a free slot → confirm bar → Confirm booking → My laundry shows it', async () => {
      await s.click('button.cell.free[data-start="10:00:00"]');
      await pause(300);
      assert(!(await s.$eval('#confirm', (el) => el.classList.contains('hidden'))), 'confirm bar not shown');
      assert(await has(s, '#confirm-text', '10:00'), 'wrong slot in confirm bar');
      await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0' }), s.click('#confirm-yes')]);
      await pause(400);
      assert(await has(s, '#banner', 'Booked'), 'no success message');
      assert(await has(s, '#upcoming', 'Washer W1'), 'booking card missing');
    });
    await step('Booking', 'The booked slot shows as "Yours" in the grid', async () => {
      await go(s, `book.html?room=${roomId}&date=${day(1)}`);
      assert((await s.$$('a.cell.mine')).length === 1, 'own slot not marked');
    });
    await step('Booking', 'Reschedule: pick a new slot → booking moved', async () => {
      await go(s, 'bookings.html');
      await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0' }), s.click('a[href^="book.html?reschedule="]')]);
      await pause(400);
      assert(!(await s.$eval('#reschedule-notice', (el) => el.classList.contains('hidden'))), 'no reschedule notice');
      await s.click('button.cell.free[data-start="14:00:00"]');
      await pause(300);
      assert((await text(s, '#confirm-yes')) === 'Move booking', 'wrong button');
      await Promise.all([s.waitForNavigation({ waitUntil: 'networkidle0' }), s.click('#confirm-yes')]);
      await pause(400);
      assert(await has(s, '#upcoming', '14:00'), 'booking not moved');
    });
    await step('Booking', 'Cancel: confirm the dialog → the booking moves to History as Cancelled', async () => {
      await s.click('[data-act="cancel"]');
      await pause(1000);
      assert(await has(s, '#upcoming', 'You have no bookings'), 'still listed as upcoming');
      assert(await has(s, '#history', 'Cancelled'), 'not in history');
    });
    await step('Waitlist', 'Join and leave the waiting list from the booking page', async () => {
      // Fill every dryer slot tomorrow so the "join" button appears.
      await pool.query(`INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end)
        SELECT u.id, m.id, ?, ADDTIME('06:00:00', SEC_TO_TIME(n.i * 3600)), ADDTIME('07:00:00', SEC_TO_TIME(n.i * 3600))
        FROM users u JOIN machines m ON m.room_id = ? AND m.code = 'D1'
        JOIN (SELECT 0 i UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7
              UNION SELECT 8 UNION SELECT 9 UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13 UNION SELECT 14 UNION SELECT 15) n
        WHERE u.email = ?`, [day(1), roomId, `admin.${tag}${DOMAIN}`]);
      await go(s, `book.html?room=${roomId}&date=${day(1)}`);
      await s.click('[data-join="dryer"]');
      await pause(800);
      assert(await has(s, '#waitlist', 'On the waiting list'), 'not joined');
      await s.click('[data-leave]');
      assert(await s.waitForSelector('[data-join="dryer"]', { timeout: 8000 }).then(() => true, () => false), 'not left');
    });

    // ---------------- tips, feedback, profile
    await step('Tips', 'Tips page has the four categories; filtering by Fabric types', async () => {
      await go(s, 'tips.html');
      assert((await s.$$('#tabs [data-cat]')).length === 5, 'category tabs missing');
      await s.click('#tabs [data-cat="fabrics"]');
      await pause(200);
      const badges = await s.$$eval('#tips .tip .badge', (els) => els.map((e) => e.innerText));
      assert(badges.length > 0 && badges.every((b) => b.includes('Fabric')), 'filter not applied');
    });
    await step('Feedback', 'Rate 4 stars with a comment → shown under My feedback', async () => {
      await go(s, 'feedback.html');
      await s.click('#stars [data-star="4"]');
      await s.type('#f-comment', 'Quick and clean, thank you.');
      await s.click('#feedback-form button[type="submit"]');
      await pause(800);
      assert(await has(s, '#list', '★★★★☆'), 'rating not shown');
    });
    await step('Feedback', 'Sending a rating without stars shows a message', async () => {
      await s.click('#feedback-form button[type="submit"]');
      await pause(300);
      assert(await has(s, '#form-error', 'stars'), 'no message');
    });
    await step('Feedback', 'Report an issue about a machine', async () => {
      await s.click('[data-kind="issue"]');
      const [[w1]] = await pool.query("SELECT id FROM machines WHERE room_id = ? AND code = 'W1'", [roomId]);
      await s.select('#f-machine', String(w1.id));
      await s.type('#f-comment', 'W1 makes a loud banging noise when spinning.');
      await s.click('#feedback-form button[type="submit"]');
      await pause(800);
      assert(await has(s, '#list', 'banging'), 'issue not listed');
    });
    await step('Profile', 'Update the phone number', async () => {
      await go(s, 'profile.html');
      await s.$eval('#phone', (el) => { el.value = ''; });
      await s.type('#phone', '071 555 0199');
      await s.click('#details-form button[type="submit"]');
      await pause(700);
      assert(await has(s, '#banner', 'saved'), 'no confirmation');
    });

    // ---------------- administrator handles the issue
    await step('Feedback', 'Admin replies to the issue and marks it resolved', async () => {
      await go(a, 'feedback.html');
      const cards = await a.$$eval('#list [data-id]', (els) => els.map((e) => ({ id: e.dataset.id, t: e.innerText })));
      const issue = cards.find((c) => c.t.includes('banging'));
      assert(issue, 'issue not visible to admin');
      await a.type(`[data-id="${issue.id}"] [data-response]`, 'The drum bearing will be replaced tomorrow.');
      await a.select(`[data-id="${issue.id}"] [data-status]`, 'resolved');
      await a.click(`[data-id="${issue.id}"] [data-save]`);
      await pause(800);
      assert(await has(a, '#banner', 'notified'), 'no confirmation');
    });
    await step('Notifications', 'Student sees the reply: bell count and notification', async () => {
      await go(s, 'notifications.html');
      assert(await has(s, '#list', 'drum bearing'), 'reply notification missing');
      await go(s, 'bookings.html');
      await s.evaluate(() => refreshBell());
      await pause(300);
      assert(Number(await text(s, '#bell-count')) >= 1, 'bell shows no unread');
    });
    await step('Notifications', 'Mark all as read clears the bell', async () => {
      await go(s, 'notifications.html');
      await s.click('#read-all');
      const cleared = await s.waitForFunction(() => document.getElementById('bell-count').classList.contains('hidden'), { timeout: 8000 }).then(() => true, () => false);
      assert(cleared, 'bell still shows a count');
    });
    await step('Machines', 'Mark a machine out of order (reason prompt) and back in service', async () => {
      await go(a, 'machines.html');
      await a.select('#room-filter', String(roomId));
      await pause(600);
      const row = await a.$$eval('#machines [data-id]', (els) => els.map((e) => ({ id: e.dataset.id, t: e.innerText })));
      const w1 = row.find((r) => r.t.includes('W1'));
      await a.click(`#machines [data-id="${w1.id}"] [data-outage]`);
      await pause(1000);
      assert(await has(a, `#machines [data-id="${w1.id}"]`, 'Out of order'), 'not out of order');
      await go(s, `book.html?room=${roomId}&date=${day(1)}`);
      assert(await has(s, '#grid', 'Drum not spinning'), 'students do not see the reason');
      await a.click(`#machines [data-id="${w1.id}"] [data-repair]`);
      await pause(1000);
      assert(await has(a, `#machines [data-id="${w1.id}"]`, 'Available'), 'not back in service');
    });
    await step('Reports', 'Booking history: search by student', async () => {
      await go(a, 'admin-bookings.html');
      await a.type('#search', STUDENT_NUMBER);
      await pause(1200);
      assert(await has(a, '#list', 'UI Test Student'), 'student bookings not found');
    });
    await step('People', 'Find the student, deactivate and reactivate', async () => {
      await go(a, 'admin.html');
      await a.type('#user-search', STUDENT_NUMBER);
      await pause(1200);
      await a.click('#users [data-active="0"]');
      await pause(1000);
      assert(await has(a, '#users', 'Deactivated'), 'not deactivated');
      await a.click('#users [data-active="1"]');
      await pause(1000);
      assert(await lacks(a, '#users', 'Deactivated'), 'not reactivated');
    });
    await step('Tips', 'Admin adds a tip with the form', async () => {
      await go(a, 'tips.html');
      await a.click('#new-tip');
      await a.select('#f-category', 'maintenance');
      await a.type('#f-title', `Clean the soap drawer ${tag}`);
      await a.type('#f-body', 'Rinse the detergent drawer once a month to stop mould.');
      await a.click('#tip-form button[type="submit"]');
      await pause(800);
      assert(await has(a, '#tips', `Clean the soap drawer ${tag}`), 'tip not listed');
    });
    await step('Security', 'A student opening an admin page is sent back to their own page', async () => {
      await go(s, 'machines.html');
      await pause(500);
      assert(s.url().endsWith('/bookings.html'), `stayed on ${s.url()}`);
    });

    // ---------------- phone-sized screen
    await s.setViewport({ width: 375, height: 812, isMobile: true, hasTouch: true });
    for (const path of ['bookings.html', `book.html?room=${roomId}&date=${day(1)}`, 'tips.html', 'feedback.html', 'notifications.html', 'profile.html']) {
      await step('Mobile', `${path.split('?')[0]} fits a 375-pixel phone screen (no sideways scrolling)`, async () => {
        await go(s, path);
        const { scroll, width } = await s.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
        assert(scroll <= width + 1, `page is ${scroll}px wide`);
      });
    }
    await step('Mobile', 'The booking grid scrolls sideways inside its own box', async () => {
      await go(s, `book.html?room=${roomId}&date=${day(1)}`);
      const { inner, box } = await s.$eval('#grid', (el) => ({ inner: el.scrollWidth, box: el.clientWidth }));
      assert(inner > box, 'grid does not scroll');
    });

    await step('Quality', 'No JavaScript errors on any page', async () => {
      assert(pageErrors.length === 0, pageErrors.join('; '));
    });
  } finally {
    await browser.close();
  }
}

async function cleanUp() {
  const [[found]] = await pool.query('SELECT id FROM laundry_rooms WHERE name = ?', [`UI Test Room ${tag}`]);
  roomId = found ? found.id : roomId;
  if (roomId) {
    await pool.query('DELETE FROM feedback WHERE room_id = ?', [roomId]);
    await pool.query('DELETE b FROM bookings b JOIN machines m ON m.id = b.machine_id WHERE m.room_id = ?', [roomId]);
    await pool.query('DELETE FROM machines WHERE room_id = ?', [roomId]);
  }
  await pool.query('DELETE FROM laundry_tips WHERE title LIKE ?', [`%${tag}`]);
  await pool.query('DELETE FROM users WHERE email LIKE ?', [`%.${tag}${DOMAIN}`]);
  if (roomId) await pool.query('DELETE FROM laundry_rooms WHERE id = ?', [roomId]);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', [`%.${tag}${DOMAIN}`]);
  return n === 0;
}

main()
  .catch((err) => { console.error('Test run stopped:', err.message); process.exitCode = 1; })
  .finally(async () => {
    const clean = await cleanUp().catch((e) => { console.error('Clean-up failed:', e.message); return false; });
    await pool.end();
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} browser tests passed.${clean ? ' All test data was removed.' : ''}`);
    if (passed !== results.length || !clean) process.exitCode = 1;
  });
