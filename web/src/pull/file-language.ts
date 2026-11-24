// The language a file is written in, by its name, as a file's head names it.
// Only kinds people read as code or config are named; any other has none.

const BY_NAME: Record<string, string> = {
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  "cmakelists.txt": "CMake",
  gemfile: "Ruby",
  rakefile: "Ruby",
};

const BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSON with Comments",
  css: "CSS",
  scss: "SCSS",
  sass: "Sass",
  less: "Less",
  html: "HTML",
  htm: "HTML",
  md: "Markdown",
  markdown: "Markdown",
  mdx: "MDX",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  swift: "Swift",
  m: "Objective-C",
  mm: "Objective-C++",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  cs: "C#",
  fs: "F#",
  rb: "Ruby",
  php: "PHP",
  pl: "Perl",
  lua: "Lua",
  r: "R",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  erl: "Erlang",
  hs: "Haskell",
  clj: "Clojure",
  vue: "Vue",
  svelte: "Svelte",
  astro: "Astro",
  sql: "SQL",
  graphql: "GraphQL",
  gql: "GraphQL",
  proto: "Protocol Buffers",
  yml: "YAML",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  svg: "SVG",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  ps1: "PowerShell",
  tf: "HCL",
  hcl: "HCL",
  ini: "INI",
  zig: "Zig",
  nix: "Nix",
};

const own = (table: Record<string, string>, key: string) =>
  Object.hasOwn(table, key) ? (table[key] ?? null) : null;

/** The language's name for a path, or null for a kind of file not named. */
export function languageName(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  // A dot file (".env") is its name, not an extension.
  return own(BY_NAME, name) ?? (dot > 0 ? own(BY_EXTENSION, name.slice(dot + 1)) : null);
}
