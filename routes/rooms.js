// Laundry rooms: everyone can list them (the sign-up form needs them); students see a
// room's availability grid; only administrators change rooms.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../lib/middleware');
const { fail, text, optionalText, date, int, time } = require('../lib/validate');
const { BOOK_DAYS_AHEAD, NO_SHOW_MINUTES, LIVE_STATUSES, slotsFor, localDate, toMinutes, freshBookings } = require('../lib/laundry');

const router = express.Router();

function readRoom(body) {
  const room = {
    name: text(body.name, 'The name', 2, 100),
    location: optionalText(body.location, 'The location', 200),
    opensAt: time(body.opensAt, 'opening time'),
    closesAt: time(body.closesAt, 'closing time'),
    slotMinutes: int(body.slotMinutes, 'The slot length', 30, 240),
    isActive: body.isActive === undefined ? true : !!body.isActive,
  };
  if (room.closesAt <= room.opensAt) fail(400, 'The room must close after it opens.');
  if (toMinutes(room.closesAt) - toMinutes(room.opensAt) < room.slotMinutes) fail(400, 'The opening hours must fit at least one slot.');
  return room;
}

async function findRoom(id) {
  const [[room]] = await pool.query('SELECT * FROM laundry_rooms WHERE id = ?', [id]);
  if (!room) fail(404, 'Laundry room not found.');
  return room;
}

// ?all=1 includes closed rooms (admin screen).
router.get('/', async (req, res) => {
  const all = req.query.all === '1';
  const [rows] = await pool.query(`
    SELECT r.*,
           (SELECT COUNT(*) FROM machines m WHERE m.room_id = r.id AND m.is_active AND m.kind = 'washer') AS washers,
           (SELECT COUNT(*) FROM machines m WHERE m.room_id = r.id AND m.is_active AND m.kind = 'dryer') AS dryers,
           (SELECT COUNT(*) FROM machines m WHERE m.room_id = r.id AND m.is_active
              AND EXISTS (SELECT 1 FROM machine_outages o WHERE o.machine_id = m.id AND o.ended_at IS NULL)) AS out_of_order
    FROM laundry_rooms r ${all ? '' : 'WHERE r.is_active'} ORDER BY r.name`);
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active })));
});

// The booking grid of a room for one day: every machine × every slot.
// Cell states: free, mine, taken, past, out_of_order.
router.get('/:id/availability', requireLogin, freshBookings, async (req, res) => {
  const user = req.session.user;
  const room = await findRoom(req.params.id);
  const day = req.query.date ? date(req.query.date, 'date') : localDate();
  const slots = slotsFor(room);
  const [machines] = await pool.query(`
    SELECT m.id, m.code, m.kind, m.cycle_minutes,
           (SELECT o.reason FROM machine_outages o WHERE o.machine_id = m.id AND o.ended_at IS NULL) AS outage_reason
    FROM machines m WHERE m.room_id = ? AND m.is_active
    ORDER BY m.kind = 'dryer', m.code`, [room.id]);
  const [bookings] = await pool.query(`
    SELECT b.id, b.machine_id, b.slot_start, b.status, b.user_id, u.full_name AS student
    FROM bookings b JOIN machines m ON m.id = b.machine_id LEFT JOIN users u ON u.id = b.user_id
    WHERE m.room_id = ? AND b.booking_date = ? AND b.status IN (?)`, [room.id, day, LIVE_STATUSES]);
  const [[{ now_min: nowMin, today }]] = await pool.query("SELECT HOUR(NOW()) * 60 + MINUTE(NOW()) AS now_min, DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");

  const isPast = (slot) => day < today || (day === today && toMinutes(slot.start) + NO_SHOW_MINUTES <= nowMin);
  const grid = machines.map((m) => ({
    ...m,
    out_of_order: !!m.outage_reason,
    cells: slots.map((s) => {
      const b = bookings.find((x) => x.machine_id === m.id && x.slot_start === s.start);
      if (b && b.user_id === user.id) return { start: s.start, state: 'mine', bookingId: b.id, status: b.status };
      if (b) return { start: s.start, state: 'taken', status: b.status, ...(user.role === 'admin' ? { student: b.student, bookingId: b.id } : {}) };
      if (isPast(s)) return { start: s.start, state: 'past' };
      if (m.outage_reason) return { start: s.start, state: 'out_of_order' };
      return { start: s.start, state: 'free' };
    }),
  }));
  const [waitlist] = await pool.query(
    'SELECT id, kind, notified_at FROM waitlist_entries WHERE user_id = ? AND room_id = ? AND wait_date = ?', [user.id, room.id, day]);
  res.json({
    room: { ...room, is_active: !!room.is_active },
    date: day, today, lastDate: localDate(BOOK_DAYS_AHEAD),
    bookable: !!room.is_active && day >= today && day <= localDate(BOOK_DAYS_AHEAD),
    slots, machines: grid, waitlist,
  });
});

router.post('/', requireRole('admin'), async (req, res) => {
  const r = readRoom(req.body);
  try {
    const [result] = await pool.query(
      'INSERT INTO laundry_rooms (name, location, opens_at, closes_at, slot_minutes, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      [r.name, r.location, r.opensAt, r.closesAt, r.slotMinutes, r.isActive]);
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A laundry room with this name already exists.' });
    throw err;
  }
});

router.put('/:id', requireRole('admin'), async (req, res) => {
  const room = await findRoom(req.params.id);
  const r = readRoom(req.body);
  // Changing the slot grid would leave existing future bookings off the grid.
  const gridChanged = r.opensAt !== room.opens_at || r.closesAt !== room.closes_at || r.slotMinutes !== room.slot_minutes;
  if (gridChanged) {
    const [[{ n }]] = await pool.query(`
      SELECT COUNT(*) AS n FROM bookings b JOIN machines m ON m.id = b.machine_id
      WHERE m.room_id = ? AND b.status = 'booked'`, [room.id]);
    if (n) fail(409, `${n} upcoming booking${n === 1 ? '' : 's'} use the current time slots. Change the hours or slot length when there are no upcoming bookings.`);
    const [[{ longest }]] = await pool.query('SELECT MAX(cycle_minutes) AS longest FROM machines WHERE room_id = ? AND is_active', [room.id]);
    if (longest && longest > r.slotMinutes) fail(400, `A machine in this room needs ${longest} minutes, so slots must be at least that long.`);
  }
  try {
    await pool.query('UPDATE laundry_rooms SET name = ?, location = ?, opens_at = ?, closes_at = ?, slot_minutes = ?, is_active = ? WHERE id = ?',
      [r.name, r.location, r.opensAt, r.closesAt, r.slotMinutes, r.isActive, room.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A laundry room with this name already exists.' });
    throw err;
  }
  res.json({ id: room.id });
});

// fk_machines_room is ON DELETE RESTRICT: a room with machines can't be deleted.
router.delete('/:id', requireRole('admin'), async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM laundry_rooms WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Laundry room not found.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This room has machines, so it cannot be deleted. Close it instead (untick "Open for bookings").' });
    }
    throw err;
  }
});

module.exports = router;
