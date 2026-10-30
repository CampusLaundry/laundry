// Proves the database itself enforces integrity. It creates a small set of its own rows,
// then tries statements that break a rule and checks MySQL rejects each one. Everything
// runs inside one transaction that is rolled back, so no data is left behind.
// Usage: node tools/test-constraints.js
const pool = require('../db/pool');

async function createFixtures(conn) {
  const tag = Date.now().toString(36).slice(-6);
  const num = String(Date.now()).slice(-9);
  const ins = async (sql, params) => (await conn.query(sql, params))[0].insertId;
  const f = { tag, num };
  f.room = await ins("INSERT INTO laundry_rooms (name, opens_at, closes_at, slot_minutes) VALUES (?, '06:00', '22:00', 60)", [`Constraint Room ${tag}`]);
  f.email = `student.${tag}@constraint.test`;
  f.student = await ins("INSERT INTO users (full_name, email, student_number, password_hash, room_id) VALUES ('Test Student', ?, ?, 'x', ?)", [f.email, num, f.room]);
  f.admin = await ins("INSERT INTO users (full_name, email, password_hash, role) VALUES ('Test Admin', ?, 'x', 'admin')", [`admin.${tag}@constraint.test`]);
  f.washer = await ins("INSERT INTO machines (room_id, code, kind, cycle_minutes) VALUES (?, 'W1', 'washer', 45)", [f.room]);
  f.dryer = await ins("INSERT INTO machines (room_id, code, kind, cycle_minutes) VALUES (?, 'D1', 'dryer', 60)", [f.room]);
  f.spare = await ins("INSERT INTO machines (room_id, code, kind, cycle_minutes) VALUES (?, 'W9', 'washer', 45)", [f.room]);
  f.booking = await ins(`INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end)
    VALUES (?, ?, CURDATE() + INTERVAL 1 DAY, '10:00', '11:00')`, [f.student, f.washer]);
  f.cancelled = await ins(`INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end, status, cancelled_at)
    VALUES (?, ?, CURDATE() + INTERVAL 1 DAY, '12:00', '13:00', 'cancelled', NOW())`, [f.student, f.washer]);
  f.outage = await ins("INSERT INTO machine_outages (machine_id, reason, reported_by) VALUES (?, 'Door seal leaking', ?)", [f.dryer, f.admin]);
  await conn.query('INSERT INTO waitlist_entries (user_id, room_id, wait_date, kind) VALUES (?, ?, CURDATE() + INTERVAL 1 DAY, \'dryer\')', [f.student, f.room]);
  f.notification = await ins("INSERT INTO notifications (user_id, booking_id, kind, message) VALUES (?, ?, 'reminder', 'Your booking starts soon')", [f.student, f.booking]);
  f.tip = await ins("INSERT INTO laundry_tips (category, title, body) VALUES ('sorting', ?, 'A long enough tip body for the test.')", [`Constraint tip ${tag}`]);
  f.feedback = await ins("INSERT INTO feedback (user_id, room_id, machine_id, kind, comment) VALUES (?, ?, ?, 'issue', 'Machine is leaking')", [f.student, f.room, f.washer]);
  f.rating = await ins("INSERT INTO feedback (user_id, room_id, kind, rating) VALUES (?, ?, 'rating', 4)", [f.student, f.room]);
  return f;
}

// [description, SQL, expected MySQL error code, or 'OK' when the statement must succeed]
const cases = (f) => [
  ['UQ: duplicate email (uq_users_email)', `INSERT INTO users (full_name, email, student_number, password_hash) VALUES ('Dup', '${f.email}', '111111111', 'x')`, 'ER_DUP_ENTRY'],
  ['UQ: duplicate student number (uq_users_student_number)', `INSERT INTO users (full_name, email, student_number, password_hash) VALUES ('Dup', 'dup.${f.tag}@constraint.test', '${f.num}', 'x')`, 'ER_DUP_ENTRY'],
  ['UQ: duplicate laundry room name (uq_laundry_rooms_name)', `INSERT INTO laundry_rooms (name) VALUES ('Constraint Room ${f.tag}')`, 'ER_DUP_ENTRY'],
  ['UQ: two machines with the same code in a room (uq_machines_room_code)', `INSERT INTO machines (room_id, code, kind, cycle_minutes) VALUES (${f.room}, 'W1', 'dryer', 60)`, 'ER_DUP_ENTRY'],
  ['UQ: double booking of a machine slot (uq_bookings_machine_slot)', `INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end) VALUES (${f.admin}, ${f.washer}, CURDATE() + INTERVAL 1 DAY, '10:00', '11:00')`, 'ER_DUP_ENTRY'],
  ['UQ: one student, two machines at the same time (uq_bookings_user_slot)', `INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end) VALUES (${f.student}, ${f.spare}, CURDATE() + INTERVAL 1 DAY, '10:00', '11:00')`, 'ER_DUP_ENTRY'],
  ['UQ: a cancelled booking frees its slot for someone else (slot_lock is NULL)', `INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end) VALUES (${f.admin}, ${f.washer}, CURDATE() + INTERVAL 1 DAY, '12:00', '13:00')`, 'OK'],
  ['UQ: a machine can only have one open outage (uq_machine_outages_machine_open)', `INSERT INTO machine_outages (machine_id, reason) VALUES (${f.dryer}, 'Another fault here')`, 'ER_DUP_ENTRY'],
  ['UQ: joining the same waiting list twice (uq_waitlist_entries_user_room_date_kind)', `INSERT INTO waitlist_entries (user_id, room_id, wait_date, kind) VALUES (${f.student}, ${f.room}, CURDATE() + INTERVAL 1 DAY, 'dryer')`, 'ER_DUP_ENTRY'],
  ['UQ: the same reminder twice for a booking (uq_notifications_booking_kind)', `INSERT INTO notifications (user_id, booking_id, kind, message) VALUES (${f.student}, ${f.booking}, 'reminder', 'Reminder again')`, 'ER_DUP_ENTRY'],
  ['UQ: two tips with the same title (uq_laundry_tips_title)', `INSERT INTO laundry_tips (category, title, body) VALUES ('fabrics', 'Constraint tip ${f.tag}', 'Another long enough tip body.')`, 'ER_DUP_ENTRY'],
  ['FK: booking a machine that does not exist (fk_bookings_machine)', `INSERT INTO bookings (user_id, machine_id, booking_date, slot_start, slot_end) VALUES (${f.student}, 99999999, CURDATE(), '08:00', '09:00')`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK: feedback about a machine that does not exist (fk_feedback_machine)', `UPDATE feedback SET machine_id = 99999999 WHERE id = ${f.feedback}`, 'ER_NO_REFERENCED_ROW_2'],
  ['FK RESTRICT: delete a laundry room that has machines (fk_machines_room)', `DELETE FROM laundry_rooms WHERE id = ${f.room}`, 'ER_ROW_IS_REFERENCED_2'],
  ['FK RESTRICT: delete a machine that has bookings (fk_bookings_machine)', `DELETE FROM machines WHERE id = ${f.washer}`, 'ER_ROW_IS_REFERENCED_2'],
  ['CHECK: room closes before it opens (chk_laundry_rooms_hours)', `UPDATE laundry_rooms SET closes_at = '05:00' WHERE id = ${f.room}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: 10-minute slots (chk_laundry_rooms_slot)', `UPDATE laundry_rooms SET slot_minutes = 10 WHERE id = ${f.room}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: a 5-minute machine cycle (chk_machines_cycle)', `UPDATE machines SET cycle_minutes = 5 WHERE id = ${f.washer}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: a student without a student number (chk_users_student_has_number)', `UPDATE users SET student_number = NULL WHERE id = ${f.student}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: a student number with letters (chk_users_student_number)', `UPDATE users SET student_number = 'ABC12345' WHERE id = ${f.student}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: invalid email (chk_users_email)', `UPDATE users SET email = 'not-an-email' WHERE id = ${f.student}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: phone number with letters (chk_users_phone)', `UPDATE users SET phone = 'call me' WHERE id = ${f.student}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: booking that ends before it starts (chk_bookings_times)', `UPDATE bookings SET slot_end = '09:00' WHERE id = ${f.booking}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: cycle running without a start time (chk_bookings_started)', `UPDATE bookings SET status = 'in_progress' WHERE id = ${f.booking}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: start time without a finish time (chk_bookings_finishes)', `UPDATE bookings SET status = 'in_progress', started_at = NOW() WHERE id = ${f.booking}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: finish time before the start (chk_bookings_finishes)', `UPDATE bookings SET status = 'in_progress', started_at = NOW(), finishes_at = NOW() - INTERVAL 1 MINUTE WHERE id = ${f.booking}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: collected without a collection time (chk_bookings_collected)', `UPDATE bookings SET status = 'collected', started_at = NOW() - INTERVAL 1 HOUR, finishes_at = NOW() WHERE id = ${f.booking}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: cancelled without a cancellation time (chk_bookings_cancelled)', `UPDATE bookings SET status = 'cancelled' WHERE id = ${f.booking}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: outage that ends before it starts (chk_machine_outages_period)', `UPDATE machine_outages SET ended_at = started_at - INTERVAL 1 HOUR WHERE id = ${f.outage}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: outage reason too short (chk_machine_outages_reason)', `UPDATE machine_outages SET reason = 'bad' WHERE id = ${f.outage}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: rating of 6 stars (chk_feedback_rating)', `UPDATE feedback SET rating = 6 WHERE id = ${f.rating}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: rating feedback without a rating (chk_feedback_rating_kind)', `INSERT INTO feedback (user_id, kind, comment) VALUES (${f.student}, 'rating', 'No stars given')`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: issue report without a description (chk_feedback_comment)', `INSERT INTO feedback (user_id, room_id, kind) VALUES (${f.student}, ${f.room}, 'issue')`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: admin response without a response time (chk_feedback_response)', `UPDATE feedback SET admin_response = 'Fixed it' WHERE id = ${f.feedback}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: blank notification (chk_notifications_message)', `UPDATE notifications SET message = '   ' WHERE id = ${f.notification}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['CHECK: tip text too short (chk_laundry_tips_body)', `UPDATE laundry_tips SET body = 'Too short' WHERE id = ${f.tip}`, 'ER_CHECK_CONSTRAINT_VIOLATED'],
  ['ENUM: unknown booking status', `UPDATE bookings SET status = 'lost' WHERE id = ${f.booking}`, 'WARN_DATA_TRUNCATED'],
  ['ENUM: unknown machine type', `UPDATE machines SET kind = 'ironer' WHERE id = ${f.washer}`, 'WARN_DATA_TRUNCATED'],
  ['ENUM: unknown role', `UPDATE users SET role = 'warden' WHERE id = ${f.student}`, 'WARN_DATA_TRUNCATED'],
  ['NOT NULL: booking without a date', `INSERT INTO bookings (user_id, machine_id, slot_start, slot_end) VALUES (${f.student}, ${f.spare}, '08:00', '09:00')`, 'ER_NO_DEFAULT_FOR_FIELD'],
];

async function main() {
  const conn = await pool.getConnection();
  let passed = 0;
  let total = 0;
  const record = (ok, text) => { total++; if (ok) passed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${text}`); };
  try {
    await conn.beginTransaction();
    const f = await createFixtures(conn);

    for (const [name, sql, expected] of cases(f)) {
      await conn.query('SAVEPOINT test_case');
      let got = 'OK';
      try { await conn.query(sql); } catch (err) { got = err.code; }
      await conn.query('ROLLBACK TO SAVEPOINT test_case');
      record(got === expected, `${name}  ->  ${got === 'OK' ? 'ACCEPTED' : got}`);
    }

    // Deleting a student keeps their booking history and feedback; personal data goes.
    await conn.query('SAVEPOINT test_case');
    await conn.query('DELETE FROM users WHERE id = ?', [f.student]);
    const [[kept]] = await conn.query(`
      SELECT (SELECT COUNT(*) FROM bookings WHERE id IN (?, ?) AND user_id IS NULL) AS bookings_kept,
             (SELECT COUNT(*) FROM feedback WHERE id IN (?, ?) AND user_id IS NULL) AS feedback_kept,
             (SELECT COUNT(*) FROM notifications WHERE user_id = ?) + (SELECT COUNT(*) FROM waitlist_entries WHERE user_id = ?) AS personal_left`,
    [f.booking, f.cancelled, f.feedback, f.rating, f.student, f.student]);
    await conn.query('ROLLBACK TO SAVEPOINT test_case');
    record(kept.bookings_kept === 2 && kept.feedback_kept === 2,
      `FK SET NULL: deleting a student keeps their booking history and feedback  ->  ${kept.bookings_kept === 2 ? 'KEPT' : 'LOST'}`);
    record(kept.personal_left === 0,
      `FK CASCADE: deleting a student deletes their notifications and waiting-list places  ->  ${kept.personal_left === 0 ? 'CASCADED' : 'ROWS_LEFT'}`);

    // Deleting a machine without bookings deletes its outage history; a booking's notifications go with it.
    await conn.query('DELETE FROM machines WHERE id = ?', [f.dryer]);
    await conn.query('DELETE FROM bookings WHERE id = ?', [f.booking]);
    const [[left]] = await conn.query(`
      SELECT (SELECT COUNT(*) FROM machine_outages WHERE machine_id = ?) + (SELECT COUNT(*) FROM notifications WHERE booking_id = ?) AS n`,
    [f.dryer, f.booking]);
    record(left.n === 0, `FK CASCADE: deleting a machine or booking deletes its outages and notifications  ->  ${left.n === 0 ? 'CASCADED' : 'ROWS_LEFT'}`);
  } finally {
    await conn.rollback(); // removes every row this test created
    conn.release();
    await pool.end();
  }
  console.log(`\n${passed}/${total} integrity rules enforced by MySQL (all test rows rolled back).`);
  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => { console.error(err.message); process.exit(1); });
