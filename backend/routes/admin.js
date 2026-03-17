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
     .text('PhillipsTech  •  info@phillipstech.co.uk',
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

  db.prepare(`UPDATE clients SET last_invoice_date = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(todayStr, client.id);

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
  const mailOptions = {
    from: `PhillipsTech <${gmailUser}>`,
    to: client.email,
    subject: `Invoice ${invoiceNum} from PhillipsTech`,
    text: `Dear ${recipientName},\n\nPlease find your invoice ${invoiceNum} attached.\n\nPayment is due within 14 days. Thank you for your business.\n\nKind regards,\nPhillipsTech`,
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

  return res.json({ success: true, invoiceNum, sentTo: client.email });
});

// DELETE /api/admin/clients/:id – delete a client
router.delete('/clients/:id', (req, res) => {
  const result = db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Client not found.' });
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

module.exports = router;
