import type { CLOUD_PREFIX } from "@open-cr-agent/cloud-contract";

// A model ocra Cloud's gateway serves is named ocra-<provider>/<model>: the
// only place that spells the form out. The contract's isCloudModel says
// whether a name is a valid one; these take a name apart and put it back,
// and accept an empty provider or model, as a half-filled form has.

// The contract's prefix, checked by type: a value import would bring the
// contract's schemas, and zod with them, into the web bundle.
const PREFIX: typeof CLOUD_PREFIX = "ocra-";

export type ModelRef = { provider: string; model: string };

/** The provider and model of an ocra-<provider>/<model> name; null for any other name. */
export function parseModelId(id: string): ModelRef | null {
  const slash = id.indexOf("/");
  if (!id.startsWith(PREFIX) || slash < 0) return null;
  return { provider: id.slice(PREFIX.length, slash), model: id.slice(slash + 1) };
}

/** The ocra-<provider>/<model> name; without a model, the start of one. */
export function formatModelId(provider: string, model = ""): string {
  return `${PREFIX}${provider}/${model}`;
}
