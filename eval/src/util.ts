// 여러 곳에서 쓰는 작은 도구들. 외부 의존성 없이 둔다.

/** 문자열을 32비트 정수로 바꾼다(FNV-1a). 암호용이 아니라 고정된 섞기용이다. */
export function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 씨앗이 같으면 같은 수열을 내는 난수 생성기(mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `--name value`와 `--flag` 꼴의 인자를 읽는다. */
export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function argString(args: Record<string, string | boolean>, key: string, fallback?: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

export function argNumber(args: Record<string, string | boolean>, key: string, fallback: number): number {
  const value = args[key];
  if (typeof value !== 'string') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`--${key}에는 숫자가 와야 합니다.`);
  return n;
}

/** 1 이상의 정수만 받는 인자. */
export function argCount(args: Record<string, string | boolean>, key: string, fallback: number): number {
  const n = argNumber(args, key, fallback);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${key}에는 1 이상의 정수가 와야 합니다.`);
  return n;
}

/** 쉼표로 나눈 목록 인자. 없으면 undefined. */
export function argList(args: Record<string, string | boolean>, key: string): string[] | undefined {
  const value = argString(args, key);
  if (value === undefined) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** q(0~1) 분위수. 두 값 사이는 직선으로 잇는다. q가 0.5이면 median과 같다. */
export function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sorted[lower] as number;
  return low + ((sorted[upper] as number) - low) * (position - lower);
}

/** 모델의 답에서 첫 번째 JSON 객체를 꺼낸다. 앞뒤에 다른 글이나 코드 울타리가 있어도 된다. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('답에 JSON 객체가 없습니다.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('JSON 객체가 닫히지 않았습니다.');
}

/** CSV 한 칸을 규칙에 맞게 감싼다. */
function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** 따옴표, 쉼표, 줄바꿈이 들어간 칸을 처리하는 CSV 읽기. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r[0] ?? '') !== '');
}

/** 한 번에 `limit`개까지만 동시에 돌린다. 결과의 순서는 입력과 같다. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '-';
}
