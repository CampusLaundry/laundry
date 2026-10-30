// Realistic, fictional sample data for demonstrations and the documentation screenshots.
// Everyone uses the sample.test email domain and the rooms have fixed names, so the
// whole set can be removed again without touching real data.
//   node tools/sample-data.js seed    -> create it (the app must be running)
//   node tools/sample-data.js clean   -> delete all of it
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const BASE = `http://localhost:${process.env.PORT || 3003}`;
const PASSWORD = 'Sample-pass-123'; // sample accounts only; deleted by "clean"
const DOMAIN = '@sample.test';
const ROOMS = [
  { name: 'Residence A Laundry', location: 'Block A, ground floor', opensAt: '06:00', closesAt: '22:00', slotMinutes: 60,
    machines: [['W1', 'washer', 45], ['W2', 'washer', 45], ['W3', 'washer', 45], ['D1', 'dryer', 60], ['D2', 'dryer', 60]] },
  { name: 'Residence B Laundry', location: 'Block B, basement', opensAt: '06:00', closesAt: '23:00', slotMinutes: 60,
    machines: [['W1', 'washer', 40], ['W2', 'washer', 40], ['D1', 'dryer', 55]] },
  { name: 'Student Centre Laundromat', location: 'Student Centre, level 1', opensAt: '07:00', closesAt: '22:00', slotMinutes: 90,
    machines: [['W1', 'washer', 60], ['W2', 'washer', 60], ['W3', 'washer', 60], ['D1', 'dryer', 75], ['D2', 'dryer', 75]] },
];
const STUDENTS = [
  ['thandi', 'Thandi Mokoena', '224100101', 0, '071 555 0142'],
  ['sipho', 'Sipho Ndlovu', '224100102', 0, '072 555 0187'],
  ['ayanda', 'Ayanda Mthembu', '224100103', 0],
  ['lerato', 'Lerato Khumalo', '224100104', 1, '073 555 0110'],
  ['kagiso', 'Kagiso Molefe', '224100105', 1],
  ['zanele', 'Zanele Dube', '224100106', 2, '074 555 0163'],
  ['lwazi', 'Lwazi Nkosi', '224100107', 2],
  ['johan', 'Johan van Wyk', '224100108', 0],
];

class Client {
  constructor() { this.cookie = ''; }
  async call(url, method = 'GET', body) {
    const res = await fetch(BASE + url, { method, headers: { 'Content-Type': 'application/json', Cookie: this.cookie }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(`${method} ${url}: ${data?.error}`);
    return data;
  }
  login(email) { this.cookie = ''; return this.call('/api/auth/login', 'POST', { email, password: PASSWORD }); }
}

const pad = (n) => String(n).padStart(2, '0');
const day = (offset) => {
  const d = new Date(Date.now() + offset * 864e5);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const hm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

// Deterministic "random" numbers so every seed looks the same.
let seedValue = 7;
const rand = () => { seedValue = (seedValue * 16807) % 2147483647; return (seedValue - 1) / 2147483646; };

async function seed() {
  const [existing] = await pool.query('SELECT name FROM laundry_rooms WHERE name IN (?)', [ROOMS.map((r) => r.name)]);
  if (existing.length) throw new Error('Sample data already exists. Run "node tools/sample-data.js clean" first.');

  await pool.query("INSERT INTO users (full_name, email, password_hash, role) VALUES ('Nomsa Admin', ?, ?, 'admin')",
    [`admin${DOMAIN}`, await bcrypt.hash(PASSWORD, 10)]);
  const admin = new Client();
  await admin.login(`admin${DOMAIN}`);

  // ---------------- rooms and machines
  const rooms = [];
  for (const r of ROOMS) {
    const { id } = await admin.call('/api/rooms', 'POST', r);
    const machines = {};
    for (const [code, kind, cycleMinutes] of r.machines) {
      machines[code] = (await admin.call('/api/machines', 'POST', { roomId: id, code, kind, cycleMinutes })).id;
    }
    rooms.push({ ...r, id, machineIds: machines });
  }
  const [resA, resB, centre] = rooms;

  // ---------------- students
  const s = {};
  for (const [key, fullName, studentNumber, roomIndex, phone] of STUDENTS) {
    const c = new Client();
    const u = await c.call('/api/auth/register', 'POST', { fullName, email: `${key}${DOMAIN}`, studentNumber, password: PASSWORD, roomId: rooms[roomIndex].id, phone });
    s[key] = { c, u };
  }
  const keys = Object.keys(s);

  // ---------------- two weeks of history (written directly: the API only books the future)
  const statuses = ['collected', 'collected', 'collected', 'collected', 'collected', 'collected', 'no_show', 'cancelled'];
  const used = new Set();
  for (let offset = -14; offset <= -1; offset++) {
    const perDay = 6 + Math.floor(rand() * 7);
    for (let i = 0; i < perDay; i++) {
      const room = rooms[Math.floor(rand() * rooms.length)];
      const codes = Object.keys(room.machineIds);
      const code = codes[Math.floor(rand() * codes.length)];
      // Evenings are busiest.
      const slots = [];
      for (let m = toMin(room.opensAt); m + room.slotMinutes <= toMin(room.closesAt); m += room.slotMinutes) slots.push(m);
      const weighted = rand() < 0.55 ? slots.slice(-6) : slots;
      const start = weighted[Math.floor(rand() * weighted.length)];
      const who = s[keys[Math.floor(rand() * keys.length)]].u.id;
      const key = `${room.machineIds[code]}|${offset}|${start}`;
      const userKey = `${who}|${offset}|${start}`;
      if (used.has(key) || used.has(userKey)) continue;
      used.add(key);
      used.add(userKey);
      const status = statuses[Math.floor(rand() * statuses.length)];
      const cycle = room.machines.find((m) => m[0] === code)[2];
      const startDelay = 1 + Math.floor(rand() * 8);
      const collectDelay = 2 + Math.floor(rand() * 25);
      await pool.query(`
        INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end, status, started_at, finishes_at, collected_at, cancelled_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?,
          IF(? = 'collected', TIMESTAMP(?, ?) + INTERVAL ? MINUTE, NULL),
          IF(? = 'collected', TIMESTAMP(?, ?) + INTERVAL ? MINUTE, NULL),
          IF(? = 'collected', TIMESTAMP(?, ?) + INTERVAL ? MINUTE, NULL),
          IF(? = 'cancelled', TIMESTAMP(?, ?) - INTERVAL 5 HOUR, NULL),
          TIMESTAMP(?, ?) - INTERVAL 1 DAY)`,
      [who, room.machineIds[code], day(offset), hm(start), hm(start + room.slotMinutes), status,
        status, day(offset), hm(start), startDelay,
        status, day(offset), hm(start), startDelay + cycle,
        status, day(offset), hm(start), startDelay + cycle + collectDelay,
        status, day(offset), hm(start),
        day(offset), hm(start)]);
    }
  }

  // ---------------- today: a cycle running now, and one waiting to be collected
  const [[{ nowMin }]] = await pool.query('SELECT HOUR(NOW()) * 60 + MINUTE(NOW()) AS nowMin');
  const slotNow = (room) => toMin(room.opensAt) + Math.floor((nowMin - toMin(room.opensAt)) / room.slotMinutes) * room.slotMinutes;
  const inHours = (room) => nowMin >= toMin(room.opensAt) && nowMin < toMin(room.closesAt) - room.slotMinutes;
  const today = {};
  if (inHours(resA)) {
    const start = slotNow(resA);
    const [r1] = await pool.query(`
      INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end, status, started_at, finishes_at)
      VALUES (?, ?, CURDATE(), ?, ?, 'in_progress', NOW() - INTERVAL 18 MINUTE, NOW() + INTERVAL 27 MINUTE)`,
    [s.thandi.u.id, resA.machineIds.W1, hm(start), hm(start + 60)]);
    today.running = r1.insertId;
    const [r2] = await pool.query(`
      INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end, status, started_at, finishes_at)
      VALUES (?, ?, CURDATE(), ?, ?, 'done', NOW() - INTERVAL 50 MINUTE, NOW() - INTERVAL 5 MINUTE)`,
    [s.sipho.u.id, resA.machineIds.W2, hm(start), hm(start + 60)]);
    await pool.query("INSERT INTO notifications (user_id, booking_id, kind, message, created_at) VALUES (?, ?, 'cycle_done', ?, NOW() - INTERVAL 5 MINUTE)",
      [s.sipho.u.id, r2.insertId, 'Your laundry in washer W2 in Residence A Laundry is done. Please collect it now so the next student can start.']);
  }

  // ---------------- upcoming bookings through the API
  const book = async (who, room, code, offset, time) => {
    try { return (await s[who].c.call('/api/bookings', 'POST', { machineId: room.machineIds[code], date: day(offset), slotStart: time })).id; } catch { return null; }
  };
  const laterToday = (room, n) => {
    const start = Math.max(slotNow(room), toMin(room.opensAt) - room.slotMinutes) + n * room.slotMinutes;
    return start + room.slotMinutes <= toMin(room.closesAt) && start > nowMin ? hm(start) : null;
  };
  for (const [who, room, code, n] of [['thandi', resA, 'D1', 1], ['ayanda', resA, 'W1', 1], ['johan', resA, 'W2', 2], ['lerato', resB, 'W1', 1], ['zanele', centre, 'W2', 1]]) {
    const t = laterToday(room, n);
    if (t) await book(who, room, code, 0, t);
  }
  await book('thandi', resA, 'W2', 1, '18:00');
  for (const [who, room, code, time] of [
    ['sipho', resA, 'W1', '18:00'], ['ayanda', resA, 'W1', '19:00'], ['johan', resA, 'W1', '20:00'], ['kagiso', resA, 'W2', '19:00'],
    ['lerato', resA, 'W2', '20:00'], ['zanele', resA, 'D1', '19:00'], ['lwazi', resA, 'D1', '20:00'], ['sipho', resA, 'D2', '19:00'],
    ['ayanda', resA, 'D2', '20:00'], ['kagiso', resA, 'D1', '21:00'], ['johan', resA, 'D2', '21:00'], ['lwazi', resA, 'W1', '21:00'],
    ['zanele', resB, 'W1', '18:00'], ['lwazi', resB, 'D1', '19:00'], ['kagiso', centre, 'W1', '17:30']]) {
    await book(who, room, code, 1, time);
  }
  await book('sipho', centre, 'W3', 2, '10:00');

  // ---------------- out of order (reported by a student, confirmed by the admin)
  const issue = await s.zanele.c.call('/api/feedback', 'POST', { kind: 'issue', machineId: resA.machineIds.W3, comment: 'W3 does not drain: the clothes come out soaking wet and there is water left in the drum.' });
  await admin.call(`/api/machines/${resA.machineIds.W3}/outage`, 'POST', { reason: 'Not draining, technician booked for Monday' });
  await admin.call(`/api/feedback/${issue.id}`, 'PATCH', { status: 'in_progress', response: 'Thank you. W3 is out of order until the technician has repaired the pump on Monday.' });
  await pool.query("UPDATE machine_outages SET started_at = NOW() - INTERVAL 1 DAY WHERE machine_id = ?", [resA.machineIds.W3]);
  // An older, fixed fault.
  await pool.query(`INSERT INTO machine_outages (machine_id, reason, reported_by, started_at, ended_at)
    VALUES (?, 'Door would not lock', NULL, NOW() - INTERVAL 10 DAY, NOW() - INTERVAL 8 DAY)`, [centre.machineIds.D1]);

  // ---------------- waiting list: all Residence A dryers are taken tomorrow evening
  await s.lerato.c.call('/api/waitlist', 'POST', { roomId: resA.id, date: day(1), kind: 'dryer' });
  await s.lwazi.c.call('/api/waitlist', 'POST', { roomId: resA.id, date: day(1), kind: 'washer' });

  // ---------------- feedback
  const fb = async (who, body) => (await s[who].c.call('/api/feedback', 'POST', body)).id;
  await fb('thandi', { kind: 'rating', rating: 5, roomId: resA.id, comment: 'Booking is so much easier than queuing. Love the "laundry done" notification!' });
  await fb('sipho', { kind: 'rating', rating: 4, roomId: resA.id, comment: 'Works well. Some people leave their clothes in the dryer too long.' });
  await fb('ayanda', { kind: 'rating', rating: 4, machineId: resA.machineIds.D1 });
  await fb('lerato', { kind: 'rating', rating: 3, roomId: resB.id, comment: 'Only one dryer in Residence B is not enough on weekends.' });
  await fb('kagiso', { kind: 'rating', rating: 5, roomId: centre.id });
  await fb('zanele', { kind: 'rating', rating: 2, machineId: centre.machineIds.D2, comment: 'D2 needs two cycles to dry jeans.' });
  const c1 = await fb('lwazi', { kind: 'comment', roomId: resB.id, comment: 'Could Residence B open until midnight during exams?' });
  const i2 = await fb('johan', { kind: 'issue', machineId: centre.machineIds.D2, comment: 'The lint filter of D2 is broken and lint is going everywhere.' });
  await fb('sipho', { kind: 'issue', roomId: resA.id, comment: 'The light above the folding table is flickering.' });
  await admin.call(`/api/feedback/${c1}`, 'PATCH', { status: 'resolved', response: 'Good idea: Residence B will stay open until 23:00 during exams.' });
  await admin.call(`/api/feedback/${i2}`, 'PATCH', { status: 'resolved', response: 'The filter was replaced on Tuesday. Thanks for reporting it!' });
  await pool.query("UPDATE feedback SET created_at = created_at - INTERVAL FLOOR(RAND() * 9 + 1) DAY WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)", [`%${DOMAIN}`]);

  // ---------------- a typical set of past notifications for Thandi (some read, some not)
  for (const [kind, message, minutesAgo, read] of [
    ['cycle_done', 'Your laundry in dryer D1 in Residence A Laundry is done. Please collect it now so the next student can start.', 60 * 26, true],
    ['reminder', 'Reminder: your washer W1 in Residence A Laundry starts today at 18:00. Tap "Start cycle" when you load it.', 60 * 28, true],
    ['machine_free', 'Washer W2 in Residence A Laundry is free now. Your slot starts at 19:00; you can start up to 5 minutes early.', 60 * 47, true],
    ['feedback_reply', 'Your feedback is resolved. Reply: Thank you! We added a second folding table in Residence A.', 60 * 3, false],
  ]) {
    await pool.query('INSERT INTO notifications (user_id, kind, message, created_at, read_at) VALUES (?, ?, ?, NOW() - INTERVAL ? MINUTE, IF(?, NOW() - INTERVAL ? MINUTE, NULL))',
      [s.thandi.u.id, kind, message, minutesAgo, read, minutesAgo - 5]);
  }

  return { rooms, students: Object.fromEntries(keys.map((k) => [k, s[k].u.id])), today };
}

async function clean() {
  const [rooms] = await pool.query('SELECT id FROM laundry_rooms WHERE name IN (?)', [ROOMS.map((r) => r.name)]);
  const [users] = await pool.query('SELECT id FROM users WHERE email LIKE ?', [`%${DOMAIN}`]);
  const roomIds = rooms.map((r) => r.id);
  const userIds = users.map((u) => u.id);
  if (roomIds.length) {
    await pool.query('DELETE FROM feedback WHERE room_id IN (?)', [roomIds]);
    await pool.query('DELETE b FROM bookings b JOIN machines m ON m.id = b.machine_id WHERE m.room_id IN (?)', [roomIds]);
    await pool.query('DELETE FROM machines WHERE room_id IN (?)', [roomIds]);
  }
  if (userIds.length) {
    await pool.query('DELETE FROM feedback WHERE user_id IN (?)', [userIds]);
    await pool.query('UPDATE laundry_tips SET created_by = NULL WHERE created_by IN (?)', [userIds]);
    await pool.query('DELETE FROM users WHERE id IN (?)', [userIds]);
  }
  if (roomIds.length) await pool.query('DELETE FROM laundry_rooms WHERE id IN (?)', [roomIds]);
  return { users: userIds.length, rooms: roomIds.length };
}

module.exports = { seed, clean, PASSWORD, DOMAIN, BASE };

if (require.main === module) {
  const action = process.argv[2];
  (async () => {
    if (action === 'seed') {
      await seed();
      console.log(`Sample data created. Log in as admin${DOMAIN} or thandi${DOMAIN} (student); the password is in tools/sample-data.js.`);
    } else if (action === 'clean') {
      const n = await clean();
      console.log(`Sample data removed (${n.users} accounts, ${n.rooms} laundry rooms and everything linked to them).`);
    } else {
      console.log('Usage: node tools/sample-data.js seed | clean');
    }
  })()
    .catch((err) => { console.error(err.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
