import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  LISTEN_PROBLEMS,
  LISTEN_TIMINGS,
  listenOnce,
  PLACE_NOTICES,
  prepareRecognition,
  type ListenProblem,
  type ListenResult,
  type OnDevicePort,
} from '../web/src/listen.ts';
import { FakeRecognizer } from './voice-fakes.ts';

const mocked = new WeakSet<TestContext>();

/** 가짜 인식기로 한 발화 듣기를 시작한다. 시간은 가짜 타이머로 돌린다(실제로 기다리지 않는다). */
function listen(t: TestContext, options: { processLocally?: boolean; startError?: Error } = {}) {
  if (!mocked.has(t)) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    mocked.add(t);
  }
  const recognizer = new FakeRecognizer();
  recognizer.startError = options.startError ?? null;
  const interims: string[] = [];
  const done: ListenResult[] = [];
  const session = listenOnce(
    recognizer,
    { processLocally: options.processLocally ?? false },
    { onInterim: (text) => interims.push(text), onDone: (result) => done.push(result) },
  );
  return { recognizer, interims, done, session, tick: (ms: number) => t.mock.timers.tick(ms) };
}

test('시간 제한은 첫 결과 10초, 조용함 2.5초, 멈춤 3초다', () => {
  assert.deepEqual(LISTEN_TIMINGS, { firstResultMs: 10_000, silenceMs: 2_500, stopMs: 3_000 });
});

test('인식기를 한국어, 한 발화, 중간 결과로 맞추고 한 번 시작한다', (t) => {
  const { recognizer } = listen(t);
  assert.deepEqual(
    [recognizer.lang, recognizer.continuous, recognizer.interimResults, recognizer.maxAlternatives],
    ['ko-KR', false, true, 1],
  );
  assert.deepEqual(recognizer.calls, ['start']);
  // 기기 안 인식이 확인되지 않았으면 processLocally를 건드리지 않는다(이 속성이 없는 브라우저가 있다).
  assert.equal(Object.hasOwn(recognizer, 'processLocally'), false);
});

test('기기 안 인식이 확인됐을 때만 processLocally를 켠다', (t) => {
  assert.equal(listen(t, { processLocally: true }).recognizer.processLocally, true);
});

test('중간 결과가 바뀔 때마다 알리고, 브라우저가 확정하고 끝내면 그 글로 한 번 끝난다', (t) => {
  const { recognizer, interims, done } = listen(t);
  recognizer.started();
  recognizer.result('거짓말은');
  recognizer.result('거짓말은 옳지');
  recognizer.result('거짓말은 옳지');
  recognizer.result('거짓말은 옳지 않습니다');
  assert.deepEqual(done, []);
  recognizer.end();
  // 같은 글이 다시 오면 알리지 않는다.
  assert.deepEqual(interims, ['거짓말은', '거짓말은 옳지', '거짓말은 옳지 않습니다']);
  assert.deepEqual(done, [{ transcript: '거짓말은 옳지 않습니다', problem: null }]);
  // 브라우저가 스스로 끝냈으므로 stop을 부르지 않았다.
  assert.deepEqual(recognizer.calls, ['start']);
});

test('스스로 끝내지 않는 인식기는 조용해진 지 2.5초 뒤에 stop을 한 번 불러 확정된 글을 받는다', (t) => {
  const { recognizer, done, tick } = listen(t);
  recognizer.started();
  tick(1_000);
  recognizer.result('거짓말은');
  tick(2_000);
  // 결과가 올 때마다 조용함을 처음부터 다시 잰다.
  recognizer.result('거짓말은 옳지 않습니다');
  tick(2_499);
  assert.deepEqual(recognizer.calls, ['start']);
  tick(1);
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
  assert.deepEqual(done, []);
  // stop() 뒤에 확정 결과와 end가 온다(실측). 확정된 글이 중간 글과 달라도 확정된 글을 쓴다.
  recognizer.result('거짓말은 옳지 않습니다 왜냐하면');
  recognizer.end();
  assert.deepEqual(done, [{ transcript: '거짓말은 옳지 않습니다 왜냐하면', problem: null }]);
  // 끝난 뒤에는 시간 제한이 남아 있지 않다.
  tick(60_000);
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
  assert.equal(done.length, 1);
});

test('stop을 부른 뒤에 온 결과는 조용함을 다시 재지 않는다', (t) => {
  const { recognizer, done, tick } = listen(t);
  recognizer.result('거짓말은');
  tick(2_500);
  recognizer.result('거짓말은 옳지 않습니다');
  // 멈춤 제한(3초)만 남아 있다. 조용함(2.5초)을 다시 걸었다면 stop을 한 번 더 불렀을 것이다.
  tick(2_999);
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
  assert.deepEqual(done, []);
  tick(1);
  assert.deepEqual(recognizer.calls, ['start', 'stop', 'abort']);
  assert.deepEqual(done, [{ transcript: '거짓말은 옳지 않습니다', problem: null }]);
});

test('말 마치기를 누른 뒤 확정 결과 없이 끝나면 마지막 중간 글을 쓴다', (t) => {
  const { recognizer, done, session } = listen(t);
  recognizer.result('거짓말은 옳지');
  session.finish();
  // 여러 번 눌러도 stop은 한 번이다.
  session.finish();
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
  recognizer.end();
  assert.deepEqual(done, [{ transcript: '거짓말은 옳지', problem: null }]);
});

test('10초 동안 결과가 없으면 stop을 부르고, 3초 안에 끝나지 않으면 abort한 뒤 말소리 없음으로 끝난다', (t) => {
  const { recognizer, done, tick } = listen(t);
  tick(9_999);
  assert.deepEqual(recognizer.calls, ['start']);
  tick(1);
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
  tick(2_999);
  assert.deepEqual(done, []);
  tick(1);
  assert.deepEqual(recognizer.calls, ['start', 'stop', 'abort']);
  assert.deepEqual(done, [{ transcript: '', problem: 'no-speech' }]);
  // 앱이 부른 abort의 오류와 end는 문제로 치지 않는다.
  recognizer.error('aborted');
  recognizer.end();
  assert.equal(done.length, 1);
});

test('인식기가 듣기 시작했다고 알리면 첫 결과를 그때부터 10초 기다린다', (t) => {
  const { recognizer, tick } = listen(t);
  // 마이크 허락 창에 답하는 동안.
  tick(8_000);
  recognizer.started();
  tick(9_999);
  assert.deepEqual(recognizer.calls, ['start']);
  tick(1);
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
});

test('빈 결과는 말을 들은 것으로 치지 않는다', (t) => {
  const { recognizer, interims, done, tick } = listen(t);
  recognizer.result('');
  tick(2_500);
  // 조용함을 재는 것이 아니라 첫 결과를 계속 기다린다.
  assert.deepEqual(recognizer.calls, ['start']);
  assert.deepEqual(interims, []);
  tick(7_500);
  assert.deepEqual(recognizer.calls, ['start', 'stop']);
  recognizer.end();
  assert.deepEqual(done, [{ transcript: '', problem: 'no-speech' }]);
});

test('결과가 여럿이면 차례대로 이어 붙이고 공백을 하나로 줄인다', (t) => {
  const { recognizer, done } = listen(t);
  recognizer.result(' 거짓말은  옳지 않습니다', ' 약속이 무너집니다 ');
  recognizer.end();
  assert.deepEqual(done, [{ transcript: '거짓말은 옳지 않습니다 약속이 무너집니다', problem: null }]);
});

test('인식기의 오류 코드를 문제로 옮긴다', (t) => {
  const cases: [string, ListenProblem][] = [
    ['no-speech', 'no-speech'],
    ['audio-capture', 'no-microphone'],
    ['not-allowed', 'not-allowed'],
    ['service-not-allowed', 'service-blocked'],
    ['network', 'network'],
    ['language-not-supported', 'unsupported-language'],
    // 앱이 부르지 않았는데 끊긴 경우.
    ['aborted', 'interrupted'],
    ['phrases-not-supported', 'failed'],
    ['처음 보는 코드', 'failed'],
    ['constructor', 'failed'],
  ];
  for (const [code, problem] of cases) {
    const { recognizer, done } = listen(t);
    recognizer.error(code);
    assert.deepEqual(done, [], code);
    recognizer.end();
    assert.deepEqual(done, [{ transcript: '', problem }], code);
  }
});

test('오류로 끝나도 그때까지 들은 글은 남긴다', (t) => {
  const { recognizer, done } = listen(t);
  recognizer.result('거짓말은 옳지');
  recognizer.error('network');
  recognizer.end();
  assert.deepEqual(done, [{ transcript: '거짓말은 옳지', problem: 'network' }]);
});

test('오류 뒤에 end가 오지 않으면 3초 뒤에 인식기를 끊고 끝낸다', (t) => {
  const { recognizer, done, session, tick } = listen(t);
  recognizer.error('audio-capture');
  // 오류가 난 뒤에는 말 마치기를 눌러도 stop을 부르지 않는다.
  session.finish();
  tick(2_999);
  assert.deepEqual(recognizer.calls, ['start']);
  assert.deepEqual(done, []);
  tick(1);
  assert.deepEqual(recognizer.calls, ['start', 'abort']);
  assert.deepEqual(done, [{ transcript: '', problem: 'no-microphone' }]);
});

test('들은 글이 있으면 말소리 없음을 문제로 치지 않고, 글도 오류도 없이 끝나면 말소리 없음이다', (t) => {
  const heard = listen(t);
  heard.recognizer.result('네');
  heard.recognizer.error('no-speech');
  heard.recognizer.end();
  assert.deepEqual(heard.done, [{ transcript: '네', problem: null }]);

  // 말하지 않고 말 마치기를 눌렀다.
  const silent = listen(t);
  silent.session.finish();
  silent.recognizer.end();
  assert.deepEqual(silent.done, [{ transcript: '', problem: 'no-speech' }]);
});

test('cancel하면 인식기를 끊고, 그 뒤로는 어떤 handler도 부르지 않는다', (t) => {
  const { recognizer, interims, done, session, tick } = listen(t);
  recognizer.result('거짓말은');
  session.cancel();
  assert.deepEqual(recognizer.calls, ['start', 'abort']);
  recognizer.result('거짓말은 옳지 않습니다');
  recognizer.error('aborted');
  recognizer.end();
  tick(60_000);
  session.finish();
  session.cancel();
  assert.deepEqual(interims, ['거짓말은']);
  assert.deepEqual(done, []);
  assert.deepEqual(recognizer.calls, ['start', 'abort']);
});

test('start가 예외를 던지면 문제(failed)로 끝나고 시간 제한을 남기지 않는다', (t) => {
  const { recognizer, done, session, tick } = listen(t, { startError: new Error('InvalidStateError') });
  assert.deepEqual(done, [{ transcript: '', problem: 'failed' }]);
  session.finish();
  tick(60_000);
  assert.deepEqual(recognizer.calls, ['start']);
  assert.equal(done.length, 1);
});

test('끝난 뒤에 오는 이벤트는 무시한다(끝났다는 알림은 한 번)', (t) => {
  const { recognizer, interims, done, session, tick } = listen(t);
  recognizer.result('네');
  recognizer.end();
  recognizer.result('네 맞습니다');
  recognizer.error('network');
  recognizer.end();
  session.finish();
  tick(60_000);
  assert.deepEqual(interims, ['네']);
  assert.deepEqual(done, [{ transcript: '네', problem: null }]);
  assert.deepEqual(recognizer.calls, ['start']);
});

/** 불린 차례를 적어 두는 가짜 기기 안 인식 API. */
function onDevice(install: () => Promise<boolean>, available: () => Promise<string>) {
  const calls: string[] = [];
  const api: OnDevicePort = {
    install(options) {
      calls.push(`install ${JSON.stringify(options)}`);
      return install();
    },
    available(options) {
      calls.push(`available ${JSON.stringify(options)}`);
      return available();
    },
  };
  return { api, calls };
}

const KOREAN_ON_DEVICE = '{"langs":["ko-KR"],"processLocally":true}';

test('기기 안 인식 API가 없는 브라우저는 브라우저가 정하는 방식으로 둔다', async () => {
  assert.equal(await prepareRecognition(null), 'unknown');
});

test('인식 팩을 설치하고 쓸 수 있다고 확인되면 기기 안 인식이다. install은 기다림 없이 먼저 부른다', async () => {
  const { api, calls } = onDevice(
    async () => true,
    async () => 'available',
  );
  const pending = prepareRecognition(api);
  // 사용자의 누름 안에서 불려야 내려받기가 시작되므로, 돌아오기 전에 이미 불려 있어야 한다.
  assert.deepEqual(calls, [`install ${KOREAN_ON_DEVICE}`]);
  assert.equal(await pending, 'device');
  assert.deepEqual(calls, [`install ${KOREAN_ON_DEVICE}`, `available ${KOREAN_ON_DEVICE}`]);
});

test('설치하지 못했으면 기기 안 인식으로 치지 않는다', async () => {
  const refused = onDevice(
    async () => false,
    async () => 'available',
  );
  assert.equal(await prepareRecognition(refused.api), 'unknown');
  assert.deepEqual(refused.calls, [`install ${KOREAN_ON_DEVICE}`]);

  // 설치했다고 했지만 쓸 수 있다고 확인되지 않았다.
  for (const availability of ['downloadable', 'downloading', 'unavailable']) {
    const unconfirmed = onDevice(
      async () => true,
      async () => availability,
    );
    assert.equal(await prepareRecognition(unconfirmed.api), 'unknown', availability);
  }
});

test('설치나 확인이 예외로 끝나면 기기 안 인식으로 치지 않는다', async () => {
  const rejected = onDevice(
    () => Promise.reject(new Error('NotAllowedError')),
    async () => 'available',
  );
  assert.equal(await prepareRecognition(rejected.api), 'unknown');
  const thrown = onDevice(
    () => {
      throw new Error('TypeError');
    },
    async () => 'available',
  );
  assert.equal(await prepareRecognition(thrown.api), 'unknown');
  const unchecked = onDevice(
    async () => true,
    () => Promise.reject(new Error('NotSupportedError')),
  );
  assert.equal(await prepareRecognition(unchecked.api), 'unknown');
});

test('다시 눌러도 풀리지 않는 문제만 음성 입력을 끄고, 문제마다 알릴 말이 있다', () => {
  const blocking = Object.entries(LISTEN_PROBLEMS)
    .filter(([, row]) => row.blocks)
    .map(([problem]) => problem)
    .sort();
  assert.deepEqual(blocking, ['no-microphone', 'not-allowed', 'service-blocked', 'unsupported-language']);
  for (const [problem, row] of Object.entries(LISTEN_PROBLEMS)) {
    assert.match(row.message, /[가-힣]/, problem);
    // 음성 입력을 끄는 문제는 글로 입력하라고 알리고, 나머지는 다시 해 보라고 알린다.
    assert.match(row.message, row.blocks ? /음성 입력을 껐습니다.*글로 입력해 주세요/ : /다시/, problem);
  }
});

test('말소리가 가는 곳을 알리는 말은 기기 안인지, 서버로 갈 수 있는지를 밝힌다', () => {
  assert.match(PLACE_NOTICES.device, /이 기기 안에서/);
  assert.match(PLACE_NOTICES.unknown, /서버로 갈 수 있습니다/);
});
