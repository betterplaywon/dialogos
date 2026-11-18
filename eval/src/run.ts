// 판정 실험의 대화를 돌려 runs/<실행 이름>/transcripts.jsonl에 쓴다.
// 끝난 대화부터 바로 덧붙인다. 도중에 멈추면 같은 명령을 다시 실행해 빠진 대화만 이어서 돌린다.
//
// 사용법: npm run eval:run -- --provider mock [--questions q01,q02] [--conditions plain,prompt,engine]
//                              [--reps 2] [--turns 30] [--run 이름] [--concurrency 2] [--confirm]

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeJudgeChecks, judgeSummary } from './checks.ts';
import { loadCards, loadQuestions } from './data.ts';
import { JUDGE_ATTEMPTS, runDialogue } from './dialogue.ts';
import {
  addUsage,
  appendJsonl,
  createModel,
  defaultRunId,
  dialogueKey,
  parseProvider,
  readJsonl,
  readMeta,
  runDir,
  runPath,
  usageText,
  writeJsonl,
  writeMeta,
  type RunMeta,
} from './runio.ts';
import { DEFAULT_TURNS } from './script.ts';
import { CONDITIONS, type Condition, type Dialogue, type Question } from './types.ts';
import { argCount, argList, argString, mapLimit, median, parseArgs } from './util.ts';

interface Job {
  question: Question;
  condition: Condition;
  rep: number;
}

function selectQuestions(all: Question[], wanted: string[] | undefined): Question[] {
  if (!wanted) return all;
  const unknown = wanted.filter((id) => !all.some((q) => q.id === id));
  if (unknown.length > 0) throw new Error(`없는 질문입니다: ${unknown.join(', ')}`);
  return all.filter((q) => wanted.includes(q.id));
}

function selectConditions(wanted: string[] | undefined): Condition[] {
  if (!wanted) return [...CONDITIONS];
  const unknown = wanted.filter((name) => !CONDITIONS.some((c) => c === name));
  if (unknown.length > 0) throw new Error(`--conditions에는 plain, prompt, engine만 쓸 수 있습니다: ${unknown.join(', ')}`);
  return CONDITIONS.filter((c) => wanted.includes(c));
}

/** 조건별로 한 턴의 답이 나오기까지 걸린 시간의 중앙값(밀리초). */
function latencyLines(dialogues: Dialogue[]): string[] {
  const lines: string[] = [];
  for (const condition of CONDITIONS) {
    const times = dialogues
      .filter((d) => d.condition === condition)
      .flatMap((d) => d.turns.flatMap((t) => (t.ms ? [(t.ms.judge ?? 0) + t.ms.opponent] : [])));
    if (times.length > 0) lines.push(`  ${condition}: ${Math.round(median(times))}ms`);
  }
  return lines;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = parseProvider(argString(args, 'provider'));
  const reps = argCount(args, 'reps', 2);
  const turns = argCount(args, 'turns', DEFAULT_TURNS);
  const concurrency = argCount(args, 'concurrency', 2);
  const runId = argString(args, 'run') ?? defaultRunId();

  const cards = loadCards();
  const questions = selectQuestions(loadQuestions(cards), argList(args, 'questions'));
  if (questions.length === 0) throw new Error('돌릴 질문이 없습니다.');
  const conditions = selectConditions(argList(args, 'conditions'));
  if (conditions.length === 0) throw new Error('--conditions에는 plain, prompt, engine 가운데 하나 이상이 와야 합니다.');

  const jobs: Job[] = [];
  for (const question of questions) {
    for (const condition of conditions) {
      for (let rep = 1; rep <= reps; rep++) jobs.push({ question, condition, rep });
    }
  }

  // 같은 이름으로 앞서 돌린 것이 있으면 이어서 돌린다.
  const dir = runPath(runId);
  const transcriptsPath = join(dir, 'transcripts.jsonl');
  const previous = existsSync(transcriptsPath) ? readJsonl<Dialogue>(transcriptsPath, true) : [];
  const oldMeta = existsSync(dir) ? readMeta(dir) : undefined;
  if (oldMeta && (oldMeta.provider !== provider || oldMeta.turns !== turns)) {
    throw new Error('이 실행 이름은 다른 설정(모델 종류나 턴 수)으로 이미 쓰였습니다. 새 이름으로 실행하세요.');
  }
  const done = new Set(previous.map(dialogueKey));
  const todo = jobs.filter((job) => !done.has(dialogueKey({ questionId: job.question.id, condition: job.condition, rep: job.rep })));
  const engineTodo = todo.filter((job) => job.condition === 'engine').length;

  const plan = [
    `실행 이름: ${runId}`,
    `모델: ${provider === 'mock' ? '모의 모델(비용 없음)' : '실제 모델'}`,
    `질문 ${questions.length}개 × 조건 ${conditions.length}개 × ${reps}번 = 대화 ${jobs.length}회, 대화마다 ${turns}턴`,
  ];
  if (jobs.length !== todo.length) plan.push(`이미 끝난 대화 ${jobs.length - todo.length}회는 건너뜁니다.`);
  const judgeCalls = engineTodo * turns;
  plan.push(
    `이번에 돌릴 대화 ${todo.length}회: 상대 모델 호출 ${todo.length * turns}회, 판정기 호출 ${judgeCalls}회 (판정을 읽지 못한 턴은 다시 불러 최대 ${judgeCalls * JUDGE_ATTEMPTS}회)`,
  );
  console.log(plan.join('\n'));

  if (todo.length === 0) {
    console.log('\n돌릴 대화가 없습니다. 다음은 eval:label입니다.');
    return;
  }
  if (provider === 'api' && args.confirm !== true) {
    console.log('\n실제 모델 호출은 비용이 듭니다. 위 계획이 맞으면 --confirm을 붙여 다시 실행하세요.');
    return;
  }

  const models = { opponent: createModel(provider, 'opponent'), judge: createModel(provider, 'judge') };
  if (oldMeta && (oldMeta.models.opponent !== models.opponent.name || oldMeta.models.judge !== models.judge.name)) {
    throw new Error('이 실행 이름은 다른 모델로 이미 쓰였습니다. 모델을 섞지 않도록 새 이름으로 실행하세요.');
  }

  runDir(runId, true);
  const meta: RunMeta = {
    runId,
    provider,
    models: { opponent: models.opponent.name, judge: models.judge.name },
    questions: [...new Set([...(oldMeta?.questions ?? []), ...questions.map((q) => q.id)])].sort(),
    conditions: CONDITIONS.filter((c) => conditions.includes(c) || (oldMeta?.conditions ?? []).includes(c)),
    reps: Math.max(oldMeta?.reps ?? 0, reps),
    turns,
    createdAt: oldMeta?.createdAt ?? new Date().toISOString(),
    ...(oldMeta?.scorer ? { scorer: oldMeta.scorer } : {}),
    ...(oldMeta?.usage ? { usage: oldMeta.usage } : {}),
  };
  writeMeta(dir, meta);
  // 쓰다가 끊긴 줄이 있었다면 여기서 정리된다.
  if (previous.length > 0) writeJsonl(transcriptsPath, previous);

  let finished = 0;
  let stopped = false;
  const failures: string[] = [];
  await mapLimit(todo, concurrency, async (job) => {
    if (stopped) return;
    const name = `${job.question.id} ${job.condition} ${job.rep}번째`;
    try {
      const card = cards.get(job.question.cardId);
      if (!card) throw new Error(`입장 카드 '${job.question.cardId}'가 없습니다.`);
      const dialogue = await runDialogue({ runId, question: job.question, card, condition: job.condition, rep: job.rep, models, totalTurns: turns });
      appendJsonl(transcriptsPath, [dialogue]);
      finished++;
      console.log(`  ${finished}/${todo.length} ${name}`);
    } catch (error) {
      // 하나가 실패하면 새 대화를 시작하지 않는다. 같은 문제로 비용이 더 나가는 것을 막는다.
      stopped = true;
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const usage: NonNullable<RunMeta['usage']> = { ...meta.usage };
  for (const role of ['opponent', 'judge'] as const) {
    const total = addUsage(meta.usage?.[role], models[role].usage);
    if (total) usage[role] = total;
  }
  if (Object.keys(usage).length > 0) writeMeta(dir, { ...meta, usage });

  console.log(`\n이번에 끝난 대화 ${finished}회. 기록: runs/${runId}/transcripts.jsonl`);
  for (const role of ['opponent', 'judge'] as const) {
    const used = models[role].usage;
    if (used && used.calls > 0) {
      console.log(`${role === 'opponent' ? '상대 모델' : '판정기'} 사용량: ${usageText(used)}`);
    }
  }
  if (existsSync(transcriptsPath)) {
    const recorded = readJsonl<Dialogue>(transcriptsPath, true);
    const summary = judgeSummary(computeJudgeChecks(recorded));
    if (summary) console.log(summary);
    const lines = provider === 'api' ? latencyLines(recorded) : [];
    if (lines.length > 0) console.log(['한 턴의 답이 나오기까지 걸린 시간(중앙값):', ...lines].join('\n'));
  }

  if (failures.length > 0) {
    console.error(`\n실패한 대화가 있어 멈췄습니다 (남은 대화 ${todo.length - finished}회).`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error('원인을 고친 뒤 같은 명령을 다시 실행하면 빠진 대화만 이어서 돌립니다.');
    process.exitCode = 1;
    return;
  }
  console.log('다음은 eval:label입니다.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
