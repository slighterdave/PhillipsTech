'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
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
  const { name, email, phone, company, address, contract_value, payment_schedule, last_invoice_date, notes } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'name is required.' });
  }
  if (!email || typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  const result = db.prepare(`
    INSERT INTO clients (name, email, phone, company, address, contract_value, payment_schedule, last_invoice_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name.trim(),
    email.trim().toLowerCase(),
    phone !== undefined ? (phone ? String(phone).trim() : null) : null,
    company !== undefined ? (company ? String(company).trim() : null) : null,
    address !== undefined ? (address ? String(address).trim() : null) : null,
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

  const { name, email, phone, company, address, contract_value, payment_schedule, last_invoice_date, notes } = req.body || {};

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
    address:           address !== undefined          ? (address ? String(address).trim() : null)           : existing.address,
    contract_value:    contract_value !== undefined   ? (contract_value !== null ? Number(contract_value) : null) : existing.contract_value,
    payment_schedule:  payment_schedule !== undefined ? (payment_schedule ? String(payment_schedule).trim() : null) : existing.payment_schedule,
    last_invoice_date: last_invoice_date !== undefined ? (last_invoice_date ? String(last_invoice_date).trim() : null) : existing.last_invoice_date,
    notes:             notes !== undefined            ? (notes ? String(notes).trim() : null)               : existing.notes,
  };

  db.prepare(`
    UPDATE clients
    SET name = ?, email = ?, phone = ?, company = ?, address = ?, contract_value = ?,
        payment_schedule = ?, last_invoice_date = ?, notes = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(
    updated.name, updated.email, updated.phone, updated.company, updated.address,
    updated.contract_value, updated.payment_schedule, updated.last_invoice_date,
    updated.notes, id,
  );

  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  return res.json(row);
});

// POST /api/admin/clients/:id/invoice – generate a PDF invoice and stamp last_invoice_date
router.post('/clients/:id/invoice', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  if (client.contract_value == null) {
    return res.status(400).json({ error: 'Client has no contract value set.' });
  }

  // Calculate the per-period invoice amount
  const scheduleMultiplier = {
    Weekly:        52,
    Monthly:       12,
    Quarterly:      4,
    'Bi-annually':  2,
    Annually:       1,
    'On completion':1,
  };
  const schedule = client.payment_schedule || '';
  const divisor  = scheduleMultiplier[schedule] || 1;
  const invoiceAmount = client.contract_value / divisor;

  // Dates
  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10); // YYYY-MM-DD
  const dueDate  = new Date(today);
  dueDate.setDate(dueDate.getDate() + 14);

  const fmtDate = (d) =>
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const fmtCurrency = (n) =>
    '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Invoice number: INV-YYYYMMDD-<clientId>
  const invoiceNum = `INV-${todayStr.replace(/-/g, '')}-${String(client.id).padStart(4, '0')}`;

  // Stamp last_invoice_date
  db.prepare(`UPDATE clients SET last_invoice_date = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(todayStr, client.id);

  // Build PDF
  const doc = new PDFDocument({ size: 'A4', margin: 50 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoiceNum}.pdf"`);
  doc.pipe(res);

  // ── Brand header ──────────────────────────────────────────────────────────
  const BRAND_BLUE = '#0066cc';
  const DARK       = '#1a1a2e';
  const MUTED      = '#6c757d';

  // Background stripe
  doc.rect(0, 0, doc.page.width, 100).fill(BRAND_BLUE);

  // Company name
  doc.fontSize(26).fillColor('#ffffff').font('Helvetica-Bold')
     .text('PhillipsTech', 50, 30);
  doc.fontSize(10).font('Helvetica').fillColor('#ffffff').fillOpacity(0.85)
     .text('Managed IT Services', 50, 62);

  // Invoice label (top-right)
  doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff')
     .text('INVOICE', 50, 30, { align: 'right' });
  doc.fontSize(10).font('Helvetica').fillColor('#ffffff').fillOpacity(0.85)
     .text(invoiceNum, 50, 62, { align: 'right' });

  // ── Meta grid ─────────────────────────────────────────────────────────────
  const metaTop = 120;
  doc.fillOpacity(1);
  doc.fontSize(9).fillColor(MUTED).font('Helvetica-Bold')
     .text('INVOICE DATE', 50, metaTop)
     .text('DUE DATE',    200, metaTop)
     .text('PAYMENT TERMS',350, metaTop);

  doc.fontSize(11).fillColor(DARK).font('Helvetica')
     .text(fmtDate(today),  50, metaTop + 14)
     .text(fmtDate(dueDate),200, metaTop + 14)
     .text('14 days',       350, metaTop + 14);

  // ── Divider ───────────────────────────────────────────────────────────────
  doc.moveTo(50, metaTop + 38).lineTo(doc.page.width - 50, metaTop + 38)
     .strokeColor('#dee2e6').lineWidth(1).stroke();

  // ── Bill To ───────────────────────────────────────────────────────────────
  const billTop = metaTop + 54;
  doc.fontSize(9).fillColor(MUTED).font('Helvetica-Bold').text('BILL TO', 50, billTop);
  doc.fontSize(12).fillColor(DARK).font('Helvetica-Bold')
     .text(client.company || client.name, 50, billTop + 14);

  let billY = billTop + 30;
  if (client.company) {
    doc.fontSize(10).font('Helvetica').fillColor(DARK).text(client.name, 50, billY);
    billY += 14;
  }
  if (client.address) {
    const addrLines = client.address.split(/\n/);
    addrLines.forEach(line => {
      doc.fontSize(10).font('Helvetica').fillColor(DARK).text(line.trim(), 50, billY);
      billY += 14;
    });
  }
  doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(client.email, 50, billY);
  if (client.phone) {
    billY += 14;
    doc.fontSize(10).font('Helvetica').fillColor(MUTED).text(client.phone, 50, billY);
  }

  // ── Line items table ──────────────────────────────────────────────────────
  const tableTop = Math.max(billY + 40, billTop + 110);
  const colDesc   = 50;
  const colPeriod = 300;
  const colAmt    = 420;
  const colTotal  = doc.page.width - 50;

  // Table header
  doc.rect(50, tableTop, doc.page.width - 100, 24).fill(BRAND_BLUE);
  doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
     .text('DESCRIPTION',    colDesc,   tableTop + 7)
     .text('PERIOD',         colPeriod, tableTop + 7)
     .text('AMOUNT',         colAmt,    tableTop + 7, { width: colTotal - colAmt, align: 'right' });

  // Table row
  const rowY = tableTop + 28;
  const description = `Managed IT Services${schedule ? ' – ' + schedule : ''}`;
  doc.fontSize(10).fillColor(DARK).font('Helvetica')
     .text(description, colDesc, rowY)
     .text(schedule || '—', colPeriod, rowY)
     .text(fmtCurrency(invoiceAmount), colAmt, rowY, { width: colTotal - colAmt, align: 'right' });

  // Row bottom border
  const rowBottom = rowY + 22;
  doc.moveTo(50, rowBottom).lineTo(doc.page.width - 50, rowBottom)
     .strokeColor('#dee2e6').lineWidth(0.5).stroke();

  // ── Totals ────────────────────────────────────────────────────────────────
  const totalsTop = rowBottom + 16;

  // Sub-total row
  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text('Subtotal', colAmt, totalsTop, { width: colTotal - colAmt, align: 'right' });
  doc.fontSize(10).fillColor(DARK)
     .text(fmtCurrency(invoiceAmount), colAmt, totalsTop + 14, { width: colTotal - colAmt, align: 'right' });

  // Divider before total
  doc.moveTo(colAmt, totalsTop + 32).lineTo(doc.page.width - 50, totalsTop + 32)
     .strokeColor('#dee2e6').lineWidth(0.5).stroke();

  // TOTAL row
  doc.rect(colAmt - 10, totalsTop + 36, doc.page.width - 50 - colAmt + 10, 28).fill('#f0f2f5');
  doc.fontSize(11).fillColor(DARK).font('Helvetica-Bold')
     .text('TOTAL DUE', colAmt, totalsTop + 43, { width: colTotal - colAmt - 10, align: 'right' });
  doc.fontSize(14).fillColor(BRAND_BLUE).font('Helvetica-Bold')
     .text(fmtCurrency(invoiceAmount), colAmt, totalsTop + 58, { width: colTotal - colAmt - 10, align: 'right' });

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerY = doc.page.height - 60;
  doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY)
     .strokeColor('#dee2e6').lineWidth(0.5).stroke();
  doc.fontSize(8).fillColor(MUTED).font('Helvetica')
     .text('Thank you for your business. Please make payment within 14 days of invoice date.',
           50, footerY + 10, { align: 'center', width: doc.page.width - 100 })
     .text('PhillipsTech  •  info@phillipstech.co.uk',
           50, footerY + 24, { align: 'center', width: doc.page.width - 100 });

  doc.end();
});

// DELETE /api/admin/clients/:id – delete a client
router.delete('/clients/:id', (req, res) => {
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found.' });
  return res.json({ success: true });
});

module.exports = router;
