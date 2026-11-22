// 음성 상태를 React에 잇는다. 상태와 동작은 voice-control.ts에 있고, 여기서는 실제 브라우저 객체를 넘기고 구독만 한다.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { browserPackMark, browserRecognition, browserSpeech, browserVoiceMemory } from './browser-voice.ts';
import { createVoiceControl, type VoiceControl, type VoiceState } from './voice-control.ts';

export interface Voice {
  state: VoiceState;
  /** 렌더마다 같은 객체다. 오래된 렌더가 잡고 있어도 최신 상태로 움직인다. */
  control: VoiceControl;
}

/** 화면 전체에서 한 번만 쓴다(App). 판을 바꿔도 음성은 켜진 채로 남고, 페이지를 새로 열면 꺼져 있다. */
export function useVoice(): Voice {
  const [control] = useState<VoiceControl>(() =>
    createVoiceControl({ recognition: browserRecognition(), speech: browserSpeech(), memory: browserVoiceMemory(), packMark: browserPackMark() }),
  );
  const state = useSyncExternalStore(control.subscribe, control.getState);

  useEffect(() => {
    // React의 정리 함수는 페이지를 닫거나 새로 열 때 불리지 않는다. 그때도 듣기와 읽기를 끊는다.
    window.addEventListener('pagehide', control.turnOff);
    return () => {
      window.removeEventListener('pagehide', control.turnOff);
      control.turnOff();
    };
  }, [control]);

  return { state, control };
}
