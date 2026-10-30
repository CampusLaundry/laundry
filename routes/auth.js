const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { requireSession, requireLogin } = require('../lib/middleware');
const { readNameAndEmail, toSessionUser } = require('../lib/accounts');
const { fail, roomId: readRoomId } = require('../lib/validate');

const router = express.Router();

// Starts a fresh session for the user (prevents session fixation).
function logIn(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.user = user;
      resolve();
    });
  });
}

// Optional phone number: digits, spaces, +, ( ) and - only.
function readPhone(value) {
  const phone = String(value ?? '').trim();
  if (!phone) return null;
  if (!/^[0-9+() -]{7,20}$/.test(phone)) fail(400, 'Enter a valid phone number (7–20 digits, spaces, +, - or brackets).');
  return phone;
}

// Student number: 8–10 digits.
function readStudentNumber(value) {
  const n = String(value ?? '').trim();
  if (!/^[0-9]{8,10}$/.test(n)) fail(400, 'Enter your student number (8–10 digits).');
  return n;
}

// Students register themselves. Administrators are created with npm run admin:create.
router.post('/register', async (req, res) => {
  const details = readNameAndEmail(req.body);
  if (details.error) return res.status(400).json({ error: details.error });
  const studentNumber = readStudentNumber(req.body.studentNumber);
  if (!req.body.password || req.body.password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  const roomId = await readRoomId(req.body.roomId, { optional: true });
  const phone = readPhone(req.body.phone);

  const [[existing]] = await pool.query('SELECT email, student_number FROM users WHERE email = ? OR student_number = ?', [details.email, studentNumber]);
  if (existing) {
    return res.status(409).json({ error: existing.email === details.email
      ? 'An account with this email already exists.' : 'An account with this student number already exists.' });
  }

  const hash = await bcrypt.hash(req.body.password, 10);
  const [result] = await pool.query(
    "INSERT INTO users (full_name, email, student_number, password_hash, role, room_id, phone) VALUES (?, ?, ?, ?, 'student', ?, ?)",
    [details.fullName, details.email, studentNumber, hash, roomId, phone]);
  const user = toSessionUser({ id: result.insertId, full_name: details.fullName, email: details.email, role: 'student', room_id: roomId });
  await logIn(req, user);
  res.status(201).json(user);
});

// Log in with email or student number.
router.post('/login', async (req, res) => {
  const login = String(req.body.email || '').trim().toLowerCase();
  const [[row]] = await pool.query('SELECT * FROM users WHERE email = ? OR student_number = ?', [login, login]);
  const ok = row && await bcrypt.compare(String(req.body.password || ''), row.password_hash);
  if (!ok) return res.status(401).json({ error: 'Wrong email / student number or password.' });
  if (!row.is_active) return res.status(403).json({ error: 'This account has been deactivated. Contact the laundry administrator.' });

  const user = toSessionUser(row);
  await logIn(req, user);
  res.json(user);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

// The logged-in user, with student number, phone, home room and unread notifications.
router.get('/me', requireSession, async (req, res) => {
  const [[extra]] = await pool.query(`
    SELECT u.student_number, u.phone, r.name AS room,
           (SELECT COUNT(*) FROM notifications n WHERE n.user_id = u.id AND n.read_at IS NULL) AS unread
    FROM users u LEFT JOIN laundry_rooms r ON r.id = u.room_id WHERE u.id = ?`, [req.session.user.id]);
  res.json({ ...req.session.user, studentNumber: extra.student_number, phone: extra.phone, room: extra.room, unread: extra.unread });
});

async function passwordMatches(userId, password) {
  const [[row]] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  return !!row && bcrypt.compare(String(password || ''), row.password_hash);
}

// Update own name, email, phone and home laundry room (the student number can't change).
router.put('/me', requireLogin, async (req, res) => {
  const details = readNameAndEmail(req.body);
  if (details.error) return res.status(400).json({ error: details.error });
  const roomId = await readRoomId(req.body.roomId, { optional: true });
  const phone = readPhone(req.body.phone);
  try {
    await pool.query('UPDATE users SET full_name = ?, email = ?, room_id = ?, phone = ? WHERE id = ?',
      [details.fullName, details.email, roomId, phone, req.session.user.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Another account already uses this email.' });
    throw err;
  }
  req.session.user = { ...req.session.user, ...details, roomId };
  res.json({ ...req.session.user, phone });
});

// Change password. Also how someone replaces a temporary password, so it only needs a session.
router.put('/password', requireSession, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!await passwordMatches(req.session.user.id, currentPassword)) {
    return res.status(403).json({ error: 'Your current password is wrong.' });
  }
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'Choose a password that is different from the current one.' });
  }
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE id = ?',
    [await bcrypt.hash(newPassword, 10), req.session.user.id]);
  req.session.user = { ...req.session.user, mustChangePassword: false };
  res.json(req.session.user);
});

// Delete own account. Booking history and feedback stay for the reports (the student
// becomes NULL, shown as "former student"); notifications and waiting-list places go.
router.delete('/me', requireLogin, async (req, res) => {
  if (req.session.user.role === 'admin') {
    return res.status(403).json({ error: 'Administrators cannot delete their own account. Ask another administrator.' });
  }
  if (!await passwordMatches(req.session.user.id, req.body.password)) {
    return res.status(403).json({ error: 'Your password is wrong.' });
  }
  // Free any future slots first so other students can book them.
  await pool.query(`
    UPDATE bookings SET status = 'cancelled', cancelled_at = NOW()
    WHERE user_id = ? AND status = 'booked'`, [req.session.user.id]);
  await pool.query('DELETE FROM users WHERE id = ?', [req.session.user.id]);
  req.session.destroy(() => res.status(204).end());
});

module.exports = router;
