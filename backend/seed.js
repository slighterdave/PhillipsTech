#!/usr/bin/env node
/**
 * seed.js – Create (or update) the admin user.
 *
 * Usage:
 *   node seed.js <email> <password>
 *
 * Example:
 *   node seed.js admin@phillipstech.info SecureP@ssw0rd!
 *
 * Run this once after first deployment to set your admin credentials.
 * You can also re-run it to change the password.
 */
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const bcrypt = require('bcryptjs');
const db = require('./database');

const [, , email, password] = process.argv;

if (!email || !password) {
  console.error('Usage: node seed.js <email> <password>');
  process.exit(1);
}

const emailNorm = email.trim().toLowerCase();
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(emailNorm)) {
  console.error('Please provide a valid email address.');
  process.exit(1);
}

if (password.length < 8) {
  console.error('Password must be at least 8 characters long.');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 12);

const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
if (existing) {
  db.prepare('UPDATE users SET password = ? WHERE email = ?').run(hash, emailNorm);
  console.log(`Admin password updated for ${emailNorm}.`);
} else {
  db.prepare('INSERT INTO users (email, password) VALUES (?, ?)').run(emailNorm, hash);
  console.log(`Admin user created: ${emailNorm}`);
}
