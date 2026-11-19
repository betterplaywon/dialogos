// 판의 진행. HTTP와 저장 방식에서 떼어 두어, 서버 경로와 검사가 같은 함수를 부른다.
// 한 턴은 판정 실험과 같은 runTurn이 맡는다. 잰 상대와 배포한 상대가 같은 코드로 답한다.

import { openingState, runTurn, type DialogueModels } from '../../eval/src/dialogue.ts';
import { DEFAULT_TURNS } from '../../eval/src/script.ts';
import type { Card, Question } from '../../eval/src/types.ts';
import type {
  EndRecordView,
  GameSummaryView,
  GameView,
  Lean,
  MessageView,
  SideIndex,
  TopicView,
  TurnResponse,
  Verdict,
} from './contract.ts';
import type { EndRecord, GameRecord, GameStore, Mode } from './store.ts';

/** 한 판에서 사용자가 보낼 수 있는 턴 수. 판정 실험이 잰 대화 길이와 같다. */
export const MAX_TURNS = DEFAULT_TURNS;
/** 한 턴에 받는 글자 수. 말로 1분쯤 하는 양(300~400자)을 넉넉히 넘는다. */
export const MAX_TEXT_LENGTH = 1000;
/** 지난 판 목록에 보이는 판 수. */
export const RECENT_GAMES = 20;
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

export interface GameDeps {
  topics: ReadonlyMap<string, Topic>;
  store: GameStore;
  models: DialogueModels;
  /** 판마다 방식을 고른다. 화면에는 알리지 않는다. */
  pickMode: () => Mode;
  newId: () => string;
  now: () => Date;
}

/** 사용자의 요청 때문에 생긴 실패. HTTP 상태와 화면에 보일 말을 함께 둔다. */
export class GameError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
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

  function viewOf(game: GameRecord): GameView {
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
      const state = openingState(matchup.question);
      const game: GameRecord = {
        id: deps.newId(),
        userId,
        topicId,
        side,
        cardId: matchup.card.id,
        mode: deps.pickMode(),
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

    async turn(userId: string, id: string, rawText: string): Promise<TurnResponse> {
      const text = rawText.replace(CONTROL_CHARS, '').trim();
      if (!text) throw new GameError(400, '보낼 말이 비어 있습니다.');
      if (text.length > MAX_TEXT_LENGTH) throw new GameError(400, `한 턴에는 ${MAX_TEXT_LENGTH}자까지 보낼 수 있습니다.`);
      return exclusive(userId, id, async () => {
        const game = await load(userId, id);
        if (game.endedAt) throw new GameError(409, '이미 끝난 판입니다.');
        if (game.turns.length >= MAX_TURNS) throw new GameError(409, `이 판은 ${MAX_TURNS}턴을 모두 마쳤습니다.`);
        const matchup = matchupOf(game);
        const state = { history: game.history, conceded: new Set(game.conceded) };
        const outcome = await runTurn(state, {
          question: matchup.question,
          card: matchup.card,
          condition: game.mode,
          models: deps.models,
          text,
        });
        const n = game.turns.length + 1;
        game.history = state.history;
        game.conceded = [...state.conceded];
        game.turns.push({
          n,
          user: text,
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
        return { turn: n, reply: outcome.reply, ended: game.endedAt !== undefined, endReason: game.endReason ?? null };
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

    /** 끝난 판에 사후 입장과 훈계 문항의 답을 남긴다. 한 번 남기면 바꾸지 않는다. */
    async record(userId: string, id: string, lean: Lean, verdict: Verdict): Promise<GameView> {
      return exclusive(userId, id, async () => {
        const game = await load(userId, id);
        if (!game.endedAt) throw new GameError(409, '아직 끝나지 않은 판입니다. 판을 끝낸 뒤에 남겨 주세요.');
        if (game.record) throw new GameError(409, '이 판에는 이미 기록을 남겼습니다.');
        game.record = { lean, verdict, at: deps.now().toISOString() };
        await deps.store.save(game);
        return viewOf(game);
      });
    },
  };
}
