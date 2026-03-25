'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
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

  // Attach service_ids array to each client row
  const svcStmt = db.prepare('SELECT service_id FROM client_services WHERE client_id = ?');
  rows.forEach(row => {
    row.service_ids = svcStmt.all(row.id).map(r => r.service_id);
  });

  return res.json({ data: rows, total, page, limit });
});

// GET /api/admin/clients/:id – single client
router.get('/clients/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Client not found.' });
  const svcRows = db.prepare('SELECT service_id FROM client_services WHERE client_id = ?').all(req.params.id);
  row.service_ids = svcRows.map(r => r.service_id);
  return res.json(row);
});

// POST /api/admin/clients – create a new client
router.post('/clients', (req, res) => {
  const { name, email, phone, company, address, contract_value, payment_schedule, last_invoice_date, notes, service_ids } = req.body || {};

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

  const newId = result.lastInsertRowid;

  // Save service associations (filter to valid integer IDs only)
  const validServiceIds = Array.isArray(service_ids)
    ? service_ids.map(id => parseInt(id, 10)).filter(id => Number.isFinite(id) && id > 0)
    : [];
  if (validServiceIds.length > 0) {
    const insertSvc = db.prepare('INSERT OR IGNORE INTO client_services (client_id, service_id) VALUES (?, ?)');
    const saveServices = db.transaction((ids) => {
      ids.forEach(sid => insertSvc.run(newId, sid));
    });
    saveServices(validServiceIds);
  }

  const created = db.prepare('SELECT * FROM clients WHERE id = ?').get(newId);
  created.service_ids = db.prepare('SELECT service_id FROM client_services WHERE client_id = ?').all(newId).map(r => r.service_id);
  return res.status(201).json(created);
});

// PUT /api/admin/clients/:id – update a client
router.put('/clients/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Client not found.' });

  const { name, email, phone, company, address, contract_value, payment_schedule, last_invoice_date, notes, service_ids } = req.body || {};

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

  // Update service associations if provided (filter to valid integer IDs only)
  if (Array.isArray(service_ids)) {
    const validSvcIds = service_ids.map(sid => parseInt(sid, 10)).filter(sid => Number.isFinite(sid) && sid > 0);
    const replaceServices = db.transaction((ids) => {
      db.prepare('DELETE FROM client_services WHERE client_id = ?').run(id);
      const insertSvc = db.prepare('INSERT OR IGNORE INTO client_services (client_id, service_id) VALUES (?, ?)');
      ids.forEach(sid => insertSvc.run(Number(id), sid));
    });
    replaceServices(validSvcIds);
  }

  const row = db.prepare('SELECT * FROM clients WHERE id = ?').get(id);
  row.service_ids = db.prepare('SELECT service_id FROM client_services WHERE client_id = ?').all(id).map(r => r.service_id);
  return res.json(row);
});

// ── Invoice PDF helper ────────────────────────────────────────────────────
// Draws all invoice content onto doc. Caller must pipe doc and call doc.end().
function drawInvoice(doc, client, selectedServices, siteSettings, invoiceNum, today) {
  const hasServices = selectedServices.length > 0;

  const dueDate = new Date(today);
  dueDate.setDate(dueDate.getDate() + 14);

  const fmtDate = (d) =>
    d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const fmtCurrency = (n) =>
    '£' + Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  const colAmt    = 420;
  const colTotal  = doc.page.width - 50;

  if (hasServices) {
    // ── Services-based invoice ────────────────────────────────────────────
    const colDescWidth = colAmt - colDesc - 10;

    // Table header
    doc.rect(50, tableTop, doc.page.width - 100, 24).fill(BRAND_BLUE);
    doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold')
       .text('DESCRIPTION', colDesc,  tableTop + 7, { width: colDescWidth })
       .text('AMOUNT',      colAmt,   tableTop + 7, { width: colTotal - colAmt, align: 'right' });

    let rowY = tableTop + 28;
    let totalAmount = 0;

    selectedServices.forEach((svc, idx) => {
      const rowBg = idx % 2 === 1 ? '#f8f9fa' : '#ffffff';
      const rowHeight = svc.description ? 32 : 22;
      doc.rect(50, rowY, doc.page.width - 100, rowHeight).fill(rowBg);

      doc.fontSize(10).fillColor(DARK).font('Helvetica-Bold')
         .text(svc.name, colDesc, rowY + 6, { width: colDescWidth });
      if (svc.description) {
        doc.fontSize(8).font('Helvetica').fillColor(MUTED)
           .text(svc.description, colDesc, rowY + 19, { width: colDescWidth });
      }
      doc.fontSize(10).fillColor(DARK).font('Helvetica')
         .text(fmtCurrency(svc.unit_price), colAmt, rowY + 6, { width: colTotal - colAmt, align: 'right' });

      doc.moveTo(50, rowY + rowHeight).lineTo(doc.page.width - 50, rowY + rowHeight)
         .strokeColor('#dee2e6').lineWidth(0.5).stroke();

      totalAmount += Number(svc.unit_price);
      rowY += rowHeight;
    });

    // ── Totals ──────────────────────────────────────────────────────────
    const totalsTop = rowY + 16;

    doc.fontSize(10).fillColor(MUTED).font('Helvetica')
       .text('Subtotal', colAmt, totalsTop, { width: colTotal - colAmt, align: 'right' });
    doc.fontSize(10).fillColor(DARK)
       .text(fmtCurrency(totalAmount), colAmt, totalsTop + 14, { width: colTotal - colAmt, align: 'right' });

    doc.moveTo(colAmt, totalsTop + 32).lineTo(doc.page.width - 50, totalsTop + 32)
       .strokeColor('#dee2e6').lineWidth(0.5).stroke();

    doc.rect(colAmt - 10, totalsTop + 36, doc.page.width - 50 - colAmt + 10, 44).fill('#f0f2f5');
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text('TOTAL DUE', colAmt, totalsTop + 42, { width: colTotal - colAmt - 10, align: 'right' });
    doc.fontSize(14).fillColor(BRAND_BLUE).font('Helvetica-Bold')
       .text(fmtCurrency(totalAmount), colAmt, totalsTop + 55, { width: colTotal - colAmt - 10, align: 'right' });

  } else {
    // ── Contract-value based invoice (legacy) ─────────────────────────────
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

    const colPeriod = 300;

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

    const rowBottom = rowY + 22;
    doc.moveTo(50, rowBottom).lineTo(doc.page.width - 50, rowBottom)
       .strokeColor('#dee2e6').lineWidth(0.5).stroke();

    // ── Totals ──────────────────────────────────────────────────────────
    const totalsTop = rowBottom + 16;

    doc.fontSize(10).fillColor(MUTED).font('Helvetica')
       .text('Subtotal', colAmt, totalsTop, { width: colTotal - colAmt, align: 'right' });
    doc.fontSize(10).fillColor(DARK)
       .text(fmtCurrency(invoiceAmount), colAmt, totalsTop + 14, { width: colTotal - colAmt, align: 'right' });

    doc.moveTo(colAmt, totalsTop + 32).lineTo(doc.page.width - 50, totalsTop + 32)
       .strokeColor('#dee2e6').lineWidth(0.5).stroke();

    doc.rect(colAmt - 10, totalsTop + 36, doc.page.width - 50 - colAmt + 10, 44).fill('#f0f2f5');
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text('TOTAL DUE', colAmt, totalsTop + 42, { width: colTotal - colAmt - 10, align: 'right' });
    doc.fontSize(14).fillColor(BRAND_BLUE).font('Helvetica-Bold')
       .text(fmtCurrency(invoiceAmount), colAmt, totalsTop + 55, { width: colTotal - colAmt - 10, align: 'right' });
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const fAddrLines = siteSettings.address
    ? siteSettings.address.split(/\n/).map(l => l.trim()).filter(Boolean)
    : [];

  const fBankLines = [];
  if (siteSettings.bank_name)           fBankLines.push(siteSettings.bank_name);
  if (siteSettings.bank_account_name)   fBankLines.push(`Acct: ${siteSettings.bank_account_name}`);
  if (siteSettings.bank_sort_code)      fBankLines.push(`Sort: ${siteSettings.bank_sort_code}`);
  if (siteSettings.bank_account_number) fBankLines.push(`No: ${siteSettings.bank_account_number}`);

  const fCryptoLines = [];
  if (siteSettings.btc_address) fCryptoLines.push({ label: 'BTC', addr: siteSettings.btc_address });
  if (siteSettings.sol_address) fCryptoLines.push({ label: 'SOL', addr: siteSettings.sol_address });

  const hasAddr    = fAddrLines.length > 0;
  const hasBank    = fBankLines.length > 0;
  const hasCrypto  = fCryptoLines.length > 0;
  const hasContent = hasAddr || hasBank || hasCrypto;

  const FL = 13;
  const FH = 11;
  const FG = 10;
  const CRYPTO_LABEL_H = 10;

  const cryptoEntryH = CRYPTO_LABEL_H + FL;
  const addrColH   = hasAddr   ? FH + fAddrLines.length * FL            : 0;
  const bankColH   = hasBank   ? FH + fBankLines.length * FL            : 0;
  const cryptoColH = hasCrypto ? FH + fCryptoLines.length * cryptoEntryH : 0;
  const maxColH    = Math.max(addrColH, bankColH, cryptoColH);

  const safeBottom  = doc.page.height - 55;
  const brandY      = safeBottom - FL;
  const thankY      = brandY - FL;
  const innerDivY   = thankY - FG;
  const contentEndY = innerDivY - (hasContent ? FG : 0);
  const contentY    = contentEndY - (hasContent ? maxColH : 0);
  const topDivY     = contentY - (hasContent ? FG : 0);

  doc.rect(0, topDivY - 6, doc.page.width, doc.page.height - topDivY + 6)
     .fill('#f8f9fa');

  doc.moveTo(50, topDivY).lineTo(doc.page.width - 50, topDivY)
     .strokeColor('#dee2e6').lineWidth(0.5).stroke();

  if (hasContent) {
    const col1X = 50;
    const col2X = 215;
    const col3X = 395;

    if (hasAddr) {
      let y = contentY;
      doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
         .text('ADDRESS', col1X, y, { width: 155 });
      y += FH;
      fAddrLines.forEach(line => {
        doc.fontSize(8.5).fillColor(DARK).font('Helvetica')
           .text(line, col1X, y, { width: 155, lineBreak: false });
        y += FL;
      });
    }

    if (hasBank) {
      let y = contentY;
      doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
         .text('BANK TRANSFER', col2X, y, { width: 170 });
      y += FH;
      fBankLines.forEach(line => {
        doc.fontSize(8.5).fillColor(DARK).font('Helvetica')
           .text(line, col2X, y, { width: 170, lineBreak: false });
        y += FL;
      });
    }

    if (hasCrypto) {
      let y = contentY;
      doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
         .text('CRYPTOCURRENCY', col3X, y, { width: 150 });
      y += FH;
      fCryptoLines.forEach(({ label, addr }) => {
        doc.fontSize(7).fillColor(MUTED).font('Helvetica-Bold')
           .text(label + ':', col3X, y, { width: 150 });
        y += CRYPTO_LABEL_H;
        doc.fontSize(7).fillColor(DARK).font('Helvetica')
           .text(addr, col3X, y, { lineBreak: false });
        y += FL;
      });
    }

    doc.moveTo(50, innerDivY).lineTo(doc.page.width - 50, innerDivY)
       .strokeColor('#dee2e6').lineWidth(0.3).stroke();
  }

  doc.fontSize(8).fillColor(MUTED).font('Helvetica')
     .text('Thank you for your business. Please make payment within 14 days of invoice date.',
           50, thankY, { align: 'center', width: doc.page.width - 100 });
  doc.fontSize(8).fillColor(MUTED).font('Helvetica')
     .text('PhillipsTech  •  dave@phillipstech.info',
           50, brandY, { align: 'center', width: doc.page.width - 100 });
}

// Resolves with a Buffer containing the complete PDF.
function buildInvoiceBuffer(client, selectedServices, siteSettings, invoiceNum, today) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    drawInvoice(doc, client, selectedServices, siteSettings, invoiceNum, today);
    doc.end();
  });
}

// ── Shared invoice data loader ────────────────────────────────────────────
function loadInvoiceData(clientId) {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) return null;

  const selectedServices = db.prepare(`
    SELECT s.* FROM services s
    INNER JOIN client_services cs ON cs.service_id = s.id
    WHERE cs.client_id = ?
    ORDER BY s.name ASC
  `).all(clientId);

  const siteSettings = {};
  try {
    db.prepare('SELECT key, value FROM site_settings').all().forEach(r => {
      siteSettings[r.key] = r.value;
    });
  } catch {
    // Settings unavailable; footer will render without details
  }

  return { client, selectedServices, siteSettings };
}

// Helper: calculate the amount for an invoice from client + selected services
function calcInvoiceAmount(client, selectedServices) {
  if (selectedServices.length > 0) {
    return selectedServices.reduce((sum, s) => sum + Number(s.unit_price), 0);
  }
  const scheduleMultiplier = { Weekly: 52, Monthly: 12, Quarterly: 4, 'Bi-annually': 2, Annually: 1, 'On completion': 1 };
  const divisor = scheduleMultiplier[client.payment_schedule] || 1;
  return client.contract_value / divisor;
}

// GET /api/admin/clients/:id/invoice/preview – generate invoice PDF for preview (no date stamp)
router.get('/clients/:id/invoice/preview', (req, res) => {
  const data = loadInvoiceData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Client not found.' });

  const { client, selectedServices, siteSettings } = data;

  if (selectedServices.length === 0 && client.contract_value == null) {
    return res.status(400).json({ error: 'Client has no services or contract value set.' });
  }

  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const invoiceNum = `INV-${todayStr.replace(/-/g, '')}-${String(client.id).padStart(4, '0')}`;

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${invoiceNum}.pdf"`);
  doc.pipe(res);
  drawInvoice(doc, client, selectedServices, siteSettings, invoiceNum, today);
  doc.end();
});

// POST /api/admin/clients/:id/invoice – generate a PDF invoice and download it
router.post('/clients/:id/invoice', (req, res) => {
  const data = loadInvoiceData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Client not found.' });

  const { client, selectedServices, siteSettings } = data;

  if (selectedServices.length === 0 && client.contract_value == null) {
    return res.status(400).json({ error: 'Client has no services or contract value set.' });
  }

  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const invoiceNum = `INV-${todayStr.replace(/-/g, '')}-${String(client.id).padStart(4, '0')}`;

  // Calculate invoice amount
  let invoiceAmount = 0;
  if (selectedServices.length > 0) {
    invoiceAmount = selectedServices.reduce((sum, s) => sum + Number(s.unit_price), 0);
  } else {
    const scheduleMultiplier = { Weekly: 52, Monthly: 12, Quarterly: 4, 'Bi-annually': 2, Annually: 1, 'On completion': 1 };
    const divisor = scheduleMultiplier[client.payment_schedule] || 1;
    invoiceAmount = client.contract_value / divisor;
  }

  db.prepare(`UPDATE clients SET last_invoice_date = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(todayStr, client.id);

  // Persist invoice record
  db.prepare(`INSERT INTO invoices (client_id, invoice_num, amount, issued_date) VALUES (?, ?, ?, ?)`)
    .run(client.id, invoiceNum, invoiceAmount, todayStr);

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${invoiceNum}.pdf"`);
  doc.pipe(res);
  drawInvoice(doc, client, selectedServices, siteSettings, invoiceNum, today);
  doc.end();
});

// POST /api/admin/clients/:id/invoice/send – generate PDF and email it to the client
router.post('/clients/:id/invoice/send', async (req, res) => {
  const data = loadInvoiceData(req.params.id);
  if (!data) return res.status(404).json({ error: 'Client not found.' });

  const { client, selectedServices, siteSettings } = data;

  if (selectedServices.length === 0 && client.contract_value == null) {
    return res.status(400).json({ error: 'Client has no services or contract value set.' });
  }

  const gmailUser = (siteSettings.gmail_user || '').trim();
  const gmailPass = (siteSettings.gmail_app_password || '').trim();
  if (!gmailUser || !gmailPass) {
    return res.status(400).json({ error: 'Gmail credentials are not configured. Please add them in Settings.' });
  }

  const today    = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const invoiceNum = `INV-${todayStr.replace(/-/g, '')}-${String(client.id).padStart(4, '0')}`;

  let pdfBuffer;
  try {
    pdfBuffer = await buildInvoiceBuffer(client, selectedServices, siteSettings, invoiceNum, today);
  } catch (err) {
    console.error('Invoice PDF generation failed:', err);
    return res.status(500).json({ error: 'Failed to generate invoice PDF.' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass },
  });

  const recipientName = client.company || client.name;
  const defaultEmailBody = `Dear ${recipientName},\n\nPlease find your invoice ${invoiceNum} attached.\n\nPayment is due within 14 days. Thank you for your business.\n\nKind regards,\nPhillipsTech`;
  const emailBody = (typeof req.body.email_body === 'string' && req.body.email_body.trim())
    ? req.body.email_body.trim()
    : defaultEmailBody;
  const mailOptions = {
    from: `PhillipsTech <${gmailUser}>`,
    to: client.email,
    subject: `Invoice ${invoiceNum} from PhillipsTech`,
    text: emailBody,
    attachments: [
      { filename: `${invoiceNum}.pdf`, content: pdfBuffer, contentType: 'application/pdf' },
    ],
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (err) {
    console.error('Invoice email failed:', err);
    const isAuthErr = err.responseCode === 535 || (err.code === 'EAUTH') ||
      (typeof err.message === 'string' && err.message.toLowerCase().includes('invalid credentials'));
    const hint = isAuthErr
      ? 'Authentication failed — check that the Gmail address and App Password are correct in Settings.'
      : 'Email could not be sent. Verify the Gmail credentials in Settings and ensure the account allows SMTP access.';
    return res.status(502).json({ error: hint });
  }

  // Stamp last_invoice_date only after successful send
  db.prepare(`UPDATE clients SET last_invoice_date = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(todayStr, client.id);

  // Persist invoice record
  const invoiceAmount = calcInvoiceAmount(client, selectedServices);
  db.prepare(`INSERT INTO invoices (client_id, invoice_num, amount, issued_date) VALUES (?, ?, ?, ?)`)
    .run(client.id, invoiceNum, invoiceAmount, todayStr);

  return res.json({ success: true, invoiceNum, sentTo: client.email });
});

// DELETE /api/admin/clients/:id – delete a client
router.delete('/clients/:id', (req, res) => {
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found.' });
  return res.json({ success: true });
});

// ── Invoice history routes ─────────────────────────────────────────────────

// GET /api/admin/clients/:id/invoices – list invoices for a client
router.get('/clients/:id/invoices', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const rows = db.prepare('SELECT * FROM invoices WHERE client_id = ? ORDER BY issued_date DESC, id DESC').all(req.params.id);
  return res.json(rows);
});

// GET /api/admin/invoices – list all invoices (optionally filtered by client)
router.get('/invoices', (req, res) => {
  const clientId = req.query.client_id ? parseInt(req.query.client_id, 10) : null;
  let rows;
  if (clientId) {
    rows = db.prepare(`
      SELECT i.*, c.name AS client_name, c.company AS client_company
      FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.client_id = ? ORDER BY i.issued_date DESC, i.id DESC
    `).all(clientId);
  } else {
    rows = db.prepare(`
      SELECT i.*, c.name AS client_name, c.company AS client_company
      FROM invoices i JOIN clients c ON c.id = i.client_id
      ORDER BY i.issued_date DESC, i.id DESC
    `).all();
  }
  return res.json(rows);
});

// POST /api/admin/clients/:id/invoices – manually create an invoice record
router.post('/clients/:id/invoices', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  const { invoice_num, amount, issued_date, notes } = req.body || {};
  if (!invoice_num || typeof invoice_num !== 'string' || invoice_num.trim().length < 1) {
    return res.status(400).json({ error: 'invoice_num is required.' });
  }
  if (amount === undefined || amount === null || !Number.isFinite(Number(amount))) {
    return res.status(400).json({ error: 'A valid amount is required.' });
  }
  const dateStr = issued_date ? String(issued_date).trim() : new Date().toISOString().slice(0, 10);

  const result = db.prepare(`
    INSERT INTO invoices (client_id, invoice_num, amount, issued_date, notes)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, invoice_num.trim(), Number(amount), dateStr, notes ? String(notes).trim() : null);

  const created = db.prepare('SELECT * FROM invoices WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json(created);
});

// PATCH /api/admin/clients/:clientId/invoices/:invId/paid – toggle paid status
router.patch('/clients/:clientId/invoices/:invId/paid', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND client_id = ?').get(req.params.invId, req.params.clientId);
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

  const paid = inv.paid ? 0 : 1;
  const paidDate = paid ? new Date().toISOString().slice(0, 10) : null;
  db.prepare('UPDATE invoices SET paid = ?, paid_date = ? WHERE id = ?').run(paid, paidDate, inv.id);

  const updated = db.prepare('SELECT * FROM invoices WHERE id = ?').get(inv.id);
  return res.json(updated);
});

// DELETE /api/admin/clients/:clientId/invoices/:invId – delete an invoice record
router.delete('/clients/:clientId/invoices/:invId', (req, res) => {
  const result = db.prepare('DELETE FROM invoices WHERE id = ? AND client_id = ?').run(req.params.invId, req.params.clientId);
  if (result.changes === 0) return res.status(404).json({ error: 'Invoice not found.' });
  return res.json({ success: true });
});

// GET /api/admin/clients/:clientId/invoices/:invId/pdf – download PDF for an existing invoice (no new record)
router.get('/clients/:clientId/invoices/:invId/pdf', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND client_id = ?').get(req.params.invId, req.params.clientId);
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

  const data = loadInvoiceData(req.params.clientId);
  if (!data) return res.status(404).json({ error: 'Client not found.' });

  const { client, selectedServices, siteSettings } = data;

  const issuedDate = inv.issued_date ? new Date(inv.issued_date + 'T00:00:00') : new Date();

  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_num}.pdf"`);
  doc.pipe(res);
  drawInvoice(doc, client, selectedServices, siteSettings, inv.invoice_num, issuedDate);
  doc.end();
});

// POST /api/admin/clients/:clientId/invoices/:invId/send – resend an existing invoice by email
router.post('/clients/:clientId/invoices/:invId/send', async (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ? AND client_id = ?').get(req.params.invId, req.params.clientId);
  if (!inv) return res.status(404).json({ error: 'Invoice not found.' });

  const data = loadInvoiceData(req.params.clientId);
  if (!data) return res.status(404).json({ error: 'Client data not found.' });

  const { client, selectedServices, siteSettings } = data;

  const gmailUser = (siteSettings.gmail_user || '').trim();
  const gmailPass = (siteSettings.gmail_app_password || '').trim();
  if (!gmailUser || !gmailPass) {
    return res.status(400).json({ error: 'Gmail credentials are not configured. Please add them in Settings.' });
  }

  const issuedDate = inv.issued_date ? new Date(inv.issued_date + 'T00:00:00') : new Date();

  let pdfBuffer;
  try {
    pdfBuffer = await buildInvoiceBuffer(client, selectedServices, siteSettings, inv.invoice_num, issuedDate);
  } catch (err) {
    console.error('Invoice PDF generation failed:', err);
    return res.status(500).json({ error: 'Failed to generate invoice PDF.' });
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: gmailUser, pass: gmailPass },
  });

  const recipientName = client.company || client.name;
  const defaultEmailBody = `Dear ${recipientName},\n\nPlease find your invoice ${inv.invoice_num} attached.\n\nPayment is due within 14 days. Thank you for your business.\n\nKind regards,\nPhillipsTech`;
  const emailBody = (typeof req.body.email_body === 'string' && req.body.email_body.trim())
    ? req.body.email_body.trim()
    : defaultEmailBody;

  const mailOptions = {
    from: `PhillipsTech <${gmailUser}>`,
    to: client.email,
    subject: `Invoice ${inv.invoice_num} from PhillipsTech`,
    text: emailBody,
    attachments: [
      { filename: `${inv.invoice_num}.pdf`, content: pdfBuffer, contentType: 'application/pdf' },
    ],
  };

  try {
    await transporter.sendMail(mailOptions);
  } catch (err) {
    console.error('Invoice resend email failed:', err);
    const isAuthErr = err.responseCode === 535 || (err.code === 'EAUTH') ||
      (typeof err.message === 'string' && err.message.toLowerCase().includes('invalid credentials'));
    const hint = isAuthErr
      ? 'Authentication failed — check that the Gmail address and App Password are correct in Settings.'
      : 'Email could not be sent. Verify the Gmail credentials in Settings and ensure the account allows SMTP access.';
    return res.status(502).json({ error: hint });
  }

  return res.json({ success: true, invoiceNum: inv.invoice_num, sentTo: client.email });
});

// ── Contact log routes ─────────────────────────────────────────────────────

// GET /api/admin/clients/:id/contact-log
router.get('/clients/:id/contact-log', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const rows = db.prepare('SELECT * FROM contact_log WHERE client_id = ? ORDER BY occurred_at DESC, id DESC').all(req.params.id);
  return res.json(rows);
});

// POST /api/admin/clients/:id/contact-log
router.post('/clients/:id/contact-log', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  const { type, summary, occurred_at } = req.body || {};
  if (!summary || typeof summary !== 'string' || summary.trim().length < 1) {
    return res.status(400).json({ error: 'summary is required.' });
  }
  const validTypes = ['call', 'email', 'meeting', 'note'];
  const logType = (type && validTypes.includes(type)) ? type : 'note';
  const dateStr = occurred_at ? String(occurred_at).trim() : new Date().toISOString().slice(0, 19).replace('T', ' ');

  const result = db.prepare(`
    INSERT INTO contact_log (client_id, type, summary, occurred_at) VALUES (?, ?, ?, ?)
  `).run(req.params.id, logType, summary.trim(), dateStr);

  const created = db.prepare('SELECT * FROM contact_log WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json(created);
});

// PUT /api/admin/clients/:clientId/contact-log/:logId
router.put('/clients/:clientId/contact-log/:logId', (req, res) => {
  const entry = db.prepare('SELECT * FROM contact_log WHERE id = ? AND client_id = ?').get(req.params.logId, req.params.clientId);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  const { type, summary, occurred_at } = req.body || {};
  const validTypes = ['call', 'email', 'meeting', 'note'];
  const updated = {
    type:        (type && validTypes.includes(type)) ? type : entry.type,
    summary:     summary !== undefined ? (summary ? String(summary).trim() : entry.summary) : entry.summary,
    occurred_at: occurred_at !== undefined ? String(occurred_at).trim() : entry.occurred_at,
  };
  db.prepare('UPDATE contact_log SET type = ?, summary = ?, occurred_at = ? WHERE id = ?')
    .run(updated.type, updated.summary, updated.occurred_at, entry.id);

  const row = db.prepare('SELECT * FROM contact_log WHERE id = ?').get(entry.id);
  return res.json(row);
});

// DELETE /api/admin/clients/:clientId/contact-log/:logId
router.delete('/clients/:clientId/contact-log/:logId', (req, res) => {
  const result = db.prepare('DELETE FROM contact_log WHERE id = ? AND client_id = ?').run(req.params.logId, req.params.clientId);
  if (result.changes === 0) return res.status(404).json({ error: 'Entry not found.' });
  return res.json({ success: true });
});

// ── Work log routes ────────────────────────────────────────────────────────

// GET /api/admin/clients/:id/work-log
router.get('/clients/:id/work-log', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const rows = db.prepare('SELECT * FROM work_log WHERE client_id = ? ORDER BY occurred_at DESC, id DESC').all(req.params.id);
  return res.json(rows);
});

// POST /api/admin/clients/:id/work-log
router.post('/clients/:id/work-log', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  const { description, hours, occurred_at } = req.body || {};
  if (!description || typeof description !== 'string' || description.trim().length < 1) {
    return res.status(400).json({ error: 'description is required.' });
  }
  const hoursVal = (hours !== undefined && hours !== null && Number.isFinite(Number(hours))) ? Number(hours) : null;
  const dateStr = occurred_at ? String(occurred_at).trim() : new Date().toISOString().slice(0, 10);

  const result = db.prepare(`
    INSERT INTO work_log (client_id, description, hours, occurred_at) VALUES (?, ?, ?, ?)
  `).run(req.params.id, description.trim(), hoursVal, dateStr);

  const created = db.prepare('SELECT * FROM work_log WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json(created);
});

// PUT /api/admin/clients/:clientId/work-log/:logId
router.put('/clients/:clientId/work-log/:logId', (req, res) => {
  const entry = db.prepare('SELECT * FROM work_log WHERE id = ? AND client_id = ?').get(req.params.logId, req.params.clientId);
  if (!entry) return res.status(404).json({ error: 'Entry not found.' });

  const { description, hours, occurred_at } = req.body || {};
  const updated = {
    description: description !== undefined ? (description ? String(description).trim() : entry.description) : entry.description,
    hours:       hours !== undefined ? (hours !== null && Number.isFinite(Number(hours)) ? Number(hours) : null) : entry.hours,
    occurred_at: occurred_at !== undefined ? String(occurred_at).trim() : entry.occurred_at,
  };
  db.prepare('UPDATE work_log SET description = ?, hours = ?, occurred_at = ? WHERE id = ?')
    .run(updated.description, updated.hours, updated.occurred_at, entry.id);

  const row = db.prepare('SELECT * FROM work_log WHERE id = ?').get(entry.id);
  return res.json(row);
});

// DELETE /api/admin/clients/:clientId/work-log/:logId
router.delete('/clients/:clientId/work-log/:logId', (req, res) => {
  const result = db.prepare('DELETE FROM work_log WHERE id = ? AND client_id = ?').run(req.params.logId, req.params.clientId);
  if (result.changes === 0) return res.status(404).json({ error: 'Entry not found.' });
  return res.json({ success: true });
});

// ── Projects routes ────────────────────────────────────────────────────────

// GET /api/admin/clients/:id/projects
router.get('/clients/:id/projects', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const rows = db.prepare('SELECT * FROM projects WHERE client_id = ? ORDER BY updated_at DESC, id DESC').all(req.params.id);
  return res.json(rows);
});

// POST /api/admin/clients/:id/projects
router.post('/clients/:id/projects', (req, res) => {
  const client = db.prepare('SELECT id FROM clients WHERE id = ?').get(req.params.id);
  if (!client) return res.status(404).json({ error: 'Client not found.' });

  const { name, description, status, start_date, end_date } = req.body || {};
  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'name is required.' });
  }
  const validStatuses = ['active', 'completed', 'on-hold'];
  const projStatus = (status && validStatuses.includes(status)) ? status : 'active';

  const result = db.prepare(`
    INSERT INTO projects (client_id, name, description, status, start_date, end_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    req.params.id,
    name.trim(),
    description ? String(description).trim() : null,
    projStatus,
    start_date ? String(start_date).trim() : null,
    end_date   ? String(end_date).trim()   : null,
  );

  const created = db.prepare('SELECT * FROM projects WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json(created);
});

// PUT /api/admin/clients/:clientId/projects/:projId
router.put('/clients/:clientId/projects/:projId', (req, res) => {
  const proj = db.prepare('SELECT * FROM projects WHERE id = ? AND client_id = ?').get(req.params.projId, req.params.clientId);
  if (!proj) return res.status(404).json({ error: 'Project not found.' });

  const { name, description, status, start_date, end_date } = req.body || {};
  const validStatuses = ['active', 'completed', 'on-hold'];
  const updated = {
    name:        name !== undefined        ? (name ? String(name).trim() : proj.name)                          : proj.name,
    description: description !== undefined ? (description ? String(description).trim() : null)                 : proj.description,
    status:      (status && validStatuses.includes(status)) ? status                                           : proj.status,
    start_date:  start_date !== undefined  ? (start_date ? String(start_date).trim() : null)                   : proj.start_date,
    end_date:    end_date !== undefined    ? (end_date   ? String(end_date).trim()   : null)                   : proj.end_date,
  };
  db.prepare(`
    UPDATE projects SET name = ?, description = ?, status = ?, start_date = ?, end_date = ?,
    updated_at = datetime('now') WHERE id = ?
  `).run(updated.name, updated.description, updated.status, updated.start_date, updated.end_date, proj.id);

  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(proj.id);
  return res.json(row);
});

// DELETE /api/admin/clients/:clientId/projects/:projId
router.delete('/clients/:clientId/projects/:projId', (req, res) => {
  const result = db.prepare('DELETE FROM projects WHERE id = ? AND client_id = ?').run(req.params.projId, req.params.clientId);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found.' });
  return res.json({ success: true });
});

// ── Services routes ────────────────────────────────────────────────────────

// GET /api/admin/services – list all services
router.get('/services', (req, res) => {
  const rows = db.prepare('SELECT * FROM services ORDER BY name ASC').all();
  return res.json(rows);
});

// POST /api/admin/services – create a service
router.post('/services', (req, res) => {
  const { name, description, unit_price } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 1) {
    return res.status(400).json({ error: 'name is required.' });
  }

  const result = db.prepare(`
    INSERT INTO services (name, description, unit_price)
    VALUES (?, ?, ?)
  `).run(
    name.trim(),
    description ? String(description).trim() : null,
    unit_price !== undefined && unit_price !== null ? (Number.isFinite(parseFloat(unit_price)) ? parseFloat(unit_price) : 0) : 0,
  );

  const created = db.prepare('SELECT * FROM services WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json(created);
});

// PUT /api/admin/services/:id – update a service
router.put('/services/:id', (req, res) => {
  const { id } = req.params;
  const existing = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Service not found.' });

  const { name, description, unit_price } = req.body || {};

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) {
    return res.status(400).json({ error: 'name cannot be blank.' });
  }

  const updated = {
    name:        name !== undefined        ? name.trim()                                           : existing.name,
    description: description !== undefined ? (description ? String(description).trim() : null)    : existing.description,
    unit_price:  unit_price !== undefined  ? (unit_price !== null && Number.isFinite(parseFloat(unit_price)) ? parseFloat(unit_price) : 0) : existing.unit_price,
  };

  db.prepare(`
    UPDATE services
    SET name = ?, description = ?, unit_price = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(updated.name, updated.description, updated.unit_price, id);

  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(id);
  return res.json(row);
});

// DELETE /api/admin/services/:id – delete a service
router.delete('/services/:id', (req, res) => {
  const result = db.prepare('DELETE FROM services WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Service not found.' });
  return res.json({ success: true });
});

// ── Site settings routes ───────────────────────────────────────────────────

const SETTINGS_KEYS = [
  'address',
  'bank_name',
  'bank_account_name',
  'bank_sort_code',
  'bank_account_number',
  'btc_address',
  'sol_address',
  'gmail_user',
  'gmail_app_password',
];

// GET /api/admin/settings – retrieve all site settings
router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const settings = {};
  SETTINGS_KEYS.forEach(k => { settings[k] = ''; });
  rows.forEach(r => { settings[r.key] = r.value; });
  return res.json(settings);
});

// PUT /api/admin/settings – upsert site settings
router.put('/settings', (req, res) => {
  const body = req.body || {};
  const upsert = db.prepare(`
    INSERT INTO site_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  const saveMany = db.transaction((data) => {
    SETTINGS_KEYS.forEach(k => {
      if (k in data) {
        upsert.run(k, String(data[k]));
      }
    });
  });

  saveMany(body);

  const rows = db.prepare('SELECT key, value FROM site_settings').all();
  const settings = {};
  SETTINGS_KEYS.forEach(k => { settings[k] = ''; });
  rows.forEach(r => { settings[r.key] = r.value; });
  return res.json(settings);
});

// ── Expenses routes ────────────────────────────────────────────────────────

const EXPENSE_CATEGORIES = ['software', 'hardware', 'hosting', 'marketing', 'travel', 'utilities', 'office', 'other'];
const EXPENSE_RECURRENCES = ['none', 'weekly', 'monthly', 'quarterly', 'yearly'];

// GET /api/admin/expenses – list all expenses (with optional filters)
router.get('/expenses', (req, res) => {
  const { category, from, to } = req.query;

  let query = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];

  if (category && EXPENSE_CATEGORIES.includes(category)) {
    query += ' AND category = ?';
    params.push(category);
  }
  if (from) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
      return res.status(400).json({ error: 'from must be a valid date (YYYY-MM-DD).' });
    }
    query += ' AND expense_date >= ?';
    params.push(String(from));
  }
  if (to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
      return res.status(400).json({ error: 'to must be a valid date (YYYY-MM-DD).' });
    }
    query += ' AND expense_date <= ?';
    params.push(String(to));
  }

  query += ' ORDER BY expense_date DESC, id DESC';

  const rows = db.prepare(query).all(...params);
  return res.json(rows);
});

// POST /api/admin/expenses – create an expense
router.post('/expenses', (req, res) => {
  const { title, amount, category, expense_date, notes, recurrence, recurrence_end_date } = req.body || {};

  if (!title || typeof title !== 'string' || title.trim().length < 1) {
    return res.status(400).json({ error: 'title is required.' });
  }
  if (amount === undefined || amount === null || !Number.isFinite(parseFloat(amount))) {
    return res.status(400).json({ error: 'amount must be a valid number.' });
  }
  if (!expense_date || typeof expense_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date.trim())) {
    return res.status(400).json({ error: 'expense_date is required (YYYY-MM-DD).' });
  }
  const cat = (category && EXPENSE_CATEGORIES.includes(category)) ? category : 'other';
  const rec = (recurrence && EXPENSE_RECURRENCES.includes(recurrence)) ? recurrence : 'none';

  let recEndDate = null;
  if (recurrence_end_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(recurrence_end_date).trim())) {
      return res.status(400).json({ error: 'recurrence_end_date must be YYYY-MM-DD.' });
    }
    if (String(recurrence_end_date).trim() <= expense_date.trim()) {
      return res.status(400).json({ error: 'recurrence_end_date must be after expense_date.' });
    }
    recEndDate = String(recurrence_end_date).trim();
  }

  const result = db.prepare(`
    INSERT INTO expenses (title, amount, category, expense_date, notes, recurrence, recurrence_end_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    title.trim(),
    parseFloat(amount),
    cat,
    expense_date.trim(),
    notes ? String(notes).trim() : null,
    rec,
    recEndDate,
  );

  const created = db.prepare('SELECT * FROM expenses WHERE id = ?').get(result.lastInsertRowid);
  return res.status(201).json(created);
});

// PUT /api/admin/expenses/:id – update an expense
router.put('/expenses/:id', (req, res) => {
  const expense = db.prepare('SELECT * FROM expenses WHERE id = ?').get(req.params.id);
  if (!expense) return res.status(404).json({ error: 'Expense not found.' });

  const { title, amount, category, expense_date, notes, recurrence, recurrence_end_date } = req.body || {};

  if (title !== undefined && (typeof title !== 'string' || title.trim().length < 1)) {
    return res.status(400).json({ error: 'title cannot be blank.' });
  }
  if (amount !== undefined && (amount === null || !Number.isFinite(parseFloat(amount)))) {
    return res.status(400).json({ error: 'amount must be a valid number.' });
  }
  if (expense_date !== undefined && (typeof expense_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expense_date.trim()))) {
    return res.status(400).json({ error: 'expense_date must be YYYY-MM-DD.' });
  }

  const effectiveDate = expense_date !== undefined ? expense_date.trim() : expense.expense_date;

  let recEndDate;
  if (recurrence_end_date !== undefined) {
    if (recurrence_end_date === null || recurrence_end_date === '') {
      recEndDate = null;
    } else {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(recurrence_end_date).trim())) {
        return res.status(400).json({ error: 'recurrence_end_date must be YYYY-MM-DD.' });
      }
      if (String(recurrence_end_date).trim() <= effectiveDate) {
        return res.status(400).json({ error: 'recurrence_end_date must be after expense_date.' });
      }
      recEndDate = String(recurrence_end_date).trim();
    }
  } else {
    recEndDate = expense.recurrence_end_date || null;
  }

  const updated = {
    title:                title        !== undefined ? title.trim()                                              : expense.title,
    amount:               amount       !== undefined ? parseFloat(amount)                                        : expense.amount,
    category:             (category && EXPENSE_CATEGORIES.includes(category)) ? category                        : expense.category,
    expense_date:         effectiveDate,
    notes:                notes        !== undefined ? (notes ? String(notes).trim() : null)                     : expense.notes,
    recurrence:           recurrence !== undefined
                            ? ((recurrence && EXPENSE_RECURRENCES.includes(recurrence)) ? recurrence : 'none')
                            : (expense.recurrence || 'none'),
    recurrence_end_date:  recEndDate,
  };

  db.prepare(`
    UPDATE expenses
    SET title = ?, amount = ?, category = ?, expense_date = ?, notes = ?, recurrence = ?,
        recurrence_end_date = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(updated.title, updated.amount, updated.category, updated.expense_date, updated.notes,
         updated.recurrence, updated.recurrence_end_date, expense.id);

  const row = db.prepare('SELECT * FROM expenses WHERE id = ?').get(expense.id);
  return res.json(row);
});

// DELETE /api/admin/expenses/:id – delete an expense
router.delete('/expenses/:id', (req, res) => {
  const result = db.prepare('DELETE FROM expenses WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Expense not found.' });
  return res.json({ success: true });
});

// ── Tax Summary ────────────────────────────────────────────────────────────────

// GET /api/admin/tax-summary – aggregate income, payments & expenses for a date range
// Query params: from (YYYY-MM-DD), to (YYYY-MM-DD)
router.get('/tax-summary', (req, res) => {
  const { from, to } = req.query;

  if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(String(from))) {
    return res.status(400).json({ error: 'from is required and must be a valid date (YYYY-MM-DD).' });
  }
  if (!to || !/^\d{4}-\d{2}-\d{2}$/.test(String(to))) {
    return res.status(400).json({ error: 'to is required and must be a valid date (YYYY-MM-DD).' });
  }

  // Invoices issued in period (accrual / turnover basis)
  const invoices = db.prepare(`
    SELECT i.id, i.invoice_num, i.amount, i.issued_date, i.paid, i.paid_date, i.notes,
           c.name AS client_name, c.company AS client_company
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    WHERE i.issued_date >= ? AND i.issued_date <= ?
    ORDER BY i.issued_date ASC, i.id ASC
  `).all(String(from), String(to));

  // Payments received in period (cash basis – invoices paid in this period)
  const payments = db.prepare(`
    SELECT i.id, i.invoice_num, i.amount, i.issued_date, i.paid_date, i.notes,
           c.name AS client_name, c.company AS client_company
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    WHERE i.paid = 1 AND i.paid_date >= ? AND i.paid_date <= ?
    ORDER BY i.paid_date ASC, i.id ASC
  `).all(String(from), String(to));

  // Expenses in period
  const expenses = db.prepare(`
    SELECT * FROM expenses
    WHERE expense_date >= ? AND expense_date <= ?
    ORDER BY expense_date ASC, id ASC
  `).all(String(from), String(to));

  const totalInvoiced  = invoices.reduce((s, r) => s + r.amount, 0);
  const totalReceived  = payments.reduce((s, r) => s + r.amount, 0);
  const totalExpenses  = expenses.reduce((s, r) => s + r.amount, 0);
  const netProfit      = totalReceived - totalExpenses;

  // Expense breakdown by category
  const expenseByCategory = {};
  for (const e of expenses) {
    expenseByCategory[e.category] = (expenseByCategory[e.category] || 0) + e.amount;
  }

  return res.json({
    period: { from, to },
    summary: {
      total_invoiced:  totalInvoiced,
      total_received:  totalReceived,
      total_expenses:  totalExpenses,
      net_profit:      netProfit,
    },
    expense_by_category: expenseByCategory,
    invoices,
    payments,
    expenses,
  });
});

module.exports = router;
