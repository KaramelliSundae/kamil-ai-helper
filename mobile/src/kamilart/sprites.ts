// Generated. Do not edit by hand.
export type Sprite = { src: number; x: number; y: number; w: number; h: number };
export type Eye = { x: number; y: number; r: number; sx: number };
type Point = number[];
export type RobotView = {
  yaw: number; body: Sprite; armA: Sprite; armB: Sprite; legs: Sprite; sitLegs?: Sprite; legA?: Sprite; legB?: Sprite;
  armAForward?: Sprite; armBForward?: Sprite; head: Sprite[]; eyes: Eye[][]; shut?: Sprite; worried?: Sprite; worriedEyes?: Eye[];
  pivots: { armA: Point; armB: Point; legA: Point; legB: Point; neck: Point; hinge: Point };
};
export const CANVAS = {"w": 406, "h": 490, "ox": 203.0, "oy": 459.2, "unit": 140};
export const KAMIL: RobotView[] = [
  {
    yaw: 20,
    body: { src: require('./k_y20_body.webp'), x: 136, y: 219, w: 134, h: 183 },
    armA: { src: require('./k_y20_armA.webp'), x: 252, y: 244, w: 62, h: 121 },
    armB: { src: require('./k_y20_armB.webp'), x: 101, y: 251, w: 53, h: 125 },
    legs: { src: require('./k_y20_legs.webp'), x: 144, y: 327, w: 117, h: 136 },
    pivots: {
      armA: [
        265.49,
        257.91,
      ],
      armB: [
        140.51,
        265.02,
      ],
      legA: [
        230.63,
        333.18,
      ],
      legB: [
        175.37,
        336.32,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        182.89,
        225.86,
      ],
    },
    sitLegs: { src: require('./k_y20_sitlegs.webp'), x: 148, y: 340, w: 132, h: 103 },
    head: [
      { src: require('./k_y20_head0.webp'), x: 136, y: 118, w: 157, h: 128 },
      { src: require('./k_y20_head1.webp'), x: 132, y: 106, w: 156, h: 137 },
      { src: require('./k_y20_head2.webp'), x: 128, y: 96, w: 154, h: 147 },
      { src: require('./k_y20_head3.webp'), x: 121, y: 83, w: 153, h: 160 },
    ],
    eyes: [
      [
        {
          x: 198.67,
          y: 196.38,
          r: 36.68,
          sx: 0.93,
        },
        {
          x: 263.41,
          y: 192.68,
          r: 36.68,
          sx: 0.928,
        },
      ],
      [
        {
          x: 194.47,
          y: 168.94,
          r: 36.68,
          sx: 0.946,
        },
        {
          x: 259.21,
          y: 165.25,
          r: 36.68,
          sx: 0.944,
        },
      ],
      [
        {
          x: 187.81,
          y: 141.5,
          r: 36.68,
          sx: 0.931,
        },
        {
          x: 252.55,
          y: 137.82,
          r: 36.68,
          sx: 0.928,
        },
      ],
      [
        {
          x: 177.03,
          y: 113.21,
          r: 36.68,
          sx: 0.869,
        },
        {
          x: 241.76,
          y: 109.54,
          r: 36.68,
          sx: 0.867,
        },
      ],
    ],
    shut: { src: require('./k_y20_shut.webp'), x: 136, y: 118, w: 158, h: 128 },
  },
  {
    yaw: 55,
    body: { src: require('./k_y55_body.webp'), x: 122, y: 221, w: 152, h: 186 },
    armA: { src: require('./k_y55_armA.webp'), x: 227, y: 239, w: 64, h: 117 },
    armB: { src: require('./k_y55_armB.webp'), x: 138, y: 256, w: 41, h: 127 },
    legs: { src: require('./k_y55_legs.webp'), x: 158, y: 325, w: 90, h: 141 },
    pivots: {
      armA: [
        241.14,
        252.94,
      ],
      armB: [
        164.86,
        269.99,
      ],
      legA: [
        219.86,
        330.98,
      ],
      legB: [
        186.14,
        338.52,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        154.83,
        229.22,
      ],
    },
    sitLegs: { src: require('./k_y55_sitlegs.webp'), x: 165, y: 337, w: 156, h: 102 },
    head: [
      { src: require('./k_y55_head0.webp'), x: 136, y: 118, w: 167, h: 129 },
    ],
    eyes: [
      [
        {
          x: 247.25,
          y: 193.77,
          r: 36.68,
          sx: 0.711,
        },
        {
          x: 286.72,
          y: 184.94,
          r: 36.68,
          sx: 0.708,
        },
      ],
    ],
    shut: { src: require('./k_y55_shut.webp'), x: 136, y: 118, w: 168, h: 129 },
  },
  {
    yaw: 90,
    body: { src: require('./k_y90_body.webp'), x: 132, y: 225, w: 145, h: 186 },
    armA: { src: require('./k_y90_armA.webp'), x: 189, y: 237, w: 48, h: 114 },
    armB: { src: require('./k_y90_armB.webp'), x: 189, y: 258, w: 48, h: 127 },
    legs: { src: require('./k_y90_legs.webp'), x: 172, y: 325, w: 62, h: 142 },
    pivots: {
      armA: [
        203.0,
        251.06,
      ],
      armB: [
        203.0,
        271.87,
      ],
      legA: [
        203.0,
        330.15,
      ],
      legB: [
        203.0,
        339.35,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        144.2,
        234.5,
      ],
    },
    sitLegs: { src: require('./k_y90_sitlegs.webp'), x: 189, y: 335, w: 133, h: 95 },
    legA: { src: require('./k_y90_lega.webp'), x: 172, y: 325, w: 62, h: 131 },
    legB: { src: require('./k_y90_legb.webp'), x: 172, y: 334, w: 62, h: 133 },
    head: [
      { src: require('./k_y90_head0.webp'), x: 136, y: 118, w: 155, h: 131 },
    ],
    eyes: [
      [
        {
          x: 281.07,
          y: 187.73,
          r: 36.68,
          sx: 0.526,
        },
      ],
    ],
    shut: { src: require('./k_y90_shut.webp'), x: 136, y: 118, w: 156, h: 131 },
  },
  {
    yaw: 135,
    body: { src: require('./k_y135_body.webp'), x: 124, y: 228, w: 147, h: 187 },
    armA: { src: require('./k_y135_armA.webp'), x: 122, y: 240, w: 48, h: 115 },
    armB: { src: require('./k_y135_armB.webp'), x: 236, y: 255, w: 68, h: 123 },
    legs: { src: require('./k_y135_legs.webp'), x: 152, y: 326, w: 102, h: 139 },
    pivots: {
      armA: [
        155.98,
        254.11,
      ],
      armB: [
        250.02,
        268.82,
      ],
      legA: [
        182.21,
        331.5,
      ],
      legB: [
        223.79,
        338.0,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        161.42,
        241.01,
      ],
    },
    sitLegs: { src: require('./k_y135_sitlegs.webp'), x: 158, y: 335, w: 156, h: 81 },
    head: [
      { src: require('./k_y135_head0.webp'), x: 136, y: 118, w: 166, h: 131 },
    ],
    eyes: [
      [],
    ],
  },
  {
    yaw: 180,
    body: { src: require('./k_y180_body.webp'), x: 136, y: 228, w: 134, h: 185 },
    armA: { src: require('./k_y180_armA.webp'), x: 91, y: 248, w: 59, h: 118 },
    armB: { src: require('./k_y180_armB.webp'), x: 256, y: 248, w: 59, h: 118 },
    legs: { src: require('./k_y180_legs.webp'), x: 146, y: 329, w: 114, h: 132 },
    pivots: {
      armA: [
        136.5,
        261.46,
      ],
      armB: [
        269.5,
        261.46,
      ],
      legA: [
        173.6,
        334.75,
      ],
      legB: [
        232.4,
        334.75,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        203.0,
        243.7,
      ],
    },
    armAForward: { src: require('./k_y180_armaf.webp'), x: 123, y: 248, w: 54, h: 36 },
    armBForward: { src: require('./k_y180_armbf.webp'), x: 229, y: 248, w: 54, h: 36 },
    head: [
      { src: require('./k_y180_head0.webp'), x: 126, y: 118, w: 154, h: 131 },
    ],
    eyes: [
      [],
    ],
  },
];
export const STAGE = { src: require('./stage.webp'), w: 1080, h: 729, ox: 540.0, oy: 668.25, unit: 135, elev: 0.1571, door: { src: require('./door.webp'), x: 39, y: 308, w: 259, h: 348 }, shadow: require('./shadow.webp') };
