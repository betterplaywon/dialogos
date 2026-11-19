// 한 턴을 보내고, 화면이 서버와 어긋나지 않게 결과를 맞춘다. 화면 밖에서 검사할 수 있게 React와 떼어 둔다.
//
// 어긋나는 경우는 응답을 잃었을 때다. 서버는 턴을 저장했는데 화면은 실패로 보거나,
// 서버가 아직 답을 만드는 중이라 화면이 다시 불러온 판에 그 턴이 아직 없을 수 있다.
// 그래서 실패하면 판을 다시 불러 보고, 성공했는데 턴 번호가 하나씩 늘지 않았으면 서버의 판으로 통째로 맞춘다.

import type { GameView, TurnResponse } from '../../server/contract.ts';
import { ApiError } from './api.ts';

export interface TurnApi {
  turn(gameId: string, text: string): Promise<TurnResponse>;
  get(gameId: string): Promise<GameView>;
}

export interface TurnSettled {
  game: GameView;
  /** 입력 칸에 남길 글. 저장되지 않았으면 보낸 말을 돌려준다. */
  draft: string;
  error: string | null;
}

export const RECOVERED_MESSAGE = '응답을 받지 못했지만 서버에 답이 저장되어 있어 불러왔습니다.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 문제가 생겼습니다.';
}

/** before는 보내기 전의 판이다. 돌려준 game이 화면에 보일 판이다. */
export async function sendTurn(api: TurnApi, before: GameView, text: string): Promise<TurnSettled> {
  try {
    const result = await api.turn(before.id, text);
    const appended: GameView = {
      ...before,
      turn: result.turn,
      ended: result.ended,
      messages: [...before.messages, { speaker: 'user', text }, { speaker: 'opponent', text: result.reply }],
    };
    if (result.turn === before.turn + 1) return { game: appended, draft: '', error: null };
    // 앞서 응답을 잃은 턴이 서버에 저장되어 있었다. 서버의 판으로 통째로 맞춘다.
    const fresh = await api.get(before.id).catch(() => null);
    return { game: fresh ?? appended, draft: '', error: null };
  } catch (error) {
    // 서버가 거절했으면(4xx) 저장된 것이 없다. 그 밖의 실패는 응답만 잃었을 수 있으므로 판을 다시 불러 본다.
    const rejected = error instanceof ApiError && error.rejected;
    const fresh = rejected ? null : await api.get(before.id).catch(() => null);
    if (fresh && fresh.turn > before.turn) return { game: fresh, draft: '', error: RECOVERED_MESSAGE };
    // 저장되지 않았으면 보낸 말을 입력 칸으로 되돌려 다시 보낼 수 있게 한다.
    return { game: fresh ?? before, draft: text, error: messageOf(error) };
  }
}
