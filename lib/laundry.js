// Laundry rules shared by the routes: time slots, booking limits, notifications,
// the waiting list and the background scheduler.
const pool = require('../db/pool');

const BOOK_DAYS_AHEAD = 7;        // students can book today and the next 7 days
const MAX_UPCOMING = 3;           // open bookings (booked / running / done) per student
const START_EARLY_MINUTES = 5;    // "Start cycle" allowed from 5 minutes before the slot
const NO_SHOW_MINUTES = 15;       // a booking not started 15 minutes into its slot is a no-show
const REMINDER_MINUTES = 30;      // reminder this long before the slot starts
const LIVE_STATUSES = ['booked', 'in_progress', 'done'];

const pad = (n) => String(n).padStart(2, '0');
const toMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const toTime = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`;
const hhmm = (t) => String(t).slice(0, 5);

// 'YYYY-MM-DD' in server time, offset by whole days.
function localDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The booking slots of a room: [{ start: 'HH:MM:00', end: 'HH:MM:00' }, ...]
function slotsFor(room) {
  const slots = [];
  const close = toMinutes(room.closes_at);
  for (let m = toMinutes(room.opens_at); m + room.slot_minutes <= close; m += room.slot_minutes) {
    slots.push({ start: toTime(m), end: toTime(m + room.slot_minutes) });
  }
  return slots;
}

// SQL condition: the machine (alias m) can be used (not retired, not out of order).
const MACHINE_USABLE_SQL = `m.is_active AND NOT EXISTS (
  SELECT 1 FROM machine_outages o WHERE o.machine_id = m.id AND o.ended_at IS NULL)`;

// Sends an in-app notification. A booking gets each kind of notification at most once
// (uq_notifications_booking_kind), so calling this twice is harmless.
async function notify(conn, userId, kind, message, bookingId = null) {
  if (!userId) return false;
  const [r] = await conn.query(
    'INSERT IGNORE INTO notifications (user_id, booking_id, kind, message) VALUES (?, ?, ?, ?)',
    [userId, bookingId, kind, message.slice(0, 255)]);
  return r.affectedRows === 1;
}

// A booking became free: tell the next student waiting for that room, day and kind of machine.
async function notifyWaitlist(conn, roomId, date, kind, text) {
  const [[next]] = await conn.query(`
    SELECT id, user_id FROM waitlist_entries
    WHERE room_id = ? AND wait_date = ? AND kind = ? AND notified_at IS NULL
    ORDER BY created_at, id LIMIT 1 FOR UPDATE`, [roomId, date, kind]);
  if (!next) return null;
  await conn.query('UPDATE waitlist_entries SET notified_at = NOW() WHERE id = ?', [next.id]);
  await notify(conn, next.user_id, 'machine_free', text);
  return next.user_id;
}

// Details used in notification messages.
async function bookingInfo(conn, bookingId) {
  const [[b]] = await conn.query(`
    SELECT b.*, m.code, m.kind, m.cycle_minutes, m.room_id, r.name AS room
    FROM bookings b JOIN machines m ON m.id = b.machine_id JOIN laundry_rooms r ON r.id = m.room_id
    WHERE b.id = ?`, [bookingId]);
  return b;
}
const describe = (b) => `${b.kind} ${b.code} in ${b.room}`;
const whenText = (b) => `${b.booking_date === localDate() ? 'today' : b.booking_date} at ${hhmm(b.slot_start)}`;

// ---------------------------------------------------------------- scheduler
// Moves bookings along with the clock and sends the time-based notifications.
// Runs every 30 seconds and before pages that show bookings; every step is safe
// to repeat because each row is only changed if it is still in the expected state.
async function runScheduler() {
  // 1. Reminders shortly before a booking starts.
  const [soon] = await pool.query(`
    SELECT b.id FROM bookings b
    WHERE b.status = 'booked'
      AND TIMESTAMP(b.booking_date, b.slot_start) BETWEEN NOW() AND NOW() + INTERVAL ? MINUTE`, [REMINDER_MINUTES]);
  for (const { id } of soon) {
    const b = await bookingInfo(pool, id);
    await notify(pool, b.user_id, 'reminder', `Reminder: your ${describe(b)} starts ${whenText(b)}. Tap "Start cycle" when you load it.`, b.id);
  }

  // 2. Cycles that have finished.
  const [finished] = await pool.query("SELECT id FROM bookings WHERE status = 'in_progress' AND finishes_at <= NOW()");
  for (const { id } of finished) {
    const [r] = await pool.query("UPDATE bookings SET status = 'done' WHERE id = ? AND status = 'in_progress'", [id]);
    if (r.affectedRows) {
      const b = await bookingInfo(pool, id);
      await notify(pool, b.user_id, 'cycle_done', `Your laundry in ${describe(b)} is done. Please collect it now so the next student can start.`, b.id);
    }
  }

  // 3. No-shows: not started 15 minutes into the slot. The machine is free for others.
  const [missed] = await pool.query(`
    SELECT id FROM bookings
    WHERE status = 'booked' AND TIMESTAMP(booking_date, slot_start) + INTERVAL ? MINUTE < NOW()`, [NO_SHOW_MINUTES]);
  for (const { id } of missed) {
    const [r] = await pool.query("UPDATE bookings SET status = 'no_show' WHERE id = ? AND status = 'booked'", [id]);
    if (r.affectedRows) {
      const b = await bookingInfo(pool, id);
      await notify(pool, b.user_id, 'no_show', `You missed your booking for ${describe(b)} ${whenText(b)}, so it was released for other students.`, b.id);
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await notifyWaitlist(conn, b.room_id, b.booking_date, b.kind,
          `A ${b.kind} is free in ${b.room} (${b.code}, ${hhmm(b.slot_start)} slot was not used). Book a slot now.`);
        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }
    }
  }
}

// Background timer plus a call before booking pages, at most once per 2 seconds.
let lastRun = 0;
let running = null;
function tick(force = false) {
  if (running) return running;
  if (!force && Date.now() - lastRun < 2000) return Promise.resolve();
  lastRun = Date.now();
  running = runScheduler().catch((err) => console.error('Scheduler error:', err.message)).finally(() => { running = null; });
  return running;
}
function startScheduler() {
  tick(true);
  return setInterval(() => tick(true), 30 * 1000);
}
// Express middleware: bring bookings up to date before answering.
const freshBookings = async (req, res, next) => { await tick(); next(); };

module.exports = {
  BOOK_DAYS_AHEAD, MAX_UPCOMING, START_EARLY_MINUTES, NO_SHOW_MINUTES, REMINDER_MINUTES, LIVE_STATUSES, MACHINE_USABLE_SQL,
  toMinutes, toTime, hhmm, localDate, slotsFor, notify, notifyWaitlist, bookingInfo, describe, whenText,
  runScheduler, tick, startScheduler, freshBookings,
};
