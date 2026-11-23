import c from "material-icon-theme/icons/c.svg";
import consoleIcon from "material-icon-theme/icons/console.svg";
import cpp from "material-icon-theme/icons/cpp.svg";
import csharp from "material-icon-theme/icons/csharp.svg";
import css from "material-icon-theme/icons/css.svg";
import database from "material-icon-theme/icons/database.svg";
import docker from "material-icon-theme/icons/docker.svg";
import file from "material-icon-theme/icons/file.svg";
import folderApi from "material-icon-theme/icons/folder-api-open.svg";
import folderComponents from "material-icon-theme/icons/folder-components-open.svg";
import folderConfig from "material-icon-theme/icons/folder-config-open.svg";
import folderCss from "material-icon-theme/icons/folder-css-open.svg";
import folderDatabase from "material-icon-theme/icons/folder-database-open.svg";
import folderDocs from "material-icon-theme/icons/folder-docs-open.svg";
import folderGithub from "material-icon-theme/icons/folder-github-open.svg";
import folderLib from "material-icon-theme/icons/folder-lib-open.svg";
import folderMigrations from "material-icon-theme/icons/folder-migrations-open.svg";
import folder from "material-icon-theme/icons/folder-open.svg";
import folderPublic from "material-icon-theme/icons/folder-public-open.svg";
import folderScripts from "material-icon-theme/icons/folder-scripts-open.svg";
import folderShared from "material-icon-theme/icons/folder-shared-open.svg";
import folderSrc from "material-icon-theme/icons/folder-src-open.svg";
import folderTest from "material-icon-theme/icons/folder-test-open.svg";
import git from "material-icon-theme/icons/git.svg";
import go from "material-icon-theme/icons/go.svg";
import h from "material-icon-theme/icons/h.svg";
import html from "material-icon-theme/icons/html.svg";
import image from "material-icon-theme/icons/image.svg";
import java from "material-icon-theme/icons/java.svg";
import javascript from "material-icon-theme/icons/javascript.svg";
import json from "material-icon-theme/icons/json.svg";
import kotlin from "material-icon-theme/icons/kotlin.svg";
import lock from "material-icon-theme/icons/lock.svg";
import markdown from "material-icon-theme/icons/markdown.svg";
import mdx from "material-icon-theme/icons/mdx.svg";
import nodejs from "material-icon-theme/icons/nodejs.svg";
import php from "material-icon-theme/icons/php.svg";
import python from "material-icon-theme/icons/python.svg";
import react from "material-icon-theme/icons/react.svg";
import reactTs from "material-icon-theme/icons/react_ts.svg";
import ruby from "material-icon-theme/icons/ruby.svg";
import rust from "material-icon-theme/icons/rust.svg";
import sass from "material-icon-theme/icons/sass.svg";
import settings from "material-icon-theme/icons/settings.svg";
import svelte from "material-icon-theme/icons/svelte.svg";
import svg from "material-icon-theme/icons/svg.svg";
import swift from "material-icon-theme/icons/swift.svg";
import testJs from "material-icon-theme/icons/test-js.svg";
import testJsx from "material-icon-theme/icons/test-jsx.svg";
import testTs from "material-icon-theme/icons/test-ts.svg";
import toml from "material-icon-theme/icons/toml.svg";
import tsconfig from "material-icon-theme/icons/tsconfig.svg";
import typescript from "material-icon-theme/icons/typescript.svg";
import typescriptDef from "material-icon-theme/icons/typescript-def.svg";
import vue from "material-icon-theme/icons/vue.svg";
import xml from "material-icon-theme/icons/xml.svg";
import yaml from "material-icon-theme/icons/yaml.svg";

// What kind of file or folder a tree row is, as Material Icon Theme draws it
// (MIT). Only the kinds listed here are bundled; any other gets the plain
// file or folder.

const BY_NAME: Record<string, string> = {
  "package.json": nodejs,
  "package-lock.json": nodejs,
  "tsconfig.json": tsconfig,
  dockerfile: docker,
  ".gitignore": git,
  ".gitattributes": git,
};

const BY_ENDING: [ending: string, icon: string][] = [
  [".d.ts", typescriptDef],
  [".test.tsx", testJsx],
  [".spec.tsx", testJsx],
  [".test.jsx", testJsx],
  [".spec.jsx", testJsx],
  [".test.ts", testTs],
  [".spec.ts", testTs],
  [".test.js", testJs],
  [".spec.js", testJs],
  [".test.mjs", testJs],
];

const BY_EXTENSION: Record<string, string> = {
  ts: typescript,
  mts: typescript,
  cts: typescript,
  tsx: reactTs,
  js: javascript,
  mjs: javascript,
  cjs: javascript,
  jsx: react,
  json: json,
  jsonc: json,
  css: css,
  scss: sass,
  sass: sass,
  html: html,
  md: markdown,
  mdx: mdx,
  py: python,
  go: go,
  rs: rust,
  java: java,
  kt: kotlin,
  swift: swift,
  c: c,
  cc: cpp,
  cpp: cpp,
  h: h,
  hpp: h,
  cs: csharp,
  rb: ruby,
  php: php,
  vue: vue,
  svelte: svelte,
  sql: database,
  yml: yaml,
  yaml: yaml,
  toml: toml,
  xml: xml,
  sh: consoleIcon,
  bash: consoleIcon,
  zsh: consoleIcon,
  svg: svg,
  png: image,
  jpg: image,
  jpeg: image,
  gif: image,
  webp: image,
  ico: image,
  lock: lock,
  env: settings,
  ini: settings,
  conf: settings,
};

const BY_FOLDER: Record<string, string> = {
  src: folderSrc,
  test: folderTest,
  tests: folderTest,
  "test-node": folderTest,
  __tests__: folderTest,
  docs: folderDocs,
  scripts: folderScripts,
  db: folderDatabase,
  migrations: folderMigrations,
  "migrations-pg": folderMigrations,
  components: folderComponents,
  styles: folderCss,
  public: folderPublic,
  config: folderConfig,
  ".github": folderGithub,
  lib: folderLib,
  shared: folderShared,
  api: folderApi,
};

function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  const named = BY_NAME[lower] ?? BY_ENDING.find(([ending]) => lower.endsWith(ending))?.[1];
  if (named) return named;
  const dot = lower.lastIndexOf(".");
  return (dot < 0 ? undefined : BY_EXTENSION[lower.slice(dot + 1)]) ?? file;
}

/** A folder row may be a joined chain ("core/src/runtime"): its last folder names it. */
const folderIcon = (name: string) =>
  BY_FOLDER[name.slice(name.lastIndexOf("/") + 1).toLowerCase()] ?? folder;

/** Decoration beside a name that says the same: hidden from a screen reader. */
export function FileTypeIcon(props: { name: string; folder?: boolean }) {
  const src = props.folder ? folderIcon(props.name) : fileIcon(props.name);
  return <img className="file-type" src={src} alt="" width={16} height={16} />;
}
