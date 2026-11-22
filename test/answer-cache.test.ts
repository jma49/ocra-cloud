import { beforeEach, describe, expect, it } from "vitest";
import { cachedFetch, forgetPlatformAnswers } from "../src/platforms/answer-cache.js";

// The platforms' GET answers kept in memory: per credential, revalidated by
// ETag, answered without asking only for a refusal the caller names.

beforeEach(forgetPlatformAnswers);

function platform(body: () => BodyInit, headers: Record<string, string> = {}) {
  const asked: (string | null)[] = [];
  const fetcher = async (_url: string, init: RequestInit) => {
    const sentTag = new Headers(init.headers).get("if-none-match");
    asked.push(sentTag);
    if (sentTag && sentTag === headers.etag) return new Response(null, { status: 304 });
    return new Response(body(), { status: 200, headers });
  };
  return { asked, fetcher };
}

const as = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe("kept platform answers", () => {
  it("revalidates with the ETag, and never shares an answer between credentials", async () => {
    const p = platform(() => "one", { etag: '"1"' });
    const url = "https://api.example/repos/o/r";
    expect(await (await cachedFetch(url, as("a"), p.fetcher)).text()).toBe("one");
    expect(await (await cachedFetch(url, as("a"), p.fetcher)).text()).toBe("one");
    expect(await (await cachedFetch(url, as("b"), p.fetcher)).text()).toBe("one");
    expect(p.asked).toEqual([null, '"1"', null]);
  });

  it("answers a refusal it was asked to remember without asking again", async () => {
    let asked = 0;
    const fetcher = async () => {
      asked++;
      return Response.json({ message: "Resource not accessible" }, { status: 403 });
    };
    const url = "https://api.example/repos/o/r/branches/main/protection";
    const remember = { remember: { statuses: [403], ms: 60_000 } };
    expect((await cachedFetch(url, as("a"), fetcher, remember)).status).toBe(403);
    expect((await cachedFetch(url, as("a"), fetcher, remember)).status).toBe(403);
    expect(asked).toBe(1);
  });

  it("hands an answer too large to keep through whole, and asks for it again", async () => {
    const big = "x".repeat(600 * 1024);
    const p = platform(() => big, { etag: '"big"' });
    const url = "https://api.example/repos/o/r/pulls/1/files";
    expect((await (await cachedFetch(url, as("a"), p.fetcher)).text()).length).toBe(big.length);
    await (await cachedFetch(url, as("a"), p.fetcher)).text();
    expect(p.asked).toEqual([null, null]);
  });

  it("leaves writes and calls without a credential alone", async () => {
    const p = platform(() => "{}", { etag: '"1"' });
    const url = "https://api.example/repos/o/r";
    await cachedFetch(url, { method: "POST", ...as("a"), body: "{}" }, p.fetcher);
    await cachedFetch(url, { method: "POST", ...as("a"), body: "{}" }, p.fetcher);
    await cachedFetch(url, {}, p.fetcher);
    await cachedFetch(url, {}, p.fetcher);
    expect(p.asked).toEqual([null, null, null, null]);
  });
});
