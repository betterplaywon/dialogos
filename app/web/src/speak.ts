// 상대의 말을 소리로 읽는다: 읽을 글 나누기, 한국어 목소리 고르기, 캐릭터별 속도와 높낮이, 읽기 제어기.
// 이 파일은 app/tests가 불러오므로 DOM 전역 타입을 쓰지 않는다. 실제 음성 합성은 browser-voice.ts가 잇는다.

/** 브라우저의 SpeechSynthesisVoice에서 쓰는 것만 적은 모양. */
export interface VoiceLike {
  name: string;
  lang: string;
  /** 기기 안의 목소리면 true. false면 읽을 글이 브라우저 회사의 서버로 간다. */
  localService: boolean;
  default: boolean;
}

/** Android는 'ko_KR'처럼 밑줄을 쓴다. */
const isKorean = (voice: VoiceLike): boolean => /^ko(-|$)/i.test(voice.lang.replace(/_/g, '-'));

/**
 * 기기 안 목소리의 차례를 이름으로 정하는 표. 위에서부터 먼저 맞는 줄을 쓰고, 어느 줄에도 맞지 않으면 OTHER_LOCAL이다.
 * Yuna와 기계음에 가까운 여덟은 이 Mac의 Chrome 157에서 본 이름이고, 고품질판과 Windows의 이름은 직접 보지 못했다.
 */
const LOCAL_NAME_RANKS: readonly (readonly [RegExp, number])[] = [
  [/^(yuna|유나).*(premium|enhanced|프리미엄|고품질)/i, 0],
  [/^(yuna|유나)(?![\p{L}\p{N}])/iu, 1],
  [/^Microsoft\b.*(Korean|한국어)/i, 2],
  [/^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)(?![\p{L}\p{N}])/iu, 4],
];
const OTHER_LOCAL_RANK = 3;
const REMOTE_RANK = 5;

function rankOf(voice: VoiceLike): number {
  if (!voice.localService) return REMOTE_RANK;
  return LOCAL_NAME_RANKS.find(([pattern]) => pattern.test(voice.name))?.[1] ?? OTHER_LOCAL_RANK;
}

/**
 * 한국어 목소리를 좋은 것부터 늘어놓는다: 기기 안의 자연스러운 목소리, 그 밖의 기기 목소리, 기계음에 가까운 목소리, 원격 목소리.
 * 차례가 같으면 브라우저의 기본 목소리를 앞에 두고, 그다음은 브라우저가 준 차례를 따른다.
 */
export function koreanVoices<V extends VoiceLike>(voices: readonly V[]): V[] {
  return voices.filter(isKorean).sort((a, b) => rankOf(a) - rankOf(b) || Number(b.default) - Number(a.default));
}

/**
 * 지금 쓸 목소리. preferredName(사용자가 고른 이름)이 목록에 있으면 그것, 없으면 기기 안 목소리 가운데 가장 좋은 것이다.
 * 기기 안 목소리가 없으면 목록이 다 온 뒤(settled)에만 원격 목소리를 쓴다. 그 전에는 'wait'다.
 * 기기 목소리는 원격 목소리보다 늦게 온다(실측 약 1.1초). 그사이에 읽을 글을 서버로 보내지 않으려는 것이다.
 */
export function chooseVoice<V extends VoiceLike>(voices: readonly V[], preferredName: string | null, settled: boolean): V | 'wait' | null {
  const korean = koreanVoices(voices);
  const preferred = preferredName === null ? undefined : korean.find((voice) => voice.name === preferredName);
  if (preferred) return preferred;
  const best = korean[0];
  if (best?.localService) return best;
  if (!settled) return 'wait';
  return best ?? null;
}

export interface VoiceStyle {
  rate: number;
  pitch: number;
}

const PLAIN_STYLE: VoiceStyle = { rate: 1, pitch: 1 };

/**
 * 캐릭터(입장 카드의 id)마다 다른 속도와 높낮이. 목소리가 하나뿐이어도 두 캐릭터가 달리 들리게 한다.
 * 들어 보고 조정할 취향 값이다. 결과를 따지는 사람은 조금 빠르고 높게, 원칙을 지키는 사람은 조금 느리고 낮게 둔다.
 */
const CHARACTER_STYLES = new Map<string, VoiceStyle>([
  ['utilitarian', { rate: 1.08, pitch: 1.15 }],
  ['deontologist', { rate: 0.94, pitch: 0.85 }],
]);

export function styleOf(characterId: string | undefined): VoiceStyle {
  return (characterId === undefined ? undefined : CHARACTER_STYLES.get(characterId)) ?? PLAIN_STYLE;
}

/**
 * 한 번에 읽는 조각의 길이 상한(글자 수).
 * 실측에서 186자를 읽는 데 24.2초가 걸렸으므로(초당 약 7.7자) 80자는 약 10초다.
 * 원격 목소리는 15초쯤에서 끊긴다는 보고가 있어(직접 재지 않음) 그보다 짧게 잡았다.
 */
export const SPEECH_CHUNK_CHARS = 80;

/** 문장 끝 부호 뒤의 공백. 닫는 따옴표와 괄호는 앞 문장에 붙인다. '3.5'는 뒤에 공백이 없어 나뉘지 않는다. */
const SENTENCE_GAP = /(?<=[.!?…][)\]"'”’]*)\s+/u;
const COMMA_GAP = /(?<=[,，、])\s+/u;

/** 이어진 조각들을 상한을 넘지 않는 만큼씩 다시 붙인다. */
function pack(parts: readonly string[], limit: number): string[] {
  const packed: string[] = [];
  for (const part of parts) {
    const last = packed[packed.length - 1];
    if (last !== undefined && last.length + 1 + part.length <= limit) packed[packed.length - 1] = `${last} ${part}`;
    else packed.push(part);
  }
  return packed;
}

/** 공백이 없는 긴 덩어리는 글자 수로 자른다. */
function slices(word: string, limit: number): string[] {
  const letters = [...word];
  const pieces: string[] = [];
  for (let start = 0; start < letters.length; start += limit) pieces.push(letters.slice(start, start + limit).join(''));
  return pieces;
}

/** 상한을 넘는 문장을 쉼표에서, 그래도 길면 공백에서 나눈다. */
function fit(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  return pack(sentence.split(COMMA_GAP), limit).flatMap((clause) => {
    if (clause.length <= limit) return [clause];
    return pack(clause.split(/\s+/), limit).flatMap((piece) => (piece.length <= limit ? [piece] : slices(piece, limit)));
  });
}

/**
 * 읽을 글을 조각으로 나눈다. 줄바꿈과 문장 끝에서 나누고, 긴 문장은 maxChars 안에 들게 더 나눈다.
 * 소리 낼 글자가 없는 조각(빈 줄, 부호뿐인 조각)은 버린다.
 */
export function splitForSpeech(text: string, maxChars = SPEECH_CHUNK_CHARS): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  return text
    .split(/\n+/)
    .flatMap((line) => line.trim().split(SENTENCE_GAP))
    .flatMap((sentence) => fit(sentence, limit))
    .filter((chunk) => /[\p{L}\p{N}]/u.test(chunk));
}

export interface SpeechChunk<V> {
  text: string;
  voice: V;
  rate: number;
  pitch: number;
}

/**
 * 브라우저의 음성 합성에서 쓰는 것만 적은 포트. speak는 조각을 대기열 끝에 넣는다.
 * done은 조각이 끝까지 읽혔으면 'end'로, 오류로 끝났으면 그 오류 코드로 부른다.
 * 읽기 전에 cancel된 대기 조각은 done이 불리지 않는다(실측: 아무 이벤트도 오지 않았다).
 */
export interface SynthPort<V> {
  speak(chunk: SpeechChunk<V>, done: (outcome: string) => void): void;
  cancel(): void;
}

/** 읽다가 생긴 문제. 'blocked'는 브라우저가 소리 재생을 막은 것이다. */
export type SpeakProblem = 'blocked' | 'interrupted' | 'failed';

/** 문제마다 화면에 보일 말. */
export const SPEAK_PROBLEMS: Record<SpeakProblem, string> = {
  blocked: '브라우저가 소리 재생을 막았습니다. 상대의 말에 있는 [듣기]를 눌러 주세요.',
  interrupted: '읽기가 중간에 끊겼습니다. [듣기]를 누르면 처음부터 다시 읽습니다.',
  failed: '읽는 중에 문제가 생겼습니다. [듣기]를 누르면 다시 읽어 봅니다.',
};

function problemOf(outcome: string): SpeakProblem {
  if (outcome === 'not-allowed') return 'blocked';
  return outcome === 'interrupted' || outcome === 'canceled' ? 'interrupted' : 'failed';
}

export interface Speaker<V> {
  /**
   * 읽던 것을 끊고 새 글을 읽는다. 끝까지 읽었으면 onDone(null), 문제가 생겼으면 onDone(문제)를 한 번 부른다.
   * 읽을 조각이 없으면 onDone(null)을 이 함수가 돌아가기 전에 부른다.
   */
  say(text: string, voice: V, style: VoiceStyle, onDone: (problem: SpeakProblem | null) => void): void;
  /** 읽기를 끊는다. 끊긴 읽기의 onDone은 부르지 않는다. */
  stop(): void;
}

/**
 * 읽기 제어기. 조각을 모두 한꺼번에 대기열에 넣고, 마지막 조각이 끝나면 끝났다고 알린다.
 * 취소된 대기 조각은 이벤트가 오지 않으므로 조각의 이벤트로 상태를 세지 않는다.
 * say와 stop마다 세대 번호를 올리고, 지난 세대의 이벤트(끊긴 조각의 interrupted 등)는 버린다.
 */
export function createSpeaker<V>(synth: SynthPort<V>): Speaker<V> {
  let generation = 0;
  return {
    say(text, voice, style, onDone) {
      generation += 1;
      const mine = generation;
      synth.cancel();
      const chunks = splitForSpeech(text);
      if (chunks.length === 0) {
        onDone(null);
        return;
      }
      for (const [index, chunk] of chunks.entries()) {
        // 앞 조각이 넣자마자 오류로 끝났으면 남은 조각은 넣지 않는다.
        if (mine !== generation) return;
        synth.speak({ text: chunk, voice, rate: style.rate, pitch: style.pitch }, (outcome) => {
          if (mine !== generation) return;
          if (outcome === 'end') {
            if (index < chunks.length - 1) return;
            generation += 1;
            onDone(null);
            return;
          }
          generation += 1;
          synth.cancel();
          onDone(problemOf(outcome));
        });
      }
    },
    stop() {
      generation += 1;
      synth.cancel();
    },
  };
}
