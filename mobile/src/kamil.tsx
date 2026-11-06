/**
 * Kamil, the butler who lives on the main page and in the chat. He is a set of 3D drawings, one sprite per part, moved
 * by the native animation driver. The top of his head is hinged at the back and opens like a puppet's while the text
 * types out; his legs are stiff cones that swivel from the hip. Every sentence he says is fixed, chosen from a real
 * result, with no model behind it.
 */
import { RNHostView, Surface, Text, useMaterialColors } from '@expo/ui/jetpack-compose';
import { padding, size, weight } from '@expo/ui/jetpack-compose/modifiers';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Easing, Image, Pressable, StyleSheet, Text as RNText, useWindowDimensions, View } from 'react-native';

import { api, Connection } from './api';
import { chat } from './chatSession';
import { timeLeft } from './format';
import { CANVAS, KAMIL, STAGE } from './kamilart/sprites';
import type { Eye, RobotView, Sprite } from './kamilart/sprites';
import type { GpuState, Upcoming } from './types';
import { rounded } from './ui';

export type Mood = 'happy' | 'busy' | 'worried' | 'asleep';

/** Kamil seen from the front, for places where he only stands. */
export const KAMIL_FRONT = KAMIL.slice(0, 1);

export const PAUSE = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const WALK_MS = 620;
const STEP_ANGLE = 27; // the legs are stiff cones that swivel from the hip, with no knees
const TURN_STEP_MS = 42;
const LEG_LENGTH = 0.9;
const SIT_DROP = 0.24;
// The drawn sides he turns through; the ones between these are only passed on the way.
export const Y20 = 0;
export const Y55 = 2;
export const Y90 = 4;
export const Y135 = 6;
export const Y180 = 8;

type AnimatedStyle = React.ComponentProps<typeof Animated.View>['style'];

export type Rig = {
  view: Animated.Value;
  flip: Animated.Value;
  walk: Animated.Value;
  sit: Animated.Value;
  jaw: Animated.Value;
  blink: Animated.Value;
  gazeX: Animated.Value;
  gazeY: Animated.Value;
  idle: Animated.Value;
  typing: Animated.Value;
  armUp: Animated.Value;
  /** -1 to 1: the head leaning to one side or the other, while he thinks or reads. */
  headTilt: Animated.Value;
  scribble: Animated.Value;
  figOn: Animated.Value;
  /** The side he has settled on. Only that one moves, so the hidden drawings cost nothing frame by frame. */
  liveView: number;
  liveListeners: Set<(view: number) => void>;
};

function settleOn(rig: Rig, view: number) {
  rig.liveView = view;
  rig.liveListeners.forEach((listener) => listener(view));
}

export function showView(rig: Rig, view: number) {
  rig.view.setValue(view);
  settleOn(rig, view);
}

// Smooth swings. A straight back-and-forth has a kink at each end that the eye reads as stutter.
const SINE_STEPS = 16;
const SINE_INPUT = Array.from({ length: SINE_STEPS + 1 }, (_, step) => step / SINE_STEPS);
const sine = (t: number) => Math.sin(2 * Math.PI * t);

function waveDeg(value: Animated.Value, amount: number, shape: (t: number) => number = sine) {
  return value.interpolate({ inputRange: SINE_INPUT, outputRange: SINE_INPUT.map((t) => `${(amount * shape(t)).toFixed(3)}deg`) });
}

function wave(value: Animated.Value, shape: (t: number) => number) {
  return value.interpolate({ inputRange: SINE_INPUT, outputRange: SINE_INPUT.map(shape) });
}

function makeRig(view = 0): Rig {
  const value = (start = 0) => new Animated.Value(start);
  return {
    view: value(view), flip: value(1), walk: value(), sit: value(), jaw: value(), blink: value(), gazeX: value(), gazeY: value(),
    idle: value(), typing: value(), armUp: value(), headTilt: value(), scribble: value(), figOn: value(),
    liveView: view, liveListeners: new Set(),
  };
}

export function useRig(view = 0): Rig {
  const holder = useRef<Rig | null>(null);
  if (!holder.current) holder.current = makeRig(view);
  return holder.current;
}

export function useLoop(value: Animated.Value, duration: number, enabled = true) {
  useEffect(() => {
    if (!enabled) {
      value.setValue(0);
      return;
    }
    const run = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: true }));
    run.start();
    return () => run.stop();
  }, [duration, enabled, value]);
}

/**
 * Turns through the drawn sides, changing to the mirrored ones only at the front or back, where it does not show. The
 * native driver runs the turn, so a busy moment in JavaScript cannot make it jump.
 */
export async function turnRobot(rig: Rig, facing: { current: number }, flipped: { current: boolean }, target: number, flip: boolean, live: () => boolean) {
  const turnTo = (view: number) => new Promise<void>((resolve) => {
    const steps = Math.abs(view - facing.current);
    if (!live() || !steps) {
      resolve();
      return;
    }
    facing.current = view;
    Animated.timing(rig.view, { toValue: view, duration: steps * TURN_STEP_MS, easing: Easing.linear, useNativeDriver: true }).start(() => resolve());
  });
  if (flipped.current !== flip) {
    const viaFront = facing.current + target <= (Y180 - facing.current) + (Y180 - target);
    await turnTo(viaFront ? Y20 : Y180);
    flipped.current = flip;
    rig.flip.setValue(flip ? -1 : 1);
  }
  await turnTo(target);
  settleOn(rig, facing.current);
}

/** Blinks now and then, and the small quick glances that make them look alive. */
export function useLife(rig: Rig, awake: boolean, glances = true) {
  useEffect(() => {
    if (!awake) return;
    const blink = Animated.loop(Animated.sequence([
      Animated.delay(2900),
      Animated.timing(rig.blink, { toValue: 1, duration: 35, useNativeDriver: true }),
      Animated.delay(70),
      Animated.timing(rig.blink, { toValue: 0, duration: 35, useNativeDriver: true }),
    ]));
    blink.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const glance = () => {
      Animated.parallel([
        Animated.timing(rig.gazeX, { toValue: Math.random() * 2 - 1, duration: 80, useNativeDriver: true }),
        Animated.timing(rig.gazeY, { toValue: Math.random() - 0.5, duration: 80, useNativeDriver: true }),
      ]).start();
      timer = setTimeout(glance, 1400 + Math.random() * 2600);
    };
    if (glances) timer = setTimeout(glance, 800);
    return () => {
      blink.stop();
      clearTimeout(timer);
      rig.blink.setValue(0);
    };
  }, [awake, glances, rig]);
}

function Piece({ sprite, k }: { sprite: Sprite; k: number }) {
  return (
    <Image
      source={sprite.src}
      fadeDuration={0}
      style={{ position: 'absolute', left: sprite.x * k, top: sprite.y * k, width: sprite.w * k, height: sprite.h * k }}
    />
  );
}

/** The whole canvas, turning around one point of it. Every sprite of a robot shares the same canvas. */
function Pivot({ k, at, transform, opacity, children }: {
  k: number;
  at?: number[];
  transform?: unknown[];
  opacity?: unknown;
  children: React.ReactNode;
}) {
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute', left: 0, top: 0, width: CANVAS.w * k, height: CANVAS.h * k, opacity,
        transformOrigin: at ? [at[0] * k, at[1] * k, 0] : undefined,
        transform,
      } as unknown as AnimatedStyle}>
      {children}
    </Animated.View>
  );
}

function Pupils({ eyes, rig, k }: { eyes: Eye[]; rig: Rig; k: number }) {
  return (
    <>
      {eyes.map((eye) => {
        const r = eye.r * 0.22 * k;
        const reach = eye.r * 0.2 * k;
        return (
          <Animated.View
            key={eye.x}
            style={{
              position: 'absolute', left: eye.x * k - r, top: eye.y * k - r, width: r * 2, height: r * 2, borderRadius: r,
              backgroundColor: '#08070a',
              transform: [
                { translateX: rig.gazeX.interpolate({ inputRange: [-1, 1], outputRange: [-reach, reach] }) },
                { translateY: rig.gazeY.interpolate({ inputRange: [-1, 1], outputRange: [-reach, reach] }) },
                { scaleX: eye.sx },
              ],
            }}
          />
        );
      })}
    </>
  );
}

/** The upper head, one finished drawing for each mouth level. A level shows only while the jaw is near it. */
function Head({ view, rig, k, mood, live }: { view: RobotView; rig: Rig; k: number; mood: Mood; live: boolean }) {
  const levels = view.head.length;
  const closedEyes = mood === 'asleep';
  const worried = mood === 'worried' && view.worried;
  // Talking is a whole-body affair: the head bounces up with each syllable, the way a puppet's does.
  const bounce = live ? rig.jaw.interpolate({ inputRange: [0, 3], outputRange: [0, -0.07 * CANVAS.unit * k] }) : 0;
  const tilt = live ? rig.jaw.interpolate({ inputRange: [0, 1, 2, 3], outputRange: ['0deg', '-1.5deg', '1.5deg', '-2.5deg'] }) : '0deg';
  return (
    <Pivot k={k} at={view.pivots.neck} transform={[{ translateY: bounce }, { rotate: tilt }]}>
      {view.head.map((sprite, level) => (
        <Pivot
          key={sprite.src}
          k={k}
          opacity={levels === 1 ? 1 : rig.jaw.interpolate({
            inputRange: [level - 0.51, level - 0.5, level + 0.49, level + 0.5],
            outputRange: [0, 1, 1, 0],
            extrapolate: 'clamp',
          })}>
          {level === 0 && worried ? <Piece sprite={view.worried!} k={k} /> : <Piece sprite={sprite} k={k} />}
          {closedEyes ? null : <Pupils eyes={level === 0 && worried ? view.worriedEyes ?? [] : view.eyes[level]} rig={rig} k={k} />}
          {level === 0 && view.shut ? (
            <Pivot k={k} opacity={closedEyes ? 1 : rig.blink}>
              <Piece sprite={view.shut} k={k} />
            </Pivot>
          ) : null}
        </Pivot>
      ))}
    </Pivot>
  );
}

/** A robot seen from one side. Its parts are stacked so that the nearest is drawn last. */
const OneView = memo(function OneView({ view, index, rig, k, mood, lying, live }: {
  view: RobotView;
  index: number;
  rig: Rig;
  k: number;
  mood: Mood;
  lying?: boolean;
  live: boolean;
}) {
  const unit = CANVAS.unit * k;
  const swing = (amount: number) => (live ? waveDeg(rig.walk, amount) : '0deg');
  const sitStep = rig.sit.interpolate({ inputRange: [0, 0.49, 0.5, 1], outputRange: [0, 0, 1, 1] });
  const standStep = rig.sit.interpolate({ inputRange: [0, 0.49, 0.5, 1], outputRange: [1, 1, 0, 0] });
  const drop = rig.sit.interpolate({ inputRange: [0, 1], outputRange: [0, SIT_DROP * unit] });
  // Arms work against the legs. While typing they peck in turn; the near one can lift to write on the board.
  const tap = (side: number) => (live ? waveDeg(rig.typing, 4 * side) : '0deg');
  const lift = rig.armUp.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-122deg'] });
  const scribble = live ? waveDeg(rig.scribble, 1, (t) => 6 * sine(t) + 3 * sine(2 * t)) : '0deg';
  const armA = <Pivot k={k} at={view.pivots.armA} transform={[{ rotate: swing(-20) }]} opacity={view.armAForward ? standStep : 1}><Piece sprite={view.armA} k={k} /></Pivot>;
  const armB = (
    <Pivot
      k={k}
      at={view.pivots.armB}
      transform={[{ rotate: swing(20) }, { rotate: lift }, { rotate: scribble }]}
      opacity={view.figArm ? rig.figOn.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0, 0] }) : view.armBForward ? standStep : 1}>
      <Piece sprite={view.armB} k={k} />
    </Pivot>
  );
  // The fig sign, thrust at you again and again.
  const figArm = view.figArm ? (
    <Pivot k={k} at={view.pivots.fig} opacity={rig.figOn} transform={[{ scale: live ? wave(rig.scribble, (t) => 1 + 0.16 * sine(t) ** 2) : 1 }]}>
      <Piece sprite={view.figArm} k={k} />
    </Pivot>
  ) : null;
  const typingArms = view.armAForward && view.armBForward ? (
    <>
      <Pivot k={k} at={view.pivots.armA} transform={[{ rotate: tap(1) }]} opacity={sitStep}><Piece sprite={view.armAForward} k={k} /></Pivot>
      <Pivot k={k} at={view.pivots.armB} transform={[{ rotate: tap(-1) }]} opacity={sitStep}><Piece sprite={view.armBForward} k={k} /></Pivot>
    </>
  ) : null;
  const legs = view.legA && view.legB && !lying ? (
    <>
      <Pivot k={k} at={view.pivots.legA} transform={[{ rotate: swing(STEP_ANGLE) }]} opacity={standStep}><Piece sprite={view.legA} k={k} /></Pivot>
      <Pivot k={k} at={view.pivots.legB} transform={[{ rotate: swing(-STEP_ANGLE) }]} opacity={standStep}><Piece sprite={view.legB} k={k} /></Pivot>
    </>
  ) : <Pivot k={k} opacity={standStep}><Piece sprite={view.legs} k={k} /></Pivot>;
  const sitLegs = view.sitLegs ? <Pivot k={k} opacity={sitStep}><Piece sprite={view.sitLegs} k={k} /></Pivot> : null;
  const nearArmOverHead = index >= Y55 && index < Y180;
  const nearArmBeforeHead = !nearArmOverHead && index !== Y180;
  // The head lags behind the body at each step, which makes the stiff walk funny.
  const headLag = live ? waveDeg(rig.walk, -3.5) : '0deg';
  const lean = live ? rig.headTilt.interpolate({ inputRange: [-1, 1], outputRange: ['-8deg', '8deg'] }) : '0deg';
  const breath = live ? waveDeg(rig.idle, 1.1) : '0deg';
  const typeNod = live ? waveDeg(rig.typing, 0.5) : '0deg';
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute', left: 0, top: 0, width: CANVAS.w * k, height: CANVAS.h * k,
        opacity: rig.view.interpolate({
          inputRange: [index - 0.51, index - 0.5, index + 0.49, index + 0.5],
          outputRange: [0, 1, 1, 0],
          extrapolate: 'clamp',
        }),
      }}>
      {legs}
      {sitLegs}
      <Pivot k={k} transform={[{ translateY: drop }]}>
        {armA}
        {index === Y180 ? armB : null}
        {typingArms}
        <Piece sprite={view.body} k={k} />
        {nearArmBeforeHead ? armB : null}
        <Pivot k={k} at={view.pivots.hinge} transform={[{ rotate: headLag }, { rotate: breath }, { rotate: typeNod }, { rotate: lean }]}>
          <Head view={view} rig={rig} k={k} mood={mood} live={live} />
        </Pivot>
        {nearArmOverHead ? armB : null}
        {figArm}
      </Pivot>
    </Animated.View>
  );
});

/** The robot standing on one spot of the canvas; the canvas's ground point is at (0, 0) of its parent. */
export const RobotBody = memo(function RobotBody({ views, rig, k, mood, lying }: { views: RobotView[]; rig: Rig; k: number; mood: Mood; lying?: boolean }) {
  const [liveView, setLiveView] = useState(rig.liveView);
  useEffect(() => {
    rig.liveListeners.add(setLiveView);
    setLiveView(rig.liveView);
    return () => {
      rig.liveListeners.delete(setLiveView);
    };
  }, [rig]);
  // A stiff-legged walk drops the body when the legs are apart, and rocks it from side to side.
  const unit = CANVAS.unit * k;
  const low = LEG_LENGTH * (1 - Math.cos(STEP_ANGLE * Math.PI / 180)) * unit;
  const bob = useMemo(() => wave(rig.walk, (t) => low * sine(t) ** 2), [low, rig]);
  const rock = useMemo(() => waveDeg(rig.walk, 5), [rig]);
  const hop = useMemo(() => rig.jaw.interpolate({ inputRange: [0, 3], outputRange: [0, -0.03 * unit] }), [rig, unit]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute', left: -CANVAS.ox * k, top: -CANVAS.oy * k, width: CANVAS.w * k, height: CANVAS.h * k,
        transformOrigin: [CANVAS.ox * k, CANVAS.oy * k, 0],
        transform: [{ scaleX: rig.flip }, { translateY: bob }, { translateY: hop }, { rotate: rock }],
      } as unknown as AnimatedStyle}>
      {views.map((view, index) => <OneView key={view.yaw} view={view} index={index} rig={rig} k={k} mood={mood} lying={lying} live={index === liveView} />)}
    </Animated.View>
  );
});

const WORRY_SHAKE: Record<Mood, number> = { happy: 2600, busy: 1100, worried: 420, asleep: 4800 };

/** A robot on its own. */
export function Figure({ views, mood, dp, text }: {
  views: RobotView[];
  mood: Mood;
  dp: number;
  text?: string;
}) {
  const rig = useRig();
  useLife(rig, mood !== 'asleep');
  useLoop(rig.idle, WORRY_SHAKE[mood]);
  useFlap(text ?? '', rig.jaw);
  const height = dp * 1.08;
  const k = height / (2.92 * CANVAS.unit);
  return (
    <RNHostView modifiers={[size(dp, height)]}>
      <View style={styles.host}>
        <View style={{ position: 'absolute', left: dp / 2, top: height - 0.08 * CANVAS.unit * k, width: dp, height }}>
          <Image source={STAGE.shadow} fadeDuration={0} style={{ position: 'absolute', left: -0.62 * CANVAS.unit * k, top: -0.2 * CANVAS.unit * k, width: 1.24 * CANVAS.unit * k, height: 0.42 * CANVAS.unit * k }} />
          <RobotBody views={views} rig={rig} k={k} mood={mood} />
        </View>
      </View>
    </RNHostView>
  );
}

const TYPE_MS = 40;
const FLAP_MS = 88;

/** The text comes out a little at a time. A repeat of the same text stays put. */
export function useSpoken(text: string): { shown: string; talking: boolean } {
  const [shown, setShown] = useState('');
  useEffect(() => {
    let length = 0;
    setShown('');
    if (!text) return;
    const ticker = setInterval(() => {
      length += 2;
      setShown(text.slice(0, length));
      if (length >= text.length) clearInterval(ticker);
    }, TYPE_MS);
    return () => clearInterval(ticker);
  }, [text]);
  return { shown, talking: shown.length < text.length };
}

/** How far the mouth opens for each letter: wide for vowels, a little for consonants, shut between words. */
export function mouthFor(letter: string | undefined, dice: number): number {
  if (!letter || /[\s.,!?:;"'()-]/.test(letter)) return 0;
  if (/[aeıioöuüAEIİOÖUÜ]/.test(letter)) return dice > 0.45 ? 3 : 2;
  return dice > 0.8 ? 2 : 1;
}

/** Flaps the jaw along with the text. It goes by the letters, so it pauses between words like a real mouth. */
export function useFlap(text: string, jaw: Animated.Value) {
  useEffect(() => {
    if (!text) {
      Animated.timing(jaw, { toValue: 0, duration: 60, useNativeDriver: true }).start();
      return;
    }
    let at = 0;
    const ticker = setInterval(() => {
      if (at >= text.length) {
        clearInterval(ticker);
        Animated.timing(jaw, { toValue: 0, duration: 70, useNativeDriver: true }).start();
        return;
      }
      Animated.timing(jaw, { toValue: mouthFor(text[at], Math.random()), duration: 45, useNativeDriver: true }).start();
      at += Math.round(FLAP_MS / TYPE_MS) * 2;
    }, FLAP_MS);
    return () => {
      clearInterval(ticker);
      jaw.setValue(0);
    };
  }, [jaw, text]);
}

export function Bubble({ text }: { text: string }) {
  const colors = useMaterialColors();
  return (
    <Surface color={colors.secondaryContainer} contentColor={colors.onSecondaryContainer} shape={rounded(20)} modifiers={[weight(1)]}>
      <Text modifiers={[padding(14, 12, 14, 12)]} style={{ typography: 'bodyMedium' }}>
        {text || ' '}
      </Text>
    </Surface>
  );
}

/** On its own so that each new letter redraws the words, not the whole room. */
function SpokenText({ line }: { line: string }) {
  const { shown } = useSpoken(line);
  return <RNText style={styles.speechText}>{shown}</RNText>;
}

/** A bubble over a scene, with its tail pointing at whoever is talking. */
export function SpeechBubble({ line, left, top, width, tail }: { line: string; left: number; top: number; width: number; tail: number }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left, top, width }}>
      <View style={styles.speech}>
        <SpokenText line={line} />
      </View>
      <View style={[styles.speechTail, { left: tail }]} />
    </View>
  );
}

function isAsleep(gpu: GpuState | null | undefined): boolean {
  if (!gpu || gpu.mode === 'phone' || gpu.llmActive) return false;
  return !!gpu.blocked || !!gpu.keepOffSeconds || gpu.gpuOwner === 'job' || gpu.gpuOwner === 'image' || gpu.mode === 'compute';
}

const GREETING = 'Merhaba patron, kontrol yapmaya hazırım.';
const TAP_LINE = 'Emredersiniz patron, hemen bakıyorum.';
const FED_UP_LINE = 'Yav patron, adamı hasta etme. Bak yapıyoruz işte, az sabırlı ol amına koyim.';
const FED_UP_TAPS = 4;
const FED_UP_WINDOW_MS = 6000;
const FED_UP_MS = 5000;

function sleepLine(gpu: GpuState | null | undefined): string {
  const name = gpu?.imageAppName ?? 'görsel uygulaması';
  const imageApp = name.charAt(0).toLocaleUpperCase('tr') + name.slice(1);
  if (gpu?.gpuOwner === 'image') return `${imageApp} çalışıyor patron, ben biraz uyuyorum. Dokunursanız kalkarım.`;
  if (gpu?.mode === 'compute') return 'GPU işlere ayrıldı patron, ben uyuyorum. Dokunursanız kalkarım.';
  if (gpu?.gpuOwner === 'job') return "Aziz Bey GPU'yu işe verdi patron, ben biraz uyuyorum. Dokunursanız kalkarım.";
  if (gpu?.keepOffSeconds) return 'Yeni iş bekleniyormuş patron, uyuyorum. Dokunursanız kalkarım.';
  return 'Şu an uyuyorum patron. Dokunursanız kalkar, yine de kontrol ederim.';
}

function shortTime(iso: string, now: number): string {
  return timeLeft(iso, now).replace(' kaldı', '').replace(' saat', ' sa').replace(' gün', ' gün');
}

/** What goes on the board: the nearest deadlines, as a plan. */
export function boardLines(upcoming: Upcoming[] | undefined, now: number): string[] {
  const next = (upcoming ?? []).slice(0, 3).map((item) => {
    const course = (item.course || item.title).split(/[\s(-]/)[0].slice(0, 9);
    return `${course}: ${shortTime(item.dueAt, now)}`;
  });
  return next.length ? ['PLAN', ...next] : ['PLAN', 'Şimdilik', 'boş :)'];
}

// Remembered between visits to this page, so he does not walk out of the house again each time.
let introDone = false;
let lastBoard: string[] = [];

const TAP_LINE_MS = 2300;
const LOOK_MS = 2400;
const SAVE_MS = 2200;
const GREET_HOLD_MS = 6000;
const RESULT_MS = 8000;
const SLEEP_LINE_MS = 7000;
const GPU_POLL_MS = 20000;

// Where things are, in the room's own coordinates
const ROOM_WIDTH_U = 8;
const SPOT = {
  bedside: { x: -2.75, z: -1.3 },
  housefront: { x: -2.75, z: 0.25 },
  seat: { x: -0.15, z: 0.05 },
  board: { x: 1.6, z: -0.9 },
};
const SCREEN_RECT = { x0: -0.55, x1: 1.05, y0: 1.46, y1: 2.46, z: -1.38 };
const BOARD_RECT = { x0: 2.3, x1: 3.84, y0: 1.2, y1: 3.0, z: -2.27 };

/** What a guest can do in the room. */
export type RoomControls = {
  rig: Rig;
  /** dp per unit of the room, and the size of the room in dp. */
  scale: number;
  width: number;
  height: number;
  k: number;
  seat: { x: number; z: number };
  place: (spot: { x: number; z: number }) => { x: number; y: number };
  /** A line in the bubble over a spot of the room. Only his own lines move Kamil's mouth. */
  say: (line: string, byGuest: boolean, overX: number) => void;
  walkTo: (spot: { x: number; z: number }, view: number, flip: boolean, unitsPerSecond?: number) => Promise<void>;
  face: (view: number, flip?: boolean) => Promise<void>;
  standUp: () => Promise<void>;
  sitDown: () => Promise<void>;
  setTyping: (on: boolean) => void;
};

export type Guest = {
  /** Drawn over everything else in the room. */
  Layer: React.ComponentType<{ scale: number; k: number; width: number; height: number; onReady: (visit: (room: RoomControls) => Promise<void>) => void }>;
};

const GUEST_HOLD_MS = 10000;
const GUEST_HINT_MS = 3000; // from here the door trembles, so a finger on the house knows something is coming
const SHORT_TAP_MS = 500;

/**
 * Kamil's room on the main page, with his house on the left, his computer in the middle and his board on the right.
 * Tapping really checks: he looks at the computer while Canvas and mail are checked, writes the nearest deadlines
 * on the board while this page reloads, then goes back to enter it all. What he says at the end comes from the real
 * result. When the model is off the GPU he goes home to sleep; the door turns to glass only while he sleeps.
 */
export function TodayKamil({ connection, gpu: gpuProp, upcoming, onUpdated, guest }: {
  connection: Connection;
  gpu?: GpuState | null;
  upcoming?: Upcoming[];
  onUpdated: () => Promise<unknown>;
  guest?: Guest | null;
}) {
  const window = useWindowDimensions();
  const width = window.width - 32;
  const scale = width / ROOM_WIDTH_U; // dp for one unit of the room
  const height = width * (STAGE.h / STAGE.w);
  const k = scale / CANVAS.unit;
  const place = useCallback((spot: { x: number; z: number }) => {
    const sin = Math.sin(STAGE.elev);
    const pxPerU = STAGE.unit;
    const u = STAGE.ox / pxPerU;
    const top = STAGE.oy / pxPerU;
    return { x: (spot.x + u) * scale, y: (top + spot.z * sin) * scale };
  }, [scale]);

  const [polled, setPolled] = useState<GpuState | undefined>();
  useEffect(() => setPolled(undefined), [gpuProp]);
  useEffect(() => {
    if (connection.mode !== 'server') return;
    let live = true;
    const ticker = setInterval(() => {
      api.gpu(connection).then((next) => { if (live) setPolled(next); }, () => undefined);
    }, GPU_POLL_MS);
    return () => {
      live = false;
      clearInterval(ticker);
    };
  }, [connection]);
  const gpu = polled ?? gpuProp;

  const rig = useRig(Y180);
  const posX = useRef(new Animated.Value(place(SPOT.seat).x)).current;
  const posY = useRef(new Animated.Value(place(SPOT.seat).y)).current;
  const spotNow = useRef(place(SPOT.seat));
  const doorSwing = useRef(new Animated.Value(0)).current; // 0 shut, 1 open
  const doorGlass = useRef(new Animated.Value(0)).current; // 0 solid, 1 see-through
  const screenScroll = useRef(new Animated.Value(0)).current;
  const dream = useRef(new Animated.Value(0)).current;
  const [lying, setLying] = useState(false);
  const [saying, setSaying] = useState('');
  const [bubbleAt, setBubbleAt] = useState<'seat' | 'board' | 'house'>('seat');
  const [screen, setScreen] = useState<'off' | 'mail' | 'check' | 'save'>('mail');
  const [board, setBoard] = useState<string[]>(lastBoard);
  const [typing, setTyping] = useState(true);
  const [scribbling, setScribbling] = useState(false);
  const [guestTalking, setGuestTalking] = useState(false);
  const [bubbleX, setBubbleX] = useState<number | null>(null);
  useFlap(guestTalking ? '' : saying, rig.jaw);
  useLife(rig, !lying);
  useLoop(rig.idle, 2800);
  useLoop(rig.typing, 560, typing);
  useLoop(rig.scribble, 520, scribbling);
  useLoop(dream, 2600, lying);
  useRowSteps(screenScroll, screen === 'check', screen !== 'off' && screen !== 'save');

  const alive = useRef(true);
  const where = useRef<'house' | 'bed' | 'seat' | 'board'>('seat');
  const facing = useRef(Y180);
  const flipped = useRef(false);
  const running = useRef(false);
  const checking = useRef(false);
  const wanted = useRef({ check: false, greet: false, visit: false, sleep: isAsleep(gpu), known: gpu !== undefined });
  const upcomingNow = useRef(upcoming);
  upcomingNow.current = upcoming;
  const gpuNow = useRef(gpu);
  gpuNow.current = gpu;
  const driveRef = useRef<() => void>(() => undefined);

  // Small steps the longer routines are made of
  const animate = useCallback((animation: Animated.CompositeAnimation) => new Promise<void>((resolve) => {
    animation.start(() => resolve());
  }), []);
  const hold = useCallback(async (ms: number, stop?: () => boolean) => {
    const until = Date.now() + ms;
    while (alive.current && Date.now() < until && !stop?.()) await PAUSE(Math.min(120, until - Date.now()));
  }, []);
  const moving = useRef(0);
  const whileMoving = useCallback(async (work: () => Promise<unknown>) => {
    moving.current += 1;
    try {
      await work();
    } finally {
      moving.current -= 1;
    }
  }, []);
  const face = useCallback((target: number, flip = false) => (
    whileMoving(() => turnRobot(rig, facing, flipped, target, flip, () => alive.current))
  ), [rig, whileMoving]);
  const walkTo = useCallback(async (spot: { x: number; z: number }, face_: number, flip: boolean, unitsPerSecond = 1.45) => {
    await whileMoving(async () => {
      const target = place(spot);
      const distance = Math.hypot(target.x - spotNow.current.x, target.y - spotNow.current.y) / scale;
      spotNow.current = target;
      await face(face_, flip);
      const steps = Animated.loop(Animated.timing(rig.walk, { toValue: 1, duration: WALK_MS, easing: Easing.linear, useNativeDriver: true }));
      steps.start();
      await animate(Animated.parallel([
        Animated.timing(posX, { toValue: target.x, duration: distance / unitsPerSecond * 1000, easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(posY, { toValue: target.y, duration: distance / unitsPerSecond * 1000, easing: Easing.linear, useNativeDriver: true }),
      ]));
      steps.stop();
      rig.walk.setValue(0);
    });
  }, [animate, face, place, posX, posY, rig, scale, whileMoving]);
  const sitDown = useCallback(async () => {
    await whileMoving(() => animate(Animated.timing(rig.sit, { toValue: 1, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true })));
    setTyping(true);
  }, [animate, rig, whileMoving]);
  const standUp = useCallback(async () => {
    setTyping(false);
    await whileMoving(() => animate(Animated.timing(rig.sit, { toValue: 0, duration: 240, easing: Easing.out(Easing.quad), useNativeDriver: true })));
  }, [animate, rig, whileMoving]);
  const say = useCallback((line: string, at: 'seat' | 'board' | 'house' = 'seat') => {
    setBubbleAt(at);
    setSaying(line);
  }, []);

  // Tapped too many times: he stops, turns to the boss, tells him and shows him the fig, then carries on where he was.
  const lineNow = useRef({ line: '', at: 'seat' as 'seat' | 'board' | 'house' });
  lineNow.current = { line: saying, at: bubbleAt };
  const typingNow = useRef(typing);
  typingNow.current = typing;
  const scribblingNow = useRef(scribbling);
  scribblingNow.current = scribbling;
  const armIsUp = useRef(false);
  const tapTimes = useRef<number[]>([]);
  const fedUpWanted = useRef(false);
  const fedUpRunning = useRef<Promise<void> | null>(null);
  const liftArm = useCallback((toValue: number) => (
    animate(Animated.timing(rig.armUp, { toValue, duration: 260, easing: Easing.out(Easing.quad), useNativeDriver: true }))
  ), [animate, rig]);
  const fedUp = useCallback(() => {
    fedUpWanted.current = false;
    const run = async () => {
      const before = { ...lineNow.current, typing: typingNow.current, scribbling: scribblingNow.current, arm: armIsUp.current };
      if (where.current === 'bed' || where.current === 'house') {
        // He answers from his bed, without getting up for it.
        say(FED_UP_LINE, 'house');
        await PAUSE(FED_UP_MS);
        say(before.line, before.at);
        return;
      }
      const view = facing.current;
      const flip = flipped.current;
      const turn = (target: number, side: boolean) => turnRobot(rig, facing, flipped, target, side, () => alive.current);
      setTyping(false);
      setScribbling(false);
      if (before.arm) await liftArm(0);
      await turn(Y20, false);
      say(FED_UP_LINE, before.at);
      setScribbling(true);
      await animate(Animated.timing(rig.figOn, { toValue: 1, duration: 120, useNativeDriver: true }));
      await PAUSE(FED_UP_MS);
      setScribbling(false);
      await animate(Animated.timing(rig.figOn, { toValue: 0, duration: 160, useNativeDriver: true }));
      say(before.line, before.at);
      await turn(view, flip);
      if (before.arm) await liftArm(1);
      setTyping(before.typing);
      setScribbling(before.scribbling);
    };
    fedUpRunning.current = run().finally(() => { fedUpRunning.current = null; });
    return fedUpRunning.current;
  }, [animate, liftArm, rig, say]);
  /** Waits out his complaint, or has it now if it is due. The routines call this before each thing they show. */
  const settle = useCallback(async () => {
    while (alive.current) {
      if (fedUpRunning.current) await fedUpRunning.current;
      else if (fedUpWanted.current) await fedUp();
      else return;
    }
  }, [fedUp]);

  // Moving between the places
  const leaveHouse = useCallback(async () => {
    moving.current += 1;
    setLying(false);
    setScreen('mail');
    showView(rig, Y20);
    facing.current = Y20;
    flipped.current = false;
    rig.flip.setValue(1);
    const inside = place(SPOT.bedside);
    spotNow.current = inside;
    posX.setValue(inside.x);
    posY.setValue(inside.y);
    await animate(Animated.timing(doorGlass, { toValue: 0, duration: 400, useNativeDriver: true }));
    await animate(Animated.timing(doorSwing, { toValue: 1, duration: 320, easing: Easing.out(Easing.quad), useNativeDriver: true }));
    await walkTo(SPOT.housefront, Y20, false);
    // It swings shut behind him, once he is clear of it.
    Animated.timing(doorSwing, { toValue: 0, duration: 300, delay: 800, useNativeDriver: true }).start();
    await walkTo(SPOT.seat, Y90, false);
    await sitDown();
    await face(Y180);
    where.current = 'seat';
    moving.current -= 1;
  }, [animate, doorGlass, doorSwing, face, place, posX, posY, rig, sitDown, walkTo]);

  const goHome = useCallback(async () => {
    moving.current += 1;
    setScreen('off');
    await standUp();
    // It is open by the time he gets there, so it never swings through him.
    Animated.timing(doorSwing, { toValue: 1, duration: 300, delay: 800, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    await walkTo(SPOT.housefront, Y90, true);
    await walkTo(SPOT.bedside, Y180, false);
    await animate(Animated.timing(doorSwing, { toValue: 0, duration: 280, useNativeDriver: true }));
    // Behind the shut door he lies down, then the door turns to glass.
    setLying(true);
    showView(rig, Y90);
    facing.current = Y90;
    await PAUSE(200);
    await animate(Animated.timing(doorGlass, { toValue: 1, duration: 800, useNativeDriver: true }));
    where.current = 'bed';
    moving.current -= 1;
  }, [animate, doorGlass, doorSwing, rig, standUp, walkTo]);

  const greet = useCallback(async () => {
    if (where.current === 'bed') {
      say(sleepLine(gpuNow.current), 'house');
      await hold(SLEEP_LINE_MS, () => wanted.current.check || !wanted.current.sleep);
      say('');
      return;
    }
    setTyping(false);
    await face(Y20);
    say(GREETING);
    await hold(GREET_HOLD_MS, () => wanted.current.check);
    say('');
    if (!wanted.current.check) {
      await face(Y180);
      setTyping(true);
    }
  }, [face, hold, say]);

  /** Checks everything, for real, in the order the boss asked for. */
  const check = useCallback(async () => {
    const seenBefore = api.events(connection).catch(() => []);
    await settle();
    if (where.current === 'bed' || where.current === 'house') await leaveHouse();

    // The boss called: he turns to him and answers before going back to work
    await settle();
    say('');
    setTyping(false);
    await face(Y20);
    say(TAP_LINE);
    await hold(TAP_LINE_MS);
    await settle();
    const before = await seenBefore;
    const newest = before.reduce((most, event) => Math.max(most, event.id), 0);

    // Then a look at the computer
    say('');
    await face(Y180);
    setTyping(true);
    setScreen('check');
    say('Bilgisayara bakıyorum.');
    const [checked] = await Promise.all([
      api.refreshEvents(connection).catch(() => ({ refreshed: false })),
      PAUSE(LOOK_MS),
    ]);

    // Then over to the board, while this page and the others catch up
    await settle();
    say('');
    await standUp();
    setScreen('mail');
    where.current = 'board';
    await walkTo(SPOT.board, Y90, false);
    await face(Y135);
    await whileMoving(() => animate(Animated.timing(rig.armUp, { toValue: 1, duration: 300, easing: Easing.out(Easing.back(1.4)), useNativeDriver: true })));
    armIsUp.current = true;
    say('Planlarınızı yazıyorum.', 'board');
    setScribbling(true);
    const [after] = await Promise.all([
      api.events(connection).catch(() => before),
      onUpdated().catch(() => undefined),
      api.drafts(connection).catch(() => undefined),
      chat.refresh(connection),
    ]);
    const lines = boardLines(upcomingNow.current, Date.now());
    setBoard([]);
    for (let line = 1; line <= lines.length && alive.current; line++) {
      await settle();
      setBoard(lines.slice(0, line));
      await PAUSE(620);
    }
    lastBoard = lines;
    await settle();
    setScribbling(false);
    armIsUp.current = false;
    await whileMoving(() => animate(Animated.timing(rig.armUp, { toValue: 0, duration: 240, useNativeDriver: true })));

    // Back to the computer to enter it all
    await settle();
    say('');
    await walkTo(SPOT.seat, Y90, true);
    await sitDown();
    await face(Y180);
    where.current = 'seat';
    await settle();
    setScreen('save');
    say('Sisteme geçiriyorum.');
    await hold(SAVE_MS);
    await settle();
    setScreen('mail');

    // And the result, to the boss's face
    setTyping(false);
    await face(Y20);
    const fresh = after.filter((event) => event.id > newest).length;
    say(!checked.refreshed
      ? 'Üzgünüm patron, kontrolü bitiremedim. Son bildiklerim duruyor.'
      : fresh
        ? `Bitti patron, ${fresh} yeni şey var. Bildirimler'e koydum.`
        : 'Bitti patron, yeni bir şey yok. Her şey güncel.');
    await hold(RESULT_MS, () => wanted.current.check);
    await settle();
    say('');
    await face(Y180);
    setTyping(true);
    await settle();
  }, [animate, connection, face, hold, leaveHouse, onUpdated, rig, say, settle, sitDown, standUp, walkTo, whileMoving]);

  // A guest turns up only when the boss has held his finger on the house for a long time.
  const visit = useRef<((room: RoomControls) => Promise<void>) | null>(null);
  const onGuestReady = useCallback((run: (room: RoomControls) => Promise<void>) => { visit.current = run; }, []);
  const receiveGuest = useCallback(async () => {
    const run = visit.current;
    if (!run) return;
    await run({
      rig, scale, width, height, k, place, seat: SPOT.seat, walkTo, face, standUp, sitDown, setTyping,
      say: (line, byGuest, overX) => {
        setGuestTalking(byGuest && !!line);
        setBubbleX(overX);
        setSaying(line);
      },
    });
    setGuestTalking(false);
    setBubbleX(null);
    setSaying('');
  }, [face, height, k, place, rig, scale, sitDown, standUp, walkTo, width]);
  const onHold = useCallback(() => {
    if (!visit.current) return;
    wanted.current.visit = true;
    driveRef.current();
  }, []);

  // The hold on the house has its own timer. The long press Pressable offers gives up when a finger drifts ten points,
  // and over ten seconds a real finger always does.
  const tremble = useRef(new Animated.Value(0)).current;
  const holdTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const trembling = useRef<Animated.CompositeAnimation | null>(null);
  const holdStart = useRef(0);
  const stopHold = useCallback(() => {
    holdTimers.current.forEach(clearTimeout);
    holdTimers.current = [];
    trembling.current?.stop();
    trembling.current = null;
    tremble.setValue(0);
  }, [tremble]);
  const startHold = useCallback(() => {
    stopHold();
    holdStart.current = Date.now();
    holdTimers.current = [
      setTimeout(() => {
        trembling.current = Animated.loop(Animated.sequence([
          Animated.timing(tremble, { toValue: 1, duration: 70, useNativeDriver: true }),
          Animated.timing(tremble, { toValue: -1, duration: 140, useNativeDriver: true }),
          Animated.timing(tremble, { toValue: 0, duration: 70, useNativeDriver: true }),
          Animated.delay(240),
        ]));
        trembling.current.start();
      }, GUEST_HINT_MS),
      setTimeout(() => {
        holdStart.current = 0;
        stopHold();
        onHold();
      }, GUEST_HOLD_MS),
    ];
  }, [onHold, stopHold, tremble]);
  useEffect(() => stopHold, [stopHold]);

  /** One thing at a time: whatever is wanted next runs when the last one is done. */
  const drive = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (alive.current) {
        const want = wanted.current;
        if (want.visit) {
          want.visit = false;
          if (where.current === 'bed' || where.current === 'house') await leaveHouse();
          moving.current += 1;
          await receiveGuest();
          moving.current -= 1;
        } else if (want.check) {
          want.check = false;
          checking.current = true;
          await check();
          checking.current = false;
          want.check = false;
        } else if (want.sleep && where.current !== 'bed') {
          if (where.current === 'house') {
            // He has not come out yet today: he is simply still in bed.
            setLying(true);
            showView(rig, Y90);
            facing.current = Y90;
            setScreen('off');
            await animate(Animated.timing(doorGlass, { toValue: 1, duration: 700, useNativeDriver: true }));
            where.current = 'bed';
            want.greet = true;
          } else {
            await goHome();
            want.greet = true;
          }
        } else if (!want.sleep && (where.current === 'bed' || where.current === 'house')) {
          await leaveHouse();
          want.greet = true;
        } else if (want.greet) {
          want.greet = false;
          await greet();
        } else {
          break;
        }
      }
    } finally {
      running.current = false;
    }
  }, [animate, check, doorGlass, goHome, greet, leaveHouse, receiveGuest, rig]);
  driveRef.current = () => void drive();

  // Opening the app: the first time he comes out of his house; after that he is already at his desk.
  useEffect(() => {
    alive.current = true;
    if (!introDone) {
      introDone = true;
      where.current = 'house';
      rig.sit.setValue(0);
      showView(rig, Y20);
      facing.current = Y20;
      const inside = place(SPOT.bedside);
      spotNow.current = inside;
      posX.setValue(inside.x);
      posY.setValue(inside.y);
      setTyping(false);
      setScreen('off');
    } else {
      rig.sit.setValue(1);
    }
    const started = setTimeout(() => driveRef.current(), wanted.current.known ? 300 : 1800);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        wanted.current.greet = true;
        driveRef.current();
      }
    });
    return () => {
      alive.current = false;
      clearTimeout(started);
      appState.remove();
    };
  }, [place, posX, posY, rig]);

  // The model going off the GPU or coming back moves him
  useEffect(() => {
    wanted.current.sleep = isAsleep(gpu);
    wanted.current.known = gpu !== undefined;
    if (gpu !== undefined) driveRef.current();
  }, [gpu]);

  const onTap = useCallback(() => {
    const now = Date.now();
    tapTimes.current = [...tapTimes.current.filter((at) => now - at < FED_UP_WINDOW_MS), now];
    if (tapTimes.current.length >= FED_UP_TAPS && !fedUpRunning.current && !fedUpWanted.current) {
      tapTimes.current = [];
      fedUpWanted.current = true;
      // Right away if he is standing still; otherwise as soon as he finishes this move.
      if (moving.current === 0 && checking.current) void fedUp();
    }
    if (checking.current) return;
    wanted.current.check = true;
    driveRef.current();
  }, [fedUp]);

  const worldX = (x: number) => (x + STAGE.ox / STAGE.unit) * scale;
  const worldY = (y: number, z: number) => (STAGE.oy / STAGE.unit - (y * Math.cos(STAGE.elev) - z * Math.sin(STAGE.elev))) * scale;
  const px = width / STAGE.w;
  const door = STAGE.door;
  const bedAt = { x: worldX(-1.88), y: worldY(1.0, -1.7) };
  const spotFor = { seat: place(SPOT.seat).x, board: place(SPOT.board).x, house: worldX(SPOT.housefront.x) };
  const bubbleWidth = Math.min(width * 0.64, 250);
  const bubbleOver = bubbleX ?? spotFor[bubbleAt];
  const bubbleLeft = Math.max(10, Math.min(width - bubbleWidth - 10, bubbleOver - bubbleWidth / 2 + (bubbleX === null && bubbleAt === 'house' ? width * 0.2 : 0)));
  const tail = Math.max(14, Math.min(bubbleWidth - 26, bubbleOver - bubbleLeft - 6));
  const rectOf = (area: typeof SCREEN_RECT) => ({
    left: (area.x0 + STAGE.ox / STAGE.unit) * scale,
    width: (area.x1 - area.x0) * scale,
    top: (STAGE.oy / STAGE.unit - (area.y1 * Math.cos(STAGE.elev) - area.z * Math.sin(STAGE.elev))) * scale,
    height: (area.y1 - area.y0) * Math.cos(STAGE.elev) * scale,
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const screenRect = useMemo(() => rectOf(SCREEN_RECT), [scale]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const boardRect = useMemo(() => rectOf(BOARD_RECT), [scale]);

  return (
    <RNHostView modifiers={[size(width, height)]}>
      <Pressable style={styles.host} onPress={onTap} accessibilityRole="button" accessibilityLabel="Kamil: her şeyi kontrol et">
        <View style={{ width, height, borderRadius: 24, overflow: 'hidden', backgroundColor: '#17120e' }}>
          <Image source={STAGE.src} fadeDuration={0} style={{ position: 'absolute', left: 0, top: 0, width, height }} />
          <ComputerScreen rect={screenRect} mode={screen} scroll={screenScroll} />
          <PlanBoard rect={boardRect} lines={board} />

          {/* The robot and his shadow */}
          <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width, height, transform: [{ translateX: posX }, { translateY: posY }], opacity: lying ? 0 : 1 }}>
            <Image source={STAGE.shadow} fadeDuration={0} style={{ position: 'absolute', left: -0.66 * scale, top: -0.17 * scale, width: 1.32 * scale, height: 0.42 * scale, opacity: 0.85 }} />
            <RobotBody views={KAMIL} rig={rig} k={k} mood={lying ? 'asleep' : 'happy'} />
          </Animated.View>
          {lying ? (
            // Asleep on the bed, seen through the glass door. He is a little smaller to fit the little house.
            <View pointerEvents="none" style={{ position: 'absolute', left: bedAt.x, top: bedAt.y, width, height, transformOrigin: [0, 0, 0], transform: [{ rotate: '-90deg' }, { scale: 0.72 }] }}>
              <RobotBody views={KAMIL} rig={rig} k={k} mood="asleep" lying />
            </View>
          ) : null}

          {/* The door is in front of him while he is inside */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute', left: door.x * px, top: door.y * px, width: door.w * px, height: door.h * px,
              opacity: doorGlass.interpolate({ inputRange: [0, 1], outputRange: [1, 0.16] }),
              transformOrigin: [0, door.h * px / 2, 0],
              transform: [
                { translateX: tremble.interpolate({ inputRange: [-1, 1], outputRange: [-1.6, 1.6] }) },
                { scaleX: doorSwing.interpolate({ inputRange: [0, 1], outputRange: [1, 0.12] }) },
              ],
            } as unknown as AnimatedStyle}>
            <Image source={door.src} fadeDuration={0} style={{ width: door.w * px, height: door.h * px }} />
          </Animated.View>

          {lying ? <Sleeping left={worldX(-3.1)} top={worldY(1.6, -1.7)} cycle={dream} /> : null}
          {guest ? <guest.Layer scale={scale} k={k} width={width} height={height} onReady={onGuestReady} /> : null}
          {guest ? (
            // The house takes a quick tap like the rest of the room; a hold is the hidden way in. It keeps the finger, so the
            // page cannot take it away by starting to scroll.
            <Pressable
              cancelable={false}
              blockNativeResponder
              pressRetentionOffset={{ top: 400, bottom: 400, left: 400, right: 400 }}
              onPressIn={startHold}
              onPressOut={() => {
                const held = holdStart.current ? Date.now() - holdStart.current : Infinity;
                stopHold();
                if (held < SHORT_TAP_MS) onTap();
              }}
              style={{ position: 'absolute', left: 0, top: worldY(3.6, -0.6), width: worldX(-1.55), bottom: 0 }}
            />
          ) : null}

          {saying ? <SpeechBubble line={saying} left={bubbleLeft} top={10} width={bubbleWidth} tail={tail} /> : null}
        </View>
      </Pressable>
    </RNHostView>
  );
}

const SCREEN_ROWS = 5;

/** A list creeping along at a few pixels a second jitters on any screen, so the rows step along with a soft ease. */
function useRowSteps(value: Animated.Value, fast: boolean, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const moves: Animated.CompositeAnimation[] = [];
    for (let row = 1; row <= SCREEN_ROWS; row++) {
      moves.push(Animated.timing(value, { toValue: row / SCREEN_ROWS, duration: fast ? 240 : 560, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }));
      moves.push(Animated.delay(fast ? 110 : 1250));
    }
    const run = Animated.loop(Animated.sequence(moves));
    run.start();
    return () => run.stop();
  }, [enabled, fast, value]);
}

/** What is on his screen: mail going by, a fast run while checking, a bar while entering it into the system. */
const ComputerScreen = memo(function ComputerScreen({ rect, mode, scroll }: {
  rect: { left: number; top: number; width: number; height: number };
  mode: 'off' | 'mail' | 'check' | 'save';
  scroll: Animated.Value;
}) {
  if (mode === 'off') return null;
  const row = rect.height / SCREEN_ROWS;
  const rows = [0.82, 0.55, 0.7, 0.42, 0.9, 0.82, 0.55, 0.7, 0.42, 0.9];
  return (
    <View pointerEvents="none" style={{ position: 'absolute', ...rect, overflow: 'hidden', backgroundColor: '#13324d', opacity: 0.94 }}>
      {mode === 'save' ? (
        <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: rect.width * 0.14 }}>
          <RNText numberOfLines={1} style={{ color: '#d8ecff', fontSize: row * 0.72, fontWeight: '700', marginBottom: row * 0.3 }}>Sisteme geçiriliyor</RNText>
          <SaveBar height={row * 0.42} />
        </View>
      ) : (
        <Animated.View style={{ transform: [{ translateY: scroll.interpolate({ inputRange: [0, 1], outputRange: [0, -row * SCREEN_ROWS] }) }] }}>
          {rows.map((amount, index) => (
            <View key={index} style={{ height: row, flexDirection: 'row', alignItems: 'center', paddingHorizontal: rect.width * 0.05, gap: rect.width * 0.03, backgroundColor: index % 5 === 0 ? 'rgba(143,211,255,0.13)' : undefined }}>
              <View style={{ width: row * 0.45, height: row * 0.32, borderRadius: 1, backgroundColor: index % 5 === 0 ? '#ffd27a' : '#8fd3ff' }} />
              <View style={{ width: `${amount * 78}%`, height: row * 0.18, borderRadius: 1, backgroundColor: '#b9dcf7', opacity: 0.85 }} />
            </View>
          ))}
        </Animated.View>
      )}
    </View>
  );
});

function SaveBar({ height }: { height: number }) {
  const fill = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fill, { toValue: 1, duration: SAVE_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: true }).start();
  }, [fill]);
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: '#0a1c2c', overflow: 'hidden' }}>
      <Animated.View style={{ flex: 1, backgroundColor: '#8fd3ff', transformOrigin: 'left', transform: [{ scaleX: fill }] }} />
    </View>
  );
}

const PlanBoard = memo(function PlanBoard({ rect, lines }: { rect: { left: number; top: number; width: number; height: number }; lines: string[] }) {
  const size_ = rect.width / 8.4;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', ...rect, gap: size_ * 0.28 }}>
      {lines.map((line, index) => (
        <RNText key={`${index}-${line}`} numberOfLines={1} style={{ fontFamily: 'casual', color: index === 0 ? '#8c1f15' : '#0d1830', fontSize: index === 0 ? size_ * 1.2 : size_, fontWeight: '700' }}>
          {line}
        </RNText>
      ))}
    </View>
  );
});

function Sleeping({ left, top, cycle }: { left: number; top: number; cycle: Animated.Value }) {
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left, top }}>
      {[0, 0.33, 0.66].map((phase, index) => (
        <Animated.Text
          key={phase}
          style={{
            position: 'absolute', left: index * 11, fontSize: 11 + index * 3, fontWeight: '800', color: '#f0e3c8',
            opacity: cycle.interpolate({ inputRange: [0, phase, Math.min(phase + 0.3, 0.99), 1], outputRange: [0, 0, 0.95, 0] }),
            transform: [{ translateY: cycle.interpolate({ inputRange: [0, 1], outputRange: [8, -18 - index * 6] }) }],
          }}>
          z
        </Animated.Text>
      ))}
    </View>
  );
}

// Kamil in the chat

const CHAT_LINE = 'Buyurun patron, sizi dinliyorum.';
const ANSWER_LINE = 'Buyurun patron.';
const ANSWER_FRESH_MS = 2500;
const ANSWER_LINE_MS = 4000;

// The walk in plays once a session. The answer's "buyurun" is only for an answer that has just landed, not for an old
// conversation being opened.
let chatGreeted = false;
let answerLandedAt = 0;

/** A strip of the page with Kamil standing in it and his speech bubble beside him. */
function KamilStrip({ width, height, rig, posX, line, bubbleLeft, opacity = 1, glances = true, props }: {
  width: number;
  height: number;
  rig: Rig;
  posX: Animated.Value | number;
  line: string;
  bubbleLeft: number;
  opacity?: Animated.Value | number;
  /** Off while he is looking at something on purpose. */
  glances?: boolean;
  /** What he holds or what appears over him. The ground point he stands on is at (0, 0) of it. */
  props?: (unit: number) => React.ReactNode;
}) {
  const k = height / (2.95 * CANVAS.unit);
  const unit = CANVAS.unit * k;
  useFlap(line, rig.jaw);
  useLife(rig, true, glances);
  useLoop(rig.idle, 2600);
  return (
    <View pointerEvents="none" style={{ width, height }}>
      <Animated.View
        style={{ position: 'absolute', left: 0, top: height - 0.08 * unit, width, height, opacity, transform: [{ translateX: posX }] }}>
        <Image source={STAGE.shadow} fadeDuration={0} style={{ position: 'absolute', left: -0.66 * unit, top: -0.17 * unit, width: 1.32 * unit, height: 0.42 * unit, opacity: 0.6 }} />
        <RobotBody views={KAMIL} rig={rig} k={k} mood="happy" />
        {props?.(unit)}
      </Animated.View>
      {line ? (
        <View style={{ position: 'absolute', left: bubbleLeft, right: 2, top: height * 0.1 }}>
          <View style={styles.speech}>
            <SpokenText line={line} />
          </View>
          <View style={[styles.speechTail, { bottom: undefined, top: 12, left: -6, transform: [{ rotate: '135deg' }] }]} />
        </View>
      ) : null}
    </View>
  );
}

/** Kamil on the empty chat screen: he walks in, turns to you and asks what you need. */
export function ChatGreeter() {
  const window = useWindowDimensions();
  const width = window.width - 48;
  const height = 112;
  const stand = height * 0.36;
  const first = useRef(!chatGreeted).current;
  const rig = useRig(first ? Y90 : Y20);
  const posX = useRef(new Animated.Value(first ? 0 : stand)).current;
  const fade = useRef(new Animated.Value(first ? 0 : 1)).current;
  const [line, setLine] = useState(first ? '' : CHAT_LINE);
  const facing = useRef(first ? Y90 : Y20);
  const flipped = useRef(false);
  useEffect(() => {
    if (!first) return;
    chatGreeted = true;
    let live = true;
    const steps = Animated.loop(Animated.timing(rig.walk, { toValue: 1, duration: WALK_MS, easing: Easing.linear, useNativeDriver: true }));
    steps.start();
    Animated.timing(fade, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    Animated.timing(posX, { toValue: stand, duration: 950, easing: Easing.linear, useNativeDriver: true }).start(() => {
      steps.stop();
      rig.walk.setValue(0);
      void turnRobot(rig, facing, flipped, Y20, false, () => live).then(() => {
        if (live) setLine(CHAT_LINE);
      });
    });
    return () => {
      live = false;
      steps.stop();
    };
  }, [fade, first, posX, rig, stand]);
  return (
    <RNHostView modifiers={[size(width, height)]}>
      <View style={styles.host}>
        <KamilStrip width={width} height={height} rig={rig} posX={posX} line={line} bubbleLeft={stand * 2 + 8} opacity={fade} />
      </View>
    </RNHostView>
  );
}

type Activity = 'think' | 'check' | 'write';

/** The step labels are fixed strings, so what he acts out is what the model is really doing at that moment. */
export function activityOf(label: string): Activity {
  if (/hazırlıyor|kaydetmeyi|kurmayı/i.test(label)) return 'write';
  if (/bakıyor|okuyor|arıyor|Okunan metin/i.test(label)) return 'check';
  return 'think';
}

/** A sign that comes up beside his head and fades: a question while thinking, a tick while checking. */
function PopSign({ text, unit, color, cycle }: { text: string; unit: number; color: string; cycle: Animated.Value }) {
  return (
    <Animated.Text
      style={{
        position: 'absolute', left: 0.42 * unit, top: -2.42 * unit, fontSize: 0.5 * unit, fontWeight: '800', color,
        opacity: cycle.interpolate({ inputRange: [0, 0.5, 0.62, 0.86, 1], outputRange: [0, 0, 1, 1, 0] }),
        transform: [{ translateY: cycle.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.14 * unit, 0.14 * unit, -0.14 * unit] }) }],
      }}>
      {text}
    </Animated.Text>
  );
}

/** The board he reads from or writes on. A line of it lights up as his eyes get there. */
function Clipboard({ unit, cycle, writing }: { unit: number; cycle: Animated.Value; writing: boolean }) {
  const lines = [0.86, 0.62, 0.78];
  return (
    <View
      style={{
        position: 'absolute', left: -0.36 * unit, top: -1.42 * unit, width: 0.56 * unit, height: 0.72 * unit,
        borderRadius: 0.035 * unit, backgroundColor: '#6d4a2c', padding: 0.05 * unit, transform: [{ rotate: '-7deg' }],
      }}>
      <View style={{ flex: 1, backgroundColor: '#e9dfc8', borderRadius: 0.012 * unit, paddingHorizontal: 0.05 * unit, paddingTop: 0.11 * unit, gap: 0.075 * unit }}>
        {lines.map((length, index) => {
          const from = index / lines.length;
          const to = (index + 1) / lines.length;
          return (
            <View key={length} style={{ height: 0.032 * unit, width: `${length * 100}%`, backgroundColor: '#8b8069', overflow: 'hidden' }}>
              <Animated.View
                style={{
                  flex: 1, backgroundColor: writing ? '#1d2a4a' : '#8c1f15', transformOrigin: 'left',
                  transform: [{ scaleX: cycle.interpolate({ inputRange: [0, from, to, 1], outputRange: [0, 0, 1, writing ? 1 : 0], extrapolate: 'clamp' }) }],
                }}
              />
            </View>
          );
        })}
      </View>
      <View style={{ position: 'absolute', alignSelf: 'center', top: -0.025 * unit, width: 0.2 * unit, height: 0.07 * unit, borderRadius: 0.015 * unit, backgroundColor: '#9aa0a6' }} />
    </View>
  );
}

const THINK_ARM = 0.72;
const CHECK_ARM = 0.26;
const WRITE_ARM = 0.42;
const SIGN_MS = 3400;

/**
 * While an answer is on its way he stays on his spot and acts out the real step: thinking with a hand up and his eyes
 * on the ceiling, or going down a clipboard line by line. The line in the bubble is one of the fixed step labels.
 */
export function WaitingFigure({ label }: { label: string }) {
  const window = useWindowDimensions();
  const width = window.width - 32; // the screen's own padding around this row
  const height = 112;
  const stand = height * 0.36;
  const bubbleLeft = Math.round(stand * 2 + 8);
  const rig = useRig(Y20);
  const activity = activityOf(label);
  const facing = useRef(Y20);
  const flipped = useRef(false);
  const cycle = useRef(new Animated.Value(0)).current;
  useLoop(cycle, activity === 'think' ? SIGN_MS : SIGN_MS * 0.8);
  useLoop(rig.scribble, 620, activity === 'write');

  useEffect(() => () => { answerLandedAt = Date.now(); }, []);
  useEffect(() => {
    let live = true;
    const to = (value: Animated.Value, toValue: number, duration: number) => Animated.timing(value, {
      toValue, duration, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
    });
    const both = (tilt: number, x: number, y: number, duration: number) => Animated.parallel([
      to(rig.headTilt, tilt, duration), to(rig.gazeX, x, duration * 0.4), to(rig.gazeY, y, duration * 0.4),
    ]);
    const moves = activity === 'think'
      ? [both(-0.9, -0.8, -1, 800), Animated.delay(1100), both(0.7, 0.9, -0.9, 900), Animated.delay(1300)]
      : [
        both(0.25, -1, 1, 300), both(0.05, 1, 1, 620), Animated.delay(120),
        both(0.3, -1, 1, 300), both(0.1, 1, 1, 620), Animated.delay(120),
        both(0.35, -1, 1, 300), both(0.15, 0.6, 1, 520), Animated.delay(320),
      ];
    const acting = Animated.loop(Animated.sequence(moves));
    void turnRobot(rig, facing, flipped, activity === 'think' ? Y55 : Y20, false, () => live).then(() => {
      if (!live) return;
      to(rig.armUp, activity === 'think' ? THINK_ARM : activity === 'check' ? CHECK_ARM : WRITE_ARM, 420).start();
      acting.start();
    });
    return () => {
      live = false;
      acting.stop();
    };
  }, [activity, rig]);

  return (
    <RNHostView modifiers={[size(width, height)]}>
      <View style={styles.host}>
        <KamilStrip
          width={width}
          height={height}
          rig={rig}
          posX={stand}
          line={label}
          bubbleLeft={bubbleLeft}
          glances={false}
          props={(unit) => (
            <>
              {activity === 'think' ? null : <Clipboard unit={unit} cycle={cycle} writing={activity === 'write'} />}
              {activity === 'write' ? null : (
                <PopSign text={activity === 'think' ? '?' : '✓'} unit={unit} color={activity === 'think' ? '#c9a24a' : '#3f8f55'} cycle={cycle} />
              )}
            </>
          )}
        />
      </View>
    </RNHostView>
  );
}

/** Under the newest answer: he hands it over with a word, then just stands by. */
export function AnswerFigure() {
  const window = useWindowDimensions();
  const width = window.width - 40;
  const height = 84;
  const rig = useRig(Y20);
  const [line, setLine] = useState('');
  useEffect(() => {
    // Here, not during the render: the waiting figure marks the landing as it unmounts, in this same commit.
    if (Date.now() - answerLandedAt >= ANSWER_FRESH_MS) return;
    setLine(ANSWER_LINE);
    const quiet = setTimeout(() => setLine(''), ANSWER_LINE_MS);
    return () => clearTimeout(quiet);
  }, []);
  return (
    <View style={{ marginTop: 6, marginLeft: 4 }}>
      <KamilStrip width={width} height={height} rig={rig} posX={height * 0.42} line={line} bubbleLeft={height * 0.84 + 6} />
    </View>
  );
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  speech: { backgroundColor: '#f3ecdc', borderRadius: 14, borderWidth: 1.5, borderColor: '#2a221a', paddingHorizontal: 11, paddingVertical: 7 },
  speechText: { color: '#1e1812', fontSize: 13, lineHeight: 17 },
  speechTail: { position: 'absolute', bottom: -7, width: 13, height: 13, backgroundColor: '#f3ecdc', borderRightWidth: 1.5, borderBottomWidth: 1.5, borderColor: '#2a221a', transform: [{ rotate: '45deg' }] },
});
