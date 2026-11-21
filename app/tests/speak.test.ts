import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
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

// 읽기 제어기는 넣은 조각의 시작을 타이머로 감시한다. 이 파일의 검사는 모두 가짜 타이머로 돌려, 6초짜리 실제 타이머가 검사 뒤에 남지 않게 한다.
beforeEach((t) => {
  if ('mock' in t) t.mock.timers.enable({ apis: ['setTimeout'] });
});

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

test('목록의 번호는 따로 읽지 않고 뒤의 문장에 붙인다', () => {
  assert.deepEqual(splitForSpeech('근거는 둘입니다. 1. 약속이 무너집니다. 2. 신뢰가 사라집니다.'), [
    '근거는 둘입니다.',
    '1. 약속이 무너집니다.',
    '2. 신뢰가 사라집니다.',
  ]);
  // 숫자로 끝나는 문장은 번호가 아니다.
  assert.deepEqual(splitForSpeech('그 일은 2019년에 있었습니다. 지금은 다릅니다.'), ['그 일은 2019년에 있었습니다.', '지금은 다릅니다.']);
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

test('기기 안 목소리가 없으면 원격 목소리를 스스로 고르지 않는다. 목록이 오는 동안에는 기다리고, 다 온 뒤에는 목소리가 없다', () => {
  // 처음에는 빈 목록이고, 곧 원격 목소리만 먼저 온다(실측).
  assert.equal(chooseVoice([], null, false), 'wait');
  assert.equal(chooseVoice(REMOTE_ONLY_VOICES, null, false), 'wait');
  assert.equal(chooseVoice(REMOTE_ONLY_VOICES, null, true), null);
  // 사용자가 고른 원격 목소리는 쓴다.
  assert.equal(chooseVoice(REMOTE_ONLY_VOICES, 'Google 한국의', true), REMOTE_ONLY_VOICES.find((item) => item.name === 'Google 한국의'));
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
  // 끝까지 읽는 동안 대기열을 끊지 않는다.
  assert.equal(synth.cancels, 0);
});

test('읽을 조각이 없으면 아무것도 넣지 않고 바로 끝났다고 알린다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say(' … ', YUNA, STYLE, onDone);
  assert.deepEqual(synth.texts(), []);
  assert.deepEqual(done, [null]);
});

test('읽히는 중에 stop하면 바로 대기열을 끊고, 끊긴 읽기는 끝났다고 알리지 않는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  synth.start(0);
  reader.stop();
  assert.equal(synth.cancels, 1);
  // 읽던 조각은 interrupted로 끝나고, 대기 중이던 조각은 아무 이벤트도 오지 않는다(실측).
  synth.finish(0, 'interrupted');
  assert.deepEqual(done, []);
});

test('읽기를 넣고 시작하기 전에 stop하면 끊지 않고, 그 문장이 시작할 때 한 번 끊는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  reader.stop();
  // 맨 앞 문장이 시작하기 전에 끊으면 Chrome의 대기열이 멈춘다(실측). 그래서 아직 끊지 않는다.
  assert.equal(synth.cancels, 0);
  synth.start(0);
  assert.equal(synth.cancels, 1);
  assert.deepEqual(synth.queue(), []);
  synth.finish(0, 'interrupted');
  assert.equal(synth.cancels, 1);
  assert.deepEqual(done, []);
});

test('읽히는 중에 새로 읽으면 바로 앞의 읽기를 끊고, 끊긴 조각이 늦게 낸 이벤트는 새 읽기에 영향을 주지 않는다', () => {
  const { synth, speaker: reader } = speaker();
  const first: (SpeakProblem | null)[] = [];
  const second: (SpeakProblem | null)[] = [];
  reader.say('앞의 글 하나. 앞의 글 둘.', YUNA, STYLE, (problem) => first.push(problem));
  synth.start(0);
  reader.say('새 글 하나. 새 글 둘.', YUNA, STYLE, (problem) => second.push(problem));
  // 앞의 것을 끊은 뒤에 새 조각을 넣는다. 그래서 대기열에는 새 조각만 남는다.
  assert.equal(synth.cancels, 1);
  assert.deepEqual(synth.texts(), ['앞의 글 하나.', '앞의 글 둘.', '새 글 하나.', '새 글 둘.']);
  assert.deepEqual(synth.queue(), ['새 글 하나.', '새 글 둘.']);
  // 앞 세대의 조각이 끊기며 낸 오류와, 그사이 끝까지 읽힌 조각의 end가 늦게 온다.
  synth.finish(0, 'interrupted');
  synth.finish(1, 'end');
  assert.deepEqual([first, second], [[], []]);
  synth.finish(2);
  synth.finish(3);
  assert.deepEqual([first, second], [[], [null]]);
});

test('끊긴 조각이 늦게 낸 이벤트는 새 읽기를 읽히는 중으로도, 끝난 것으로도 만들지 않는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('앞의 글 하나. 앞의 글 둘.', YUNA, STYLE, onDone);
  synth.start(0);
  reader.say('새 글 하나. 새 글 둘.', YUNA, STYLE, onDone);
  // 끊는 순간 합성기가 다음 조각으로 넘어가고 있었다면, 끊긴 조각들의 end와 start가 늦게 올 수 있다(추정).
  synth.finish(0);
  synth.start(1);
  synth.finish(1, 'interrupted');
  // 새 읽기는 아직 시작 전이다. 지금 stop해도 끊지 않고, 새 읽기의 조각이 시작하면 그때 끊는다.
  reader.stop();
  assert.deepEqual([synth.cancels, synth.queue()], [1, ['새 글 하나.', '새 글 둘.']]);
  synth.start(2);
  assert.deepEqual([synth.cancels, synth.queue(), done], [2, [], []]);
});

test('읽기, stop, 새 읽기가 한 틱에 와도 앞의 문장이 시작하기 전에는 끊지 않고, 시작하면 끊은 뒤 새 읽기를 넣는다', () => {
  const { synth, speaker: reader } = speaker();
  const first: (SpeakProblem | null)[] = [];
  const second: (SpeakProblem | null)[] = [];
  // 개발 서버의 React StrictMode가 판 화면의 효과를 두 번 돌릴 때의 순서다.
  reader.say('앞의 글 하나. 앞의 글 둘.', YUNA, STYLE, (problem) => first.push(problem));
  reader.stop();
  reader.say('새 글 하나. 새 글 둘.', YUNA, STYLE, (problem) => second.push(problem));
  assert.equal(synth.cancels, 0);
  assert.deepEqual(synth.queue(), ['앞의 글 하나.', '앞의 글 둘.']);
  synth.start(0);
  assert.equal(synth.cancels, 1);
  assert.deepEqual(synth.queue(), ['새 글 하나.', '새 글 둘.']);
  synth.finish(0, 'interrupted');
  synth.finish(2);
  assert.deepEqual([first, second], [[], []]);
  synth.finish(3);
  assert.deepEqual([first, second], [[], [null]]);
  assert.equal(synth.cancels, 1);
});

test('시작하기 전에 새 읽기가 두 번 연달아 오면 마지막 것만 읽는다', () => {
  const { synth, speaker: reader } = speaker();
  const done: string[] = [];
  reader.say('첫째 글.', YUNA, STYLE, () => done.push('첫째'));
  reader.say('둘째 글.', YUNA, STYLE, () => done.push('둘째'));
  reader.say('셋째 글.', YUNA, STYLE, () => done.push('셋째'));
  assert.deepEqual([synth.texts(), synth.cancels], [['첫째 글.'], 0]);
  synth.start(0);
  assert.deepEqual([synth.texts(), synth.cancels], [['첫째 글.', '셋째 글.'], 1]);
  synth.finish(1);
  assert.deepEqual(done, ['셋째']);
});

test('문장과 문장 사이에 stop하면 다음 문장이 시작할 때 끊는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.', YUNA, STYLE, onDone);
  // 첫 문장은 끝났고 둘째 문장은 아직 시작 전이다.
  synth.finish(0);
  reader.stop();
  assert.equal(synth.cancels, 0);
  synth.start(1);
  assert.equal(synth.cancels, 1);
  assert.deepEqual(synth.queue(), []);
  assert.deepEqual(done, []);
});

test('문장과 문장 사이에 새로 읽으면 다음 문장이 시작할 때 끊고 새 읽기를 넣는다', () => {
  const { synth, speaker: reader } = speaker();
  const first: (SpeakProblem | null)[] = [];
  const second: (SpeakProblem | null)[] = [];
  reader.say('앞의 글 하나. 앞의 글 둘.', YUNA, STYLE, (problem) => first.push(problem));
  synth.finish(0);
  reader.say('새 글.', YUNA, STYLE, (problem) => second.push(problem));
  assert.deepEqual([synth.cancels, synth.queue()], [0, ['앞의 글 둘.']]);
  synth.start(1);
  assert.deepEqual([synth.cancels, synth.queue()], [1, ['새 글.']]);
  synth.finish(2);
  assert.deepEqual([first, second], [[], [null]]);
});

test('조각이 오류로 끝나면 문제를 한 번 알리고, 남은 조각은 시작할 때 끊는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.', YUNA, STYLE, onDone);
  synth.start(0);
  synth.finish(0, 'synthesis-failed');
  assert.deepEqual(done, ['failed']);
  // 남은 조각은 아직 시작 전이라 끊지 않는다.
  assert.deepEqual([synth.cancels, synth.queue()], [0, ['둘째 문장입니다.', '셋째 문장입니다.']]);
  synth.start(1);
  assert.deepEqual([synth.cancels, synth.queue()], [1, []]);
  synth.finish(1, 'interrupted');
  assert.deepEqual(done, ['failed']);
});

test('오류로 끝난 읽기의 남은 조각이 시작하기 전에 새로 읽으면, 그 조각이 시작할 때 끊고 새 읽기를 넣는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  synth.start(0);
  synth.finish(0, 'synthesis-failed');
  reader.say('다시 읽습니다.', YUNA, STYLE, onDone);
  assert.deepEqual([synth.cancels, synth.queue()], [0, ['둘째 문장입니다.']]);
  synth.start(1);
  assert.deepEqual([synth.cancels, synth.queue()], [1, ['다시 읽습니다.']]);
  synth.finish(2);
  assert.deepEqual(done, ['failed', null]);
});

test('브라우저가 소리 재생을 막으면 막혔다고 따로 알리고, 남은 조각의 오류로 다시 알리지 않는다', (t) => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  synth.finish(0, 'not-allowed');
  assert.deepEqual(done, ['blocked']);
  synth.finish(1, 'not-allowed');
  // 조각이 모두 오류로 끝나 대기열이 비었다. 읽힌 조각이 없었으므로 시간이 지나도 끊지 않는다.
  t.mock.timers.tick(60_000);
  assert.deepEqual([done, synth.cancels], [['blocked'], 0]);
  // 다음 읽기는 바로 넣는다.
  reader.say('다시 읽습니다.', YUNA, STYLE, onDone);
  assert.deepEqual([synth.cancels, synth.queue()], [0, ['다시 읽습니다.']]);
});

test('시작하지 못한 앞의 읽기가 오류로 모두 끝나면, 기다리던 새 읽기를 끊지 않고 넣는다', () => {
  const { synth, speaker: reader } = speaker();
  const first: (SpeakProblem | null)[] = [];
  const second: (SpeakProblem | null)[] = [];
  reader.say('앞의 글 하나. 앞의 글 둘.', YUNA, STYLE, (problem) => first.push(problem));
  reader.say('새 글.', YUNA, STYLE, (problem) => second.push(problem));
  synth.finish(0, 'not-allowed');
  assert.deepEqual(synth.queue(), ['앞의 글 둘.']);
  synth.finish(1, 'not-allowed');
  assert.deepEqual([synth.cancels, synth.queue()], [0, ['새 글.']]);
  // 새 읽기에 밀린 앞의 읽기는 문제도 알리지 않는다.
  synth.finish(2);
  assert.deepEqual([first, second], [[], [null]]);
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

test('읽는 것이 없을 때는 대기열을 끊지 않는다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  // 아무것도 읽지 않았을 때의 stop과 첫 읽기.
  reader.stop();
  reader.say('첫 문장입니다.', YUNA, STYLE, onDone);
  assert.equal(synth.cancels, 0);
  // 끝까지 읽은 뒤의 stop과 다음 읽기.
  synth.finish(0);
  reader.stop();
  reader.say('다음 문장입니다.', YUNA, STYLE, onDone);
  assert.equal(synth.cancels, 0);
  // 읽히는 중에 새로 읽을 때만 끊는다.
  synth.start(1);
  reader.say('끼어든 문장입니다.', YUNA, STYLE, onDone);
  assert.equal(synth.cancels, 1);
  assert.deepEqual(done, [null]);
});

test('문제로 끝난 뒤에도 다시 읽을 수 있다', () => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다.', YUNA, STYLE, onDone);
  synth.finish(0, 'synthesis-failed');
  reader.say('다시 읽습니다.', YUNA, STYLE, onDone);
  synth.finish(1);
  assert.deepEqual(done, ['failed', null]);
});

test('넣은 조각이 6초 동안 시작하지 않으면 문제로 한 번 알리고, 그 뒤의 읽기는 다시 넣는다', (t) => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  // 합성기가 멈췄다. start도 end도 오류도 오지 않는다.
  synth.stalled = true;
  t.mock.timers.tick(5_900);
  assert.deepEqual([done, synth.cancels], [[], 0]);
  t.mock.timers.tick(100);
  // 멈춘 대기열은 비운다.
  assert.deepEqual([done, synth.cancels, synth.queue()], [['failed'], 1, []]);
  t.mock.timers.tick(60_000);
  assert.deepEqual([done, synth.cancels], [['failed'], 1]);
  reader.say('다시 읽습니다.', YUNA, STYLE, onDone);
  assert.deepEqual(synth.queue(), ['다시 읽습니다.']);
  synth.finish(2);
  assert.deepEqual(done, ['failed', null]);
});

test('읽히는 동안에는 시간을 재지 않고, 문장 사이에서 다시 6초를 잰다', (t) => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다. 둘째 문장입니다.', YUNA, STYLE, onDone);
  t.mock.timers.tick(5_900);
  synth.start(0);
  // 긴 문장은 읽는 데 6초를 넘긴다(80자는 약 10초). 읽히는 중이면 멈춘 것이 아니다.
  t.mock.timers.tick(30_000);
  assert.deepEqual([done, synth.cancels], [[], 0]);
  synth.finish(0);
  synth.stalled = true;
  t.mock.timers.tick(5_900);
  assert.deepEqual([done, synth.cancels], [[], 0]);
  t.mock.timers.tick(100);
  assert.deepEqual([done, synth.cancels], [['failed'], 1]);
});

test('끝까지 읽은 뒤와 읽히는 중에 끊은 뒤에는 시간이 지나도 문제로 알리지 않는다', (t) => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다.', YUNA, STYLE, onDone);
  synth.finish(0);
  t.mock.timers.tick(60_000);
  reader.say('다음 문장입니다.', YUNA, STYLE, onDone);
  synth.start(1);
  reader.stop();
  t.mock.timers.tick(60_000);
  assert.deepEqual([done, synth.cancels], [[null], 1]);
});

test('멈춘 대기열에서는 끊긴 읽기를 알리지 않고, 기다리던 새 읽기를 이어서 넣는다', (t) => {
  const { synth, speaker: reader } = speaker();
  const first: (SpeakProblem | null)[] = [];
  const second: (SpeakProblem | null)[] = [];
  reader.say('앞의 글.', YUNA, STYLE, (problem) => first.push(problem));
  reader.say('새 글.', YUNA, STYLE, (problem) => second.push(problem));
  synth.stalled = true;
  t.mock.timers.tick(6_000);
  assert.deepEqual([first, second, synth.cancels, synth.queue()], [[], [], 1, ['새 글.']]);
  // 끊고 넣은 새 읽기가 되살아나 끝까지 읽힌다.
  synth.finish(1);
  assert.deepEqual([first, second], [[], [null]]);
});

test('멈춘 대기열에서 stop으로 끊긴 읽기는 알리지 않고, 6초 뒤에 대기열만 비운다', (t) => {
  const { synth, done, speaker: reader, onDone } = speaker();
  reader.say('첫 문장입니다.', YUNA, STYLE, onDone);
  reader.stop();
  synth.stalled = true;
  t.mock.timers.tick(6_000);
  assert.deepEqual([done, synth.cancels, synth.queue()], [[], 1, []]);
});

test('가짜 합성기는 읽히는 조각이 없을 때의 cancel을 잡아낸다', () => {
  const chunk = (text: string) => ({ text, voice: YUNA, rate: 1, pitch: 1 });
  const events = { onStart() {}, onDone() {} };
  const early = /시작 전의 cancel/;
  const synth = new FakeSynth();
  // 빈 대기열은 끊어도 된다.
  synth.cancel();
  // 넣었지만 시작 전이다(Chrome 157에서 대기열이 멈춘 순서).
  synth.speak(chunk('하나.'), events);
  synth.speak(chunk('둘.'), events);
  assert.throws(() => synth.cancel(), early);
  // 읽히는 중이면 끊어도 된다.
  synth.start(0);
  synth.cancel();
  assert.deepEqual([synth.cancels, synth.queue()], [2, []]);
  // 문장과 문장 사이다.
  synth.speak(chunk('셋.'), events);
  synth.speak(chunk('넷.'), events);
  synth.finish(2);
  assert.throws(() => synth.cancel(), early);
  // 이미 멈춘 대기열은 한 번 끊을 수 있다. 그 뒤에 넣은 조각은 다시 지켜본다.
  synth.stalled = true;
  synth.cancel();
  synth.speak(chunk('다섯.'), events);
  assert.throws(() => synth.cancel(), early);
  assert.equal(synth.cancels, 3);
});
