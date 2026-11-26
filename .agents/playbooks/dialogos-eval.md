---
extends: eval
when: Use it whenever a request in this repository mentions the 판정 실험, eval/, the rubric, the judge or scorer, the questions or the script, or an npm run eval:* command.
---

# dialogos 판정 실험

pstack의 eval 플레이북은 에이전트와 스킬의 변형을 눈가림 후보로 비교하는 절차다. 이 저장소의 판정 실험(`eval/`)은 그것이 아니다. 실행기로 토론 상대 세 조건을 돌리고, 채점기로 라벨을 붙이고, 미리 정한 통과 기준으로 판정하는 실험이다. 후보 서브에이전트와 판정 서브에이전트를 띄우지 않는다.

- **Before** "State what variant is under test and what behavior counts as success.": 요청이 이 저장소의 판정 실험이면 이 플레이북의 단계 대신 아래를 따르고 여기서 멈춘다.
  1. 설계는 사용자가 정했다. `eval/README.md`의 통과 기준과 세부 규칙, `eval/rubric.md`의 채점 기준, 질문, 대본은 사용자의 확인 없이 바꾸지 않는다. 바꾸는 PR은 1번 배경에 그 사용자 결정을 적고, 독립 검증이 그 결정이 있는지 본다(CLAUDE.md '자율 범위').
  2. 흐름은 모의 모델로 확인한다: `node .claude/skills/verify/scripts/verify.mjs flow`. 모의 모델의 숫자는 결과가 아니므로 보고와 공개 문서에 결과로 적지 않는다.
  3. 실제 모델 실행은 `--provider api`로 계획(호출 횟수)을 먼저 출력해 사용자에게 보여 주고, 확인을 받은 뒤에만 `--confirm`을 붙인다. 가드 훅이 확인 창을 띄운다. 비용 상한과 시범 실행의 범위는 `notes/handoff.md`를 따른다.
  4. `.env`는 읽거나 출력하지 않는다. 키를 대화에 적어 달라고 하지 않는다.
  5. 결과는 `runs/`에만 쓴다. 공개하는 결과표에는 합성 대화에서 나온 숫자만 넣는다.
  6. 보고에는 실행 이름, 모델, 호출 횟수와 토큰(`meta.json`), 걸린 시간, 읽지 못한 판정의 수를 적고, 추정과 실측을 나눠 쓴다.
