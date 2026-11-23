import { repoRuleSchema } from "@open-cr-agent/core/internal";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RULES_JSON_SCHEMA } from "../src/engine-schemas.js";

// The console checks a repository's rules with the engine's own schema;
// after an engine bump, `node scripts/engine-schemas.ts` makes it again, and
// this fails until it has.

describe("the engine's rules schema the console checks with", () => {
  it("is the installed engine's", () => {
    expect(RULES_JSON_SCHEMA).toEqual(
      z.toJSONSchema(z.object({ rules: z.array(repoRuleSchema) }), {
        target: "draft-2020-12",
        io: "input",
      }),
    );
  });
});
