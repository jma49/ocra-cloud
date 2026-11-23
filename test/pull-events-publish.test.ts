/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

// What moves an account's inbox change time (src/db/pull-changes.ts) tells
// its open consoles: a webhook's touchPulls only through touchAndPublish,
// and every stored review upload with publishReview.
const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const callers = (pattern: RegExp) =>
  Object.entries(sources)
    .filter(([file, text]) => !file.includes("/db/") && pattern.test(text))
    .map(([file]) => file.replace("../src/", ""))
    .sort();

describe("the inbox's change time", () => {
  it("is moved by webhooks only where the move is published", () => {
    expect(callers(/\btouchPulls\b/)).toEqual(["pull-events/publish.ts"]);
    expect(sources["../src/pull-events/publish.ts"]).toMatch(/touchPulls[\s\S]*hub\.publish/);
    expect(callers(/\btouchAndPublish\(/)).toEqual([
      "auto-review/webhooks.ts",
      "pull-events/publish.ts",
      "webhooks.ts",
    ]);
  });

  it("is moved by stored reviews only where the review is published", () => {
    const storing = callers(/\.insertReview\(/);
    expect(storing).toEqual(["reviews.ts"]);
    for (const file of storing) expect(sources[`../src/${file}`]).toMatch(/publishReview\(c, id\)/);
  });
});
