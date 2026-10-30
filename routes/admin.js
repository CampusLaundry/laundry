// Administration: user accounts and the full booking history.
const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireRole } = require('../lib/middleware');
const { ROLES, makeTempPassword } = require('../lib/accounts');
const { freshBookings } = require('../lib/laundry');

const router = express.Router();
router.use(requireRole('admin'));

async function findUser(req, res) {
  const [[user]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!user) res.status(404).json({ error: 'User not found.' });
  return user;
}

// ?search= (name, email or student number), ?role=
router.get('/users', async (req, res) => {
  const where = [];
  const params = [];
  if (req.query.search) {
    where.push('(u.full_name LIKE ? OR u.email LIKE ? OR u.student_number LIKE ?)');
    const like = `%${String(req.query.search).slice(0, 100)}%`;
    params.push(like, like, like);
  }
  if (ROLES.includes(req.query.role)) where.push('u.role = ?'), params.push(req.query.role);
  const [rows] = await pool.query(`
    SELECT u.id, u.full_name, u.email, u.student_number, u.phone, u.role, u.is_active, u.must_change_password, u.created_at,
           u.room_id, r.name AS room,
           (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status IN ('in_progress', 'done', 'collected')) AS washes,
           (SELECT COUNT(*) FROM bookings b WHERE b.user_id = u.id AND b.status = 'no_show') AS no_shows
    FROM users u LEFT JOIN laundry_rooms r ON r.id = u.room_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY u.role = 'student', u.full_name
    LIMIT 500`, params);
  res.json(rows.map((r) => ({ ...r, is_active: !!r.is_active, must_change_password: !!r.must_change_password })));
});

// Change role and/or active state. Body: { role?, isActive? }
router.patch('/users/:id', async (req, res) => {
  const user = await findUser(req, res);
  if (!user) return;
  if (user.id === req.session.user.id) {
    return res.status(400).json({ error: 'You cannot change your own role or deactivate yourself.' });
  }
  const role = req.body.role ?? user.role;
  const isActive = req.body.isActive ?? !!user.is_active;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Unknown role.' });
  if (role === 'student' && !user.student_number) {
    return res.status(400).json({ error: 'This account has no student number, so it cannot be a student account.' });
  }
  await pool.query('UPDATE users SET role = ?, is_active = ? WHERE id = ?', [role, !!isActive, user.id]);
  // A deactivated student's future slots are released for others.
  if (!isActive) {
    await pool.query("UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE user_id = ? AND status = 'booked'", [user.id]);
  }
  res.json({ id: user.id, role, is_active: !!isActive });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const user = await findUser(req, res);
  if (!user) return;
  const tempPassword = makeTempPassword();
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?',
    [await bcrypt.hash(tempPassword, 10), user.id]);
  res.json({ tempPassword });
});

// Deleting a user keeps their booking history and feedback (the person becomes NULL);
// their future bookings are cancelled first so the slots become free.
router.delete('/users/:id', async (req, res) => {
  const user = await findUser(req, res);
  if (!user) return;
  if (user.id === req.session.user.id) return res.status(400).json({ error: 'You cannot delete your own account here.' });
  await pool.query("UPDATE bookings SET status = 'cancelled', cancelled_at = NOW() WHERE user_id = ? AND status = 'booked'", [user.id]);
  await pool.query('DELETE FROM users WHERE id = ?', [user.id]);
  res.status(204).end();
});

// Booking history. Filters: from, to (dates), roomId, machineId, status, search (student). page.
router.get('/bookings', freshBookings, async (req, res) => {
  const q = req.query;
  const where = [];
  const params = [];
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.from || '')) where.push('b.booking_date >= ?'), params.push(q.from);
  if (/^\d{4}-\d{2}-\d{2}$/.test(q.to || '')) where.push('b.booking_date <= ?'), params.push(q.to);
  if (q.roomId) where.push('m.room_id = ?'), params.push(q.roomId);
  if (q.machineId) where.push('b.machine_id = ?'), params.push(q.machineId);
  if (q.status) where.push('b.status = ?'), params.push(String(q.status));
  if (q.search) {
    where.push('(u.full_name LIKE ? OR u.student_number LIKE ? OR u.email LIKE ?)');
    const like = `%${String(q.search).slice(0, 100)}%`;
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM bookings b JOIN machines m ON m.id = b.machine_id JOIN laundry_rooms r ON r.id = m.room_id
                LEFT JOIN users u ON u.id = b.user_id ${whereSql}`;
  const page = Math.max(1, Number(q.page) || 1);
  const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total ${from}`, params);
  const [rows] = await pool.query(`
    SELECT b.id, b.booking_date, b.slot_start, b.slot_end, b.status, b.started_at, b.finishes_at, b.collected_at, b.cancelled_at, b.created_at,
           m.code, m.kind, r.name AS room, u.full_name AS student, u.student_number
    ${from}
    ORDER BY b.booking_date DESC, b.slot_start DESC, r.name, m.code
    LIMIT 50 OFFSET ?`, [...params, (page - 1) * 50]);
  res.json({ bookings: rows, total, page, pages: Math.max(1, Math.ceil(total / 50)) });
});

module.exports = router;
