// 화면: 주제를 고르고, 글로 한 판을 주고받는다. 음성은 다음 단계에서 붙인다.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { GameView, TopicView } from '../../server/contract.ts';
import { api } from './api.ts';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 문제가 생겼습니다.';
}

export function App() {
  const [topics, setTopics] = useState<TopicView[] | null>(null);
  const [mock, setMock] = useState(false);
  const [game, setGame] = useState<GameView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .topics()
      .then((data) => {
        setTopics(data.topics);
        setMock(data.provider === 'mock');
      })
      .catch((e: unknown) => setError(messageOf(e)));
  }, []);

  async function start(topicId: string) {
    setError(null);
    try {
      setGame(await api.start(topicId));
    } catch (e) {
      setError(messageOf(e));
    }
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
      {game ? <Game initial={game} onLeave={() => setGame(null)} /> : <TopicList topics={topics} onStart={start} />}
    </div>
  );
}

function TopicList({ topics, onStart }: { topics: TopicView[] | null; onStart: (id: string) => void }) {
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
            <button type="button" onClick={() => onStart(topic.id)}>
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
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [game.messages.length, waiting]);

  async function send() {
    const text = draft.trim();
    if (!text || waiting || game.ended) return;
    setWaiting(true);
    setError(null);
    // 보낸 말을 먼저 보이고, 답이 오면 덧붙인다.
    setGame((g) => ({ ...g, messages: [...g.messages, { speaker: 'user', text }] }));
    setDraft('');
    try {
      const result = await api.turn(game.id, text);
      setGame((g) => ({
        ...g,
        turn: result.turn,
        ended: result.ended,
        messages: [...g.messages, { speaker: 'opponent', text: result.reply }],
      }));
    } catch (e) {
      // 실패하면 보낸 말을 입력 칸으로 되돌려 다시 보낼 수 있게 한다.
      setGame((g) => ({ ...g, messages: g.messages.slice(0, -1) }));
      setDraft(text);
      setError(messageOf(e));
    } finally {
      setWaiting(false);
    }
  }

  async function end() {
    setError(null);
    try {
      setGame(await api.end(game.id));
    } catch (e) {
      setError(messageOf(e));
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
        <p className="muted">
          상대: {name} · 턴 {game.turn} / {game.maxTurns}
        </p>
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
            다른 주제 고르기
          </button>
        </div>
      ) : (
        <form className="composer" onSubmit={onSubmit}>
          <label htmlFor="draft">내 말</label>
          <textarea
            id="draft"
            rows={3}
            value={draft}
            maxLength={game.maxTextLength}
            placeholder="반론이나 질문을 적어 보내세요."
            disabled={waiting}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="actions">
            <span className="muted">
              {draft.length} / {game.maxTextLength}자 · ⌘ 또는 Ctrl + Enter로 보내기
            </span>
            <button type="button" className="secondary" onClick={() => void end()} disabled={waiting}>
              끝내기
            </button>
            <button type="submit" disabled={waiting || !draft.trim()}>
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
