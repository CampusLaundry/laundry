// Laundry tips: everyone reads them; the administrator writes them.
const express = require('express');
const pool = require('../db/pool');
const { requireLogin, requireRole } = require('../lib/middleware');
const { fail, text, oneOf } = require('../lib/validate');

const router = express.Router();
router.use(requireLogin);
const adminOnly = requireRole('admin');

const CATEGORIES = ['sorting', 'detergents', 'fabrics', 'maintenance'];

function readTip(body) {
  return {
    category: oneOf(body.category, CATEGORIES, 'category'),
    title: text(body.title, 'The title', 5, 150),
    body: text(body.body, 'The tip', 20, 5000),
    isPublished: body.isPublished === undefined ? true : !!body.isPublished,
  };
}

// ?category= ; administrators also see drafts.
router.get('/', async (req, res) => {
  const where = [];
  const params = [];
  if (req.session.user.role !== 'admin') where.push('t.is_published');
  if (CATEGORIES.includes(req.query.category)) where.push('t.category = ?'), params.push(req.query.category);
  const [rows] = await pool.query(`
    SELECT t.id, t.category, t.title, t.body, t.is_published, t.created_at, t.updated_at, u.full_name AS author
    FROM laundry_tips t LEFT JOIN users u ON u.id = t.created_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY FIELD(t.category, 'sorting', 'detergents', 'fabrics', 'maintenance'), t.title`, params);
  res.json(rows.map((t) => ({ ...t, is_published: !!t.is_published })));
});

router.post('/', adminOnly, async (req, res) => {
  const t = readTip(req.body);
  try {
    const [r] = await pool.query('INSERT INTO laundry_tips (category, title, body, is_published, created_by) VALUES (?, ?, ?, ?, ?)',
      [t.category, t.title, t.body, t.isPublished, req.session.user.id]);
    res.status(201).json({ id: r.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A tip with this title already exists.' });
    throw err;
  }
});

router.put('/:id', adminOnly, async (req, res) => {
  const t = readTip(req.body);
  try {
    const [r] = await pool.query('UPDATE laundry_tips SET category = ?, title = ?, body = ?, is_published = ? WHERE id = ?',
      [t.category, t.title, t.body, t.isPublished, req.params.id]);
    if (r.affectedRows === 0) fail(404, 'Tip not found.');
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A tip with this title already exists.' });
    throw err;
  }
  res.json({ id: Number(req.params.id) });
});

router.delete('/:id', adminOnly, async (req, res) => {
  const [r] = await pool.query('DELETE FROM laundry_tips WHERE id = ?', [req.params.id]);
  if (r.affectedRows === 0) return res.status(404).json({ error: 'Tip not found.' });
  res.status(204).end();
});

module.exports = router;
