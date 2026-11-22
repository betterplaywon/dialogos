import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendDictation, dictationNotice, turnInputOf, voiceTallyText } from '../web/src/dictation.ts';

test('인식된 글을 빈 입력 칸에는 그대로, 글이 있으면 공백 하나를 두고 끝에 붙인다', () => {
  assert.deepEqual(appendDictation('', '거짓말은 옳지 않습니다', 1000), { draft: '거짓말은 옳지 않습니다', added: '거짓말은 옳지 않습니다', cut: false });
  assert.deepEqual(appendDictation('제 생각에는', '거짓말은 옳지 않습니다', 1000), {
    draft: '제 생각에는 거짓말은 옳지 않습니다',
    added: '거짓말은 옳지 않습니다',
    cut: false,
  });
  // 입력 칸이 공백이나 줄바꿈으로 끝나면 공백을 더 넣지 않는다.
  assert.equal(appendDictation('제 생각에는 ', '그렇습니다', 1000).draft, '제 생각에는 그렇습니다');
  assert.equal(appendDictation('첫 줄\n', '둘째 줄', 1000).draft, '첫 줄\n둘째 줄');
});

test('인식된 글의 앞뒤 공백은 떼고, 안의 이어진 공백은 하나로 줄인다', () => {
  assert.deepEqual(appendDictation('', '  거짓말은   옳지\n않습니다 ', 1000), {
    draft: '거짓말은 옳지 않습니다',
    added: '거짓말은 옳지 않습니다',
    cut: false,
  });
});

test('인식된 글이 비었으면 입력 칸을 그대로 둔다', () => {
  for (const transcript of ['', '   ', '\n']) {
    assert.deepEqual(appendDictation('쓰던 글', transcript, 1000), { draft: '쓰던 글', added: '', cut: false });
  }
});

test('글자 수 상한을 넘는 부분은 자르고, 실제로 들어간 글만 돌려준다', () => {
  // '쓰던 글'(4자)과 공백 하나 뒤에 5자가 남는다.
  assert.deepEqual(appendDictation('쓰던 글', '가나다라마바사', 10), { draft: '쓰던 글 가나다라마', added: '가나다라마', cut: true });
  // 자른 끝이 공백이면 그 공백은 넣지 않는다.
  assert.deepEqual(appendDictation('', '가나 다라', 3), { draft: '가나', added: '가나', cut: true });
  // 꼭 맞게 들어가면 잘린 것이 아니다.
  assert.deepEqual(appendDictation('', '가나다', 3), { draft: '가나다', added: '가나다', cut: false });
  // 두 칸짜리 글자(이모지)의 반쪽만 들어가게 자르지 않는다.
  assert.deepEqual(appendDictation('', '가😀', 2), { draft: '가', added: '가', cut: true });
});

test('자리가 없으면 아무것도 붙이지 않는다(사이 공백도)', () => {
  assert.deepEqual(appendDictation('가나다라마', '바사', 5), { draft: '가나다라마', added: '', cut: true });
  // 공백 하나가 들어갈 자리뿐이면 공백만 붙이지 않는다.
  assert.deepEqual(appendDictation('가나다라', '바사', 5), { draft: '가나다라', added: '', cut: true });
  assert.deepEqual(appendDictation('이미 넘친 글', '바사', 3), { draft: '이미 넘친 글', added: '', cut: true });
});

test('듣기가 끝나면 입력 칸에 한 일을 알리고, 자리가 없어 잘렸으면 그렇게 알린다', () => {
  assert.match(dictationNotice(appendDictation('', '그렇습니다', 1000)) ?? '', /입력 칸에 넣었습니다/);
  assert.match(dictationNotice(appendDictation('', '가나다라마', 3)) ?? '', /앞부분만 넣었습니다/);
  assert.match(dictationNotice(appendDictation('가나다', '라마', 3)) ?? '', /넣지 못했습니다/);
  assert.equal(dictationNotice(appendDictation('쓰던 글', '  ', 1000)), null);
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

test('여러 번에 나눠 말한 것은 차례대로 남아 있으면 말로 넣은 턴이다', () => {
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
  // 두 번 말한 사이에 글을 끼웠다.
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
