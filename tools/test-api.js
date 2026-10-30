// End-to-end tests through the real HTTP API, acting as an administrator and three students
// at the same time. Self-contained: it creates a temporary administrator directly in the
// database, creates everything else through the API, and removes ALL of it at the end
// (even if a test fails). It never touches existing data. Time-based steps (starting a
// cycle, a cycle finishing, a missed slot, a reminder) move the test's own bookings in
// time directly in the database, then check that the scheduler reacts.
// Needs the app running (npm start).
// Usage: node tools/test-api.js
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');

const BASE = `http://localhost:${process.env.PORT || 3003}`;
const tag = Date.now().toString(36).toLowerCase().slice(-6);
const emailFor = (who) => `${who}.${tag}@apitest.test`;
const numberBase = `9${String(Date.now()).slice(-7)}`; // fixed for the whole run
const numberFor = (n) => `${numberBase}${n}`;
const PASSWORD = 'Test-pass-123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pad = (n) => String(n).padStart(2, '0');
function day(offset = 0) {
  const d = new Date(Date.now() + offset * 864e5);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// One simulated browser: keeps its own login cookie.
class Client {
  constructor() { this.cookie = ''; }
  async call(url, { method = 'GET', body } = {}) {
    const res = await fetch(BASE + url, {
      method,
      headers: { 'Content-Type': 'application/json', Cookie: this.cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const err = new Error(data?.error || res.statusText); err.status = res.status; throw err; }
    return data;
  }
  get(url) { return this.call(url); }
  post(url, body) { return this.call(url, { method: 'POST', body: body || {} }); }
  put(url, body) { return this.call(url, { method: 'PUT', body }); }
  patch(url, body) { return this.call(url, { method: 'PATCH', body }); }
  del(url, body) { return this.call(url, { method: 'DELETE', body }); }
  login(email, password = PASSWORD) { this.cookie = ''; return this.post('/api/auth/login', { email, password }); }
}
const statusOf = async (fn) => { try { await fn(); return 'ok'; } catch (e) { return e.status; } };

const results = [];
function check(area, name, pass, detail = '') {
  results.push({ area, name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${area}] ${name}${detail ? '  (' + detail + ')' : ''}`);
}

const created = { rooms: [] };
const notes = async (client, kind) => (await client.get('/api/notifications')).notifications.filter((n) => !kind || n.kind === kind);
// Moves one of the test's bookings so that its slot starts `minutes` from now (negative = in the past).
async function moveSlot(bookingId, minutes) {
  await pool.query(`
    UPDATE bookings SET booking_date = DATE(NOW() + INTERVAL ? MINUTE), slot_start = TIME(NOW() + INTERVAL ? MINUTE),
           slot_end = TIME(NOW() + INTERVAL ? MINUTE) WHERE id = ?`, [minutes, minutes, minutes + 60, bookingId]);
}

async function main() {
  await pool.query("INSERT INTO users (full_name, email, password_hash, role) VALUES ('API Test Admin', ?, ?, 'admin')",
    [emailFor('admin'), await bcrypt.hash(PASSWORD, 10)]);
  const admin = new Client();
  await admin.login(emailFor('admin'));

  // ---------- Rooms and machines (admin) ----------
  const room = await admin.post('/api/rooms', { name: `Test Res A ${tag}`, location: 'Block A', opensAt: '06:00', closesAt: '22:00', slotMinutes: 60 });
  const room2 = await admin.post('/api/rooms', { name: `Test Res B ${tag}`, opensAt: '07:00', closesAt: '19:00', slotMinutes: 90 });
  created.rooms.push(room.id, room2.id);
  check('Rooms', 'Create: admin adds laundry rooms', !!room.id && !!room2.id);
  check('Rooms', 'Create: duplicate room name rejected (409)', await statusOf(() => admin.post('/api/rooms', { name: `Test Res A ${tag}`, opensAt: '06:00', closesAt: '22:00', slotMinutes: 60 })) === 409);
  check('Rooms', 'Create: closing before opening rejected (400)', await statusOf(() => admin.post('/api/rooms', { name: `Bad room ${tag}`, opensAt: '20:00', closesAt: '08:00', slotMinutes: 60 })) === 400);
  const w1 = await admin.post('/api/machines', { roomId: room.id, code: 'w1', kind: 'washer', cycleMinutes: 45 });
  const w2 = await admin.post('/api/machines', { roomId: room.id, code: 'W2', kind: 'washer', cycleMinutes: 45 });
  const d1 = await admin.post('/api/machines', { roomId: room.id, code: 'D1', kind: 'dryer', cycleMinutes: 60 });
  const spare = await admin.post('/api/machines', { roomId: room2.id, code: 'W9', kind: 'washer', cycleMinutes: 50 });
  const list = await admin.get(`/api/machines?roomId=${room.id}`);
  check('Machines', 'Create: washers and dryers added, codes stored in capitals', list.length === 3 && list.some((m) => m.code === 'W1'));
  check('Machines', 'Create: duplicate code in a room rejected (409)', await statusOf(() => admin.post('/api/machines', { roomId: room.id, code: 'W1', kind: 'dryer', cycleMinutes: 50 })) === 409);
  check('Machines', 'Create: cycle longer than the slot rejected (400)', await statusOf(() => admin.post('/api/machines', { roomId: room.id, code: 'W3', kind: 'washer', cycleMinutes: 90 })) === 400);
  await admin.put(`/api/machines/${w2.id}`, { roomId: room.id, code: 'W2', kind: 'washer', cycleMinutes: 40 });
  check('Machines', 'Update: cycle length changed', (await admin.get(`/api/machines?roomId=${room.id}`)).find((m) => m.id === w2.id).cycle_minutes === 40);

  // ---------- Students ----------
  const s1 = new Client();
  const s2 = new Client();
  const s3 = new Client();
  check('Accounts', 'Register: student number with letters rejected (400)', await statusOf(() => s1.post('/api/auth/register', { fullName: 'Student One', email: emailFor('s1'), studentNumber: 'ABC123', password: PASSWORD })) === 400);
  const r1 = await s1.post('/api/auth/register', { fullName: 'Student One', email: emailFor('s1'), studentNumber: numberFor(1), password: PASSWORD, roomId: room.id });
  check('Accounts', 'Register: student signs up with student number and home room', r1.role === 'student' && r1.roomId === room.id);
  check('Accounts', 'Register: duplicate student number rejected (409)', await statusOf(() => s2.post('/api/auth/register', { fullName: 'Someone Else', email: emailFor('x'), studentNumber: numberFor(1), password: PASSWORD })) === 409);
  const r2 = await s2.post('/api/auth/register', { fullName: 'Student Two', email: emailFor('s2'), studentNumber: numberFor(2), password: PASSWORD });
  const r3 = await s3.post('/api/auth/register', { fullName: 'Student Three', email: emailFor('s3'), studentNumber: numberFor(3), password: PASSWORD });
  check('Accounts', 'Log in with the student number instead of the email', (await new Client().login(numberFor(2))).id === r2.id);
  check('Admin', 'Students cannot manage machines (403)', await statusOf(() => s1.post('/api/machines', { roomId: room.id, code: 'X1', kind: 'washer', cycleMinutes: 30 })) === 403);

  // ---------- Availability and booking ----------
  const tomorrow = day(1);
  let grid = await s1.get(`/api/rooms/${room.id}/availability?date=${tomorrow}`);
  check('Booking', 'Read: availability grid has every machine × slot (16 one-hour slots)', grid.slots.length === 16 && grid.machines.length === 3 && grid.machines.every((m) => m.cells.every((c) => c.state === 'free')));
  const b1 = await s1.post('/api/bookings', { machineId: w1.id, date: tomorrow, slotStart: '10:00' });
  check('Booking', 'Create: student books W1 tomorrow 10:00', !!b1.id);
  check('Booking', 'Double booking of the same slot rejected (409)', await statusOf(() => s2.post('/api/bookings', { machineId: w1.id, date: tomorrow, slotStart: '10:00' })) === 409);
  check('Booking', 'Same student, two machines at the same time rejected (409)', await statusOf(() => s1.post('/api/bookings', { machineId: w2.id, date: tomorrow, slotStart: '10:00' })) === 409);
  check('Booking', 'A time that is not a slot start rejected (400)', await statusOf(() => s2.post('/api/bookings', { machineId: w1.id, date: tomorrow, slotStart: '10:30' })) === 400);
  check('Booking', 'More than 7 days ahead rejected (400)', await statusOf(() => s2.post('/api/bookings', { machineId: w1.id, date: day(9), slotStart: '10:00' })) === 400);
  check('Booking', 'A date in the past rejected (400)', await statusOf(() => s2.post('/api/bookings', { machineId: w1.id, date: day(-1), slotStart: '10:00' })) === 400);
  grid = await s2.get(`/api/rooms/${room.id}/availability?date=${tomorrow}`);
  const cellOf = (g, machineId, start) => g.machines.find((m) => m.id === machineId).cells.find((c) => c.start === start);
  check('Booking', 'Read: other students see the slot as taken, without names', cellOf(grid, w1.id, '10:00:00').state === 'taken' && !cellOf(grid, w1.id, '10:00:00').student);
  check('Booking', 'Read: the admin sees who booked', !!cellOf(await admin.get(`/api/rooms/${room.id}/availability?date=${tomorrow}`), w1.id, '10:00:00').student);
  const b2 = await s1.post('/api/bookings', { machineId: d1.id, date: tomorrow, slotStart: '11:00' });
  const b3 = await s1.post('/api/bookings', { machineId: w2.id, date: day(2), slotStart: '08:00' });
  check('Booking', 'At most 3 open bookings per student (409)', await statusOf(() => s1.post('/api/bookings', { machineId: w2.id, date: day(3), slotStart: '08:00' })) === 409);

  // ---------- Reschedule and cancel ----------
  await s1.put(`/api/bookings/${b1.id}`, { date: tomorrow, slotStart: '12:00' });
  grid = await s2.get(`/api/rooms/${room.id}/availability?date=${tomorrow}`);
  check('Reschedule', 'Update: booking moved to 12:00 and 10:00 is free again', cellOf(grid, w1.id, '12:00:00').state === 'taken' && cellOf(grid, w1.id, '10:00:00').state === 'free');
  check('Reschedule', "Can't reschedule someone else's booking (404)", await statusOf(() => s2.put(`/api/bookings/${b1.id}`, { date: tomorrow, slotStart: '13:00' })) === 404);
  const b4 = await s2.post('/api/bookings', { machineId: w1.id, date: tomorrow, slotStart: '10:00' });
  check('Reschedule', 'The freed slot can be booked by another student', !!b4.id);

  // ---------- Waiting list ----------
  await s3.post('/api/waitlist', { roomId: room.id, date: tomorrow, kind: 'dryer' });
  check('Waitlist', 'Join: second time rejected (409)', await statusOf(() => s3.post('/api/waitlist', { roomId: room.id, date: tomorrow, kind: 'dryer' })) === 409);
  await s1.post(`/api/bookings/${b2.id}/cancel`);
  check('Cancel', 'Cancel: student cancels a booking', (await s1.get(`/api/bookings/${b2.id}`)).status === 'cancelled');
  const free = await notes(s3, 'machine_free');
  check('Waitlist', 'Notify: the first student waiting for a dryer is told one is free', free.length === 1 && free[0].message.includes('D1'));
  check('Waitlist', 'The waiting-list entry is marked as notified', !!(await s3.get('/api/waitlist'))[0].notified_at);
  const b5 = await s3.post('/api/bookings', { machineId: d1.id, date: tomorrow, slotStart: '11:00' });
  check('Waitlist', 'Booking the machine removes the student from the waiting list', !!b5.id && (await s3.get('/api/waitlist')).length === 0);
  check('Cancel', 'A cancelled booking cannot be cancelled again (409)', await statusOf(() => s1.post(`/api/bookings/${b2.id}/cancel`)) === 409);

  // ---------- Out of order ----------
  const b6 = await s2.post('/api/bookings', { machineId: w2.id, date: day(2), slotStart: '09:00' });
  const outage = await admin.post(`/api/machines/${w2.id}/outage`, { reason: 'Leaking from the door seal' });
  check('Out of order', 'Mark out of order: upcoming bookings on it cancelled (2)', outage.cancelled === 2 && (await s2.get(`/api/bookings/${b6.id}`)).status === 'cancelled');
  check('Out of order', 'Students get a "booking cancelled" notification with the reason', (await notes(s2, 'booking_cancelled')).some((n) => n.message.includes('Leaking')));
  check('Out of order', 'An out-of-order machine cannot be booked (409)', await statusOf(() => s3.post('/api/bookings', { machineId: w2.id, date: day(2), slotStart: '10:00' })) === 409);
  check('Out of order', 'It shows as out of order in the grid', cellOf(await s3.get(`/api/rooms/${room.id}/availability?date=${day(2)}`), w2.id, '10:00:00').state === 'out_of_order');
  check('Out of order', 'Marking it twice rejected (409)', await statusOf(() => admin.post(`/api/machines/${w2.id}/outage`, { reason: 'Second fault' })) === 409);
  await admin.post(`/api/machines/${w2.id}/repair`);
  check('Out of order', 'Back in service: it can be booked again', !!(await s3.post('/api/bookings', { machineId: w2.id, date: day(2), slotStart: '10:00' })).id);
  check('Out of order', 'The outage history is kept', (await admin.get(`/api/machines/${w2.id}/outages`)).length === 1);

  // ---------- Start cycle, done, collected ----------
  check('Cycle', "Can't start a booking for tomorrow yet (409)", await statusOf(() => s1.post(`/api/bookings/${b1.id}/start`)) === 409);
  await moveSlot(b1.id, -2); // the slot started 2 minutes ago
  check('Cycle', "Only the student who booked can start it (403)", await statusOf(() => admin.post(`/api/bookings/${b1.id}/start`)) === 403);
  const started = await s1.post(`/api/bookings/${b1.id}/start`);
  check('Cycle', 'Start: status in progress with a finish time 45 minutes later', started.status === 'in_progress'
    && Math.abs(new Date(started.finishes_at) - Date.now() - 45 * 60e3) < 120e3);
  check('Cycle', 'Starting twice rejected (409)', await statusOf(() => s1.post(`/api/bookings/${b1.id}/start`)) === 409);
  check('Cycle', 'Collecting while it is still running rejected (409)', await statusOf(() => s1.post(`/api/bookings/${b1.id}/collect`)) === 409);
  // Another student's later booking on the same machine today, to be told it is free.
  const [[{ later_ok: laterOk }]] = await pool.query("SELECT CURTIME() < '21:30:00' AND CURTIME() > '00:30:00' AS later_ok");
  if (laterOk) await moveSlot(b4.id, 40);
  await pool.query('UPDATE bookings SET started_at = NOW() - INTERVAL 46 MINUTE, finishes_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [b1.id]);
  await sleep(2100); // the scheduler runs at most every 2 seconds per request
  check('Cycle', 'Done: the scheduler marks the finished cycle as done', (await s1.get(`/api/bookings/${b1.id}`)).status === 'done');
  check('Notifications', 'Done: the student is notified that the laundry is done', (await notes(s1, 'cycle_done')).length === 1);
  await s1.post(`/api/bookings/${b1.id}/collect`);
  check('Cycle', 'Collected: status and collection time recorded', (await s1.get(`/api/bookings/${b1.id}`)).status === 'collected');
  if (laterOk) {
    check('Notifications', 'Machine free: the next student booked on W1 today is told it is free', (await notes(s2, 'machine_free')).some((n) => n.message.includes('W1')));
  } else {
    console.log('SKIP  [Notifications] next-student check (too close to midnight to place a later slot today)');
  }
  const hist = await s1.get('/api/bookings?view=history');
  check('Booking', 'Read: history lists the collected and cancelled bookings', hist.some((b) => b.id === b1.id) && hist.some((b) => b.id === b2.id));

  // ---------- Reminder and no-show ----------
  const b7 = await s1.post('/api/bookings', { machineId: w1.id, date: day(3), slotStart: '08:00' });
  await moveSlot(b7.id, 20); // starts in 20 minutes
  await sleep(2100);
  await s1.get('/api/bookings');
  await sleep(2100);
  await s1.get('/api/bookings');
  check('Notifications', 'Reminder: sent once, 30 minutes before the slot', (await notes(s1, 'reminder')).filter((n) => n.booking_id === b7.id).length === 1);
  await s3.post('/api/waitlist', { roomId: room.id, date: day(0), kind: 'washer' }).catch(() => {});
  await moveSlot(b7.id, -20); // started 20 minutes ago and never started
  await sleep(2100);
  await s1.get('/api/bookings');
  check('No-show', 'Missed slot: marked as no-show after 15 minutes', (await s1.get(`/api/bookings/${b7.id}`)).status === 'no_show');
  check('No-show', 'The student is told the booking was released', (await notes(s1, 'no_show')).length === 1);
  check('No-show', 'The next student waiting for a washer that day is notified', (await notes(s3, 'machine_free')).some((n) => n.message.includes('not used')));

  // ---------- Notifications ----------
  const before = await s1.get('/api/notifications/unread');
  const first = (await s1.get('/api/notifications')).notifications[0];
  await s1.post(`/api/notifications/${first.id}/read`);
  check('Notifications', 'Mark one as read lowers the unread count', (await s1.get('/api/notifications/unread')).unread === before.unread - 1);
  await s1.post('/api/notifications/read-all');
  check('Notifications', 'Mark all as read', (await s1.get('/api/notifications/unread')).unread === 0);
  check('Notifications', "Can't read someone else's notification (404)", await statusOf(() => s2.post(`/api/notifications/${first.id}/read`)) === 404);
  await s1.del(`/api/notifications/${first.id}`);
  check('Notifications', 'Delete a notification', !(await s1.get('/api/notifications')).notifications.some((n) => n.id === first.id));

  // ---------- Tips ----------
  const seeded = await s1.get('/api/tips');
  check('Tips', 'Read: students see the tips in all four categories', ['sorting', 'detergents', 'fabrics', 'maintenance'].every((c) => seeded.some((t) => t.category === c)));
  const tip = await admin.post('/api/tips', { category: 'fabrics', title: `Drying towels ${tag}`, body: 'Dry towels on high heat and shake them out first.', isPublished: false });
  check('Tips', 'Drafts are hidden from students', !(await s1.get('/api/tips')).some((t) => t.id === tip.id));
  await admin.put(`/api/tips/${tip.id}`, { category: 'fabrics', title: `Drying towels ${tag}`, body: 'Dry towels on high heat and shake them out first.', isPublished: true });
  check('Tips', 'Update: published tip visible to students', (await s1.get('/api/tips?category=fabrics')).some((t) => t.id === tip.id));
  check('Tips', 'Students cannot write tips (403)', await statusOf(() => s1.post('/api/tips', { category: 'sorting', title: 'My own tip', body: 'This should not be allowed at all.' })) === 403);
  await admin.del(`/api/tips/${tip.id}`);
  check('Tips', 'Delete: tip removed', !(await admin.get('/api/tips')).some((t) => t.id === tip.id));

  // ---------- Feedback ----------
  check('Feedback', 'A rating of 6 stars rejected (400)', await statusOf(() => s1.post('/api/feedback', { kind: 'rating', rating: 6, roomId: room.id })) === 400);
  await s1.post('/api/feedback', { kind: 'rating', rating: 4, roomId: room.id, comment: 'Clean and quick.' });
  check('Feedback', 'An issue needs a room (400)', await statusOf(() => s2.post('/api/feedback', { kind: 'issue', comment: 'Something is broken.' })) === 400);
  const issue = await s2.post('/api/feedback', { kind: 'issue', machineId: d1.id, comment: 'D1 stops after 10 minutes with error E3.' });
  const mine = await s2.get('/api/feedback');
  check('Feedback', 'Create: issue linked to the machine and its room; students see only their own', mine.length === 1 && mine[0].room === `Test Res A ${tag}` && mine[0].machine_code === 'D1');
  check('Feedback', 'Admin sees all open feedback', (await admin.get(`/api/feedback?status=open&roomId=${room.id}`)).length === 2);
  check('Feedback', 'Dismissing needs an explanation (400)', await statusOf(() => admin.patch(`/api/feedback/${issue.id}`, { status: 'dismissed' })) === 400);
  await admin.patch(`/api/feedback/${issue.id}`, { status: 'resolved', response: 'The technician replaced the sensor.' });
  check('Feedback', 'Respond: status and reply saved, student notified', (await s2.get('/api/feedback'))[0].status === 'resolved'
    && (await notes(s2, 'feedback_reply')).some((n) => n.message.includes('sensor')));
  check('Feedback', 'Students cannot respond to feedback (403)', await statusOf(() => s2.patch(`/api/feedback/${issue.id}`, { status: 'resolved' })) === 403);

  // ---------- Reports and history (admin) ----------
  const stats = await admin.get('/api/stats?days=30');
  check('Reports', 'Usage report: per machine, per room and per hour', stats.machines.some((m) => m.code === 'W1' && m.washes >= 1) && stats.rooms.some((r) => r.name === `Test Res A ${tag}`) && stats.busiestHours.length > 0);
  check('Reports', 'Students cannot see the reports (403)', await statusOf(() => s1.get('/api/stats')) === 403);
  const historyAll = await admin.get(`/api/admin/bookings?roomId=${room.id}&search=${encodeURIComponent('Student One')}`);
  check('Reports', 'Booking history filtered by room and student', historyAll.total >= 3 && historyAll.bookings.every((b) => b.student === 'Student One'));
  await admin.post(`/api/bookings/${b5.id}/cancel`);
  check('Reports', 'Admin cancels a booking; the student is notified', (await notes(s3, 'booking_cancelled')).length === 1);

  // ---------- Integrity through the API ----------
  check('Integrity', 'A room with machines cannot be deleted (409, RESTRICT)', await statusOf(() => admin.del(`/api/rooms/${room.id}`)) === 409);
  check('Integrity', 'A machine with booking history cannot be deleted (409, RESTRICT)', await statusOf(() => admin.del(`/api/machines/${w1.id}`)) === 409);
  check('Integrity', 'Slot length cannot change while there are upcoming bookings (409)', await statusOf(() => admin.put(`/api/rooms/${room.id}`, { name: `Test Res A ${tag}`, opensAt: '06:00', closesAt: '22:00', slotMinutes: 90 })) === 409);
  await admin.del(`/api/machines/${spare.id}`);
  check('Machines', 'Delete: a machine without bookings is deleted', !(await admin.get('/api/machines?all=1')).some((m) => m.id === spare.id));
  const retire = await admin.patch(`/api/machines/${w2.id}`, { isActive: false });
  check('Machines', 'Retire: the machine leaves the grid and its upcoming bookings are cancelled', retire.cancelled === 1
    && !(await s3.get(`/api/rooms/${room.id}/availability?date=${day(2)}`)).machines.some((m) => m.id === w2.id));

  // ---------- Accounts (admin) ----------
  await admin.patch(`/api/admin/users/${r2.id}`, { isActive: false });
  check('Admin', 'Deactivated student cannot log in (403)', await statusOf(() => new Client().login(emailFor('s2'))) === 403);
  check('Admin', "Deactivated student's session ends (401)", await statusOf(() => s2.get('/api/bookings')) === 401);
  check('Admin', 'Deactivating releases their upcoming bookings', (await pool.query("SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'booked'", [r2.id]))[0][0].n === 0);
  await admin.patch(`/api/admin/users/${r2.id}`, { isActive: true });
  const { tempPassword } = await admin.post(`/api/admin/users/${r2.id}/reset-password`);
  await s2.login(emailFor('s2'), tempPassword);
  check('Admin', 'Temporary password must be changed first (403)', await statusOf(() => s2.get('/api/bookings')) === 403);
  await s2.put('/api/auth/password', { currentPassword: tempPassword, newPassword: PASSWORD });
  const adminId = (await admin.get('/api/auth/me')).id;
  check('Admin', 'An admin without a student number cannot become a student (400)', await statusOf(async () => {
    const other = await pool.query("INSERT INTO users (full_name, email, password_hash, role) VALUES ('Other Admin', ?, 'x', 'admin')", [emailFor('admin2')]);
    await admin.patch(`/api/admin/users/${other[0].insertId}`, { role: 'student' });
  }) === 400);
  check('Admin', "Admin can't demote themselves (400)", await statusOf(() => admin.patch(`/api/admin/users/${adminId}`, { role: 'student' })) === 400);

  // ---------- Records are kept when people leave ----------
  await s1.del('/api/auth/me', { password: PASSWORD });
  const [[kept]] = await pool.query('SELECT COUNT(*) AS n FROM bookings WHERE id IN (?, ?, ?) AND user_id IS NULL', [b1.id, b2.id, b3.id]);
  check('Records', 'Deleting an account keeps its booking history ("former student")', kept.n === 3);
}

// Removes everything this run created, straight from the database.
async function cleanUp() {
  const like = `%.${tag}@apitest.test`;
  if (created.rooms.length) {
    await pool.query('DELETE FROM feedback WHERE room_id IN (?)', [created.rooms]);
    await pool.query('DELETE b FROM bookings b JOIN machines m ON m.id = b.machine_id WHERE m.room_id IN (?)', [created.rooms]);
    await pool.query('DELETE FROM machines WHERE room_id IN (?)', [created.rooms]);
  }
  await pool.query('DELETE FROM laundry_tips WHERE title LIKE ?', [`%${tag}`]);
  await pool.query('DELETE FROM users WHERE email LIKE ?', [like]);
  if (created.rooms.length) await pool.query('DELETE FROM laundry_rooms WHERE id IN (?)', [created.rooms]);
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE email LIKE ?', [like]);
  return n === 0;
}

main()
  .catch((err) => { console.error('Test run stopped:', err.message); process.exitCode = 1; })
  .finally(async () => {
    const clean = await cleanUp().catch((e) => { console.error('Clean-up failed:', e.message); return false; });
    await pool.end();
    const passed = results.filter((r) => r.pass).length;
    console.log(`\n${passed}/${results.length} API tests passed.${clean ? ' All test accounts and data were removed.' : ''}`);
    if (passed !== results.length || !clean) process.exitCode = 1;
  });
