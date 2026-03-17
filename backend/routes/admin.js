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

// ── Client management routes ───────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/admin/clients – paginated list of clients
router.get('/clients', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const rows = db
    .prepare('SELECT * FROM clients ORDER BY name ASC LIMIT ? OFFSET ?')
    .all(limit, offset);
  const total = db.prepare('SELECT COUNT(*) AS count FROM clients').get().count;

  return res.json({ data: rows, total, page, limit });
});

// GET /api/admin/clients/:id – single client
router.get('/clients/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Client not found.' });
  return res.json(row);
});

// POST /api/admin/clients – create a new client
router.post('/clients', (req, res) => {
  const { name, email, phone, company, contract_value, payment_schedule, last_invoice_date, notes } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'name is required.' });
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  const result = db.prepare(`
    INSERT INTO clients (name, email, phone, company, contract_value, payment_schedule, last_invoice_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    email.trim().toLowerCase(),
    phone !== undefined ? (phone ? String(phone).trim() : null) : null,
    company !== undefined ? (company ? String(company).trim() : null) : null,
    contract_value !== undefined ? (contract_value !== null ? Number(contract_value) : null) : null,
    payment_schedule !== undefined ? (payment_schedule ? String(payment_schedule).trim() : null) : null,
    last_invoice_date !== undefined ? (last_invoice_date ? String(last_invoice_date).trim() : null) : null,
    notes !== undefined ? (notes ? String(notes).trim() : null) : null,
  );

  const created = db.prepare('SELECT * FROM clients WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json(created);
});

// PUT /api/admin/clients/:id – update a client
router.put('/clients/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Client not found.' });

  const { name, email, phone, company, contract_value, payment_schedule, last_invoice_date, notes } = req.body || {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) {
    return res.status(400).json({ error: 'name cannot be blank.' });
  }
  if (email !== undefined && (typeof email !== 'string' || !EMAIL_RE.test(email.trim()))) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  const updated = {
    name:              name !== undefined             ? name.trim()                                          : existing.name,
    email:             email !== undefined            ? email.trim().toLowerCase()                           : existing.email,
    phone:             phone !== undefined            ? (phone ? String(phone).trim() : null)               : existing.phone,
    company:           company !== undefined          ? (company ? String(company).trim() : null)           : existing.company,
    contract_value:    contract_value !== undefined   ? (contract_value !== null ? Number(contract_value) : null) : existing.contract_value,
    payment_schedule:  payment_schedule !== undefined ? (payment_schedule ? String(payment_schedule).trim() : null) : existing.payment_schedule,
    last_invoice_date: last_invoice_date !== undefined ? (last_invoice_date ? String(last_invoice_date).trim() : null) : existing.last_invoice_date,
    notes:             notes !== undefined            ? (notes ? String(notes).trim() : null)               : existing.notes,
  };

  db.prepare(`
    UPDATE clients
    SET name = ?, email = ?, phone = ?, company = ?, contract_value = ?,
        payment_schedule = ?, last_invoice_date = ?, notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    updated.name, updated.email, updated.phone, updated.company,
    updated.contract_value, updated.payment_schedule, updated.last_invoice_date,
    updated.notes, id,
  );

  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  return res.json(row);
});

// DELETE /api/admin/clients/:id – delete a client
router.delete('/clients/:id', (req, res) => {
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found.' });
  return res.json({ success: true });
});

module.exports = router;
