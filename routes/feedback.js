// Feedback: students rate the service or a machine, comment, or report an issue;
// the administrator responds and closes it (the student is notified).
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../lib/middleware');
const { fail, text, optionalText, int, oneOf } = require('../lib/validate');
const { notify } = require('../lib/laundry');

const router = express.Router();
router.use(requireLogin);
const adminOnly = requireRole('admin');

const KINDS = ['rating', 'comment', 'issue'];
const STATUSES = ['new', 'in_progress', 'resolved', 'dismissed'];

const FEEDBACK_SELECT = `
  SELECT f.id, f.user_id, f.room_id, f.machine_id, f.kind, f.rating, f.comment, f.status, f.admin_response, f.responded_at, f.created_at,
         u.full_name AS student, u.student_number, r.name AS room, m.code AS machine_code, m.kind AS machine_kind,
         EXISTS (SELECT 1 FROM machine_outages o WHERE o.machine_id = f.machine_id AND o.ended_at IS NULL) AS machine_out_of_order,
         ru.full_name AS responded_by_name
  FROM feedback f
  LEFT JOIN users u ON u.id = f.user_id
  LEFT JOIN laundry_rooms r ON r.id = f.room_id
  LEFT JOIN machines m ON m.id = f.machine_id
  LEFT JOIN users ru ON ru.id = f.responded_by`;

// Students: their own feedback. Admin: everything, ?status= ?kind= ?roomId=
router.get('/', async (req, res) => {
  const user = req.session.user;
  const where = [];
  const params = [];
  if (user.role !== 'admin' || req.query.mine === '1') where.push('f.user_id = ?'), params.push(user.id);
  if (STATUSES.includes(req.query.status)) where.push('f.status = ?'), params.push(req.query.status);
  if (req.query.status === 'open') where.push("f.status IN ('new', 'in_progress')");
  if (KINDS.includes(req.query.kind)) where.push('f.kind = ?'), params.push(req.query.kind);
  if (req.query.roomId) where.push('f.room_id = ?'), params.push(req.query.roomId);
  const [rows] = await pool.query(`${FEEDBACK_SELECT}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY f.status IN ('resolved', 'dismissed'), f.kind <> 'issue', f.created_at DESC
    LIMIT 300`, params);
  res.json(rows.map((f) => ({ ...f, machine_out_of_order: !!f.machine_out_of_order })));
});

// Body: { kind, rating?, comment?, roomId?, machineId? }
router.post('/', async (req, res) => {
  const kind = oneOf(req.body.kind, KINDS, 'type of feedback');
  const rating = kind === 'rating' ? int(req.body.rating, 'The rating', 1, 5) : null;
  const comment = kind === 'rating'
    ? optionalText(req.body.comment, 'The comment', 2000)
    : text(req.body.comment, kind === 'issue' ? 'The description of the issue' : 'The comment', 5, 2000);
  let roomId = req.body.roomId ? Number(req.body.roomId) : null;
  let machineId = req.body.machineId ? Number(req.body.machineId) : null;
  if (machineId) {
    const [[m]] = await pool.query('SELECT id, room_id FROM machines WHERE id = ?', [machineId]);
    if (!m) fail(400, 'Choose a valid machine.');
    roomId = m.room_id; // a machine always belongs to its room
  } else if (roomId) {
    const [[r]] = await pool.query('SELECT id FROM laundry_rooms WHERE id = ?', [roomId]);
    if (!r) fail(400, 'Choose a valid laundry room.');
  }
  if (kind === 'issue' && !roomId) fail(400, 'Say which laundry room (and machine, if you know it) the issue is in.');
  const [r] = await pool.query('INSERT INTO feedback (user_id, room_id, machine_id, kind, rating, comment) VALUES (?, ?, ?, ?, ?, ?)',
    [req.session.user.id, roomId, machineId, kind, rating, comment]);
  res.status(201).json({ id: r.insertId });
});

// Admin: change status and/or respond. Body: { status?, response? }
router.patch('/:id', adminOnly, async (req, res) => {
  const [[f]] = await pool.query('SELECT * FROM feedback WHERE id = ?', [req.params.id]);
  if (!f) fail(404, 'Feedback not found.');
  const status = req.body.status ? oneOf(req.body.status, STATUSES, 'status') : f.status;
  const response = req.body.response !== undefined ? optionalText(req.body.response, 'The response', 2000) : f.admin_response;
  if (status === 'dismissed' && !response) fail(400, 'Explain to the student why the feedback is dismissed.');
  const newResponse = !!response && response !== f.admin_response;
  // responded_at is set exactly when there is a response (chk_feedback_response).
  const respondedBy = newResponse ? req.session.user.id : f.responded_by;
  const respondedAt = !response ? null : newResponse ? new Date() : f.responded_at;
  await pool.query('UPDATE feedback SET status = ?, admin_response = ?, responded_by = ?, responded_at = ? WHERE id = ?',
    [status, response, respondedBy, respondedAt, f.id]);
  if (newResponse || (status !== f.status && ['resolved', 'dismissed'].includes(status))) {
    const label = { new: 'received', in_progress: 'being looked at', resolved: 'resolved', dismissed: 'closed' }[status];
    await notify(pool, f.user_id, 'feedback_reply', `Your ${f.kind === 'issue' ? 'issue report' : 'feedback'} is ${label}.${response ? ` Reply: ${response}` : ''}`);
  }
  res.json({ id: f.id, status });
});

router.delete('/:id', adminOnly, async (req, res) => {
  const [r] = await pool.query('DELETE FROM feedback WHERE id = ?', [req.params.id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: 'Feedback not found.' });
  res.status(204).end();
});

module.exports = router;
