// Files a reviewer rarely reads line by line: lock files, generated code and
// vendored copies. They start folded, named for what they are, one click away.

export type FoldReason = "lock" | "generated" | "vendored";

const LOCK_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "go.sum",
  "flake.lock",
  "podfile.lock",
  "packages.lock.json",
  "pubspec.lock",
  "mix.lock",
]);

const VENDORED =
  /(?:^|\/)(?:vendor|vendors|third_party|third-party|node_modules|bower_components)\//;

const GENERATED =
  /(?:\.(?:generated|gen|pb|g)\.[a-z]+$|_pb2(?:_grpc)?\.py$|\.pb\.go$|_generated\.[a-z]+$|\.min\.(?:js|css)$|\.map$|\.snap$)|(?:^|\/)(?:__generated__|generated|dist)\//;

/** Why a path starts folded, or null for a file read as usual. */
export function foldReason(path: string): FoldReason | null {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (LOCK_FILES.has(name)) return "lock";
  if (VENDORED.test(lower)) return "vendored";
  if (GENERATED.test(lower)) return "generated";
  return null;
}

export const FOLD_LABEL: Record<FoldReason, string> = {
  lock: "Lock file",
  generated: "Generated",
  vendored: "Vendored",
};
