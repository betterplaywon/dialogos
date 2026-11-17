// 입장 카드와 질문 파일을 읽고 모양을 검사한다.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Card, Question } from './types.ts';

export const EVAL_DIR = fileURLToPath(new URL('..', import.meta.url));

function readJsonDir<T>(dir: string): T[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T);
}

export function loadCards(dir = join(EVAL_DIR, 'cards')): Map<string, Card> {
  return new Map(readJsonDir<Card>(dir).map((card) => [card.id, card]));
}

export function validateQuestion(question: Question, cards: Map<string, Card>): string[] {
  const problems: string[] = [];
  if (!cards.has(question.cardId)) problems.push(`입장 카드 '${question.cardId}'가 없습니다.`);
  const ids = question.premises.map((p) => p.id);
  if (new Set(ids).size !== ids.length) problems.push('전제의 id가 겹칩니다.');
  if (question.premises.length < 1) problems.push('전제가 없습니다.');
  for (const rebuttal of question.rebuttals) {
    if (!ids.includes(rebuttal.premiseId)) problems.push(`반론이 없는 전제 '${rebuttal.premiseId}'를 겨냥합니다.`);
  }
  const targeted = question.rebuttals.map((r) => r.premiseId);
  if (new Set(targeted).size !== targeted.length) problems.push('같은 전제를 겨냥한 반론이 둘 이상입니다.');
  for (const field of ['text', 'userStance', 'opponentStance'] as const) {
    if (!question[field]?.trim()) problems.push(`'${field}'가 비어 있습니다.`);
  }
  return problems;
}

export function loadQuestions(cards: Map<string, Card>, dir = join(EVAL_DIR, 'questions')): Question[] {
  const questions = readJsonDir<Question>(dir);
  for (const question of questions) {
    const problems = validateQuestion(question, cards);
    if (problems.length > 0) throw new Error(`질문 ${question.id}: ${problems.join(' ')}`);
  }
  return questions;
}
