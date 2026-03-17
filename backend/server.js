'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

// Fail fast if the required secret is missing
if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET environment variable is not set. Refusing to start.');
  process.exit(1);
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

// Serve the admin portal static files
app.use('/admin', express.static(path.join(__dirname, '..', 'admin')));

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
