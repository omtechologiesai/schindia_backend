/**
 * Public-health reference benchmarks shown beside the Shichida checklist.
 *
 * CDC / AAP "Learn the Signs. Act Early." checkpoints (revised February 2022, public domain):
 * paraphrased summaries, not verbatim reproductions. Each lists what ~75% of children
 * typically do by that checkup age.
 *
 * WHO Motor Development Study, "Windows of achievement for six gross motor development
 * milestones", Acta Paediatrica Supplement 450 (2006): 86–95. Ranges are the 1st–99th
 * percentile age in months.
 */
import type { DomainKey } from '../domain';

export interface CdcCheckpoint {
  ageMonths: number;
  socialEmotional: readonly string[];
  language: readonly string[];
  cognitive: readonly string[];
  movement: readonly string[];
}

export const CDC_CHECKPOINTS: readonly CdcCheckpoint[] = [
  {
    "ageMonths": 2,
    "socialEmotional": [
      "Begins to smile at people",
      "Calms down when spoken to or picked up"
    ],
    "language": [
      "Makes sounds other than crying",
      "Reacts to loud sounds"
    ],
    "cognitive": [
      "Watches faces",
      "Seems to recognize familiar people"
    ],
    "movement": [
      "Holds head up briefly during tummy time",
      "Moves both arms and legs"
    ]
  },
  {
    "ageMonths": 4,
    "socialEmotional": [
      "Smiles on his/her own to get your attention",
      "Chuckles when you try to make him/her laugh"
    ],
    "language": [
      "Makes cooing sounds back and forth with you",
      "Turns head toward the sound of your voice"
    ],
    "cognitive": [
      "Reaches for a toy with one hand",
      "Uses hands and eyes together"
    ],
    "movement": [
      "Holds head steady without support",
      "Pushes up onto elbows/forearms when on tummy"
    ]
  },
  {
    "ageMonths": 6,
    "socialEmotional": [
      "Knows familiar people",
      "Likes to look at self in a mirror"
    ],
    "language": [
      "Takes turns making sounds with you",
      "Blows raspberries"
    ],
    "cognitive": [
      "Puts things in his/her mouth to explore them",
      "Reaches to grab a toy he/she wants"
    ],
    "movement": [
      "Rolls from tummy to back",
      "Leans on hands to support self when sitting"
    ]
  },
  {
    "ageMonths": 9,
    "socialEmotional": [
      "Is shy, clingy, or fearful around strangers",
      "Has favorite toys"
    ],
    "language": [
      "Makes a lot of different sounds like mamamama and bababababa",
      "Lifts arms up to be picked up"
    ],
    "cognitive": [
      "Looks for objects when they are dropped out of sight",
      "Bangs two things together"
    ],
    "movement": [
      "Gets to a sitting position by him/herself",
      "Moves things from one hand to the other"
    ]
  },
  {
    "ageMonths": 12,
    "socialEmotional": [
      "Plays games with you, like pat-a-cake"
    ],
    "language": [
      "Waves bye-bye",
      "Calls a parent by a special name like mama or dada"
    ],
    "cognitive": [
      "Puts something in a container, like a block in a cup",
      "Looks for things he/she sees hidden"
    ],
    "movement": [
      "Pulls up to stand",
      "Walks holding onto furniture"
    ]
  },
  {
    "ageMonths": 15,
    "socialEmotional": [
      "Copies other children while playing",
      "Shows you an object he/she likes"
    ],
    "language": [
      "Tries to say one or two words besides mama or dada",
      "Follows one-step directions without gestures"
    ],
    "cognitive": [
      "Tries to use things the right way, like a phone or cup",
      "Stacks two small objects"
    ],
    "movement": [
      "Takes a few steps on his/her own",
      "Uses fingers to feed him/herself some food"
    ]
  },
  {
    "ageMonths": 18,
    "socialEmotional": [
      "Moves away from you but looks to make sure you are close by",
      "Points to show you something interesting"
    ],
    "language": [
      "Tries to say three or more words besides mama or dada",
      "Follows one-step directions with a gesture"
    ],
    "cognitive": [
      "Copies you doing chores, such as sweeping",
      "Plays with toys in a simple way, like pushing a toy car"
    ],
    "movement": [
      "Walks without holding on to anyone or anything",
      "Scribbles"
    ]
  },
  {
    "ageMonths": 24,
    "socialEmotional": [
      "Notices when others are hurt or upset",
      "Looks at your face to see how to react in a new situation"
    ],
    "language": [
      "Points to things in a book when asked",
      "Says at least two words together, like more milk"
    ],
    "cognitive": [
      "Holds something in one hand while using the other hand",
      "Plays with more than one toy at the same time"
    ],
    "movement": [
      "Kicks a ball",
      "Runs",
      "Walks up a few stairs with or without help"
    ]
  },
  {
    "ageMonths": 30,
    "socialEmotional": [
      "Plays next to other children and sometimes plays with them",
      "Shows you what he/she can do"
    ],
    "language": [
      "Says about 50 words",
      "Says two or more words together, with one action word"
    ],
    "cognitive": [
      "Uses things to pretend, like feeding a block to a doll",
      "Shows simple problem-solving skills"
    ],
    "movement": [
      "Uses hands to twist things, like turning doorknobs",
      "Jumps off the ground with both feet"
    ]
  },
  {
    "ageMonths": 36,
    "socialEmotional": [
      "Calms down within 10 minutes after you leave him/her, like at a childcare drop off",
      "Notices other children and joins them to play"
    ],
    "language": [
      "Talks with you in conversation using at least two back-and-forth exchanges",
      "Names a few items in a picture book"
    ],
    "cognitive": [
      "Draws a circle when you show him/her how",
      "Avoids touching hot objects when warned"
    ],
    "movement": [
      "Strings items together, like large beads",
      "Puts on some clothes by him/herself"
    ]
  },
  {
    "ageMonths": 48,
    "socialEmotional": [
      "Pretends to be something else during play",
      "Comforts others who are hurt or sad"
    ],
    "language": [
      "Says sentences with four or more words",
      "Answers simple questions like What is a coat for?"
    ],
    "cognitive": [
      "Names a few colors of items",
      "Tells what comes next in a well-known story"
    ],
    "movement": [
      "Catches a large ball most of the time",
      "Holds a crayon or pencil between fingers and thumb, not a fist"
    ]
  },
  {
    "ageMonths": 60,
    "socialEmotional": [
      "Follows rules or takes turns when playing games with other children",
      "Sings, dances, or acts for you"
    ],
    "language": [
      "Tells a story with at least two events",
      "Answers simple questions about a book or story"
    ],
    "cognitive": [
      "Counts to 10",
      "Draws a person with at least three body parts"
    ],
    "movement": [
      "Hops on one foot",
      "Uses a fork"
    ]
  }
];

export interface WhoMotorWindow {
  name: string;
  lo: number;
  hi: number;
}

export const WHO_MOTOR: readonly WhoMotorWindow[] = [
  {
    "name": "Sitting without support",
    "lo": 3.8,
    "hi": 9.2
  },
  {
    "name": "Standing with assistance",
    "lo": 4.8,
    "hi": 11.4
  },
  {
    "name": "Hands-and-knees crawling",
    "lo": 5.2,
    "hi": 13.5
  },
  {
    "name": "Walking with assistance",
    "lo": 5.9,
    "hi": 13.7
  },
  {
    "name": "Standing alone",
    "lo": 6.9,
    "hi": 16.9
  },
  {
    "name": "Walking alone",
    "lo": 8.2,
    "hi": 17.6
  }
];

export const WHO_MAX_MONTHS = 20;

/** How each Shichida domain lines up with the CDC and ASQ-3 domain structures. */
export const CROSSWALK: Record<DomainKey, string> = {
  "physical": "Movement/Physical (CDC) · Gross & Fine Motor (ASQ-3) · gross-motor windows (WHO)",
  "sensory": "Cognitive (CDC) · Fine Motor & Problem Solving (ASQ-3)",
  "language": "Language/Communication (CDC) · Communication (ASQ-3)",
  "social": "Social/Emotional (CDC) · Personal-Social (ASQ-3)"
};
