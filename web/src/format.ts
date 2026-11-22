import type { ReviewSource } from "../../src/shared/index.js";

// How numbers and times read on the console's pages.

const nf = new Intl.NumberFormat("en-US");
export const num = (n: number) => nf.format(n);
/** "1 review", "2 reviews": a count with its noun in the right number. */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${num(n)} ${n === 1 ? one : many}`;
/** Dollars to the cent. */
export const usd = (n: number) => `$${n.toFixed(2)}`;
export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}
export function bytes(n: number): string {
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
/** How long ago, in a list's narrow column: "2m", "6h", "3d", then "Oct 4", or "Oct 2025" in another year. */
export function since(iso: string): string {
  const then = new Date(iso);
  const s = (Date.now() - then.getTime()) / 1000;
  if (s < 86400 * 30) return ago(iso).replace(" ago", "");
  const sameYear = then.getFullYear() === new Date().getFullYear();
  return then.toLocaleDateString(
    undefined,
    sameYear ? { month: "short", day: "numeric" } : { month: "short", year: "numeric" },
  );
}
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return date(iso);
}
/** A time range picker's option, the same words on every page. */
export const period = (days: number) => ({ value: days, label: `${days} days` });
export const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const SOURCES: Record<ReviewSource, string> = {
  local: "Local",
  github: "GitHub PR",
  gitlab: "GitLab MR",
};
export const sourceLabel = (source: ReviewSource) => SOURCES[source];
