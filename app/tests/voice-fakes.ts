// 음성 검사가 함께 쓰는 가짜 브라우저 객체. 실제 인식기와 합성기가 내는 이벤트를 검사가 손으로 낸다.
// 이벤트의 차례와 목소리 목록은 Chrome 157에서 잰 것을 따른다(app/README.md의 '음성' 절).

import type { RecognizerPort } from '../web/src/listen.ts';
import type { SpeechChunk, SynthPort, VoiceLike } from '../web/src/speak.ts';

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
  done: (outcome: string) => void;
}

/** 대기열에 들어온 조각을 적어 두는 가짜 합성기. 조각을 끝내는 것은 검사가 한다. */
export class FakeSynth<V = FakeVoice> implements SynthPort<V> {
  /** 지금까지 들어온 모든 조각(끊긴 것 포함). */
  readonly spoken: Spoken<V>[] = [];
  cancels = 0;
  /** 주면 speak가 조각을 받자마자 이 결과로 끝낸다. */
  failWith: string | null = null;

  speak(chunk: SpeechChunk<V>, done: (outcome: string) => void): void {
    this.spoken.push({ chunk, done });
    if (this.failWith !== null) done(this.failWith);
  }

  cancel(): void {
    this.cancels += 1;
  }

  texts(): string[] {
    return this.spoken.map((item) => item.chunk.text);
  }

  /** index번째로 들어온 조각을 outcome으로 끝낸다. */
  finish(index: number, outcome = 'end'): void {
    const item = this.spoken[index];
    if (!item) throw new Error(`${index}번째 조각이 없습니다.`);
    item.done(outcome);
  }
}
