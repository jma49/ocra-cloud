import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import { readJson, SMALL_BODY } from "./body.js";
import { type BodyIssue, ERROR_STATUS, type ErrorCode } from "./contract/index.js";
import type { AppEnv } from "./types.js";

// The API's boundary: every request body goes through jsonBody (a schema,
// read with the streamed limit of src/body.ts), every refusal through
// apiError (a code of the contract's ErrorCode, with its one status).

/**
 * `{ "error": code, ...extra }` with the code's status (ERROR_STATUS). The
 * device flow's RFC 8628 codes answer 400, or `status` when the RFC leaves
 * it open (slow_down from a rate limit is 429).
 */
export function apiError(
  c: Context,
  code: ErrorCode,
  extra: Record<string, unknown> = {},
  status?: ContentfulStatusCode,
) {
  const fixed = Object.hasOwn(ERROR_STATUS, code)
    ? ERROR_STATUS[code as keyof typeof ERROR_STATUS]
    : 400;
  return c.json({ error: code, ...extra }, status ?? fixed);
}

/** Where a body did not fit its schema, for the `issues` of invalid_body. */
function issuesOf(error: z.ZodError): BodyIssue[] {
  return error.issues.map((i) => ({
    path: i.path.filter((p): p is string | number => typeof p !== "symbol"),
    message: i.message,
  }));
}

/**
 * Reads the JSON body (at most `max` bytes; past it, 413 body_too_large) and
 * checks it against `schema`; the handler reads the result with
 * `c.req.valid("json")`. A body that does not fit answers invalid_body with
 * its issues, or `invalid` (RFC 8628's invalid_request for the device flow).
 */
export function jsonBody<S extends z.ZodType>(
  schema: S,
  options: { max?: number; invalid?: "invalid_body" | "invalid_request" } = {},
): MiddlewareHandler<AppEnv, string, { in: { json: z.input<S> }; out: { json: z.output<S> } }> {
  const { max = SMALL_BODY, invalid = "invalid_body" } = options;
  return async (c, next) => {
    const parsed = schema.safeParse(await readJson(c, max));
    if (!parsed.success) {
      return invalid === "invalid_body"
        ? apiError(c, invalid, { issues: issuesOf(parsed.error) })
        : apiError(c, invalid);
    }
    c.req.addValidatedData("json", parsed.data as object);
    await next();
  };
}
