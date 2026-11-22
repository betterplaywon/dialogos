// 음성 인식이 적은 글을 입력 칸에 붙이고, 보낼 때 그 턴을 넣은 방식을 정한다. 화면 밖에서 검사할 수 있게 React와 떼어 둔다.
//
// 넣은 방식은 "고쳐야 하는 턴이 5턴 중 1턴을 넘으면 인식을 올린다"는 기준을 재는 데 쓴다.
// 그래서 인식이 틀려 손댄 턴만 고친 턴으로 세도록, 글자와 숫자만 놓고 견준다.

import type { TurnInput, VoiceTally } from '../../server/contract.ts';

export interface Appended {
  /** 붙인 뒤의 입력 칸 글. */
  draft: string;
  /** 실제로 들어간 글. 자리가 없으면 잘리거나 빈 글이다. */
  added: string;
  /** 자리가 모자라 인식된 글의 일부나 전부가 들어가지 못했으면 true. */
  cut: boolean;
}

/**
 * 인식된 글을 입력 칸의 글 끝에 붙인다. 인식된 글의 앞뒤 공백은 떼고 안의 이어진 공백은 하나로 줄인다.
 * 입력 칸이 비었거나 공백으로 끝나면 그대로 붙이고, 아니면 사이에 공백 하나를 둔다. maxLength를 넘는 부분은 자른다.
 */
export function appendDictation(draft: string, transcript: string, maxLength: number): Appended {
  const heard = transcript.trim().replace(/\s+/g, ' ');
  if (!heard) return { draft, added: '', cut: false };
  const gap = draft === '' || /\s$/.test(draft) ? '' : ' ';
  const room = Math.max(0, maxLength - draft.length - gap.length);
  // 자른 끝에 공백이나, 두 칸짜리 글자(이모지 등)의 앞 반쪽만 남지 않게 한다.
  const added = heard
    .slice(0, room)
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
  if (!added) return { draft, added: '', cut: true };
  return { draft: draft + gap + added, added, cut: added.length < heard.length };
}

/** 듣기가 끝난 뒤 입력 칸에 무엇을 했는지 알리는 말. 들은 글이 없었으면 null이다. */
export function dictationNotice(appended: Appended): string | null {
  if (!appended.cut) return appended.added ? '인식한 글을 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.' : null;
  return appended.added
    ? '입력 칸이 가득 차 인식한 글의 앞부분만 넣었습니다. 고친 뒤 보내 주세요.'
    : '입력 칸이 가득 차 인식한 글을 넣지 못했습니다.';
}

/** 견줄 때는 글자와 숫자만 남긴다. 인식된 글에는 문장 부호가 원래 없어, 공백과 부호만 손본 것은 고친 것으로 치지 않는다. */
const lettersOf = (text: string): string => text.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * 보낼 글과, 이 턴에 인식되어 입력 칸에 들어간 조각들로 넣은 방식을 정한다.
 * 모든 조각이 보낼 글 안에 들어간 차례대로, 겹치지 않게 그대로 남아 있으면 'voice'다.
 * 낱말을 고쳤거나 인식된 글을 지우고 다시 썼으면 'voice-edited'다.
 * 인식된 글을 둔 채 앞뒤에 글로 덧붙인 것, 여러 번에 나눠 말한 것은 고친 것이 아니다.
 */
export function turnInputOf(sent: string, segments: readonly string[]): TurnInput {
  const spoken = segments.map(lettersOf).filter((segment) => segment !== '');
  if (spoken.length === 0) return 'text';
  const whole = lettersOf(sent);
  let from = 0;
  for (const segment of spoken) {
    const at = whole.indexOf(segment, from);
    if (at === -1) return 'voice-edited';
    from = at + segment.length;
  }
  return 'voice';
}

/** 판에서 말로 보낸 턴과 고쳐 보낸 턴을 한 줄로 적는다. 말로 보낸 턴이 없으면 null이다. */
export function voiceTallyText(voice: VoiceTally): string | null {
  if (voice.turns === 0) return null;
  return `말로 보낸 ${voice.turns}턴 가운데 ${voice.edited}턴을 고쳐 보냈습니다.`;
}
