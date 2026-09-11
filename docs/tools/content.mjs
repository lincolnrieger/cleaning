/**
 * The words in the cleaner's guide. Both the PDF and the Word version are
 * built from this file, so there is one place to change the wording and no
 * way for the two to end up saying different things.
 *
 * Short sentences, small words, one job per page. A cleaner reads this once,
 * standing up, on their first morning.
 */

export const TITLE = 'The cleaning app';
export const SUBTITLE = 'How to use it';

export const CONTACTS = [
  ['Office', '0402 930 714'],
  ['Maintenance', '0437 316 386'],
];

export const PAGES = [
  {
    title: 'Logging in',
    // Only the first page carries the site address, which differs per camp and
    // is written in by hand.
    address: true,
    steps: [
      'Open the app on your phone.',
      'Tap your name.',
      'Tap your PIN. The last number logs you in.',
    ],
    images: [
      ['sign-in-names', 'Tap your name.'],
      ['sign-in-pin', 'Then tap your PIN.'],
    ],
    note: 'You only do this once. The app remembers you next time.',
  },

  {
    title: 'What to clean today',
    steps: [
      'The app opens on today’s list.',
      'Start at number 1 and work down.',
      'Tap a building to open it.',
    ],
    images: [
      ['todays-list-plain', 'Today’s list.'],
    ],
    note: 'Check means a quick tidy and re-stock. Full Clean means the whole '
      + 'clean. A green Done means someone has already finished that building.',
  },

  {
    title: 'When you finish a building',
    steps: [
      'Tap the blue button.',
      'Tap Yes, all done.',
      'That is it. The office can see it is finished.',
    ],
    images: [
      ['building', 'Tap the blue button.'],
      ['confirm', 'Then tap Yes, all done.'],
    ],
    note: 'There is nothing to tick and nothing to hand in. Tapped it by '
      + 'mistake? Open the building again and tap Reopen.',
  },

  {
    title: 'If something is broken',
    steps: [
      'Tap Report.',
      'Say where it is and what is wrong.',
      'Tap Send.',
    ],
    images: [
      ['report', 'The report form.'],
    ],
    note: 'Use it for lost property too. The office sees it straight away. '
      + 'You do not have to wait for an answer.',
    contacts: true,
  },
];
