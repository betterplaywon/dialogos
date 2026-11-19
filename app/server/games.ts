// 판의 진행. HTTP와 저장 방식에서 떼어 두어, 서버 경로와 검사가 같은 함수를 부른다.
// 한 턴은 판정 실험과 같은 runTurn이 맡는다. 잰 상대와 배포한 상대가 같은 코드로 답한다.

import { openingState, runTurn, type DialogueModels } from '../../eval/src/dialogue.ts';
import { DEFAULT_TURNS } from '../../eval/src/script.ts';
import type { Card, Question } from '../../eval/src/types.ts';
import type { GameView, MessageView, TopicView, TurnResponse } from './contract.ts';
import type { GameRecord, GameStore, Mode } from './store.ts';

/** 한 판에서 사용자가 보낼 수 있는 턴 수. 판정 실험이 잰 대화 길이와 같다. */
export const MAX_TURNS = DEFAULT_TURNS;
/** 한 턴에 받는 글자 수. 말로 1분쯤 하는 양(300~400자)을 넉넉히 넘는다. */
export const MAX_TEXT_LENGTH = 1000;

export interface Topic {
  question: Question;
  card: Card;
}

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
  return {
    id: topic.question.id,
    question: topic.question.text,
    userStance: topic.question.userStance,
    character: { id: topic.card.id, name: topic.card.name },
  };
}

function messagesOf(game: GameRecord): MessageView[] {
  return game.history.map((m) => ({ speaker: m.role === 'assistant' ? 'opponent' : 'user', text: m.content }));
}

export function createGames(deps: GameDeps) {
  /** 한 턴이나 끝내기를 처리하는 중인 판. 서버가 하나일 때만 지켜진다. */
  const busy = new Set<string>();

  /** 같은 판의 턴과 끝내기를 한 번에 하나씩만 처리한다. 둘이 겹치면 나중 저장이 앞의 저장을 지운다. */
  async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (busy.has(id)) throw new GameError(409, '이 판의 앞 요청을 아직 처리하고 있습니다. 잠시 뒤 다시 해 주세요.');
    busy.add(id);
    try {
      return await work();
    } finally {
      busy.delete(id);
    }
  }

  function topicOf(game: GameRecord): Topic {
    const topic = deps.topics.get(game.topicId);
    if (!topic) throw new Error(`판 ${game.id}의 주제 ${game.topicId}가 없습니다.`);
    return topic;
  }

  function viewOf(game: GameRecord): GameView {
    return {
      id: game.id,
      topic: topicView(topicOf(game)),
      messages: messagesOf(game),
      turn: game.turns.length,
      maxTurns: MAX_TURNS,
      maxTextLength: MAX_TEXT_LENGTH,
      ended: game.endedAt !== undefined,
    };
  }

  async function load(id: string): Promise<GameRecord> {
    const game = await deps.store.get(id);
    if (!game) throw new GameError(404, '없는 판입니다.');
    return game;
  }

  return {
    topics(): TopicView[] {
      return [...deps.topics.values()].map(topicView);
    },

    async start(topicId: string): Promise<GameView> {
      const topic = deps.topics.get(topicId);
      if (!topic) throw new GameError(404, '없는 주제입니다.');
      const state = openingState(topic.question);
      const game: GameRecord = {
        id: deps.newId(),
        topicId,
        cardId: topic.card.id,
        mode: deps.pickMode(),
        history: state.history,
        conceded: [...state.conceded],
        turns: [],
        startedAt: deps.now().toISOString(),
      };
      await deps.store.create(game);
      return viewOf(game);
    },

    async get(id: string): Promise<GameView> {
      return viewOf(await load(id));
    },

    async turn(id: string, rawText: string): Promise<TurnResponse> {
      const text = rawText.trim();
      if (!text) throw new GameError(400, '보낼 말이 비어 있습니다.');
      if (text.length > MAX_TEXT_LENGTH) throw new GameError(400, `한 턴에는 ${MAX_TEXT_LENGTH}자까지 보낼 수 있습니다.`);
      return exclusive(id, async () => {
        const game = await load(id);
        if (game.endedAt) throw new GameError(409, '이미 끝난 판입니다.');
        if (game.turns.length >= MAX_TURNS) throw new GameError(409, `이 판은 ${MAX_TURNS}턴을 모두 마쳤습니다.`);
        const topic = topicOf(game);
        const state = { history: game.history, conceded: new Set(game.conceded) };
        const outcome = await runTurn(state, {
          question: topic.question,
          card: topic.card,
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
        if (n >= MAX_TURNS) game.endedAt = deps.now().toISOString();
        await deps.store.save(game);
        return { turn: n, reply: outcome.reply, ended: game.endedAt !== undefined };
      });
    },

    async end(id: string): Promise<GameView> {
      return exclusive(id, async () => {
        const game = await load(id);
        if (!game.endedAt) {
          game.endedAt = deps.now().toISOString();
          await deps.store.save(game);
        }
        return viewOf(game);
      });
    },
  };
}
