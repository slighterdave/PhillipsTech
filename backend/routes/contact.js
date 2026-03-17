'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const db = require('../database');

const router = express.Router();

// 30 submissions per hour per IP to deter spam
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// POST /api/contact
router.post('/', contactLimiter, (req, res) => {
  const { name, email, message } = req.body || {};

  if (!name || typeof name !== 'string' || name.trim().length < 2) {
    return res.status(400).json({ error: 'Please provide your name (minimum 2 characters).' });
  }
  if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }
  if (!message || typeof message !== 'string' || message.trim().length < 10) {
    return res.status(400).json({ error: 'Please provide a message (minimum 10 characters).' });
  }

  db.prepare(
    'INSERT INTO contact_submissions (name, email, message) VALUES (?, ?, ?)'
  ).run(name.trim(), email.trim().toLowerCase(), message.trim());

  return res.status(201).json({ success: true, message: "Thanks! We'll be in touch soon." });
});

module.exports = router;
