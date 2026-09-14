/**
 * Builds docs/cleaner-manual.docx — the same guide as the PDF, in Word, for
 * anyone who wants to change the wording without touching code.
 *
 *   npm i docx
 *   node docs/tools/build-docx.mjs
 *
 * The words come from content.mjs and the pictures from docs/manual/, both
 * shared with the PDF.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType, BorderStyle, Document, HeadingLevel, ImageRun, LevelFormat,
  PageBreak, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { CONTACTS, COVER, PAGES, SUBTITLE, TITLE } from './content.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '..');
const SHOTS = path.join(DOCS, 'manual');

const INK = '16191F';
const GREY = '5C6470';

// Every screenshot is a 1170x2532 phone screen, so one ratio covers them all.
const PHONE_RATIO = 2532 / 1170;

const shot = (name, width) => new ImageRun({
  type: 'png',
  data: fs.readFileSync(path.join(SHOTS, `${name}.png`)),
  transformation: { width, height: Math.round(width * PHONE_RATIO) },
});

const caption = (text) => new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { before: 60, after: 200 },
  children: [new TextRun({ text, size: 18, color: GREY })],
});

const noBorders = () => {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return {
    top: none, bottom: none, left: none, right: none,
    insideHorizontal: none, insideVertical: none,
  };
};

/** One screenshot, or two side by side in a table with no visible lines. */
const images = (list) => {
  if (list.length === 1) {
    const [name, text] = list[0];
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120 },
        children: [shot(name, 255)],
      }),
      caption(text),
    ];
  }

  const cell = ([name, text]) => new TableCell({
    width: { size: 4390, type: WidthType.DXA },
    margins: { top: 80, bottom: 80, left: 80, right: 80 },
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [shot(name, 200)] }),
      caption(text),
    ],
  });

  return [new Table({
    width: { size: 8780, type: WidthType.DXA },
    columnWidths: [4390, 4390],
    borders: noBorders(),
    rows: [new TableRow({ children: list.map(cell) })],
  })];
};

/**
 * Each page's steps take their own numbering instance. Sharing one would make
 * Word treat every list in the guide as a single list counting to twelve.
 */
let listSeq = 0;
const steps = (list) => {
  const instance = ++listSeq;
  return list.map((text) => new Paragraph({
    numbering: { reference: 'steps', level: 0, instance },
    spacing: { after: 160 },
    children: [new TextRun({ text, size: 28 })],
  }));
};

const contacts = () => new Table({
  width: { size: 8780, type: WidthType.DXA },
  columnWidths: [4390, 4390],
  borders: noBorders(),
  rows: [new TableRow({
    children: CONTACTS.map(([label, number]) => new TableCell({
      width: { size: 4390, type: WidthType.DXA },
      margins: { top: 120, bottom: 120, left: 0, right: 120 },
      children: [new Paragraph({
        children: [
          new TextRun({ text: `${label}  `, color: GREY }),
          new TextRun({ text: number, bold: true, size: 30 }),
        ],
      })],
    })),
  })],
});

/* The front page. */
const children = [
  new Paragraph({
    spacing: { after: 240 },
    children: [new ImageRun({
      type: 'png',
      data: fs.readFileSync(path.join(SHOTS, 'icon.png')),
      transformation: { width: 68, height: 68 },
    })],
  }),
  new Paragraph({
    spacing: { after: 60 },
    children: [new TextRun({ text: COVER.kicker, size: 24, color: GREY })],
  }),
  new Paragraph({
    spacing: { after: 80 },
    children: [new TextRun({ text: TITLE, bold: true, size: 72 })],
  }),
  new Paragraph({
    spacing: { after: 240 },
    children: [new TextRun({ text: SUBTITLE, size: 34, color: GREY })],
  }),
  new Paragraph({
    spacing: { after: 360 },
    children: [new TextRun({ text: COVER.blurb, size: 28 })],
  }),
  // A line to write the address on. Drawn as a paragraph border, because Word
  // collapses the underlined run of spaces you would otherwise use.
  new Paragraph({
    spacing: { after: 40 },
    children: [new TextRun({ text: 'The app is at:' })],
  }),
  new Paragraph({
    spacing: { after: 400 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '9AA3B0' } },
    children: [new TextRun({ text: ' ' })],
  }),
  new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text: COVER.inside, size: 22, color: GREY })],
  }),
  ...steps(PAGES.map((p) => p.title)),
  contacts(),
];

PAGES.forEach((page) => {
  children.push(new Paragraph({ children: [new PageBreak()] }));
  children.push(new Paragraph({ text: page.title, heading: HeadingLevel.HEADING_1 }));
  children.push(...steps(page.steps));
  children.push(...images(page.images));

  if (page.note) {
    children.push(new Paragraph({
      spacing: { before: 160, after: 160 },
      children: [new TextRun({ text: page.note, color: GREY })],
    }));
  }

  if (page.contacts) children.push(contacts());
});

const doc = new Document({
  creator: 'Woodhouse Basecamp',
  title: TITLE,
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 24, color: INK } },
      heading1: {
        run: { font: 'Calibri', size: 52, bold: true, color: INK },
        paragraph: { spacing: { before: 0, after: 240 } },
      },
    },
  },
  numbering: {
    config: [{
      reference: 'steps',
      levels: [{
        level: 0,
        format: LevelFormat.DECIMAL,
        text: '%1.',
        alignment: AlignmentType.START,
        style: {
          paragraph: { indent: { left: 560, hanging: 360 } },
          run: { bold: true, size: 28 },
        },
      }],
    }],
  },
  sections: [{
    properties: { page: { margin: { top: 1240, bottom: 1240, left: 1240, right: 1240 } } },
    children,
  }],
});

const out = path.join(DOCS, 'cleaner-manual.docx');
fs.writeFileSync(out, await Packer.toBuffer(doc));
console.log(`manual → ${out}`);
