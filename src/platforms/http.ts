import { deadline } from "../deadline.js";

const TIMEOUT_MS = 10_000;

/** A platform call's JSON answer; null when it failed, was refused or took too long. */
export async function platformCall<T>(url: string, init: RequestInit = {}): Promise<T | null> {
  const clock = deadline(TIMEOUT_MS);
  try {
    // Not followed: a redirect would resend the user's token to another address.
    const res = await fetch(url, { ...init, redirect: "manual", signal: clock.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clock.clear();
  }
}
