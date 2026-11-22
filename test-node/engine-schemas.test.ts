import { configJsonSchema } from "@open-cr-agent/cli/internal";
import { repoRuleSchema } from "@open-cr-agent/core/internal";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONFIG_JSON_SCHEMA, CONFIG_SCHEMA_ID, RULES_JSON_SCHEMA } from "../src/engine-schemas.js";

// The console checks a repository's configuration with the engine's own
// schemas; after an engine bump, `node scripts/engine-schemas.ts` makes them
// again, and this fails until it has.

describe("the engine's schemas the console checks with", () => {
  it("are the installed engine's", () => {
    const config = configJsonSchema();
    expect(CONFIG_JSON_SCHEMA).toEqual(config);
    expect(CONFIG_SCHEMA_ID).toBe(config.$id);
    expect(RULES_JSON_SCHEMA).toEqual(
      z.toJSONSchema(z.object({ rules: z.array(repoRuleSchema) }), {
        target: "draft-2020-12",
        io: "input",
      }),
    );
  });
});
