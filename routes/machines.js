// Washers and dryers. Administrators add, edit, retire or remove them and mark them
// out of order (which cancels their upcoming bookings and tells the students).
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../lib/middleware');
const { fail, text, int, oneOf, roomId, inTransaction } = require('../lib/validate');
const { notify, describe, whenText } = require('../lib/laundry');

const router = express.Router();
router.use(requireLogin);
const adminOnly = requireRole('admin');

async function readMachine(body) {
  const m = {
    roomId: await roomId(body.roomId),
    code: text(body.code, 'The machine code', 1, 20).toUpperCase(),
    kind: oneOf(body.kind, ['washer', 'dryer'], 'machine type'),
    cycleMinutes: int(body.cycleMinutes, 'The cycle length', 10, 240),
  };
  const [[room]] = await pool.query('SELECT slot_minutes FROM laundry_rooms WHERE id = ?', [m.roomId]);
  if (m.cycleMinutes > room.slot_minutes) fail(400, `The cycle must fit in one ${room.slot_minutes}-minute slot of this room.`);
  return m;
}

async function findMachine(req, conn = pool) {
  const [[m]] = await conn.query('SELECT * FROM machines WHERE id = ?', [req.params.id]);
  if (!m) fail(404, 'Machine not found.');
  return m;
}

// ?roomId= ; ?all=1 includes retired machines (admin).
router.get('/', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.roomId) where.push('m.room_id = ?'), params.push(req.query.roomId);
  if (req.query.all !== '1') where.push('m.is_active');
  const [rows] = await pool.query(`
    SELECT m.id, m.room_id, r.name AS room, m.code, m.kind, m.cycle_minutes, m.is_active, m.created_at,
           o.id AS outage_id, o.reason AS outage_reason, o.started_at AS outage_since,
           (SELECT COUNT(*) FROM bookings b WHERE b.machine_id = m.id) AS bookings,
           (SELECT COUNT(*) FROM bookings b WHERE b.machine_id = m.id AND b.status = 'booked') AS upcoming,
           (SELECT ROUND(AVG(f.rating), 1) FROM feedback f WHERE f.machine_id = m.id AND f.rating IS NOT NULL) AS avg_rating
    FROM machines m
    JOIN laundry_rooms r ON r.id = m.room_id
    LEFT JOIN machine_outages o ON o.machine_id = m.id AND o.ended_at IS NULL
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY r.name, m.kind = 'dryer', m.code`, params);
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active, out_of_order: !!r.outage_id })));
});

router.post('/', adminOnly, async (req, res) => {
  const m = await readMachine(req.body);
  try {
    const [r] = await pool.query('INSERT INTO machines (room_id, code, kind, cycle_minutes) VALUES (?, ?, ?, ?)',
      [m.roomId, m.code, m.kind, m.cycleMinutes]);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `This room already has a machine called ${m.code}.` });
    throw err;
  }
});

router.put('/:id', adminOnly, async (req, res) => {
  const existing = await findMachine(req);
  const m = await readMachine(req.body);
  if (m.roomId !== existing.room_id) {
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM bookings WHERE machine_id = ? AND status IN ('booked', 'in_progress')", [existing.id]);
    if (n) fail(409, 'This machine has upcoming bookings, so it cannot move to another room now.');
  }
  try {
    await pool.query('UPDATE machines SET room_id = ?, code = ?, kind = ?, cycle_minutes = ? WHERE id = ?',
      [m.roomId, m.code, m.kind, m.cycleMinutes, existing.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `This room already has a machine called ${m.code}.` });
    throw err;
  }
  res.json({ id: existing.id });
});

// Cancels a machine's upcoming bookings and tells each student. Returns how many.
async function cancelUpcoming(conn, machineId, reason) {
  const [rows] = await conn.query(`
    SELECT b.id, b.user_id, b.booking_date, b.slot_start, m.code, m.kind, r.name AS room
    FROM bookings b JOIN machines m ON m.id = b.machine_id JOIN laundry_rooms r ON r.id = m.room_id
    WHERE b.machine_id = ? AND b.status = 'booked' FOR UPDATE`, [machineId]);
  for (const b of rows) {
    await conn.query("UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE id = ?", [b.id]);
    await notify(conn, b.user_id, 'booking_cancelled',
      `Your booking for ${describe(b)} ${whenText(b)} was cancelled: ${reason} Please book another machine.`, b.id);
  }
  return rows.length;
}

// Retire (isActive false) or bring back a machine. Retiring cancels its upcoming bookings.
router.patch('/:id', adminOnly, async (req, res) => {
  const isActive = !!req.body.isActive;
  const cancelled = await inTransaction(async (conn) => {
    const m = await findMachine(req, conn);
    await conn.query('UPDATE machines SET is_active = ? WHERE id = ?', [isActive, m.id]);
    return isActive ? 0 : cancelUpcoming(conn, m.id, 'the machine has been removed from service.');
  });
  res.json({ id: Number(req.params.id), is_active: isActive, cancelled });
});

// fk_bookings_machine is ON DELETE RESTRICT: a machine with booking history can only be retired.
router.delete('/:id', adminOnly, async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM machines WHERE id = ?', [req.params.id]);
    if (r.affectedRows === 0) return res.status(404).json({ error: 'Machine not found.' });
    res.status(204).end();
  } catch (err) {
    if (err.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(409).json({ error: 'This machine has booking history, so it cannot be deleted. Retire it instead.' });
    }
    throw err;
  }
});

// Out of order. Body: { reason }. Cancels upcoming bookings on this machine.
router.post('/:id/outage', adminOnly, async (req, res) => {
  const reason = text(req.body.reason, 'The reason', 5, 255);
  const cancelled = await inTransaction(async (conn) => {
    const m = await findMachine(req, conn);
    try {
      await conn.query('INSERT INTO machine_outages (machine_id, reason, reported_by) VALUES (?, ?, ?)', [m.id, reason, req.session.user.id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') fail(409, 'This machine is already marked out of order.');
      throw err;
    }
    return cancelUpcoming(conn, m.id, `the machine is out of order (${reason.replace(/\.$/, '')}).`);
  });
  res.status(201).json({ cancelled });
});

// Back in service: ends the open outage.
router.post('/:id/repair', adminOnly, async (req, res) => {
  const m = await findMachine(req);
  const [r] = await pool.query(
    'UPDATE machine_outages SET ended_at = GREATEST(NOW(), started_at + INTERVAL 1 SECOND) WHERE machine_id = ? AND ended_at IS NULL', [m.id]);
  if (r.affectedRows === 0) return res.status(409).json({ error: 'This machine is not out of order.' });
  res.json({ id: m.id });
});

// Outage history of a machine.
router.get('/:id/outages', adminOnly, async (req, res) => {
  const m = await findMachine(req);
  const [rows] = await pool.query(`
    SELECT o.id, o.reason, o.started_at, o.ended_at, u.full_name AS reported_by_name
    FROM machine_outages o LEFT JOIN users u ON u.id = o.reported_by
    WHERE o.machine_id = ? ORDER BY o.started_at DESC`, [m.id]);
  res.json(rows);
});

module.exports = router;
