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
 * 원격 목소리는 사용자가 고른 것일 때만 쓴다. 읽을 글이 서버로 가는 일을 앱이 대신 정하지 않는다.
 * 기기 안 목소리가 없으면 목록이 오는 동안(settled 전)에는 'wait', 다 온 뒤에는 null이다.
 * settled는 추정이라(목록이 다 왔다는 신호가 없다) 화면에 보일 말을 가르는 데만 쓴다.
 */
export function chooseVoice<V extends VoiceLike>(voices: readonly V[], preferredName: string | null, settled: boolean): V | 'wait' | null {
  const korean = koreanVoices(voices);
  const preferred = preferredName === null ? undefined : korean.find((voice) => voice.name === preferredName);
  if (preferred) return preferred;
  const best = korean[0];
  if (best?.localService) return best;
  return settled ? null : 'wait';
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

/** 번호만 있는 조각('1.', '2.'). 목록의 번호가 뒤의 문장과 떨어져 따로 읽히지 않게 다음 조각에 붙인다. */
const LIST_NUMBER = /^\d{1,3}\.$/;

function joinListNumbers(sentences: readonly string[]): string[] {
  const joined: string[] = [];
  let number = '';
  for (const sentence of sentences) {
    if (LIST_NUMBER.test(sentence)) {
      number = number ? `${number} ${sentence}` : sentence;
      continue;
    }
    joined.push(number ? `${number} ${sentence}` : sentence);
    number = '';
  }
  if (number) joined.push(number);
  return joined;
}

/**
 * 읽을 글을 조각으로 나눈다. 줄바꿈과 문장 끝에서 나누고, 긴 문장은 maxChars 안에 들게 더 나눈다.
 * 소리 낼 글자가 없는 조각(빈 줄, 부호뿐인 조각)은 버린다.
 */
export function splitForSpeech(text: string, maxChars = SPEECH_CHUNK_CHARS): string[] {
  const limit = Math.max(1, Math.floor(maxChars));
  return text
    .split(/\n+/)
    .flatMap((line) => joinListNumbers(line.trim().split(SENTENCE_GAP)))
    .flatMap((sentence) => fit(sentence, limit))
    .filter((chunk) => /[\p{L}\p{N}]/u.test(chunk));
}

export interface SpeechChunk<V> {
  text: string;
  voice: V;
  rate: number;
  pitch: number;
}

/** 대기열에 넣은 조각 하나가 내는 이벤트. cancel된 대기 조각은 아무 이벤트도 내지 않는다(실측). */
export interface ChunkEvents {
  /** 조각이 실제로 읽히기 시작했다. */
  onStart(): void;
  /** 조각이 끝났다. 끝까지 읽혔으면 'end', 오류로 끝났으면 그 오류 코드다. 오류는 speak가 돌아가기 전에 올 수도 있다(Chrome 157의 not-allowed가 그랬다, 실측). */
  onDone(outcome: string): void;
}

/** 브라우저의 음성 합성에서 쓰는 것만 적은 포트. speak는 조각을 대기열 끝에 넣고, cancel은 대기열을 비운다. */
export interface SynthPort<V> {
  speak(chunk: SpeechChunk<V>, events: ChunkEvents): void;
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
 * 넣은 조각이 이만큼 동안 시작하지도 끝나지도 않으면 합성기가 멈춘 것으로 본다.
 * 실측에서 넣은 뒤 start까지는 보통 25ms 안이었고, 음성을 처음 켠 직후에는 목소리 목록을 기다리느라 약 1.1초였다.
 * 그보다 넉넉히 길게 잡았다. 원격 목소리의 시작이 얼마나 늦을 수 있는지는 재지 않았다.
 */
const START_WATCH_MS = 6_000;

/** 사용자가 원하는 읽기 하나. */
interface Reading<V> {
  readonly chunks: readonly string[];
  readonly voice: V;
  readonly style: VoiceStyle;
  readonly onDone: (problem: SpeakProblem | null) => void;
}

/** 합성기 대기열에 넣은 한 읽기의 조각들. */
interface Batch<V> {
  readonly reading: Reading<V>;
  /** 넣은 조각 가운데 아직 끝나지 않은 수. */
  left: number;
  /** 조각 하나가 읽히는 중이다(start가 왔고 아직 끝나지 않았다). */
  speaking: boolean;
}

/**
 * 읽기 제어기. 사용자가 원하는 읽기(wanted)와 합성기 대기열에 든 우리 조각(queued)을 따로 갖고, flush가 둘을 맞춘다.
 *
 * 대기열은 조각이 읽히는 중일 때만 끊는다. Chrome 157은 맨 앞 조각이 start를 내기 전에 cancel하면 대기열이 멈췄다
 * (실측: 뒤에 넣은 조각이 시작하지 않고 speaking과 pending이 참으로 남았다. start 이벤트 안이나 그 뒤에 끊으면 뒤의 조각을 모두 읽었다).
 * 그래서 넣었지만 아직 시작 전이면 끊지 않고 기다렸다가, 다음 start에서 다시 맞춘다.
 * 문장과 문장 사이의 틈도 그렇게 다룬다. 그 틈(앞 문장의 end 이벤트 안)에 끊었을 때는 세 번 모두 멈추지 않았지만(실측), 경우를 나누지 않는 쪽이 단순하다.
 */
export function createSpeaker<V>(synth: SynthPort<V>): Speaker<V> {
  /** 사용자가 지금 원하는 읽기. say가 바꾸고, stop과 끝났다는 알림이 비운다. */
  let wanted: Reading<V> | null = null;
  /**
   * 합성기 대기열에 든 우리 조각들. 모두 끝났거나 끊었으면 null이다.
   * cancel한 뒤에 오는 이벤트(끊긴 조각의 interrupted 등)는 조각의 묶음이 이것과 달라서 버려진다.
   * null일 때는 cancel을 부르지 않는다. 읽는 것이 없는데 끊으면 끊은 직후의 읽기를 놓친다고 알려진 브라우저(Safari)가 있다
   * (이 환경에서 확인하지 못했다).
   */
  let queued: Batch<V> | null = null;
  /** 시작 감시. 넣은 조각이 있고 읽히는 중인 조각이 없는 동안에만 걸려 있다. */
  let startWatch: ReturnType<typeof setTimeout> | undefined;

  /** 읽기가 끝났다고 한 번 알린다. 그사이 끊겼거나 새 읽기에 밀린 읽기는 알리지 않는다. */
  function settle(reading: Reading<V>, problem: SpeakProblem | null): void {
    if (wanted !== reading) return;
    wanted = null;
    reading.onDone(problem);
  }

  /** 합성기 대기열을 원하는 읽기에 맞춘다. 원하는 읽기나 대기열의 상태가 바뀔 때마다 부른다. */
  function flush(): void {
    if (queued) {
      if (queued.reading === wanted) return;
      // 읽히는 중이 아니면 끊지 않고 두었다가 다음 start에서 다시 맞춘다(까닭은 위의 설명).
      if (!queued.speaking) return;
      queued = null;
      synth.cancel();
    }
    if (wanted) put(wanted);
  }

  /** 시작 감시를 처음부터 다시 잰다. 조각을 넣었을 때와, 조각이 끝났는데 남은 조각이 있을 때 부른다. */
  function watchStart(batch: Batch<V>): void {
    clearTimeout(startWatch);
    startWatch = setTimeout(() => {
      // 이미 멈춘 대기열이라 시작 전에 끊어도 더 잃을 것이 없다.
      // 멈춘 대기열을 끊고 같은 틱에 새 조각을 넣었더니 되살아난 적이 있다(실측: 두 번 가운데 한 번).
      queued = null;
      synth.cancel();
      settle(batch.reading, 'failed');
      flush();
    }, START_WATCH_MS);
  }

  /** 읽기의 조각을 모두 한꺼번에 차례대로 넣는다. */
  function put(reading: Reading<V>): void {
    const batch: Batch<V> = { reading, left: 0, speaking: false };
    queued = batch;
    watchStart(batch);
    for (const text of reading.chunks) {
      batch.left += 1;
      synth.speak(
        { text, voice: reading.voice, rate: reading.style.rate, pitch: reading.style.pitch },
        {
          onStart() {
            if (queued !== batch) return;
            clearTimeout(startWatch);
            batch.speaking = true;
            flush();
          },
          onDone(outcome) {
            if (queued !== batch) return;
            batch.speaking = false;
            batch.left -= 1;
            if (batch.left > 0) {
              watchStart(batch);
            } else {
              clearTimeout(startWatch);
              queued = null;
            }
            // 오류로 끝난 조각 뒤에 남은 조각은 원하는 읽기가 아니게 되어, 시작할 때 flush가 끊는다.
            if (outcome !== 'end') settle(reading, problemOf(outcome));
            else if (batch.left === 0) settle(reading, null);
            flush();
          },
        },
      );
      // 조각이 넣자마자 오류로 끝났으면 남은 조각은 넣지 않는다.
      if (wanted !== reading) return;
    }
  }

  return {
    say(text, voice, style, onDone) {
      const chunks = splitForSpeech(text);
      wanted = chunks.length > 0 ? { chunks, voice, style, onDone } : null;
      flush();
      if (chunks.length === 0) onDone(null);
    },
    stop() {
      wanted = null;
      flush();
    },
  };
}
