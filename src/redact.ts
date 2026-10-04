// Replaces secret-looking tokens before a finding is stored (ADR-0028, 2).
// The CLI runs the same pass before upload; this one is the server's own.
// It catches patterns, not every secret, and the data policy says so.

const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(ant-|or-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
];

// A long run of base64-ish characters mixing cases and digits: a likely key.
const HIGH_ENTROPY = /\b[A-Za-z0-9+/_-]{32,}={0,2}/g;
function looksRandom(s: string): boolean {
  return (
    /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s) && !/^[a-z]+$/i.test(s) && !s.includes("/")
  );
}

export function redact(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, "[redacted]");
  out = out.replace(HIGH_ENTROPY, (m) => (looksRandom(m) ? "[redacted]" : m));
  return { text: out, redacted: out !== text };
}
