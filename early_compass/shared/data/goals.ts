/**
 * Attainment goals by age (0–6): broader curriculum-style targets from the Shichida
 * "Goals by Age" framework. Extracted verbatim from the Shape Early Compass HTML (RAW_DATA.goals).
 * These do not feed the compass reading; they are recorded alongside it when assessed.
 */
export type GoalAge = '0' | '1' | '2' | '3' | '4' | '5' | '6';

export const GOAL_AGES: readonly GoalAge[] = ['0', '1', '2', '3', '4', '5', '6'];

export const GOALS: Record<GoalAge, Record<string, readonly string[]>> = {
  "0": {
    "Imagination": [
      "Can pretend to eat"
    ],
    "Senses": [
      "Can pick up and drop an item using his/her fingers",
      "Can take pieces of a peg puzzle out with his/her fingers"
    ],
    "Critical Thinking": [
      "Can understand one color out of red, blue and yellow",
      "Can understand one shape out of circle, triangle and square"
    ],
    "Language Art": [
      "Understands the names of body parts and can point them out when asked",
      "Can pick up the correct alphabet card (A-Z) as indicated",
      "Can recognize and imitate simple commands such as \"Give me XX\" and \"Thank you\""
    ]
  },
  "1": {
    "Imagination": [
      "Can engage in pretend play (e.g. pretending to eat or drink)"
    ],
    "Memorization": [
      "After seeing 4 items organized and put away, can place them back where they were",
      "Can memorize 5 to 10 items in order while listening to a story"
    ],
    "Senses": [
      "Can use tweezers",
      "Can do up/undo buttons",
      "Can string items with a hole"
    ],
    "Critical Thinking": [
      "Can stack 6 to 10 blocks",
      "Can understand 10 colors (red, blue, yellow, green, orange, purple, pink, white, black, brown)",
      "Can understand basic shapes (circle, triangle, square, star, trapezoid, hexagon, diamond, cross)",
      "Can understand big/small, up/down, many/a little, long/short",
      "Can complete a 6-piece puzzle"
    ],
    "Language Art": [
      "Can recognize some nouns",
      "Can read aloud uppercase letters A to Z in order",
      "Can understand the phonics of his/her own name correctly",
      "Can draw spirals and vertical/horizontal lines"
    ],
    "Number": [
      "Can count up to 30",
      "Can place numbers 1 to 5 in order",
      "Can see a number 1 to 5 and take that many objects"
    ]
  },
  "2": {
    "Imagination": [
      "Can enjoy pretending to be animals or doing everyday activities",
      "Can verbalize what he/she saw in an image"
    ],
    "Memorization": [
      "After seeing 6 items organized and put away, can place them back where they were",
      "Can memorize 15 to 20 items in order while listening to a story",
      "Can recite the whole sentence of a short picture book"
    ],
    "Senses": [
      "Can use chopsticks",
      "Can cut circles, triangles and squares",
      "Can fold origami paper in quarters"
    ],
    "Critical Thinking": [
      "Can complete an easy maze",
      "Can understand various plane figures",
      "Can understand half/whole, high/low, inside/outside, front/back, left/right",
      "Can replicate a block structure shown in a real example",
      "Can solve a 15-piece puzzle"
    ],
    "Language Art": [
      "Can recognize some item names and pick the correct picture card from two choices",
      "Can recognize and arrange the alphabet A to Z in order",
      "Can match uppercase and lowercase letters",
      "Can read three-letter words",
      "Can draw a circle, a cross, etc., and connect two dots with a line",
      "Can hold a pencil properly"
    ],
    "Number": [
      "Can count up to 70",
      "Can count up to 100 by 10s",
      "Can arrange numbers 1 to 10 in order",
      "Can write numbers 1 to 10",
      "Can see a number 1 to 10 and take that many objects",
      "Can divide items into groups of 3 to 5"
    ]
  },
  "3": {
    "Imagination": [
      "Can verbalize or draw pictures of what he/she imagined"
    ],
    "Memorization": [
      "After seeing 6 to 8 items organized and put away, can place them back where they were",
      "Can memorize 25 to 30 items in order while listening to a story",
      "Can recite a short book"
    ],
    "Senses": [
      "Can complete a simple craft"
    ],
    "Critical Thinking": [
      "Can complete an intermediate-level maze",
      "Can replicate a block structure shown on an example card",
      "Can understand ordinal position (2nd/3rd/etc. largest or smallest, from top/bottom, front/back, left/right)",
      "Can understand telling time to the hour"
    ],
    "Language Art": [
      "Can recognize simple opposite words and synonyms",
      "Can understand some consonant blends (e.g. \"bl\" and \"cr\")",
      "Can read a picture book with short sentences",
      "Can write the alphabet without an example"
    ],
    "Number": [
      "Can count up to 70-100",
      "Can count up to 20 by 2s",
      "Can count up to 60 by 5s",
      "Can write numbers 1 to 30",
      "Can understand the composition of numbers 3 to 10 (e.g. 3+2=5, 6+4=10)"
    ]
  },
  "4": {
    "Imagination": [
      "Can describe what he/she imagined in detailed drawing or writing"
    ],
    "Memory": [
      "Can re-create an example made of 10 to 12 items after a brief look",
      "Can memorize 19 to 24 pictures in the order given in a story",
      "Can recite a story"
    ],
    "Senses": [
      "Can make shapes with color boards freely",
      "Can complete a more complex craft",
      "Can color while controlling color intensity"
    ],
    "Critical Thinking": [
      "Can solve an intermediate-advanced maze",
      "Can recognize the scale of an area at a glance",
      "Can describe the position of an object on a 5x5 grid",
      "Understands the half-hour, and 10- and 5-minute marks on a clock",
      "Understands exchanging and combining coins, and can role-play shopping with coins"
    ],
    "Language Art": [
      "Can recognize some homonyms",
      "Can understand and pronounce words with long vowel sounds (e.g. \"sale\", \"mule\", \"pole\")",
      "Can read books smoothly",
      "Can write words smoothly"
    ],
    "Number": [
      "Can count beyond 100",
      "Understands decomposition of numbers 3 to 10",
      "Can complete simple addition worksheets",
      "Can solve addition story problems with answers below 10"
    ]
  },
  "5": {
    "Imagination": [
      "Can imagine having accomplished something (memory game, calculation, sports, friendship, etc.)",
      "Can describe his/her own imagination in writing"
    ],
    "Memory": [
      "Can re-create an example made of 12 to 14 items after a brief look",
      "Can memorize 50 picture cards in correct order after listening to a story",
      "Can recite an advanced memorized text"
    ],
    "Senses": [
      "Can find a rule in a pattern of colored chips or rearrange them into a new shape",
      "Can make shapes with matchsticks"
    ],
    "Critical Thinking": [
      "Can solve an advanced-level maze",
      "Can name 3D shapes (cube, cuboid, cylinder, cone, triangular prism, etc.)",
      "Can understand units of measurement (length, weight, amount, time)",
      "Can do advanced pattern-making activities",
      "Can tell exact time and understand elapsed time",
      "Can understand exchanging and combining coins and bills, and role-play shopping with both"
    ],
    "Language Art": [
      "Can recognize various kinds of words (contractions, word families, compound words)",
      "Can read aloud a chapter from a chapter book",
      "Can write words smoothly including various phonetic sounds",
      "Can write a short composition"
    ],
    "Number": [
      "Can solve carry-over addition story problems",
      "Can solve simple subtraction story problems",
      "Can finish a grid calculation sheet within five minutes"
    ]
  },
  "6": {
    "Imagination": [
      "Can imagine the future of a story",
      "Can imagine abstract concepts (e.g. \"wrapping the world with light\")",
      "Can describe his/her imagination in extended writing and pictures, making an original picture book"
    ],
    "Memory": [
      "Can reproduce from memory 6 kinds of 2-3 letter words after seeing them once",
      "Can memorize up to 1,000 words from a story and recall them in order",
      "Can recite any text from an advanced memorization collection"
    ],
    "Senses": [
      "Can do complex paper-cutting and complex origami",
      "Can perform practical self-care skills needed for school life (tying a bow, wringing a cloth, folding clothes, wrapping a lunch box)"
    ],
    "Critical Thinking": [
      "Can complete an advanced maze within 15 minutes",
      "Can understand the concept of fractions",
      "Can complete a 3D puzzle",
      "Can count the number of blocks in a complex stack, including hidden ones",
      "Can understand and calculate change owed in a transaction",
      "Can solve word problems involving money"
    ],
    "Language Art": [
      "Can recognize and spell various words (contractions, word families, compound words)",
      "Can read a chapter from a chapter book smoothly",
      "Can write words including various phonetic sounds",
      "Can write and illustrate a picture diary"
    ],
    "Number": [
      "Can finish a 10x10 grid calculation within five minutes",
      "Can solve word problems involving double-digit addition, subtraction and simple multiplication"
    ]
  }
};
