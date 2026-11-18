# flow: 판정 실험 전체 흐름

다섯 명령을 사람이 쓰는 순서대로 모의 모델로 돌린다. 옵션(`--questions`, `--reps`, `--turns`)을 주지 않으면 본 실행과 같은 모양(모든 질문, 조건 셋, 2번, 30턴)이다.

| 단계 id | 사용자 행동 | 보여야 하는 것 |
| --- | --- | --- |
| `run` | `eval:run -- --provider mock --run <이름>` | 계획 줄 "모의 모델(비용 없음)"과 "질문 N개 × 조건 3개 × R번 = 대화 D회, 대화마다 T턴". `transcripts.jsonl`에 D줄, 대화마다 T턴, `meta.json`의 provider가 mock |
| `resume` | 같은 명령을 한 번 더 | "이미 끝난 대화 D회는 건너뜁니다", "돌릴 대화가 없습니다". 기록 줄 수 그대로 |
| `label` | `eval:label -- --provider mock --run <이름>` | `labels.jsonl`에 D × T줄, 줄마다 `yield`와 `concededBefore`. `meta.json`의 scorer가 mock |
| `score` | `eval:score -- --run <이름>` | 첫 줄 "# 판정 실험 결과 (<이름>)", "모의 모델로 돌린 결과입니다" 안내, 끝에 "## 점검" 절. `results.md`가 출력과 같고 `results.json`에 판정, 지표, 점검 값(`checks`) |
| `sample` | `eval:sample -- --run <이름> --n 20` | `sample.csv`에 `item`, `human_yield` 칸이 있고 조건·턴 종류·채점기 라벨 칸은 없다. 표본 수 = `sample.key.json`의 열쇠 수 |
| `agreement` | `sample.csv`의 `human_yield`를 채점기 라벨대로 채우되 마지막 두 칸만 반대로 적고, `eval:agreement -- --run <이름>` | "사람이 라벨을 붙인 표본: 20개 (비어 있는 칸 0개)", "서로 다른 표본:"에 뒤집은 두 표본만 |
| `readable` | 첫 질문의 1번째 대화를 조건마다 대화록으로 | `dialogue-<질문>-<조건>-1.md` 세 개. 엔진 턴 가운데 판정이 시킨 것과 채점기 라벨이 어긋난 수. 점검 절(`results.json`의 `checks.follow`)과 같은 값이다(모의 모델이라 결과 아님) |

## 이 여정이 증명하지 않는 것

- 실제 모델에서의 동작과 숫자. 모의 모델은 길이로만 압박과 반론을 가른다.
- 실패 뒤 이어 돌리기. `eval/tests/cli.test.ts`가 맡는다.
