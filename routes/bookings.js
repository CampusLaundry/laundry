// Bookings: a student books a machine for a slot, can cancel or reschedule it, starts
// the cycle when loading the machine and marks the laundry collected.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../lib/middleware');
const { fail, date, int, time, inTransaction } = require('../lib/validate');
const {
  BOOK_DAYS_AHEAD, MAX_UPCOMING, START_EARLY_MINUTES, NO_SHOW_MINUTES, MACHINE_USABLE_SQL,
  slotsFor, localDate, hhmm, notify, notifyWaitlist, bookingInfo, describe, whenText, freshBookings,
} = require('../lib/laundry');

const router = express.Router();
router.use(requireLogin);

const BOOKING_SELECT = `
  SELECT b.id, b.user_id, b.machine_id, b.booking_date, b.slot_start, b.slot_end, b.status,
         b.started_at, b.finishes_at, b.collected_at, b.cancelled_at, b.created_at,
         m.code, m.kind, m.cycle_minutes, m.room_id, r.name AS room, r.location,
         TIMESTAMP(b.booking_date, b.slot_start) AS starts_at, TIMESTAMP(b.booking_date, b.slot_end) AS ends_at
  FROM bookings b JOIN machines m ON m.id = b.machine_id JOIN laundry_rooms r ON r.id = m.room_id`;

// What the student may do with a booking right now.
function actionsFor(b, now) {
  const start = new Date(b.starts_at);
  const end = new Date(b.ends_at);
  const canStart = b.status === 'booked' && now >= start - START_EARLY_MINUTES * 60e3 && now < start.getTime() + NO_SHOW_MINUTES * 60e3;
  return {
    start: canStart,
    collect: b.status === 'done',
    cancel: b.status === 'booked' && now < start,
    reschedule: b.status === 'booked' && now < start,
    late: b.status === 'done' && now > end,
  };
}

// Checks that a machine can be booked for this date and slot; returns { machine, room, slot }.
async function checkSlot(conn, machineId, day, slotStart) {
  const [[machine]] = await conn.query(`
    SELECT m.*, (${MACHINE_USABLE_SQL}) AS usable FROM machines m WHERE m.id = ?`, [machineId]);
  if (!machine) fail(404, 'Machine not found.');
  if (!machine.usable) fail(409, `${machine.code} is out of order or out of service. Choose another machine.`);
  const [[room]] = await conn.query('SELECT * FROM laundry_rooms WHERE id = ?', [machine.room_id]);
  if (!room.is_active) fail(409, `${room.name} is closed for bookings.`);
  if (day < localDate() || day > localDate(BOOK_DAYS_AHEAD)) fail(400, `You can book from today up to ${BOOK_DAYS_AHEAD} days ahead.`);
  const slot = slotsFor(room).find((s) => s.start === slotStart);
  if (!slot) fail(400, `${hhmm(slotStart)} is not a slot in ${room.name} (open ${hhmm(room.opens_at)}–${hhmm(room.closes_at)}, ${room.slot_minutes}-minute slots).`);
  const [[{ late }]] = await conn.query('SELECT TIMESTAMP(?, ?) + INTERVAL ? MINUTE <= NOW() AS late', [day, slotStart, NO_SHOW_MINUTES]);
  if (late) fail(409, 'That slot has already started. Choose a later slot.');
  return { machine, room, slot };
}

// Turns a duplicate-key error into the right message (the database stops double bookings).
function duplicateMessage(err) {
  if (err.code !== 'ER_DUP_ENTRY') return null;
  if (err.message.includes('uq_bookings_machine_slot')) return 'Sorry, someone has just booked that slot. Choose another one.';
  if (err.message.includes('uq_bookings_user_slot')) return 'You already have a machine booked at that time.';
  return null;
}

// ---------------------------------------------------------------- list
// Students: their own bookings. ?view=upcoming (default) | history
router.get('/', freshBookings, async (req, res) => {
  const history = req.query.view === 'history';
  const [rows] = await pool.query(`${BOOKING_SELECT}
    WHERE b.user_id = ? AND ${history
    ? "b.status IN ('collected', 'cancelled', 'no_show')"
    : "b.status IN ('booked', 'in_progress', 'done')"}
    ORDER BY b.booking_date ${history ? 'DESC' : 'ASC'}, b.slot_start ${history ? 'DESC' : 'ASC'}
    LIMIT 200`, [req.session.user.id]);
  const now = Date.now();
  res.json(rows.map((b) => ({ ...b, actions: actionsFor(b, now) })));
});

router.get('/:id', freshBookings, async (req, res) => {
  const [[b]] = await pool.query(`${BOOKING_SELECT} WHERE b.id = ?`, [req.params.id]);
  if (!b || (b.user_id !== req.session.user.id && req.session.user.role !== 'admin')) fail(404, 'Booking not found.');
  res.json({ ...b, actions: actionsFor(b, Date.now()) });
});

// ---------------------------------------------------------------- book
// Body: { machineId, date, slotStart }
router.post('/', async (req, res) => {
  const user = req.session.user;
  const machineId = int(req.body.machineId, 'The machine', 1, 2147483647);
  const day = date(req.body.date, 'date');
  const slotStart = time(req.body.slotStart, 'slot');
  const id = await inTransaction(async (conn) => {
    // Lock this student's own row first, so two bookings by the same student are handled
    // one after the other and the limit below is counted correctly. (Locking the bookings
    // themselves locked index ranges shared with other students and caused deadlocks.)
    await conn.query('SELECT id FROM users WHERE id = ? FOR UPDATE', [user.id]);
    const { machine, room, slot } = await checkSlot(conn, machineId, day, slotStart);
    const [open] = await conn.query("SELECT id FROM bookings WHERE user_id = ? AND status IN ('booked', 'in_progress', 'done')", [user.id]);
    if (open.length >= MAX_UPCOMING) fail(409, `You can have at most ${MAX_UPCOMING} open bookings. Finish or cancel one first.`);
    let r;
    try {
      [r] = await conn.query('INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end) VALUES (?, ?, ?, ?, ?)',
        [user.id, machine.id, day, slot.start, slot.end]);
    } catch (err) {
      const msg = duplicateMessage(err);
      if (msg) fail(409, msg);
      throw err;
    }
    // Got a machine, so they no longer need to wait for one.
    await conn.query('DELETE FROM waitlist_entries WHERE user_id = ? AND room_id = ? AND wait_date = ? AND kind = ?', [user.id, room.id, day, machine.kind]);
    return r.insertId;
  });
  res.status(201).json({ id });
});

// Loads a booking for a change by its owner (or an admin), locked for the transaction.
async function ownBooking(conn, req) {
  const [[b]] = await conn.query('SELECT id, user_id FROM bookings WHERE id = ? FOR UPDATE', [req.params.id]);
  const isAdmin = req.session.user.role === 'admin';
  if (!b || (b.user_id !== req.session.user.id && !isAdmin)) fail(404, 'Booking not found.');
  return { booking: await bookingInfo(conn, b.id), byAdmin: b.user_id !== req.session.user.id };
}

// ---------------------------------------------------------------- reschedule
// Body: { machineId?, date, slotStart }. Only while it is still "booked" and hasn't started.
router.put('/:id', async (req, res) => {
  const day = date(req.body.date, 'date');
  const slotStart = time(req.body.slotStart, 'slot');
  await inTransaction(async (conn) => {
    const { booking: b } = await ownBooking(conn, req);
    if (b.status !== 'booked') fail(409, 'Only a booking that has not started can be rescheduled.');
    const [[{ started }]] = await conn.query('SELECT TIMESTAMP(?, ?) <= NOW() AS started', [b.booking_date, b.slot_start]);
    if (started) fail(409, 'This booking has already started, so it cannot be rescheduled.');
    const machineId = req.body.machineId ? int(req.body.machineId, 'The machine', 1, 2147483647) : b.machine_id;
    const { machine, slot } = await checkSlot(conn, machineId, day, slotStart);
    try {
      await conn.query('UPDATE bookings SET machine_id = ?, booking_date = ?, slot_start = ?, slot_end = ? WHERE id = ?',
        [machine.id, day, slot.start, slot.end, b.id]);
    } catch (err) {
      const msg = duplicateMessage(err);
      if (msg) fail(409, msg);
      throw err;
    }
    // A new time needs a new reminder.
    await conn.query("DELETE FROM notifications WHERE booking_id = ? AND kind IN ('reminder', 'machine_free')", [b.id]);
    await notifyWaitlist(conn, b.room_id, b.booking_date, b.kind,
      `A ${b.kind} is free in ${b.room}: ${b.code} at ${hhmm(b.slot_start)} on ${b.booking_date} was released. Book it now.`);
  });
  res.json({ id: Number(req.params.id) });
});

// ---------------------------------------------------------------- cancel
router.post('/:id/cancel', async (req, res) => {
  await inTransaction(async (conn) => {
    const { booking: b, byAdmin } = await ownBooking(conn, req);
    if (b.status !== 'booked') fail(409, 'Only a booking that has not started can be cancelled.');
    if (!byAdmin) {
      const [[{ started }]] = await conn.query('SELECT TIMESTAMP(?, ?) <= NOW() AS started', [b.booking_date, b.slot_start]);
      if (started) fail(409, 'Your slot has already started. Start the cycle, or leave it and it will be released automatically.');
    }
    await conn.query("UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?", [b.id]);
    if (byAdmin) {
      await notify(conn, b.user_id, 'booking_cancelled', `The laundry administrator cancelled your booking for ${describe(b)} ${whenText(b)}.`, b.id);
    }
    await notifyWaitlist(conn, b.room_id, b.booking_date, b.kind,
      `A ${b.kind} is free in ${b.room}: ${b.code} at ${hhmm(b.slot_start)} on ${b.booking_date} was cancelled. Book it now.`);
  });
  res.json({ id: Number(req.params.id), status: 'cancelled' });
});

// ---------------------------------------------------------------- start cycle
// The student has loaded the machine. The cycle finishes after the machine's cycle time;
// the scheduler then marks it done and notifies the student.
router.post('/:id/start', async (req, res) => {
  const finishesAt = await inTransaction(async (conn) => {
    const { booking: b } = await ownBooking(conn, req);
    if (b.user_id !== req.session.user.id) fail(403, 'Only the student who booked can start the cycle.');
    if (b.status !== 'booked') fail(409, 'This booking has already been started, or is no longer active.');
    const [[t]] = await conn.query(`
      SELECT NOW() >= TIMESTAMP(?, ?) - INTERVAL ? MINUTE AS open_now,
             NOW() >= TIMESTAMP(?, ?) + INTERVAL ? MINUTE AS too_late`,
    [b.booking_date, b.slot_start, START_EARLY_MINUTES, b.booking_date, b.slot_start, NO_SHOW_MINUTES]);
    if (!t.open_now) fail(409, `You can start the cycle from ${START_EARLY_MINUTES} minutes before your slot (${hhmm(b.slot_start)}).`);
    if (t.too_late) fail(409, 'Your slot started more than 15 minutes ago, so it was released.');
    const [[{ usable }]] = await conn.query(`SELECT (${MACHINE_USABLE_SQL}) AS usable FROM machines m WHERE m.id = ?`, [b.machine_id]);
    if (!usable) fail(409, `${b.code} has been marked out of order. Please book another machine.`);
    // The previous student's cycle may still be running.
    const [[busy]] = await conn.query(
      "SELECT finishes_at FROM bookings WHERE machine_id = ? AND status = 'in_progress' AND id <> ? AND finishes_at > NOW()", [b.machine_id, b.id]);
    if (busy) fail(409, `The previous cycle on ${b.code} is still running until ${hhmm(new Date(busy.finishes_at).toTimeString())}.`);
    await conn.query(`
      UPDATE bookings SET status = 'in_progress', started_at = NOW(), finishes_at = NOW() + INTERVAL ? MINUTE WHERE id = ?`,
    [b.cycle_minutes, b.id]);
    const [[row]] = await conn.query('SELECT finishes_at FROM bookings WHERE id = ?', [b.id]);
    return row.finishes_at;
  });
  res.json({ id: Number(req.params.id), status: 'in_progress', finishes_at: finishesAt });
});

// ---------------------------------------------------------------- collected
// The laundry is out, so the machine is free: tell the student with the next booking on it today.
router.post('/:id/collect', async (req, res) => {
  await inTransaction(async (conn) => {
    const { booking: b } = await ownBooking(conn, req);
    if (b.status !== 'done') fail(409, b.status === 'in_progress' ? 'The cycle is still running.' : 'This laundry has already been collected or the booking is not active.');
    await conn.query("UPDATE bookings SET status = 'collected', collected_at = NOW() WHERE id = ?", [b.id]);
    const [[next]] = await conn.query(`
      SELECT id FROM bookings
      WHERE machine_id = ? AND booking_date = CURDATE() AND status = 'booked' AND slot_start > CURTIME()
      ORDER BY slot_start LIMIT 1`, [b.machine_id]);
    if (next) {
      const n = await bookingInfo(conn, next.id);
      await notify(conn, n.user_id, 'machine_free',
        `${describe(n)} is free now. Your slot starts at ${hhmm(n.slot_start)}; you can start up to ${START_EARLY_MINUTES} minutes early.`, n.id);
    }
  });
  res.json({ id: Number(req.params.id), status: 'collected' });
});

module.exports = router;
