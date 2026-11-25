// 사용자별 기억. 끝 기록을 남긴 판에서 규칙으로 만든다. 모델을 부르지 않는다.
// 기억은 판보다 오래 살고 사용자가 따로 고치고 지우므로, 판 기록 밖의 표에 둔다(store.ts의 listMemories 등).
// 기억을 지워도 판 기록과 턴 원문은 남는다.

import type { Tactic } from '../../eval/src/types.ts';
import type { Lean, MemoryKind, SideIndex } from './contract.ts';
import type { Topic } from './games.ts';
import type { EndRecord, GameRecord } from './store.ts';

export interface MemoryRecord {
  id: string;
  userId: string;
  /** 기억이 나온 판. */
  gameId: string;
  topicId: string;
  /** 그 판에서 사용자가 지킨 쪽. */
  side: SideIndex;
  kind: MemoryKind;
  /** 상대에게 넘기고 화면에 보이는 글. 사용자가 고칠 수 있다. 1~MAX_MEMORY_TEXT자. */
  text: string;
  /** 만든 시각(끝 기록의 시각과 같다). */
  createdAt: string;
  /** 사용자가 고친 시각. 고친 적이 없으면 없다. */
  editedAt?: string;
}

/** 기억 한 개의 글자 수 상한. 로컬 모델의 맥락(4096)을 생각해 짧게 둔다. */
export const MAX_MEMORY_TEXT = 200;
/** 한 턴에 상대에게 넘기는 기억 수(M2 A). */
export const MEMORIES_PER_TURN = 3;

/**
 * 기억 글의 글자 수. 코드 포인트로 세어 SQLite의 length()와 같게 한다.
 * 자르기(clip)와 고친 글의 상한 확인이 같은 셈을 쓰고, 그래서 이모지를 반으로 자르지 않는다.
 */
export const memoryLength = (text: string): number => [...text].length;

/**
 * 기억 글을 한 줄로 만든다. 공백 문자 묶음(줄바꿈, 탭 포함)을 공백 하나로 바꾸고 앞뒤를 다듬는다.
 * JS의 \s에 없는 유니코드 줄바꿈 NEL(U+0085)도 함께 바꾼다(U+2028, U+2029는 \s에 있다).
 * 상대의 지시문은 기억마다 '- ' 한 줄로 넣는데, 턴 원문에는 줄바꿈이 남아 있을 수 있다.
 * 기억을 만들 때(턴 원문, 전제 글, 입장 글)와 사용자가 고친 글을 받을 때 모두 이것을 거친 뒤에 길이를 재고 자른다.
 */
export const oneLine = (text: string): string => text.replace(/[\s\u0085]+/g, ' ').trim();

/** 한 줄로 만든 뒤, n자를 넘으면 n-1자에 '…'를 붙여 n자로 줄인다. 기억 글에 넣는 조각은 모두 이것을 거친다. */
function clip(text: string, n: number): string {
  const line = oneLine(text);
  const chars = [...line];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : line;
}

/** 판정기가 '근거 없이 밀어붙임'으로 본 방식과 약점 글의 이름. 이 순서로 적는다. */
const PUSH_LABELS: Readonly<Record<Tactic, string>> = {
  repeat: '같은 주장 되풀이',
  authority: '권위·다수에 호소',
  emotion: '감정에 호소',
};

const isPush = (tactic: string): tactic is Tactic => Object.hasOwn(PUSH_LABELS, tactic);

/** 이 횟수 이상 되풀이한 방식만 약점으로 남긴다. 한 번은 버릇이라 하기 어렵다. */
const WEAKNESS_MIN = 2;

/**
 * 끝 기록을 남긴 판에서 규칙으로 기억을 만든다(M1 A). 모델을 부르지 않는 순수 함수다.
 * 사용자의 턴이 하나도 없는 판은 기억을 만들지 않는다. 순서는 claim, ground(턴 순서), shift, weakness.
 * 근거와 약점은 엔진 판의 판정에서만 나온다. 지시문 방식 판에는 판정이 없어 claim과 shift만 생긴다.
 */
export function memoriesOf(game: GameRecord & { record: EndRecord }, topic: Topic, newId: () => string): MemoryRecord[] {
  const first = game.turns[0];
  if (!first) return [];
  const { sides } = topic;
  const texts: [MemoryKind, string][] = [];

  // 입장 글은 모두 마침표로 끝나므로, 뒤에 붙이는 마침표와 겹치지 않게 하나를 뗀다.
  const kept = oneLine(sides[game.side].stance).replace(/\.$/, '');
  texts.push(['claim', `지킨 입장: ${clip(kept, 60)}. 첫 말: "${clip(first.user, 110)}"`]);

  const premises = sides[game.side].matchup?.question.premises ?? [];
  for (const turn of game.turns) {
    const defeated = turn.decision?.defeats;
    if (!defeated) continue;
    const premise = premises.find((p) => p.id === defeated)?.text ?? defeated;
    texts.push(['ground', `상대가 전제를 거둔 말: "${clip(turn.user, 120)}" (거둔 전제: ${clip(premise, 50)})`]);
  }

  const label = (lean: Lean): string =>
    lean === 0 ? '반반' : `${Math.abs(lean) === 2 ? '확실히' : '대체로'} "${clip(sides[lean < 0 ? 0 : 1].stance, 40)}"`;
  if (game.startLean !== null && game.startLean !== game.record.lean) {
    texts.push(['shift', `생각이 바뀜: ${label(game.startLean)} → ${label(game.record.lean)}`]);
  }

  // 전제를 무너뜨리지 못한 턴 가운데 밀어붙인 방식(PUSH_LABELS의 키)만 센다.
  // 근거를 댄 턴(argument)과, 판정기를 읽지 못하거나 판정하지 않은 턴(other)은 들지 않는다.
  const pushes = new Map<Tactic, number>();
  for (const turn of game.turns) {
    const decision = turn.decision;
    if (decision && decision.defeats === null && isPush(decision.tactic)) pushes.set(decision.tactic, (pushes.get(decision.tactic) ?? 0) + 1);
  }
  const weak = (Object.entries(PUSH_LABELS) as [Tactic, string][]).flatMap(([tactic, name]) => {
    const count = pushes.get(tactic) ?? 0;
    return count >= WEAKNESS_MIN ? [`${name} ${count}번`] : [];
  });
  if (weak.length > 0) texts.push(['weakness', `근거 없이 밀어붙인 턴: ${weak.join(', ')}`]);

  return texts.map(([kind, text]) => ({
    id: newId(),
    userId: game.userId,
    gameId: game.id,
    topicId: game.topicId,
    side: game.side,
    kind,
    text: clip(text, MAX_MEMORY_TEXT),
    createdAt: game.record.at,
  }));
}
