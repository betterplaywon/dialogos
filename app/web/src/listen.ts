// 한 발화를 듣는다. 브라우저의 음성 인식기를 좁은 포트로 받아, 화면 밖에서 가짜 인식기로 검사한다.
// 이 파일은 app/tests가 불러오므로 DOM 전역 타입을 쓰지 않는다. 실제 인식기는 browser-voice.ts가 잇는다.
//
// Chrome 157의 기기 안 인식은 소리 트랙으로 넣은 실측에서 말이 끝나도 스스로 확정하지 않았다(22초를 기다려도 확정 결과와 end가 없었다).
// 실제 마이크에서도 그런지는 확인하지 못했다. 그래서 브라우저가 끝내 주기를 기다리지 않고, 조용해지면 앱이 stop()을 부른다.
// start 뒤로 아무 이벤트도 오지 않은 적도 있어(실측 네 번, 원인 미확인, 뒤에는 재현되지 않음) end가 오지 않는 경우에 대비해 시간 제한을 둔다.
//
// 인식 팩을 내려받은 그 브라우저 세션에서는 기기 안 인식이 되지 않았다(실측, 새 사용자 폴더 다섯 개). 브라우저를 다시 띄운 직후에도 잠시 그런 때가 있었다(길게는 약 20초).
// - 소리 트랙으로 넣은 듣기는 start 없이 0.2초 안에 aborted와 end로 끝났다(한 번은 30초 동안 아무 이벤트도 없었다).
//   listenOnce가 start보다 먼저 온 aborted를 'not-ready'로 가른다.
// - 마이크 경로(가짜 장치)의 듣기는 start를 내고, 결과 없이 no-speech와 end로 끝났다. 이벤트만으로는 말소리가 없던 것과 가를 수 없다.
//   이 경우는 voice-control.ts가 인식 팩을 내려받은 뒤에 남긴 표시(packPending)로 가른다.

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
  | 'not-ready'
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
  'not-ready': {
    message:
      '기기 안 음성 인식이 아직 준비되지 않았습니다. 인식 팩을 내려받은 뒤에는 브라우저를 완전히 종료했다가 다시 열어야 하고, 다시 연 직후에도 잠시 걸립니다. 조금 뒤 [말하기]를 다시 눌러 주세요. 그동안은 글로 입력할 수 있습니다.',
    blocks: false,
  },
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
  // 기기 안 인식이 start보다 먼저 낸 aborted만은 listenOnce가 'not-ready'로 가른다.
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
  let started = false;
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
      // 명세는 끝난 인식기의 abort()를 무시하라고 하지만, Chrome 밖에서는 확인하지 못했다.
      // 여기서 예외가 나가면 끝났다는 알림이 빠져 화면이 듣는 중에 갇힌다.
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
    started = true;
    // 인식기가 실제로 듣기 시작한 때부터 다시 잰다. 마이크 허락 창에 답하느라 늦어진 시간을 빼려는 것이다.
    // 명세는 start를 권한 확인 뒤 듣기 시작할 때 낸다고 한다. 허락 창이 실제로 뜨는 흐름은 이 환경에서 보지 못했다.
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
    // 기기 안 인식이 듣기 시작하기도 전에 끊겼으면, 듣다가 끊긴 것이 아니라 아직 준비되지 않은 것이다(파일 머리의 실측).
    const unready = event.error === 'aborted' && options.processLocally && !started;
    failure ??= unready ? 'not-ready' : (PROBLEM_OF_ERROR.get(event.error) ?? 'failed');
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

/** 말소리를 글로 바꾸는 곳. 'device'는 기기 안(브라우저가 쓸 수 있다고 답했다). 'unknown'은 브라우저가 정하며 회사 서버로 갈 수 있다. */
export type RecognitionPlace = 'device' | 'unknown';

/** 말소리가 어디서 글로 바뀌는지 화면에 알리는 말. */
export const PLACE_NOTICES: Record<RecognitionPlace, string> = {
  device: '말소리는 이 기기 안에서 글로 바뀝니다.',
  unknown: '말소리는 브라우저가 정한 방식으로 글로 바뀝니다. 브라우저 회사의 서버로 갈 수 있습니다.',
};

/**
 * 인식 팩을 내려받은 뒤 아직 말소리가 글로 바뀐 적이 없는 동안, PLACE_NOTICES.device 대신 알리는 말.
 * 그 표시는 브라우저를 다시 연 뒤에도 글이 한 번 올 때까지 남는다. 그래서 이미 다시 연 사람에게도 맞는 말로 둔다.
 */
export const PACK_PENDING_NOTICE =
  '한국어 인식 팩을 내려받았습니다. 브라우저를 완전히 종료했다가 다시 열어야 말로 입력할 수 있습니다(다시 연 직후에도 잠시 걸립니다. 이미 다시 열었다면 [말하기]를 눌러 보세요). 그때까지는 글로 입력해 주세요. 준비되면 말소리는 이 기기 안에서 글로 바뀝니다.';

export interface OnDeviceOptions {
  langs: string[];
  processLocally: boolean;
}

/** 기기 안 인식을 묻고 준비시키는 SpeechRecognition의 정적 함수 둘. 없는 브라우저가 있다. */
export interface OnDevicePort {
  available(options: OnDeviceOptions): Promise<string>;
  install(options: OnDeviceOptions): Promise<boolean>;
}

/** 기기 안 인식을 준비한 결과. downloaded는 이번 준비에서 인식 팩을 내려받았다는 뜻이고, 기기 안 인식을 쓰게 됐을 때만 참이다. */
export type PreparedRecognition = { place: 'device'; downloaded: boolean } | { place: 'unknown'; downloaded: false };

/**
 * install()이 true를 돌려주기까지 이만큼 이상 걸렸으면 인식 팩을 이번에 내려받은 것으로 본다. 걸린 시간으로 가르는 추정이다.
 * 실측에서 인식 팩이 이미 있는 사용자 폴더는 약 2ms 만에 끝났고(두 번), 새 사용자 폴더는 6.1~9.4초가 걸렸다(출력을 남긴 네 번).
 * available()의 답으로는 가를 수 없었다. 인식 팩이 이미 있는 폴더에서도 Chrome을 띄운 지 약 3초 뒤에 물으면 'downloadable'이었다(실측, 두 폴더).
 */
const SLOW_INSTALL_MS = 1_000;

/**
 * 한국어 기기 안 인식을 준비한다. 사용자의 누름(제스처) 안에서 불러야 한다.
 * install을 먼저, 다른 것을 기다리지 않고 부른다. 제스처 없이 부르면 내려받기가 거절된다(실측).
 * now는 흐른 시간을 재는 시계(ms)다. 검사에서 바꾼다.
 */
export async function prepareRecognition(api: OnDevicePort | null, now: () => number = () => performance.now()): Promise<PreparedRecognition> {
  const notOnDevice: PreparedRecognition = { place: 'unknown', downloaded: false };
  if (!api) return notOnDevice;
  const korean: OnDeviceOptions = { langs: ['ko-KR'], processLocally: true };
  try {
    const asked = now();
    if (!(await api.install(korean))) return notOnDevice;
    const downloaded = now() - asked >= SLOW_INSTALL_MS;
    return (await api.available(korean)) === 'available' ? { place: 'device', downloaded } : notOnDevice;
  } catch {
    return notOnDevice;
  }
}
