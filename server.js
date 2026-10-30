require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const path = require('path');
const { loadUser } = require('./lib/middleware');
const { HttpError } = require('./lib/validate');
const { startScheduler } = require('./lib/laundry');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api', loadUser);
app.use('/api/auth', require('./routes/auth'));
app.use('/api/rooms', require('./routes/rooms'));
app.use('/api/machines', require('./routes/machines'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/waitlist', require('./routes/waitlist'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/tips', require('./routes/tips'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// Last line of defence: if the app's own validation misses something, the database
// constraints still reject it, and we turn MySQL's error into a readable message.
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That upload is too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request could not be read.' });
  console.error(err);
  switch (err.code) {
    case 'ECONNREFUSED':
      return res.status(500).json({ error: 'Cannot reach the database. Is MySQL running?' });
    case 'ER_CHECK_CONSTRAINT_VIOLATED':
      return res.status(400).json({ error: 'The database rejected invalid data.' });
    case 'ER_DUP_ENTRY':
      return res.status(409).json({ error: 'That already exists.' });
    case 'ER_ROW_IS_REFERENCED_2':
      return res.status(409).json({ error: 'This is still in use by other records.' });
    case 'ER_NO_REFERENCED_ROW_2':
      return res.status(400).json({ error: 'That refers to something that does not exist.' });
    default:
      return res.status(500).json({ error: 'Something went wrong on the server.' });
  }
});

const port = Number(process.env.PORT) || 3003;
app.listen(port, () => {
  console.log(`Campus Laundry running at http://localhost:${port}`);
  startScheduler(); // reminders, finished cycles, no-shows
  require('./db/pool').warmUp().catch((err) => console.error('Database not reachable:', err.message));
});
