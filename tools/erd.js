// Draws the crow's-foot ERD of the Campus Laundry database, in black and white.
// Tables, columns, types, keys and relationships are read from information_schema, so the
// diagram always matches what is built. The ELK layout engine places the tables and routes
// the relationship lines (parents above their children).
//
// Usage: node tools/erd.js
// Writes docs/erd/laundry-erd-physical.{svg,png} and docs/erd/laundry-erd-conceptual.{svg,png}
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const ELK = require('elkjs/lib/elk.bundled.js');
const pool = require('../db/pool');
const { renderToPng } = require('./render');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'erd');
const DB = process.env.DB_NAME || 'campus_laundry';
const SCHEMA_VERSION = require('../package.json').version.split('.').slice(0, 2).join('.');

// Tables added during design to meet the requirements (the others come straight from them).
const EXTENSION_TABLES = ['laundry_rooms', 'waitlist_entries', 'machine_outages'];

// Verb phrase for each foreign key, read parent -> child.
const LABELS = {
  fk_users_room: 'is home room of',
  fk_machines_room: 'contains',
  fk_bookings_machine: 'is booked in',
  fk_bookings_user: 'makes',
  fk_notifications_user: 'receives',
  fk_notifications_booking: 'triggers',
  fk_waitlist_entries_user: 'joins',
  fk_waitlist_entries_room: 'has waiting list',
  fk_machine_outages_machine: 'has outages',
  fk_machine_outages_reported_by: 'reports',
  fk_laundry_tips_created_by: 'writes',
  fk_feedback_user: 'gives',
  fk_feedback_room: 'receives',
  fk_feedback_machine: 'is rated in',
  fk_feedback_responded_by: 'responds to',
};

// Black and white only: core tables have a black header, extension tables a grey one.
const C = { line: '#000000', text: '#000000', muted: '#555555', core: '#1a1a1a', ext: '#d0d0d0', rowAlt: '#f2f2f2', labelBorder: '#999999' };

async function readSchema() {
  const [columns] = await pool.query(`
    SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE = 'YES' AS nullable, COLUMN_KEY AS col_key,
           EXTRA IN ('STORED GENERATED', 'VIRTUAL GENERATED') AS is_generated
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> 'schema_migrations'
    ORDER BY TABLE_NAME, ORDINAL_POSITION`, [DB]);
  const [fks] = await pool.query(`
    SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS child, k.COLUMN_NAME AS col,
           k.REFERENCED_TABLE_NAME AS parent, r.DELETE_RULE AS on_delete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = ? ORDER BY k.CONSTRAINT_NAME`, [DB]);
  const [uniques] = await pool.query(`
    SELECT s.TABLE_NAME AS tbl, s.COLUMN_NAME AS col,
           (SELECT COUNT(*) FROM information_schema.STATISTICS s2
            WHERE s2.TABLE_SCHEMA = s.TABLE_SCHEMA AND s2.TABLE_NAME = s.TABLE_NAME AND s2.INDEX_NAME = s.INDEX_NAME) AS size
    FROM information_schema.STATISTICS s
    WHERE s.TABLE_SCHEMA = ? AND s.NON_UNIQUE = 0 AND s.INDEX_NAME <> 'PRIMARY'`, [DB]);

  const tables = {};
  for (const c of columns) {
    (tables[c.tbl] ||= { name: c.tbl, columns: [] }).columns.push({
      name: c.name,
      type: c.type.startsWith('enum') ? 'enum' : c.type.replace('tinyint(1)', 'boolean'),
      nullable: !!c.nullable,
      generated: !!c.is_generated,
      pk: c.col_key === 'PRI',
      fk: fks.some((f) => f.child === c.tbl && f.col === c.name),
      uq: uniques.some((u) => u.tbl === c.tbl && u.col === c.name && u.size === 1),
      uc: uniques.some((u) => u.tbl === c.tbl && u.col === c.name && u.size > 1),
    });
  }
  return { tables, fks };
}

// ELK reserves room for a label next to its line; move it onto the line so it clearly belongs
// to that relationship. Positions are tried along each segment; the nearest free one wins.
function snapToLine(l, pts, placed) {
  const cx = l.x + l.width / 2;
  const cy = l.y + l.height / 2;
  const overlaps = (x, y) => placed.some((o) => Math.abs(o.x - x) < (o.w + l.width) / 2 + 4 && Math.abs(o.y - y) < (o.h + l.height) / 2 + 3);
  let best = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const [[x1, y1], [x2, y2]] = [pts[i], pts[i + 1]];
    const vertical = x1 === x2;
    const half = vertical ? l.height / 2 + 12 : l.width / 2 + 12;
    const lo = vertical ? Math.min(y1, y2) + half : Math.min(x1, x2) + half;
    const hi = vertical ? Math.max(y1, y2) - half : Math.max(x1, x2) - half;
    if (hi < lo) continue;
    const base = Math.min(Math.max(vertical ? cy : cx, lo), hi);
    for (let k = 0; k <= 16; k++) {
      const along = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 22;
      if (along < lo || along > hi) continue;
      const px = vertical ? x1 : along;
      const py = vertical ? along : y1;
      const d = Math.hypot(px - cx, py - cy) + (overlaps(px, py) ? 100000 : 0);
      if (!best || d < best.d) best = { d, px, py };
    }
  }
  if (best) { l.x = best.px - l.width / 2; l.y = best.py - l.height / 2; }
  placed.push({ x: l.x + l.width / 2, y: l.y + l.height / 2, w: l.width, h: l.height });
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const labelWidth = (text) => text.length * 6.4 + 12;

async function build({ tables, fks }, detailed) {
  const BOX_W = detailed ? 268 : 210;
  const HEAD = detailed ? 34 : 46;
  const ROW = 21;
  const heightOf = (t) => (detailed ? HEAD + t.columns.length * ROW + 6 : HEAD);

  const missing = fks.filter((f) => !LABELS[f.name]).map((f) => f.name);
  if (missing.length) throw new Error(`No label for foreign key(s): ${missing.join(', ')}`);
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': detailed ? '70' : '60',
      'elk.spacing.nodeNode': detailed ? '46' : '40',
      'elk.spacing.edgeEdge': '18',
      'elk.spacing.edgeNode': '22',
      'elk.layered.spacing.edgeNodeBetweenLayers': '22',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.spacing.edgeLabel': '4',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=30,left=30,bottom=30,right=30]',
    },
    children: Object.values(tables).map((t) => ({ id: t.name, width: BOX_W, height: heightOf(t) })),
    edges: fks.map((f) => ({
      id: f.name, sources: [f.parent], targets: [f.child],
      labels: [{ id: `${f.name}_label`, text: LABELS[f.name], width: labelWidth(LABELS[f.name]), height: 18 }],
    })),
  };
  const laid = await new ELK().layout(graph);

  const out = [];
  const markerLines = [];
  // Crow's-foot ends: two bars = exactly one; bar + circle = zero or one; fork + circle = zero or many.
  function marker([x, y], [dx, dy], kind) {
    const px = -dy, py = dx;
    const at = (d) => [x + dx * d, y + dy * d];
    const bar = (d) => { const [cx, cy] = at(d); markerLines.push(`<line x1="${cx + px * 7}" y1="${cy + py * 7}" x2="${cx - px * 7}" y2="${cy - py * 7}"/>`); };
    const circle = (d) => { const [cx, cy] = at(d); markerLines.push(`<circle cx="${cx}" cy="${cy}" r="4.5" fill="#fff"/>`); };
    if (kind === 'one') { bar(7); bar(13); }
    if (kind === 'zeroOrOne') { bar(7); circle(17); }
    if (kind === 'many') {
      const [tx, ty] = at(15);
      markerLines.push(`<line x1="${tx}" y1="${ty}" x2="${x + px * 8}" y2="${y + py * 8}"/>`);
      markerLines.push(`<line x1="${tx}" y1="${ty}" x2="${x}" y2="${y}"/>`);
      markerLines.push(`<line x1="${tx}" y1="${ty}" x2="${x - px * 8}" y2="${y - py * 8}"/>`);
      circle(21);
    }
  }
  const unit = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1]; const l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };

  const lines = [];
  const labels = [];
  const placed = [];
  for (const e of laid.edges) {
    const fk = fks.find((f) => f.name === e.id);
    const s = e.sections[0];
    const pts = [[s.startPoint.x, s.startPoint.y], ...(s.bendPoints || []).map((b) => [b.x, b.y]), [s.endPoint.x, s.endPoint.y]];
    lines.push(`<polyline points="${pts.map((pt) => pt.join(',')).join(' ')}" fill="none" stroke="${C.line}" stroke-width="1.4"/>`);
    const optionalParent = tables[fk.child].columns.find((c) => c.name === fk.col).nullable;
    marker(pts[0], unit(pts[0], pts[1]), optionalParent ? 'zeroOrOne' : 'one');
    marker(pts[pts.length - 1], unit(pts[pts.length - 1], pts[pts.length - 2]), 'many');
    for (const l of e.labels || []) {
      snapToLine(l, pts, placed);
      labels.push(`<rect x="${l.x}" y="${l.y}" width="${l.width}" height="${l.height}" rx="3" fill="#ffffff" stroke="${C.labelBorder}"/>` +
        `<text x="${l.x + l.width / 2}" y="${l.y + 13}" text-anchor="middle" font-size="11.5" font-style="italic" fill="${C.text}">${esc(l.text)}</text>`);
    }
  }
  out.push(...lines);
  out.push(`<g stroke="${C.line}" stroke-width="1.4" fill="none">${markerLines.join('')}</g>`);

  for (const n of laid.children) {
    const t = tables[n.id];
    const b = { x: n.x, y: n.y, w: n.width, h: n.height };
    const ext = EXTENSION_TABLES.includes(t.name);
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#ffffff" stroke="${C.line}" stroke-width="1.4"/>`);
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${HEAD}" fill="${ext ? C.ext : C.core}" stroke="${C.line}" stroke-width="1.4"/>`);
    out.push(`<text x="${b.x + b.w / 2}" y="${b.y + (detailed ? 22 : 29)}" text-anchor="middle" font-size="${detailed ? 15 : 13.5}" font-weight="700" fill="${ext ? '#000000' : '#ffffff'}">${esc(detailed ? t.name : t.name.toUpperCase().replace(/_/g, ' '))}</text>`);
    if (detailed) {
      t.columns.forEach((c, i) => {
        const y = b.y + HEAD + i * ROW;
        if (i % 2 === 1) out.push(`<rect x="${b.x + 1}" y="${y}" width="${b.w - 2}" height="${ROW}" fill="${C.rowAlt}"/>`);
        const keys = [c.pk && 'PK', c.fk && 'FK', c.uq && !c.pk && 'UQ', c.uc && 'UC'].filter(Boolean).join(' ');
        out.push(`<text x="${b.x + 8}" y="${y + 15}" font-size="10.5" font-weight="700" fill="${C.text}">${keys}</text>`);
        out.push(`<text x="${b.x + 50}" y="${y + 15}" font-size="12.5" fill="${C.text}" ${c.pk ? 'font-weight="700" text-decoration="underline"' : ''} ${c.nullable ? 'font-style="italic"' : ''}>${esc(c.name)}</text>`);
        const type = c.generated ? `${c.type} · generated` : `${c.type}${c.nullable ? ' · null' : ''}`;
        out.push(`<text x="${b.x + b.w - 8}" y="${y + 15}" text-anchor="end" font-size="11" fill="${C.muted}">${esc(type)}</text>`);
      });
    }
  }
  out.push(...labels);

  // Title and legend along the bottom.
  const MX = 30;
  const ly = laid.height + 40;
  const legend = [];
  legend.push(`<text x="${MX}" y="${ly}" font-size="19" font-weight="700">Campus Laundry ${detailed ? 'physical' : 'conceptual'} ERD (crow's foot)</text>`);
  legend.push(`<text x="${MX}" y="${ly + 22}" fill="${C.muted}" font-size="12.5">Schema v${SCHEMA_VERSION} · read from the MySQL 8.4 database</text>`);
  const row2 = ly + 30;
  let x = MX;
  const item = (y, draw, text, w) => { legend.push(draw(x, y - 4)); legend.push(`<text x="${x + 58}" y="${y}" font-size="12.5">${text}</text>`); x += w; };
  const sample = (kind) => (lx, y) => {
    markerLines.length = 0;
    marker([lx, y], [1, 0], kind);
    marker([lx + 46, y], [-1, 0], 'many');
    return `<line x1="${lx}" y1="${y}" x2="${lx + 46}" y2="${y}" stroke="${C.line}" stroke-width="1.4"/><g stroke="${C.line}" stroke-width="1.4" fill="none">${markerLines.join('')}</g>`;
  };
  x = MX + 520;
  item(ly, (lx, y) => `<rect x="${lx}" y="${y - 8}" width="46" height="16" fill="${C.core}" stroke="#000"/>`, 'Table from the requirements', 250);
  item(ly, (lx, y) => `<rect x="${lx}" y="${y - 8}" width="46" height="16" fill="${C.ext}" stroke="#000"/>`, 'Table added in design', 220);
  x = MX + 520;
  item(row2, sample('one'), 'exactly one to zero or many', 250);
  item(row2, sample('zeroOrOne'), 'zero or one to zero or many', 260);
  let height = row2 + 30;
  if (detailed) {
    legend.push(`<text x="${MX + 520}" y="${row2 + 30}" font-size="12.5" fill="${C.muted}"><tspan font-weight="700" fill="#000">PK</tspan> primary key   <tspan font-weight="700" fill="#000">FK</tspan> foreign key   <tspan font-weight="700" fill="#000">UQ</tspan> unique   <tspan font-weight="700" fill="#000">UC</tspan> unique together with the other UC columns   <tspan font-style="italic">italic · null</tspan> = optional</text>`);
    height += 22;
  }
  out.push(`<g fill="${C.text}">${legend.join('')}</g>`);

  const width = Math.ceil(Math.max(laid.width, x + 20, detailed ? MX + 520 + 640 : 0));
  height = Math.ceil(height + 10);
  out.unshift(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Segoe UI, Arial, sans-serif"><rect width="100%" height="100%" fill="#ffffff"/>`);
  out.push('</svg>');
  return { svg: out.join('\n'), width, height };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const schema = await readSchema();
  await pool.end();
  for (const [name, detailed] of [['physical', true], ['conceptual', false]]) {
    const { svg, width, height } = await build(schema, detailed);
    const base = path.join(OUT_DIR, `laundry-erd-${name}`);
    fs.writeFileSync(`${base}.svg`, svg);
    await renderToPng(`<html><body style="margin:0">${svg}</body></html>`, `${base}.png`, width, height);
    console.log(`Wrote ${base}.svg and .png (${width}x${height})`);
  }
  console.log(`${Object.keys(schema.tables).length} tables, ${schema.fks.length} relationships read from "${DB}".`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
