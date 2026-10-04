export type Me = { login: string; githubId: number; session: "web" | "cli"; since: string };
export type ProviderInfo = {
  name: string;
  label: string;
  group: "Major" | "China" | "Platforms";
  base: string;
  paths: string[];
};
export type Key = { provider: string; last4: string; createdAt: string };
export type Call = {
  id: string;
  provider: string;
  path: string;
  model: string | null;
  status: number;
  tokensIn: number;
  tokensOut: number;
  ms: number;
  createdAt: string;
};
export type Day = {
  day: string;
  calls: number;
  tokensIn: number;
  tokensOut: number;
  errors: number;
  byModel: Record<string, { calls: number; tokens: number }>;
};
export type Usage = {
  days: number;
  today: number;
  dailyLimit: number;
  series: Day[];
  models: { model: string; provider: string; calls: number; tokensIn: number; tokensOut: number }[];
  calls: Call[];
};
export type Session = {
  id: string;
  kind: "web" | "cli";
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  current: boolean;
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? String(res.status));
  return body as T;
}

const nf = new Intl.NumberFormat("en-US");
export const num = (n: number) => nf.format(n);
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}
export const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
