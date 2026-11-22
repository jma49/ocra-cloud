// The stand-in GitLab's project and the people on it.

export const PROJECT = { id: 42, path: "platform/payments" };
export const BOT = { id: 900, username: "ocra-bot", token: "glpat-ocra-bot" };
export const PERSON = { id: 7, username: "dana", token: "gloas-dana" };
/** The merge request reviewed: feature into main, closing ISSUE. */
export const MR = 3;
/** The merge request stacked on it: backoff into feature. */
export const STACKED = 4;
export const ISSUE = { iid: 12, title: "Retries stop one short", labels: ["bug"] };

export type User = { id: number; username: string };
export type Recorded = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
};
export type Json = (value: unknown, status?: number) => void;
