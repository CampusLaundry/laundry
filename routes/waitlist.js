// Waiting list: a student waits for a washer or dryer in a room on a day and is
// notified when a booking there is cancelled or not used.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin } = require('../lib/middleware');
const { fail, date, oneOf, roomId } = require('../lib/validate');
const { BOOK_DAYS_AHEAD, localDate } = require('../lib/laundry');

const router = express.Router();
router.use(requireLogin);

router.get('/', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT w.id, w.room_id, r.name AS room, w.wait_date, w.kind, w.created_at, w.notified_at,
           (SELECT COUNT(*) FROM waitlist_entries x
            WHERE x.room_id = w.room_id AND x.wait_date = w.wait_date AND x.kind = w.kind
              AND x.notified_at IS NULL AND (x.created_at < w.created_at OR (x.created_at = w.created_at AND x.id < w.id))) AS ahead
    FROM waitlist_entries w JOIN laundry_rooms r ON r.id = w.room_id
    WHERE w.user_id = ? AND w.wait_date >= CURDATE()
    ORDER BY w.wait_date, r.name`, [req.session.user.id]);
  res.json(rows);
});

// Body: { roomId, date, kind }
router.post('/', async (req, res) => {
  const room = await roomId(req.body.roomId);
  const day = date(req.body.date, 'date');
  const kind = oneOf(req.body.kind, ['washer', 'dryer'], 'machine type');
  if (day < localDate() || day > localDate(BOOK_DAYS_AHEAD)) fail(400, `You can wait for a machine from today up to ${BOOK_DAYS_AHEAD} days ahead.`);
  try {
    const [r] = await pool.query('INSERT INTO waitlist_entries (user_id, room_id, wait_date, kind) VALUES (?, ?, ?, ?)',
      [req.session.user.id, room, day, kind]);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `You are already on the waiting list for a ${kind} that day.` });
    throw err;
  }
});

router.delete('/:id', async (req, res) => {
  const [r] = await pool.query('DELETE FROM waitlist_entries WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: 'Waiting-list entry not found.' });
  res.status(204).end();
});

module.exports = router;
