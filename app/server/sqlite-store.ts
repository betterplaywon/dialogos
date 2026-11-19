// 판을 SQLite 파일에 남기는 저장소. Node에 들어 있는 node:sqlite를 써서 새 의존성이 없다(Node 22.13 이상).
// 판에 사용자의 토론 기록이 들어가므로, 파일은 커밋하지 않는 곳(data/)에 둔다.

import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, JudgeDecision } from '../../eval/src/types.ts';
import type { EndReason, Lean, SideIndex, Verdict } from './contract.ts';
import type { EndRecord, GameRecord, GameStore, GameSummary, Mode, TurnLog } from './store.ts';

/**
 * 스키마. 바꿀 때는 끝에 하나를 더하고, 이미 있는 것은 고치지 않는다.
 * 파일마다 schema_version에 적용한 개수를 적어, 다시 열 때 남은 것만 적용한다.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE games (
     id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL,
     topic_id TEXT NOT NULL,
     card_id TEXT NOT NULL,
     mode TEXT NOT NULL CHECK (mode IN ('prompt', 'engine')),
     history TEXT NOT NULL,
     conceded TEXT NOT NULL,
     started_at TEXT NOT NULL,
     ended_at TEXT
   );
   CREATE INDEX games_by_user ON games (user_id, started_at);
   CREATE TABLE turns (
     game_id TEXT NOT NULL REFERENCES games (id) ON DELETE CASCADE,
     n INTEGER NOT NULL,
     user_text TEXT NOT NULL,
     reply TEXT NOT NULL,
     decision TEXT,
     judge_calls INTEGER,
     judge_readable INTEGER,
     ms_judge INTEGER,
     ms_opponent INTEGER NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (game_id, n)
   );`,
  // 2: 지킨 입장과 판 앞뒤의 기록. 스키마 1의 판은 판정 실험 질문의 사용자 입장(sides[0])을 지켰으므로 side는 0이다.
  `ALTER TABLE games ADD COLUMN side INTEGER NOT NULL DEFAULT 0 CHECK (side IN (0, 1));
   ALTER TABLE games ADD COLUMN start_lean INTEGER CHECK (start_lean BETWEEN -2 AND 2);
   ALTER TABLE games ADD COLUMN end_reason TEXT CHECK (end_reason IN ('max-turns', 'user'));
   ALTER TABLE games ADD COLUMN end_lean INTEGER CHECK (end_lean BETWEEN -2 AND 2);
   ALTER TABLE games ADD COLUMN verdict TEXT CHECK (verdict IN ('debate', 'lecture'));
   ALTER TABLE games ADD COLUMN recorded_at TEXT;`,
];

/** 다른 연결의 쓰기를 기다리는 최대 시간. */
const BUSY_TIMEOUT_MS = 5000;

interface GameRow {
  id: string;
  user_id: string;
  topic_id: string;
  side: number;
  card_id: string;
  mode: string;
  history: string;
  conceded: string;
  start_lean: number | null;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  end_lean: number | null;
  verdict: string | null;
  recorded_at: string | null;
}

interface TurnRow {
  n: number;
  user_text: string;
  reply: string;
  decision: string | null;
  judge_calls: number | null;
  judge_readable: number | null;
  ms_judge: number | null;
  ms_opponent: number;
  at: string;
}

interface SummaryRow {
  id: string;
  topic_id: string;
  side: number;
  card_id: string;
  start_lean: number | null;
  turns: number;
  started_at: string;
  ended_at: string | null;
  end_lean: number | null;
  verdict: string | null;
  recorded_at: string | null;
}

/** 끝 기록의 세 칸은 함께 채워진다. 하나라도 비었으면 기록이 없는 것이다. */
function recordOf(row: { end_lean: number | null; verdict: string | null; recorded_at: string | null }): EndRecord | undefined {
  if (row.end_lean === null || row.verdict === null || row.recorded_at === null) return undefined;
  return { lean: row.end_lean as Lean, verdict: row.verdict as Verdict, at: row.recorded_at };
}

function turnOf(row: TurnRow): TurnLog {
  return {
    n: row.n,
    user: row.user_text,
    reply: row.reply,
    ...(row.decision !== null ? { decision: JSON.parse(row.decision) as JudgeDecision } : {}),
    ...(row.judge_calls !== null ? { judge: { calls: row.judge_calls, readable: row.judge_readable === 1 } } : {}),
    ms: { ...(row.ms_judge !== null ? { judge: row.ms_judge } : {}), opponent: row.ms_opponent },
    at: row.at,
  };
}

export class SqliteGameStore implements GameStore {
  readonly #db: DatabaseSync;

  /** path는 파일 경로이거나 ':memory:'다. 파일이 없으면 만든다. */
  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    // 다른 연결(다른 도구나 프로세스)이 쓰는 중이면 바로 실패하지 않고 기다린다.
    // DatabaseSync는 동기식이라 기다리는 동안 이 프로세스가 멈춘다. 평소에는 연결이 하나라 기다릴 일이 없다.
    this.#db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    this.#db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL');
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  /** 적용한 스키마의 개수. */
  get schemaVersion(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS applied FROM schema_version').get() as unknown as { applied: number };
    return row.applied;
  }

  #migrate(): void {
    this.#db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');
    // 이미 모두 적용한 파일은 쓰기 잠금 없이 연다. 다른 연결이 쓰는 중이어도 기다리지 않는다.
    if (this.schemaVersion >= MIGRATIONS.length) return;
    for (const [index, sql] of MIGRATIONS.entries()) {
      this.#transaction(() => {
        // 적용했는지는 쓰기 잠금을 잡은 뒤에 다시 본다. 다른 프로세스가 먼저 적용했으면 건너뛴다.
        // 여러 프로세스가 같은 새 파일을 동시에 열면, WAL 전환이 기다리지 않아 일부는 열기부터 실패할 수 있다.
        // 이 앱은 파일 하나를 서버 하나가 쓰므로 그 경우를 다루지 않는다.
        if (this.schemaVersion > index) return;
        this.#db.exec(sql);
        this.#db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(index + 1);
      });
    }
  }

  #transaction<T>(work: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 아직 저장하지 않은 턴만 넣는다. 한 번 저장한 턴은 바꾸지 않는다. */
  #insertTurns(game: GameRecord): void {
    const insert = this.#db.prepare(
      `INSERT INTO turns (game_id, n, user_text, reply, decision, judge_calls, judge_readable, ms_judge, ms_opponent, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (game_id, n) DO NOTHING`,
    );
    for (const turn of game.turns) {
      insert.run(
        game.id,
        turn.n,
        turn.user,
        turn.reply,
        turn.decision ? JSON.stringify(turn.decision) : null,
        turn.judge ? turn.judge.calls : null,
        turn.judge ? (turn.judge.readable ? 1 : 0) : null,
        turn.ms.judge ?? null,
        turn.ms.opponent,
        turn.at,
      );
    }
  }

  async create(game: GameRecord): Promise<void> {
    this.#transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO games (id, user_id, topic_id, side, card_id, mode, history, conceded, start_lean, started_at,
                              ended_at, end_reason, end_lean, verdict, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          game.id,
          game.userId,
          game.topicId,
          game.side,
          game.cardId,
          game.mode,
          JSON.stringify(game.history),
          JSON.stringify(game.conceded),
          game.startLean,
          game.startedAt,
          game.endedAt ?? null,
          game.endReason ?? null,
          game.record?.lean ?? null,
          game.record?.verdict ?? null,
          game.record?.at ?? null,
        );
      this.#insertTurns(game);
    });
  }

  async get(id: string): Promise<GameRecord | undefined> {
    const row = this.#db.prepare('SELECT * FROM games WHERE id = ?').get(id) as unknown as GameRow | undefined;
    if (!row) return undefined;
    const turns = this.#db.prepare('SELECT * FROM turns WHERE game_id = ? ORDER BY n').all(id) as unknown as TurnRow[];
    const record = recordOf(row);
    return {
      id: row.id,
      userId: row.user_id,
      topicId: row.topic_id,
      side: row.side as SideIndex,
      cardId: row.card_id,
      mode: row.mode as Mode,
      startLean: row.start_lean as Lean | null,
      history: JSON.parse(row.history) as ChatMessage[],
      conceded: JSON.parse(row.conceded) as string[],
      turns: turns.map(turnOf),
      startedAt: row.started_at,
      ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
      ...(row.end_reason !== null ? { endReason: row.end_reason as EndReason } : {}),
      ...(record ? { record } : {}),
    };
  }

  /** 끝난 시각, 끝난 방식, 끝 기록은 한 번 채우면 바꾸지 않는다(턴과 같은 덧붙이기). */
  async save(game: GameRecord): Promise<void> {
    this.#transaction(() => {
      const result = this.#db
        .prepare(
          `UPDATE games SET history = ?, conceded = ?, ended_at = COALESCE(ended_at, ?),
                  end_reason = COALESCE(end_reason, ?),
                  end_lean = COALESCE(end_lean, ?),
                  verdict = COALESCE(verdict, ?),
                  recorded_at = COALESCE(recorded_at, ?)
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(game.history),
          JSON.stringify(game.conceded),
          game.endedAt ?? null,
          game.endReason ?? null,
          game.record?.lean ?? null,
          game.record?.verdict ?? null,
          game.record?.at ?? null,
          game.id,
        );
      if (Number(result.changes) === 0) throw new Error(`없는 판입니다: ${game.id}`);
      this.#insertTurns(game);
    });
  }

  async list(userId: string, limit: number): Promise<GameSummary[]> {
    const rows = this.#db
      .prepare(
        `SELECT g.id, g.topic_id, g.side, g.card_id, g.start_lean, g.started_at, g.ended_at,
                g.end_lean, g.verdict, g.recorded_at,
                (SELECT COUNT(*) FROM turns t WHERE t.game_id = g.id) AS turns
         FROM games g
         WHERE g.user_id = ?
         ORDER BY g.started_at DESC, g.rowid DESC
         LIMIT ?`,
      )
      .all(userId, limit) as unknown as SummaryRow[];
    return rows.map((row) => {
      const record = recordOf(row);
      return {
        id: row.id,
        topicId: row.topic_id,
        side: row.side as SideIndex,
        cardId: row.card_id,
        startLean: row.start_lean as Lean | null,
        turns: row.turns,
        startedAt: row.started_at,
        ...(row.ended_at !== null ? { endedAt: row.ended_at } : {}),
        ...(record ? { record } : {}),
      };
    });
  }
}
