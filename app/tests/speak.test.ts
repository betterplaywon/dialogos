import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chooseVoice,
  createSpeaker,
  koreanVoices,
  SPEAK_PROBLEMS,
  SPEECH_CHUNK_CHARS,
  splitForSpeech,
  styleOf,
  type SpeakProblem,
} from '../web/src/speak.ts';
import { FakeSynth, MEASURED_VOICES, REMOTE_ONLY_VOICES, voice } from './voice-fakes.ts';

const letters = (text: string) => text.replace(/[^\p{L}\p{N}]/gu, '');

test('읽을 글은 문장 끝과 줄바꿈에서 나눈다', () => {
  assert.deepEqual(splitForSpeech('저는 반대로 생각합니다. 정말 그렇습니까? 아닙니다! 글쎄요… 다시 보겠습니다.'), [
    '저는 반대로 생각합니다.',
    '정말 그렇습니까?',
    '아닙니다!',
    '글쎄요…',
    '다시 보겠습니다.',
  ]);
  assert.deepEqual(splitForSpeech('첫 줄입니다\n\n  둘째 줄입니다  \n셋째 줄'), ['첫 줄입니다', '둘째 줄입니다', '셋째 줄']);
  // 닫는 따옴표와 괄호는 앞 문장에 붙인다.
  assert.deepEqual(splitForSpeech('그는 "아닙니다." 라고 했습니다. (정말입니다.) 끝.'), ['그는 "아닙니다."', '라고 했습니다.', '(정말입니다.)', '끝.']);
});

test('소수점처럼 뒤에 공백이 없는 마침표에서는 나누지 않는다', () => {
  assert.deepEqual(splitForSpeech('평균은 3.5점입니다. 버전은 1.2.3입니다.'), ['평균은 3.5점입니다.', '버전은 1.2.3입니다.']);
});

test('긴 문장은 쉼표에서, 그래도 길면 공백에서 나눠 상한 안에 들게 한다', () => {
  // 쉼표에서 나눈 조각은 상한 안에서 다시 붙인다.
  assert.deepEqual(splitForSpeech('하나, 둘, 셋, 넷, 다섯.', 8), ['하나, 둘,', '셋, 넷,', '다섯.']);
  // 쉼표가 없으면 공백에서 나눈다.
  assert.deepEqual(splitForSpeech('가나다 라마바 사아자 차카타', 8), ['가나다 라마바', '사아자 차카타']);
  // 쉼표로 나눈 조각 하나가 여전히 길면 그 조각만 공백에서 나눈다.
  assert.deepEqual(splitForSpeech('짧다, 이것은 꽤나 길게 이어지는 조각이다, 끝', 10), ['짧다,', '이것은 꽤나 길게', '이어지는 조각이다,', '끝']);
  // 공백도 없는 덩어리는 글자 수로 자른다.
  assert.deepEqual(splitForSpeech('가나다라마바사아자차', 4), ['가나다라', '마바사아', '자차']);
  // 천 단위 쉼표(뒤에 공백이 없다)에서는 나누지 않는다.
  assert.deepEqual(splitForSpeech('값은 1,000원입니다', 10), ['값은', '1,000원입니다']);
});

test('기본 상한은 80자이고, 어떤 글도 상한을 넘는 조각을 남기지 않으며 글자를 잃지 않는다', () => {
  assert.equal(SPEECH_CHUNK_CHARS, 80);
  const long =
    '거짓말은 결과가 좋더라도 옳지 않다고 생각합니다. 모두가 거짓말을 하면 약속이 성립하지 않기 때문입니다, 그리고 약속이 성립하지 않으면 우리가 서로를 믿고 함께 일하는 데 필요한 바탕이 무너지고, 그 바탕 없이는 좋은 결과라는 것도 오래 지킬 수 없게 됩니다. 그렇다면 친구를 지키려고 한 거짓말은 어떻습니까?\n저는 한 번의 예외가 원칙 전체를 무너뜨린다고 보지 않습니다.';
  const chunks = splitForSpeech(long);
  assert.ok(chunks.length >= 5, String(chunks.length));
  for (const chunk of chunks) assert.ok(chunk.length <= 80, `${chunk.length}자: ${chunk}`);
  assert.equal(letters(chunks.join('')), letters(long));
});

test('빈 글과 소리 낼 글자가 없는 조각은 버린다', () => {
  assert.deepEqual(splitForSpeech(''), []);
  assert.deepEqual(splitForSpeech('  \n \n'), []);
  assert.deepEqual(splitForSpeech('… ?! \n--'), []);
  assert.deepEqual(splitForSpeech('네. … 아니요.'), ['네.', '아니요.']);
});

test('한국어 목소리는 기기 안의 자연스러운 목소리부터, 원격 목소리를 마지막에 둔다', () => {
  assert.deepEqual(
    koreanVoices(MEASURED_VOICES).map((item) => item.name),
    [
      'Yuna',
      'Eddy (Korean (South Korea))',
      'Flo (Korean (South Korea))',
      'Grandma (Korean (South Korea))',
      'Grandpa (Korean (South Korea))',
      'Reed (Korean (South Korea))',
      'Rocko (Korean (South Korea))',
      'Sandy (Korean (South Korea))',
      'Shelley (Korean (South Korea))',
      'Google 한국의',
    ],
  );
  // 받은 목록은 건드리지 않는다.
  assert.equal(MEASURED_VOICES[0]?.name, 'Samantha');
});

test('목소리의 차례는 고품질 유나, 유나, Microsoft 한국어, 그 밖의 기기 목소리, 기계음, 원격 순이다', () => {
  const mixed = [
    voice('Google 한국의', 'ko-KR', false),
    voice('Microsoft SunHi Online (Natural) - Korean (Korea)', 'ko-KR', false),
    voice('Sandy (한국어(대한민국))'),
    voice('Korean South Korea', 'ko_KR'),
    voice('시스템 한국어', 'ko', true, true),
    voice('Microsoft Heami - Korean (Korean)'),
    voice('유나'),
    voice('Yuna (Enhanced)'),
    voice('유나(프리미엄)'),
    voice('Yunah'),
  ];
  assert.deepEqual(
    koreanVoices(mixed).map((item) => item.name),
    [
      'Yuna (Enhanced)',
      '유나(프리미엄)',
      '유나',
      'Microsoft Heami - Korean (Korean)',
      // 차례가 같으면 브라우저의 기본 목소리가 먼저, 그다음은 받은 차례다.
      '시스템 한국어',
      'Korean South Korea',
      'Yunah',
      'Sandy (한국어(대한민국))',
      // 이름이 Microsoft여도 기기 밖 목소리는 원격이다.
      'Google 한국의',
      'Microsoft SunHi Online (Natural) - Korean (Korea)',
    ],
  );
});

test('한국어가 아닌 목소리는 뺀다. ko_KR처럼 밑줄을 쓴 것은 한국어다', () => {
  const names = koreanVoices([
    voice('영어', 'en-US'),
    voice('밑줄', 'ko_KR'),
    voice('대문자', 'KO-kr'),
    voice('말만', 'ko'),
    voice('콘칸어', 'kok-IN'),
    voice('일본어', 'ja-JP'),
    voice('빈 말', ''),
  ]).map((item) => item.name);
  assert.deepEqual(names, ['밑줄', '대문자', '말만']);
});

test('기기 안 한국어 목소리가 있으면 목록이 다 오기 전에도 그 가운데 가장 좋은 것을 쓴다', () => {
  assert.equal(chooseVoice(MEASURED_VOICES, null, false), MEASURED_VOICES.find((item) => item.name === 'Yuna'));
  assert.equal(chooseVoice(MEASURED_VOICES, null, true), MEASURED_VOICES.find((item) => item.name === 'Yuna'));
});

test('기기 안 목소리가 없으면 목록이 다 올 때까지 기다리고, 다 온 뒤에만 원격 목소리를 쓴다', () => {
  // 처음에는 빈 목록이고, 곧 원격 목소리만 먼저 온다(실측).
  assert.equal(chooseVoice([], null, false), 'wait');
  assert.equal(chooseVoice(REMOTE_ONLY_VOICES, null, false), 'wait');
  assert.equal(chooseVoice(REMOTE_ONLY_VOICES, null, true), REMOTE_ONLY_VOICES.find((item) => item.name === 'Google 한국의'));
});

test('목록이 다 왔는데 한국어 목소리가 없으면 읽을 목소리가 없다', () => {
  assert.equal(chooseVoice([], null, true), null);
  assert.equal(chooseVoice([voice('Samantha', 'en-US', true, true), voice('Google 日本語', 'ja-JP', false)], null, true), null);
});

test('사용자가 고른 목소리가 목록에 있으면 그것을 쓰고, 없으면 고르지 않은 것처럼 정한다', () => {
  const flo = MEASURED_VOICES.find((item) => item.name === 'Flo (Korean (South Korea))');
  assert.equal(chooseVoice(MEASURED_VOICES, 'Flo (Korean (South Korea))', false), flo);
  // 사용자가 원격 목소리를 골랐으면 기기 목소리가 있어도 그것을 쓴다.
  assert.equal(chooseVoice(MEASURED_VOICES, 'Google 한국의', false), MEASURED_VOICES.find((item) => item.name === 'Google 한국의'));
  // 고른 기기 목소리가 아직 오지 않았으면 원격 목소리로 대신하지 않고 기다린다.
  assert.equal(chooseVoice(REMOTE_ONLY_VOICES, 'Yuna', false), 'wait');
  const yuna = MEASURED_VOICES.find((item) => item.name === 'Yuna');
  assert.equal(chooseVoice(MEASURED_VOICES, '없는 목소리', true), yuna);
  // 한국어가 아닌 목소리의 이름은 고른 것으로 치지 않는다.
  assert.equal(chooseVoice(MEASURED_VOICES, 'Samantha', true), yuna);
});

test('캐릭터마다 속도와 높낮이가 다르고, 모르는 캐릭터는 보통으로 읽는다', () => {
  const quick = styleOf('utilitarian');
  const slow = styleOf('deontologist');
  assert.ok(quick.rate > 1 && quick.pitch > 1, JSON.stringify(quick));
  assert.ok(slow.rate < 1 && slow.pitch < 1, JSON.stringify(slow));
  assert.deepEqual(styleOf('처음 보는 캐릭터'), { rate: 1, pitch: 1 });
  assert.deepEqual(styleOf(undefined), { rate: 1, pitch: 1 });
  assert.deepEqual(styleOf('constructor'), { rate: 1, pitch: 1 });
});

const YUNA = voice('Yuna');
const STYLE = { rate: 1.08, pitch: 1.15 };

/** 가짜 합성기에 읽기 제어기를 붙이고, 끝났다는 알림을 적어 둔다. */
function speaker() {
  const synth = new FakeSynth();
  const done: (SpeakProblem | null)[] = [];
  return { synth, done, speaker: createSpeaker(synth), onDone: (problem: SpeakProblem | null) => done.push(problem) };
}

test('읽을 글의 조각을 모두 한꺼번에 차례대로 넣고, 마지막 조각이 끝나면 한 번 알린다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.', YUNA, STYLE, onDone);
  assert.deepEqual(
    synth.spoken.map((item) => item.chunk),
    [
      { text: '첫 문장입니다.', voice: YUNA, rate: 1.08, pitch: 1.15 },
      { text: '둘째 문장입니다.', voice: YUNA, rate: 1.08, pitch: 1.15 },
      { text: '셋째 문장입니다.', voice: YUNA, rate: 1.08, pitch: 1.15 },
    ],
  );
  synth.finish(0);
  synth.finish(1);
  assert.deepEqual(done, []);
  synth.finish(2);
  assert.deepEqual(done, [null]);
  // 같은 조각의 이벤트가 다시 와도 한 번만 알린다.
  synth.finish(2);
  assert.deepEqual(done, [null]);
});

test('읽을 조각이 없으면 아무것도 넣지 않고 바로 끝났다고 알린다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say(' … ', YUNA, STYLE, onDone);
  assert.deepEqual(synth.texts(), []);
  assert.deepEqual(done, [null]);
});

test('stop하면 대기열을 끊고, 끊긴 읽기는 끝났다고 알리지 않는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  const before = synth.cancels;
  reader.stop();
  assert.equal(synth.cancels, before + 1);
  // 읽던 조각은 interrupted로 끝나고, 대기 중이던 조각은 아무 이벤트도 오지 않는다(실측).
  synth.finish(0, 'interrupted');
  assert.deepEqual(done, []);
});

test('새로 읽으면 앞의 읽기를 끊고, 끊긴 조각이 늦게 낸 이벤트는 새 읽기에 영향을 주지 않는다', () => {
  const { synth, speaker: reader } = speaker();
  const first: (SpeakProblem | null)[] = [];
  const second: (SpeakProblem | null)[] = [];
  reader.say('앞의 글 하나. 앞의 글 둘.', YUNA, STYLE, (problem) => first.push(problem));
  const before = synth.cancels;
  reader.say('새 글 하나. 새 글 둘.', YUNA, STYLE, (problem) => second.push(problem));
  // 앞의 것을 끊은 뒤에 새 조각을 넣는다.
  assert.equal(synth.cancels, before + 1);
  assert.deepEqual(synth.texts(), ['앞의 글 하나.', '앞의 글 둘.', '새 글 하나.', '새 글 둘.']);
  // 앞 세대의 조각이 끊기며 낸 오류와, 그사이 끝까지 읽힌 조각의 end가 늦게 온다.
  synth.finish(0, 'interrupted');
  synth.finish(1, 'end');
  assert.deepEqual([first, second], [[], []]);
  synth.finish(2);
  synth.finish(3);
  assert.deepEqual([first, second], [[], [null]]);
});

test('브라우저가 소리 재생을 막으면 남은 조각을 끊고 막혔다고 따로 알린다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  const before = synth.cancels;
  synth.finish(0, 'not-allowed');
  assert.deepEqual(done, ['blocked']);
  assert.equal(synth.cancels, before + 1);
  // 남은 조각의 이벤트가 와도 다시 알리지 않는다.
  synth.finish(1, 'not-allowed');
  synth.finish(1);
  assert.deepEqual(done, ['blocked']);
});

test('조각이 넣자마자 오류로 끝나면 남은 조각은 넣지 않는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  synth.failWith = 'not-allowed';
  reader.say('첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.', YUNA, STYLE, onDone);
  assert.deepEqual(synth.texts(), ['첫 문장입니다.']);
  assert.deepEqual(done, ['blocked']);
});

test('앱이 끊지 않았는데 끊긴 읽기와 그 밖의 오류는 문제로 알린다', () => {
  const cases: [string, SpeakProblem][] = [
    ['interrupted', 'interrupted'],
    ['canceled', 'interrupted'],
    ['synthesis-failed', 'failed'],
    ['network', 'failed'],
    ['voice-unavailable', 'failed'],
  ];
  for (const [outcome, problem] of cases) {
    const { synth, done, speaker: reader, onDone } = speaker();
    reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
    synth.finish(1, outcome);
    assert.deepEqual(done, [problem], outcome);
  }
  for (const message of Object.values(SPEAK_PROBLEMS)) assert.match(message, /[가-힣]/);
});

test('문제로 끝난 뒤에도 다시 읽을 수 있다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다.', YUNA, STYLE, onDone);
  synth.finish(0, 'synthesis-failed');
  reader.say('다시 읽습니다.', YUNA, STYLE, onDone);
  synth.finish(1);
  assert.deepEqual(done, ['failed', null]);
});
