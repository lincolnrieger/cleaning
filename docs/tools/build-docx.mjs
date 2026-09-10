/**
 * Builds docs/cleaner-manual.docx — the editable version of the cleaner's
 * guide, for anyone who wants to change the wording, the names or the phone
 * numbers without touching HTML.
 *
 *   npm i docx
 *   node docs/tools/build-docx.mjs
 *
 * It reads the same screenshots as the PDF (docs/manual/*.png), so both
 * versions show the same app. The PDF is the one to print; this one is the
 * one to edit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun,
  LevelFormat, PageBreak, PageNumber, Packer, Paragraph, ShadingType, Table,
  TableCell, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(HERE, '..');
const SHOTS = path.join(DOCS, 'manual');

const ACCENT = '1D5FD0';
const INK = '16191F';
const INK_2 = '4A5261';
const WASH = 'EEF3FD';
const LINE = 'DFE3E9';

const OFFICE = '0402 930 714';
const MAINTENANCE = '0437 316 386';

/* --------------------------------------------------------------- helpers */

// Every screenshot is a 1170x2532 phone screen, so one ratio covers them all.
const PHONE_RATIO = 2532 / 1170;

const shot = (name, width) => new ImageRun({
  type: 'png',
  data: fs.readFileSync(path.join(SHOTS, `${name}.png`)),
  transformation: { width, height: Math.round(width * PHONE_RATIO) },
});

/** A screenshot on its own line, with the caption under it. */
const figure = (name, caption, width = 240) => [
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 240, after: 60 },
    children: [shot(name, width)],
  }),
  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 240 },
    children: [new TextRun({ text: caption, size: 18, color: INK_2, italics: true })],
  }),
];

/** Two screenshots side by side, in a table with no visible lines. */
const figurePair = (left, right, width = 175) => {
  const cell = (name, caption) => new TableCell({
    width: { size: 4390, type: WidthType.DXA },
    margins: { top: 60, bottom: 60, left: 60, right: 60 },
    children: [
      new Paragraph({ alignment: AlignmentType.CENTER, children: [shot(name, width)] }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60 },
        children: [new TextRun({ text: caption, size: 18, color: INK_2, italics: true })],
      }),
    ],
  });

  return new Table({
    width: { size: 8780, type: WidthType.DXA },
    columnWidths: [4390, 4390],
    borders: noBorders(),
    rows: [new TableRow({ children: [cell(...left), cell(...right)] })],
  });
};

const noBorders = () => {
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return {
    top: none, bottom: none, left: none, right: none,
    insideHorizontal: none, insideVertical: none,
  };
};

/** The blue-washed aside used for the "worth knowing" notes. */
const note = (title, body) => new Table({
  width: { size: 8780, type: WidthType.DXA },
  columnWidths: [8780],
  borders: {
    ...noBorders(),
    left: { style: BorderStyle.SINGLE, size: 18, color: ACCENT },
  },
  rows: [new TableRow({
    children: [new TableCell({
      width: { size: 8780, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: WASH, color: 'auto' },
      margins: { top: 160, bottom: 160, left: 220, right: 220 },
      children: [
        new Paragraph({ children: [new TextRun({ text: title, bold: true })] }),
        new Paragraph({
          spacing: { before: 40 },
          children: [new TextRun({ text: body })],
        }),
      ],
    })],
  })],
});

/**
 * A numbered list of steps, each a bold opening then the rest of the sentence.
 *
 * Every call takes a new numbering instance. Sharing one would make Word treat
 * all nine lists in the guide as a single list running 1 to 29.
 */
let listSeq = 0;
const steps = (items, reference = 'steps') => {
  const instance = ++listSeq;
  return items.map(([lead, rest = '']) => new Paragraph({
    numbering: { reference, level: 0, instance },
    spacing: { after: 120 },
    children: [
      new TextRun({ text: lead, bold: true }),
      ...(rest ? [new TextRun({ text: ` ${rest}` })] : []),
    ],
  }));
};

const body = (text, opts = {}) => new Paragraph({
  spacing: { after: 140 },
  children: [new TextRun({ text, ...opts })],
});

/** Body text with a bold opening, e.g. "It remembers you. On your own…" */
const leadIn = (lead, rest) => new Paragraph({
  spacing: { after: 140 },
  children: [
    new TextRun({ text: lead, bold: true }),
    new TextRun({ text: ` ${rest}` }),
  ],
});

const kicker = (text) => new Paragraph({
  spacing: { after: 60 },
  children: [new TextRun({
    text: text.toUpperCase(), bold: true, size: 18, color: ACCENT, characterSpacing: 30,
  })],
});

const heading = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
const subhead = (text) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });

const lead = (text) => new Paragraph({
  spacing: { after: 200 },
  children: [new TextRun({ text, size: 26, color: INK_2 })],
});

const pageBreak = () => new Paragraph({ children: [new PageBreak()] });

/** Two-column table of a label and what it means. */
const glossary = (rows) => new Table({
  width: { size: 8780, type: WidthType.DXA },
  columnWidths: [2600, 6180],
  borders: {
    ...noBorders(),
    insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: LINE },
    top: { style: BorderStyle.SINGLE, size: 4, color: LINE },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE },
  },
  rows: rows.map(([label, meaning]) => new TableRow({
    children: [
      new TableCell({
        width: { size: 2600, type: WidthType.DXA },
        margins: { top: 100, bottom: 100, left: 80, right: 160 },
        verticalAlign: VerticalAlign.TOP,
        children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })] })],
      }),
      new TableCell({
        width: { size: 6180, type: WidthType.DXA },
        margins: { top: 100, bottom: 100, left: 80, right: 80 },
        children: [new Paragraph({ text: meaning })],
      }),
    ],
  })),
});

/** The two phone numbers, side by side in boxes. */
const contacts = () => {
  const cell = (label, number) => new TableCell({
    width: { size: 4390, type: WidthType.DXA },
    margins: { top: 160, bottom: 160, left: 160, right: 160 },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      left: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      right: { style: BorderStyle.SINGLE, size: 4, color: LINE },
    },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: label.toUpperCase(), size: 18, color: INK_2 })],
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60 },
        children: [new TextRun({ text: number, bold: true, size: 30 })],
      }),
    ],
  });

  return new Table({
    width: { size: 8780, type: WidthType.DXA },
    columnWidths: [4390, 4390],
    borders: noBorders(),
    rows: [new TableRow({ children: [cell('Office', OFFICE), cell('Maintenance', MAINTENANCE)] })],
  });
};

/* ------------------------------------------------------------- the pages */

const children = [
  /* ------------------------------------------------------------- cover */
  kicker('Woodhouse Basecamp'),
  new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({ text: 'The cleaning app', bold: true, size: 72 })],
  }),
  new Paragraph({
    spacing: { after: 280 },
    children: [new TextRun({
      text: 'A guide for cleaners. Five minutes to read, and then you have it.',
      size: 30,
      color: INK_2,
    })],
  }),

  body('The app does two things.'),
  ...steps([
    ['What to clean today,',
      'and which one to do first.'],
    ['It tells the office when you are done,',
      'so nobody has to ring round and ask.'],
  ]),
  body('There is nothing to tick and nothing to hand in. Clean the building, '
    + 'then press one button.'),

  new Paragraph({
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text: 'The address for the app:', color: INK_2 })],
  }),
  new Paragraph({
    spacing: { after: 60 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'B9C1CD' } },
    children: [new TextRun({ text: ' ' })],
  }),
  body('Ask the office if you do not have it.', { size: 20, color: INK_2 }),

  contacts(),
  ...figure('todays-list-plain', 'The screen a cleaner opens on.', 200),

  pageBreak(),

  /* ------------------------------------------- page 2: the whole job */
  kicker('The short version'),
  heading('The whole job, in four steps'),
  lead('If you read nothing else, read this page.'),

  ...steps([
    ['Sign in.',
      'Tap your name, then tap your PIN.'],
    ['Read today’s list.',
      'The buildings to clean are at the top, in order. '
    + 'Number 1 first.'],
    ['Clean the building.',
      'The app is not involved in this part.'],
    ['Open the building in the app and press the big blue button.',
      'That tells the office it is done.'],
  ]),

  new Paragraph({ spacing: { after: 120 }, children: [] }),
  note('Something broken, or something left behind?',
    'Press Report. The office is told straight away, and you can carry on.'),

  subhead('Two words you will see all day'),
  glossary([
    ['Check', 'The quick walk round. Is it still clean, is it stocked, is anything broken.'],
    ['Full Clean', 'The whole thing, top to bottom.'],
  ]),
  body('The office chooses which one, and the app tells you. You do not have to decide.',
    { size: 20, color: INK_2 }),

  pageBreak(),

  /* -------------------------------------------- page 3: install it */
  kicker('Step 1 · you only do this once'),
  heading('Put the app on your phone'),
  lead('It is a website, not an App Store app. Nothing to buy, nothing to update.'),

  ...steps([
    ['Open the address in your phone’s browser.',
      'The office will send you the link. Write it on the front page of this guide.'],
    ['iPhone:',
      'tap the Share button at the bottom of the screen, scroll down, '
    + 'and tap Add to Home Screen.'],
    ['Android:',
      'tap Install on the bar under the names. If you do not see it, '
    + 'open the browser’s menu and tap Install app.'],
  ]),

  new Paragraph({ spacing: { after: 120 }, children: [] }),
  note('Why bother?',
    'You get an icon on your home screen, it opens full screen with no address bar, '
    + 'and you never have to find the link again.'),

  body('You can skip this and just use the browser. Everything works the same.',
    { size: 20, color: INK_2 }),

  ...figure('sign-in-names', 'The bar under the names is the one to tap.'),

  pageBreak(),

  /* ---------------------------------------------- page 4: signing in */
  kicker('Step 2'),
  heading('Sign in'),
  lead('Two taps and a PIN. No username, nothing to type.'),

  figurePair(['sign-in-names', 'Tap your name.'], ['sign-in-pin', 'Tap your PIN.']),

  new Paragraph({ spacing: { after: 160 }, children: [] }),
  ...steps([
    ['Tap your name.',
      'Yours is usually the first one.'],
    ['Tap your PIN.',
      'It signs you in on the last number, so there is no button '
    + 'to press afterwards.'],
  ]),

  leadIn('It remembers you.', 'On your own phone you will not be asked for your PIN again.'),
  leadIn('Handing the phone back?', 'Tap the arrow in the top right corner to sign out.'),
  leadIn('Forgotten your PIN?', 'The office can set you a new one. Nobody can look up '
    + 'the old one.'),

  note('Tapped the wrong name?',
    'Tap "Not you? Pick another name" at the bottom of the keypad, and start again.'),

  pageBreak(),

  /* ------------------------------------------- page 5: today's list */
  kicker('Step 3'),
  heading('Read today’s list'),
  lead('This is the screen you start on. It answers one question: what is left to '
    + 'clean today.'),

  ...steps([
    ['Today’s date.',
      'The arrows look at other days. You can only tick off work '
    + 'on today, so come back to Today before you start.'],
    ['How many buildings are left.',
      'The bar fills up as they are signed off.'],
    ['Your hours today,',
      'if the office has rostered you on.'],
    ['The buildings to clean.',
      'They are in the order the office wants them done.'],
  ], 'key'),

  ...figure('todays-list', 'The numbers on this picture match the list above.'),

  note('The same list for everyone',
    'The plan says what needs cleaning, not who does it. Sort out between you who '
    + 'takes what, and the app keeps up.'),

  pageBreak(),

  /* ---------------------------------------------- page 6: the labels */
  kicker('Step 3 · continued'),
  heading('What the labels mean'),

  ...steps([
    ['The number and the name.',
      'Number 1 is the first job of the day. A building '
    + 'with no number is on today’s list too, it just does not have to be done in '
    + 'an order.'],
    ['Check or Full Clean.',
      'Which one the office asked for.'],
    ['A green "Done" and a time.',
      'Somebody has already finished that one. Leave it.'],
  ], 'key5'),

  new Paragraph({ spacing: { after: 120 }, children: [] }),
  glossary([
    ['Checking in today', 'Guests arrive here today. Do this one first, whatever the '
      + 'numbers say.'],
    ['Not started', 'Nobody has touched it yet.'],
    ['Done 8:42 am', 'Finished, and the time it was signed off.'],
    ['0/0', 'The number of items ticked. Our buildings have no tick list, so this stays '
      + 'at 0/0. It is not a problem.'],
    ['Group arriving 2pm', 'A note from the office about that building.'],
    ['Other buildings', 'Everything not on today’s plan. Tap it to open the list if '
      + 'you need one of them.'],
  ]),

  ...figure('todays-list-more', 'Further down the same list.'),

  pageBreak(),

  /* ------------------------------------------ page 7: marking it done */
  kicker('Step 4 · the important one'),
  heading('Mark the building done'),
  lead('Clean the building first. Then open it in the app and press the blue button.'),

  ...steps([
    ['Tap the building',
      'on today’s list.'],
    ['Tap the blue button',
      '— "Mark check complete", or "Mark full clean complete".'],
    ['Tap "Yes, all done"',
      'when it asks.'],
  ]),

  body('The app takes you straight back to your list, and that building turns green.'),

  figurePair(['building', 'Tap the building on your list.'],
    ['confirm', 'Then tap "Yes, all done".']),

  note('Our buildings have no tick list',
    'There is nothing to tick off room by room. One button is the whole job.'),

  pageBreak(),

  /* -------------------------------------------- page 8: after sign-off */
  kicker('Step 4 · continued'),
  heading('That’s it — the office can see it'),
  lead('The building now says Signed off, with your name and the time.'),

  body('The office sees the same thing on their screen the moment you press the button. '
    + 'There is no need to ring in, write anything down, or hand anything over at the '
    + 'end of the day.'),

  ...figure('signed-off', 'Green means done.', 200),

  subhead('Pressed it by mistake?'),
  body('Open the building again and tap "Reopen this check". It goes back to unfinished. '
    + 'Nothing is lost and nobody is in trouble.'),

  subhead('Two of you in the same building?'),
  body('That is fine. Whoever finishes last presses the button.'),

  subhead('Cleaned something that was not on the list?'),
  body('Open "Other buildings" at the bottom of your list, tap it, and mark it done the '
    + 'same way.'),

  note('Only today can be ticked off',
    'You can look at other days with the arrows at the top, but the button only works '
    + 'on today. If it is missing, check the top of the screen says Today.'),

  pageBreak(),

  /* ------------------------------------------------ page 9: reporting */
  kicker('When something is wrong'),
  heading('Report a problem'),
  lead('A broken tap, a blocked toilet, a light out, something left behind. Tell the '
    + 'office through the app.'),

  ...steps([
    ['Tap Report.',
      'It is the blue button in the corner of your list, and it is also '
    + 'inside every building.'],
    ['Where',
      '— in your own words. "Kitchen near the door", "Room 3, upstairs". '
    + 'You can leave it empty.'],
    ['Details',
      '— what is wrong.'],
    ['Photo',
      '— optional, but it saves a lot of questions.'],
    ['Tap Send.',
      'The office gets it straight away.'],
  ]),

  note('Use it for lost property too',
    'Anything worth telling the office about goes here. It does not have to be a fault.'),

  body('You do not have to wait for an answer, and you do not have to stop cleaning. '
    + 'Send it and carry on.'),

  figurePair(['report', 'Where, what, and a photo if you have one.'],
    ['reports-list', 'The Reports tab keeps every one of them.']),

  pageBreak(),

  /* ------------------------------------------------ page 10: the tabs */
  kicker('Getting around'),
  heading('The three buttons at the bottom'),

  new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 240 },
    children: [new ImageRun({
      type: 'png',
      data: fs.readFileSync(path.join(SHOTS, 'tabs.png')),
      transformation: { width: 560, height: Math.round(560 * (192 / 1170)) },
    })],
  }),

  subhead('Buildings'),
  body('Today’s work. This is where you spend the day.'),

  subhead('Roster'),
  body('Who is working this week, and when you are on. The office builds it; you read it.'),
  body('The tab strip at the top also has "My availability", where you say which days '
    + 'you can work. Set it once, and change it when your week changes.',
  { size: 20, color: INK_2 }),

  ...figure('roster', 'The Roster tab.', 200),

  subhead('Reports'),
  body('Everything that has been reported and not yet fixed. Worth a look before you '
    + 'ring the office about something — it may already be there.'),

  note('Lost?', 'The house icon in the top left corner takes you back to today’s '
    + 'list from anywhere.'),

  pageBreak(),

  /* --------------------------------------------------- page 11: the FAQ */
  kicker('If something looks wrong'),
  heading('Questions people ask'),

  subhead('My list is empty.'),
  body('Check the top of the screen says Today. If it does, the office has not sent this '
    + 'week’s plan out yet — the screen will say so. You can still pick any '
    + 'building from "Other buildings" and get started.'),

  subhead('It says I am not on today.'),
  body('Nobody has put you on the roster for today. If that is wrong, ring the office. '
    + 'You can still use the app.'),

  subhead('The building I cleaned already says Done.'),
  body('Somebody else got there first. The name and time are on the building’s own '
    + 'screen.'),

  subhead('I marked the wrong building.'),
  body('Open it and tap "Reopen this check", then go and mark the right one.'),

  subhead('There is no signal down there.'),
  body('The app opens without signal, but it needs signal to load the day’s list and '
    + 'to save that a building is done. Walk back to where you have bars and press the '
    + 'button then. Nothing is lost.'),

  subhead('It is stuck on "Loading".'),
  body('Give it a few seconds — the first load of the morning is the slow one. If it '
    + 'stays there, it will offer you "Try again" and "Reset and reload". Try both, in '
    + 'that order.'),

  subhead('Do I have to tick anything off?'),
  body('No. Our buildings have no tick lists. Clean it, press the button.'),

  subhead('I have a new phone.'),
  body('Open the address again, tap your name, tap your PIN. Everything is there.'),

  note('Still stuck?', `Ring the office on ${OFFICE}. Nothing in the app can be broken `
    + 'by pressing the wrong thing.'),

  pageBreak(),

  /* ------------------------------------------------ page 12: the card */
  kicker('Cut this out'),
  heading('The short version, for the wall'),
  lead('Pin it up in the cleaning cupboard, or fold it into a pocket.'),

  new Table({
    width: { size: 8780, type: WidthType.DXA },
    columnWidths: [8780],
    borders: {
      top: { style: BorderStyle.DASHED, size: 8, color: 'B9C1CD' },
      bottom: { style: BorderStyle.DASHED, size: 8, color: 'B9C1CD' },
      left: { style: BorderStyle.DASHED, size: 8, color: 'B9C1CD' },
      right: { style: BorderStyle.DASHED, size: 8, color: 'B9C1CD' },
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
    },
    rows: [new TableRow({
      children: [new TableCell({
        width: { size: 8780, type: WidthType.DXA },
        margins: { top: 400, bottom: 400, left: 400, right: 400 },
        children: [
          new Paragraph({
            spacing: { after: 240 },
            children: [new TextRun({
              text: 'Woodhouse cleaning app — the whole job', bold: true, size: 34,
            })],
          }),
          ...steps([
    ['Tap your name, tap your PIN.'],
    ['Clean the buildings on today’s list,',
      'starting at number 1.'],
    ['Open each one and press the blue button',
      'when it is finished.'],
  ], 'card'),
          new Paragraph({
            spacing: { before: 200, after: 240 },
            children: [
              new TextRun({ text: 'Something broken or left behind? Press ' }),
              new TextRun({ text: 'Report', bold: true }),
              new TextRun({ text: '.' }),
            ],
          }),
          contacts(),
        ],
      })],
    })],
  }),
];

/* ------------------------------------------------------- the document */

// Word merges two tables that touch into one, which hands the second table the
// first one's borders — the blue edge of a note bleeding onto a pair of
// screenshots. An empty paragraph between them keeps them apart.
const spaced = [];
for (const el of children) {
  if (el instanceof Table && spaced.at(-1) instanceof Table) {
    spaced.push(new Paragraph({ spacing: { after: 80 }, children: [] }));
  }
  spaced.push(el);
}

// `start` is what lets the key on the "what the labels mean" page run 5, 6, 7,
// matching the blue circles printed on the screenshot beside it.
const numberedList = (reference, start = 1) => ({
  reference,
  levels: [{
    level: 0,
    start,
    format: LevelFormat.DECIMAL,
    text: '%1.',
    alignment: AlignmentType.START,
    style: {
      paragraph: { indent: { left: 480, hanging: 320 } },
      run: { bold: true, color: ACCENT },
    },
  }],
});

const doc = new Document({
  creator: 'Woodhouse Basecamp',
  title: 'The cleaning app — a guide for cleaners',
  description: 'How to use the Woodhouse cleaning tracker.',
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 24, color: INK } },
      heading1: {
        run: { font: 'Calibri', size: 44, bold: true, color: INK },
        paragraph: { spacing: { before: 80, after: 160 } },
      },
      heading2: {
        run: { font: 'Calibri', size: 28, bold: true, color: INK },
        paragraph: { spacing: { before: 280, after: 100 } },
      },
    },
  },
  numbering: {
    config: [
      numberedList('steps'),
      numberedList('key'),
      numberedList('key5', 5),
      numberedList('card'),
    ],
  },
  sections: [{
    properties: {
      page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } },
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: LINE } },
          children: [
            new TextRun({
              text: 'Woodhouse Cleaning — cleaner’s guide          ',
              size: 16,
              color: '8B93A1',
            }),
            new TextRun({ children: [PageNumber.CURRENT], size: 16, color: '8B93A1' }),
          ],
        })],
      }),
    },
    children: spaced,
  }],
});

const out = path.join(DOCS, 'cleaner-manual.docx');
fs.writeFileSync(out, await Packer.toBuffer(doc));
console.log(`manual → ${out}`);
