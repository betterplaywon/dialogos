// 실제 브라우저의 음성 인식과 음성 합성을 voice-control.ts의 포트에 잇는다. DOM의 음성 타입은 이 파일에만 둔다.
// 검사는 이 파일을 불러오지 않는다(app/tests에는 DOM 타입이 없다). 판단은 포트 뒤의 listen.ts, speak.ts, voice-control.ts에 있고,
// 여기에는 브라우저 객체를 만들고 이벤트를 넘기는 일만 둔다. 이 앱은 소리를 직접 녹음하거나 서버로 보내지 않는다.

import type { OnDevicePort, RecognizerPort } from './listen.ts';
import type { PackMark, RecognitionPort, SpeechPort, VoiceMemory } from './voice-control.ts';

/**
 * 이 저장소의 DOM 타입에는 SpeechRecognition 생성자가 없어, 쓰는 만큼만 적는다.
 * available과 install은 기기 안 인식을 묻고 준비시키는 정적 함수다(Chrome 157에서 확인). 없는 브라우저가 있다.
 */
type RecognitionConstructor = (new () => RecognizerPort) & Partial<OnDevicePort>;

export function browserRecognition(): RecognitionPort | null {
  const scope = window as unknown as {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  };
  const Recognition = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Recognition) return null;
  const available = Recognition.available?.bind(Recognition);
  const install = Recognition.install?.bind(Recognition);
  return {
    create: () => new Recognition(),
    onDevice: available && install ? { available, install } : null,
  };
}

/**
 * 목소리 목록의 마지막 변경 뒤 이만큼 조용하면 다 온 것으로 본다. 목록이 다 왔다는 신호가 없어서 두는 추정이다.
 * 실측에서 두 변경의 간격은 약 1.1초였다. 이 값은 '찾는 중'과 '없음' 가운데 화면에 보일 말을 가를 뿐이고,
 * 읽을 글을 어디로 보낼지는 정하지 않는다(원격 목소리는 사용자가 고를 때만 쓴다).
 */
const VOICES_SETTLE_MS = 2_500;

export function browserSpeech(): SpeechPort<SpeechSynthesisVoice> | null {
  if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) return null;
  const engine = window.speechSynthesis;
  /** 읽는 동안 utterance가 쓰레기 수집되면 end와 error 이벤트를 잃는다. 끝날 때까지 여기에 잡아 둔다. */
  const alive = new Set<SpeechSynthesisUtterance>();
  /** 다 왔다고 본 목록의 목소리 수. 아직 그렇게 본 적이 없으면 null이다. */
  let settledCount: number | null = null;
  return {
    synth: {
      speak(chunk, { onStart, onDone }) {
        const utterance = new SpeechSynthesisUtterance(chunk.text);
        utterance.lang = 'ko-KR';
        // voice를 비워 두면 브라우저가 목소리를 고른다. 목록에는 원격 목소리가 기기 목소리보다 약 1.1초 먼저 오므로(실측),
        // 그때 고른 것은 원격 목소리일 수 있고 그러면 글이 서버로 간다(추정). 그래서 고른 목소리를 항상 넣는다.
        utterance.voice = chunk.voice;
        utterance.rate = chunk.rate;
        utterance.pitch = chunk.pitch;
        utterance.onstart = () => onStart();
        utterance.onend = () => {
          alive.delete(utterance);
          onDone('end');
        };
        utterance.onerror = (event) => {
          alive.delete(utterance);
          onDone(event.error);
        };
        alive.add(utterance);
        engine.speak(utterance);
      },
      cancel() {
        // 대기 중이던 utterance는 cancel해도 이벤트가 오지 않는다(실측). 기다리지 않고 여기서 놓아 준다.
        alive.clear();
        engine.cancel();
      },
    },

    watchVoices(onChange) {
      let timer: number | undefined;
      // 목록은 처음에 비어 있고 여러 번에 걸쳐 온다(실측: 원격 목소리가 먼저, 기기 목소리는 약 1.1초 뒤).
      const report = () => {
        window.clearTimeout(timer);
        const voices = engine.getVoices();
        // 다 왔다고 본 목록이 그대로면 다시 기다리지 않는다(껐다 켤 때).
        if (settledCount === voices.length) {
          onChange(voices, true);
          return;
        }
        settledCount = null;
        onChange(voices, false);
        timer = window.setTimeout(() => {
          const settled = engine.getVoices();
          settledCount = settled.length;
          onChange(settled, true);
        }, VOICES_SETTLE_MS);
      };
      engine.addEventListener('voiceschanged', report);
      report();
      return () => {
        window.clearTimeout(timer);
        engine.removeEventListener('voiceschanged', report);
      };
    },

    prime() {
      // Safari와 iOS는 첫 speak()가 사용자의 누름 안에 있어야 한다고 알려져 있다(이 환경에서 확인하지 못했다).
      // 그래서 켜는 누름 안에서 빈 글을 소리 크기 0으로 한 번 읽어 둔다.
      // Chrome 157은 누름이 한 번도 없으면 speak()를 not-allowed로 막고, 페이지를 한 번 누른 뒤로는 누름 밖의 읽기도
      // 막지 않았다(실측). 목록이 오기 전에 넣은 이 빈 글은 기기 목소리가 올 때까지 대기했다가 바로 끝났다(실측).
      const utterance = new SpeechSynthesisUtterance('');
      utterance.lang = 'ko-KR';
      utterance.volume = 0;
      // 보낼 글은 없지만, 이미 아는 기기 목소리가 있으면 그것으로 정해 원격 목소리를 거치지 않게 한다.
      const local = engine.getVoices().find((voice) => voice.localService);
      if (local) utterance.voice = local;
      engine.speak(utterance);
    },
  };
}

const VOICE_NAME_KEY = 'dialogos.voice';

/** 고른 목소리의 이름을 이 브라우저에 남기고, 고른 것을 거두면 지운다. 저장소를 쓸 수 없어도 화면은 그대로 돈다. */
export function browserVoiceMemory(): VoiceMemory {
  return {
    load() {
      try {
        return window.localStorage.getItem(VOICE_NAME_KEY);
      } catch {
        return null;
      }
    },
    save(name) {
      try {
        if (name === null) window.localStorage.removeItem(VOICE_NAME_KEY);
        else window.localStorage.setItem(VOICE_NAME_KEY, name);
      } catch {
        // 남기거나 지우지 못해도 이 페이지에서는 고른 대로 읽는다.
      }
    },
  };
}

const PACK_PENDING_KEY = 'dialogos.pack-pending';

/**
 * '인식 팩을 내려받은 뒤 아직 말소리가 글로 바뀐 적이 없다'는 표시를 이 브라우저에 남긴다. 값은 표시 하나뿐이다.
 * 브라우저를 다시 열어도 남아야 해서 localStorage에 둔다. 저장소를 쓸 수 없어도 화면은 그대로 돈다.
 */
export function browserPackMark(): PackMark {
  return {
    load() {
      try {
        return window.localStorage.getItem(PACK_PENDING_KEY) !== null;
      } catch {
        return false;
      }
    },
    save(pending) {
      try {
        if (pending) window.localStorage.setItem(PACK_PENDING_KEY, '1');
        else window.localStorage.removeItem(PACK_PENDING_KEY);
      } catch {
        // 남기거나 지우지 못해도 이 페이지에서는 voice-control.ts가 기억한다.
      }
    },
  };
}
