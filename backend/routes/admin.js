'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../database');
const authenticate = require('../middleware/authenticate');

const router = express.Router();

// 200 requests per 15 minutes per IP for authenticated admin actions
const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// All admin routes require a valid JWT and are rate-limited
router.use(adminLimiter);
router.use(authenticate);

// GET /api/admin/stats – summary counts for the dashboard
router.get('/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS count FROM contact_submissions').get().count;
  const unread = db.prepare('SELECT COUNT(*) AS count FROM contact_submissions WHERE read = 0').get().count;
  return res.json({ total, unread });
});

// GET /api/admin/contacts – paginated list of contact submissions
router.get('/contacts', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const rows = db
    .prepare('SELECT * FROM contact_submissions ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS count FROM contact_submissions').get().count;

  return res.json({ data: rows, total, page, limit });
});

// PATCH /api/admin/contacts/:id/read – mark a submission as read
router.patch('/contacts/:id/read', (req, res) => {
  const { id } = req.params;
  const result = db
    .prepare('UPDATE contact_submissions SET read = 1 WHERE id = ?')
    .run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Submission not found.' });
  }
  return res.json({ success: true });
});

// DELETE /api/admin/contacts/:id – delete a submission
router.delete('/contacts/:id', (req, res) => {
  const { id } = req.params;
  const result = db
    .prepare('DELETE FROM contact_submissions WHERE id = ?')
    .run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Submission not found.' });
  }
  return res.json({ success: true });
});

module.exports = router;
