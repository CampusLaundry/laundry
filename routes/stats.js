// Usage reports for the administrator dashboard.
const express = require('express');
const pool = require('../db/pool');
const { requireRole } = require('../lib/middleware');
const { freshBookings } = require('../lib/laundry');

const router = express.Router();

// ?days= period for the usage figures (default 30).
router.get('/', requireRole('admin'), freshBookings, async (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const [[today]] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM bookings WHERE booking_date = CURDATE() AND status NOT IN ('cancelled')) AS bookings_today,
      (SELECT COUNT(*) FROM bookings WHERE status = 'in_progress') AS running_now,
      (SELECT COUNT(*) FROM bookings WHERE status = 'done') AS waiting_collection,
      (SELECT COUNT(*) FROM machines WHERE is_active) AS machines,
      (SELECT COUNT(*) FROM machine_outages WHERE ended_at IS NULL) AS out_of_order,
      (SELECT COUNT(*) FROM feedback WHERE status IN ('new', 'in_progress')) AS open_feedback,
      (SELECT COUNT(*) FROM feedback WHERE status IN ('new', 'in_progress') AND kind = 'issue') AS open_issues,
      (SELECT COUNT(*) FROM waitlist_entries WHERE wait_date >= CURDATE() AND notified_at IS NULL) AS waiting_students,
      (SELECT COUNT(*) FROM users WHERE role = 'student' AND is_active) AS students`);
  const [[period]] = await pool.query(`
    SELECT COUNT(*) AS bookings,
           SUM(status IN ('in_progress', 'done', 'collected')) AS washes,
           SUM(status = 'cancelled') AS cancelled,
           SUM(status = 'no_show') AS no_shows,
           ROUND(100 * SUM(status = 'no_show') / NULLIF(SUM(status <> 'cancelled' AND TIMESTAMP(booking_date, slot_start) < NOW()), 0)) AS no_show_rate,
           (SELECT ROUND(AVG(rating), 1) FROM feedback WHERE rating IS NOT NULL AND created_at >= CURDATE() - INTERVAL ? DAY) AS avg_rating
    FROM bookings WHERE booking_date BETWEEN CURDATE() - INTERVAL ? DAY AND CURDATE()`, [days, days]);
  const [perDay] = await pool.query(`
    SELECT DATE_FORMAT(booking_date, '%Y-%m-%d') AS day,
           SUM(status <> 'cancelled') AS booked, SUM(status IN ('in_progress', 'done', 'collected')) AS washed, SUM(status = 'no_show') AS no_shows
    FROM bookings WHERE booking_date BETWEEN CURDATE() - INTERVAL 13 DAY AND CURDATE() + INTERVAL 7 DAY
    GROUP BY booking_date ORDER BY booking_date`);
  const [busiestHours] = await pool.query(`
    SELECT HOUR(slot_start) AS hour, COUNT(*) AS bookings
    FROM bookings WHERE status <> 'cancelled' AND booking_date >= CURDATE() - INTERVAL ? DAY
    GROUP BY HOUR(slot_start) ORDER BY hour`, [days]);
  const [machines] = await pool.query(`
    SELECT m.id, m.code, m.kind, r.name AS room,
           SUM(b.status IN ('in_progress', 'done', 'collected')) AS washes,
           SUM(b.status = 'no_show') AS no_shows,
           (SELECT ROUND(AVG(f.rating), 1) FROM feedback f WHERE f.machine_id = m.id AND f.rating IS NOT NULL) AS avg_rating,
           EXISTS (SELECT 1 FROM machine_outages o WHERE o.machine_id = m.id AND o.ended_at IS NULL) AS out_of_order
    FROM machines m JOIN laundry_rooms r ON r.id = m.room_id
    LEFT JOIN bookings b ON b.machine_id = m.id AND b.booking_date >= CURDATE() - INTERVAL ? DAY
    WHERE m.is_active
    GROUP BY m.id, m.code, m.kind, r.name
    ORDER BY washes DESC, r.name, m.code`, [days]);
  const [rooms] = await pool.query(`
    SELECT r.id, r.name,
           (SELECT COUNT(*) FROM bookings b JOIN machines m ON m.id = b.machine_id
            WHERE m.room_id = r.id AND b.status <> 'cancelled' AND b.booking_date >= CURDATE() - INTERVAL ? DAY) AS bookings,
           (SELECT ROUND(AVG(f.rating), 1) FROM feedback f WHERE f.room_id = r.id AND f.rating IS NOT NULL) AS avg_rating,
           (SELECT COUNT(*) FROM feedback f WHERE f.room_id = r.id AND f.kind = 'issue' AND f.status IN ('new', 'in_progress')) AS open_issues
    FROM laundry_rooms r ORDER BY bookings DESC, r.name`, [days]);
  const [recentIssues] = await pool.query(`
    SELECT f.id, f.comment, f.status, f.created_at, r.name AS room, m.code AS machine_code
    FROM feedback f LEFT JOIN laundry_rooms r ON r.id = f.room_id LEFT JOIN machines m ON m.id = f.machine_id
    WHERE f.kind = 'issue' AND f.status IN ('new', 'in_progress') ORDER BY f.created_at LIMIT 5`);
  res.json({
    days, today, period, perDay, busiestHours, rooms, recentIssues,
    machines: machines.map((m) => ({ ...m, out_of_order: !!m.out_of_order })),
  });
});

module.exports = router;
