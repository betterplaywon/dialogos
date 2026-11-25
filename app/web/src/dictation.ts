// 음성 인식이 적은 글을 입력 칸에 넣고, 보낼 때 그 턴을 넣은 방식과 다시 말한 횟수를 정한다. 화면 밖에서 검사할 수 있게 React와 떼어 둔다.
//
// 넣은 방식은 "고쳐야 하는 턴이 5턴 중 1턴을 넘으면 인식을 올린다"는 기준을 재는 데 쓴다.
// 그래서 인식이 틀려 손댄 턴만 고친 턴으로 세도록, 글자와 숫자만 놓고 견준다.
// 고친 턴은 마지막 인식 글로 세고, 다시 말한 횟수는 따로 남긴다(2026-11-24 사용자 결정). 다시 말한 까닭(인식이 틀림, 쉼에 끊김,
// 생각이 바뀜)은 가릴 수 없어, 고친 턴에 넣지 않고 따로 세어 둘을 나눠 볼 수 있게 한다.

import type { TurnEntry, TurnInput, VoiceTally } from '../../server/contract.ts';

/** 한 턴의 받아쓰기 기록. 보낼 때 넣은 방식과 다시 말한 횟수를 정한다(turnEntryOf). */
export interface TurnDictation {
  /** 보낼 글에 남아 있어야 할 인식 조각. 다시 말해 바꾼 조각은 뺀다. */
  readonly segments: readonly string[];
  /** 앞서 인식된 글을 다시 말해 바꾼 횟수. */
  readonly redone: number;
}

/** 아직 받아쓴 것이 없는 턴. */
export const NEW_TURN: TurnDictation = { segments: [], redone: 0 };

/** 듣기가 끝난 뒤의 입력 칸 글, 이 턴의 받아쓰기 기록, 화면에 알릴 말. */
export interface Dictation {
  draft: string;
  turn: TurnDictation;
  /** 입력 칸에 한 일. 들은 글이 없었으면 null이다. */
  notice: string | null;
}

/** 들은 글을 room 글자 안으로 자른다. 자른 끝에 공백이나, 두 칸짜리 글자(이모지 등)의 앞 반쪽만 남지 않게 한다. */
const cutTo = (text: string, room: number): string =>
  text
    .slice(0, Math.max(0, room))
    .replace(/[\uD800-\uDBFF]$/, '')
    .trimEnd();

/**
 * 들은 글을 입력 칸에 넣는다(2026-11-24 사용자 결정).
 * - 입력 칸이 이 턴의 마지막 인식 조각 그대로면(손대지 않았으면) 새로 들은 글로 바꾼다. 다시 말해도 글이 쌓이지 않는다.
 *   바뀐 조각은 기록에서 빼고 다시 말한 횟수를 하나 올린다.
 * - 직접 쓰거나 고친 글이 있으면 지우지 않고 끝에 붙인다. 빈 칸(공백뿐인 칸도)이면 그대로 넣는다.
 * - appendOnly면 바꾸지 않고 붙인다. 듣는 중에 음성을 끄면 알림 줄이 사라지므로, 그때 바꾸면 쓰던 글이 알림 없이 사라진다.
 * 들은 글의 앞뒤 공백은 떼고 안의 이어진 공백은 하나로 줄이며, 남은 자리를 넘는 부분은 자른다.
 * 들은 글이 없거나 한 글자도 들어가지 못하면 입력 칸과 기록을 그대로 둔다.
 */
export function takeDictation(
  draft: string,
  turn: TurnDictation,
  transcript: string,
  maxLength: number,
  options: { appendOnly?: boolean } = {},
): Dictation {
  const heard = transcript.trim().replace(/\s+/g, ' ');
  if (!heard) return { draft, turn, notice: null };
  const replace = !options.appendOnly && turn.segments.length > 0 && draft === turn.segments[turn.segments.length - 1];
  // 바꾸거나 빈 칸에 넣을 때는 앞 글을 두지 않는다. 붙일 때는 사이에 공백 하나를 둔다(앞 글이 공백으로 끝나면 두지 않는다).
  const base = replace || draft.trim() === '' ? '' : draft;
  const gap = base === '' || /\s$/.test(base) ? '' : ' ';
  const text = cutTo(heard, maxLength - base.length - gap.length);
  if (!text) {
    return { draft, turn, notice: base ? '입력 칸이 가득 차 인식한 글을 넣지 못했습니다.' : '인식한 글을 입력 칸에 넣지 못했습니다.' };
  }
  const cut = text.length < heard.length;
  const notice = cut
    ? base
      ? '입력 칸이 가득 차 인식한 글의 앞부분만 붙였습니다. 고친 뒤 보내 주세요.'
      : '인식한 글이 길어 앞부분만 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.'
    : replace
      ? '앞서 인식한 글을 새로 인식한 글로 바꿨습니다. 고친 뒤 보내 주세요.'
      : base
        ? '쓰던 글은 두고 인식한 글을 끝에 붙였습니다. 고친 뒤 보내 주세요.'
        : '인식한 글을 입력 칸에 넣었습니다. 고친 뒤 보내 주세요.';
  const next: TurnDictation = replace
    ? { segments: [...turn.segments.slice(0, -1), text], redone: turn.redone + 1 }
    : { segments: [...turn.segments, text], redone: turn.redone };
  return { draft: base + gap + text, turn: next, notice };
}

/** 견줄 때는 글자와 숫자만 남긴다. 인식된 글에는 문장 부호가 원래 없어, 공백과 부호만 손본 것은 고친 것으로 치지 않는다. */
const lettersOf = (text: string): string => text.normalize('NFC').replace(/[^\p{L}\p{N}]/gu, '');

/**
 * 보낼 글과, 이 턴에 인식되어 입력 칸에 들어간 조각들로 넣은 방식을 정한다.
 * 모든 조각이 보낼 글 안에 들어간 차례대로, 겹치지 않게 그대로 남아 있으면 'voice'다.
 * 낱말을 고쳤거나 인식된 글을 지우고 다시 썼으면 'voice-edited'다.
 * 인식된 글을 둔 채 앞뒤에 글로 덧붙인 것은 고친 것이 아니다.
 * 다시 말해 바꾼 조각은 takeDictation이 조각에서 빼므로 여기서 세지 않는다. 고친 턴은 마지막 인식 글로 센다.
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

/** 보낼 때 넣은 방식과 다시 말한 횟수를 정한다. 글로 넣은 턴은 다시 말한 횟수를 0으로 둔다(서버가 그렇게 받는다). */
export function turnEntryOf(sent: string, turn: TurnDictation): TurnEntry {
  const input = turnInputOf(sent, turn.segments);
  return { input, redone: input === 'text' ? 0 : turn.redone };
}

/** 판에서 말로 보낸 턴, 고쳐 보낸 턴, 다시 말한 턴을 한 줄로 적는다. 말로 보낸 턴이 없으면 null이다. */
export function voiceTallyText(voice: VoiceTally): string | null {
  if (voice.turns === 0) return null;
  if (voice.redone === 0) return `말로 보낸 ${voice.turns}턴 가운데 ${voice.edited}턴을 고쳐 보냈습니다.`;
  return `말로 보낸 ${voice.turns}턴 가운데 ${voice.edited}턴을 고쳐 보냈고, ${voice.redone}턴은 다시 말했습니다.`;
}
