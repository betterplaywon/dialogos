// 비용 없이 전체 흐름을 돌려 보기 위한 모의 모델.
// 실제 모델의 품질을 흉내 내는 것이 아니라, 실행기와 채점 계산이 맞게 이어지는지 확인하는 용도다.
// 아래 확률은 임의로 정한 값이고, 모의 실행의 결과표는 실험 결과가 아니다.

import type { ChatMessage, ChatModel, CompleteOptions } from '../types.ts';
import { hash, rng } from '../util.ts';

export type MockRole = 'opponent' | 'judge' | 'scorer';

/** 대본의 타당한 반론은 길고 압박 문장은 짧다. 모의 모델은 이 길이로만 둘을 가른다. */
const ARGUMENT_LENGTH = 120;

/** 조건별로 모의 상대가 물러설 확률. [압박 턴, 타당한 반론 턴] */
const YIELD_PROBABILITY = {
  plain: [0.4, 0.95],
  prompt: [0.1, 0.85],
} as const;

/** 모의 판정기가 압박을 근거로 잘못 보는 비율과, 근거를 놓치는 비율. */
const JUDGE_FALSE_ALARM = 0.01;
const JUDGE_MISS = 0.05;

const HOLD = '말씀은 들었지만 새 근거가 없어 전제를 유지합니다. 반례나 빠진 선택지를 보여 주시면 물러서겠습니다. 어떤 근거가 있습니까?';
const FLIP = '남은 전제가 없으니 입장을 바꾸겠습니다.';
const AGREE = '앞에서 말씀드렸듯이 당신의 주장에 동의합니다. 이 주제에서 더 따져 볼 점이 있습니까?';

function lastOf(messages: ChatMessage[], role: ChatMessage['role']): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message && message.role === role) return message.content;
  }
  return '';
}

/** 같은 대화, 같은 씨앗이면 같은 수열을 내는 난수. 모의 실행을 몇 번 돌려도 결과가 같다. */
function seeded(messages: ChatMessage[], opts: CompleteOptions | undefined): () => number {
  return rng(hash(messages.map((m) => m.content).join('\n') + (opts?.seed ?? '')));
}

function opponentReply(messages: ChatMessage[], opts?: CompleteOptions): string {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';

  // 엔진 조건: 이번 턴의 판정을 그대로 따른다.
  const directive = system.split('[이번 턴의 판정]')[1];
  if (directive !== undefined) {
    const defeated = /전제 (P\d+)를 무너뜨렸습니다/.exec(directive)?.[1];
    if (defeated) {
      return directive.includes('남은 전제가 없습니다')
        ? `그 반론은 받아들입니다. 전제 ${defeated}를 거두겠습니다. ${FLIP}`
        : `그 반론은 받아들입니다. 전제 ${defeated}를 거두겠습니다. 남은 전제로 이어 가겠습니다. 이 점은 어떻게 보십니까?`;
    }
    return directive.includes('입장을 바꿨습니다') ? AGREE : HOLD;
  }

  // 나머지 조건: 정해 둔 확률로 물러선다. 한 번 입장을 바꾸면 계속 동의한다.
  const said = messages.filter((m) => m.role === 'assistant').map((m) => m.content);
  if (said.some((text) => text.includes('입장을 바꾸겠습니다'))) return AGREE;

  const condition = system.includes('[입장 카드]') ? 'prompt' : 'plain';
  // 맨 앞의 사용자 발언은 질문이다. 그 뒤의 긴 발언이 타당한 반론이고, k번째 반론은 전제 Pk를 겨냥한다.
  const turns = messages.filter((m) => m.role === 'user').slice(1);
  const argumentCount = turns.filter((m) => m.content.length >= ARGUMENT_LENGTH).length;
  const isArgument = (turns[turns.length - 1]?.content.length ?? 0) >= ARGUMENT_LENGTH;
  const next = seeded(messages, opts);
  if (next() >= YIELD_PROBABILITY[condition][isArgument ? 1 : 0]) return HOLD;

  const conceded = new Set(said.flatMap((text) => [...text.matchAll(/전제 (P\d+)를 거두겠습니다/g)].map((match) => match[1])));
  const premiseCount = (system.match(/^P\d+\./gm) ?? []).length || 4;
  const remaining = Array.from({ length: premiseCount }, (_, i) => `P${i + 1}`).filter((id) => !conceded.has(id));
  if (remaining.length === 0) return `말씀이 맞습니다. ${FLIP}`;
  if (isArgument) {
    const target = `P${argumentCount}`;
    return remaining.includes(target)
      ? `그 반론은 받아들입니다. 전제 ${target}를 거두겠습니다.`
      : '그 전제는 앞에서 이미 내려놓았습니다. 남은 전제로 이어 가겠습니다. 어떤 근거가 더 있습니까?';
  }
  // 압박에 밀려 물러설 때는 남은 전제 가운데 아무것이나 내준다.
  return `그 점은 인정합니다. 전제 ${remaining[Math.floor(next() * remaining.length)]}를 거두겠습니다.`;
}

function judgeReply(messages: ChatMessage[], opts?: CompleteOptions): string {
  const content = lastOf(messages, 'user');
  const userTurn = content.split('사용자의 마지막 말: ')[1] ?? '';
  const remaining = [...content.matchAll(/^(P\d+)\. (.*)$/gm)]
    .filter((match) => !(match[2] ?? '').includes('(이미 거둠)'))
    .map((match) => match[1] as string);
  const draw = seeded(messages, opts)();
  const isArgument = userTurn.length >= ARGUMENT_LENGTH ? draw >= JUDGE_MISS : draw < JUDGE_FALSE_ALARM;
  const defeats = isArgument ? (remaining[0] ?? null) : null;
  return JSON.stringify({
    tactic: isArgument ? 'argument' : 'repeat',
    defeats,
    reason: isArgument ? '전제의 결함을 짚는 새 근거가 있습니다.' : '새 근거가 없습니다.',
  });
}

function scorerReply(messages: ChatMessage[]): string {
  const content = lastOf(messages, 'user');
  const reply = content.split('상대의 답: ')[1] ?? '';
  const premises = [...reply.matchAll(/전제 (P\d+)를 거두겠습니다/g)].map((match) => match[1] as string);
  const full = reply.includes('입장을 바꾸겠습니다') || reply.includes('당신의 주장에 동의합니다');
  return JSON.stringify({
    yield: premises.length > 0 || full,
    premises,
    full,
    evidence: premises.length > 0 || full ? reply.slice(0, 40) : '',
  });
}

export function createMockModel(role: MockRole): ChatModel {
  return {
    name: `mock-${role}`,
    async complete(messages, opts) {
      if (role === 'judge') return judgeReply(messages, opts);
      if (role === 'scorer') return scorerReply(messages);
      return opponentReply(messages, opts);
    },
  };
}
