// 대화 기록의 답마다 채점기 라벨을 붙여 runs/<실행 이름>/labels.jsonl에 쓴다.
// 끝난 대화부터 바로 덧붙인다. 도중에 멈추면 같은 명령을 다시 실행해 빠진 대화만 이어서 채점한다.
//
// 사용법: npm run eval:label -- --run 이름 --provider mock [--concurrency 2] [--confirm]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadCards, loadQuestions } from './data.ts';
import { labelDialogue, SCORER_ATTEMPTS } from './labeler.ts';
import { addUsage, appendJsonl, createModel, dialogueKey, parseProvider, readJsonl, readMeta, runDir, writeJsonl, writeMeta } from './runio.ts';
import type { Dialogue, LabeledTurn } from './types.ts';
import { argCount, argString, mapLimit, parseArgs } from './util.ts';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const runId = argString(args, 'run');
  if (!runId) throw new Error('--run에 실행 이름을 적어 주세요.');
  const provider = parseProvider(argString(args, 'provider'));
  const concurrency = argCount(args, 'concurrency', 2);

  const dir = runDir(runId);
  const meta = readMeta(dir);
  if (meta?.provider === 'api' && provider === 'mock') {
    throw new Error('실제 모델로 돌린 대화는 모의 채점기로 채점할 수 없습니다. --provider api로 실행하세요.');
  }
  const dialogues = readJsonl<Dialogue>(join(dir, 'transcripts.jsonl'));

  // 앞서 붙인 라벨 가운데 대화 하나가 온전히 끝난 것만 남기고 이어서 붙인다.
  const labelsPath = join(dir, 'labels.jsonl');
  const previous = existsSync(labelsPath) ? readJsonl<LabeledTurn>(labelsPath, true) : [];
  const counts = new Map<string, number>();
  for (const row of previous) counts.set(dialogueKey(row), (counts.get(dialogueKey(row)) ?? 0) + 1);
  const complete = new Set(dialogues.filter((d) => counts.get(dialogueKey(d)) === d.turns.length).map(dialogueKey));
  const kept = previous.filter((row) => complete.has(dialogueKey(row)));
  const todo = dialogues.filter((d) => !complete.has(dialogueKey(d)));
  const calls = todo.reduce((sum, d) => sum + d.turns.length, 0);

  console.log(
    `대화 ${dialogues.length}회 가운데 이번에 채점할 대화 ${todo.length}회, 채점기 호출 ${calls}회 (${provider === 'mock' ? '모의 모델' : '실제 모델'}). 답을 읽지 못한 턴은 다시 불러 최대 ${calls * SCORER_ATTEMPTS}회`,
  );
  if (todo.length === 0) {
    console.log('\n채점할 대화가 없습니다. 다음은 eval:score입니다.');
    return;
  }
  if (provider === 'api' && args.confirm !== true) {
    console.log('\n실제 모델 호출은 비용이 듭니다. 위 계획이 맞으면 --confirm을 붙여 다시 실행하세요.');
    return;
  }

  const questions = new Map(loadQuestions(loadCards()).map((q) => [q.id, q]));
  const scorer = createModel(provider, 'scorer');
  if (meta?.scorer && kept.length > 0 && (meta.scorer.provider !== provider || meta.scorer.model !== scorer.name)) {
    throw new Error('이 실행은 다른 채점기로 일부가 채점되어 있습니다. 채점기를 섞지 않도록 labels.jsonl을 옮겨 두고 처음부터 채점하세요.');
  }
  if (meta) writeMeta(dir, { ...meta, scorer: { provider, model: scorer.name } });
  writeJsonl(labelsPath, kept);

  let finished = 0;
  let stopped = false;
  const failures: string[] = [];
  await mapLimit(todo, concurrency, async (dialogue) => {
    if (stopped) return;
    const name = `${dialogue.questionId} ${dialogue.condition} ${dialogue.rep}번째`;
    try {
      const question = questions.get(dialogue.questionId);
      if (!question) throw new Error(`질문 '${dialogue.questionId}'가 없습니다.`);
      appendJsonl(labelsPath, await labelDialogue(dialogue, question, scorer));
      finished++;
      console.log(`  ${finished}/${todo.length} ${name}`);
    } catch (error) {
      stopped = true;
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const after = readMeta(dir);
  const total = addUsage(after?.usage?.scorer, scorer.usage);
  if (after && total) writeMeta(dir, { ...after, usage: { ...after.usage, scorer: total } });

  console.log(`\n이번에 채점한 대화 ${finished}회. 라벨: runs/${runId}/labels.jsonl`);
  if (scorer.usage && scorer.usage.calls > 0) {
    console.log(`채점기 사용량: 호출 ${scorer.usage.calls}회, 입력 토큰 ${scorer.usage.promptTokens}, 출력 토큰 ${scorer.usage.completionTokens}`);
  }
  if (failures.length > 0) {
    console.error(`\n실패한 대화가 있어 멈췄습니다 (남은 대화 ${todo.length - finished}회).`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('원인을 고친 뒤 같은 명령을 다시 실행하면 빠진 대화만 이어서 채점합니다.');
    process.exitCode = 1;
    return;
  }
  console.log('다음은 eval:score입니다.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
