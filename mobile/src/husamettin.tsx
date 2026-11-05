/**
 * Husamettin, Kamil's bad influence. A secret of the main page: hold a finger on Kamil's house for ten seconds and he
 * turns up in the middle of Kamil's work.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image } from 'react-native';

import { PAUSE, RobotBody, turnRobot, useFlap, useLife, useLoop, useRig, WALK_MS, Y180, Y20, Y55, Y90 } from './kamil';
import type { Guest, RoomControls } from './kamil';
import { HUSAMETTIN, STAGE } from './kamilart/sprites';

const HUSAMETTIN_START = { x: 4.9, z: 0.5 };
const BESIDE_KAMIL = { x: 0.85, z: 0.5 };
const HUSAMETTIN_STEP_BACK = 0.2; // for each of the three rounds of blows
const FLOOR_LIFT = 0.33; // lying down, his middle rests this far above his feet's line

function HusamettinLayer({ scale, k, width, height, onReady }: {
  scale: number;
  k: number;
  width: number;
  height: number;
  onReady: (visit: (room: RoomControls) => Promise<void>) => void;
}) {
  const rig = useRig(Y90);
  const posX = useRef(new Animated.Value(0)).current;
  const posY = useRef(new Animated.Value(0)).current;
  const tilt = useRef(new Animated.Value(0)).current;
  const dust = useRef(new Animated.Value(0)).current;
  const facing = useRef(Y90);
  const flipped = useRef(false);
  const [here, setHere] = useState(false);
  const [line, setLine] = useState('');
  const [closedEyes, setClosedEyes] = useState(false);
  const [dustAt, setDustAt] = useState({ x: 0, y: 0 });
  useFlap(line, rig.jaw);
  useLife(rig, here && !closedEyes);
  useLoop(rig.idle, 1400, here);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    const animate = (animation: Animated.CompositeAnimation) => new Promise<void>((resolve) => animation.start(() => resolve()));
    const turn = (view: number, flip: boolean) => turnRobot(rig, facing, flipped, view, flip, () => alive.current);
    onReady(async (room: RoomControls) => {
      const walk = async (from: { x: number; y: number }, to: { x: number; y: number }, ms: number) => {
        posX.setValue(from.x);
        posY.setValue(from.y);
        const steps = Animated.loop(Animated.timing(rig.walk, { toValue: 1, duration: WALK_MS * 0.85, easing: Easing.linear, useNativeDriver: true }));
        steps.start();
        await animate(Animated.parallel([
          Animated.timing(posX, { toValue: to.x, duration: ms, easing: Easing.linear, useNativeDriver: true }),
          Animated.timing(posY, { toValue: to.y, duration: ms, easing: Easing.linear, useNativeDriver: true }),
        ]));
        steps.stop();
        rig.walk.setValue(0);
      };
      const beside = room.place(BESIDE_KAMIL);
      const speak = async (words: string, ms: number) => {
        setLine(words);
        room.say(words, true, beside.x);
        await PAUSE(ms);
        setLine('');
      };
      const kamilSays = (words: string, x: number) => room.say(words, false, room.place({ x, z: 0 }).x);

      // In he comes, while Kamil is at work
      setHere(true);
      setClosedEyes(false);
      tilt.setValue(0);
      await turn(Y90, true);
      await walk(room.place(HUSAMETTIN_START), beside, 2700);
      await turn(Y55, true);
      await speak('Kamil! Bırak şu bilgisayarı, gel votka içek.', 3000);
      await speak('Hadi oğlum, patron görmez. Bir kadeh, bir!', 3000);

      // Kamil turns round, not pleased
      room.say('', false, beside.x);
      room.setTyping(false);
      await room.face(Y20);
      kamilSays('Hüsamettin, mesai saatindeyiz. Git işine.', room.seat.x);
      await PAUSE(2800);
      await speak('Soğuk soğuk votka var diyorum, gel be!', 2800);
      kamilSays('Ben patrona ihanet etmem!', room.seat.x);
      await PAUSE(1900);
      room.say('', false, beside.x);

      // And gives him what he came for
      await room.standUp();
      const kamilAt = BESIDE_KAMIL.x - 0.98;
      await room.walkTo({ x: kamilAt, z: BESIDE_KAMIL.z }, Y90, false, 1.9);
      const flail = Animated.loop(Animated.timing(room.rig.scribble, { toValue: 1, duration: 190, easing: Easing.linear, useNativeDriver: true }));
      await animate(Animated.timing(room.rig.armUp, { toValue: 0.72, duration: 120, useNativeDriver: true }));
      flail.start();
      let backed = 0;
      for (const words of ['Patrona ihanet etmem!', 'Al sana votka!', 'Bu da mezesi!']) {
        kamilSays(words, kamilAt);
        for (let blow = 0; blow < 2; blow++) {
          const hit = room.place({ x: BESIDE_KAMIL.x + backed - 0.25, z: BESIDE_KAMIL.z });
          setDustAt({ x: hit.x, y: hit.y - 1.35 * room.scale });
          dust.setValue(0);
          backed += HUSAMETTIN_STEP_BACK / 2;
          const pushed = room.place({ x: BESIDE_KAMIL.x + backed, z: BESIDE_KAMIL.z });
          await animate(Animated.parallel([
            Animated.timing(dust, { toValue: 1, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.timing(posX, { toValue: pushed.x, duration: 150, easing: Easing.out(Easing.quad), useNativeDriver: true }),
            Animated.sequence([
              Animated.timing(tilt, { toValue: blow ? 11 : -9, duration: 80, useNativeDriver: true }),
              Animated.timing(tilt, { toValue: 0, duration: 130, useNativeDriver: true }),
            ]),
          ]));
        }
        await PAUSE(320);
      }
      flail.stop();
      room.rig.scribble.setValue(0);
      await animate(Animated.timing(room.rig.armUp, { toValue: 0, duration: 160, useNativeDriver: true }));

      // Down he goes, then off he runs
      room.say('', false, beside.x);
      setClosedEyes(true);
      const fallenAt = room.place({ x: BESIDE_KAMIL.x + backed, z: BESIDE_KAMIL.z });
      await animate(Animated.parallel([
        Animated.timing(tilt, { toValue: 86, duration: 340, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(posY, { toValue: fallenAt.y - FLOOR_LIFT * room.scale, duration: 340, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]));
      await PAUSE(1500);
      setClosedEyes(false);
      await animate(Animated.parallel([
        Animated.timing(tilt, { toValue: 0, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(posY, { toValue: fallenAt.y, duration: 300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      ]));
      await turn(Y90, false);
      setLine('Tamam abi tamam, gidiyorum!');
      room.say('Tamam abi tamam, gidiyorum!', true, fallenAt.x);
      await walk(fallenAt, room.place(HUSAMETTIN_START), 1500);
      setLine('');
      setHere(false);

      // Back to work, with an apology to the boss
      await room.face(Y20);
      kamilSays('Kusura bakmayın patron. İşimize dönüyoruz.', kamilAt);
      await PAUSE(2800);
      room.say('', false, beside.x);
      await room.walkTo(room.seat, Y90, true);
      await room.sitDown();
      await room.face(Y180);
      room.setTyping(true);
    });
  }, [dust, onReady, posX, posY, rig, tilt]);

  if (!here) return null;
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute', left: 0, top: 0, width, height,
          transform: [{ translateX: posX }, { translateY: posY }, { rotate: tilt.interpolate({ inputRange: [-90, 90], outputRange: ['-90deg', '90deg'] }) }],
          transformOrigin: [0, 0, 0],
        } as unknown as React.ComponentProps<typeof Animated.View>['style']}>
        <Image source={STAGE.shadow} fadeDuration={0} style={{ position: 'absolute', left: -0.55 * scale, top: -0.15 * scale, width: 1.1 * scale, height: 0.36 * scale, opacity: 0.8 }} />
        <RobotBody views={HUSAMETTIN} rig={rig} k={k} mood={closedEyes ? 'asleep' : 'happy'} />
      </Animated.View>
      <Animated.Text
        pointerEvents="none"
        style={{
          position: 'absolute', left: dustAt.x - 12, top: dustAt.y - 12, fontSize: 22, color: '#ffd66b', fontWeight: '900',
          opacity: dust.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0, 1, 0] }),
          transform: [{ scale: dust.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1.7] }) }, { rotate: dust.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '70deg'] }) }],
        }}>
        ✦
      </Animated.Text>
    </>
  );
}

export const guest: Guest | null = { Layer: HusamettinLayer };
