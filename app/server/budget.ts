// 서버가 모델에 쓰는 돈과 한 사용자가 쓰는 양의 상한. 실제 모델을 붙이기 전에 갖추는 장치다.
// 판 진행(games.ts)이 요청을 검사한 뒤에 이 파일의 확인을 부른다. 거절은 값(Refusal)으로 돌려주고,
// games.ts가 HTTP 오류로 바꾼다(이 파일이 games.ts를 가져오지 않게 하려는 것이다).

import type { DialogueModels } from '../../eval/src/dialogue.ts';
import type { ChatModel, Usage } from '../../eval/src/types.ts';
import { billedOutputTokens } from '../../eval/src/util.ts';
import type { GameStore, ModelRole } from './store.ts';

/** 100만 토큰당 단가(달러). 공식 가격표의 단위 그대로다. */
export interface Price {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

/** 사용량을 세는 모델. providers/api.ts의 모델이 이렇다. */
export type MeteredModel = ChatModel & { readonly usage: Usage };

/**
 * 서버가 쓰는 모델의 출처. 모의 모델은 돈이 들지 않아 세지 않는다.
 * 실제 모델은 사용량을 세는 모델이고 역할마다 단가가 있다. 그 create는 부를 때마다 새 모델을 만들어야 한다.
 * 모델 하나의 usage가 그 호출 하나의 양이 되게 하려는 것이다(meteredModels).
 */
export type ModelSource =
  | { provider: 'mock'; create(role: ModelRole): ChatModel }
  | { provider: 'api'; create(role: ModelRole): MeteredModel; prices: Readonly<Record<ModelRole, Price>> };

export interface Limits {
  /** 서비스 전체가 모델에 쓸 수 있는 돈(원). 원장에 처음부터 쌓인 합으로 센다. 닿으면 사람이 값을 바꿀 때까지 새 판과 턴을 받지 않는다. */
  totalWon: number;
  /** 한 사용자가 하루(한국 시간 0시부터)에 보낼 수 있는 턴 수. */
  userTurnsPerDay: number;
}

/** 제안값이다. 실제 값은 사용자가 정한다. */
export const LIMITS: Limits = { totalWon: 100_000, userTurnsPerDay: 90 };

/** 1달러를 원으로 바꿀 때 쓰는 값. 비용을 추정할 때 가정한 환율(2026-11-17)이고, 실제 환율을 따라가지 않는다. */
export const KRW_PER_USD = 1336;

/** 100만분의 1달러로 센 비용. 입력 토큰과 과금되는 출력 토큰에 단가를 곱해 더하고 올림한다. */
export function costMicroUsd(usage: Usage, price: Price): number {
  // 100만 토큰당 달러 단가에 토큰 수를 곱하면 100만분의 1달러가 된다.
  return Math.ceil(usage.promptTokens * price.inputUsdPerMTok + billedOutputTokens(usage) * price.outputUsdPerMTok);
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** 한국 시간은 UTC+9이고 일광 절약 시간이 없다. */
const KST_OFFSET_MS = 9 * HOUR_MS;

/** now가 속한 한국 시간 하루의 0시. 저장소의 시각과 같은 ISO 꼴(UTC)로 낸다. */
export function kstDayStart(now: Date): string {
  const kst = now.getTime() + KST_OFFSET_MS;
  return new Date(Math.floor(kst / DAY_MS) * DAY_MS - KST_OFFSET_MS).toISOString();
}

/** 상한에 걸린 요청을 거절할 때의 HTTP 상태와 화면에 보일 말. */
export interface Refusal {
  status: 429 | 503;
  message: string;
}

/**
 * 새 판이나 새 턴을 받을지 본다. 받으면 null이다. ledgerClosed는 원장 쓰기가 실패해 판 진행(games.ts)이 원장을 닫았는지다.
 * 원장이 닫혔는지(503)를 가장 먼저 본다. 저장소가 아직 망가져 있으면 원장을 읽다가 실패해, 막는 까닭을 알리지 못한다.
 * 그다음 서비스 상한(503)을 하루 턴 수(429)보다 먼저 본다. 서비스가 멈췄는데 '내일 다시 할 수 있다'고 알리지 않으려는 것이다.
 */
export async function limitRefusal(
  store: Pick<GameStore, 'totalSpendMicroUsd' | 'countTurnsSince'>,
  limits: Limits,
  userId: string,
  now: Date,
  ledgerClosed: boolean,
): Promise<Refusal | null> {
  if (ledgerClosed) {
    return {
      status: 503,
      message: "서버가 모델 사용량을 기록하지 못해, 운영자가 확인할 때까지 새 판과 턴을 받지 않습니다. 하던 판은 '지난 판'에 남아 있습니다.",
    };
  }
  // 원으로 정한 상한을 원장의 단위(100만분의 1달러)로 바꿔 견준다.
  const capMicroUsd = (limits.totalWon / KRW_PER_USD) * 1_000_000;
  if ((await store.totalSpendMicroUsd()) >= capMicroUsd) {
    return {
      status: 503,
      message: "서비스가 모델에 쓸 수 있는 비용의 한도에 닿아 지금은 상대가 답할 수 없습니다. 하던 판은 '지난 판'에 남아 있습니다.",
    };
  }
  if ((await store.countTurnsSince(userId, kstDayStart(now))) >= limits.userTurnsPerDay) {
    return {
      status: 429,
      message: `오늘(한국 시간) 보낼 수 있는 ${limits.userTurnsPerDay}턴을 모두 썼습니다. 내일 0시부터 다시 할 수 있고, 하던 판은 '지난 판'에서 이어 할 수 있습니다.`,
    };
  }
  return null;
}

/**
 * 한 턴에 쓸 모델. 실제 모델이면 complete를 부를 때마다 source.create(role)로 새 모델을 만들어 부르므로,
 * 그 모델의 usage가 그 호출 하나의 양이다. 여러 판이 한 모델의 usage를 함께 쓰지 않는다.
 * 호출이 끝나면(실패해도) 응답을 받은 호출이 있었을 때 원장에 한 줄을 남긴다. 그래서 다시 부르다 끝내 실패한
 * 호출도 받은 응답의 양은 남고, 판정기는 됐는데 상대가 실패한 턴도 판정기의 양이 남는다.
 * 원장 쓰기가 실패하면 그 호출도 실패한다. 모르는 비용으로 턴을 이어 가지 않는다.
 */
export function meteredModels(
  source: ModelSource,
  store: Pick<GameStore, 'addSpend'>,
  context: { userId: string; gameId: string; now: () => Date },
): DialogueModels {
  // 모의 모델은 돈이 들지 않아 세지 않는다.
  if (source.provider === 'mock') return { opponent: source.create('opponent'), judge: source.create('judge') };
  const metered = (role: ModelRole): ChatModel => ({
    name: role,
    async complete(messages, opts) {
      const model = source.create(role);
      try {
        return await model.complete(messages, opts);
      } finally {
        const { usage } = model;
        if (usage.calls > 0) {
          await store.addSpend({
            at: context.now().toISOString(),
            userId: context.userId,
            gameId: context.gameId,
            role,
            model: model.name,
            calls: usage.calls,
            inputTokens: usage.promptTokens,
            outputTokens: billedOutputTokens(usage),
            costMicroUsd: costMicroUsd(usage, source.prices[role]),
          });
        }
      }
    },
  });
  return { opponent: metered('opponent'), judge: metered('judge') };
}
