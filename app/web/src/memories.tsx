// 기억 화면 조각. 판 화면(상대 답 아래의 넘긴 기록), 시작 화면(이 주제의 지난 기록), 목록 화면(내 기억)이
// 같은 기록 항목(MemoryItem)을 함께 쓴다. 항목에서 바로 고치거나 지운다.
// 지우는 것은 기억 줄뿐이다. 판 기록과 턴 원문은 서버에 남는다.

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { MemoryKind, MemoryView, PassedMemoryView, TopicView } from '../../server/contract.ts';
import { api } from './api.ts';
import { MEMORIES_PER_TURN, MEMORY_MAX } from './memory-limits.ts';

const KIND_LABEL: Readonly<Record<MemoryKind, string>> = { claim: '주장', ground: '근거', shift: '바뀐 생각', weakness: '약점' };

const DELETED_NOTE = '기억만 지웠습니다. 판 기록은 남습니다.';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '알 수 없는 문제가 생겼습니다.';
}

const keptOf = (memory: MemoryView): PassedMemoryView => ({
  id: memory.id,
  state: 'kept',
  kind: memory.kind,
  text: memory.text,
  edited: memory.edited,
});

/**
 * 이 화면에서 고치거나 지운 기억. 서버에서 받은 목록 위에 덮어 보인다.
 * 판 화면에서는 같은 기억이 여러 턴에 넘어갔을 수 있어 한 곳에서 바꾸면 모두 바뀌고,
 * 답을 기다리는 사이에 바꿔도 답과 함께 온 판이 바꾼 것을 되돌리지 않는다.
 */
export function useMemoryChanges() {
  const [changes, setChanges] = useState<ReadonlyMap<string, PassedMemoryView>>(() => new Map());
  const show = useCallback((memory: PassedMemoryView) => changes.get(memory.id) ?? memory, [changes]);
  const change = useCallback((next: PassedMemoryView) => setChanges((prev) => new Map(prev).set(next.id, next)), []);
  return { show, change };
}

type ItemMode = { kind: 'view' } | { kind: 'edit'; draft: string } | { kind: 'confirm' };

/**
 * 기록 하나: 종류, 글, 고침 표시, [고치기], [지우기]. 고치기는 그 자리의 입력 칸이고,
 * 지우기는 브라우저의 확인 창 대신 그 자리에서 한 번 더 묻는다. 지운 기록은 글 없이 '지운 기록'으로 남는다.
 */
function MemoryItem({ memory, onChange }: { memory: PassedMemoryView; onChange: (next: PassedMemoryView) => void }) {
  const [mode, setMode] = useState<ItemMode>({ kind: 'view' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 이 자리에서 지웠는지. 같은 기억이 다른 턴에도 있으면 그곳에는 알림을 겹쳐 보이지 않는다. */
  const [deletedHere, setDeletedHere] = useState(false);
  const item = useRef<HTMLLIElement | null>(null);
  const editButton = useRef<HTMLButtonElement | null>(null);
  const deleteButton = useRef<HTMLButtonElement | null>(null);
  /** 입력 칸이나 확인을 닫은 뒤 초점을 돌려줄 단추. 누른 단추가 사라졌다 다시 생기므로 그린 뒤에 옮긴다. */
  const returnTo = useRef<'edit' | 'delete' | null>(null);

  useEffect(() => {
    if (mode.kind !== 'view' || returnTo.current === null) return;
    (returnTo.current === 'edit' ? editButton : deleteButton).current?.focus();
    returnTo.current = null;
  }, [mode]);

  useEffect(() => {
    // 지운 자리에는 단추가 없다. 초점을 항목으로 옮겨, 키보드로 쓰는 사람이 자리를 잃지 않게 한다.
    if (memory.state === 'deleted' && deletedHere) item.current?.focus();
  }, [memory.state, deletedHere]);

  function close(to: 'edit' | 'delete') {
    returnTo.current = to;
    setError(null);
    setMode({ kind: 'view' });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (mode.kind !== 'edit' || busy) return;
    setBusy(true);
    setError(null);
    try {
      onChange(keptOf(await api.editMemory(memory.id, mode.draft)));
      close('edit');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteMemory(memory.id);
      setDeletedHere(true);
      setMode({ kind: 'view' });
      onChange({ id: memory.id, state: 'deleted' });
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') close('edit');
  }

  // 알림 칸은 늘 두어, 지운 뒤 생긴 글을 화면 낭독기가 읽게 한다.
  // 지우기 전과 뒤의 자식 구성이 달라, key가 없으면 React가 이 칸을 다른 노드로 바꿔 끼워 미리 있던 알림 칸이 아니게 된다.
  const note = (
    <span key="note" className="memory-note" role="status">
      {memory.state === 'deleted' && deletedHere ? DELETED_NOTE : ''}
    </span>
  );

  if (memory.state === 'deleted') {
    return (
      <li className="memory deleted" ref={item} tabIndex={-1}>
        <div className="memory-body">
          <span className="memory-text">지운 기록</span>
          {note}
        </div>
      </li>
    );
  }

  let tail;
  if (mode.kind === 'edit') {
    tail = (
      <form className="memory-edit" onSubmit={(event) => void save(event)} aria-busy={busy}>
        <textarea
          rows={2}
          value={mode.draft}
          maxLength={MEMORY_MAX}
          aria-label={`${KIND_LABEL[memory.kind]} 기록 고치기`}
          autoFocus
          onChange={(event) => setMode({ kind: 'edit', draft: event.target.value })}
          onKeyDown={onKeyDown}
        />
        <div className="memory-actions">
          <span className="muted">
            {mode.draft.length} / {MEMORY_MAX}자
          </span>
          <button type="button" className="secondary" onClick={() => close('edit')} disabled={busy}>
            그만두기
          </button>
          <button type="submit" disabled={busy || !mode.draft.trim()}>
            저장
          </button>
        </div>
      </form>
    );
  } else if (mode.kind === 'confirm') {
    tail = (
      <div className="memory-actions memory-confirm" role="group" aria-label="기록 지우기">
        <span>이 기록을 지울까요? 상대에게 더 넘기지 않습니다. 판 기록은 남습니다.</span>
        <button type="button" className="secondary" onClick={() => close('delete')} disabled={busy} autoFocus>
          그만두기
        </button>
        <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>
          정말 지우기
        </button>
      </div>
    );
  } else {
    tail = (
      <div className="memory-actions">
        <button type="button" className="secondary" ref={editButton} onClick={() => setMode({ kind: 'edit', draft: memory.text })}>
          고치기
        </button>
        <button type="button" className="secondary" ref={deleteButton} onClick={() => setMode({ kind: 'confirm' })}>
          지우기
        </button>
      </div>
    );
  }

  return (
    <li className="memory" ref={item}>
      <div className="memory-body">
        <span className="memory-kind">{KIND_LABEL[memory.kind]}</span>
        <span className="memory-text">{memory.text}</span>
        {memory.edited && <span className="memory-edited">고침</span>}
        {note}
      </div>
      {tail}
      {error && (
        <span className="memory-error" role="alert">
          {error}
        </span>
      )}
    </li>
  );
}

function MemoryList({
  memories,
  show,
  onChange,
  id,
}: {
  memories: readonly PassedMemoryView[];
  show: (memory: PassedMemoryView) => PassedMemoryView;
  onChange: (next: PassedMemoryView) => void;
  id?: string;
}) {
  return (
    <ul className="memories" id={id}>
      {memories.map((memory) => (
        <MemoryItem key={memory.id} memory={show(memory)} onChange={onChange} />
      ))}
    </ul>
  );
}

/**
 * 판 화면: 상대의 답 아래에 그 답을 만들 때 넘긴 기록. 처음에는 접어 둔다.
 * 고친 기록은 지금 글이다. 상대가 받은 글은 고치기 전 글일 수 있다.
 */
export function PassedMemories({
  memories,
  show,
  onChange,
}: {
  memories: readonly PassedMemoryView[];
  show: (memory: PassedMemoryView) => PassedMemoryView;
  onChange: (next: PassedMemoryView) => void;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="passed">
      <button type="button" className="passed-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen(!open)}>
        이 답을 만들 때 넘긴 기록 {memories.length}개
      </button>
      <div hidden={!open}>
        <MemoryList id={listId} memories={memories} show={show} onChange={onChange} />
      </div>
    </div>
  );
}

/** 서버에서 기억 목록을 한 번 받는다. 화면이 사라진 뒤에 온 답은 버린다. */
function useFetchedMemories(topicId?: string) {
  const [memories, setMemories] = useState<MemoryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .memories(topicId)
      .then((data) => live && setMemories(data.memories))
      .catch((e: unknown) => live && setError(messageOf(e)));
    return () => {
      live = false;
    };
  }, [topicId]);
  return { memories, error };
}

/** 시작 화면: 이 주제의 지난 기록. 최근 것부터이고, 기록이 없으면 아무것도 보이지 않는다. */
export function TopicMemories({ topicId }: { topicId: string }) {
  const { memories, error } = useFetchedMemories(topicId);
  const { show, change } = useMemoryChanges();
  if (error) {
    return (
      <p className="error" role="alert">
        지난 기록을 불러오지 못했습니다. {error}
      </p>
    );
  }
  if (!memories || memories.length === 0) return null;
  return (
    <section className="memory-section" aria-labelledby="topic-memories-title">
      <h3 id="topic-memories-title">이 주제의 지난 기록</h3>
      <p className="muted">최근 것부터 보입니다. 상대에게 최근 {MEMORIES_PER_TURN}개까지 넘깁니다.</p>
      <MemoryList memories={memories.map(keptOf)} show={show} onChange={change} />
    </section>
  );
}

/** 목록 화면: 내 기억(최근 100개)을 주제별로. 주제의 차례는 그 주제의 가장 최근 기억 차례다. 기록이 없으면 아무것도 보이지 않는다. */
export function MyMemories({ topics }: { topics: TopicView[] | null }) {
  const { memories, error } = useFetchedMemories();
  const { show, change } = useMemoryChanges();
  if (error) {
    return (
      <p className="error" role="alert">
        내 기억을 불러오지 못했습니다. {error}
      </p>
    );
  }
  // 주제를 불러오기 전에는 그리지 않는다. 그리면 모든 묶음이 '지금은 없는 주제'로 보인다.
  if (!memories || memories.length === 0 || !topics) return null;
  const groups = new Map<string, PassedMemoryView[]>();
  for (const memory of memories) {
    const list = groups.get(memory.topicId) ?? [];
    list.push(keptOf(memory));
    groups.set(memory.topicId, list);
  }
  return (
    <section className="memory-section" aria-labelledby="my-memories-title">
      <h2 id="my-memories-title">내 기억</h2>
      <p className="muted">판을 끝내고 기록을 남기면 생깁니다. 같은 주제의 다음 판에서 상대에게 최근 {MEMORIES_PER_TURN}개까지 넘깁니다.</p>
      {[...groups].map(([topicId, list]) => (
        <div key={topicId} className="memory-group">
          <h3>{topics.find((topic) => topic.id === topicId)?.question ?? '지금은 없는 주제'}</h3>
          <MemoryList memories={list} show={show} onChange={change} />
        </div>
      ))}
    </section>
  );
}
