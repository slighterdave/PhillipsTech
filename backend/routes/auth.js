'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../database');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = process.env.TOKEN_TTL || '24h';

// Strict rate limit on login – 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' },
});

// POST /api/auth/login
router.post('/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());

  // Constant-time comparison to prevent user enumeration
  const dummyHash = '$2a$10$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const hashToCheck = user ? user.password : dummyHash;
  const match = bcrypt.compareSync(password, hashToCheck);

  if (!user || !match) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }

  const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  return res.json({ token });
});

// 60 verify checks per 15 minutes per IP
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});

// GET /api/auth/verify  – lightweight token health-check
router.get('/verify', verifyLimiter, (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ valid: false });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET);
    return res.json({ valid: true, email: payload.email });
  } catch {
    return res.status(401).json({ valid: false });
  }
});

module.exports = router;
