/**
 * Aziz in the app: his report under the server connection in Settings, and his office. It shows only when the server has a
 * GPU gate; a server without one has no such panel. The report is fixed sentences chosen from the server's state, with no
 * model behind it.
 */
import { Column, RNHostView, Row, Text, useMaterialColors } from '@expo/ui/jetpack-compose';
import { size, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Image, Pressable, Text as RNText, useWindowDimensions, View } from 'react-native';

import { api, ApiError, ServerConnection } from './api';
import { icons } from './icons';
import {
  Figure, KAMIL_FRONT, PAUSE, RobotBody, SpeechBubble, turnRobot, useFlap, useLife, useLoop, useRig, WALK_MS, Y135, Y20, Y90,
} from './kamil';
import type { Mood } from './kamil';
import { AZIZ, CANVAS, OFFICE } from './kamilart/sprites';
import type { GpuState } from './types';
import { Panel, SectionTitle } from './ui';

const REFRESH_MS = 5000;
const RECENT_FAILURE_SECONDS = 15 * 60;
const HOT_GPU_C = 85;
const LOW_RAM_GIB = 3;

export type Report = { aziz: Mood; line: string; kamil: Mood; kamilLine: string };

function minutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

function greeting(hour: number): string {
  if (hour < 6) return 'İyi geceler';
  if (hour < 12) return 'Günaydın';
  if (hour < 18) return 'İyi günler';
  return 'İyi akşamlar';
}

/** What Aziz tells the boss. Every sentence is chosen here from the server's own numbers. */
export function report(state: GpuState | null, now: Date): Report {
  const asleep = { kamil: 'asleep' as Mood, kamilLine: 'Diskte dinleniyor' };
  if (!state) {
    return { aziz: 'worried', line: 'Patron, sunucuya ulaşamıyorum. Tailscale açık mı acaba?', kamil: 'asleep', kamilLine: 'Haber alınamıyor' };
  }
  if (state.mode === 'unknown') {
    return { aziz: 'worried', line: 'Patron, sunucu cevap veriyor ama ben masama ulaşamıyorum. Servisim durmuş olabilir.', kamil: 'asleep', kamilLine: 'Haber alınamıyor' };
  }
  const jobs = state.jobs ?? [];
  const gpuJob = jobs.find((job) => job.gpu && job.status === 'running');
  const cpuJobs = jobs.filter((job) => !job.gpu && job.status === 'running').length;
  const queued = jobs.filter((job) => job.status === 'queued').length;
  const nowSeconds = now.getTime() / 1000;
  const failed = [...jobs].reverse().find(
    (job) => job.status === 'failed' && (job.finishedAt ?? 0) > nowSeconds - RECENT_FAILURE_SECONDS,
  );
  const kamil = state.llmActive
    ? { kamil: 'happy' as Mood, kamilLine: 'Hazır, emrinizde' }
    : !state.blocked && !state.keepOffSeconds
      ? { kamil: 'busy' as Mood, kamilLine: 'Uyanıyor' }
      : asleep;

  let aziz: Mood = 'happy';
  let line: string;
  if ((state.prioritySeconds ?? 0) > 0) {
    line = `Emredersiniz patron. Kamil öncelikte, işleri ${minutes(state.prioritySeconds!)} dakika bekletiyorum.`;
  } else if (state.gpuOwner === 'image') {
    aziz = 'busy';
    const name = state.server?.name ?? state.imageAppName ?? 'görsel uygulaması';
    line = state.server
      ? `Patron, ${name} sunucusu açık. Siz kapatana kadar açık kalır; Kamil diskte bekliyor, kapanınca hemen döner.`
      : `Patron, ${name} çalışıyor. Biter bitmez Kamil'i geri getiririm.`;
  } else if (gpuJob?.server) {
    aziz = 'busy';
    line = `Patron, "${gpuJob.label || gpuJob.id}" sunucusu GPU'da açık. Siz kapatana kadar çalışır; Kamil diskte bekliyor.`;
  } else if (state.mode === 'compute') {
    aziz = 'busy';
    line = gpuJob
      ? `Patron, "${gpuJob.label || gpuJob.id}" işi GPU'da çalışıyor. Compute modundayız, AI-Asistan'a aldığınızda Kamil döner.`
      : "Patron, GPU işlere ayrıldı. AI-Asistan'a aldığınızda Kamil döner.";
  } else if (gpuJob) {
    aziz = 'busy';
    line = `Patron, "${gpuJob.label || gpuJob.id}" işi GPU'da çalışıyor. Kamil dinleniyor, iş bitince hemen döner.`;
  } else if (state.keepOffSeconds) {
    aziz = 'busy';
    line = `Patron, birazdan yeni GPU işi geleceği söylendi. ${minutes(state.keepOffSeconds)} dakika bekliyorum; bir şey sorarsanız Kamil hemen uyanır.`;
  } else if (state.blocked) {
    aziz = 'worried';
    line = `Patron, Kamil şu an açılamıyor. Sebebi: ${state.blocked}.`;
  } else if (!state.llmActive) {
    aziz = 'busy';
    line = 'Kamil uyanıyor patron, birkaç saniye sürer.';
  } else {
    line = `${greeting(now.getHours())} patron. Her şey yolunda, Kamil hazır ve GPU emrinizde.`;
  }

  if (cpuJobs) line += ` İşlemcide ${cpuJobs} iş çalışıyor.`;
  if (queued) line += ` Sırada ${queued} iş var.`;
  if (failed) {
    aziz = 'worried';
    line += ` Üzgünüm patron, "${failed.label || failed.id}" hata verdi.`;
  }
  const system = state.system;
  if ((system?.gpuTempC ?? 0) >= HOT_GPU_C) {
    aziz = 'worried';
    line += ` GPU epey ısındı patron (${system!.gpuTempC} °C).`;
  }
  if (system?.ramAvailableGib !== undefined && system.ramAvailableGib < LOW_RAM_GIB) {
    aziz = 'worried';
    line += ' Bellek azaldı patron, işleri gerekirse ben durdururum.';
  }
  return { aziz, line, ...kamil };
}

type LogEntry = { at: number; kind: string; text: string; count?: number };

function clock(seconds: number): string {
  const when = new Date(seconds * 1000);
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  return new Date().toDateString() === when.toDateString() ? time : `${when.getDate()}.${when.getMonth() + 1} ${time}`;
}

/** Aziz's logbook: what he decided and why, newest first. */
function Logbook({ entries }: { entries: LogEntry[] }) {
  const colors = useMaterialColors();
  if (!entries.length) return null;
  return (
    <Column verticalArrangement={{ spacedBy: 4 }}>
      <Text color={colors.onSurface} style={{ typography: 'titleSmall', fontWeight: '700' }}>Aziz'in defteri</Text>
      {[...entries].reverse().map((entry) => (
        <Row key={`${entry.at}-${entry.text}`} horizontalArrangement={{ spacedBy: 8 }}>
          <Text color={colors.outline} style={{ typography: 'bodySmall' }}>{clock(entry.at)}</Text>
          <Text color={entry.kind === 'problem' ? colors.error : colors.onSurfaceVariant} modifiers={[weight(1)]} style={{ typography: 'bodySmall' }}>
            {entry.count && entry.count > 1 ? `${entry.text} (${entry.count} kez)` : entry.text}
          </Text>
        </Row>
      ))}
    </Column>
  );
}

/** Under the server connection in Settings. */
export function ServerReport({ connection }: { connection: ServerConnection }) {
  const colors = useMaterialColors();
  const [state, setState] = useState<GpuState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [noGate, setNoGate] = useState(false);

  useEffect(() => {
    let live = true;
    const load = () => {
      api.gpu(connection).then(
        (next) => { if (live) { setState(next); setLoaded(true); } },
        (reason) => {
          if (!live) return;
          // A server without a gate has nothing for him to report, which is no fault of anyone's.
          if (reason instanceof ApiError && reason.status === 404) setNoGate(true);
          setState(null);
          setLoaded(true);
        },
      );
    };
    load();
    const ticker = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(ticker);
    };
  }, [connection]);

  const said = report(state, new Date());
  const line = loaded ? said.line : '';
  if (!loaded || noGate) return null;
  return (
    <Panel>
      <SectionTitle icon={icons.memory} title="Aziz'in raporu" />
      <AzizOffice connection={connection} line={line} mood={said.aziz} state={state} />
      <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
        <Figure views={KAMIL_FRONT} mood={said.kamil} dp={72} />
        <Column modifiers={[weight(1)]}>
          <Text color={colors.onSurface} style={{ typography: 'titleSmall', fontWeight: '700' }}>Kamil</Text>
          <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>{said.kamilLine}</Text>
        </Column>
      </Row>
      <Logbook entries={(state as (GpuState & { log?: LogEntry[] }) | null)?.log ?? []} />
    </Panel>
  );
}

// Aziz's office

type KamilToday = { upSeconds: number; loads: number; jobsDone: number; jobsFailed: number };
type OfficeState = GpuState & { kamilToday?: KamilToday };
type ChartNumbers = { answers: number; notifications: number; upSeconds: number; jobsDone: number; jobsFailed: number };

const OFFICE_UNITS_WIDE = 8;
const OFFICE_SIT_DROP = 0.24;
const AZIZ_PACE = 1.05; // units a second: he is not a fast man
const CHAIR = { x: 0, z: -2.0 }; // far back, which also lifts him above the desk
const BY_THE_CHART = { x: -1.62, z: -1.2 };
const BY_THE_SAFE = { x: 1.42, z: -0.98 };
const CHART_PAPER = { x0: -3.8, x1: -2.04, y0: 1.28, y1: 3.16, z: -2.04 };
const CHECK_LINE_MS = 2200;
const CHART_LINE_MS = 3600;
const SAFE_LINE_MS = 2200;
const VERDICT_MS = 8000;

function numbersFrom(state: GpuState | null): ChartNumbers {
  const today = (state as OfficeState | null)?.kamilToday;
  return {
    answers: state?.today?.answers ?? 0,
    notifications: state?.today?.notifications ?? 0,
    upSeconds: today?.upSeconds ?? 0,
    jobsDone: today?.jobsDone ?? 0,
    jobsFailed: today?.jobsFailed ?? 0,
  };
}

function hoursText(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} dk`;
  const hours = Math.floor(seconds / 3600);
  const rest = Math.round((seconds % 3600) / 60);
  return rest ? `${hours} sa ${rest} dk` : `${hours} sa`;
}

/** What Aziz concludes from the chart. Fixed sentences, chosen from the real numbers. */
export function verdict(numbers: ChartNumbers): string {
  const { answers, notifications, upSeconds, jobsFailed } = numbers;
  if (!upSeconds && !answers && !notifications) return 'Patron, Kamil bugün daha masaya oturmadı. Maaşından keseyim mi?';
  if (jobsFailed) return `Patron, Kamil ${hoursText(upSeconds)} GPU'da durdu, ${answers} soruya baktı. Ama ${jobsFailed} iş patladı, onu da ben toplarım.`;
  if (answers >= 10) return `Patron, Kamil bugün ${answers} soruya cevap verdi. Kasadan prim çıkaralım mı?`;
  if (!answers) return `Patron, Kamil ${hoursText(upSeconds)} GPU'da oturdu, kimse bir şey sormadı. ${notifications} bildirim yazmış, o kadar.`;
  return `Patron, Kamil bugün ${hoursText(upSeconds)} GPU'da, ${answers} cevap, ${notifications} bildirim. Fena değil. Kasa da yerinde.`;
}

/** Kamil's day, on the paper beside Aziz's desk. The bars grow each time he comes to read them. */
function Chart({ rect, numbers, grow }: {
  rect: { left: number; top: number; width: number; height: number };
  numbers: ChartNumbers;
  grow: Animated.Value;
}) {
  const unit = rect.width / 11.5;
  const rows = [
    { label: 'Cevap', value: String(numbers.answers), share: numbers.answers / 20, color: '#2c6e49' },
    { label: 'Bildirim', value: String(numbers.notifications), share: numbers.notifications / 20, color: '#1f5f8b' },
    { label: 'GPU', value: hoursText(numbers.upSeconds), share: numbers.upSeconds / (16 * 3600), color: '#a1642a' },
    { label: 'İş', value: numbers.jobsFailed ? `${numbers.jobsDone} / ${numbers.jobsFailed} hata` : String(numbers.jobsDone), share: (numbers.jobsDone + numbers.jobsFailed) / 8, color: numbers.jobsFailed ? '#9a2a1f' : '#5b4a8a' },
  ];
  return (
    <View pointerEvents="none" style={{ position: 'absolute', ...rect, gap: unit * 0.28 }}>
      <RNText numberOfLines={1} style={{ fontFamily: 'casual', color: '#7d1d14', fontSize: unit * 1.2, fontWeight: '700' }}>KAMİL · BUGÜN</RNText>
      {rows.map((row) => (
        <View key={row.label}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <RNText style={{ fontFamily: 'casual', color: '#10182a', fontSize: unit * 1.08, fontWeight: '700' }}>{row.label}</RNText>
            <RNText numberOfLines={1} style={{ fontFamily: 'casual', color: '#10182a', fontSize: unit * 1.08, fontWeight: '700' }}>{row.value}</RNText>
          </View>
          <View style={{ height: unit * 0.5, marginTop: unit * 0.06, backgroundColor: 'rgba(20,20,20,0.13)', borderRadius: 2, overflow: 'hidden' }}>
            <Animated.View
              style={{
                width: `${Math.max(3, Math.min(100, row.share * 100))}%`, height: '100%', backgroundColor: row.color,
                transformOrigin: 'left', transform: [{ scaleX: grow }],
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

/**
 * Aziz at his desk, with his safe on one side and Kamil's day on the other. Tapping him sends him to read the chart with
 * today's real numbers and to look in the safe, and he comes back and says what he makes of it.
 */
function AzizOffice({ connection, line, mood, state }: { connection: ServerConnection; line: string; mood: Mood; state: GpuState | null }) {
  const window = useWindowDimensions();
  const width = window.width - 32 - 36; // the page's padding and the panel's
  const scale = width / OFFICE_UNITS_WIDE;
  const height = width * (OFFICE.h / OFFICE.w);
  const k = scale / CANVAS.unit;
  const px = width / OFFICE.w;
  const place = useCallback((spot: { x: number; z: number }) => ({
    x: (spot.x + OFFICE.ox / OFFICE.unit) * scale,
    y: (OFFICE.oy / OFFICE.unit + spot.z * Math.sin(OFFICE.elev)) * scale,
  }), [scale]);

  const rig = useRig(Y20);
  const posX = useRef(new Animated.Value(place(CHAIR).x)).current;
  const posY = useRef(new Animated.Value(place(CHAIR).y)).current;
  const spotNow = useRef(place(CHAIR));
  const safeSwing = useRef(new Animated.Value(0)).current;
  const grow = useRef(new Animated.Value(1)).current;
  const facing = useRef(Y20);
  const flipped = useRef(false);
  const alive = useRef(true);
  const busy = useRef(false);
  const [saying, setSaying] = useState<string | null>(null);
  const [bubbleSpot, setBubbleSpot] = useState(CHAIR.x);
  const [typing, setTyping] = useState(false);
  const [numbers, setNumbers] = useState<ChartNumbers>(numbersFrom(state));
  const shown = saying ?? line;

  useEffect(() => {
    rig.sit.setValue(1);
    alive.current = true;
    return () => { alive.current = false; };
  }, [rig]);
  useEffect(() => {
    if (!busy.current) setNumbers(numbersFrom(state));
  }, [state]);
  useFlap(shown, rig.jaw);
  useLife(rig, true);
  useLoop(rig.idle, mood === 'worried' ? 520 : 3000);
  useLoop(rig.typing, 700, typing);

  const animate = useCallback((animation: Animated.CompositeAnimation) => new Promise<void>((resolve) => animation.start(() => resolve())), []);
  const face = useCallback((view: number, flip = false) => turnRobot(rig, facing, flipped, view, flip, () => alive.current), [rig]);
  const walkTo = useCallback(async (spot: { x: number; z: number }, view: number, flip: boolean) => {
    const target = place(spot);
    const distance = Math.hypot(target.x - spotNow.current.x, target.y - spotNow.current.y) / scale;
    spotNow.current = target;
    await face(view, flip);
    const steps = Animated.loop(Animated.timing(rig.walk, { toValue: 1, duration: WALK_MS * 1.2, easing: Easing.linear, useNativeDriver: true }));
    steps.start();
    const ms = distance / AZIZ_PACE * 1000;
    await animate(Animated.parallel([
      Animated.timing(posX, { toValue: target.x, duration: ms, easing: Easing.linear, useNativeDriver: true }),
      Animated.timing(posY, { toValue: target.y, duration: ms, easing: Easing.linear, useNativeDriver: true }),
    ]));
    steps.stop();
    rig.walk.setValue(0);
  }, [animate, face, place, posX, posY, rig, scale]);
  const say = useCallback((words: string | null, spot = CHAIR.x) => {
    setBubbleSpot(spot);
    setSaying(words);
  }, []);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      say('Bakalım patron, Kamil neler yapmış.');
      await PAUSE(CHECK_LINE_MS);
      const fresh = await api.gpu(connection).then(numbersFrom, () => numbersFrom(state));
      say('');
      await animate(Animated.timing(rig.sit, { toValue: 0, duration: 260, useNativeDriver: true }));

      await walkTo(BY_THE_CHART, Y90, true);
      await face(Y135, true);
      grow.setValue(0);
      setNumbers(fresh);
      setTyping(true);
      await animate(Animated.timing(grow, { toValue: 1, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: true }));
      say(`Cevap ${fresh.answers}, bildirim ${fresh.notifications}, GPU'da ${hoursText(fresh.upSeconds)}.`, BY_THE_CHART.x);
      await PAUSE(CHART_LINE_MS);
      setTyping(false);
      say('');

      await walkTo(BY_THE_SAFE, Y90, false);
      await face(Y135, false);
      await animate(Animated.timing(safeSwing, { toValue: 1, duration: 420, easing: Easing.out(Easing.quad), useNativeDriver: true }));
      say('Kasa yerinde patron.', BY_THE_SAFE.x);
      await PAUSE(SAFE_LINE_MS);
      say('');
      await animate(Animated.timing(safeSwing, { toValue: 0, duration: 340, useNativeDriver: true }));

      await walkTo(CHAIR, Y90, true);
      await animate(Animated.timing(rig.sit, { toValue: 1, duration: 280, easing: Easing.out(Easing.quad), useNativeDriver: true }));
      await face(Y20);
      say(verdict(fresh));
      await PAUSE(VERDICT_MS);
    } finally {
      busy.current = false;
      if (alive.current) say(null);
    }
  }, [animate, connection, face, grow, rig, safeSwing, say, state, walkTo]);

  const chartRect = useMemo(() => ({
    left: (CHART_PAPER.x0 + OFFICE.ox / OFFICE.unit) * scale,
    width: (CHART_PAPER.x1 - CHART_PAPER.x0) * scale,
    top: (OFFICE.oy / OFFICE.unit - (CHART_PAPER.y1 * Math.cos(OFFICE.elev) - CHART_PAPER.z * Math.sin(OFFICE.elev))) * scale,
    height: (CHART_PAPER.y1 - CHART_PAPER.y0) * Math.cos(OFFICE.elev) * scale,
  }), [scale]);
  const door = OFFICE.safeDoor;
  const desk = OFFICE.desk;
  const bubbleWidth = width * 0.68;
  const bubbleAnchor = (bubbleSpot + OFFICE.ox / OFFICE.unit) * scale;
  // Always right of the chart, so what he says never covers what he is reading.
  const bubbleLeft = Math.max(width * 0.28, Math.min(width - bubbleWidth - 4, bubbleAnchor - bubbleWidth / 2));
  const tail = Math.max(14, Math.min(bubbleWidth - 26, bubbleAnchor - bubbleLeft - 6));

  return (
    <RNHostView modifiers={[size(width, height)]}>
      <Pressable style={{ flex: 1 }} onPress={() => void check()} accessibilityRole="button" accessibilityLabel="Aziz: Kamil'in istatistiklerini kontrol et">
        <View style={{ width, height, borderRadius: 20, overflow: 'hidden', backgroundColor: '#17120e' }}>
          <Image source={OFFICE.src} fadeDuration={0} style={{ position: 'absolute', left: 0, top: 0, width, height }} />
          <Chart rect={chartRect} numbers={numbers} grow={grow} />
          <Animated.View pointerEvents="none" style={{ position: 'absolute', left: 0, top: 0, width, height, transform: [{ translateX: posX }, { translateY: posY }] }}>
            <RobotBody views={AZIZ} rig={rig} k={k} mood={mood} />
          </Animated.View>
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute', left: door.x * px, top: door.y * px, width: door.w * px, height: door.h * px,
              transformOrigin: [0, door.h * px / 2, 0],
              transform: [{ scaleX: safeSwing.interpolate({ inputRange: [0, 1], outputRange: [1, 0.1] }) }],
            } as unknown as React.ComponentProps<typeof Animated.View>['style']}>
            <Image source={door.src} fadeDuration={0} style={{ width: door.w * px, height: door.h * px }} />
          </Animated.View>
          <Image source={desk.src} fadeDuration={0} style={{ position: 'absolute', left: desk.x * px, top: desk.y * px, width: desk.w * px, height: desk.h * px }} />
          <RNText numberOfLines={1} style={{ position: 'absolute', left: (OFFICE.ox / OFFICE.unit - 0.42) * scale, width: 0.84 * scale, top: (OFFICE.oy / OFFICE.unit - 1.27 * Math.cos(OFFICE.elev) - 0.06 * Math.sin(OFFICE.elev) - 0.075) * scale, textAlign: 'center', fontSize: 0.13 * scale, fontWeight: '800', color: '#2a1a06', letterSpacing: 0.6 }}>
            MÜDÜR
          </RNText>
          {shown ? <SpeechBubble line={shown} left={bubbleLeft} top={6} width={bubbleWidth} tail={tail} /> : null}
        </View>
      </Pressable>
    </RNHostView>
  );
}
