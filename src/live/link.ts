import { hmacHex, randomToken, sameText } from "../crypto.js";

// A run's share link carries an HMAC of the run and its nonce under the
// server's secret, so the server stores no token and the owner can copy the
// link again at any time; a new nonce replaces the link.

const tokenOf = (secret: string, liveRunId: string, nonce: string) =>
  hmacHex(secret, `live-link:${liveRunId}:${nonce}`);

export const newNonce = () => randomToken("");

export async function linkUrl(origin: string, secret: string, liveRunId: string, nonce: string) {
  return `${origin}/live/${liveRunId}?k=${await tokenOf(secret, liveRunId, nonce)}`;
}

/** Checks the request's `k` against a run's nonce. */
export function linkCheck(secret: string, liveRunId: string, token: string | undefined) {
  return async (nonce: string) =>
    token !== undefined && sameText(token, await tokenOf(secret, liveRunId, nonce));
}
