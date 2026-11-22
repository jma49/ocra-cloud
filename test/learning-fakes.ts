import { githubFake } from "./platform-fakes.js";

export const HEAD = "a".repeat(40);
export const BLOB = "b".repeat(40);
export const OTHER = "c".repeat(40);
export const PR_HEAD = "d".repeat(40);

type Sent = { method: string; url: string; body: unknown };
type Route = (body: unknown) => Response;

/** A learning file of the contract's format. */
export const learningText = (
  title = "Close every pool",
  body = "Pools leak when a handler throws.",
) =>
  `---\ntitle: ${title}\npaths:\n  - "src/db/**"\nkeywords:\n  - pool\ncreated: 2026-10-01\n---\n\n${body}\n`;

/**
 * Answers the routes given, by `METHOD url`, and records every call but a
 * GET (a key ending in `*` matches by prefix); GitHub's GraphQL goes to `graphql`, with the query's variables.
 */
export function platform(
  routes: Record<string, Route>,
  graphql?: (variables: Record<string, string>) => Response,
) {
  const sent: Sent[] = [];
  githubFake({
    extra: async (req) => {
      const body: unknown =
        req.method === "GET" || req.method === "HEAD" ? null : await req.json().catch(() => null);
      if (req.url === "https://api.github.com/graphql" && graphql) {
        return graphql((body as { variables: Record<string, string> }).variables);
      }
      const key = `${req.method} ${req.url}`;
      const route =
        routes[key] ??
        Object.entries(routes).find(
          ([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)),
        )?.[1];
      if (!route) return undefined;
      if (req.method !== "GET") sent.push({ method: req.method, url: req.url, body });
      return route(body);
    },
  });
  return sent;
}

/** GitHub's answers for octo/api with its default branch `main` at HEAD. */
export const githubHead = {
  "GET https://api.github.com/repos/octo/api": () =>
    Response.json({ id: 1, full_name: "octo/api", default_branch: "main" }),
  "GET https://api.github.com/repos/octo/api/branches/main": () =>
    Response.json({ commit: { sha: HEAD } }),
};

/** GraphQL's answer for the files the variables name, from `files` by path. */
export function githubBlobs(files: Record<string, { oid: string; text: string }>) {
  return (variables: Record<string, string>) => {
    const repository: Record<string, unknown> = {};
    const at: Record<string, unknown> = {};
    for (let i = 0; variables[`p${i}`] !== undefined; i++) {
      const file = files[variables[`p${i}`] ?? ""];
      repository[`b${i}`] = file
        ? {
            oid: file.oid,
            byteSize: new TextEncoder().encode(file.text).byteLength,
            isBinary: false,
            isTruncated: false,
            text: file.text,
          }
        : null;
      at[`h${i}`] = { nodes: file ? [{ oid: OTHER, committedDate: "2026-11-01T00:00:00Z" }] : [] };
    }
    return Response.json({ data: { repository: { ...repository, at } } });
  };
}
