// In-app notifications for the logged-in user.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../lib/middleware');
const { freshBookings } = require('../lib/laundry');

const router = express.Router();
router.use(requireLogin);

// Newest first, with the number still unread.
router.get('/', freshBookings, async (req, res) => {
  const id = req.session.user.id;
  const [rows] = await pool.query(`
    SELECT id, booking_id, kind, message, created_at, read_at FROM notifications
    WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`, [id]);
  const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL', [id]);
  res.json({ notifications: rows, unread });
});

// Unread count only (polled by the header bell).
router.get('/unread', freshBookings, async (req, res) => {
  const [[{ unread }]] = await pool.query('SELECT COUNT(*) AS unread FROM notifications WHERE user_id = ? AND read_at IS NULL', [req.session.user.id]);
  res.json({ unread });
});

router.post('/read-all', async (req, res) => {
  const [r] = await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.session.user.id]);
  res.json({ marked: r.affectedRows });
});

router.post('/:id/read', async (req, res) => {
  const [r] = await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = ? AND user_id = ?',
    [req.params.id, req.session.user.id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ id: Number(req.params.id) });
});

router.delete('/:id', async (req, res) => {
  const [r] = await pool.query('DELETE FROM notifications WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: 'Notification not found.' });
  res.status(204).end();
});

module.exports = router;
