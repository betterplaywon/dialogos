import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEW_TURN, takeDictation, turnEntryOf, turnInputOf, voiceTallyText, type TurnDictation } from '../web/src/dictation.ts';

/** 조각만 적어 한 턴의 받아쓰기 기록을 만든다. */
const turnOf = (...segments: string[]): TurnDictation => ({ segments, redone: 0 });

test('들은 글을 빈 입력 칸에 넣고, 이 턴의 인식 조각에 더한다', () => {
  assert.deepEqual(takeDictation('', NEW_TURN, '거짓말은 옳지 않습니다', 1000), {
    draft: '거짓말은 옳지 않습니다',
    turn: { segments: ['거짓말은 옳지 않습니다'], redone: 0 },
    notice: '인식한 글을 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.',
  });
  // 공백뿐인 입력 칸은 빈 칸으로 본다. 앞선 조각이 없으니 다시 말한 것이 아니다.
  const blank = takeDictation('  \n', NEW_TURN, '말한 글', 1000);
  assert.equal(blank.draft, '말한 글');
  assert.deepEqual(blank.turn, { segments: ['말한 글'], redone: 0 });
});

test('입력 칸이 직전에 인식된 글 그대로면, 다시 말할 때 새로 들은 글로 바꾸고 바뀐 조각을 빼고 다시 말한 횟수를 센다', () => {
  const first = takeDictation('', NEW_TURN, '첫째', 1000);
  const second = takeDictation(first.draft, first.turn, '둘째', 1000);
  assert.deepEqual(second, {
    draft: '둘째',
    turn: { segments: ['둘째'], redone: 1 },
    notice: '앞서 인식한 글을 새로 인식한 글로 바꿨습니다. 고친 뒤 보내 주세요.',
  });
  assert.deepEqual(takeDictation(second.draft, second.turn, '셋째', 1000).turn, { segments: ['셋째'], redone: 2 });
});

test('인식된 글을 손으로 모두 지운 뒤 말하면 앞선 조각을 빼고 다시 말한 횟수를 센다', () => {
  const first = takeDictation('', NEW_TURN, '알아듣기 어렵게 적힌 글', 1000);
  const again = takeDictation('', first.turn, '거짓말은 옳지 않습니다', 1000);
  assert.deepEqual(again, {
    draft: '거짓말은 옳지 않습니다',
    turn: { segments: ['거짓말은 옳지 않습니다'], redone: 1 },
    notice: '인식한 글을 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.',
  });
  // 그대로 보내면 [말하기]를 다시 눌러 바꾼 것과 같이 센다. 고친 턴이 아니다.
  assert.deepEqual(turnEntryOf(again.draft, again.turn), { input: 'voice', redone: 1 });
  // 공백뿐인 칸도, 음성을 끄면서 넘긴 글(appendOnly)도 같다. 빈 칸이라 지킬 글이 없다.
  assert.deepEqual(takeDictation(' \n', first.turn, '거짓말은 옳지 않습니다', 1000).turn, again.turn);
  assert.deepEqual(takeDictation('', first.turn, '거짓말은 옳지 않습니다', 1000, { appendOnly: true }).turn, again.turn);
  // 조각이 여럿이어도 모두 뺀다.
  assert.deepEqual(takeDictation('', turnOf('첫째', '둘째'), '셋째', 1000).turn, { segments: ['셋째'], redone: 1 });
  // 앞 조각만 손으로 지워 입력 칸이 마지막 조각 그대로면, 다시 말해 바꿀 때 지운 조각도 뺀다. 입력 칸에는 새로 들은 글만 남는다.
  assert.deepEqual(takeDictation('둘째', turnOf('첫째', '둘째'), '셋째', 1000).turn, { segments: ['셋째'], redone: 1 });
});

test('인식된 글을 일부만 지우고 말하면 끝에 붙이고, 그대로 보내면 고친 턴이다', () => {
  const first = takeDictation('', NEW_TURN, '거짓말은 결가가 좋아도 옳지 않습니다', 1000);
  const partly = takeDictation('거짓말은', first.turn, '결과가 좋아도 옳지 않습니다', 1000);
  assert.deepEqual(partly.turn, { segments: ['거짓말은 결가가 좋아도 옳지 않습니다', '결과가 좋아도 옳지 않습니다'], redone: 0 });
  assert.deepEqual(turnEntryOf(partly.draft, partly.turn), { input: 'voice-edited', redone: 0 });
});

test('직접 쓰거나 고친 글이 있으면 지우지 않고 끝에 붙이며, 다시 말한 횟수는 세지 않는다', () => {
  assert.deepEqual(takeDictation('제 생각에는', NEW_TURN, '거짓말은 옳지 않습니다', 1000), {
    draft: '제 생각에는 거짓말은 옳지 않습니다',
    turn: { segments: ['거짓말은 옳지 않습니다'], redone: 0 },
    notice: '쓰던 글은 두고 인식한 글을 끝에 붙였습니다. 고친 뒤 보내 주세요.',
  });
  // 인식된 글을 손본 뒤(문장 부호 하나라도) 다시 말하면 붙인다.
  const first = takeDictation('', NEW_TURN, '첫째', 1000);
  assert.deepEqual(takeDictation(`${first.draft}.`, first.turn, '둘째', 1000), {
    draft: '첫째. 둘째',
    turn: { segments: ['첫째', '둘째'], redone: 0 },
    notice: '쓰던 글은 두고 인식한 글을 끝에 붙였습니다. 고친 뒤 보내 주세요.',
  });
  // 직접 쓴 글 뒤에 붙인 뒤에는 입력 칸이 마지막 조각과 다르므로, 또 말해도 직접 쓴 글을 지우지 않는다.
  const appended = takeDictation('제 생각에는', NEW_TURN, '첫째', 1000);
  assert.equal(takeDictation(appended.draft, appended.turn, '둘째', 1000).draft, '제 생각에는 첫째 둘째');
  // 입력 칸이 공백이나 줄바꿈으로 끝나면 공백을 더 넣지 않는다.
  assert.equal(takeDictation('제 생각에는 ', NEW_TURN, '그렇습니다', 1000).draft, '제 생각에는 그렇습니다');
  assert.equal(takeDictation('첫 줄\n', NEW_TURN, '둘째 줄', 1000).draft, '첫 줄\n둘째 줄');
});

test('음성을 끄면서 넘긴 글(appendOnly)은 직전 인식 글이라도 바꾸지 않고 끝에 붙인다', () => {
  const first = takeDictation('', NEW_TURN, '첫째', 1000);
  assert.deepEqual(takeDictation(first.draft, first.turn, '둘째', 1000, { appendOnly: true }), {
    draft: '첫째 둘째',
    turn: { segments: ['첫째', '둘째'], redone: 0 },
    notice: '쓰던 글은 두고 인식한 글을 끝에 붙였습니다. 고친 뒤 보내 주세요.',
  });
  assert.equal(takeDictation('직접 쓴 글', NEW_TURN, '들은 글', 1000, { appendOnly: true }).draft, '직접 쓴 글 들은 글');
});

test('고친 턴은 마지막 인식 글로 세고, 다시 말한 횟수는 따로 넘긴다', () => {
  // 다시 말해 바꾼 뒤 그대로 보냈으면 고친 턴이 아니다. 쉼에 끊겨 이어 말하다 앞 글이 바뀐 때도 같다.
  const first = takeDictation('', NEW_TURN, '알아듣기 어렵게 적힌 글', 1000);
  const again = takeDictation(first.draft, first.turn, '거짓말은 옳지 않습니다', 1000);
  assert.deepEqual(turnEntryOf(again.draft, again.turn), { input: 'voice', redone: 1 });
  // 다시 말한 뒤 낱말을 고쳤으면 고친 턴이다.
  assert.deepEqual(turnEntryOf('거짓말은 결코 옳지 않습니다', again.turn), { input: 'voice-edited', redone: 1 });
  // 같은 말을 다시 했어도 고친 턴이 아니다.
  const same = takeDictation(first.draft, first.turn, '알아듣기 어렵게 적힌 글', 1000);
  assert.deepEqual(turnEntryOf(same.draft, same.turn), { input: 'voice', redone: 1 });
  // 직접 쓴 글 뒤에 말로 붙인 턴은 말로 넣은 턴이고, 다시 말한 적이 없다.
  const typed = takeDictation('직접 쓴 글', NEW_TURN, '거짓말은 옳지 않습니다', 1000);
  assert.deepEqual(turnEntryOf(typed.draft, typed.turn), { input: 'voice', redone: 0 });
  // 인식된 글을 손으로 지우고 다른 글을 썼으면 고친 턴이다.
  assert.deepEqual(turnEntryOf('손으로 쓴 글', first.turn), { input: 'voice-edited', redone: 0 });
  // 글로 넣은 턴은 다시 말한 횟수가 0이다. 부호뿐인 조각만 있어 글로 넣은 턴이 된 때도 그렇다.
  assert.deepEqual(turnEntryOf('글로 쓴 반론', NEW_TURN), { input: 'text', redone: 0 });
  assert.deepEqual(turnEntryOf('글로 쓴 반론', { segments: ['?'], redone: 3 }), { input: 'text', redone: 0 });
});

test('인식된 글의 앞뒤 공백은 떼고, 안의 이어진 공백은 하나로 줄인다', () => {
  assert.equal(takeDictation('', NEW_TURN, '  거짓말은   옳지\n않습니다 ', 1000).draft, '거짓말은 옳지 않습니다');
});

test('들은 글이 없으면 입력 칸과 기록을 그대로 두고 알리지 않는다', () => {
  const turn = turnOf('쓰던 글');
  for (const transcript of ['', '   ', '\n']) {
    assert.deepEqual(takeDictation('쓰던 글', turn, transcript, 1000), { draft: '쓰던 글', turn, notice: null });
  }
});

test('글자 수 상한을 넘는 부분은 자르고 그렇게 알린다', () => {
  // 빈 칸에 넣거나 바꿀 때는 들은 글이 길어서 잘린다.
  assert.deepEqual(takeDictation('', NEW_TURN, '가나다라마바사', 5), {
    draft: '가나다라마',
    turn: { segments: ['가나다라마'], redone: 0 },
    notice: '인식한 글이 길어 앞부분만 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.',
  });
  // 붙일 때는 남은 자리만큼 들어간다. '쓰던 글'(4자)과 공백 하나 뒤에 5자가 남는다.
  assert.deepEqual(takeDictation('쓰던 글', NEW_TURN, '가나다라마바사', 10), {
    draft: '쓰던 글 가나다라마',
    turn: { segments: ['가나다라마'], redone: 0 },
    notice: '입력 칸이 가득 차 인식한 글의 앞부분만 붙였습니다. 고친 뒤 보내 주세요.',
  });
  // 자른 끝이 공백이면 그 공백은 넣지 않는다.
  assert.equal(takeDictation('', NEW_TURN, '가나 다라', 3).draft, '가나');
  // 꼭 맞게 들어가면 잘린 것이 아니다.
  assert.match(takeDictation('', NEW_TURN, '가나다', 3).notice ?? '', /입력 칸에 넣었습니다/);
  // 두 칸짜리 글자(이모지)의 반쪽만 들어가게 자르지 않는다.
  assert.equal(takeDictation('', NEW_TURN, '가😀', 2).draft, '가');
});

test('한 글자도 들어가지 못하면 입력 칸과 기록을 그대로 두고 그렇게 알린다', () => {
  // 붙일 자리가 없다. 사이 공백 하나만 들어갈 자리여도 공백만 붙이지 않는다.
  assert.deepEqual(takeDictation('가나다라마', NEW_TURN, '바사', 5), {
    draft: '가나다라마',
    turn: NEW_TURN,
    notice: '입력 칸이 가득 차 인식한 글을 넣지 못했습니다.',
  });
  assert.deepEqual(takeDictation('가나다라', NEW_TURN, '바사', 5), { draft: '가나다라', turn: NEW_TURN, notice: '입력 칸이 가득 차 인식한 글을 넣지 못했습니다.' });
  // 빈 칸인데 첫 글자가 두 칸짜리라 한 칸에 들어가지 못한다.
  assert.deepEqual(takeDictation('', NEW_TURN, '😀가', 1), { draft: '', turn: NEW_TURN, notice: '인식한 글을 입력 칸에 넣지 못했습니다.' });
  // 앞선 조각이 있는 빈 칸이어도, 넣지 못했으면 다시 말한 것으로 세지 않는다.
  assert.deepEqual(takeDictation('', turnOf('첫째'), '😀가', 1).turn, turnOf('첫째'));
});

test('받은 기록은 바꾸지 않는다', () => {
  const turn = turnOf('첫째');
  takeDictation('첫째', turn, '둘째', 1000);
  assert.deepEqual(turn, { segments: ['첫째'], redone: 0 });
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

test('말로 보낸 턴이 있는 판에만 고쳐 보낸 턴과 다시 말한 턴을 한 줄로 적는다', () => {
  assert.equal(voiceTallyText({ turns: 0, edited: 0, redone: 0 }), null);
  assert.equal(voiceTallyText({ turns: 12, edited: 3, redone: 0 }), '말로 보낸 12턴 가운데 3턴을 고쳐 보냈습니다.');
  assert.equal(voiceTallyText({ turns: 1, edited: 0, redone: 0 }), '말로 보낸 1턴 가운데 0턴을 고쳐 보냈습니다.');
  assert.equal(voiceTallyText({ turns: 12, edited: 3, redone: 2 }), '말로 보낸 12턴 가운데 3턴을 고쳐 보냈고, 2턴은 다시 말했습니다.');
});
