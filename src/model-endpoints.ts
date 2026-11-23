import {
  GATEWAY_PATH,
  MODEL_ID,
  modelPriceSchema,
  PROVIDER_ID,
} from "@open-cr-agent/cloud-contract";
import { z } from "zod";
import type { AuthStyle, Provider } from "./providers.js";

// A self-hosted server's own model endpoints (MODEL_ENDPOINTS): a company's
// internal OpenAI-compatible gateways, declared by the operator as JSON. They
// join the built-in providers under their own ids, in the "Company" group.

/** The most endpoints one server declares. */
const MAX_ENDPOINTS = 20;

// A path a URL keeps as written: no `.` or `..` segment that would resolve
// out of the base to another endpoint of the server.
const path = z
  .string()
  .regex(GATEWAY_PATH)
  .refine((p) => new URL(p, "http://base.invalid").pathname === p, "a plain path");

const endpointSchema = z
  .object({
    id: z.string().regex(PROVIDER_ID),
    label: z.string().trim().min(1).max(60),
    base: z.string(),
    /** The paths the gateway forwards; an OpenAI-compatible chat route by default. */
    paths: z.array(path).min(1).max(10).default(["/v1/chat/completions"]),
    auth: z.enum(["bearer", "x-api-key"]).default("bearer"),
    /** A GET listing the models (OpenAI's /v1/models shape), which also checks a key. */
    models: path.optional(),
    /** The server's own key for the endpoint: every account uses it, and none stores one. */
    key: z.string().min(1).max(4096).optional(),
    /** What its models cost, in US dollars per million tokens, by model id. */
    prices: z.record(z.string().regex(MODEL_ID), modelPriceSchema).optional(),
  })
  .strict();

/** A base URL the gateway may append paths to: http(s), no credentials, query or fragment. */
function baseOf(raw: string, id: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`MODEL_ENDPOINTS: "${id}" has a base that is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`MODEL_ENDPOINTS: "${id}" needs an http or https base`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`MODEL_ENDPOINTS: "${id}" has a base with credentials, a query or a fragment`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * The endpoints MODEL_ENDPOINTS declares, by id; throws naming what is wrong,
 * so a server with a broken declaration does not start. `taken` are the ids
 * already in use (the built-in providers').
 */
export function modelEndpoints(
  raw: string | undefined,
  taken: ReadonlySet<string>,
): Map<string, Provider> {
  const found = new Map<string, Provider>();
  if (!raw?.trim()) return found;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("MODEL_ENDPOINTS is not JSON");
  }
  const parsed = z.array(endpointSchema).max(MAX_ENDPOINTS).safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`);
    throw new Error(`MODEL_ENDPOINTS is not a list of endpoints (${where.join("; ")})`);
  }
  for (const e of parsed.data) {
    if (taken.has(e.id)) throw new Error(`MODEL_ENDPOINTS: "${e.id}" is a built-in provider's id`);
    if (found.has(e.id)) throw new Error(`MODEL_ENDPOINTS: "${e.id}" is declared twice`);
    const auth: AuthStyle = e.auth;
    found.set(e.id, {
      label: e.label,
      group: "Company",
      base: baseOf(e.base, e.id),
      routes: e.paths.map((path) => ({ path, auth })),
      ...(e.models ? { verify: { path: e.models, auth } } : {}),
      ...(e.key ? { sharedKey: e.key } : {}),
      ...(e.prices ? { prices: e.prices } : {}),
    });
  }
  return found;
}
