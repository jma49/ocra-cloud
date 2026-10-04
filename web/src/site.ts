// Where the console links to, and which deployment it is.

export const DOCS = "https://ocracloud.com/docs";
export const GITHUB = "https://github.com/jma49/Open-CR-Agent";
export const PRODUCTION_HOST = "app.ocracloud.com";

/** The tag beside the brand: "dev" marks every host but production. */
export function brandTag(host: string): string {
  return host === PRODUCTION_HOST ? "cloud" : "cloud · dev";
}

/** "any of 46 providers" once the list is loaded; no stale number before. */
export function anyProvider(count: number | undefined): string {
  return count ? `any of ${count} providers` : "any supported provider";
}
