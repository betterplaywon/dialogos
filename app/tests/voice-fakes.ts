// 음성 검사가 함께 쓰는 가짜 브라우저 객체. 실제 인식기와 합성기가 내는 이벤트를 검사가 손으로 낸다.
// 이벤트의 차례와 목소리 목록은 Chrome 157에서 잰 것을 따른다(app/README.md의 '음성' 절).

import type { OnDevicePort, RecognizerPort } from '../web/src/listen.ts';
import type { ChunkEvents, SpeechChunk, SynthPort, VoiceLike } from '../web/src/speak.ts';
import type { RecognitionPort, SpeechPort } from '../web/src/voice-control.ts';

export class FakeRecognizer implements RecognizerPort {
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  /** 앱이 넣기 전에는 속성 자체가 없다(이 속성이 없는 브라우저를 흉내 낸다). */
  declare processLocally?: boolean;
  onstart: RecognizerPort['onstart'] = null;
  onresult: RecognizerPort['onresult'] = null;
  onerror: RecognizerPort['onerror'] = null;
  onend: RecognizerPort['onend'] = null;
  /** 앱이 부른 차례대로: 'start', 'stop', 'abort'. */
  readonly calls: string[] = [];
  /** 주면 start()가 이것을 던진다. */
  startError: Error | null = null;

  start(): void {
    this.calls.push('start');
    if (this.startError) throw this.startError;
  }

  stop(): void {
    this.calls.push('stop');
  }

  abort(): void {
    this.calls.push('abort');
  }

  count(call: string): number {
    return this.calls.filter((made) => made === call).length;
  }

  /** start 이벤트를 낸다. */
  started(): void {
    this.onstart?.();
  }

  /** 결과 이벤트를 낸다. 결과 목록 전체를 준다(기기 안 인식은 결과 하나가 점점 길어진다). */
  result(...transcripts: string[]): void {
    this.onresult?.({ results: transcripts.map((transcript) => [{ transcript }]) });
  }

  error(code: string): void {
    this.onerror?.({ error: code });
  }

  end(): void {
    this.onend?.();
  }
}

export type FakeVoice = VoiceLike;

export function voice(name: string, lang = 'ko-KR', localService = true, isDefault = false): FakeVoice {
  return { name, lang, localService, default: isDefault };
}

/** 이 Mac의 Chrome 157이 준 차례 그대로의 한국어 목소리와, 섞여 오는 다른 말의 목소리. */
export const MEASURED_VOICES: readonly FakeVoice[] = [
  voice('Samantha', 'en-US', true, true),
  voice('Eddy (Korean (South Korea))'),
  voice('Flo (Korean (South Korea))'),
  voice('Grandma (Korean (South Korea))'),
  voice('Grandpa (Korean (South Korea))'),
  voice('Reed (Korean (South Korea))'),
  voice('Rocko (Korean (South Korea))'),
  voice('Sandy (Korean (South Korea))'),
  voice('Shelley (Korean (South Korea))'),
  voice('Yuna'),
  voice('Kyoko', 'ja-JP'),
  voice('Google 日本語', 'ja-JP', false),
  voice('Google 한국의', 'ko-KR', false),
];

/** 처음 6ms 뒤에 오는 목록: 원격 목소리뿐이다. */
export const REMOTE_ONLY_VOICES: readonly FakeVoice[] = MEASURED_VOICES.filter((item) => !item.localService);

interface Spoken<V> {
  chunk: SpeechChunk<V>;
  events: ChunkEvents;
  /** 'queued'는 시작을 기다리는 중, 'speaking'은 읽히는 중, 'gone'은 대기열에서 빠진 것(끝났거나 끊겼다)이다. */
  stage: 'queued' | 'speaking' | 'gone';
}

/**
 * 대기열에 들어온 조각을 적어 두는 가짜 합성기. 조각을 시작시키고 끝내는 것은 검사가 한다.
 * Chrome 157에서 잰 결함을 그대로 갖는다: 대기열에 조각이 있는데 읽히는 중인 조각이 없을 때 cancel이 불리면 대기열이 멈춘다.
 * 그 순서가 오면 cancel이 예외를 던져, 이 가짜를 쓰는 어느 검사에서든 드러난다.
 */
export class FakeSynth<V = FakeVoice> implements SynthPort<V> {
  /** 지금까지 들어온 모든 조각(끊긴 것 포함). */
  readonly spoken: Spoken<V>[] = [];
  cancels = 0;
  /** 주면 speak가 조각을 받자마자 이 결과로 끝낸다. */
  failWith: string | null = null;
  /** 주면 조각이 들어올 때마다 'speak'를 적는다(다른 가짜 객체와 차례를 견줄 때 쓴다). */
  log: string[] | null = null;
  /**
   * 검사가 true로 두면 대기열이 이미 멈춘 것이다(넣은 조각이 시작하지 않는다).
   * 멈춘 대기열은 끊어도 더 잃을 것이 없어, 다음 cancel 한 번은 시작 전이어도 받는다.
   */
  stalled = false;

  speak(chunk: SpeechChunk<V>, events: ChunkEvents): void {
    this.spoken.push({ chunk, events, stage: 'queued' });
    this.log?.push('speak');
    if (this.failWith !== null) this.finish(this.spoken.length - 1, this.failWith);
  }

  cancel(): void {
    const queue = this.#queue();
    if (queue.length > 0 && !this.stalled && !queue.some((item) => item.stage === 'speaking')) {
      throw new Error('시작 전의 cancel: 넣은 조각이 읽히기 전에 끊으면 Chrome의 읽기 대기열이 멈춥니다.');
    }
    this.cancels += 1;
    this.stalled = false;
    for (const item of queue) item.stage = 'gone';
  }

  texts(): string[] {
    return this.spoken.map((item) => item.chunk.text);
  }

  /** 지금 대기열에 남아 있는 조각의 글(읽히는 중인 것부터). */
  queue(): string[] {
    return this.#queue().map((item) => item.chunk.text);
  }

  /** index번째로 들어온 조각이 읽히기 시작했다고 알린다. */
  start(index: number): void {
    const item = this.#at(index);
    if (item.stage === 'queued') item.stage = 'speaking';
    item.events.onStart();
  }

  /**
   * index번째로 들어온 조각을 outcome으로 끝낸다.
   * 끝까지 읽힌('end') 조각이 아직 시작 전이면 start를 먼저 낸다(브라우저가 내는 차례). 오류는 시작 없이도 온다.
   */
  finish(index: number, outcome = 'end'): void {
    const item = this.#at(index);
    if (outcome === 'end' && item.stage === 'queued') this.start(index);
    item.stage = 'gone';
    item.events.onDone(outcome);
  }

  #at(index: number): Spoken<V> {
    const item = this.spoken[index];
    if (!item) throw new Error(`${index}번째 조각이 없습니다.`);
    return item;
  }

  #queue(): Spoken<V>[] {
    return this.spoken.filter((item) => item.stage !== 'gone');
  }
}

/** 가짜 음성 합성. 목소리 목록이 언제 무엇으로 오는지는 검사가 정한다. */
export class FakeSpeech implements SpeechPort<FakeVoice> {
  readonly synth = new FakeSynth();
  primes = 0;
  /** 지금 브라우저가 가진 목록. watchVoices가 처음에 이것을 알린다. */
  voices: readonly FakeVoice[];
  readonly log: string[];
  #onChange: ((voices: readonly FakeVoice[], settled: boolean) => void) | null = null;

  constructor(voices: readonly FakeVoice[] = MEASURED_VOICES, log: string[] = []) {
    this.voices = voices;
    this.log = log;
    this.synth.log = log;
  }

  prime(): void {
    this.primes += 1;
    this.log.push('prime');
  }

  watchVoices(onChange: (voices: readonly FakeVoice[], settled: boolean) => void): () => void {
    this.log.push('watch');
    this.#onChange = onChange;
    onChange(this.voices, false);
    return () => {
      this.log.push('unwatch');
      this.#onChange = null;
    };
  }

  get watching(): boolean {
    return this.#onChange !== null;
  }

  /** 목록이 바뀌었다고, 또는 다 왔다고(settled) 알린다. */
  emit(voices: readonly FakeVoice[], settled: boolean): void {
    this.voices = voices;
    this.#onChange?.(voices, settled);
  }
}

/** 가짜 음성 인식. 만든 인식기를 차례대로 적어 둔다. */
export class FakeRecognition implements RecognitionPort {
  readonly created: FakeRecognizer[] = [];
  onDevice: OnDevicePort | null = null;
  /** 주면 다음에 만드는 인식기의 start()가 이것을 던진다. */
  nextStartError: Error | null = null;

  create(): FakeRecognizer {
    const recognizer = new FakeRecognizer();
    recognizer.startError = this.nextStartError;
    this.nextStartError = null;
    this.created.push(recognizer);
    return recognizer;
  }

  /** 가장 최근에 만든 인식기. */
  get last(): FakeRecognizer {
    const recognizer = this.created[this.created.length - 1];
    if (!recognizer) throw new Error('만든 인식기가 없습니다.');
    return recognizer;
  }
}

/** 가짜 기기 안 인식 API. install은 검사가 끝내 줄 때까지 기다린다. */
export function fakeOnDevice(log: string[] = []) {
  let finishInstall: (installed: boolean) => void = () => {};
  const installing = new Promise<boolean>((resolve) => {
    finishInstall = resolve;
  });
  const api: OnDevicePort = {
    install() {
      log.push('install');
      return installing;
    },
    async available() {
      log.push('available');
      return 'available';
    },
  };
  return { api, finishInstall };
}
