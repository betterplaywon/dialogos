# plan-gate: 실제 모델 실행의 문턱

실제 모델을 부르는 실행이 `--confirm` 없이는 계획만 출력하고 아무것도 만들지 않는지 확인한다. 어떤 단계도 `--confirm`을 넘기지 않고, 환경에는 모델 연결 정보가 없다. 그래서 문턱이 깨져 있어도 이 여정은 실제 모델에 닿지 않고 실패로 끝난다.

| 단계 id | 사용자 행동 | 보여야 하는 것 |
| --- | --- | --- |
| `run-plan` | `eval:run -- --provider api --run <이름>-api --questions q01 --reps 1 --turns 2` | "모델: 실제 모델", 호출 횟수 계획, "--confirm을 붙여 다시 실행하세요". 종료 코드 0. `runs/verify/<이름>-api/` 폴더가 없다 |
| `mock-seed` | `eval:run -- --provider mock --run <이름> --questions q01 --reps 1 --turns 2` | 대화 3회 |
| `label-plan` | `eval:label -- --provider api --run <이름>` | "채점기 호출 N회 (실제 모델)", "--confirm을 붙여 다시 실행하세요". `labels.jsonl`이 없고 `meta.json`에 scorer가 없다 |

## 이 여정이 증명하지 않는 것

- `--confirm`을 붙였을 때의 실제 호출. 그것은 사용자가 확인한 시범 실행의 일이다.
- 가드 훅의 확인 창. 훅의 판정은 `.claude/hooks/guard-bash.test.mjs`가 검사한다.
