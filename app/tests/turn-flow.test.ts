import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameView, TurnInput, TurnResponse } from '../server/contract.ts';
import { ApiError } from '../web/src/api.ts';
import { RECOVERED_MESSAGE, sendTurn, type TurnApi } from '../web/src/turn-flow.ts';

const before: GameView = {
  id: 'g1',
  topic: {
    id: 'q01',
    question: '질문',
    sides: [
      { stance: '내 입장', opponent: { id: 'c', name: '상대' } },
      { stance: '반대 입장', opponent: null },
    ],
  },
  side: 0,
  startLean: -1,
  messages: [
    { speaker: 'user', text: '첫 말' },
    { speaker: 'opponent', text: '첫 발언' },
  ],
  turn: 0,
  maxTurns: 30,
  maxTextLength: 1000,
  ended: false,
  endReason: null,
  record: null,
  voice: { turns: 0, edited: 0 },
};

/** 서버에 저장된 판. turns개의 턴이 들어 있다. */
function serverGame(turns: number): GameView {
  const messages = [...before.messages];
  for (let n = 1; n <= turns; n++) messages.push({ speaker: 'user', text: '반론입니다.' }, { speaker: 'opponent', text: `답 ${n}` });
  return { ...before, messages, turn: turns };
}

function fakeApi(turn: () => Promise<TurnResponse>, get: () => Promise<GameView>) {
  /** sent에는 api.turn이 받은 인자를 그대로 적는다. */
  const calls = { turn: 0, get: 0, sent: [] as [string, string, TurnInput][] };
  const api: TurnApi = {
    async turn(gameId, text, input) {
      calls.turn++;
      calls.sent.push([gameId, text, input]);
      return turn();
    },
    async get() {
      calls.get++;
      return get();
    },
  };
  return { api, calls };
}

const lost = () => Promise.reject(new ApiError('서버에 닿지 못했습니다.'));

test('답이 오면 보낸 말과 답을 덧붙이고, 판을 다시 부르지 않는다', async () => {
  const { api, calls } = fakeApi(async () => ({ turn: 1, reply: '답 1', ended: false, endReason: null }), async () => serverGame(9));
  const settled = await sendTurn(api, before, '반론입니다.', 'text');
  assert.deepEqual(settled, { game: serverGame(1), draft: '', error: null });
  assert.equal(calls.get, 0);
});

test('말을 넣은 방식을 서버에 그대로 보내고, 화면의 판에도 말로 넣은 턴과 고쳐 보낸 턴을 더한다', async () => {
  const reply = async (): Promise<TurnResponse> => ({ turn: 1, reply: '답 1', ended: false, endReason: null });
  const cases = [
    ['text', { turns: 0, edited: 0 }],
    ['voice', { turns: 1, edited: 0 }],
    ['voice-edited', { turns: 1, edited: 1 }],
  ] as const;
  for (const [input, voice] of cases) {
    const { api, calls } = fakeApi(reply, async () => serverGame(9));
    const settled = await sendTurn(api, before, '반론입니다.', input);
    assert.deepEqual(calls.sent, [['g1', '반론입니다.', input]], input);
    assert.deepEqual(settled.game, { ...serverGame(1), voice }, input);
  }
  // 앞서 말로 넣은 턴이 있던 판에는 거기에 더한다.
  const spoken: GameView = { ...before, voice: { turns: 4, edited: 1 } };
  const { api } = fakeApi(reply, async () => serverGame(9));
  assert.deepEqual((await sendTurn(api, spoken, '반론입니다.', 'voice-edited')).game.voice, { turns: 5, edited: 2 });
});

test('저장되지 않아 보낸 말을 되돌릴 때는 말로 넣은 턴을 세지 않는다', async () => {
  const { api, calls } = fakeApi(() => Promise.reject(new ApiError('이미 끝난 판입니다.', 409)), async () => serverGame(0));
  const settled = await sendTurn(api, before, '반론입니다.', 'voice');
  assert.deepEqual(calls.sent, [['g1', '반론입니다.', 'voice']]);
  assert.deepEqual([settled.draft, settled.game.voice], ['반론입니다.', { turns: 0, edited: 0 }]);
});

test('턴을 모두 써서 판이 끝나면 끝난 방식도 화면의 판에 싣는다', async () => {
  const { api } = fakeApi(async () => ({ turn: 1, reply: '답 1', ended: true, endReason: 'max-turns' }), async () => serverGame(9));
  const settled = await sendTurn(api, before, '반론입니다.', 'text');
  assert.deepEqual([settled.game.ended, settled.game.endReason], [true, 'max-turns']);
});

test('응답을 잃었지만 서버에 저장됐으면 서버의 판을 쓰고 보낸 말을 되돌리지 않는다', async () => {
  const { api } = fakeApi(lost, async () => serverGame(1));
  const settled = await sendTurn(api, before, '반론입니다.', 'text');
  assert.deepEqual(settled, { game: serverGame(1), draft: '', error: RECOVERED_MESSAGE });
});

test('서버가 아직 답을 만드는 중에 응답을 잃어도, 다음 턴에서 서버의 판으로 맞춘다', async () => {
  // 연결이 끊긴 직후에는 서버가 아직 저장하지 않았다. 화면은 보낸 말을 입력 칸으로 되돌린다.
  const first = fakeApi(lost, async () => serverGame(0));
  const rolledBack = await sendTurn(first.api, before, '반론입니다.', 'text');
  assert.deepEqual(rolledBack.game, before);
  assert.equal(rolledBack.draft, '반론입니다.');

  // 그 사이 서버가 첫 턴을 저장했고, 다시 보낸 말이 두 번째 턴이 된다. 턴 번호가 건너뛰므로 판을 다시 불러 맞춘다.
  const second = fakeApi(async () => ({ turn: 2, reply: '답 2', ended: false, endReason: null }), async () => serverGame(2));
  const settled = await sendTurn(second.api, rolledBack.game, rolledBack.draft, 'text');
  assert.deepEqual(settled, { game: serverGame(2), draft: '', error: null });
  assert.equal(second.calls.get, 1);
  assert.equal(settled.game.messages.length, 6);
});

test('서버가 거절했으면(4xx) 판을 다시 부르지 않고 보낸 말을 되돌린다', async () => {
  const { api, calls } = fakeApi(
    () => Promise.reject(new ApiError('이 판의 앞 요청을 아직 처리하고 있습니다.', 409)),
    async () => serverGame(1),
  );
  const settled = await sendTurn(api, before, '반론입니다.', 'text');
  assert.deepEqual(settled, { game: before, draft: '반론입니다.', error: '이 판의 앞 요청을 아직 처리하고 있습니다.' });
  assert.equal(calls.get, 0);
});

test('서버 오류(5xx)나 다시 부르기 실패면 저장되지 않은 것으로 보고 되돌린다', async () => {
  const serverError = fakeApi(() => Promise.reject(new ApiError('서버에서 문제가 생겼습니다.', 500)), async () => serverGame(0));
  const afterError = await sendTurn(serverError.api, before, '반론입니다.', 'text');
  assert.deepEqual(afterError, { game: before, draft: '반론입니다.', error: '서버에서 문제가 생겼습니다.' });
  assert.equal(serverError.calls.get, 1);

  const nothing = fakeApi(lost, lost);
  const afterNothing = await sendTurn(nothing.api, before, '반론입니다.', 'text');
  assert.deepEqual(afterNothing, { game: before, draft: '반론입니다.', error: '서버에 닿지 못했습니다.' });
});
