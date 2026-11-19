// 화면: 지난 판을 이어 하거나 주제를 골라, 글로 한 판을 주고받는다. 음성은 다음 단계에서 붙인다.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { GameSummaryView, GameView, TopicView } from '../../server/contract.ts';
import { api } from './api.ts';
import { sendTurn } from './turn-flow.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 문제가 생겼습니다.';
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

export function App() {
  const [topics, setTopics] = useState<TopicView[] | null>(null);
  const [pastGames, setPastGames] = useState<GameSummaryView[] | null>(null);
  const [mock, setMock] = useState(false);
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

  /** 새 판을 시작하거나(topicId) 지난 판을 연다(gameId). 요청 중에는 다시 누르지 못한다. */
  async function open(load: () => Promise<GameView>) {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      setGame(await load());
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
      {game ? (
        <Game initial={game} onLeave={leave} />
      ) : (
        <>
          <PastGames games={pastGames} busy={starting} onOpen={(id) => void open(() => api.get(id))} />
          <TopicList topics={topics} busy={starting} onStart={(id) => void open(() => api.start(id))} />
        </>
      )}
    </div>
  );
}

function PastGames({ games, busy, onOpen }: { games: GameSummaryView[] | null; busy: boolean; onOpen: (id: string) => void }) {
  if (!games || games.length === 0) return null;
  return (
    <section className="past" aria-labelledby="past-title">
      <h2 id="past-title">지난 판</h2>
      <ul>
        {games.map((past) => (
          <li key={past.id} className="past-game">
            <div className="past-text">
              <p className="question">{past.topic.question}</p>
              <p className="muted">
                {past.topic.character.name} · {past.turn} / {past.maxTurns}턴 · {past.ended ? '끝남' : '진행 중'} · {formatTime(past.startedAt)}
              </p>
            </div>
            <button type="button" className={past.ended ? 'secondary' : undefined} onClick={() => onOpen(past.id)} disabled={busy}>
              {past.ended ? '다시 보기' : '이어 하기'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TopicList({ topics, busy, onStart }: { topics: TopicView[] | null; busy: boolean; onStart: (id: string) => void }) {
  if (!topics) return <p className="muted">주제를 불러오는 중입니다.</p>;
  return (
    <section className="topics" aria-labelledby="topics-title">
      <h2 id="topics-title">주제 고르기</h2>
      <ul>
        {topics.map((topic) => (
          <li key={topic.id} className="topic">
            <p className="question">{topic.question}</p>
            <dl>
              <dt>내 입장</dt>
              <dd>{topic.userStance}</dd>
              <dt>상대</dt>
              <dd>{topic.character.name}</dd>
            </dl>
            <button type="button" onClick={() => onStart(topic.id)} disabled={busy}>
              이 주제로 시작
            </button>
          </li>
        ))}
      </ul>
    </section>
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
  }, [game.messages.length, waiting]);

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

  const name = game.topic.character.name;
  return (
    <section className="game" aria-labelledby="game-title">
      <div className="game-head">
        <h2 id="game-title">{game.topic.question}</h2>
        <div className="game-meta">
          <p className="muted">
            상대: {name} · 턴 {game.turn} / {game.maxTurns}
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
            <span className="who">{message.speaker === 'user' ? (index === 0 ? '나 · 주제의 입장' : '나') : name}</span>
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
      <div ref={bottom} />
      {game.ended ? (
        <div className="ended">
          <p>판이 끝났습니다. {game.turn}턴을 주고받았습니다.</p>
          <button type="button" onClick={onLeave}>
            목록으로
          </button>
        </div>
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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
