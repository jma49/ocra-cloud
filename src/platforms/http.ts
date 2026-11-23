import { deadline } from "../deadline.js";
import { type CacheOptions, cachedFetch } from "./answer-cache.js";
import { notePlatformLimit } from "./rate-limit.js";

const TIMEOUT_MS = 10_000;

/** A platform call: never followed, since a redirect would resend the user's token elsewhere. */
async function send(url: string, init: RequestInit, options?: CacheOptions): Promise<Response> {
  const res = await cachedFetch(
    url,
    init,
    (u, i) => {
      // The deadline may pass while the cache reads its key, before the call starts.
      i.signal?.throwIfAborted();
      return fetch(u, { ...i, redirect: "manual" });
    },
    options,
  );
  notePlatformLimit(res);
  return res;
}

/**
 * What `read` makes of a platform call's answer; null when the call failed,
 * was refused or took too long, or `read` threw. `signal` stops it early.
 */
export async function platformRead<T>(
  url: string,
  init: RequestInit,
  read: (res: Response) => Promise<T>,
  signal?: AbortSignal,
): Promise<T | null> {
  const clock = deadline(TIMEOUT_MS, ...(signal ? [signal] : []));
  try {
    const res = await send(url, { ...init, signal: clock.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return await read(res);
  } catch {
    return null;
  } finally {
    clock.clear();
  }
}

/** A platform call's JSON answer; null when it failed, was refused or took too long. */
export const platformCall = <T>(url: string, init: RequestInit = {}): Promise<T | null> =>
  platformRead(url, init, (res) => res.json() as Promise<T>);

/** The answer's bytes, or null past `max`: the stream is cancelled as soon as it passes. */
export async function boundedBytes(res: Response, max: number): Promise<Uint8Array | null> {
  if (Number(res.headers.get("content-length") ?? "0") > max || !res.body) {
    await res.body?.cancel().catch(() => {});
    return res.body ? null : new Uint8Array(0);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** A write's status and JSON answer; null when it failed to reach the platform or took too long. */
export async function platformSend<T>(
  url: string,
  init: RequestInit,
  options?: CacheOptions,
): Promise<{ status: number; body: T | null } | null> {
  const clock = deadline(TIMEOUT_MS);
  try {
    const res = await send(url, { ...init, signal: clock.signal }, options);
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: null };
    }
    const body = (await res.json().catch(() => null)) as T | null;
    return { status: res.status, body };
  } catch {
    return null;
  } finally {
    clock.clear();
  }
}

/**
 * A call's status and JSON answer read to at most `max` bytes; null when it
 * failed, took too long, was larger or was not JSON.
 */
export async function platformJson<T>(
  url: string,
  init: RequestInit,
  max: number,
): Promise<{ status: number; body: T | null } | null> {
  const clock = deadline(TIMEOUT_MS);
  try {
    const res = await send(url, { ...init, signal: clock.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: null };
    }
    const bytes = await boundedBytes(res, max);
    if (!bytes) return null;
    return { status: res.status, body: JSON.parse(new TextDecoder().decode(bytes)) as T };
  } catch {
    return null;
  } finally {
    clock.clear();
  }
}
