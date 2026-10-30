// Formatting helpers shared by the report and the manual (Word documents built with docx).
const fs = require('fs');
const path = require('path');
const {
  Paragraph, TextRun, ImageRun, Table, TableRow, TableCell, Footer, HeadingLevel, AlignmentType,
  WidthType, ShadingType, BorderStyle, PageNumber, LevelFormat,
} = require('docx');

const COLOR = { primary: '0B6AA2', accent: 'C2410C', muted: '62677D', rowAlt: 'F1F6FA', code: 'F4F5F8', border: 'DCDDE8', tip: 'E2F0F9', warn: 'FDF1E4' };
const PORTRAIT_W = 9026;   // A4 width minus 2 × 1" margins, in DXA
const LANDSCAPE_W = 13958;
const PX_PER_DXA = 96 / 1440;

// Inline markup: **bold**, `code`, [[placeholder]] (highlighted for the team to fill in)
function runs(text, base = {}) {
  return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`|\[\[[^\]]+\]\])/).filter(Boolean).map((part) => {
    if (part.startsWith('**')) return new TextRun({ ...base, text: part.slice(2, -2), bold: true });
    if (part.startsWith('`')) return new TextRun({ ...base, text: part.slice(1, -1), font: 'Consolas', size: (base.size || 22) - 2 });
    if (part.startsWith('[[')) return new TextRun({ ...base, text: `[${part.slice(2, -2)}]`, highlight: 'yellow' });
    return new TextRun({ ...base, text: part });
  });
}
const p = (text, opts = {}) => new Paragraph({ children: runs(text, opts.run), spacing: { after: 120, line: 276 }, ...opts.para });
const h1 = (text, pageBreak = true) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(text)], pageBreakBefore: pageBreak });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(text)] });
const h3 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun(text)] });
const spacer = () => new Paragraph({ children: [], spacing: { after: 120 } });

const bullets = (items) => items.map((t) => new Paragraph({ children: runs(t), numbering: { reference: 'bullets', level: 0 }, spacing: { after: 60, line: 264 } }));
let listInstance = 0;
// Numbered list. Pass the same instance to continue a list after a code box.
const newList = () => ++listInstance;
const numbered = (items, instance = newList()) => items.map((t) => new Paragraph({ children: runs(t), numbering: { reference: 'numbers', level: 0, instance }, spacing: { after: 80, line: 264 } }));

function box(text, kind = 'tip') {
  const [fill, color, label] = kind === 'warn' ? [COLOR.warn, COLOR.accent, 'Important: ']
    : kind === 'note' ? [COLOR.tip, COLOR.primary, ''] : [COLOR.tip, COLOR.primary, 'Tip: '];
  return new Paragraph({
    children: [...(label ? [new TextRun({ text: label, bold: true, color })] : []), ...runs(text)],
    spacing: { before: 120, after: 200, line: 264 },
    shading: { type: ShadingType.CLEAR, color: 'auto', fill },
    border: { left: { style: BorderStyle.SINGLE, size: 18, color, space: 8 } },
    indent: { left: 160, right: 160 },
  });
}

// A command to type, in a grey box.
function command(...lines) {
  return lines.map((line, i) => new Paragraph({
    children: [new TextRun({ text: line, font: 'Consolas', size: 19 })],
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.code },
    spacing: { before: i === 0 ? 80 : 0, after: i === lines.length - 1 ? 160 : 0, line: 260 },
    indent: { left: 360, right: 160 },
  }));
}

// A block of source code (small monospace, shaded).
function code(text) {
  return text.replace(/\r/g, '').replace(/^﻿/, '').replace(/\n+$/, '').split('\n').map((line) => new Paragraph({
    children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 15 })],
    shading: { type: ShadingType.CLEAR, color: 'auto', fill: COLOR.code },
    spacing: { after: 0, line: 228 },
    indent: { left: 120, right: 120 },
  }));
}

// Header colours can be changed through COLOR.headerFill / COLOR.headerText (e.g. a black-and-white document).
function table(headers, rows, fractions, { width = PORTRAIT_W, size = 18 } = {}) {
  const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: COLOR.border };
  const widths = fractions.map((f) => Math.round(width * f));
  widths[widths.length - 1] = width - widths.slice(0, -1).reduce((a, b) => a + b, 0);
  const cell = (content, i, header, fill) => new TableCell({
    width: { size: widths[i], type: WidthType.DXA },
    shading: fill ? { type: ShadingType.CLEAR, color: 'auto', fill } : undefined,
    margins: { top: 50, bottom: 50, left: 90, right: 90 },
    children: String(content ?? '').split('\n').map((line) => new Paragraph({
      children: runs(line, header ? { bold: true, color: COLOR.headerText || 'FFFFFF', size } : { size }),
      spacing: { after: 0, line: 252 },
    })),
  });
  return new Table({
    width: { size: width, type: WidthType.DXA },
    columnWidths: widths,
    borders: { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder, insideHorizontal: cellBorder, insideVertical: cellBorder },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, i, true, COLOR.headerFill || COLOR.primary)) }),
      ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, i, false, ri % 2 ? COLOR.rowAlt : undefined)) })),
    ],
  });
}

// Image + numbered caption, scaled to fit.
function makeFigure(root) {
  let n = 0;
  const figure = (relFile, caption, maxWidthDxa = PORTRAIT_W, maxHeightPx = 9999) => {
    const buf = fs.readFileSync(path.join(root, relFile));
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    let width = maxWidthDxa * PX_PER_DXA;
    let height = width * h / w;
    if (height > maxHeightPx) { height = maxHeightPx; width = height * w / h; }
    n++;
    return [
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 }, keepNext: true,
        children: [new ImageRun({ type: 'png', data: buf, transformation: { width: Math.round(width), height: Math.round(height) } })] }),
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 },
        children: runs(`Figure ${n}: ${caption}`, { italics: true, size: 18, color: COLOR.muted }) }),
    ];
  };
  figure.count = () => n;
  return figure;
}

function documentStyles() {
  return {
    styles: {
      default: { document: { run: { font: 'Calibri', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: 'Cambria', size: 34, bold: true, color: COLOR.primary }, paragraph: { spacing: { before: 240, after: 200 }, outlineLevel: 0, keepNext: true } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: 'Cambria', size: 26, bold: true, color: '1C1F2E' }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1, keepNext: true } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
          run: { font: 'Calibri', size: 23, bold: true, color: COLOR.primary }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2, keepNext: true } },
      ],
    },
    numbering: { config: [
      { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] },
      { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 320 } } } }] },
    ] },
  };
}

function footer(text) {
  return new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [
    new TextRun({ text: `${text} · Page `, size: 16, color: COLOR.muted }),
    new TextRun({ children: [PageNumber.CURRENT], size: 16, color: COLOR.muted }),
  ] })] });
}

module.exports = {
  COLOR, PORTRAIT_W, LANDSCAPE_W, runs, p, h1, h2, h3, spacer, bullets, numbered, newList,
  box, command, code, table, makeFigure, documentStyles, footer,
};
