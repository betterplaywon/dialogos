// 서버가 쓰는 모델의 출처. 지금은 모의 모델만 있다.
// 실제 모델은 사용량을 세는 모델과 역할별 단가로 붙인다(budget.ts의 ModelSource). 붙이는 때는 사용자가 정한다.

import { createMockModel } from '../../eval/src/providers/mock.ts';
import type { ModelSource } from './budget.ts';

/** 모의 모델. 돈이 들지 않아 원장에 남기지 않지만, 하루 턴 수에는 든다. */
export function mockSource(): ModelSource {
  return { provider: 'mock', create: (role) => createMockModel(role) };
}
