'use strict';
require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(express.json({ limit: '16kb' }));
app.use(cors({ origin: '*', methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));

app.use('/admin', express.static(path.join(__dirname, '..', 'admin'), { extensions: ['html'] }));
app.use('/', express.static(path.join(__dirname, '..'), { extensions: ['html'] }));

app.listen(3001, '0.0.0.0', () => { console.log('Test server on :3001'); });
