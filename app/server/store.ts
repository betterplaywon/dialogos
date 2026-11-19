// 판을 저장하는 곳. 지금은 메모리에만 두므로 서버를 다시 띄우면 판이 사라진다.
// SQLite 저장소는 다음 단계에서 같은 인터페이스로 붙인다.

import type { ChatMessage, Condition, JudgeDecision, TurnRecord } from '../../eval/src/types.ts';

/** 상대를 만드는 방식. 판정 실험의 조건 가운데 서비스에서 쓰는 둘이다. */
export type Mode = Extract<Condition, 'prompt' | 'engine'>;

/** 한 턴의 기록. 판정과 걸린 시간은 서버에만 남고 화면에는 가지 않는다. */
export interface TurnLog {
  n: number;
  user: string;
  reply: string;
  decision?: JudgeDecision;
  judge?: TurnRecord['judge'];
  ms: NonNullable<TurnRecord['ms']>;
  at: string;
}

export interface GameRecord {
  id: string;
  topicId: string;
  cardId: string;
  mode: Mode;
  /** 상대 모델에게 넘기는 대화(runTurn의 상태). */
  history: ChatMessage[];
  /** 엔진이 거둔 전제. 지시문 방식이면 늘 비어 있다. */
  conceded: string[];
  turns: TurnLog[];
  startedAt: string;
  endedAt?: string;
}

export interface GameStore {
  create(game: GameRecord): Promise<void>;
  get(id: string): Promise<GameRecord | undefined>;
  save(game: GameRecord): Promise<void>;
}

/** 메모리 저장소. 꺼낼 때와 넣을 때 복사해, 밖에서 고쳐도 저장된 판이 바뀌지 않게 한다. */
export class MemoryGameStore implements GameStore {
  readonly #games = new Map<string, GameRecord>();

  async create(game: GameRecord): Promise<void> {
    if (this.#games.has(game.id)) throw new Error(`이미 있는 판입니다: ${game.id}`);
    this.#games.set(game.id, structuredClone(game));
  }

  async get(id: string): Promise<GameRecord | undefined> {
    const game = this.#games.get(id);
    return game ? structuredClone(game) : undefined;
  }

  async save(game: GameRecord): Promise<void> {
    if (!this.#games.has(game.id)) throw new Error(`없는 판입니다: ${game.id}`);
    this.#games.set(game.id, structuredClone(game));
  }
}
