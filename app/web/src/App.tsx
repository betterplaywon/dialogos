// 화면: 지난 판을 이어 하거나 주제를 골라, 지킬 입장과 지금의 생각을 고르고, 글로 한 판을 주고받는다.
// 판이 끝나면 사후 입장과 훈계 문항을 받아야 판이 닫힌다. 음성은 다음 단계에서 붙인다.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { GameSummaryView, GameView, Lean, SideIndex, TopicView, Verdict } from '../../server/contract.ts';
import { api } from './api.ts';
import { LEAN_STEPS, leanAccessibleName, leanLabel, sideOfLean, VERDICT_LABEL } from './lean.ts';
import { sendTurn } from './turn-flow.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 문제가 생겼습니다.';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

const stancesOf = (topic: TopicView): [string, string] => [topic.sides[0].stance, topic.sides[1].stance];

export function App() {
  const [topics, setTopics] = useState<TopicView[] | null>(null);
  const [pastGames, setPastGames] = useState<GameSummaryView[] | null>(null);
  const [mock, setMock] = useState(false);
  const [picking, setPicking] = useState<TopicView | null>(null);
  const [game, setGame] = useState<GameView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function refreshPastGames() {
    api
      .list()
      .then((data) => setPastGames(data.games))
      .catch((e: unknown) => setError(messageOf(e)));
  }

  useEffect(() => {
    api
      .topics()
      .then((data) => {
        setTopics(data.topics);
        setMock(data.provider === 'mock');
      })
      .catch((e: unknown) => setError(messageOf(e)));
    refreshPastGames();
  }, []);

  /** 새 판을 시작하거나 지난 판을 연다. 요청 중에는 다시 누르지 못한다. */
  async function open(load: () => Promise<GameView>) {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      setGame(await load());
      setPicking(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setStarting(false);
    }
  }

  function leave() {
    setGame(null);
    refreshPastGames();
  }

  function pick(topic: TopicView | null) {
    setError(null);
    setPicking(topic);
  }

  let body;
  if (game) {
    body = <Game initial={game} onLeave={leave} />;
  } else if (picking) {
    body = (
      <StartScreen
        topic={picking}
        busy={starting}
        onStart={(side, lean) => void open(() => api.start(picking.id, side, lean))}
        onBack={() => pick(null)}
      />
    );
  } else {
    body = (
      <>
        <PastGames games={pastGames} busy={starting} onOpen={(id) => void open(() => api.get(id))} />
        <TopicList topics={topics} onPick={pick} />
      </>
    );
  }

  return (
    <div className="page">
      <header className="masthead">
        <h1>dialogos</h1>
        <p>근거 없이는 물러서지 않고, 타당한 반론에는 물러서는 토론 상대</p>
      </header>
      {mock && (
        <p className="notice" role="note">
          모의 모델로 도는 개발용 화면입니다. 상대의 답은 흐름을 확인하려고 만든 문장이라 뜻이 없습니다.
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {body}
    </div>
  );
}

function pastStatus(past: GameSummaryView): string {
  if (!past.ended) return '진행 중';
  return past.record ? VERDICT_LABEL[past.record.verdict] : '기록 전';
}

function pastAction(past: GameSummaryView): string {
  if (!past.ended) return '이어 하기';
  return past.record ? '다시 보기' : '기록 남기기';
}

function PastGames({ games, busy, onOpen }: { games: GameSummaryView[] | null; busy: boolean; onOpen: (id: string) => void }) {
  if (!games || games.length === 0) return null;
  return (
    <section className="past" aria-labelledby="past-title">
      <h2 id="past-title">지난 판</h2>
      <ul>
        {games.map((past) => {
          const opponent = past.topic.sides[past.side].opponent;
          return (
            <li key={past.id} className="past-game">
              <div className="past-text">
                <p className="question">{past.topic.question}</p>
                <p className="muted">
                  {opponent ? `${opponent.name} · ` : ''}
                  {past.turn} / {past.maxTurns}턴 · {pastStatus(past)} · {formatTime(past.startedAt)}
                </p>
                {past.startLean !== null && (
                  <p className="muted">
                    생각: {leanLabel(past.startLean, past.side)}
                    {past.record ? ` → ${leanLabel(past.record.lean, past.side)}` : ''}
                  </p>
                )}
              </div>
              <button type="button" className={past.record ? 'secondary' : undefined} onClick={() => onOpen(past.id)} disabled={busy}>
                {pastAction(past)}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function TopicList({ topics, onPick }: { topics: TopicView[] | null; onPick: (topic: TopicView) => void }) {
  if (!topics) return <p className="muted">주제를 불러오는 중입니다.</p>;
  return (
    <section className="topics" aria-labelledby="topics-title">
      <h2 id="topics-title">주제 고르기</h2>
      <ul>
        {topics.map((topic) => (
          <li key={topic.id} className="topic">
            <p className="question">{topic.question}</p>
            <ul className="stances" aria-label="두 입장">
              {topic.sides.map((side, index) => (
                <li key={index}>{side.stance}</li>
              ))}
            </ul>
            <button type="button" onClick={() => onPick(topic)}>
              이 주제로
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 다섯 칸 척도. marker를 주면 그 칸 아래에 '시작'을 적는다(끝 화면에서 시작할 때의 생각). */
function LeanScale({
  name,
  stances,
  value,
  onChange,
  marker,
}: {
  name: string;
  stances: [string, string];
  value: Lean | null;
  onChange: (lean: Lean) => void;
  marker?: Lean | null;
}) {
  return (
    <>
      <div className="scale">
        {LEAN_STEPS.map((step) => (
          <label key={step.lean} className="pick-opt">
            <input
              type="radio"
              name={name}
              checked={value === step.lean}
              onChange={() => onChange(step.lean)}
              aria-label={`${leanAccessibleName(step.lean, stances)}${marker === step.lean ? ' (시작할 때의 생각)' : ''}`}
            />
            <span>{step.label}</span>
          </label>
        ))}
      </div>
      {marker !== undefined && marker !== null && (
        <div className="scale marks" aria-hidden="true">
          {LEAN_STEPS.map((step) => (
            <span key={step.lean}>{marker === step.lean ? '시작' : ''}</span>
          ))}
        </div>
      )}
    </>
  );
}

function Ends({ topic, withOpponents }: { topic: TopicView; withOpponents: boolean }) {
  return (
    <div className="ends">
      {topic.sides.map((side, index) => (
        <div key={index}>
          <span>{side.stance}</span>
          {withOpponents && (
            <span className="opp">{side.opponent ? `이쪽이면 상대: ${side.opponent.name}` : '이쪽은 아직 상대가 없습니다'}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function StartScreen({
  topic,
  busy,
  onStart,
  onBack,
}: {
  topic: TopicView;
  busy: boolean;
  onStart: (side: SideIndex, lean: Lean) => void;
  onBack: () => void;
}) {
  const [lean, setLean] = useState<Lean | null>(null);
  const [tested, setTested] = useState<SideIndex | null>(null);
  const side = lean === null ? null : (sideOfLean(lean) ?? tested);
  const opponent = side === null ? null : topic.sides[side].opponent;

  let caption: string;
  if (lean === null) caption = '척도에서 한 칸을 고르세요.';
  else if (side === null) caption = '반반이면 지켜 볼 입장을 고르세요.';
  else if (!opponent) caption = '이 입장으로 토론할 상대가 아직 없습니다.';
  else caption = `지킬 입장: ${topic.sides[side].stance} · 상대: ${opponent.name}`;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (lean !== null && side !== null && opponent) onStart(side, lean);
  }

  return (
    <section className="start" aria-labelledby="start-title">
      <h2 id="start-title">{topic.question}</h2>
      <form className="choices" onSubmit={submit}>
        <fieldset className="choice">
          <legend>지금 내 생각은 어느 쪽에 가깝습니까?</legend>
          <Ends topic={topic} withOpponents />
          <LeanScale name="start-lean" stances={stancesOf(topic)} value={lean} onChange={setLean} />
        </fieldset>
        {lean === 0 && (
          <fieldset className="choice">
            <legend>반반이라면, 어느 입장을 지켜 보시겠습니까?</legend>
            <div className="scale two">
              {topic.sides.map((item, index) => (
                <label key={index} className="pick-opt">
                  <input
                    type="radio"
                    name="tested-side"
                    checked={tested === index}
                    onChange={() => setTested(index as SideIndex)}
                    aria-label={item.stance}
                  />
                  <span>{index === 0 ? '왼쪽 입장' : '오른쪽 입장'}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="actions">
          <span className="muted">{caption}</span>
          <button type="button" className="secondary" onClick={onBack} disabled={busy}>
            목록으로
          </button>
          <button type="submit" disabled={busy || side === null || !opponent}>
            이 입장으로 시작
          </button>
        </div>
      </form>
    </section>
  );
}

function endText(game: GameView): string {
  if (game.endReason === 'max-turns') return `판이 끝났습니다. ${game.turn}턴을 모두 주고받았습니다.`;
  if (game.endReason === 'user') return `판을 끝냈습니다. ${game.turn}턴을 주고받았습니다.`;
  return `판이 끝났습니다. ${game.turn}턴을 주고받았습니다.`;
}

/** 끝난 판의 기록. 사후 입장과 훈계 문항에 답해야 판이 닫힌다(창을 닫았다면 다음에 열 때 다시 묻는다). */
function EndPanel({ game, onRecorded, onLeave }: { game: GameView; onRecorded: (game: GameView) => void; onLeave: () => void }) {
  const [lean, setLean] = useState<Lean | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (game.record) {
    return (
      <div className="ended">
        <p>{endText(game)}</p>
        <p className="muted">
          생각: {game.startLean !== null ? `${leanLabel(game.startLean, game.side)} → ` : ''}
          {leanLabel(game.record.lean, game.side)} · 이번 판은 {VERDICT_LABEL[game.record.verdict]}
        </p>
        <button type="button" onClick={onLeave}>
          목록으로
        </button>
      </div>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lean === null || verdict === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      onRecorded(await api.record(game.id, lean, verdict));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="end-record choices" onSubmit={(event) => void submit(event)} aria-busy={saving}>
      <p>{endText(game)} 두 가지에 답하면 판이 닫힙니다.</p>
      <fieldset className="choice">
        <legend>지금 내 생각은 어느 쪽에 가깝습니까?</legend>
        <Ends topic={game.topic} withOpponents={false} />
        <LeanScale name="end-lean" stances={stancesOf(game.topic)} value={lean} onChange={setLean} marker={game.startLean} />
      </fieldset>
      <fieldset className="choice">
        <legend>이번 판은 토론이었습니까, 훈계였습니까?</legend>
        <div className="scale two">
          {(['debate', 'lecture'] as const).map((value) => (
            <label key={value} className="pick-opt">
              <input type="radio" name="verdict" checked={verdict === value} onChange={() => setVerdict(value)} />
              <span>{VERDICT_LABEL[value]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="actions">
        <button type="submit" disabled={lean === null || verdict === null || saving}>
          기록 남기기
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Game({ initial, onLeave }: { initial: GameView; onLeave: () => void }) {
  const [game, setGame] = useState(initial);
  const [draft, setDraft] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [game.messages.length, waiting, game.ended]);

  async function send() {
    const text = draft.trim();
    if (!text || waiting || ending || game.ended) return;
    const before = game;
    setWaiting(true);
    setError(null);
    // 보낸 말을 먼저 보이고, 결과가 오면 sendTurn이 맞춘 판으로 바꾼다.
    setGame({ ...before, messages: [...before.messages, { speaker: 'user', text }] });
    setDraft('');
    try {
      const settled = await sendTurn(api, before, text);
      setGame(settled.game);
      setDraft(settled.draft);
      setError(settled.error);
    } finally {
      setWaiting(false);
    }
  }

  async function end() {
    if (ending || waiting) return;
    setEnding(true);
    setError(null);
    try {
      setGame(await api.end(game.id));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setEnding(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 한글 조합 중의 Enter는 보내지 않는다.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const mine = game.topic.sides[game.side];
  const name = mine.opponent?.name ?? '상대';
  return (
    <section className="game" aria-labelledby="game-title">
      <div className="game-head">
        <h2 id="game-title">{game.topic.question}</h2>
        <div className="game-meta">
          <p className="muted">
            내 입장: {mine.stance} · 상대: {name} · 턴 {game.turn} / {game.maxTurns}
          </p>
          {!game.ended && (
            // 판은 저장되므로 목록으로 나갔다가 '지난 판'에서 이어 할 수 있다.
            <button type="button" className="secondary" onClick={onLeave} disabled={waiting || ending}>
              목록으로
            </button>
          )}
        </div>
      </div>
      <ol className="messages" aria-live="polite">
        {game.messages.map((message, index) => (
          <li key={index} className={`message ${message.speaker}`}>
            <span className="who">{message.speaker === 'user' ? (index === 0 ? '나 · 고른 입장' : '나') : name}</span>
            <p>{message.text}</p>
          </li>
        ))}
        {waiting && (
          <li className="message opponent pending">
            <span className="who">{name}</span>
            <p>답을 쓰는 중입니다.</p>
          </li>
        )}
      </ol>
      {game.ended ? (
        <EndPanel game={game} onRecorded={setGame} onLeave={onLeave} />
      ) : (
        <form className="composer" onSubmit={onSubmit} aria-busy={waiting}>
          <label htmlFor="draft">내 말</label>
          {/* 답을 기다리는 동안 비활성(disabled)으로 두면 포커스가 빠지므로 읽기 전용으로 둔다. */}
          <textarea
            id="draft"
            rows={3}
            value={draft}
            maxLength={game.maxTextLength}
            placeholder="반론이나 질문을 적어 보내세요."
            readOnly={waiting}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="actions">
            <span className="muted">
              {draft.length} / {game.maxTextLength}자 · ⌘ 또는 Ctrl + Enter로 보내기
            </span>
            <button type="button" className="secondary" onClick={() => void end()} disabled={waiting || ending}>
              끝내기
            </button>
            <button type="submit" disabled={waiting || ending || !draft.trim()}>
              보내기
            </button>
          </div>
        </form>
      )}
      <div ref={bottom} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
