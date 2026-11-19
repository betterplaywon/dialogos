// 서버가 쓰는 모델. 지금은 모의 모델만 있다.
// 실제 모델은 서버가 지키는 비용 상한과 함께, 사용자가 정한 때에 붙인다.

import type { DialogueModels } from '../../eval/src/dialogue.ts';
import { createMockModel } from '../../eval/src/providers/mock.ts';

export function mockModels(): DialogueModels {
  return { opponent: createMockModel('opponent'), judge: createMockModel('judge') };
}
