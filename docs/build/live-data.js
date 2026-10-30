// Collects facts for the report and slides straight from the running system:
// the live database structure (information_schema), applied migrations, and the
// output of the three test tools. Nothing here is typed in by hand.
const path = require('path');
const { execFileSync } = require('child_process');
const pool = require('../../db/pool');

const ROOT = path.join(__dirname, '..', '..');
const DB = process.env.DB_NAME || 'campus_laundry';

function cleanCheck(clause) {
  return clause.replace(/_utf8mb4\\?'/g, "'").replace(/\\'/g, "'").replace(/`/g, '');
}

function runTool(script) {
  try {
    return execFileSync(process.execPath, [path.join(ROOT, 'tools', script)], { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    throw new Error(`${script} failed:\n${err.stdout || ''}${err.stderr || err.message}`);
  }
}

async function collect() {
  const [columns] = await pool.query(`
    SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable,
           COLUMN_DEFAULT AS dflt, EXTRA AS extra, COLUMN_KEY AS col_key
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
    ORDER BY TABLE_NAME, ORDINAL_POSITION`, [DB]);
  const [fks] = await pool.query(`
    SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS child, k.COLUMN_NAME AS col,
           k.REFERENCED_TABLE_NAME AS parent, k.REFERENCED_COLUMN_NAME AS parent_col, r.DELETE_RULE AS on_delete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = ? ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME`, [DB]);
  const [uniques] = await pool.query(`
    SELECT tc.TABLE_NAME AS tbl, tc.CONSTRAINT_NAME AS name,
           GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') AS cols
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.KEY_COLUMN_USAGE k
      ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
    WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'UNIQUE'
    GROUP BY tc.TABLE_NAME, tc.CONSTRAINT_NAME ORDER BY tc.TABLE_NAME`, [DB]);
  const [checks] = await pool.query(`
    SELECT tc.TABLE_NAME AS tbl, cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause
    FROM information_schema.CHECK_CONSTRAINTS cc
    JOIN information_schema.TABLE_CONSTRAINTS tc
      ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME
    WHERE cc.CONSTRAINT_SCHEMA = ? ORDER BY tc.TABLE_NAME, cc.CONSTRAINT_NAME`, [DB]);
  const [indexes] = await pool.query(`
    SELECT TABLE_NAME AS tbl, INDEX_NAME AS name, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS cols
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = ? AND NON_UNIQUE = 1
    GROUP BY TABLE_NAME, INDEX_NAME ORDER BY TABLE_NAME`, [DB]);
  const [migrations] = await pool.query('SELECT version, applied_at FROM schema_migrations ORDER BY version');
  const [[{ version }]] = await pool.query('SELECT VERSION() AS version');
  await pool.end();

  // Test tools (the API tests need the app running on localhost).
  const compare = runTool('compare-schema.js').trim();
  const constraintLines = runTool('test-constraints.js').split('\n').filter((l) => /^(PASS|FAIL) /.test(l));
  const apiLines = runTool('test-api.js').split('\n').filter((l) => /^(PASS|FAIL) /.test(l));

  return {
    mysqlVersion: version,
    tables: [...new Set(columns.map((c) => c.tbl))],
    columns, fks, uniques, indexes, migrations,
    checks: checks.map((c) => ({ ...c, clause: cleanCheck(c.clause) })),
    tests: {
      compare,
      constraints: constraintLines.map((l) => {
        const m = l.match(/^(PASS|FAIL)\s+(.*?)\s+->\s+(\S+)/);
        return { pass: m[1] === 'PASS', name: m[2], result: m[3] };
      }),
      api: apiLines.map((l) => {
        const m = l.match(/^(PASS|FAIL)\s+\[(.*?)\]\s+(.*?)(\s+\(.*\))?$/);
        return { pass: m[1] === 'PASS', area: m[2], name: m[3] };
      }),
    },
  };
}

module.exports = { collect, ROOT };
