require('dotenv').config({ quiet: true });
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'campus_laundry',
  connectionLimit: 10,
  // Opening a MySQL connection costs up to a second when several open at once, so keep
  // idle connections for 10 minutes instead of 1 (found by tools/test-load.js).
  idleTimeout: 10 * 60 * 1000,
  decimalNumbers: true, // return SUM/AVG results as numbers, not strings
  dateStrings: ['DATE'], // plain dates stay 'YYYY-MM-DD' (no time-zone shift)
});

// Opens all the connections up front, so the first busy moment after start-up is fast.
pool.warmUp = () => Promise.all(Array.from({ length: 10 }, () => pool.query('SELECT 1')));

module.exports = pool;
