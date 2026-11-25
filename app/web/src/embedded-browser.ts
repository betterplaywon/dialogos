// 앱 안에 들어 있는 브라우저를 가린다. 그런 브라우저에서는 음성 인식과 음성 합성을 만들지 않는다.
//
// 2026-11-23 VS Code 안의 브라우저에서 [음성으로 하기]를 누르자 페이지가 강제로 닫혔다('Render process gone: killed (3)').
// 이 버튼은 기기 안 인식 팩 준비와 음성 합성을 부른다. 함수는 있지만 Electron에는 Chrome의 음성 서비스가 없어,
// 부르는 순간 페이지를 끝낸 것으로 본다(추정). 함수가 있는지로는 가를 수 없어 User-Agent로 가린다.
// Electron 앱은 기본으로 User-Agent에 'Electron/'을 넣는다. 이를 지운 앱과, Electron이 아닌 앱 안 브라우저는 가리지 못한다.

type GatedVoice<R, S> =
  | { embedded: true; recognition: null; speech: null }
  | { embedded: false; recognition: R; speech: S };

/** 앱 안의 브라우저면 만드는 함수를 부르지 않는다. 아니면 둘을 한 번씩 부른다. */
export function gateVoice<R, S>(userAgent: string, make: { recognition: () => R; speech: () => S }): GatedVoice<R, S> {
  if (/\bElectron\//.test(userAgent)) return { embedded: true, recognition: null, speech: null };
  return { embedded: false, recognition: make.recognition(), speech: make.speech() };
}
