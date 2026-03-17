'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Auto-generate and persist JWT_SECRET if it is not already configured.
// This allows the server to start without a pre-existing .env file.
if (!process.env.JWT_SECRET) {
  const crypto = require('crypto');
  const fs = require('fs');
  const envPath = path.join(__dirname, '.env');

  const SECRET_BYTES = 64; // 128 hex characters
  const generated = crypto.randomBytes(SECRET_BYTES).toString('hex');

  try {
    let envContent = '';
    try { envContent = fs.readFileSync(envPath, 'utf8'); } catch { /* file doesn't exist yet */ }

    // Replace the first JWT_SECRET= line, or append one if absent
    if (/^JWT_SECRET=/m.test(envContent)) {
      envContent = envContent.replace(/^JWT_SECRET=[^\n]*/m, `JWT_SECRET=${generated}`);
    } else {
      envContent += (envContent.length && !envContent.endsWith('\n') ? '\n' : '') + `JWT_SECRET=${generated}\n`;
    }

    fs.writeFileSync(envPath, envContent, { mode: 0o600 });
    // Ensure permissions are 600 even when the file already existed
    fs.chmodSync(envPath, 0o600);
    console.log('INFO: JWT_SECRET was not set – a random secret has been generated and saved to backend/.env');
  } catch (err) {
    console.warn(`WARNING: Could not write JWT_SECRET to .env (${err.message}). ` +
      'Using an in-memory secret for this session only; all tokens will be invalidated on the next restart.');
  }

  process.env.JWT_SECRET = generated;
}

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Middleware ─────────────────────────────────────────────────────────────

// Only allow requests from the configured origin (or same-origin in production)
const allowedOrigin = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
app.use(cors({
  origin: allowedOrigin,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '16kb' }));

// ── Routes ─────────────────────────────────────────────────────────────────

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/contact', require('./routes/contact'));

// Redirect bare /admin and /admin/ to the login page
app.get(['/admin', '/admin/'], (req, res) => {
  res.redirect('/admin/login');
});

// Serve the admin portal static files
// extensions: ['html'] allows /admin/login to resolve to login.html
app.use('/admin', express.static(path.join(__dirname, '..', 'admin'), { extensions: ['html'] }));

// ── Global error handler ───────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`PhillipsTech backend listening on 127.0.0.1:${PORT}`);
});

module.exports = app;
