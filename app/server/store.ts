// 판을 저장하는 곳의 인터페이스와 메모리 저장소. 파일에 남기는 SQLite 저장소는 sqlite-store.ts에 있다.
// 배포처에 맞는 저장소(Turso 등)도 이 인터페이스로 붙인다.

import type { ChatMessage, Condition, JudgeDecision, TurnRecord } from '../../eval/src/types.ts';
import type { EndReason, Lean, SideIndex, Verdict } from './contract.ts';

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

/** 판이 끝난 뒤 사용자가 남긴 기록. 한 번 남기면 바꾸지 않는다. */
export interface EndRecord {
  lean: Lean;
  verdict: Verdict;
  at: string;
}

export interface GameRecord {
  id: string;
  /** 판을 한 사용자. 로그인을 붙이기 전에는 모두 같은 사용자(LOCAL_USER)다. */
  userId: string;
  topicId: string;
  /** 사용자가 지키는 입장(주제의 sides 번호). 상대는 반대쪽이다. */
  side: SideIndex;
  /** 상대의 입장 카드. */
  cardId: string;
  mode: Mode;
  /** 판을 시작할 때 고른 생각. 이 기록을 받기 전(스키마 1)에 만든 판은 null이다. */
  startLean: Lean | null;
  /** 상대 모델에게 넘기는 대화(runTurn의 상태). */
  history: ChatMessage[];
  /** 엔진이 거둔 전제. 지시문 방식이면 늘 비어 있다. */
  conceded: string[];
  /** 턴은 덧붙이기만 한다. 한 번 저장한 턴은 바꾸지 않는다. */
  turns: TurnLog[];
  startedAt: string;
  endedAt?: string;
  /** 끝난 방식. 스키마 1에서 끝난 판에는 없다. */
  endReason?: EndReason;
  record?: EndRecord;
}

/** 지난 판 목록에 쓰는 요약. */
export interface GameSummary {
  id: string;
  topicId: string;
  side: SideIndex;
  cardId: string;
  startLean: Lean | null;
  turns: number;
  startedAt: string;
  endedAt?: string;
  record?: EndRecord;
}

export interface GameStore {
  create(game: GameRecord): Promise<void>;
  get(id: string): Promise<GameRecord | undefined>;
  save(game: GameRecord): Promise<void>;
  /** 한 사용자의 판을 최근에 시작한 것부터 limit개. 시작 시각이 같으면 나중에 만든 판이 먼저다. */
  list(userId: string, limit: number): Promise<GameSummary[]>;
}

export function summaryOf(game: GameRecord): GameSummary {
  return {
    id: game.id,
    topicId: game.topicId,
    side: game.side,
    cardId: game.cardId,
    startLean: game.startLean,
    turns: game.turns.length,
    startedAt: game.startedAt,
    ...(game.endedAt ? { endedAt: game.endedAt } : {}),
    ...(game.record ? { record: { ...game.record } } : {}),
  };
}

/**
 * 메모리 저장소. 서버를 다시 띄우면 판이 사라진다. 검사와, 파일을 남기지 않을 때 쓴다.
 * 꺼낼 때와 넣을 때 복사해, 밖에서 고쳐도 저장된 판이 바뀌지 않게 한다.
 * 오래 띄워 두어도 메모리가 계속 늘지 않게, 판이 상한을 넘으면 가장 먼저 만든 판부터 지운다.
 */
export class MemoryGameStore implements GameStore {
  readonly #games = new Map<string, GameRecord>();

  constructor(readonly limit = 1000) {}

  async create(game: GameRecord): Promise<void> {
    if (this.#games.has(game.id)) throw new Error(`이미 있는 판입니다: ${game.id}`);
    this.#games.set(game.id, structuredClone(game));
    for (const id of this.#games.keys()) {
      if (this.#games.size <= this.limit) break;
      this.#games.delete(id);
    }
  }

  async get(id: string): Promise<GameRecord | undefined> {
    const game = this.#games.get(id);
    return game ? structuredClone(game) : undefined;
  }

  async save(game: GameRecord): Promise<void> {
    if (!this.#games.has(game.id)) throw new Error(`없는 판입니다: ${game.id}`);
    this.#games.set(game.id, structuredClone(game));
  }

  async list(userId: string, limit: number): Promise<GameSummary[]> {
    // 넣은 순서를 뒤집은 뒤 시작 시각으로 정렬한다(정렬은 안정적이라 같은 시각이면 나중에 만든 판이 먼저).
    return [...this.#games.values()]
      .filter((game) => game.userId === userId)
      .reverse()
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit)
      .map(summaryOf);
  }
}
