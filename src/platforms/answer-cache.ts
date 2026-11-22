// Answers to the platforms' GET calls, kept in this isolate's memory under
// the credential that asked and the address. A kept answer with an ETag is
// asked again with If-None-Match: GitHub's 304 costs nothing of the user's
// hourly allowance, and the platform still checks the token each time, so
// nothing is answered from here that the platform would refuse. Only a
// refusal the caller names (`remember`) is answered for a few minutes
// without asking. A kept answer never outlives the isolate; nothing
// reaches storage.

const MAX_ENTRY_BYTES = 512 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;

type Kept = {
  status: number;
  etag: string | null;
  headers: [string, string][];
  body: Uint8Array;
  freshUntil: number;
};

const kept = new Map<string, Kept>();
let keptBytes = 0;

export type CacheOptions = {
  /** Statuses whose answer is kept and answered for `ms` without asking again. */
  remember?: { statuses: readonly number[]; ms: number };
};

/** Empties the kept answers (tests: their fakes share one token). */
export function forgetPlatformAnswers(): void {
  kept.clear();
  keptBytes = 0;
}

function replay(k: Kept): Response {
  return new Response(k.status === 204 ? null : k.body.slice(), {
    status: k.status,
    headers: k.headers,
  });
}

function drop(key: string) {
  const k = kept.get(key);
  if (!k) return;
  kept.delete(key);
  keptBytes -= k.body.byteLength;
}

function keep(key: string, k: Kept) {
  drop(key);
  kept.set(key, k);
  keptBytes += k.body.byteLength;
  // Map order is insertion order: the oldest go first.
  for (const old of kept.keys()) {
    if (keptBytes <= MAX_BYTES) break;
    drop(old);
  }
}

/**
 * The answer's bytes when they fit in `max`, else a response that still
 * holds every byte read so far: the caller reads it as if nothing was read.
 */
async function collect(
  res: Response,
  max: number,
): Promise<{ bytes: Uint8Array } | { res: Response }> {
  if (!res.body) return { bytes: new Uint8Array(0) };
  if (Number(res.headers.get("content-length") ?? "0") > max) return { res };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > max) {
      const rest = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
        },
        async pull(controller) {
          const next = await reader.read();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return { res: new Response(rest, { status: res.status, headers: res.headers }) };
    }
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return { bytes };
}

const isGet = (init: RequestInit) => (init.method ?? "GET").toUpperCase() === "GET";

/**
 * fetch(), with the GET calls that carry a credential answered as above.
 * `fetcher` is the plain call, so its own timeout and redirect rules hold.
 */
export async function cachedFetch(
  url: string,
  init: RequestInit,
  fetcher: (url: string, init: RequestInit) => Promise<Response>,
  options: CacheOptions = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const credential = headers.get("authorization") ?? headers.get("private-token");
  if (!credential || !isGet(init) || init.body != null) return fetcher(url, init);
  // The credential itself, not a digest of it: hashing would put an await
  // between the caller's deadline and its call. The map is memory only.
  const key = `${credential} ${headers.get("accept") ?? ""} ${url}`;
  const now = Date.now();
  const hit = kept.get(key);
  if (hit && hit.freshUntil > now) return replay(hit);
  if (hit?.etag) headers.set("if-none-match", hit.etag);
  const res = await fetcher(url, { ...init, headers });
  if (res.status === 304 && hit) {
    await res.body?.cancel().catch(() => {});
    keep(key, hit);
    return replay(hit);
  }
  const etag = res.status === 200 ? res.headers.get("etag") : null;
  // A refusal for the allowance itself ends when the allowance is back, not in `ms`.
  const limited =
    res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
  const remember = options.remember;
  const remembered = !limited && remember?.statuses.includes(res.status) === true;
  if (!etag && !remembered) {
    drop(key);
    return res;
  }
  const read = await collect(res, MAX_ENTRY_BYTES);
  if ("res" in read) {
    drop(key);
    return read.res;
  }
  const entry: Kept = {
    status: res.status,
    etag,
    headers: [...res.headers],
    body: read.bytes,
    freshUntil: remembered && remember ? now + remember.ms : 0,
  };
  keep(key, entry);
  return replay(entry);
}
