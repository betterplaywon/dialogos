// 화면: 지난 판을 이어 하거나 주제를 골라, 지킬 입장과 지금의 생각을 고르고, 글이나 말로 한 판을 주고받는다.
// 판이 끝나면 사후 입장과 훈계 문항을 받아야 판이 닫힌다.
// 음성은 켰을 때만 쓴다. 인식된 글은 입력 칸에 넣어 고치게 하고 자동으로 보내지 않는다. 글 입력은 언제나 된다.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { GameSummaryView, GameView, Lean, SideIndex, TopicView, Verdict } from '../../server/contract.ts';
import { api } from './api.ts';
import { NEW_TURN, takeDictation, turnEntryOf, voiceTallyText, type TurnDictation } from './dictation.ts';
import { LEAN_STEPS, leanAccessibleName, leanLabel, sideOfLean, VERDICT_LABEL } from './lean.ts';
import { LISTEN_PROBLEMS, PACK_PENDING_NOTICE, PLACE_NOTICES } from './listen.ts';
import { SPEAK_PROBLEMS } from './speak.ts';
import { sendTurn } from './turn-flow.ts';
import { useVoice, type Voice } from './use-voice.ts';
import type { Heard, ReadRequest, VoiceState } from './voice-control.ts';

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
  // 음성 상태는 여기에 둔다. 판을 나갔다가 다른 판을 열어도 켜진 채로 남는다.
  const voice = useVoice();

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
    body = <Game initial={game} voice={voice} onLeave={leave} />;
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
          const tally = voiceTallyText(past.voice);
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
                {tally && <p className="muted">{tally}</p>}
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
                    aria-label={`${index === 0 ? '왼쪽 입장' : '오른쪽 입장'}: ${item.stance}`}
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
    const tally = voiceTallyText(game.voice);
    return (
      <div className="ended">
        <p>{endText(game)}</p>
        <p className="muted">
          생각: {game.startLean !== null ? `${leanLabel(game.startLean, game.side)} → ` : ''}
          {leanLabel(game.record.lean, game.side)} · 이번 판은 {VERDICT_LABEL[game.record.verdict]}
        </p>
        {tally && <p className="muted">{tally}</p>}
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

/** 음성을 켜기 전에 읽는 안내. 말소리와 읽을 글이 어디로 가는지 알린다. */
const VOICE_NOTES: readonly string[] = [
  '말소리는 브라우저의 음성 인식이 글로 바꿉니다. 기기 안에서 바꿀 수 있으면 그렇게 하고(처음 한 번 한국어 인식 팩을 내려받습니다. 수십 MB이고, 내려받은 뒤 브라우저를 완전히 종료했다가 다시 열어야 쓸 수 있습니다), 안 되면 브라우저가 정한 방식으로 바꿉니다. 이때 말소리가 브라우저 회사의 서버(Chrome은 Google, Safari는 Apple, Edge는 Microsoft)로 갈 수 있습니다.',
  '상대의 말은 기기 안의 목소리로 읽습니다. 기기 안에 한국어 목소리가 없으면 읽지 않습니다. 기기 밖 목소리는 직접 고른 경우에만 쓰고, 그때는 읽을 글이 그 목소리의 서버로 갑니다.',
  'dialogos 서버는 소리를 받지도 저장하지도 않습니다. 인식된 글은 입력 칸에 넣어 드리고, 고친 뒤 직접 보냅니다.',
];

const PREPARING_NOTICE = '기기 안 인식을 준비하는 중입니다. 처음에는 인식 팩을 내려받습니다.';
const LISTENING_HINT = '말을 마치면 [말 마치기]를 누르거나 잠시 기다려 주세요.';

/** 말소리가 어디서 글로 바뀌는지, 아니면 왜 음성 입력을 쓸 수 없는지. */
function recognitionNotice(state: VoiceState): string {
  if (!state.canListen) return '이 브라우저는 음성 인식을 지원하지 않습니다. 글로 입력해 주세요.';
  if (state.blocked) return LISTEN_PROBLEMS[state.blocked].message;
  // 인식 팩을 내려받은 뒤 아직 말소리가 글로 바뀐 적이 없으면, 기기 안에서 바뀐다고만 하지 않고 브라우저를 다시 열라고 알린다.
  if (state.packPending) return PACK_PENDING_NOTICE;
  if (state.place === 'device' || state.place === 'unknown') return PLACE_NOTICES[state.place];
  return PREPARING_NOTICE;
}

/**
 * 목소리 목록에 '고르지 않음'을 두는가. 기기 안 한국어 목소리가 없으면 기기 밖 목소리를 직접 골라야 읽는다.
 * 그때는 고르기 전에도 고른 뒤에도 읽지 않는 쪽을 고를 수 있어야 한다. 기기 안 목소리가 있으면 그것을 고르면 되므로 두지 않는다.
 * 고른 것 없이 목록을 기다리는 중('wait')에는 기기 목소리가 곧 올 수 있어 목록을 보이지 않는다.
 */
function canPickNone(state: VoiceState): boolean {
  return state.voice !== 'wait' && state.voices.length > 0 && !state.voices.some((item) => item.localService);
}

/** 상대의 말을 읽는 목소리에 대해 알릴 것. 기기 안 목소리로 읽을 때는 알릴 것이 없다. */
function speechNotice(state: VoiceState): string | null {
  if (!state.canSpeak) return '이 브라우저는 음성 합성을 지원하지 않아 상대의 말을 읽어 주지 못합니다.';
  if (state.voice === 'wait') return '한국어 목소리를 찾는 중입니다.';
  if (state.voice === null) {
    return state.voices.length > 0
      ? '기기 안에 한국어 목소리가 없어 읽지 않습니다. 기기 밖 목소리를 고르면 그 목소리로 읽고, 읽을 글이 그 목소리의 서버로 갑니다.'
      : '이 브라우저에는 한국어 목소리가 없어 읽어 주지 못합니다.';
  }
  if (state.voice.localService) return null;
  const remoteNotice = '이 목소리는 읽을 글을 기기 밖 서버로 보냅니다.';
  return canPickNone(state) ? `${remoteNotice} 목록에서 '고르지 않음'을 고르면 읽지 않습니다.` : remoteNotice;
}

/**
 * 켜기 전에 밝히는, 지난번에 고른 목소리. 켜자마자 그 목소리로 읽기 때문이다.
 * 목소리 목록은 켠 뒤에야 받으므로, 그 목소리가 기기 밖 것인지는 이때 알 수 없다.
 */
function rememberedNote(state: VoiceState): string | null {
  if (!state.canSpeak || !state.remembered) return null;
  return `지난번에 고른 목소리(${state.remembered})로 읽습니다. 기기 밖 목소리라면 읽을 글이 그 서버로 갑니다.`;
}

/** 음성 줄. 켜기 전에는 단추와 안내를, 켠 뒤에는 말소리와 읽을 글이 가는 곳을 보인다. */
function VoiceBar({ voice, onTurnOn }: { voice: Voice; onTurnOn: () => void }) {
  const { state, control } = voice;
  const bar = useRef<HTMLElement | null>(null);
  const wasOn = useRef(state.on);

  useEffect(() => {
    if (wasOn.current === state.on) return;
    wasOn.current = state.on;
    // 켜고 끌 때 누른 단추가 사라진다. 초점을 그 자리에 생긴 단추로 옮겨, 키보드로 쓰는 사람이 자리를 잃지 않게 한다.
    bar.current?.querySelector('button')?.focus();
  }, [state.on]);

  if (!state.canListen && !state.canSpeak) {
    return (
      <p className="voice-bar muted">
        {voice.embedded
          ? '이 창은 앱 안에 들어 있는 브라우저라 음성 기능을 쓸 수 없습니다. Chrome에서 이 주소를 열면 음성으로 토론할 수 있습니다. 지금은 글로 토론할 수 있습니다.'
          : '이 브라우저는 음성 기능을 지원하지 않습니다. 글로 토론할 수 있습니다.'}
      </p>
    );
  }
  if (!state.on) {
    const remembered = rememberedNote(state);
    return (
      <section className="voice-bar" aria-label="음성" ref={bar}>
        {/* 이 누름이 브라우저가 요구하는 사용자 제스처다. 첫 읽기와 인식 팩 내려받기가 이 안에서 시작된다. */}
        <button type="button" onClick={onTurnOn}>
          음성으로 하기
        </button>
        <ul className="voice-notes">
          {VOICE_NOTES.map((note) => (
            <li key={note}>{note}</li>
          ))}
          {remembered && <li>{remembered}</li>}
        </ul>
      </section>
    );
  }
  const chosen = state.voice === 'wait' ? null : state.voice;
  const notice = speechNotice(state);
  const pickNone = canPickNone(state);
  // 고를 것이 있을 때만 목록을 보인다. 기기 안 목소리가 없으면 기기 밖 목소리가 하나뿐이어도 '고르지 않음'과 둘이 된다.
  const pickable = pickNone || (chosen !== null && state.voices.length >= 2);
  return (
    <section className="voice-bar" aria-label="음성" ref={bar}>
      <div className="voice-lines">
        <p role="status">{recognitionNotice(state)}</p>
        {pickable && (
          <label className="voice-pick">
            <span>목소리</span>
            {/* 빈 값('고르지 않음')을 고르면 고른 것을 거둔다. */}
            <select value={chosen?.name ?? ''} onChange={(event) => control.preferVoice(event.target.value || null)}>
              {pickNone && <option value="">고르지 않음</option>}
              {state.voices.map((item, index) => (
                <option key={`${index}:${item.name}`} value={item.name}>
                  {item.localService ? item.name : `${item.name} (기기 밖)`}
                </option>
              ))}
            </select>
          </label>
        )}
        {notice && <p>{notice}</p>}
        <p role="status">{state.speakProblem ? SPEAK_PROBLEMS[state.speakProblem] : ''}</p>
      </div>
      <button type="button" className="secondary" onClick={control.turnOff}>
        음성 끄기
      </button>
    </section>
  );
}

function readRequestOf(game: GameView, index: number, text: string): ReadRequest {
  return { key: `${game.id}:${index}`, text, characterId: game.topic.sides[game.side].opponent?.id };
}

/** 판에서 마지막으로 나온 상대의 말을 읽어 달라는 요청. */
function lastOpponentRequest(game: GameView): ReadRequest | null {
  for (let index = game.messages.length - 1; index >= 0; index--) {
    const message = game.messages[index];
    if (message?.speaker === 'opponent') return readRequestOf(game, index, message.text);
  }
  return null;
}

function Game({ initial, voice, onLeave }: { initial: GameView; voice: Voice; onLeave: () => void }) {
  const [game, setGame] = useState(initial);
  const [draft, setDraft] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 듣기가 끝난 뒤 알릴 말(인식한 글을 넣었다, 문제가 생겼다). */
  const [heardNotice, setHeardNotice] = useState('');
  const bottom = useRef<HTMLDivElement | null>(null);
  /** 입력 칸의 최신 글. 듣기가 끝날 때 불리는 함수는 오래된 렌더의 값을 잡고 있을 수 있어 여기서 읽는다. */
  const latestDraft = useRef('');
  /** 이 턴의 받아쓰기 기록(인식 조각과 다시 말한 횟수). 보낼 때 넣은 방식과 다시 말한 횟수를 정한다. */
  const dictation = useRef<TurnDictation>(NEW_TURN);
  const draftBox = useRef<HTMLTextAreaElement | null>(null);
  const { state, control } = voice;
  const wasBlocked = useRef(state.blocked !== null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [game.messages.length, waiting, game.ended, error]);

  useEffect(() => {
    // 음성이 켜진 채로 판을 열면 마지막 상대의 말을 읽는다(꺼져 있으면 아무 일도 없다). 끝난 판은 읽지 않는다.
    const last = initial.ended ? null : lastOpponentRequest(initial);
    if (last) control.read(last);
    // 판 화면이 사라질 때 듣기와 읽기를 끊는다.
    return () => {
      control.cancelListening();
      control.stopReading();
    };
  }, [control, initial]);

  useEffect(() => {
    // 음성을 끄면 듣기의 지난 알림을 지운다. 다시 켰을 때 지난 일이 방금 일처럼 보이지 않게 한다.
    if (!state.on) setHeardNotice('');
  }, [state.on]);

  useEffect(() => {
    const blocked = state.blocked !== null;
    if (blocked === wasBlocked.current) return;
    wasBlocked.current = blocked;
    // 음성 입력이 꺼지면 [말하기]가 사라진다. 초점이 거기 있었으면 입력 칸으로 옮긴다.
    if (blocked && (document.activeElement === null || document.activeElement === document.body)) draftBox.current?.focus();
  }, [state.blocked]);

  function changeDraft(next: string) {
    latestDraft.current = next;
    setDraft(next);
  }

  async function send() {
    const text = draft.trim();
    if (!text || waiting || ending || game.ended || state.listening) return;
    const before = game;
    const entry = turnEntryOf(text, dictation.current);
    control.stopReading();
    setWaiting(true);
    setError(null);
    setHeardNotice('');
    // 보낸 말을 먼저 보이고, 결과가 오면 sendTurn이 맞춘 판으로 바꾼다.
    setGame({ ...before, messages: [...before.messages, { speaker: 'user', text }] });
    changeDraft('');
    try {
      const settled = await sendTurn(api, before, text, entry);
      setGame(settled.game);
      changeDraft(settled.draft);
      setError(settled.error);
      // 보내기에 성공해 입력 칸이 비워졌을 때만 기록을 비운다. 글이 입력 칸으로 돌아오면 기록도 그대로 둔다.
      if (settled.draft === '') dictation.current = NEW_TURN;
      // 새로 온 상대의 답을 읽는다. 응답을 잃었다가 서버에서 되찾은 답도 읽는다(음성이 꺼져 있으면 아무 일도 없다).
      const reply = settled.game.turn > before.turn ? lastOpponentRequest(settled.game) : null;
      if (reply) control.read(reply);
    } finally {
      setWaiting(false);
    }
  }

  /**
   * 듣기가 끝났다. 들은 글을 입력 칸에 넣고(takeDictation) 무슨 일이 있었는지 알린다. 보내는 것은 사용자가 한다.
   * 음성을 끄면서 넘긴 글이면 알림이 보이지 않으므로 입력 칸의 글을 바꾸지 않고 끝에 붙인다.
   */
  function onHeard(result: Heard) {
    const taken = takeDictation(latestDraft.current, dictation.current, result.transcript, game.maxTextLength, {
      appendOnly: result.turnedOff === true,
    });
    dictation.current = taken.turn;
    if (taken.draft !== latestDraft.current) changeDraft(taken.draft);
    // 음성 입력을 끄는 문제는 음성 줄이 이유를 보인다. 같은 말을 두 곳에서 알리지 않는다.
    const problem = result.problem !== null && !LISTEN_PROBLEMS[result.problem].blocks ? LISTEN_PROBLEMS[result.problem].message : null;
    setHeardNotice([taken.notice, problem].filter((notice) => notice !== null).join(' '));
  }

  function toggleListening() {
    if (state.listening) {
      control.finishListening();
      return;
    }
    setHeardNotice('');
    control.listen(onHeard);
  }

  async function end() {
    if (ending || waiting) return;
    control.cancelListening();
    control.stopReading();
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
  /** 말하기 단추를 보일 때. 음성 입력이 막혔으면(blocked) 이 페이지에서는 글로만 넣는다. */
  const canDictate = state.on && state.canListen && state.blocked === null;
  const canRead = state.on && state.canSpeak && state.voice !== null;
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
      {/* 켜자마자 마지막 상대의 말을 읽는다. 끝난 판과 답을 기다리는 중에는 읽지 않는다. */}
      <VoiceBar voice={voice} onTurnOn={() => control.turnOn(game.ended || waiting ? null : lastOpponentRequest(game))} />
      {/* 앱이 상대의 말을 소리로 읽는 동안에는 화면 낭독기가 같은 말을 겹쳐 읽지 않게 한다. */}
      <ol className="messages" aria-live={canRead ? 'off' : 'polite'}>
        {game.messages.map((message, index) => {
          const reading = state.reading === `${game.id}:${index}`;
          return (
            <li key={index} className={`message ${message.speaker}${reading ? ' reading' : ''}`}>
              <span className="who">{message.speaker === 'user' ? (index === 0 ? '나 · 고른 입장' : '나') : name}</span>
              <p>{message.text}</p>
              {message.speaker === 'opponent' && canRead && (
                <button
                  type="button"
                  className="secondary read"
                  disabled={state.listening}
                  onClick={() => (reading ? control.stopReading() : control.read(readRequestOf(game, index, message.text)))}
                >
                  {reading ? '멈춤' : '듣기'}
                </button>
              )}
            </li>
          );
        })}
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
            ref={draftBox}
            rows={3}
            value={draft}
            maxLength={game.maxTextLength}
            placeholder="반론이나 질문을 적어 보내세요."
            readOnly={waiting}
            onChange={(event) => changeDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {/* 듣는 동안의 글은 화면 낭독기가 읽지 않게 한다(aria-live 없음). 낭독 소리가 마이크로 들어가 받아쓴 글에 섞인다. */}
          {state.listening && (
            <p className="interim">
              듣는 중: {state.interim || '…'}
              <span className="muted">{LISTENING_HINT}</span>
            </p>
          )}
          {/* 듣기가 끝난 뒤의 일(글을 넣었다, 문제가 생겼다)만 알린다. */}
          {state.on && state.canListen && (
            <p className="muted voice-status" role="status">
              {state.listening ? '' : heardNotice}
            </p>
          )}
          <div className="actions">
            <span className="muted">
              {draft.length} / {game.maxTextLength}자 · ⌘ 또는 Ctrl + Enter로 보내기
            </span>
            {canDictate && (
              // 듣는 중인지는 단추의 글자가 알린다. aria-pressed를 함께 쓰면 '말 마치기, 눌림'처럼 겹쳐 읽힌다.
              <button
                type="button"
                className={state.listening ? undefined : 'secondary'}
                onClick={toggleListening}
                disabled={!state.listening && (waiting || ending || state.place === 'preparing')}
              >
                {state.listening ? '말 마치기' : '말하기'}
              </button>
            )}
            <button type="button" className="secondary" onClick={() => void end()} disabled={waiting || ending}>
              끝내기
            </button>
            {/* 듣는 동안에는 보내지 않는다. 인식된 글이 입력 칸에 들어온 것을 보고 보내게 한다. */}
            <button type="submit" disabled={waiting || ending || state.listening || !draft.trim()}>
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
      {/* 맨 아래 표시는 오류 문단보다 뒤에 둔다. 앞에 두면 막힌 턴과 끝내기의 메시지가 화면 바로 아래에 놓인다. */}
      <div ref={bottom} />
    </section>
  );
}
