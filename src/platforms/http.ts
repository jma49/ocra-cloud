import { deadline } from "../deadline.js";

const TIMEOUT_MS = 10_000;

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
    // Not followed: a redirect would resend the user's token to another address.
    const res = await fetch(url, { ...init, redirect: "manual", signal: clock.signal });
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
): Promise<{ status: number; body: T | null } | null> {
  const clock = deadline(TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, redirect: "manual", signal: clock.signal });
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
