// Concurrency and performance tests (non-functional requirements: "handle multiple users
// booking at the same time", "load quickly", "booking data must be accurate").
// Self-contained: creates its own room, machines and students, and removes all of it.
// Needs the app running (npm start).
// Usage: node tools/test-load.js
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const BASE = `http://localhost:${process.env.PORT || 3003}`;
const tag = Date.now().toString(36).slice(-6);
const PASSWORD = 'Test-pass-123';
const STUDENTS = 30;

class Client {
  constructor() { this.cookie = ''; }
  async call(url, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  }
}

const results = [];
function check(area, name, pass, detail = '') {
  results.push({ area, name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const pct = (list, p) => list.slice().sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(list.length * p))];
async function timed(fn) { const t = performance.now(); const r = await fn(); return { ms: performance.now() - t, r }; }
const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => { const d = new Date(Date.now() + offset * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

let roomId = null;

async function main() {
  // Setup straight in the database (fast): one room, two machines, an admin and 30 students.
  const [room] = await pool.query("INSERT INTO laundry_rooms (name, opens_at, closes_at, slot_minutes) VALUES (?, '06:00', '22:00', 60)", [`Load Test Room ${tag}`]);
  roomId = room.insertId;
  const [w1] = await pool.query("INSERT INTO machines (room_id, code, kind, cycle_minutes) VALUES (?, 'W1', 'washer', 45)", [roomId]);
  const [w2] = await pool.query("INSERT INTO machines (room_id, code, kind, cycle_minutes) VALUES (?, 'W2', 'washer', 45)", [roomId]);
  const hash = await bcrypt.hash(PASSWORD, 10);
  const clients = [];
  for (let i = 0; i < STUDENTS; i++) {
    const email = `load${i}.${tag}@loadtest.test`;
    await pool.query("INSERT INTO users (full_name, email, student_number, password_hash) VALUES (?, ?, ?, ?)",
      [`Load Student ${i}`, email, `8${String(Date.now()).slice(-6)}${pad(i)}`, hash]);
    const c = new Client();
    await c.call('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    clients.push(c);
  }
  check('Setup', `${STUDENTS} students logged in at the same time`, clients.every((c) => c.cookie));

  // 1. Everyone tries to book the same slot at the same moment.
  const tomorrow = day(1);
  const race = await Promise.all(clients.map((c) => c.call('/api/bookings', { method: 'POST', body: { machineId: w1.insertId, date: tomorrow, slotStart: '18:00' } })));
  const won = race.filter((r) => r.status === 201).length;
  const lost = race.filter((r) => r.status === 409).length;
  const [[{ live }]] = await pool.query("SELECT COUNT(*) AS live FROM bookings WHERE machine_id = ? AND booking_date = ? AND slot_start = '18:00:00' AND status <> 'cancelled'", [w1.insertId, tomorrow]);
  check('Concurrency', `${STUDENTS} simultaneous bookings of one slot: exactly one succeeds`, won === 1 && lost === STUDENTS - 1 && live === 1,
    `${won} booked, ${lost} told "someone has just booked that slot", ${live} row in the database`);
  check('Concurrency', 'The losers get a clear message, not a server error', race.filter((r) => r.status === 409).every((r) => /just booked|already/i.test(r.data?.error || '')));

  // 2. Everyone books a different slot at the same moment: all succeed, nothing lost.
  const slots = Array.from({ length: 16 }, (_, i) => `${pad(6 + i)}:00`);
  const spread = await Promise.all(clients.slice(0, 16).map((c, i) => c.call('/api/bookings', { method: 'POST', body: { machineId: w2.insertId, date: tomorrow, slotStart: slots[i] } })));
  const [[{ n: w2Rows }]] = await pool.query("SELECT COUNT(*) AS n FROM bookings WHERE machine_id = ? AND booking_date = ? AND status = 'booked'", [w2.insertId, tomorrow]);
  check('Concurrency', '16 simultaneous bookings of different slots: all succeed and all are saved', spread.every((r) => r.status === 201) && w2Rows === 16, `${w2Rows} rows`);

  // 3. One student double-clicks: two requests for two machines at the same time.
  const c = clients[20];
  const dbl = await Promise.all([
    c.call('/api/bookings', { method: 'POST', body: { machineId: w1.insertId, date: day(2), slotStart: '09:00' } }),
    c.call('/api/bookings', { method: 'POST', body: { machineId: w2.insertId, date: day(2), slotStart: '09:00' } }),
  ]);
  check('Concurrency', 'One student sending two bookings for the same time at once: only one is kept', dbl.filter((r) => r.status === 201).length === 1);

  // 4. The 3-booking limit holds under simultaneous requests.
  const c2 = clients[25];
  const many = await Promise.all(['10:00', '11:00', '12:00', '13:00', '14:00'].map((t) => c2.call('/api/bookings', { method: 'POST', body: { machineId: w1.insertId, date: day(3), slotStart: t } })));
  check('Concurrency', '5 simultaneous bookings by one student: the limit of 3 still holds', many.filter((r) => r.status === 201).length === 3);

  // 5. Response times.
  const grid = [];
  for (let i = 0; i < 40; i++) grid.push((await timed(() => clients[i % STUDENTS].call(`/api/rooms/${roomId}/availability?date=${tomorrow}`))).ms);
  check('Performance', 'Availability grid: 95% of requests under 300 ms', pct(grid, 0.95) < 300, `median ${pct(grid, 0.5).toFixed(0)} ms, 95th percentile ${pct(grid, 0.95).toFixed(0)} ms`);
  const burst = await timed(() => Promise.all(clients.map((x) => x.call('/api/bookings'))));
  check('Performance', `${STUDENTS} students opening "My laundry" at the same moment: all answered within 2 s`, burst.ms < 2000 && burst.r.every((r) => r.status === 200), `${burst.ms.toFixed(0)} ms in total`);
  const page = await timed(() => fetch(`${BASE}/book.html`).then((r) => r.text()));
  check('Performance', 'A page loads in under 200 ms', page.ms < 200, `${page.ms.toFixed(0)} ms`);
}

async function cleanUp() {
  await pool.query('DELETE b FROM bookings b JOIN machines m ON m.id = b.machine_id WHERE m.room_id = ?', [roomId]);
  await pool.query('DELETE FROM machines WHERE room_id = ?', [roomId]);
  await pool.query('DELETE FROM users WHERE email LIKE ?', [`%.${tag}@loadtest.test`]);
  await pool.query('DELETE FROM laundry_rooms WHERE id = ?', [roomId]);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', [`%.${tag}@loadtest.test`]);
  return n === 0;
}

main()
  .catch((err) => { console.error('Test run stopped:', err.message); process.exitCode = 1; })
  .finally(async () => {
    const clean = roomId ? await cleanUp().catch((e) => { console.error('Clean-up failed:', e.message); return false; }) : true;
    await pool.end();
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} concurrency and performance tests passed.${clean ? ' All test data was removed.' : ''}`);
    if (passed !== results.length || !clean) process.exitCode = 1;
  });
