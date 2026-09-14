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

/** The front page. Its list of what's inside is built from PAGES below. */
export const COVER = {
  kicker: 'Woodhouse Basecamp',
  blurb: 'It tells you what to clean today, and it tells the office when you '
    + 'have finished.',
  inside: 'What is in here',
};

export const CONTACTS = [
  ['Office', '0402 930 714'],
  ['Maintenance', '0437 316 386'],
];

export const PAGES = [
  {
    title: 'Logging in',
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
    title: 'Putting it on your phone',
    steps: [
      'Open the app in your phone’s browser.',
      'On an iPhone: tap the Share button, then Add to Home Screen.',
      'On Android: tap Install on the bar under the names.',
    ],
    images: [
      ['install-iphone', 'On an iPhone.'],
      ['install-android', 'On Android.'],
    ],
    note: 'You only do this once. The app then has its own icon, like any '
      + 'other app, and you never have to find the link again.',
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
      + 'clean. A green Done means someone has already finished that building. '
      + 'The arrows at the top show another day, and every other building is '
      + 'under Other buildings at the bottom.',
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
  },

  {
    title: 'Who is working this week',
    steps: [
      'Tap Roster at the bottom of the screen.',
      'Your row shows the days you are on and your hours.',
      'Tap the arrows to look at another week.',
    ],
    images: [
      ['roster', 'The week, with your hours on it.'],
    ],
    note: 'The office writes the roster. If a shift looks wrong, ring them. '
      + 'A week that is not out yet will say so instead of showing you a '
      + 'half-finished one.',
  },

  {
    title: 'Saying when you can work',
    steps: [
      'Tap Roster, then My availability at the top.',
      'Tick the days you can work. Add hours if they matter.',
      'Tap Save as my usual week.',
    ],
    images: [
      ['availability', 'Tick a day, and add hours if they matter.'],
    ],
    note: 'Tap the star on a day you would rather work. Use Save for this '
      + 'week only if it is a one-off. Saving does not move a shift you '
      + 'already have, so ring the office if one needs to change.',
    contacts: true,
  },
];
