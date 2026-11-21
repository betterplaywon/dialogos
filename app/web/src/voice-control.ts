// 음성으로 하는 한 판의 상태를 한곳에 묶는다: 켜고 끄기, 기기 안 인식 준비, 한 발화 듣기, 상대의 말 읽기.
// 브라우저 객체는 포트로 받아, 켜는 누름 안에서 일어나는 일의 차례까지 화면 밖에서 검사한다.
// React에는 use-voice.ts가, 실제 브라우저 객체에는 browser-voice.ts가 잇는다.

import {
  LISTEN_PROBLEMS,
  listenOnce,
  prepareRecognition,
  type ListenProblem,
  type ListenResult,
  type ListenSession,
  type OnDevicePort,
  type RecognitionPlace,
  type RecognizerPort,
} from './listen.ts';
import { chooseVoice, createSpeaker, koreanVoices, styleOf, type SpeakProblem, type SynthPort, type VoiceLike } from './speak.ts';

/** 브라우저의 음성 인식. */
export interface RecognitionPort {
  /** 발화마다 새 인식기를 만든다. */
  create(): RecognizerPort;
  /** 기기 안 인식을 묻고 준비시키는 API. 없는 브라우저는 null이다. */
  onDevice: OnDevicePort | null;
}

/** 브라우저의 음성 합성. */
export interface SpeechPort<V extends VoiceLike> {
  synth: SynthPort<V>;
  /**
   * 목소리 목록을 지금 한 번, 그리고 바뀔 때마다 알린다. settled는 목록이 다 왔다는 뜻이다.
   * 돌려준 함수를 부르면 그만 알린다.
   */
  watchVoices(onChange: (voices: readonly V[], settled: boolean) => void): () => void;
  /** 소리 없는 첫 읽기. 사용자의 누름 안에서 불러, 그 뒤의 읽기가 막히지 않게 한다. */
  prime(): void;
}

/** 고른 목소리의 이름을 기억하는 곳. */
export interface VoiceMemory {
  load(): string | null;
  save(name: string): void;
}

export interface VoicePorts<V extends VoiceLike> {
  recognition: RecognitionPort | null;
  speech: SpeechPort<V> | null;
  memory: VoiceMemory;
}

/** 읽어 달라는 요청. */
export interface ReadRequest {
  /** 화면이 어느 말을 읽는 중인지 가리는 이름. */
  key: string;
  text: string;
  /** 상대 캐릭터(입장 카드의 id). 속도와 높낮이를 정한다. */
  characterId: string | undefined;
}

export interface VoiceState<V extends VoiceLike = VoiceLike> {
  /** 이 브라우저에 음성 인식이 있는가. */
  canListen: boolean;
  /** 이 브라우저에 음성 합성이 있는가. */
  canSpeak: boolean;
  on: boolean;
  /** 말소리를 글로 바꾸는 곳. 'preparing'은 기기 안 인식을 준비하는 중이다. 꺼져 있거나 음성 인식이 없으면 null이다. */
  place: RecognitionPlace | 'preparing' | null;
  /** 음성 입력을 끄게 한 문제. 한번 생기면 페이지를 새로 열 때까지 남는다. */
  blocked: ListenProblem | null;
  listening: boolean;
  /** 듣는 동안 지금까지 들은 글. */
  interim: string;
  /** 한국어 목소리, 좋은 것부터. */
  voices: readonly V[];
  /** 지금 쓰는 목소리. 'wait'는 목록을 기다리는 중이고, null은 읽을 한국어 목소리가 없다는 뜻이다. */
  voice: V | 'wait' | null;
  /** 읽는 중이거나 목소리를 기다리는 요청의 key. */
  reading: string | null;
  speakProblem: SpeakProblem | null;
}

export interface VoiceControl<V extends VoiceLike = VoiceLike> {
  getState(): VoiceState<V>;
  /** 상태가 바뀔 때마다 listener를 부른다. 돌려준 함수를 부르면 그만 부른다. */
  subscribe(listener: () => void): () => void;
  /** 음성을 켠다. 사용자의 누름 안에서 부른다. first는 켜자마자 읽을 말이다. */
  turnOn(first: ReadRequest | null): void;
  /** 듣기와 읽기를 멈추고 음성을 끈다. */
  turnOff(): void;
  /** 읽던 것을 끊고 한 발화를 듣는다. 다 들으면 onHeard를 한 번 부른다. 들을 수 없는 때에는 아무것도 하지 않는다. */
  listen(onHeard: (result: ListenResult) => void): void;
  /** 사용자가 말을 마쳤다. 확정된 글을 받아 onHeard로 넘긴다. */
  finishListening(): void;
  /** 듣기를 버린다. onHeard를 부르지 않는다. */
  cancelListening(): void;
  /** 읽던 것을 끊고 이 말을 읽는다. 목소리가 아직 정해지지 않았으면 정해질 때 읽는다. */
  read(request: ReadRequest): void;
  stopReading(): void;
  /** 읽을 목소리를 고른다. 읽는 중이면 새 목소리로 처음부터 다시 읽는다. */
  preferVoice(name: string): void;
}

export function createVoiceControl<V extends VoiceLike>(ports: VoicePorts<V>): VoiceControl<V> {
  const { recognition, speech, memory } = ports;
  const speaker = speech ? createSpeaker(speech.synth) : null;
  const listeners = new Set<() => void>();
  let state: VoiceState<V> = {
    canListen: recognition !== null,
    canSpeak: speech !== null,
    on: false,
    place: null,
    blocked: null,
    listening: false,
    interim: '',
    voices: [],
    voice: speech ? 'wait' : null,
    reading: null,
    speakProblem: null,
  };
  let allVoices: readonly V[] = [];
  let settled = false;
  let preferred = memory.load();
  let unwatch: (() => void) | null = null;
  let session: ListenSession | null = null;
  /** 읽는 중이거나 목소리를 기다리는 요청. 기다리는 요청은 가장 최근 것 하나만 남는다. */
  let current: ReadRequest | null = null;
  let awaitingVoice = false;
  /** 기기 안 인식이 한 번 확인되면 다시 켤 때 준비를 되풀이하지 않는다. */
  let onDeviceReady = false;
  /** 켤 때마다 올린다. 끈 뒤에 끝난 준비가 상태를 바꾸지 못하게 한다. */
  let prepareRun = 0;

  function set(patch: Partial<VoiceState<V>>): void {
    const keys = Object.keys(patch) as (keyof VoiceState<V>)[];
    if (keys.every((key) => Object.is(state[key], patch[key]))) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  }

  const voiceNow = (): V | 'wait' | null => (speech ? chooseVoice(allVoices, preferred, settled) : null);

  function say(request: ReadRequest, voice: V): void {
    if (!speaker) return;
    // 읽을 조각이 없으면 say가 돌아가기 전에 끝났다고 알려 온다. 그래서 상태를 먼저 적는다.
    current = request;
    awaitingVoice = false;
    set({ reading: request.key, speakProblem: null });
    speaker.say(request.text, voice, styleOf(request.characterId), (problem) => {
      current = null;
      set({ reading: null, speakProblem: problem });
    });
  }

  function read(request: ReadRequest): void {
    // 듣는 동안에는 읽지 않는다. 읽는 소리가 마이크로 들어간다.
    if (!state.on || !speaker || state.listening) return;
    const voice = voiceNow();
    if (voice === null) return;
    if (voice !== 'wait') {
      say(request, voice);
      return;
    }
    // 읽던 것이 있을 때만 끊는다. 켜는 누름 안에서 넣은 소리 없는 첫 읽기까지 끊지 않으려는 것이다.
    if (current && !awaitingVoice) speaker.stop();
    current = request;
    awaitingVoice = true;
    set({ reading: request.key, speakProblem: null });
  }

  function stopReading(): void {
    // 꺼져 있을 때는 읽는 것이 없다. 음성을 켜지 않은 사람의 브라우저에서 음성 합성을 건드리지 않는다.
    if (!state.on) return;
    current = null;
    awaitingVoice = false;
    speaker?.stop();
    set({ reading: null });
  }

  function onVoices(voices: readonly V[], isSettled: boolean): void {
    allVoices = voices;
    settled = isSettled;
    const voice = voiceNow();
    set({ voices: koreanVoices(voices), voice });
    if (!awaitingVoice || !current || voice === 'wait') return;
    if (voice === null) stopReading();
    else say(current, voice);
  }

  function cancelListening(): void {
    session?.cancel();
    session = null;
    set({ listening: false, interim: '' });
  }

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    turnOn(first) {
      if (state.on || (!recognition && !speech)) return;
      set({ on: true, speakProblem: null });
      // 아래는 모두 이 누름(사용자 제스처) 안에서, 무엇도 기다리지 않고 차례로 시작한다.
      if (speech) {
        speech.prime();
        unwatch = speech.watchVoices(onVoices);
        if (first) read(first);
      }
      // 음성 입력이 이 페이지에서 꺼졌으면(blocked) 인식 팩을 준비할 까닭이 없다.
      if (!recognition || state.blocked !== null) return;
      if (onDeviceReady) {
        set({ place: 'device' });
        return;
      }
      set({ place: 'preparing' });
      prepareRun += 1;
      const run = prepareRun;
      // 읽기는 이 준비를 기다리지 않는다. 준비가 끝날 때까지는 말하기만 막힌다.
      void prepareRecognition(recognition.onDevice).then((place) => {
        if (place === 'device') onDeviceReady = true;
        if (run === prepareRun && state.on) set({ place });
      });
    },

    turnOff() {
      if (!state.on) return;
      prepareRun += 1;
      session?.cancel();
      session = null;
      current = null;
      awaitingVoice = false;
      speaker?.stop();
      unwatch?.();
      unwatch = null;
      set({ on: false, place: null, listening: false, interim: '', reading: null, speakProblem: null });
    },

    listen(onHeard) {
      if (!state.on || !recognition || state.blocked !== null || state.listening) return;
      if (state.place !== 'device' && state.place !== 'unknown') return;
      stopReading();
      const recognizer = recognition.create();
      // start()가 예외를 던지면 listenOnce가 돌아가기 전에 끝났다고 알려 온다. 그래서 상태를 먼저 적는다.
      set({ listening: true, interim: '' });
      const started = listenOnce(
        recognizer,
        { processLocally: state.place === 'device' },
        {
          onInterim: (text) => set({ interim: text }),
          onDone: (result) => {
            session = null;
            const blocks = result.problem !== null && LISTEN_PROBLEMS[result.problem].blocks;
            set({ listening: false, interim: '', ...(blocks ? { blocked: result.problem } : {}) });
            onHeard(result);
          },
        },
      );
      if (state.listening) session = started;
    },

    finishListening() {
      session?.finish();
    },

    cancelListening,
    read,
    stopReading,

    preferVoice(name) {
      preferred = name;
      memory.save(name);
      const voice = voiceNow();
      set({ voice });
      // 읽는 중이면 고른 목소리로 처음부터 다시 읽어, 바로 들어 볼 수 있게 한다.
      if (current && voice !== 'wait' && voice !== null) say(current, voice);
    },
  };
}
