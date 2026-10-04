import { describe, expect, it } from "vitest";
import { ERROR_STATUS } from "../../src/contract/index.js";
import { ApiError, type MESSAGES, why } from "./api.js";

describe("ocra Cloud's error codes", () => {
  it("each read as the words its status reads as, so a code never changes what the person sees", () => {
    for (const [code, status] of Object.entries(ERROR_STATUS)) {
      expect(why(new ApiError(status, code as keyof typeof MESSAGES)), code).toBe(
        why(new ApiError(status, undefined)),
      );
    }
  });
});
