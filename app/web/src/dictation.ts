// 음성 인식이 적은 글을 입력 칸에 넣고, 보낼 때 그 턴을 넣은 방식을 정한다. 화면 밖에서 검사할 수 있게 React와 떼어 둔다.
//
// 넣은 방식은 "고쳐야 하는 턴이 5턴 중 1턴을 넘으면 인식을 올린다"는 기준을 재는 데 쓴다.
// 그래서 인식이 틀려 손댄 턴만 고친 턴으로 세도록, 글자와 숫자만 놓고 견준다.

import type { TurnInput, VoiceTally } from '../../server/contract.ts';

/** 듣기가 끝난 뒤의 입력 칸 글, 이 턴의 인식 조각, 화면에 알릴 말. */
export interface Dictation {
  draft: string;
  segments: string[];
  /** 입력 칸에 한 일. 들은 글이 없었으면 null이다. */
  notice: string | null;
}

/**
 * 들은 글로 입력 칸의 글을 바꾼다. 다시 말하면 이어 붙이지 않고 새로 들은 글로 바꾼다(2026-11-23 사용자 결정).
 * 들은 글의 앞뒤 공백은 떼고 안의 이어진 공백은 하나로 줄이며, maxLength를 넘는 부분은 자른다.
 * 들은 글이 없거나 한 글자도 들어가지 못하면 입력 칸과 조각을 그대로 둔다. 잘못 눌러 쓰던 글을 잃지 않게 하려는 것이다.
 * 조각은 바뀐 앞 조각도 남긴다. 그래서 앞서 인식된 글을 다시 말해 바꾼 턴은 turnInputOf가 고친 턴으로 센다.
 */
export function takeDictation(draft: string, segments: readonly string[], transcript: string, maxLength: number): Dictation {
  const heard = transcript.trim().replace(/\s+/g, ' ');
  // 자른 끝에 공백이나, 두 칸짜리 글자(이모지 등)의 앞 반쪽만 남지 않게 한다.
  const text = heard
    .slice(0, Math.max(0, maxLength))
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();
  if (!text) return { draft, segments: [...segments], notice: heard ? '인식한 글을 입력 칸에 넣지 못했습니다.' : null };
  const notice =
    text.length < heard.length
      ? '인식한 글이 길어 앞부분만 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.'
      : draft.trim()
        ? '입력 칸의 글을 새로 인식한 글로 바꿨습니다. 고친 뒤 보내 주세요.'
        : '인식한 글을 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.';
  return { draft: text, segments: [...segments, text], notice };
}

/** 견줄 때는 글자와 숫자만 남긴다. 인식된 글에는 문장 부호가 원래 없어, 공백과 부호만 손본 것은 고친 것으로 치지 않는다. */
const lettersOf = (text: string): string => text.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * 보낼 글과, 이 턴에 인식되어 입력 칸에 들어간 조각들로 넣은 방식을 정한다.
 * 모든 조각이 보낼 글 안에 들어간 차례대로, 겹치지 않게 그대로 남아 있으면 'voice'다.
 * 낱말을 고쳤거나 인식된 글을 지우고 다시 썼으면 'voice-edited'다.
 * 인식된 글을 둔 채 앞뒤에 글로 덧붙인 것은 고친 것이 아니다.
 * 다시 말해 앞 조각을 바꿨으면 입력 칸에는 새 조각만 남는다. 앞 조각을 새 조각 앞에 손으로 다시 써 넣지 않는 한
 * 두 조각이 겹치지 않고 차례대로 남지 않으므로 고친 것이다. 같은 말을 다시 했거나 새 조각이 앞 조각을 품어도 그렇다.
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
