// 주제 목록을 만든다. 파일을 읽으므로 Node에서만 쓴다.
// 서비스용 주제 카드(app/topics/*.json)는 질문 하나에 두 입장을 두고, 입장마다 그 입장을 미는 캐릭터와 전제를 미리 쓴다.
// 판정 실험의 질문을 쓰는 카드는 그 질문 쪽을 질문 파일에서 그대로 가져와, 그 쪽의 판은 잰 판과 같다.
// 카드가 아직 없는 판정 실험 질문은 질문의 사용자 입장만 지킬 수 있는 주제로 보인다. 형식은 app/topics/README.md에 있다.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCards, loadQuestions, validateQuestion } from '../../eval/src/data.ts';
import type { Card, Premise, Question, ValidRebuttal } from '../../eval/src/types.ts';
import type { Matchup, Topic, TopicSide } from './games.ts';

export const TOPICS_DIR = fileURLToPath(new URL('../topics', import.meta.url));

/** 카드 파일의 한 쪽: 이 입장, 이 입장을 미는 캐릭터와 전제, 반대 입장의 사람이 할 수 있는 타당한 반론. */
export interface SideFile {
  stance: string;
  cardId: string;
  premises: Premise[];
  rebuttals: ValidRebuttal[];
}

/** 판정 실험 질문에서 가져오는 쪽. 그 질문의 상대 입장, 입장 카드, 전제, 반론을 그대로 쓴다. */
export interface EvalSideFile {
  fromEval: string;
}

export interface TopicFile {
  id: string;
  question: string;
  sides: [SideFile, SideFile | EvalSideFile];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const FLAWS: readonly string[] = ['overgeneralization', 'false-dichotomy', 'unsupported-fact', 'self-contradiction'];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** 정한 칸 밖의 칸(오타 등)을 찾는다. */
function unknownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): string[] {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? [`${label}에 모르는 칸이 있습니다: ${extra.join(', ')}.`] : [];
}

/** 사용자가 against의 반대 입장을 지킬 때의 질문. 판정 실험의 질문과 같은 모양으로 만든다. */
function questionAgainst(id: string, text: string, userStance: string, against: SideFile): Question {
  return {
    id,
    cardId: against.cardId,
    text,
    userStance,
    opponentStance: against.stance,
    premises: against.premises,
    rebuttals: against.rebuttals,
  };
}

/** 한 쪽의 모양: 칸, 전제와 반론 하나하나의 칸과 값. 쓰는 규칙(개수, 결함 네 종류, 길이)은 검사가 본다. */
function sideProblems(side: unknown, label: string): string[] {
  if (!isObject(side)) return [`${label}이 객체가 아닙니다.`];
  const problems = unknownKeys(side, ['stance', 'cardId', 'premises', 'rebuttals'], label);
  if (!isText(side['stance'])) problems.push(`${label}의 stance가 비어 있습니다.`);
  if (!isText(side['cardId'])) problems.push(`${label}의 cardId가 비어 있습니다.`);
  const premises = side['premises'];
  if (!Array.isArray(premises)) problems.push(`${label}의 premises가 목록이 아닙니다.`);
  else {
    for (const [index, premise] of premises.entries()) {
      const at = `${label}.premises[${index}]`;
      if (!isObject(premise)) {
        problems.push(`${at}이 객체가 아닙니다.`);
        continue;
      }
      problems.push(...unknownKeys(premise, ['id', 'flaw', 'text'], at));
      if (!isText(premise['id'])) problems.push(`${at}의 id가 비어 있습니다.`);
      if (typeof premise['flaw'] !== 'string' || !FLAWS.includes(premise['flaw'])) problems.push(`${at}의 flaw는 ${FLAWS.join(', ')} 가운데 하나입니다.`);
      if (!isText(premise['text'])) problems.push(`${at}의 text가 비어 있습니다.`);
    }
  }
  const rebuttals = side['rebuttals'];
  if (!Array.isArray(rebuttals)) problems.push(`${label}의 rebuttals가 목록이 아닙니다.`);
  else {
    for (const [index, rebuttal] of rebuttals.entries()) {
      const at = `${label}.rebuttals[${index}]`;
      if (!isObject(rebuttal)) {
        problems.push(`${at}이 객체가 아닙니다.`);
        continue;
      }
      problems.push(...unknownKeys(rebuttal, ['premiseId', 'text', 'why'], at));
      for (const field of ['premiseId', 'text', 'why']) {
        if (!isText(rebuttal[field])) problems.push(`${at}의 ${field}가 비어 있습니다.`);
      }
    }
  }
  return problems;
}

interface BuildContext {
  cards: ReadonlyMap<string, Card>;
  questions: ReadonlyMap<string, Question>;
}

/** 카드 파일 하나를 주제로 만든다. 문제가 있으면 주제 없이 문제 목록만 돌려준다. */
export function buildTopic(file: unknown, context: BuildContext): { topic?: Topic; problems: string[] } {
  if (!isObject(file)) return { problems: ['카드가 객체가 아닙니다.'] };
  const problems = unknownKeys(file, ['id', 'question', 'sides'], '카드');
  const { id, question, sides } = file;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) problems.push('id는 영문 소문자, 숫자, -로만 씁니다.');
  if (!isText(question)) problems.push('question이 비어 있습니다.');
  if (!Array.isArray(sides) || sides.length !== 2) return { problems: [...problems, 'sides는 두 개입니다.'] };
  const [first, second] = sides as unknown[];
  if (isObject(first) && 'fromEval' in first) problems.push('fromEval은 sides[1]에만 둡니다.');
  else problems.push(...sideProblems(first, 'sides[0]'));
  const fromEval = isObject(second) && 'fromEval' in second ? second['fromEval'] : undefined;
  if (fromEval === undefined) problems.push(...sideProblems(second, 'sides[1]'));
  else if (Object.keys(second as object).length !== 1) problems.push('fromEval 쪽에는 다른 칸을 두지 않습니다.');
  if (problems.length > 0 || typeof id !== 'string' || !isText(question)) return { problems };

  const a = first as SideFile;
  let b: SideFile;
  let evalQuestion: Question | undefined;
  if (fromEval !== undefined) {
    evalQuestion = typeof fromEval === 'string' ? context.questions.get(fromEval) : undefined;
    if (!evalQuestion) return { problems: [`판정 실험 질문 '${String(fromEval)}'이 없습니다.`] };
    if (id !== evalQuestion.id) problems.push(`판정 실험 질문을 쓰는 카드의 id는 그 질문의 id(${evalQuestion.id})와 같아야 합니다.`);
    if (question !== evalQuestion.text) problems.push('question이 판정 실험 질문의 글과 다릅니다.');
    if (a.stance !== evalQuestion.userStance) problems.push('sides[0]의 stance가 판정 실험 질문의 사용자 입장과 다릅니다.');
    b = {
      stance: evalQuestion.opponentStance,
      cardId: evalQuestion.cardId,
      premises: evalQuestion.premises,
      rebuttals: evalQuestion.rebuttals,
    };
  } else {
    if (context.questions.has(id)) problems.push(`id '${id}'는 판정 실험 질문의 id입니다. 그 질문을 쓰려면 sides[1]을 fromEval로 둡니다.`);
    b = second as SideFile;
  }
  if (a.stance.trim() === b.stance.trim()) problems.push('두 입장이 같습니다.');
  if (a.cardId === b.cardId) problems.push('두 입장을 같은 캐릭터가 밉니다. 입장마다 다른 캐릭터를 둡니다.');

  // sides[i]를 지키는 사용자는 반대쪽(sides[1 - i])의 캐릭터와 전제에 맞선다.
  // 판정 실험 질문 쪽은 질문 파일의 질문을 그대로 써서, 잰 판과 같은 판이 되게 한다.
  const keepFirst = evalQuestion ?? questionAgainst(`${id}-0`, question, a.stance, b);
  const keepSecond = questionAgainst(`${id}-1`, question, b.stance, a);
  for (const [index, built] of [keepFirst, keepSecond].entries()) {
    for (const problem of validateQuestion(built, new Map(context.cards))) {
      problems.push(`sides[${1 - index}]: ${problem}`);
    }
  }
  if (problems.length > 0) return { problems };

  const matchup = (built: Question): Matchup => {
    const card = context.cards.get(built.cardId);
    if (!card) throw new Error(`입장 카드 '${built.cardId}'가 없습니다.`);
    return { question: built, card };
  };
  const topicSides: [TopicSide, TopicSide] = [
    { stance: a.stance, matchup: matchup(keepFirst) },
    { stance: b.stance, matchup: matchup(keepSecond) },
  ];
  return { topic: { id, question, sides: topicSides }, problems: [] };
}

/** 카드가 없는 판정 실험 질문: 질문의 사용자 입장(sides[0])만 지킬 수 있다. */
function evalOnlyTopic(question: Question, cards: ReadonlyMap<string, Card>): Topic {
  const card = cards.get(question.cardId);
  if (!card) throw new Error(`질문 ${question.id}의 입장 카드가 없습니다.`);
  return {
    id: question.id,
    question: question.text,
    sides: [{ stance: question.userStance, matchup: { question, card } }, { stance: question.opponentStance }],
  };
}

function readTopicFiles(dir: string): { name: string; data: unknown }[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.sort().map((name) => {
    try {
      return { name, data: JSON.parse(readFileSync(join(dir, name), 'utf8')) as unknown };
    } catch (error) {
      throw new Error(`주제 카드 ${name}을 읽지 못했습니다: ${(error as Error).message}`);
    }
  });
}

export interface LoadTopicsOptions {
  /** 주제 카드 폴더. 검사에서 바꾼다. */
  dir?: string;
}

/** 주제 카드와 판정 실험 질문으로 주제 목록을 만든다. 카드에 문제가 있으면 모두 모아 한 번에 알린다. */
export function loadTopics(options: LoadTopicsOptions = {}): Map<string, Topic> {
  const cards = loadCards();
  const questions = new Map(loadQuestions(cards).map((question) => [question.id, question]));
  const topics = new Map<string, Topic>();
  const problems: string[] = [];
  for (const { name, data } of readTopicFiles(options.dir ?? TOPICS_DIR)) {
    const built = buildTopic(data, { cards, questions });
    if (!built.topic) {
      problems.push(`${name}: ${built.problems.join(' ')}`);
    } else if (topics.has(built.topic.id)) {
      problems.push(`${name}: id '${built.topic.id}'가 다른 카드와 겹칩니다.`);
    } else {
      topics.set(built.topic.id, built.topic);
    }
  }
  if (problems.length > 0) throw new Error(`주제 카드에 문제가 있습니다.\n${problems.join('\n')}`);
  for (const question of questions.values()) {
    if (!topics.has(question.id)) topics.set(question.id, evalOnlyTopic(question, cards));
  }
  return new Map([...topics].sort(([a], [b]) => a.localeCompare(b)));
}
