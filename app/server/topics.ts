// 주제 목록을 판정 실험의 질문과 입장 카드에서 만든다. 파일을 읽으므로 Node에서만 쓴다.
// 서비스용 주제 카드의 형식은 아직 정하지 않았다. 정하기 전까지는 판정 실험의 질문을 그대로 쓴다.

import { loadCards, loadQuestions } from '../../eval/src/data.ts';
import type { Topic } from './games.ts';

export function loadTopics(): Map<string, Topic> {
  const cards = loadCards();
  const topics = new Map<string, Topic>();
  for (const question of loadQuestions(cards)) {
    const card = cards.get(question.cardId);
    if (!card) throw new Error(`질문 ${question.id}의 입장 카드가 없습니다.`);
    topics.set(question.id, { question, card });
  }
  return topics;
}
