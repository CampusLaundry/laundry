// Creates the database if needed and brings its structure up to date.
//   npm run db:setup   -> apply any migrations that haven't run yet (keeps all data)
//   npm run db:reset   -> DELETE the whole database and rebuild an empty one from migration 001
//
// Migrations live in db/migrations and run in filename order. Each one is recorded in
// the schema_migrations table so it only ever runs once.
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function migrate(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(100) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  const [rows] = await conn.query('SELECT version FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.version));

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  let count = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (applied.has(version)) continue;
    console.log(`Applying migration ${version}…`);
    await conn.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [version]);
    count++;
  }
  if (count === 0) console.log('No new migrations to apply.');
}

async function main() {
  const dbName = process.env.DB_NAME || 'campus_laundry';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  if (process.argv.includes('--reset')) {
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    console.log(`Dropped database "${dbName}".`);
  }
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
  await conn.query(`USE \`${dbName}\``);
  await migrate(conn);

  const [[{ admins }]] = await conn.query("SELECT COUNT(*) AS admins FROM users WHERE role = 'admin'");
  await conn.end();
  console.log(`Database "${dbName}" is up to date.`);
  if (admins === 0) {
    console.log('There is no administrator yet. Create one with:  npm run admin:create -- "Full Name" email@example.com');
  }
}

main().catch((err) => {
  console.error('Database setup failed:', err.message);
  if (err.code === 'ECONNREFUSED') console.error('Is the MySQL service running?');
  if (err.code === 'ER_ACCESS_DENIED_ERROR') console.error('Check DB_USER and DB_PASSWORD in your .env file.');
  process.exit(1);
});
