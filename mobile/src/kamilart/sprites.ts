// Generated. Do not edit by hand.
export type Sprite = { src: number; x: number; y: number; w: number; h: number };
export type Eye = { x: number; y: number; r: number; sx: number };
type Point = number[];
export type RobotView = {
  yaw: number; body: Sprite; armA: Sprite; armB: Sprite; legs: Sprite; sitLegs?: Sprite; legA?: Sprite; legB?: Sprite;
  armAForward?: Sprite; armBForward?: Sprite; figArm?: Sprite; head: Sprite[]; eyes: Eye[][]; shut?: Sprite; worried?: Sprite; worriedEyes?: Eye[];
  pivots: { armA: Point; armB: Point; legA: Point; legB: Point; neck: Point; hinge: Point; fig: Point };
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
      fig: [
        103.76,
        222.11,
      ],
    },
    sitLegs: { src: require('./k_y20_sitlegs.webp'), x: 148, y: 340, w: 132, h: 103 },
    figArm: { src: require('./k_y20_figarm.webp'), x: 70, y: 191, w: 84, h: 88 },
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
    yaw: 38,
    body: { src: require('./k_y38_body.webp'), x: 127, y: 220, w: 145, h: 184 },
    armA: { src: require('./k_y38_armA.webp'), x: 242, y: 241, w: 65, h: 119 },
    armB: { src: require('./k_y38_armB.webp'), x: 117, y: 254, w: 47, h: 126 },
    legs: { src: require('./k_y38_legs.webp'), x: 149, y: 326, w: 108, h: 139 },
    pivots: {
      armA: [
        255.4,
        255.06,
      ],
      armB: [
        150.6,
        267.87,
      ],
      legA: [
        226.17,
        331.92,
      ],
      legB: [
        179.83,
        337.58,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        166.8,
        227.25,
      ],
      fig: [
        148.32,
        225.92,
      ],
    },
    sitLegs: { src: require('./k_y38_sitlegs.webp'), x: 154, y: 338, w: 152, h: 104 },
    head: [
      { src: require('./k_y38_head0.webp'), x: 136, y: 118, w: 165, h: 128 },
    ],
    eyes: [
      [
        {
          x: 225.03,
          y: 195.57,
          r: 36.68,
          sx: 0.823,
        },
        {
          x: 279.28,
          y: 188.92,
          r: 36.68,
          sx: 0.819,
        },
      ],
    ],
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
      fig: [
        195.41,
        227.38,
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
    yaw: 72,
    body: { src: require('./k_y72_body.webp'), x: 123, y: 222, w: 155, h: 187 },
    armA: { src: require('./k_y72_armA.webp'), x: 210, y: 238, w: 57, h: 115 },
    armB: { src: require('./k_y72_armB.webp'), x: 166, y: 258, w: 36, h: 127 },
    legs: { src: require('./k_y72_legs.webp'), x: 164, y: 324, w: 78, h: 142 },
    pivots: {
      armA: [
        223.55,
        251.57,
      ],
      armB: [
        182.45,
        271.36,
      ],
      legA: [
        212.09,
        330.38,
      ],
      legB: [
        193.91,
        339.13,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        147.08,
        231.66,
      ],
      fig: [
        243.15,
        226.61,
      ],
    },
    sitLegs: { src: require('./k_y72_sitlegs.webp'), x: 179, y: 336, w: 148, h: 99 },
    head: [
      { src: require('./k_y72_head0.webp'), x: 136, y: 118, w: 164, h: 131 },
    ],
    eyes: [
      [
        {
          x: 265.93,
          y: 191.18,
          r: 36.68,
          sx: 0.611,
        },
        {
          x: 287.21,
          y: 180.93,
          r: 36.68,
          sx: 0.608,
        },
      ],
    ],
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
      fig: [
        289.8,
        223.47,
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
    yaw: 112,
    body: { src: require('./k_y112_body.webp'), x: 122, y: 228, w: 156, h: 185 },
    armA: { src: require('./k_y112_armA.webp'), x: 157, y: 238, w: 39, h: 114 },
    armB: { src: require('./k_y112_armB.webp'), x: 214, y: 257, w: 61, h: 126 },
    legs: { src: require('./k_y112_legs.webp'), x: 163, y: 324, w: 80, h: 142 },
    pivots: {
      armA: [
        178.09,
        251.82,
      ],
      armB: [
        227.91,
        271.11,
      ],
      legA: [
        191.99,
        330.49,
      ],
      legB: [
        214.01,
        339.02,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        148.48,
        237.95,
      ],
      fig: [
        334.88,
        216.82,
      ],
    },
    sitLegs: { src: require('./k_y112_sitlegs.webp'), x: 175, y: 335, w: 151, h: 88 },
    head: [
      { src: require('./k_y112_head0.webp'), x: 136, y: 118, w: 165, h: 131 },
    ],
    eyes: [
      [
        {
          x: 294.75,
          y: 182.6,
          r: 36.68,
          sx: 0.38,
        },
      ],
    ],
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
      fig: [
        361.39,
        207.58,
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
    yaw: 158,
    body: { src: require('./k_y158_body.webp'), x: 136, y: 228, w: 134, h: 187 },
    armA: { src: require('./k_y158_armA.webp'), x: 99, y: 244, w: 56, h: 116 },
    armB: { src: require('./k_y158_armB.webp'), x: 251, y: 252, w: 67, h: 120 },
    legs: { src: require('./k_y158_legs.webp'), x: 145, y: 327, w: 116, h: 136 },
    pivots: {
      armA: [
        141.34,
        257.57,
      ],
      armB: [
        264.66,
        265.36,
      ],
      legA: [
        175.74,
        333.03,
      ],
      legB: [
        230.26,
        336.47,
      ],
      neck: [
        203.0,
        235.19,
      ],
      hinge: [
        180.97,
        243.03,
      ],
      fig: [
        362.73,
        197.46,
      ],
    },
    head: [
      { src: require('./k_y158_head0.webp'), x: 136, y: 118, w: 158, h: 131 },
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
      fig: [
        340.2,
        188.43,
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
export const HUSAMETTIN: RobotView[] = [
  {
    yaw: 20,
    body: { src: require('./h_y20_body.webp'), x: 145, y: 189, w: 116, h: 137 },
    armA: { src: require('./h_y20_armA.webp'), x: 239, y: 214, w: 62, h: 121 },
    armB: { src: require('./h_y20_armB.webp'), x: 114, y: 220, w: 53, h: 125 },
    legs: { src: require('./h_y20_legs.webp'), x: 150, y: 297, w: 106, h: 166 },
    pivots: {
      armA: [
        252.33,
        228.24,
      ],
      armB: [
        153.67,
        233.85,
      ],
      legA: [
        225.36,
        303.06,
      ],
      legB: [
        180.64,
        305.6,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        182.89,
        195.44,
      ],
      fig: [
        103.76,
        191.69,
      ],
    },
    head: [
      { src: require('./h_y20_head0.webp'), x: 136, y: 84, w: 145, h: 130 },
      { src: require('./h_y20_head1.webp'), x: 129, y: 74, w: 147, h: 138 },
      { src: require('./h_y20_head2.webp'), x: 121, y: 57, w: 149, h: 155 },
      { src: require('./h_y20_head3.webp'), x: 112, y: 38, w: 149, h: 174 },
    ],
    eyes: [
      [
        {
          x: 203.25,
          y: 164.43,
          r: 30.1,
          sx: 0.929,
        },
        {
          x: 254.53,
          y: 161.51,
          r: 30.1,
          sx: 0.929,
        },
      ],
      [
        {
          x: 199.05,
          y: 138.19,
          r: 30.1,
          sx: 0.945,
        },
        {
          x: 250.33,
          y: 135.27,
          r: 30.1,
          sx: 0.945,
        },
      ],
      [
        {
          x: 192.53,
          y: 112.06,
          r: 30.1,
          sx: 0.929,
        },
        {
          x: 243.81,
          y: 109.14,
          r: 30.1,
          sx: 0.929,
        },
      ],
      [
        {
          x: 182.07,
          y: 85.21,
          r: 30.1,
          sx: 0.868,
        },
        {
          x: 233.36,
          y: 82.29,
          r: 30.1,
          sx: 0.868,
        },
      ],
    ],
    shut: { src: require('./h_y20_shut.webp'), x: 136, y: 84, w: 145, h: 130 },
  },
  {
    yaw: 38,
    body: { src: require('./h_y38_body.webp'), x: 145, y: 189, w: 120, h: 137 },
    armA: { src: require('./h_y38_armA.webp'), x: 231, y: 212, w: 65, h: 119 },
    armB: { src: require('./h_y38_armB.webp'), x: 128, y: 222, w: 47, h: 126 },
    legs: { src: require('./h_y38_legs.webp'), x: 153, y: 296, w: 100, h: 168 },
    pivots: {
      armA: [
        244.37,
        225.99,
      ],
      armB: [
        161.63,
        236.1,
      ],
      legA: [
        221.75,
        302.04,
      ],
      legB: [
        184.25,
        306.62,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        166.8,
        196.83,
      ],
      fig: [
        148.32,
        195.5,
      ],
    },
    head: [
      { src: require('./h_y38_head0.webp'), x: 135, y: 85, w: 154, h: 129 },
    ],
    eyes: [
      [
        {
          x: 227.02,
          y: 163.52,
          r: 30.1,
          sx: 0.821,
        },
        {
          x: 270.02,
          y: 158.27,
          r: 30.1,
          sx: 0.821,
        },
      ],
    ],
  },
  {
    yaw: 55,
    body: { src: require('./h_y55_body.webp'), x: 144, y: 190, w: 126, h: 136 },
    armA: { src: require('./h_y55_armA.webp'), x: 219, y: 211, w: 64, h: 116 },
    armB: { src: require('./h_y55_armB.webp'), x: 146, y: 224, w: 41, h: 127 },
    legs: { src: require('./h_y55_legs.webp'), x: 161, y: 295, w: 84, h: 170 },
    pivots: {
      armA: [
        233.11,
        224.32,
      ],
      armB: [
        172.89,
        237.77,
      ],
      legA: [
        216.65,
        301.28,
      ],
      legB: [
        189.35,
        307.38,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        154.83,
        198.8,
      ],
      fig: [
        195.41,
        196.95,
      ],
    },
    head: [
      { src: require('./h_y55_head0.webp'), x: 134, y: 85, w: 159, h: 131 },
    ],
    eyes: [
      [
        {
          x: 246.74,
          y: 161.73,
          r: 30.1,
          sx: 0.709,
        },
        {
          x: 278.05,
          y: 154.74,
          r: 30.1,
          sx: 0.709,
        },
      ],
    ],
    shut: { src: require('./h_y55_shut.webp'), x: 134, y: 85, w: 159, h: 131 },
  },
  {
    yaw: 72,
    body: { src: require('./h_y72_body.webp'), x: 142, y: 192, w: 128, h: 134 },
    armA: { src: require('./h_y72_armA.webp'), x: 205, y: 209, w: 58, h: 116 },
    armB: { src: require('./h_y72_armB.webp'), x: 170, y: 225, w: 36, h: 127 },
    legs: { src: require('./h_y72_legs.webp'), x: 166, y: 295, w: 74, h: 171 },
    pivots: {
      armA: [
        219.22,
        223.23,
      ],
      armB: [
        186.78,
        238.85,
      ],
      legA: [
        210.35,
        300.79,
      ],
      legB: [
        195.65,
        307.87,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        147.08,
        201.24,
      ],
      fig: [
        243.15,
        196.19,
      ],
    },
    head: [
      { src: require('./h_y72_head0.webp'), x: 133, y: 84, w: 166, h: 133 },
    ],
    eyes: [
      [
        {
          x: 279.81,
          y: 151.12,
          r: 30.1,
          sx: 0.61,
        },
      ],
    ],
  },
  {
    yaw: 90,
    body: { src: require('./h_y90_body.webp'), x: 145, y: 194, w: 120, h: 132 },
    armA: { src: require('./h_y90_armA.webp'), x: 189, y: 209, w: 48, h: 114 },
    armB: { src: require('./h_y90_armB.webp'), x: 189, y: 226, w: 48, h: 126 },
    legs: { src: require('./h_y90_legs.webp'), x: 172, y: 295, w: 62, h: 171 },
    pivots: {
      armA: [
        203.0,
        222.83,
      ],
      armB: [
        203.0,
        239.26,
      ],
      legA: [
        203.0,
        300.61,
      ],
      legB: [
        203.0,
        308.05,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        144.2,
        204.08,
      ],
      fig: [
        289.8,
        193.05,
      ],
    },
    legA: { src: require('./h_y90_lega.webp'), x: 172, y: 295, w: 62, h: 162 },
    legB: { src: require('./h_y90_legb.webp'), x: 172, y: 303, w: 62, h: 163 },
    head: [
      { src: require('./h_y90_head0.webp'), x: 133, y: 84, w: 168, h: 133 },
    ],
    eyes: [
      [],
    ],
    shut: { src: require('./h_y90_shut.webp'), x: 133, y: 84, w: 168, h: 133 },
  },
  {
    yaw: 112,
    body: { src: require('./h_y112_body.webp'), x: 142, y: 197, w: 119, h: 129 },
    armA: { src: require('./h_y112_armA.webp'), x: 162, y: 210, w: 39, h: 113 },
    armB: { src: require('./h_y112_armB.webp'), x: 209, y: 225, w: 61, h: 125 },
    legs: { src: require('./h_y112_legs.webp'), x: 165, y: 295, w: 76, h: 171 },
    pivots: {
      armA: [
        183.33,
        223.43,
      ],
      armB: [
        222.67,
        238.66,
      ],
      legA: [
        194.08,
        300.88,
      ],
      legB: [
        211.92,
        307.78,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        148.48,
        207.53,
      ],
      fig: [
        334.88,
        186.4,
      ],
    },
    head: [
      { src: require('./h_y112_head0.webp'), x: 134, y: 84, w: 164, h: 133 },
    ],
    eyes: [
      [],
    ],
  },
  {
    yaw: 135,
    body: { src: require('./h_y135_body.webp'), x: 145, y: 200, w: 116, h: 126 },
    armA: { src: require('./h_y135_armA.webp'), x: 132, y: 211, w: 48, h: 115 },
    armB: { src: require('./h_y135_armB.webp'), x: 226, y: 223, w: 68, h: 123 },
    legs: { src: require('./h_y135_legs.webp'), x: 156, y: 296, w: 94, h: 169 },
    pivots: {
      armA: [
        165.88,
        225.24,
      ],
      armB: [
        240.12,
        236.85,
      ],
      legA: [
        186.17,
        301.7,
      ],
      legB: [
        219.83,
        306.96,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        161.42,
        210.58,
      ],
      fig: [
        361.39,
        177.16,
      ],
    },
    head: [
      { src: require('./h_y135_head0.webp'), x: 135, y: 84, w: 156, h: 133 },
    ],
    eyes: [
      [],
    ],
  },
  {
    yaw: 158,
    body: { src: require('./h_y158_body.webp'), x: 145, y: 200, w: 116, h: 126 },
    armA: { src: require('./h_y158_armA.webp'), x: 111, y: 214, w: 57, h: 116 },
    armB: { src: require('./h_y158_armB.webp'), x: 238, y: 220, w: 67, h: 121 },
    legs: { src: require('./h_y158_legs.webp'), x: 150, y: 297, w: 106, h: 166 },
    pivots: {
      armA: [
        154.32,
        227.97,
      ],
      armB: [
        251.68,
        234.12,
      ],
      legA: [
        180.93,
        302.94,
      ],
      legB: [
        225.07,
        305.73,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        180.97,
        212.61,
      ],
      fig: [
        362.73,
        167.04,
      ],
    },
    head: [
      { src: require('./h_y158_head0.webp'), x: 136, y: 83, w: 146, h: 134 },
    ],
    eyes: [
      [],
    ],
  },
  {
    yaw: 180,
    body: { src: require('./h_y180_body.webp'), x: 145, y: 200, w: 116, h: 126 },
    armA: { src: require('./h_y180_armA.webp'), x: 105, y: 217, w: 59, h: 118 },
    armB: { src: require('./h_y180_armB.webp'), x: 242, y: 217, w: 59, h: 119 },
    legs: { src: require('./h_y180_legs.webp'), x: 152, y: 298, w: 102, h: 163 },
    pivots: {
      armA: [
        150.5,
        231.04,
      ],
      armB: [
        255.5,
        231.04,
      ],
      legA: [
        179.2,
        304.33,
      ],
      legB: [
        226.8,
        304.33,
      ],
      neck: [
        203.0,
        204.77,
      ],
      hinge: [
        203.0,
        213.28,
      ],
      fig: [
        340.2,
        158.01,
      ],
    },
    head: [
      { src: require('./h_y180_head0.webp'), x: 135, y: 83, w: 136, h: 134 },
    ],
    eyes: [
      [],
    ],
  },
];
