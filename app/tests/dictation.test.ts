import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takeDictation, turnInputOf, voiceTallyText } from '../web/src/dictation.ts';

test('들은 글을 빈 입력 칸에 넣고, 이 턴의 인식 조각에 더한다', () => {
  assert.deepEqual(takeDictation('', [], '거짓말은 옳지 않습니다', 1000), {
    draft: '거짓말은 옳지 않습니다',
    segments: ['거짓말은 옳지 않습니다'],
    notice: '인식한 글을 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.',
  });
});

test('다시 말하면 입력 칸의 글을 새로 들은 글로 바꾼다(이어 붙이지 않는다)', () => {
  const first = takeDictation('', [], '첫째', 1000);
  assert.deepEqual(takeDictation(first.draft, first.segments, '둘째', 1000), {
    draft: '둘째',
    segments: ['첫째', '둘째'],
    notice: '입력 칸의 글을 새로 인식한 글로 바꿨습니다. 고친 뒤 보내 주세요.',
  });
  // 직접 쓴 글도 바꾼다.
  assert.equal(takeDictation('직접 쓴 글', [], '말한 글', 1000).draft, '말한 글');
  // 공백뿐인 입력 칸은 빈 칸으로 보고 '바꿨다'고 알리지 않는다.
  assert.match(takeDictation('  \n', [], '말한 글', 1000).notice ?? '', /입력 칸에 넣었습니다/);
});

test('앞서 인식된 글을 다시 말해 바꾼 턴은 고친 턴이고, 직접 쓴 글을 말로 바꾼 턴은 말로 넣은 턴이다', () => {
  const first = takeDictation('', [], '알아듣기 어렵게 적힌 글', 1000);
  const again = takeDictation(first.draft, first.segments, '거짓말은 옳지 않습니다', 1000);
  assert.equal(turnInputOf(again.draft, again.segments), 'voice-edited');
  const typed = takeDictation('직접 쓴 글', [], '거짓말은 옳지 않습니다', 1000);
  assert.equal(turnInputOf(typed.draft, typed.segments), 'voice');
});

test('인식된 글의 앞뒤 공백은 떼고, 안의 이어진 공백은 하나로 줄인다', () => {
  assert.equal(takeDictation('', [], '  거짓말은   옳지\n않습니다 ', 1000).draft, '거짓말은 옳지 않습니다');
});

test('들은 글이 없으면 입력 칸과 조각을 그대로 두고 알리지 않는다', () => {
  for (const transcript of ['', '   ', '\n']) {
    assert.deepEqual(takeDictation('쓰던 글', ['쓰던 글'], transcript, 1000), { draft: '쓰던 글', segments: ['쓰던 글'], notice: null });
  }
});

test('글자 수 상한을 넘는 부분은 자르고 그렇게 알린다', () => {
  assert.deepEqual(takeDictation('쓰던 글', [], '가나다라마바사', 5), {
    draft: '가나다라마',
    segments: ['가나다라마'],
    notice: '인식한 글이 길어 앞부분만 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.',
  });
  // 자른 끝이 공백이면 그 공백은 넣지 않는다.
  assert.equal(takeDictation('', [], '가나 다라', 3).draft, '가나');
  // 꼭 맞게 들어가면 잘린 것이 아니다.
  assert.match(takeDictation('', [], '가나다', 3).notice ?? '', /입력 칸에 넣었습니다/);
  // 두 칸짜리 글자(이모지)의 반쪽만 들어가게 자르지 않는다.
  assert.equal(takeDictation('', [], '가😀', 2).draft, '가');
  // 한 글자도 들어가지 못하면 입력 칸과 조각을 그대로 둔다.
  assert.deepEqual(takeDictation('쓰던 글', [], '😀가', 1), { draft: '쓰던 글', segments: [], notice: '인식한 글을 입력 칸에 넣지 못했습니다.' });
});

test('받은 조각 목록은 바꾸지 않는다', () => {
  const segments = ['첫째'];
  takeDictation('첫째', segments, '둘째', 1000);
  assert.deepEqual(segments, ['첫째']);
});

test('인식된 조각이 없으면 글로 넣은 턴이다', () => {
  assert.equal(turnInputOf('글로 쓴 반론입니다.', []), 'text');
  // 글자가 없는 조각(부호뿐)은 조각으로 치지 않는다.
  assert.equal(turnInputOf('글로 쓴 반론입니다.', ['?', ' ']), 'text');
});

test('인식된 글을 그대로 보냈으면 말로 넣은 턴이다', () => {
  assert.equal(turnInputOf('거짓말은 결과가 좋아도 옳지 않습니다', ['거짓말은 결과가 좋아도 옳지 않습니다']), 'voice');
});

test('공백과 문장 부호만 고친 것은 고친 턴으로 세지 않는다', () => {
  const segments = ['거짓말은 결과가 좋아도 옳지 않습니다 왜 그렇습니까'];
  assert.equal(turnInputOf('거짓말은, 결과가 좋아도 옳지 않습니다. 왜 그렇습니까?', segments), 'voice');
  assert.equal(turnInputOf('거짓말은 결과가좋아도 옳지 않습니다\n왜 그렇습니까', segments), 'voice');
  assert.equal(turnInputOf('"거짓말은 결과가 좋아도 옳지 않습니다" — 왜 그렇습니까!', segments), 'voice');
});

test('낱말을 고쳤으면 고친 턴이다', () => {
  const segments = ['거짓말은 결가가 좋아도 옳지 않습니다'];
  assert.equal(turnInputOf('거짓말은 결과가 좋아도 옳지 않습니다', segments), 'voice-edited');
  // 낱말을 빼거나 사이에 끼워 넣은 것도 고친 것이다.
  assert.equal(turnInputOf('거짓말은 좋아도 옳지 않습니다', segments), 'voice-edited');
  assert.equal(turnInputOf('거짓말은 결가가 아무리 좋아도 옳지 않습니다', segments), 'voice-edited');
  // 숫자를 고친 것도 고친 것이다.
  assert.equal(turnInputOf('3명 가운데 2명입니다', ['3명 가운데 1명입니다']), 'voice-edited');
});

test('인식된 글을 지우고 다시 썼으면 고친 턴이다', () => {
  assert.equal(turnInputOf('처음부터 손으로 다시 쓴 반론입니다.', ['알아듣기 어렵게 적힌 글']), 'voice-edited');
  assert.equal(turnInputOf('', ['알아듣기 어렵게 적힌 글']), 'voice-edited');
});

test('조각이 여럿이면 모두 들어간 차례대로 남아 있어야 말로 넣은 턴이다', () => {
  const segments = ['거짓말은 옳지 않습니다', '약속이 성립하지 않기 때문입니다'];
  assert.equal(turnInputOf('거짓말은 옳지 않습니다. 약속이 성립하지 않기 때문입니다.', segments), 'voice');
  // 조각의 차례를 바꿔 놓았으면 고친 것이다.
  assert.equal(turnInputOf('약속이 성립하지 않기 때문입니다. 거짓말은 옳지 않습니다.', segments), 'voice-edited');
  // 한 조각을 지웠으면 고친 것이다.
  assert.equal(turnInputOf('거짓말은 옳지 않습니다.', segments), 'voice-edited');
});

test('인식된 글을 둔 채 앞뒤와 사이에 글로 덧붙인 것은 고친 턴이 아니다', () => {
  // 글로 먼저 쓰고 말로 덧붙였다.
  assert.equal(turnInputOf('제 생각은 이렇습니다. 거짓말은 옳지 않습니다', ['거짓말은 옳지 않습니다']), 'voice');
  // 말한 뒤 글로 덧붙였다.
  assert.equal(turnInputOf('거짓말은 옳지 않습니다. 반례가 있습니까?', ['거짓말은 옳지 않습니다']), 'voice');
  // 두 조각 사이에 글을 끼웠다.
  assert.equal(turnInputOf('거짓말은 옳지 않습니다. 그리고 약속이 무너집니다.', ['거짓말은 옳지 않습니다', '약속이 무너집니다']), 'voice');
});

test('같은 말을 두 번 했으면 두 번 다 남아 있어야 말로 넣은 턴이다', () => {
  assert.equal(turnInputOf('아닙니다 아닙니다', ['아닙니다', '아닙니다']), 'voice');
  // 겹쳐서 세지 않는다. 하나를 지웠으면 고친 것이다.
  assert.equal(turnInputOf('아닙니다', ['아닙니다', '아닙니다']), 'voice-edited');
  // 뒤 조각이 앞 조각 앞에만 있으면 차례가 맞지 않는다.
  assert.equal(turnInputOf('네 아닙니다', ['아닙니다', '네']), 'voice-edited');
  // 짧은 조각이 긴 조각 안에 들어 있어도, 긴 조각 뒤에 따로 있어야 한다.
  assert.equal(turnInputOf('그렇지 않습니다 않습니다', ['그렇지 않습니다', '않습니다']), 'voice');
  assert.equal(turnInputOf('그렇지 않습니다', ['그렇지 않습니다', '않습니다']), 'voice-edited');
});

test('말로 보낸 턴이 있는 판에만 고쳐 보낸 턴을 한 줄로 적는다', () => {
  assert.equal(voiceTallyText({ turns: 0, edited: 0 }), null);
  assert.equal(voiceTallyText({ turns: 12, edited: 3 }), '말로 보낸 12턴 가운데 3턴을 고쳐 보냈습니다.');
  assert.equal(voiceTallyText({ turns: 1, edited: 0 }), '말로 보낸 1턴 가운데 0턴을 고쳐 보냈습니다.');
});
