/**
 * Curated play ideas by domain × age band, tagged by interest. Suggested for the domains
 * that sit furthest below the attainment target. Same ideas as the Shape Early Compass,
 * in the Indian-English wording used by the Shichida Digital parent portal.
 */
import type { BandKey, DomainKey } from '../domain';

export type InterestKey = 'books' | 'music' | 'building' | 'outdoor' | 'art' | 'pretend';

export interface Activity {
  text: string;
  tags: readonly InterestKey[];
}

export const INTEREST_OPTIONS: readonly { key: InterestKey; label: string }[] = [
  {
    "key": "books",
    "label": "Books & stories"
  },
  {
    "key": "music",
    "label": "Music & movement"
  },
  {
    "key": "building",
    "label": "Building & puzzles"
  },
  {
    "key": "outdoor",
    "label": "Outdoor play"
  },
  {
    "key": "art",
    "label": "Art & crafts"
  },
  {
    "key": "pretend",
    "label": "Pretend play"
  }
];

export const ACTIVITIES: Record<`${DomainKey}|${BandKey}`, readonly Activity[]> = {
  "physical|0-2": [
    {
      "text": "Tummy-time reach: place a toy just out of reach to encourage lifting the head and stretching",
      "tags": [
        "outdoor"
      ]
    },
    {
      "text": "Cushion crawling course: line up pillows to crawl over and around",
      "tags": [
        "building",
        "outdoor"
      ]
    },
    {
      "text": "Cruise along the couch: hold a favourite toy a step away to encourage walking while holding on",
      "tags": [
        "outdoor"
      ]
    },
    {
      "text": "Roll-and-kick: sit facing your child and roll a soft ball back and forth",
      "tags": [
        "outdoor"
      ]
    }
  ],
  "physical|2-4": [
    {
      "text": "Animal walks: take turns doing a bear crawl, crab walk, and frog jump across the room",
      "tags": [
        "outdoor",
        "pretend"
      ]
    },
    {
      "text": "Obstacle course: crawl under a chair, step over cushions, walk along a taped line",
      "tags": [
        "outdoor",
        "building"
      ]
    },
    {
      "text": "Freeze dance: dance to music and freeze when it stops",
      "tags": [
        "music"
      ]
    },
    {
      "text": "Catch and roll: practise catching a large ball, then rolling it back",
      "tags": [
        "outdoor"
      ]
    }
  ],
  "physical|4-6": [
    {
      "text": "Hopscotch: chalk a simple grid and practise hopping on one and two feet",
      "tags": [
        "outdoor"
      ]
    },
    {
      "text": "Jump-rope basics: start with swinging the rope for them to jump over on the ground",
      "tags": [
        "outdoor",
        "music"
      ]
    },
    {
      "text": "Balance-beam walk: use a chalk line, curb, or taped strip to practise walking heel-to-toe",
      "tags": [
        "outdoor"
      ]
    },
    {
      "text": "Throw, catch, kick circuit: set up three short stations with a beanbag, soft ball, and target",
      "tags": [
        "outdoor"
      ]
    }
  ],
  "sensory|0-2": [
    {
      "text": "Texture bin: fill a tray with rice, water, or dry pasta for supervised scooping and pouring",
      "tags": [
        "art"
      ]
    },
    {
      "text": "Stacking cups: practise stacking and knocking down 2–4 cups or blocks",
      "tags": [
        "building"
      ]
    },
    {
      "text": "Shape sorter play: name each shape as it goes in",
      "tags": [
        "building"
      ]
    },
    {
      "text": "Peekaboo with objects: hide a toy under a cloth and let them find it",
      "tags": [
        "pretend"
      ]
    }
  ],
  "sensory|2-4": [
    {
      "text": "Playdough shapes: roll, pinch, and cut simple shapes together",
      "tags": [
        "art"
      ]
    },
    {
      "text": "Bead threading: string large beads or pasta onto a shoelace",
      "tags": [
        "building",
        "art"
      ]
    },
    {
      "text": "Colour and shape sort: sort buttons or blocks by colour, then by shape",
      "tags": [
        "building"
      ]
    },
    {
      "text": "Simple 6–15 piece puzzles: work on a puzzle together, naming pieces as they fit",
      "tags": [
        "building"
      ]
    }
  ],
  "sensory|4-6": [
    {
      "text": "Scissor-cutting crafts: practise cutting along drawn lines, then simple shapes",
      "tags": [
        "art"
      ]
    },
    {
      "text": "Origami basics: fold a simple paper cup or boat together, step by step",
      "tags": [
        "art",
        "building"
      ]
    },
    {
      "text": "Maze worksheets: trace a path with a pencil without crossing the lines",
      "tags": [
        "building"
      ]
    },
    {
      "text": "Memory match: play a matching-pairs card game",
      "tags": [
        "building"
      ]
    }
  ],
  "language|0-2": [
    {
      "text": "Narrate the everyday: describe what you are doing out loud during routines like bath or meals",
      "tags": [
        "books"
      ]
    },
    {
      "text": "Sing nursery rhymes with hand motions: \"Itsy Bitsy Spider\", \"Wheels on the Bus\"",
      "tags": [
        "music"
      ]
    },
    {
      "text": "Name-it play: point to and name objects and body parts during play",
      "tags": [
        "pretend"
      ]
    },
    {
      "text": "Read together daily: point at pictures and name what you see",
      "tags": [
        "books"
      ]
    }
  ],
  "language|2-4": [
    {
      "text": "Open-ended questions: ask \"what happens next?\" while reading a familiar book",
      "tags": [
        "books"
      ]
    },
    {
      "text": "Retell a story: after reading, ask them to tell it back to you in their own words",
      "tags": [
        "books"
      ]
    },
    {
      "text": "Rhyming games: take turns saying words that rhyme with a simple word like \"cat\"",
      "tags": [
        "music"
      ]
    },
    {
      "text": "Pretend phone calls: role-play a phone conversation to practise back-and-forth talk",
      "tags": [
        "pretend"
      ]
    }
  ],
  "language|4-6": [
    {
      "text": "Chapter-book time: read a short chapter together and talk about what might happen next",
      "tags": [
        "books"
      ]
    },
    {
      "text": "Letter and name writing: trace, then freehand, their name and a few familiar words",
      "tags": [
        "art"
      ]
    },
    {
      "text": "I Spy and word games: play I Spy or \"the word that starts with…\" on a walk or car ride",
      "tags": [
        "outdoor",
        "music"
      ]
    },
    {
      "text": "Daily recap: ask them to tell you three things that happened in their day, in order",
      "tags": [
        "books"
      ]
    }
  ],
  "social|0-2": [
    {
      "text": "Side-by-side play: set up parallel play with another child, no sharing required yet",
      "tags": [
        "pretend"
      ]
    },
    {
      "text": "Turn-taking games: roll a ball back and forth, taking clear turns",
      "tags": [
        "outdoor"
      ]
    },
    {
      "text": "Wave and greet: practise waving hello and goodbye with family members",
      "tags": [
        "pretend"
      ]
    },
    {
      "text": "Mirror play: make faces together in a mirror and name the emotions",
      "tags": [
        "pretend"
      ]
    }
  ],
  "social|2-4": [
    {
      "text": "Simple playdates: arrange short playdates with one peer around an activity like blocks",
      "tags": [
        "building",
        "pretend"
      ]
    },
    {
      "text": "Turn-based board games: try an easy game to practise waiting a turn",
      "tags": [
        "building"
      ]
    },
    {
      "text": "Pretend play: set up a pretend kitchen, doctor kit, or shop to practise roles and rules",
      "tags": [
        "pretend"
      ]
    },
    {
      "text": "Sharing practice: use a timer to practise sharing a toy fairly with a sibling or friend",
      "tags": [
        "pretend"
      ]
    }
  ],
  "social|4-6": [
    {
      "text": "Rules-based games: play a card or board game with real rules and turn order",
      "tags": [
        "building"
      ]
    },
    {
      "text": "Small chores: give one consistent small responsibility, like setting napkins at dinner",
      "tags": []
    },
    {
      "text": "Conflict practice: role-play how to ask for a turn or say sorry after a disagreement",
      "tags": [
        "pretend"
      ]
    },
    {
      "text": "Group activity: join a small group class or team activity, like a sports class or group craft",
      "tags": [
        "outdoor",
        "art"
      ]
    }
  ]
};
