// 판의 진행. HTTP와 저장 방식에서 떼어 두어, 서버 경로와 검사가 같은 함수를 부른다.
// 한 턴은 판정 실험과 같은 runTurn이 맡는다. 잰 상대와 배포한 상대가 같은 코드로 답한다.

import { openingState, runTurn } from '../../eval/src/dialogue.ts';
import { DEFAULT_TURNS } from '../../eval/src/script.ts';
import type { Card, Question } from '../../eval/src/types.ts';
import { LEDGER_CLOSED_MESSAGE, limitRefusal, meteredModels, type Limits, type ModelSource, type Refusal } from './budget.ts';
import type {
  DeleteMemoryResponse,
  EndRecordView,
  GameSummaryView,
  GameView,
  Lean,
  MemoryView,
  MessageView,
  PassedMemoryView,
  PassedTurnView,
  SideIndex,
  TopicView,
  TurnEntry,
  TurnInput,
  TurnResponse,
  Verdict,
} from './contract.ts';
import { MAX_MEMORY_TEXT, MEMORIES_PER_TURN, memoriesOf, memoryLength, oneLine, type MemoryRecord } from './memory.ts';
import { voiceTallyOf, type EndRecord, type GameRecord, type GameStore, type Mode } from './store.ts';

/** 한 판에서 사용자가 보낼 수 있는 턴 수. 판정 실험이 잰 대화 길이와 같다. */
export const MAX_TURNS = DEFAULT_TURNS;
/** 한 턴에 받는 글자 수. 말로 1분쯤 하는 양(300~400자)을 넉넉히 넘는다. */
export const MAX_TEXT_LENGTH = 1000;
/** 지난 판 목록에 보이는 판 수. */
export const RECENT_GAMES = 20;
/** 기억 목록에 보이는 기억 수. 주제를 골라도 같다. */
export const RECENT_MEMORIES = 100;
/** 로그인을 붙이기 전의 사용자. 3주 차에 사람마다 다른 사용자로 바꾼다. */
export const LOCAL_USER = 'local';
/**
 * 받은 말에서 지우는 보이지 않는 제어 문자(줄바꿈, 탭은 남긴다).
 * Node 22.13의 node:sqlite는 U+0000에서 글을 잘라 저장해, 턴 기록과 대화가 어긋났다.
 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * 사용자가 한 입장을 지킬 때의 상대. question은 판정 실험의 질문과 같은 모양이라 runTurn에 그대로 넘긴다.
 * question.userStance가 사용자가 지키는 입장, question.opponentStance와 premises가 상대의 입장과 전제다.
 */
export interface Matchup {
  question: Question;
  card: Card;
}

export interface TopicSide {
  stance: string;
  /** 사용자가 이 입장을 지킬 때 맞설 상대. 아직 없으면 이 쪽은 고를 수 없다. */
  matchup?: Matchup;
}

/** 주제 하나. 두 입장 가운데 사용자가 하나를 지키고, 상대는 반대쪽 입장에서 시작한다. */
export interface Topic {
  id: string;
  question: string;
  sides: readonly [TopicSide, TopicSide];
}

export const isSide = (value: unknown): value is SideIndex => value === 0 || value === 1;
export const isLean = (value: unknown): value is Lean =>
  typeof value === 'number' && Number.isInteger(value) && value >= -2 && value <= 2;
export const isVerdict = (value: unknown): value is Verdict => value === 'debate' || value === 'lecture';
export const isTurnInput = (value: unknown): value is TurnInput =>
  value === 'text' || value === 'voice' || value === 'voice-edited';
/** 한 턴에서 다시 말한 횟수의 상한. 화면이 알려 준 값이라, 사람이 낼 수 없는 큰 값은 받지 않는다. */
export const MAX_REDONE = 1000;
export const isRedone = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_REDONE;

export interface GameDeps {
  topics: ReadonlyMap<string, Topic>;
  store: GameStore;
  /** 모델의 출처. 실제 모델이면 부를 때마다 사용량을 원장에 남긴다(budget.ts). */
  models: ModelSource;
  /** 서비스 전체의 비용 상한과 사용자별 하루 턴 수. */
  limits: Limits;
  /** 판마다 방식을 고른다. 화면에는 알리지 않는다. */
  pickMode: () => Mode;
  /**
   * 새 판이 기억을 쓰는지(턴마다 같은 주제의 기억을 상대에게 넘기고, 끝 기록 때 기억을 만든다). 기억의 근거와 약점은 판정기의 판단을 드러내므로,
   * 눈가림 비교(APP_MODE=random)에서는 끈다(2026-11-25 사용자 결정, dev-setup.ts).
   * 판을 시작할 때 판에 남기고(GameRecord.memory), 그 판의 턴과 끝 기록은 이 설정이 아니라 판에 남긴 값을 따른다.
   */
  memory: boolean;
  newId: () => string;
  now: () => Date;
}

/** 사용자의 요청 때문에 생긴 실패와 상한에 걸린 요청. HTTP 상태와 화면에 보일 말을 함께 둔다. */
export class GameError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | Refusal['status'],
    message: string,
  ) {
    super(message);
  }
}

/** 지시문 방식과 엔진 방식을 반씩 고른다. */
export function randomMode(): Mode {
  return (crypto.getRandomValues(new Uint8Array(1))[0] ?? 0) < 128 ? 'prompt' : 'engine';
}

export function topicView(topic: Topic): TopicView {
  const [first, second] = topic.sides.map((side) => ({
    stance: side.stance,
    opponent: side.matchup ? { id: side.matchup.card.id, name: side.matchup.card.name } : null,
  }));
  if (!first || !second) throw new Error(`주제 ${topic.id}의 입장이 둘이 아닙니다.`);
  return { id: topic.id, question: topic.question, sides: [first, second] };
}

function recordView(record: EndRecord | undefined): EndRecordView | null {
  return record ? { lean: record.lean, verdict: record.verdict } : null;
}

function memoryView(memory: MemoryRecord): MemoryView {
  return {
    id: memory.id,
    gameId: memory.gameId,
    topicId: memory.topicId,
    side: memory.side,
    kind: memory.kind,
    text: memory.text,
    createdAt: memory.createdAt,
    edited: memory.editedAt !== undefined,
  };
}

/** 턴에 넘긴 기억의 지금 모습. 고쳤으면 지금 글과 고침 표시다. */
function keptView(memory: MemoryRecord): PassedMemoryView {
  return { id: memory.id, state: 'kept', kind: memory.kind, text: memory.text, edited: memory.editedAt !== undefined };
}

function messagesOf(game: GameRecord): MessageView[] {
  return game.history.map((m) => ({ speaker: m.role === 'assistant' ? 'opponent' : 'user', text: m.content }));
}

export function createGames(deps: GameDeps) {
  /** 한 턴이나 끝내기를 처리하는 중인 (사용자, 판). 서버가 하나일 때만 지켜진다. */
  const busy = new Set<string>();

  /**
   * 같은 사용자의 같은 판에 온 턴과 끝내기를 한 번에 하나씩만 처리한다. 둘이 겹치면 나중 저장이 앞의 저장을 지운다.
   * 잠금을 사용자별로 잡고 판의 주인은 그 안에서 확인한다. 그래서 남의 요청은 판이 처리 중이어도
   * '없는 판'(404)이 되고(판이 있는지 드러나지 않음), 주인의 요청을 막지도 않는다.
   */
  async function exclusive<T>(userId: string, id: string, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([userId, id]);
    if (busy.has(key)) throw new GameError(409, '이 판의 앞 요청을 아직 처리하고 있습니다. 잠시 뒤 다시 해 주세요.');
    busy.add(key);
    try {
      return await work();
    } finally {
      busy.delete(key);
    }
  }

  /** 모델을 부르는 턴을 처리하는 중인 사용자. 판 잠금처럼 서버가 하나일 때만 지켜진다. */
  const turning = new Set<string>();

  /**
   * 사용자마다 모델을 부르는 턴을 한 번에 하나씩만 처리한다. 상한 확인부터 턴 저장까지 자리를 잡고 있어,
   * 그사이에 같은 사용자의 다른 판 턴이 상한 확인을 통과하지 못한다. 그래서 하루 턴 수를 넘지 않고,
   * 서비스 상한을 넘는 양도 사용자마다 진행 중이던 한 턴의 비용까지다.
   */
  async function oneTurnPerUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
    if (turning.has(userId)) throw new GameError(409, '다른 판에 보낸 말의 답을 아직 만들고 있습니다. 그 답이 온 뒤에 다시 보내 주세요.');
    turning.add(userId);
    try {
      return await work();
    } finally {
      turning.delete(userId);
    }
  }

  /**
   * 원장 쓰기가 실패한 적이 있는지. 실패한 호출의 양은 원장에 없어 그 뒤의 원장 합으로는 서비스 상한을 셀 수 없으므로,
   * 한 번 닫히면 서버를 다시 띄울 때까지 새 판과 턴을 막는다. 판 잠금처럼 서버 하나 안에서만 지켜진다.
   * 닫히기 전에 상한 확인을 시작한 턴은 막지 않는다. 사용자마다 그런 턴은 하나라(oneTurnPerUser), 기록 없이 나가는 양은 사용자마다 그 한 턴까지다.
   * 상한을 확인하다 원장을 읽지 못한 것은 닫지 않는다. 그 요청만 실패하고 모델을 부르지 않아 기록 없이 나가는 돈이 없다.
   */
  let ledgerClosed = false;

  /**
   * 턴이 원장에 남기는 길. 남기지 못하면 원장을 닫고, 그 턴도 닫힌 뒤의 턴과 같은 503과 까닭으로 실패한다.
   * 실패의 내용은 실패마다 서버 오류로 남기고, 닫힌다는 줄은 처음 닫힐 때 한 번만 남긴다.
   * 요청 헤더와 본문, 원장 항목(사용자 id 등)은 남기지 않는다(AGENTS.md 1번).
   */
  const ledger: Pick<GameStore, 'addSpend'> = {
    async addSpend(entry) {
      try {
        await deps.store.addSpend(entry);
      } catch (error) {
        console.error(`서버 오류: ${error instanceof Error ? error.message : String(error)}`);
        if (!ledgerClosed) {
          ledgerClosed = true;
          console.error('원장에 남기지 못해, 서버를 다시 띄울 때까지 새 판과 턴을 막습니다. 다시 띄우기 전에 제공사의 사용량과 원장을 맞춰 보세요.');
        }
        throw new GameError(503, LEDGER_CLOSED_MESSAGE);
      }
    },
  };

  /** 원장이 닫혔거나(503) 서비스 상한(503), 하루 턴 수(429)에 걸리면, 판을 만들거나 모델을 부르기 전에 막는다. */
  async function checkLimits(userId: string): Promise<void> {
    const refusal = await limitRefusal(deps.store, deps.limits, userId, deps.now(), ledgerClosed);
    if (refusal) throw new GameError(refusal.status, refusal.message);
  }

  function topicOf(game: GameRecord): Topic {
    const topic = deps.topics.get(game.topicId);
    if (!topic) throw new Error(`판 ${game.id}의 주제 ${game.topicId}가 없습니다.`);
    return topic;
  }

  /** 판을 시작할 때와 같은 상대. 주제 카드가 바뀌어 상대가 달라졌으면 판을 이어 가지 않는다. */
  function matchupOf(game: GameRecord): Matchup {
    const matchup = topicOf(game).sides[game.side].matchup;
    if (!matchup || matchup.card.id !== game.cardId) {
      throw new Error(`판 ${game.id}의 상대(${game.topicId}, ${game.side}쪽)가 시작할 때와 다릅니다.`);
    }
    return matchup;
  }

  /**
   * 턴마다 넘긴 기억의 id를 지금의 기억과 잇는다. 지금 없는 기억(지웠다)은 글 없이 'deleted'로 보인다.
   * 턴에 글을 떠 두지 않으므로, 지운 기억의 글은 판 화면에 다시 나오지 않는다.
   */
  async function passedOf(game: GameRecord): Promise<PassedTurnView[]> {
    const turns = game.turns.filter((turn) => turn.memoryIds.length > 0);
    if (turns.length === 0) return [];
    const found = await currentMemories(game.userId, turns.flatMap((turn) => turn.memoryIds));
    return turns.map((turn) => ({ turn: turn.n, memories: passedViews(found, turn.memoryIds) }));
  }

  /** ids의 지금 기억. 지운 기억은 빠진다. */
  async function currentMemories(userId: string, ids: readonly string[]): Promise<ReadonlyMap<string, MemoryRecord>> {
    return new Map((await deps.store.findMemories(userId, ids)).map((memory) => [memory.id, memory]));
  }

  /** 넘긴 id를 지금의 기억과 잇는다. 지금 없는 기억(지웠다)은 글 없이 'deleted'다. */
  function passedViews(found: ReadonlyMap<string, MemoryRecord>, ids: readonly string[]): PassedMemoryView[] {
    return ids.map((id) => {
      const memory = found.get(id);
      return memory ? keptView(memory) : { id, state: 'deleted' };
    });
  }

  async function viewOf(game: GameRecord): Promise<GameView> {
    return {
      id: game.id,
      topic: topicView(topicOf(game)),
      side: game.side,
      startLean: game.startLean,
      messages: messagesOf(game),
      turn: game.turns.length,
      maxTurns: MAX_TURNS,
      maxTextLength: MAX_TEXT_LENGTH,
      ended: game.endedAt !== undefined,
      endReason: game.endReason ?? null,
      record: recordView(game.record),
      voice: voiceTallyOf(game.turns),
      passed: await passedOf(game),
    };
  }

  /** 그 사용자의 판만 꺼낸다. 남의 판은 있는지도 알리지 않고 '없는 판'으로 답한다. */
  async function load(userId: string, id: string): Promise<GameRecord> {
    const game = await deps.store.get(id);
    if (!game || game.userId !== userId) throw new GameError(404, '없는 판입니다.');
    return game;
  }

  return {
    topics(): TopicView[] {
      return [...deps.topics.values()].map(topicView);
    },

    /** 최근에 시작한 판부터. 주제가 사라진 판은 뺀다. */
    async list(userId: string): Promise<GameSummaryView[]> {
      const summaries = await deps.store.list(userId, RECENT_GAMES);
      return summaries.flatMap((summary) => {
        const topic = deps.topics.get(summary.topicId);
        if (!topic) return [];
        return [
          {
            id: summary.id,
            topic: topicView(topic),
            side: summary.side,
            startLean: summary.startLean,
            turn: summary.turns,
            maxTurns: MAX_TURNS,
            ended: summary.endedAt !== undefined,
            record: recordView(summary.record),
            voice: summary.voice,
            startedAt: summary.startedAt,
          },
        ];
      });
    },

    /**
     * 판을 시작한다. side는 사용자가 지킬 입장이고, lean은 지금의 생각(다섯 칸)이다.
     * 한쪽으로 기울었으면 그쪽을 지키고, 반반이면 시험해 볼 쪽을 사용자가 고른다.
     */
    async start(userId: string, topicId: string, side: SideIndex, lean: Lean): Promise<GameView> {
      const topic = deps.topics.get(topicId);
      if (!topic) throw new GameError(404, '없는 주제입니다.');
      if ((lean < 0 && side !== 0) || (lean > 0 && side !== 1)) {
        throw new GameError(400, '고른 생각과 지킬 입장이 서로 다른 쪽입니다.');
      }
      const matchup = topic.sides[side].matchup;
      if (!matchup) throw new GameError(409, '이 입장으로 토론할 상대가 아직 없습니다.');
      await checkLimits(userId);
      const state = openingState(matchup.question);
      const game: GameRecord = {
        id: deps.newId(),
        userId,
        topicId,
        side,
        cardId: matchup.card.id,
        mode: deps.pickMode(),
        memory: deps.memory,
        startLean: lean,
        history: state.history,
        conceded: [...state.conceded],
        turns: [],
        startedAt: deps.now().toISOString(),
      };
      await deps.store.create(game);
      return viewOf(game);
    },

    async get(userId: string, id: string): Promise<GameView> {
      return viewOf(await load(userId, id));
    },

    /**
     * entry는 사용자가 이 말을 넣은 방식과 다시 말한 횟수다. 화면이 알려 준 대로 턴에 남기고, 상대의 답에는 쓰지 않는다.
     * 판이 기억을 쓰면 상한을 확인한 뒤, 모델을 부르기 전에 같은 주제의 최근 기억을 찾아 상대의 지시문으로 넘기고
     * 그 id를 턴에 남긴다. 턴마다 다시 찾으므로 판 도중에 지우거나 고친 기억은 다음 턴부터 반영된다.
     */
    async turn(userId: string, id: string, rawText: string, entry: TurnEntry): Promise<TurnResponse> {
      const text = rawText.replace(CONTROL_CHARS, '').trim();
      if (!text) throw new GameError(400, '보낼 말이 비어 있습니다.');
      if (text.length > MAX_TEXT_LENGTH) throw new GameError(400, `한 턴에는 ${MAX_TEXT_LENGTH}자까지 보낼 수 있습니다.`);
      return exclusive(userId, id, async () => {
        const game = await load(userId, id);
        if (game.endedAt) throw new GameError(409, '이미 끝난 판입니다.');
        if (game.turns.length >= MAX_TURNS) throw new GameError(409, `이 판은 ${MAX_TURNS}턴을 모두 마쳤습니다.`);
        const matchup = matchupOf(game);
        return oneTurnPerUser(userId, async () => {
          await checkLimits(userId);
          const passed = game.memory
            ? await deps.store.listMemories(userId, { topicId: game.topicId, limit: MEMORIES_PER_TURN })
            : [];
          const state = { history: game.history, conceded: new Set(game.conceded) };
          const outcome = await runTurn(state, {
            question: matchup.question,
            card: matchup.card,
            condition: game.mode,
            models: meteredModels(deps.models, ledger, { userId, gameId: game.id, now: deps.now }),
            text,
            memories: passed.map((memory) => memory.text),
            // 지시문 방식 판은 눈가림 비교(APP_MODE=random)에서만 생긴다. 엔진 방식 판처럼 판정기를 먼저 불러 기다리는 시간을 맞추고,
            // 판정은 버린다(이슈 #25, 2026-11-26 사용자 결정). 판에 남긴 방식을 따르므로 서버를 다시 띄워도 판마다 같다.
            decoyJudge: true,
          });
          const n = game.turns.length + 1;
          game.history = state.history;
          game.conceded = [...state.conceded];
          game.turns.push({
            n,
            user: text,
            input: entry.input,
            redone: entry.redone,
            memoryIds: passed.map((memory) => memory.id),
            reply: outcome.reply,
            ...(outcome.decision ? { decision: outcome.decision } : {}),
            ...(outcome.judge ? { judge: outcome.judge } : {}),
            ms: outcome.ms,
            at: deps.now().toISOString(),
          });
          if (n >= MAX_TURNS) {
            game.endedAt = deps.now().toISOString();
            game.endReason = 'max-turns';
          }
          await deps.store.save(game);
          // 넘긴 기억은 모델을 부르기 전에 찾았다. 답을 기다리는 사이에 다른 탭에서 지우거나 고쳤을 수 있으므로,
          // 응답에는 지금의 기억과 다시 이어 보낸다. 그래야 지운 기억의 글이 답과 함께 화면에 다시 나오지 않는다.
          const passedIds = passed.map((memory) => memory.id);
          const memories = passedIds.length > 0 ? passedViews(await currentMemories(userId, passedIds), passedIds) : [];
          return {
            turn: n,
            reply: outcome.reply,
            ended: game.endedAt !== undefined,
            endReason: game.endReason ?? null,
            memories,
          };
        });
      });
    },

    async end(userId: string, id: string): Promise<GameView> {
      return exclusive(userId, id, async () => {
        const game = await load(userId, id);
        if (!game.endedAt) {
          game.endedAt = deps.now().toISOString();
          game.endReason = 'user';
          await deps.store.save(game);
        }
        return viewOf(game);
      });
    },

    /**
     * 끝난 판에 사후 입장과 훈계 문항의 답을 남긴다. 한 번 남기면 바꾸지 않는다.
     * 판이 기억을 쓰면 이 판의 기억을 규칙으로 만들어 끝 기록과 함께 저장한다. 기억을 넣지 못하면 끝 기록도 남지 않는다.
     */
    async record(userId: string, id: string, lean: Lean, verdict: Verdict): Promise<GameView> {
      return exclusive(userId, id, async () => {
        const game = await load(userId, id);
        if (!game.endedAt) throw new GameError(409, '아직 끝나지 않은 판입니다. 판을 끝낸 뒤에 남겨 주세요.');
        if (game.record) throw new GameError(409, '이 판에는 이미 기록을 남겼습니다.');
        const recorded = { ...game, record: { lean, verdict, at: deps.now().toISOString() } };
        const memories = recorded.memory ? memoriesOf(recorded, topicOf(recorded), deps.newId) : [];
        await deps.store.save(recorded, memories);
        return viewOf(recorded);
      });
    },

    /** 그 사용자의 기억. 만든 시각이 늦은 것부터 RECENT_MEMORIES개. topicId가 있으면 그 주제만. */
    async memories(userId: string, topicId?: string): Promise<MemoryView[]> {
      const memories = await deps.store.listMemories(userId, { ...(topicId !== undefined ? { topicId } : {}), limit: RECENT_MEMORIES });
      return memories.map(memoryView);
    },

    /**
     * 기억 글을 고친다. 턴과 같이 보이지 않는 제어 문자를 지우고, 만들 때와 같이 한 줄로 만든 뒤 1~MAX_MEMORY_TEXT자만 받는다.
     * 없거나 남의 기억이면 있는지 드러내지 않고 '없는 기록'(404)으로 답한다.
     */
    async editMemory(userId: string, id: string, rawText: string): Promise<MemoryView> {
      const text = oneLine(rawText.replace(CONTROL_CHARS, ''));
      if (!text) throw new GameError(400, '고친 기록이 비어 있습니다.');
      if (memoryLength(text) > MAX_MEMORY_TEXT) throw new GameError(400, `기록은 ${MAX_MEMORY_TEXT}자까지 쓸 수 있습니다.`);
      const edited = await deps.store.editMemory(userId, id, text, deps.now().toISOString());
      if (!edited) throw new GameError(404, '없는 기록입니다.');
      return memoryView(edited);
    },

    /** 기억을 지운다. 판 기록과 턴 원문은 남는다. 없거나 남의 기억이면 '없는 기록'(404)이다. */
    async deleteMemory(userId: string, id: string): Promise<DeleteMemoryResponse> {
      if (!(await deps.store.deleteMemory(userId, id))) throw new GameError(404, '없는 기록입니다.');
      return { deleted: true };
    },
  };
}
