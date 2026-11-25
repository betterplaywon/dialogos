// 판을 저장하는 곳의 인터페이스와 메모리 저장소. 파일에 남기는 SQLite 저장소는 sqlite-store.ts에 있다.
// 배포처에 맞는 저장소(Turso 등)도 이 인터페이스로 붙인다.

import type { DialogueModels } from '../../eval/src/dialogue.ts';
import type { ChatMessage, Condition, JudgeDecision, TurnRecord } from '../../eval/src/types.ts';
import type { EndReason, Lean, SideIndex, TurnInput, Verdict, VoiceTally } from './contract.ts';
import type { MemoryRecord } from './memory.ts';

/** 상대를 만드는 방식. 판정 실험의 조건 가운데 서비스에서 쓰는 둘이다. */
export type Mode = Extract<Condition, 'prompt' | 'engine'>;

/** 서버가 쓰는 모델의 역할(상대, 판정기). */
export type ModelRole = keyof DialogueModels;

/** 모델을 한 번 부른 사용량과 비용. 원장에 덧붙이기만 하고 바꾸거나 지우지 않는다. */
export interface SpendEntry {
  /** 원장에 남긴 시각(ISO). */
  at: string;
  userId: string;
  gameId: string;
  role: ModelRole;
  /** 그 호출의 모델 이름. */
  model: string;
  /** 응답을 받은 호출 수. 모델 안에서 다시 부른 것도 센다. 0이면 원장에 남기지 않는다. */
  calls: number;
  inputTokens: number;
  /** 과금되는 출력 토큰(생각 토큰 포함, eval/src/util.ts의 billedOutputTokens). */
  outputTokens: number;
  /** 비용. 100만분의 1달러 단위로 올림한 정수다. */
  costMicroUsd: number;
}

/** 한 턴의 기록. 판정과 걸린 시간은 서버에만 남고 화면에는 가지 않는다. */
export interface TurnLog {
  n: number;
  user: string;
  /** 사용자가 이 말을 넣은 방식. 스키마 2까지의 턴은 모두 글로 넣었다. */
  input: TurnInput;
  /** 이 턴에서 앞서 인식된 글을 다시 말해 바꾼 횟수. 스키마 4까지의 턴은 남기지 않아 0이다. */
  redone: number;
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
  voice: VoiceTally;
  startedAt: string;
  endedAt?: string;
  record?: EndRecord;
}

export interface GameStore {
  create(game: GameRecord): Promise<void>;
  get(id: string): Promise<GameRecord | undefined>;
  /**
   * 판을 저장한다. newMemories가 있으면 그 판에서 새로 만든 기억도 함께 넣는다(SQLite는 한 트랜잭션).
   * 기억 넣기가 실패하면 판 저장도 없던 일이다.
   */
  save(game: GameRecord, newMemories?: readonly MemoryRecord[]): Promise<void>;
  /** 한 사용자의 판을 최근에 시작한 것부터 limit개. 시작 시각이 같으면 나중에 만든 판이 먼저다. */
  list(userId: string, limit: number): Promise<GameSummary[]>;
  /**
   * 그 사용자가 since(ISO 시각) 이후에 저장한 턴 수. 끝난 판의 턴도 센다.
   * 턴의 시각과 since는 모두 toISOString()의 UTC 꼴이라, 글자 순서로 견주면 시간 순서와 같다.
   */
  countTurnsSince(userId: string, since: string): Promise<number>;
  /** 모델 사용량 원장에 한 줄을 덧붙인다. */
  addSpend(entry: SpendEntry): Promise<void>;
  /** 원장의 비용 합(100만분의 1달러). 처음부터 쌓인 전체다. */
  totalSpendMicroUsd(): Promise<number>;
  /**
   * 그 사용자의 기억. 만든 시각이 늦은 것부터, 같은 시각이면 먼저 넣은 것부터 limit개
   * (한 판의 기억은 claim, ground, shift, weakness 순). topicId가 있으면 그 주제만.
   */
  listMemories(userId: string, query: { topicId?: string; limit: number }): Promise<MemoryRecord[]>;
  /** 그 사용자의 기억 글을 바꾸고 고친 시각을 남긴다. 없거나 남의 것이면 undefined. */
  editMemory(userId: string, id: string, text: string, at: string): Promise<MemoryRecord | undefined>;
  /** 그 사용자의 기억을 지운다(기억 줄만, 판 기록은 남는다). 지웠으면 true. */
  deleteMemory(userId: string, id: string): Promise<boolean>;
}

/** 말로 넣은 턴, 그 가운데 고쳐 보낸 턴, 다시 말한 적이 있는 턴을 센다. SQLite 저장소의 목록은 같은 값을 SQL로 센다. */
export function voiceTallyOf(turns: readonly Pick<TurnLog, 'input' | 'redone'>[]): VoiceTally {
  const spoken = turns.filter((turn) => turn.input !== 'text');
  return {
    turns: spoken.length,
    edited: spoken.filter((turn) => turn.input === 'voice-edited').length,
    redone: spoken.filter((turn) => turn.redone > 0).length,
  };
}

export function summaryOf(game: GameRecord): GameSummary {
  return {
    id: game.id,
    topicId: game.topicId,
    side: game.side,
    cardId: game.cardId,
    startLean: game.startLean,
    turns: game.turns.length,
    voice: voiceTallyOf(game.turns),
    startedAt: game.startedAt,
    ...(game.endedAt ? { endedAt: game.endedAt } : {}),
    ...(game.record ? { record: { ...game.record } } : {}),
  };
}

/**
 * 메모리 저장소. 서버를 다시 띄우면 판이 사라진다. 검사에서 쓴다.
 * 파일 없이 띄우는 개발 서버(APP_DB_PATH=:memory:)는 이 저장소가 아니라 SQLite 저장소를 메모리에 연다.
 * 꺼낼 때와 넣을 때 복사해, 밖에서 고쳐도 저장된 판이 바뀌지 않게 한다.
 * 오래 띄워 두어도 메모리가 계속 늘지 않게, 판이 상한을 넘으면 가장 먼저 만든 판부터 그 판의 기억과 함께 지운다.
 */
export class MemoryGameStore implements GameStore {
  readonly #games = new Map<string, GameRecord>();
  /** 넣은 순서를 지키는 Map이라, 같은 시각의 기억을 넣은 순서로 낼 수 있다(SQLite 저장소의 rowid). */
  readonly #memories = new Map<string, MemoryRecord>();
  /** 원장은 비용 합 하나만 둔다(검사용). */
  #spentMicroUsd = 0;

  constructor(readonly limit = 1000) {}

  async create(game: GameRecord): Promise<void> {
    if (this.#games.has(game.id)) throw new Error(`이미 있는 판입니다: ${game.id}`);
    this.#games.set(game.id, structuredClone(game));
    for (const id of this.#games.keys()) {
      if (this.#games.size <= this.limit) break;
      this.#games.delete(id);
      for (const memory of this.#memories.values()) if (memory.gameId === id) this.#memories.delete(memory.id);
    }
  }

  async get(id: string): Promise<GameRecord | undefined> {
    const game = this.#games.get(id);
    return game ? structuredClone(game) : undefined;
  }

  /**
   * 끝난 시각, 끝난 방식, 끝 기록은 한 번 채우면 바꾸지 않는다(SQLite 저장소와 같다).
   * 기억의 id가 이미 있거나 겹치면 판도 기억도 저장하지 않는다(SQLite 저장소의 기본 키와 트랜잭션).
   */
  async save(game: GameRecord, newMemories: readonly MemoryRecord[] = []): Promise<void> {
    const saved = this.#games.get(game.id);
    if (!saved) throw new Error(`없는 판입니다: ${game.id}`);
    const ids = new Set(newMemories.map((memory) => memory.id));
    if (ids.size < newMemories.length || [...ids].some((id) => this.#memories.has(id))) {
      throw new Error(`이미 있는 기억입니다: ${game.id}`);
    }
    const next = structuredClone(game);
    if (saved.endedAt) next.endedAt = saved.endedAt;
    if (saved.endReason) next.endReason = saved.endReason;
    if (saved.record) next.record = saved.record;
    this.#games.set(game.id, next);
    for (const memory of newMemories) this.#memories.set(memory.id, structuredClone(memory));
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

  /** 판들의 턴에서 센다. 상한을 넘어 지운 판의 턴은 세지 않는다. */
  async countTurnsSince(userId: string, since: string): Promise<number> {
    let count = 0;
    for (const game of this.#games.values()) {
      if (game.userId === userId) count += game.turns.filter((turn) => turn.at >= since).length;
    }
    return count;
  }

  async addSpend(entry: SpendEntry): Promise<void> {
    this.#spentMicroUsd += entry.costMicroUsd;
  }

  async totalSpendMicroUsd(): Promise<number> {
    return this.#spentMicroUsd;
  }

  async listMemories(userId: string, query: { topicId?: string; limit: number }): Promise<MemoryRecord[]> {
    // 넣은 순서대로 둔 채 만든 시각으로 정렬한다(정렬은 안정적이라 같은 시각이면 먼저 넣은 것이 먼저).
    return [...this.#memories.values()]
      .filter((memory) => memory.userId === userId && (query.topicId === undefined || memory.topicId === query.topicId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, query.limit)
      .map((memory) => structuredClone(memory));
  }

  async editMemory(userId: string, id: string, text: string, at: string): Promise<MemoryRecord | undefined> {
    const memory = this.#memories.get(id);
    if (!memory || memory.userId !== userId) return undefined;
    // 있는 키에 다시 넣으면 Map의 순서는 그대로다.
    const edited = { ...memory, text, editedAt: at };
    this.#memories.set(id, edited);
    return structuredClone(edited);
  }

  async deleteMemory(userId: string, id: string): Promise<boolean> {
    if (this.#memories.get(id)?.userId !== userId) return false;
    return this.#memories.delete(id);
  }
}
