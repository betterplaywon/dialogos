import assert from 'node:assert/strict';
import { beforeEach, test, type TestContext } from 'node:test';
import type { ListenResult } from '../web/src/listen.ts';
import { createVoiceControl, type ReadRequest, type VoiceControl, type VoiceMemory } from '../web/src/voice-control.ts';
import {
  fakeOnDevice,
  FakePackMark,
  FakeRecognition,
  FakeSpeech,
  MEASURED_VOICES,
  REMOTE_ONLY_VOICES,
  voice,
  type FakeVoice,
} from './voice-fakes.ts';

const OPENING: ReadRequest = { key: 'g1:1', text: '저는 반대로 생각합니다. 근거는 네 가지입니다.', characterId: 'deontologist' };
const REPLY: ReadRequest = { key: 'g1:3', text: '그 반론은 받아들입니다.', characterId: 'deontologist' };

/** 새 사용자 폴더에서 잰 install 시간(6.0~9.4초) 가운데 하나. install이 이만큼 걸렸으면 인식 팩을 내려받은 것이다. */
const DOWNLOAD_MS = 6_000;

/** 약속(promise)에 걸린 일이 모두 돌 때까지 기다린다. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

// 듣기의 시간 제한과 읽기의 시작 감시가 타이머를 건다. 이 파일의 검사는 모두 가짜 타이머로 돌려, 실제 타이머가 검사 뒤에 남지 않게 한다.
beforeEach((t) => {
  if ('mock' in t) t.mock.timers.enable({ apis: ['setTimeout'] });
});

interface Options {
  /** 처음에 브라우저가 가진 목소리 목록. 주지 않으면 실측한 목록이다. */
  voices?: readonly FakeVoice[];
  /** false면 기기 안 인식 API가 없는 브라우저다. */
  onDevice?: boolean;
  /** false면 그 기능이 없는 브라우저다. */
  speech?: boolean;
  recognition?: boolean;
  /** 지난번에 골라 둔 목소리의 이름. */
  remembered?: string;
  /** 다른 제어기가 쓰던 저장소. 주면 같은 브라우저에서 페이지를 새로 연 것이 된다. */
  memory?: VoiceMemory;
  /** 다른 제어기가 쓰던 표시 저장소. 주면 같은 브라우저의 다른 페이지(새로 연 페이지, 다른 탭)가 된다. */
  packMark?: FakePackMark;
  /** turnedOn에서 인식 팩 설치(install)에 걸리는 시간. 주지 않으면 바로 끝난다(인식 팩이 이미 있는 브라우저). */
  installMs?: number;
}

function setup(options: Options = {}) {
  const log: string[] = [];
  const speech = new FakeSpeech(options.voices ?? MEASURED_VOICES, log);
  const recognition = new FakeRecognition();
  const device = fakeOnDevice(log);
  if (options.onDevice !== false) recognition.onDevice = device.api;
  let remembered: string | null = options.remembered ?? null;
  const memory: VoiceMemory = options.memory ?? {
    load: () => remembered,
    save: (name) => {
      remembered = name;
    },
  };
  const packMark = options.packMark ?? new FakePackMark();
  /** 검사가 돌리는 시계. 제어기는 이것으로 install에 걸린 시간을 잰다. */
  let clock = 0;
  const control = createVoiceControl({
    recognition: options.recognition === false ? null : recognition,
    speech: options.speech === false ? null : speech,
    memory,
    packMark,
    now: () => clock,
  });
  let notified = 0;
  control.subscribe(() => {
    notified += 1;
  });
  return {
    control,
    speech,
    synth: speech.synth,
    recognition,
    device,
    log,
    memory,
    packMark,
    remembered: () => memory.load(),
    notified: () => notified,
    /** 시계를 ms만큼 보낸다. */
    elapse: (ms: number) => {
      clock += ms;
    },
  };
}

/** 기기 안 한국어 목소리가 없는 브라우저에서 음성을 켜고, 목록이 다 온 뒤 원격 목소리를 골라 기다리던 말을 읽게 한다. */
function remoteChosen() {
  const made = setup({ voices: REMOTE_ONLY_VOICES });
  made.control.turnOn(OPENING);
  made.speech.emit(REMOTE_ONLY_VOICES, true);
  made.control.preferVoice('Google 한국의');
  return made;
}

/** 음성을 켜고 기기 안 인식 준비까지 끝낸다. tick은 가짜 타이머의 시간을 보낸다. */
async function turnedOn(t: TestContext, options: Options = {}, first: ReadRequest | null = null) {
  const made = setup(options);
  made.control.turnOn(first);
  made.elapse(options.installMs ?? 0);
  made.device.finishInstall(true);
  await settle();
  return { ...made, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('음성 인식도 합성도 없는 브라우저에서는 켜지지 않는다', () => {
  const { control, log, notified } = setup({ speech: false, recognition: false });
  assert.deepEqual([control.getState().canListen, control.getState().canSpeak], [false, false]);
  control.turnOn(OPENING);
  assert.equal(control.getState().on, false);
  assert.deepEqual(log, []);
  assert.equal(notified(), 0);
});

test('켜는 누름 안에서 소리 없는 첫 읽기, 목소리 구독, 마지막 말 읽기, 인식 팩 설치가 차례로 시작된다', async () => {
  const { control, synth, device, log } = setup();
  assert.equal(control.getState().on, false);
  control.turnOn(OPENING);
  // 여기까지가 누름(사용자 제스처) 안이다. 무엇도 기다리지 않고 모두 시작됐다.
  assert.deepEqual(log, ['prime', 'watch', 'speak', 'speak', 'install']);
  const state = control.getState();
  assert.deepEqual([state.on, state.place, state.reading], [true, 'preparing', 'g1:1']);
  // 읽기는 인식 준비를 기다리지 않는다. 기기 목소리로, 캐릭터의 속도와 높낮이로 읽는다.
  assert.deepEqual(
    synth.spoken.map((item) => [item.chunk.text, item.chunk.voice.name, item.chunk.rate, item.chunk.pitch]),
    [
      ['저는 반대로 생각합니다.', 'Yuna', 0.94, 0.85],
      ['근거는 네 가지입니다.', 'Yuna', 0.94, 0.85],
    ],
  );
  device.finishInstall(true);
  await settle();
  assert.equal(control.getState().place, 'device');
  assert.deepEqual(log.slice(-2), ['install', 'available']);
});

test('기기 안 인식을 쓸 수 없으면 말소리가 가는 곳을 알 수 없다고 적는다', async () => {
  const noApi = setup({ onDevice: false });
  noApi.control.turnOn(null);
  await settle();
  assert.equal(noApi.control.getState().place, 'unknown');
  assert.deepEqual(noApi.log, ['prime', 'watch']);

  const refused = setup();
  refused.control.turnOn(null);
  refused.device.finishInstall(false);
  await settle();
  assert.equal(refused.control.getState().place, 'unknown');
});

test('음성 인식이 없는 브라우저에서도 켜서 상대의 말을 들을 수 있다', async () => {
  const { control, synth, log } = setup({ recognition: false });
  control.turnOn(OPENING);
  await settle();
  const state = control.getState();
  assert.deepEqual([state.on, state.canListen, state.place, state.reading], [true, false, null, 'g1:1']);
  assert.equal(synth.spoken.length, 2);
  assert.ok(!log.includes('install'));
  // 들을 수 없으므로 말하기는 아무 일도 하지 않는다.
  control.listen(() => assert.fail('듣지 않아야 한다'));
  assert.equal(control.getState().listening, false);
});

test('목소리 목록이 아직 오지 않았으면 기다렸다가, 기기 목소리가 오면 가장 최근 요청 하나만 읽는다', () => {
  const { control, speech, synth } = setup({ voices: [] });
  control.turnOn(OPENING);
  assert.deepEqual([control.getState().voice, control.getState().reading, synth.spoken.length], ['wait', 'g1:1', 0]);
  // 기다리는 동안 온 새 요청이 앞의 것을 대신한다.
  control.read(REPLY);
  assert.equal(control.getState().reading, 'g1:3');
  // 읽던 것이 없으므로 대기열을 끊지 않는다. 켜는 누름 안에서 넣은 소리 없는 첫 읽기가 끊기지 않는다.
  assert.equal(synth.cancels, 0);
  // 원격 목소리가 먼저 온다(실측). 목록이 다 오기 전에는 원격 목소리로 읽지 않는다.
  speech.emit(REMOTE_ONLY_VOICES, false);
  assert.deepEqual([control.getState().voice, synth.spoken.length], ['wait', 0]);
  speech.emit(MEASURED_VOICES, false);
  assert.deepEqual(
    synth.spoken.map((item) => [item.chunk.text, item.chunk.voice.name]),
    [['그 반론은 받아들입니다.', 'Yuna']],
  );
  const state = control.getState();
  assert.deepEqual([typeof state.voice === 'object' && state.voice?.name, state.voices.length, state.reading], ['Yuna', 10, 'g1:3']);
  // 목록이 한 번 더 바뀌어도 읽던 것을 다시 읽지 않는다.
  speech.emit(MEASURED_VOICES, true);
  assert.equal(synth.spoken.length, 1);
  synth.finish(0);
  assert.equal(control.getState().reading, null);
});

test('읽는 중에 기기 목소리가 목록에서 빠진 뒤 새 요청이 오면, 읽던 것을 끊고 목소리를 기다린다', () => {
  const { control, speech, synth } = setup();
  control.turnOn(OPENING);
  assert.equal(synth.spoken.length, 2);
  synth.start(0);
  speech.emit(REMOTE_ONLY_VOICES, false);
  // 목록이 바뀐 것만으로는 읽던 것을 끊지 않는다.
  assert.deepEqual([control.getState().voice, control.getState().reading], ['wait', 'g1:1']);
  const before = synth.cancels;
  control.read(REPLY);
  assert.equal(synth.cancels, before + 1);
  assert.deepEqual([control.getState().reading, synth.spoken.length], ['g1:3', 2]);
  // 끊긴 읽기의 늦은 이벤트는 기다리는 요청의 표시를 지우지 않는다.
  synth.finish(0, 'interrupted');
  assert.equal(control.getState().reading, 'g1:3');
  speech.emit(MEASURED_VOICES, false);
  assert.deepEqual(synth.texts().slice(2), ['그 반론은 받아들입니다.']);
});

test('기기 목소리가 끝내 없으면 원격 목소리로 읽지 않고, 사용자가 원격 목소리를 고르면 기다리던 말을 읽는다', () => {
  const { control, speech, synth, remembered } = setup({ voices: REMOTE_ONLY_VOICES });
  control.turnOn(OPENING);
  // 목록이 오는 동안에는 곧 읽을 것으로 보인다.
  assert.deepEqual([control.getState().voice, control.getState().reading, synth.spoken.length], ['wait', 'g1:1', 0]);
  speech.emit(REMOTE_ONLY_VOICES, true);
  // 다 왔는데 기기 목소리가 없다. 읽을 글을 서버로 보내는 일을 앱이 대신 정하지 않는다.
  assert.deepEqual([control.getState().voice, control.getState().reading, synth.spoken.length], [null, null, 0]);
  // 고를 수 있게 원격 목소리는 목록에 남는다.
  assert.deepEqual(
    control.getState().voices.map((item) => item.name),
    ['Google 한국의'],
  );
  control.preferVoice('Google 한국의');
  assert.equal(remembered(), 'Google 한국의');
  assert.deepEqual(
    synth.spoken.map((item) => [item.chunk.text, item.chunk.voice.name, item.chunk.voice.localService]),
    [
      ['저는 반대로 생각합니다.', 'Google 한국의', false],
      ['근거는 네 가지입니다.', 'Google 한국의', false],
    ],
  );
  assert.equal(control.getState().reading, 'g1:1');
});

test('기기 목소리가 목록이 다 왔다고 본 뒤에 늦게 와도, 그사이 원격 목소리로 읽지 않고 오면 기기 목소리로 읽는다', () => {
  const { control, speech, synth } = setup({ voices: REMOTE_ONLY_VOICES });
  control.turnOn(OPENING);
  speech.emit(REMOTE_ONLY_VOICES, true);
  assert.equal(synth.spoken.length, 0);
  speech.emit(MEASURED_VOICES, false);
  assert.deepEqual(
    synth.spoken.map((item) => item.chunk.voice.name),
    ['Yuna', 'Yuna'],
  );
  assert.equal(control.getState().reading, 'g1:1');
});

test('고른 원격 목소리를 거두면 기억해 둔 이름을 지우고 읽던 것을 멈춘다. 그 뒤로는 고르기 전처럼 읽지 않다가, 기기 목소리가 오면 기다리던 말을 읽는다', () => {
  const { control, speech, synth, remembered } = remoteChosen();
  synth.start(0);
  assert.deepEqual([remembered(), control.getState().reading], ['Google 한국의', 'g1:1']);
  const cancels = synth.cancels;
  control.preferVoice(null);
  assert.equal(remembered(), null);
  // 읽히는 중이던 문장을 끊고, 넣어 둔 다음 문장도 대기열에서 뺀다.
  assert.deepEqual([control.getState().voice, control.getState().reading, synth.cancels, synth.queue()], [null, null, cancels + 1, []]);
  // 끊긴 읽기의 늦은 이벤트는 문제로 치지 않는다.
  synth.finish(0, 'interrupted');
  assert.equal(control.getState().speakProblem, null);
  // 고르기 전과 같다. 읽을 글을 원격 목소리로 보내지 않고, 다시 고를 수 있게 원격 목소리는 목록에 남는다.
  control.read(REPLY);
  assert.deepEqual([control.getState().reading, synth.spoken.length], [null, 2]);
  assert.deepEqual(
    control.getState().voices.map((item) => item.name),
    ['Google 한국의'],
  );
  // 기기 목소리가 늦게 오면 기다리던 말을 그 목소리로 읽는다.
  speech.emit(MEASURED_VOICES, false);
  assert.deepEqual(
    synth.spoken.slice(2).map((item) => [item.chunk.text, item.chunk.voice.name]),
    [['그 반론은 받아들입니다.', 'Yuna']],
  );
  assert.equal(control.getState().reading, 'g1:3');
});

test('원격 목소리로 넣은 문장이 시작하기 전에 고른 것을 거둬도 대기열을 끊지 않고, 넣어 둔 문장이 시작할 때 끊는다', () => {
  const { control, synth, remembered } = remoteChosen();
  // 원격 목소리의 시작이 얼마나 늦을 수 있는지는 재지 않았다. 넣은 문장이 시작하기 전에 거둔 것이다.
  control.preferVoice(null);
  assert.deepEqual([remembered(), control.getState().reading, synth.cancels], [null, null, 0]);
  synth.start(0);
  assert.deepEqual([synth.cancels, synth.queue()], [1, []]);
});

test('원격 목소리로 읽다 생긴 문제의 알림은 고른 것을 거두면 지운다', () => {
  const { control, synth } = remoteChosen();
  // 원격 목소리의 서버에 닿지 못했다.
  synth.finish(0, 'network');
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], [null, 'failed']);
  // 거두면 [듣기]가 사라진다. [듣기]를 누르라는 알림이 남지 않게 한다.
  control.preferVoice(null);
  assert.deepEqual([control.getState().voice, control.getState().speakProblem], [null, null]);
});

test('고른 원격 목소리를 거둔 뒤에는 음성을 껐다 켜도, 페이지를 새로 열어도 원격 목소리로 읽지 않는다', () => {
  const { control, speech, synth, memory } = remoteChosen();
  /** 같은 브라우저에서 페이지를 새로 열어 음성을 켜고, 원격 목소리뿐인 목록이 다 올 때까지 읽은 조각의 목소리를 돌려준다. */
  const reopen = () => {
    const page = setup({ voices: [], memory });
    page.control.turnOn(OPENING);
    page.speech.emit(REMOTE_ONLY_VOICES, false);
    page.speech.emit(REMOTE_ONLY_VOICES, true);
    return page.synth.spoken.map((item) => item.chunk.voice.name);
  };
  // 거두기 전에는 고른 것이 남아 있어, 새로 연 페이지가 원격 목소리가 오자마자 그 목소리로 읽는다.
  assert.deepEqual(reopen(), ['Google 한국의', 'Google 한국의']);
  synth.finish(0);
  synth.finish(1);
  control.preferVoice(null);
  const spoken = synth.spoken.length;
  control.turnOff();
  control.turnOn(OPENING);
  speech.emit(REMOTE_ONLY_VOICES, true);
  assert.deepEqual([control.getState().voice, control.getState().reading, synth.spoken.length], [null, null, spoken]);
  assert.deepEqual(reopen(), []);
});

test('한국어 목소리가 하나도 없으면 읽는 중으로 보이지 않고, 그 뒤의 요청도 읽지 않는다', () => {
  const { control, speech, synth } = setup({ voices: [] });
  control.turnOn(OPENING);
  speech.emit([voice('Samantha', 'en-US', true, true)], true);
  assert.deepEqual([control.getState().voice, control.getState().reading], [null, null]);
  control.read(REPLY);
  assert.deepEqual([control.getState().reading, synth.spoken.length], [null, 0]);
});

test('꺼져 있으면 읽지 않고, 켤 때 읽을 말을 주지 않으면 아무것도 읽지 않는다', () => {
  const { control, synth } = setup();
  control.read(OPENING);
  assert.deepEqual([control.getState().reading, synth.spoken.length], [null, 0]);
  control.turnOn(null);
  assert.deepEqual([control.getState().reading, synth.spoken.length], [null, 0]);
});

test('음성을 켜지 않았으면 판 화면이 사라질 때의 정리가 브라우저의 음성 기능을 건드리지 않는다', () => {
  const { control, synth, recognition, log, notified } = setup();
  // 판 화면은 사라질 때마다 듣기와 읽기를 끊으라고 한다. 음성을 켜지 않은 사람에게는 아무 일도 없어야 한다.
  control.cancelListening();
  control.stopReading();
  control.finishListening();
  control.turnOff();
  assert.deepEqual([synth.cancels, synth.spoken.length, recognition.created.length, log, notified()], [0, 0, 0, [], 0]);
});

test('읽기가 끝나면 읽는 중 표시를 지우고, 새로 읽으면 앞의 읽기를 끊는다', async (t) => {
  const { control, synth } = await turnedOn(t, {}, OPENING);
  assert.equal(control.getState().reading, 'g1:1');
  synth.start(0);
  control.read(REPLY);
  assert.equal(control.getState().reading, 'g1:3');
  // 끊긴 앞 읽기의 이벤트가 늦게 와도 새 읽기의 표시는 그대로다.
  synth.finish(0, 'interrupted');
  assert.equal(control.getState().reading, 'g1:3');
  synth.finish(2);
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], [null, null]);
});

test('멈추면 읽는 중 표시를 지우고, 끊긴 읽기는 문제로 치지 않는다', async (t) => {
  const { control, synth } = await turnedOn(t, {}, OPENING);
  synth.start(0);
  const before = synth.cancels;
  control.stopReading();
  assert.equal(synth.cancels, before + 1);
  synth.finish(0, 'interrupted');
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], [null, null]);
});

test('판 화면의 효과가 두 번 돌아 읽기, 끊기, 읽기가 한 틱에 와도, 넣어 둔 문장이 시작한 뒤에 끊고 다시 읽는다', async (t) => {
  const { control, synth } = await turnedOn(t);
  // 개발 서버의 React StrictMode는 판 화면의 효과를 돌리고, 정리하고, 다시 돌린다.
  control.read(OPENING);
  control.cancelListening();
  control.stopReading();
  control.read(OPENING);
  // 넣어 둔 문장이 시작하기 전에 끊으면 Chrome의 대기열이 멈춘다(실측). 그래서 아직 끊지 않는다.
  assert.deepEqual([synth.cancels, control.getState().reading], [0, 'g1:1']);
  synth.start(0);
  assert.deepEqual([synth.cancels, synth.queue()], [1, ['저는 반대로 생각합니다.', '근거는 네 가지입니다.']]);
  synth.finish(2);
  synth.finish(3);
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], [null, null]);
});

test('읽기가 시작하기 전에 말하기, 멈춤, 음성 끄기를 눌러도 대기열을 끊지 않고, 넣어 둔 문장이 시작할 때 끊는다', async (t) => {
  const presses: [string, (control: VoiceControl) => void][] = [
    ['말하기', (control) => control.listen(() => {})],
    ['멈춤', (control) => control.stopReading()],
    ['음성 끄기', (control) => control.turnOff()],
  ];
  for (const [name, press] of presses) {
    // 음성을 처음 켠 직후에는 넣은 문장이 시작하기까지 약 1.1초가 걸렸다(실측). 그사이에 누른 것이다.
    const { control, synth } = await turnedOn(t, {}, OPENING);
    press(control);
    assert.deepEqual([control.getState().reading, synth.cancels], [null, 0], name);
    synth.start(0);
    assert.deepEqual([synth.cancels, synth.queue()], [1, []], name);
  }
});

test('넣은 문장이 6초 동안 시작하지 않으면 읽는 중 표시를 지우고 문제로 알린다. 다시 읽으면 새로 넣는다', async (t) => {
  const { control, synth, tick } = await turnedOn(t, {}, OPENING);
  // 합성기가 멈췄다. 넣은 문장이 시작하지 않는다.
  synth.stalled = true;
  tick(5_900);
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], ['g1:1', null]);
  tick(100);
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], [null, 'failed']);
  control.read(REPLY);
  assert.deepEqual([control.getState().reading, control.getState().speakProblem, synth.queue()], ['g1:3', null, ['그 반론은 받아들입니다.']]);
});

test('브라우저가 소리 재생을 막으면 그렇게 알리고, 다시 읽기 시작하면 알림을 지운다', async (t) => {
  const { control, synth } = await turnedOn(t, {}, OPENING);
  synth.finish(0, 'not-allowed');
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], [null, 'blocked']);
  control.read(REPLY);
  assert.deepEqual([control.getState().reading, control.getState().speakProblem], ['g1:3', null]);
});

test('읽을 글자가 없는 말은 읽는 중으로 남지 않는다', async (t) => {
  const { control, synth } = await turnedOn(t);
  control.read({ key: 'g1:5', text: ' … ', characterId: undefined });
  assert.deepEqual([control.getState().reading, synth.spoken.length], [null, 0]);
});

test('기기 안 인식을 준비하는 동안에는 듣지 않고, 준비되면 기기 안 인식으로 한 발화를 듣는다', async () => {
  const { control, recognition, device } = setup();
  const heard: ListenResult[] = [];
  control.turnOn(null);
  control.listen((result) => heard.push(result));
  assert.deepEqual([control.getState().place, control.getState().listening, recognition.created.length], ['preparing', false, 0]);

  device.finishInstall(true);
  await settle();
  control.listen((result) => heard.push(result));
  const recognizer = recognition.last;
  assert.deepEqual([control.getState().listening, recognizer.processLocally, recognizer.calls], [true, true, ['start']]);
  // 듣는 중에 다시 눌러도 인식기를 또 만들지 않는다(브라우저는 겹친 start를 막아 주지 않는다).
  control.listen(() => assert.fail('겹쳐 듣지 않아야 한다'));
  assert.equal(recognition.created.length, 1);

  recognizer.result('거짓말은 옳지');
  assert.equal(control.getState().interim, '거짓말은 옳지');
  control.finishListening();
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
  recognizer.result('거짓말은 옳지 않습니다');
  recognizer.end();
  assert.deepEqual(heard, [{ transcript: '거짓말은 옳지 않습니다', problem: null }]);
  assert.deepEqual([control.getState().listening, control.getState().interim, control.getState().blocked], [false, '', null]);

  // 다음 발화는 새 인식기로 듣는다.
  control.listen(() => {});
  assert.equal(recognition.created.length, 2);
});

test('기기 안 인식이 확인되지 않았으면 processLocally를 켜지 않고 듣는다', async () => {
  const { control, recognition } = setup({ onDevice: false });
  control.turnOn(null);
  await settle();
  control.listen(() => {});
  assert.deepEqual([control.getState().place, Object.hasOwn(recognition.last, 'processLocally')], ['unknown', false]);
});

test('듣기 시작하면 읽던 것을 끊고, 듣는 동안에는 읽지 않는다', async (t) => {
  const { control, synth, recognition } = await turnedOn(t, {}, OPENING);
  synth.start(0);
  const before = synth.cancels;
  control.listen(() => {});
  assert.ok(synth.cancels > before);
  assert.deepEqual([control.getState().reading, control.getState().listening], [null, true]);
  const spoken = synth.spoken.length;
  control.read(REPLY);
  assert.deepEqual([control.getState().reading, synth.spoken.length], [null, spoken]);
  // 듣기가 끝난 뒤에는 다시 읽는다.
  recognition.last.end();
  control.read(REPLY);
  assert.equal(control.getState().reading, 'g1:3');
});

test('다시 눌러도 풀리지 않는 문제가 나면 음성 입력을 끄고, 껐다 켜도 그 페이지에서는 꺼 둔다', async (t) => {
  const { control, synth, recognition } = await turnedOn(t);
  const heard: ListenResult[] = [];
  control.listen((result) => heard.push(result));
  recognition.last.error('not-allowed');
  recognition.last.end();
  assert.deepEqual(heard, [{ transcript: '', problem: 'not-allowed' }]);
  assert.deepEqual([control.getState().blocked, control.getState().listening], ['not-allowed', false]);
  control.listen((result) => heard.push(result));
  assert.equal(recognition.created.length, 1);

  control.turnOff();
  control.turnOn(OPENING);
  assert.equal(control.getState().blocked, 'not-allowed');
  control.listen((result) => heard.push(result));
  assert.equal(recognition.created.length, 1);
  // 읽기는 그대로 된다.
  assert.ok(synth.spoken.length > 0);
  assert.equal(control.getState().reading, 'g1:1');
});

test('음성 입력이 꺼진 뒤에는 다시 켜도 인식 팩을 준비하지 않는다', async () => {
  const { control, recognition, device, log } = setup();
  control.turnOn(null);
  // 기기 안 인식을 쓰지 못해 브라우저가 정한 방식으로 듣다가, 마이크를 찾지 못했다.
  device.finishInstall(false);
  await settle();
  control.listen(() => {});
  recognition.last.error('audio-capture');
  recognition.last.end();
  assert.deepEqual([control.getState().place, control.getState().blocked], ['unknown', 'no-microphone']);
  control.turnOff();
  control.turnOn(OPENING);
  await settle();
  assert.equal(log.filter((entry) => entry === 'install').length, 1);
  assert.deepEqual([control.getState().on, control.getState().place, control.getState().blocked], [true, null, 'no-microphone']);
});

test('다시 해 볼 수 있는 문제는 음성 입력을 끄지 않는다', async (t) => {
  const { control, recognition, tick } = await turnedOn(t);
  const heard: ListenResult[] = [];
  control.listen((result) => heard.push(result));
  // 10초 동안 아무 말도 듣지 못했다.
  tick(10_000);
  recognition.last.end();
  assert.deepEqual(heard, [{ transcript: '', problem: 'no-speech' }]);
  assert.deepEqual([control.getState().blocked, control.getState().listening], [null, false]);
  control.listen((result) => heard.push(result));
  assert.equal(recognition.created.length, 2);
});

test('인식기가 시작하지 못해도 듣는 중으로 남지 않는다', async (t) => {
  const { control, recognition } = await turnedOn(t);
  const heard: ListenResult[] = [];
  recognition.nextStartError = new Error('InvalidStateError');
  control.listen((result) => heard.push(result));
  assert.deepEqual(heard, [{ transcript: '', problem: 'failed' }]);
  assert.equal(control.getState().listening, false);
  // 끝난 듣기를 마치거나 버려도 아무 일이 없고, 다시 누르면 새로 듣는다.
  control.finishListening();
  control.cancelListening();
  assert.deepEqual(recognition.last.calls, ['start']);
  control.listen((result) => heard.push(result));
  assert.deepEqual([control.getState().listening, recognition.created.length], [true, 2]);
});

test('듣기를 버리면 인식기를 끊고, 들은 글을 넘기지 않는다', async (t) => {
  const { control, recognition } = await turnedOn(t);
  control.listen(() => assert.fail('버린 듣기는 넘기지 않아야 한다'));
  recognition.last.result('거짓말은');
  control.cancelListening();
  assert.deepEqual(recognition.last.calls, ['start', 'abort']);
  assert.deepEqual([control.getState().listening, control.getState().interim], [false, '']);
  recognition.last.end();
});

test('끄면 듣기와 읽기를 멈추고 목소리 구독을 그만두며, 준비 중이던 결과는 버린다', async () => {
  const { control, speech, synth, device, log } = setup();
  control.turnOn(OPENING);
  synth.start(0);
  const cancels = synth.cancels;
  control.turnOff();
  assert.ok(synth.cancels > cancels);
  assert.equal(speech.watching, false);
  assert.equal(log[log.length - 1], 'unwatch');
  const state = control.getState();
  assert.deepEqual([state.on, state.place, state.reading, state.listening], [false, null, null, false]);
  // 끈 뒤에 끝난 준비는 상태를 바꾸지 않는다.
  device.finishInstall(true);
  await settle();
  assert.equal(control.getState().place, null);
  // 끈 뒤에 온 목소리 목록과 읽기 요청도 아무 일을 하지 않는다.
  const spoken = synth.spoken.length;
  speech.emit(MEASURED_VOICES, true);
  control.read(REPLY);
  assert.deepEqual([control.getState().reading, synth.spoken.length], [null, spoken]);
});

test('듣는 중에 끄면 인식기를 끊고, 그때까지 들은 글은 버리지 않고 끄면서 넘긴 글이라고 표시해 한 번 넘긴다', async (t) => {
  const { control, recognition } = await turnedOn(t);
  const heard: ListenResult[] = [];
  control.listen((result) => heard.push(result));
  recognition.last.result('거짓말은 결과가');
  control.turnOff();
  assert.deepEqual(recognition.last.calls, ['start', 'abort']);
  // 화면은 이 표시(turnedOff)를 보고 입력 칸의 글을 바꾸지 않고 끝에 붙인다(dictation.ts의 appendOnly).
  assert.deepEqual(heard, [{ transcript: '거짓말은 결과가', problem: null, turnedOff: true }]);
  // 끊긴 인식기가 늦게 낸 이벤트로 다시 넘기지 않는다.
  recognition.last.end();
  assert.equal(heard.length, 1);
  assert.deepEqual([control.getState().on, control.getState().listening, control.getState().interim], [false, false, '']);
});

test('아직 들은 글이 없을 때 끄면 아무것도 넘기지 않는다', async (t) => {
  const { control, recognition } = await turnedOn(t);
  control.listen(() => assert.fail('들은 글이 없으면 넘기지 않아야 한다'));
  control.turnOff();
  assert.deepEqual(recognition.last.calls, ['start', 'abort']);
});

test('준비 중에 껐다가 다시 켜면 설치를 겹쳐 부르지 않고, 같은 준비가 끝나면 그 결과를 적는다', async () => {
  const { control, device, log } = setup();
  control.turnOn(null);
  control.turnOff();
  control.turnOn(null);
  assert.equal(control.getState().place, 'preparing');
  assert.equal(log.filter((entry) => entry === 'install').length, 1);
  device.finishInstall(true);
  await settle();
  assert.equal(control.getState().place, 'device');
});

test('기기 안 인식이 한 번 확인되면 다시 켤 때 설치를 되풀이하지 않는다', async (t) => {
  const { control, log } = await turnedOn(t);
  control.turnOff();
  control.turnOn(null);
  assert.equal(control.getState().place, 'device');
  assert.equal(log.filter((entry) => entry === 'install').length, 1);
  // 소리 없는 첫 읽기와 목소리 구독은 켤 때마다 다시 한다.
  assert.equal(log.filter((entry) => entry === 'prime').length, 2);
  assert.equal(log.filter((entry) => entry === 'watch').length, 2);
});

test('인식 팩을 내려받았으면 표시를 남기고, 말소리가 아직 글로 바뀐 적이 없다고 적는다. 껐다 켜도 그대로다', async () => {
  const { control, device, packMark, elapse } = setup();
  control.turnOn(null);
  elapse(DOWNLOAD_MS);
  // 내려받는 동안에는 아직 적지 않는다.
  assert.deepEqual([control.getState().place, control.getState().packPending, packMark.stored], ['preparing', false, false]);
  device.finishInstall(true);
  await settle();
  assert.deepEqual([control.getState().place, control.getState().packPending, packMark.stored], ['device', true, true]);
  control.turnOff();
  // 꺼져 있을 때는 말소리가 가는 곳이 없으므로 적지 않는다.
  assert.equal(control.getState().packPending, false);
  control.turnOn(null);
  assert.deepEqual([control.getState().place, control.getState().packPending], ['device', true]);
});

test('인식 팩이 이미 있던 브라우저에서는 표시를 남기지 않는다', async (t) => {
  const { control, packMark } = await turnedOn(t);
  assert.deepEqual([control.getState().place, control.getState().packPending, packMark.stored], ['device', false, false]);
});

test('내려받는 중에 음성을 껐어도 표시는 남기고, 다시 켜면 적는다', async () => {
  const { control, device, packMark, elapse } = setup();
  control.turnOn(null);
  control.turnOff();
  elapse(DOWNLOAD_MS);
  device.finishInstall(true);
  await settle();
  assert.deepEqual([control.getState().on, control.getState().packPending, packMark.stored], [false, false, true]);
  control.turnOn(null);
  assert.deepEqual([control.getState().place, control.getState().packPending], ['device', true]);
});

test('표시가 남아 있으면 페이지를 새로 열어 켜도 그대로 적는다', async (t) => {
  const first = await turnedOn(t, { installMs: DOWNLOAD_MS });
  // 같은 브라우저에서 페이지를 새로 열었다. 인식 팩이 이제 있어서 install은 바로 끝난다.
  const reopened = await turnedOn(t, { packMark: first.packMark });
  assert.deepEqual([reopened.control.getState().place, reopened.control.getState().packPending], ['device', true]);
});

test('다른 탭이 인식 팩을 내려받았으면, 먼저 열려 있던 탭도 켤 때 그 표시를 읽는다', async (t) => {
  const packMark = new FakePackMark();
  // 이 탭은 인식 팩을 내려받기 전에 열렸다.
  const earlier = setup({ packMark });
  await turnedOn(t, { packMark, installMs: DOWNLOAD_MS });
  earlier.control.turnOn(null);
  earlier.device.finishInstall(true);
  await settle();
  assert.deepEqual([earlier.control.getState().place, earlier.control.getState().packPending], ['device', true]);
});

test('표시를 남기지 못하는 브라우저에서도 그 페이지에서는 기억한다', async (t) => {
  const packMark = new FakePackMark();
  packMark.blocked = true;
  const { control } = await turnedOn(t, { packMark, installMs: DOWNLOAD_MS });
  assert.equal(control.getState().packPending, true);
  control.turnOff();
  control.turnOn(null);
  assert.equal(control.getState().packPending, true);
});

test('표시가 남아 있는 동안 글 없이 끝난 듣기는 말소리가 없었던 것이 아니라 준비되지 않은 것으로 알리고, 음성 입력을 끄지 않는다', async (t) => {
  const { control, recognition, tick } = await turnedOn(t, { installMs: DOWNLOAD_MS });
  const heard: ListenResult[] = [];
  // 인식 팩을 내려받은 세션의 마이크 경로에서 잰 차례: start가 오고, 결과 없이 no-speech와 end가 온다.
  control.listen((result) => heard.push(result));
  recognition.last.started();
  recognition.last.error('no-speech');
  recognition.last.end();
  assert.deepEqual(heard, [{ transcript: '', problem: 'not-ready' }]);
  assert.deepEqual([control.getState().blocked, control.getState().listening, control.getState().packPending], [null, false, true]);
  // 브라우저가 오류를 내지 않아 앱이 시간 제한(첫 결과 10초)으로 끝낸 듣기도 같다. 표시가 남아 있어도 다시 누를 수 있다.
  control.listen((result) => heard.push(result));
  recognition.last.started();
  tick(10_000);
  recognition.last.end();
  assert.deepEqual(heard[1], { transcript: '', problem: 'not-ready' });
  assert.deepEqual([control.getState().blocked, recognition.created.length], [null, 2]);
});

test('표시가 남아 있어도 듣기를 막지 않고, 글이 오면 표시를 지운다. 그 뒤로 글 없이 끝난 듣기는 말소리가 없었던 것이다', async (t) => {
  const { control, recognition, packMark } = await turnedOn(t, { installMs: DOWNLOAD_MS });
  const heard: ListenResult[] = [];
  control.listen((result) => heard.push(result));
  assert.deepEqual([control.getState().listening, recognition.last.processLocally], [true, true]);
  recognition.last.started();
  recognition.last.result('거짓말은 옳지 않습니다');
  // 듣는 동안에는 그대로 둔다. 화면의 안내가 듣는 중에 바뀌지 않게 한다.
  assert.equal(control.getState().packPending, true);
  recognition.last.end();
  assert.deepEqual([...heard], [{ transcript: '거짓말은 옳지 않습니다', problem: null }]);
  assert.deepEqual([control.getState().packPending, packMark.stored], [false, false]);

  control.listen((result) => heard.push(result));
  recognition.last.error('no-speech');
  recognition.last.end();
  assert.deepEqual(heard[1], { transcript: '', problem: 'no-speech' });
  // 껐다 켜도, 페이지를 새로 열어도 표시는 돌아오지 않는다.
  control.turnOff();
  control.turnOn(null);
  assert.equal(control.getState().packPending, false);
  const reopened = await turnedOn(t, { packMark });
  assert.equal(reopened.control.getState().packPending, false);
});

test('기기 안 인식을 쓰지 못하면 표시가 남아 있어도 적지 않고, 말소리 없음도 그대로 알린다', async () => {
  const packMark = new FakePackMark();
  packMark.stored = true;
  const { control, recognition } = setup({ onDevice: false, packMark });
  control.turnOn(null);
  await settle();
  assert.deepEqual([control.getState().place, control.getState().packPending], ['unknown', false]);
  const heard: ListenResult[] = [];
  control.listen((result) => heard.push(result));
  recognition.last.error('no-speech');
  recognition.last.end();
  assert.deepEqual(heard, [{ transcript: '', problem: 'no-speech' }]);
  // 브라우저가 정한 방식으로 들은 글은 기기 안 인식이 된다는 증거가 아니다. 표시를 지우지 않는다.
  control.listen((result) => heard.push(result));
  recognition.last.result('네');
  recognition.last.end();
  assert.deepEqual([heard[1], packMark.stored], [{ transcript: '네', problem: null }, true]);
});

test('기억해 둔 목소리의 이름은 켜기 전부터 상태에 실리고, 고르거나 거두면 함께 바뀐다', () => {
  const { control, speech } = setup({ voices: REMOTE_ONLY_VOICES, remembered: 'Google 한국의' });
  // 켜자마자 이 목소리로 읽으므로, 화면이 켜기 전에 미리 밝힐 수 있어야 한다.
  assert.deepEqual([control.getState().on, control.getState().remembered], [false, 'Google 한국의']);
  control.turnOn(null);
  speech.emit(REMOTE_ONLY_VOICES, true);
  control.preferVoice(null);
  assert.equal(control.getState().remembered, null);
  control.preferVoice('Google 한국의');
  control.turnOff();
  assert.deepEqual([control.getState().on, control.getState().remembered], [false, 'Google 한국의']);
  // 기억해 둔 것이 없는 브라우저.
  assert.equal(setup().control.getState().remembered, null);
});

test('지난번에 고른 목소리로 읽고, 새로 고르면 기억해 두고 다음 읽기부터 쓴다. 읽던 말을 다시 읽지 않는다', async (t) => {
  const { control, synth, remembered } = await turnedOn(t, { remembered: 'Flo (Korean (South Korea))' }, OPENING);
  assert.deepEqual(
    synth.spoken.map((item) => item.chunk.voice.name),
    ['Flo (Korean (South Korea))', 'Flo (Korean (South Korea))'],
  );
  synth.start(0);
  // 목록을 넘기다 원격 목소리를 지나가도, 읽던 글이 그 목소리로 다시 나가지 않는다.
  const cancels = synth.cancels;
  control.preferVoice('Google 한국의');
  control.preferVoice('Yuna');
  assert.equal(remembered(), 'Yuna');
  const chosen = control.getState().voice;
  assert.equal(typeof chosen === 'object' && chosen?.name, 'Yuna');
  assert.deepEqual([synth.spoken.length, synth.cancels, control.getState().reading], [2, cancels, 'g1:1']);
  control.read(REPLY);
  assert.deepEqual(
    synth.spoken.slice(2).map((item) => [item.chunk.text, item.chunk.voice.name]),
    [['그 반론은 받아들입니다.', 'Yuna']],
  );
});

test('상태가 바뀔 때만 구독자를 부르고, 구독을 그만두면 부르지 않는다', async (t) => {
  const { control, notified } = await turnedOn(t);
  const before = notified();
  const seen = control.getState();
  // 바뀌는 것이 없는 동작은 알리지 않고, 상태 객체도 그대로다(React가 같은 상태로 다시 그리지 않게).
  control.stopReading();
  control.cancelListening();
  control.finishListening();
  assert.equal(notified(), before);
  assert.equal(control.getState(), seen);

  let mine = 0;
  const unsubscribe = control.subscribe(() => {
    mine += 1;
  });
  control.read(REPLY);
  assert.ok(mine > 0);
  assert.notEqual(control.getState(), seen);
  const counted = mine;
  unsubscribe();
  control.stopReading();
  assert.equal(mine, counted);
});
