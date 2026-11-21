// 한 발화를 듣는다. 브라우저의 음성 인식기를 좁은 포트로 받아, 화면 밖에서 가짜 인식기로 검사한다.
// 이 파일은 app/tests가 불러오므로 DOM 전역 타입을 쓰지 않는다. 실제 인식기는 browser-voice.ts가 잇는다.
//
// Chrome 157의 기기 안 인식은 말이 끝나도 스스로 확정하지 않았다(실측: 22초를 기다려도 확정 결과와 end가 없었다).
// 그래서 조용해지면 앱이 stop()을 부르고, end가 오지 않는 경우에 대비해 시간 제한을 둔다.

/** 결과 이벤트에서 읽는 것만 적은 모양. 결과마다 첫째 후보의 글을 쓴다. */
export interface RecognitionResults {
  readonly length: number;
  readonly [index: number]: { readonly [index: number]: { readonly transcript: string } };
}

/** 브라우저의 SpeechRecognition에서 쓰는 것만 적은 포트. */
export interface RecognizerPort {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  /** 기기 안에서만 인식하게 한다. 이 속성이 없는 브라우저가 있다. */
  processLocally?: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { readonly results: RecognitionResults }) => void) | null;
  onerror: ((event: { readonly error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type ListenProblem =
  // 다시 해 볼 수 있는 문제
  | 'no-speech'
  | 'interrupted'
  | 'network'
  | 'failed'
  // 다시 눌러도 풀리지 않아, 음성 입력을 끄고 글 입력으로 돌리는 문제
  | 'not-allowed'
  | 'no-microphone'
  | 'service-blocked'
  | 'unsupported-language';

/** 문제마다 화면에 보일 말과, 이 페이지에서 음성 입력을 끄는지. */
export const LISTEN_PROBLEMS: Record<ListenProblem, { message: string; blocks: boolean }> = {
  'no-speech': { message: '말소리를 듣지 못했습니다. [말하기]를 다시 눌러 말해 주세요.', blocks: false },
  interrupted: { message: '듣기가 중간에 끊겼습니다. [말하기]를 다시 눌러 주세요.', blocks: false },
  network: { message: '음성 인식 서버에 닿지 못했습니다. 다시 해 보거나 글로 입력해 주세요.', blocks: false },
  failed: { message: '음성 인식에 문제가 생겼습니다. 다시 해 보거나 글로 입력해 주세요.', blocks: false },
  'not-allowed': {
    message:
      '마이크 사용이 허용되지 않아 음성 입력을 껐습니다. 브라우저의 사이트 설정에서 마이크를 허용하고 페이지를 새로 열면 다시 쓸 수 있습니다. 지금은 글로 입력해 주세요.',
    blocks: true,
  },
  'no-microphone': { message: '마이크를 찾지 못해 음성 입력을 껐습니다. 글로 입력해 주세요.', blocks: true },
  'service-blocked': { message: '이 브라우저에서는 음성 인식을 쓸 수 없어 음성 입력을 껐습니다. 글로 입력해 주세요.', blocks: true },
  'unsupported-language': {
    message: '이 브라우저의 음성 인식이 한국어를 지원하지 않아 음성 입력을 껐습니다. 글로 입력해 주세요.',
    blocks: true,
  },
};

/** 인식기의 오류 코드가 뜻하는 문제. 여기 없는 코드는 'failed'다. */
const PROBLEM_OF_ERROR = new Map<string, ListenProblem>([
  ['no-speech', 'no-speech'],
  ['audio-capture', 'no-microphone'],
  ['not-allowed', 'not-allowed'],
  ['service-not-allowed', 'service-blocked'],
  ['network', 'network'],
  ['language-not-supported', 'unsupported-language'],
  // 앱이 abort()를 부를 때는 먼저 이벤트를 끊는다. 그래서 여기까지 오는 aborted는 앱이 부르지 않은 것이다.
  ['aborted', 'interrupted'],
]);

export interface ListenTimings {
  /** 듣기 시작한 뒤 첫 결과를 기다리는 시간. */
  firstResultMs: number;
  /** 들은 글이 이만큼 동안 달라지지 않으면 말이 끝난 것으로 본다. */
  silenceMs: number;
  /** stop()을 부르거나 오류가 난 뒤 end를 기다리는 시간. */
  stopMs: number;
}

/** 써 보며 조정할 값이다. 실측에서 중간 결과는 0.1~0.3초마다 왔고, stop() 뒤의 확정 결과와 end는 바로 왔다. */
export const LISTEN_TIMINGS: ListenTimings = { firstResultMs: 10_000, silenceMs: 2_500, stopMs: 3_000 };

export interface ListenResult {
  /** 들은 글. 오류로 끝나도 그때까지 들은 글이 담긴다. */
  transcript: string;
  problem: ListenProblem | null;
}

export interface ListenSession {
  /** 사용자가 말을 마쳤다. stop()을 불러 확정된 글을 받는다. */
  finish(): void;
  /** 듣기를 버린다. 이 뒤로는 어떤 handler도 부르지 않는다(화면이 사라질 때). */
  cancel(): void;
}

/** 결과 목록 전체에서 글을 다시 모은다. 확정되지 않은 글도 넣어, 확정 없이 끝나면 마지막 중간 글이 남게 한다. */
function textOf(results: RecognitionResults): string {
  const parts: string[] = [];
  for (let index = 0; index < results.length; index++) parts.push(results[index]?.[0]?.transcript ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 한 발화를 듣는다. onDone은 정확히 한 번 부르고, 그 뒤에 오는 이벤트는 무시한다.
 * start()가 예외를 던지면 onDone을 이 함수가 돌아가기 전에 부른다.
 */
export function listenOnce(
  recognizer: RecognizerPort,
  options: { processLocally: boolean; timings?: ListenTimings },
  handlers: { onInterim(text: string): void; onDone(result: ListenResult): void },
): ListenSession {
  const timings = options.timings ?? LISTEN_TIMINGS;
  let phase: 'listening' | 'stopping' | 'done' = 'listening';
  let heard = '';
  let failure: ListenProblem | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** 시간 제한은 한 번에 하나만 건다. */
  function after(ms: number, run: () => void): void {
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  }

  function abortQuietly(): void {
    try {
      recognizer.abort();
    } catch {
      // 이미 끝난 인식기다.
    }
  }

  /** 끝난 것으로 적고 이벤트를 끊는다. 이미 끝났으면 false. */
  function close(): boolean {
    if (phase === 'done') return false;
    phase = 'done';
    clearTimeout(timer);
    recognizer.onstart = null;
    recognizer.onresult = null;
    recognizer.onerror = null;
    recognizer.onend = null;
    return true;
  }

  function report(): void {
    // 들은 글이 있으면 '말소리 없음'은 맞지 않고, 글도 오류도 없이 끝났으면 말소리가 없었던 것이다.
    const problem = heard ? (failure === 'no-speech' ? null : failure) : (failure ?? 'no-speech');
    handlers.onDone({ transcript: heard, problem });
  }

  function settle(): void {
    if (close()) report();
  }

  /** end가 오지 않았다. 인식기를 끊고 지금까지 들은 글로 끝낸다. */
  function giveUp(): void {
    if (!close()) return;
    abortQuietly();
    report();
  }

  function requestStop(): void {
    if (phase !== 'listening') return;
    phase = 'stopping';
    after(timings.stopMs, giveUp);
    try {
      recognizer.stop();
    } catch {
      settle();
    }
  }

  recognizer.lang = 'ko-KR';
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 1;
  if (options.processLocally) recognizer.processLocally = true;

  recognizer.onstart = () => {
    // 인식기가 실제로 듣기 시작한 때부터 다시 잰다. 마이크 허락 창에 답하느라 늦어진 시간을 빼려는 것이다
    // (허락 창이 떠 있는 동안 start 이벤트가 미뤄지는지는 이 환경에서 확인하지 못했다).
    if (phase === 'listening' && heard === '') after(timings.firstResultMs, requestStop);
  };
  recognizer.onresult = (event) => {
    if (phase === 'done') return;
    const text = textOf(event.results);
    // 글이 그대로면 새로 들은 것이 없다. 빈 첫 결과와 같은 글이 되풀이해 오는 결과는 조용함을 미루지 않는다.
    if (text === heard) return;
    heard = text;
    handlers.onInterim(text);
    // stop()을 부른 뒤의 결과(확정된 글)는 받되, 조용함을 다시 재지 않는다.
    if (phase === 'listening') after(timings.silenceMs, requestStop);
  };
  recognizer.onerror = (event) => {
    if (phase === 'done') return;
    failure ??= PROBLEM_OF_ERROR.get(event.error) ?? 'failed';
    // 오류 뒤에는 end가 온다. 오지 않는 경우에 대비해 stop() 뒤와 같은 시간만 기다린다.
    phase = 'stopping';
    after(timings.stopMs, giveUp);
  };
  recognizer.onend = settle;

  after(timings.firstResultMs, requestStop);
  try {
    recognizer.start();
  } catch {
    failure = 'failed';
    settle();
  }

  return {
    finish: requestStop,
    cancel() {
      if (close()) abortQuietly();
    },
  };
}

/** 말소리를 글로 바꾸는 곳. 'device'는 기기 안(확인됨). 'unknown'은 브라우저가 정하며 회사 서버로 갈 수 있다. */
export type RecognitionPlace = 'device' | 'unknown';

/** 말소리가 어디서 글로 바뀌는지 화면에 알리는 말. */
export const PLACE_NOTICES: Record<RecognitionPlace, string> = {
  device: '말소리는 이 기기 안에서 글로 바뀝니다.',
  unknown: '말소리는 브라우저가 정한 방식으로 글로 바뀝니다. 브라우저 회사의 서버로 갈 수 있습니다.',
};

export interface OnDeviceOptions {
  langs: string[];
  processLocally: boolean;
}

/** 기기 안 인식을 묻고 준비시키는 SpeechRecognition의 정적 함수 둘. 없는 브라우저가 있다. */
export interface OnDevicePort {
  available(options: OnDeviceOptions): Promise<string>;
  install(options: OnDeviceOptions): Promise<boolean>;
}

/**
 * 한국어 기기 안 인식을 준비한다. 사용자의 누름(제스처) 안에서 불러야 한다.
 * install을 먼저, 다른 것을 기다리지 않고 부른다. 제스처 없이 부르면 내려받기가 거절된다(실측).
 */
export async function prepareRecognition(api: OnDevicePort | null): Promise<RecognitionPlace> {
  if (!api) return 'unknown';
  const korean: OnDeviceOptions = { langs: ['ko-KR'], processLocally: true };
  try {
    if (!(await api.install(korean))) return 'unknown';
    return (await api.available(korean)) === 'available' ? 'device' : 'unknown';
  } catch {
    return 'unknown';
  }
}
