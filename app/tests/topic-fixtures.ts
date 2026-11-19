// 검사용 주제 카드. 실제 카드(app/topics/)가 늘거나 바뀌어도 서버 검사가 흔들리지 않게, 임시 폴더에 카드를 써서 불러온다.
// - q01: 판정 실험 질문 q01에 반대쪽(원칙을 지키는 사람)을 더한 카드
// - x01: 판정 실험과 상관없는 새 주제
// 나머지 판정 실험 질문(q02 …)은 카드가 없으므로 질문의 사용자 입장만 지킬 수 있다.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCards, loadQuestions } from '../../eval/src/data.ts';
import type { Topic } from '../server/games.ts';
import { loadTopics, type SideFile, type TopicFile } from '../server/topics.ts';

function side(stance: string, cardId: string, tag: string): SideFile {
  return {
    stance,
    cardId,
    premises: [
      { id: 'P1', flaw: 'overgeneralization', text: `${tag} 검사용 첫째 전제입니다.` },
      { id: 'P2', flaw: 'false-dichotomy', text: `${tag} 검사용 둘째 전제입니다.` },
    ],
    rebuttals: [
      { premiseId: 'P1', text: `${tag} 첫째 전제를 짚는 검사용 반론입니다.`, why: '검사용' },
      { premiseId: 'P2', text: `${tag} 둘째 전제를 짚는 검사용 반론입니다.`, why: '검사용' },
    ],
  };
}

/** 검사용 카드 파일들. 판정 실험 질문의 글을 그대로 가져와 쓴다. */
export function fixtureTopicFiles(): TopicFile[] {
  const q01 = loadQuestions(loadCards()).find((question) => question.id === 'q01');
  if (!q01) throw new Error('판정 실험 질문 q01이 없습니다.');
  return [
    { id: 'q01', question: q01.text, sides: [side(q01.userStance, 'deontologist', 'q01 반대쪽'), { fromEval: 'q01' }] },
    {
      id: 'x01',
      question: '검사용 새 주제입니다. 이렇게 하는 것이 옳습니까?',
      sides: [side('그렇게 해도 됩니다.', 'utilitarian', 'x01 첫째 쪽'), side('그렇게 해서는 안 됩니다.', 'deontologist', 'x01 둘째 쪽')],
    },
  ];
}

/** 카드 파일을 임시 폴더에 써서 불러온다. 다 읽은 뒤 폴더는 지운다. */
export function loadTopicsFrom(files: readonly unknown[]): Map<string, Topic> {
  const dir = mkdtempSync(join(tmpdir(), 'dialogos-topics-'));
  try {
    // 파일 이름 앞에 차례를 붙여, id가 같은 카드도 따로 쓴다.
    for (const [index, file] of files.entries()) {
      const id = (file as { id?: unknown }).id;
      writeFileSync(join(dir, `${String(index).padStart(2, '0')}-${typeof id === 'string' ? id : 'card'}.json`), JSON.stringify(file));
    }
    return loadTopics({ dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const loadFixtureTopics = (): Map<string, Topic> => loadTopicsFrom(fixtureTopicFiles());
