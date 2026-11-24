import { useRef, useState } from "react";
import type { PullFileView } from "../../../src/shared/index.js";
import { foldReason } from "./generated.js";

// Ways to narrow a pull request's changed files, and views of them saved
// under a name in this browser. A narrowing applies to the tree and the
// diffs alike, so a view narrows the page, not only the list.

export type FileKind = PullFileView["status"];
export type ViewedChoice = "any" | "unviewed" | "viewed";

export type FileNarrowing = {
  /** Words of a path or globs, any of which a file matches; a word after `!` leaves files out. */
  path: string;
  /** What happened to a file; none means any. */
  kinds: FileKind[];
  viewed: ViewedChoice;
  /** Leaves out lock files, generated code and vendored copies. */
  hideGenerated: boolean;
};

export type FileView = { name: string; narrowing: FileNarrowing };

export const KINDS: readonly FileKind[] = ["added", "modified", "removed", "renamed"];
const VIEWED: readonly ViewedChoice[] = ["any", "unviewed", "viewed"];

export const ALL_FILES: FileNarrowing = {
  path: "",
  kinds: [],
  viewed: "any",
  hideGenerated: false,
};

export const MAX_VIEWS = 20;
export const MAX_NAME = 40;

const KEY = "ocra-pull-file-views";

const ESCAPE = /[.+^${}()|[\]\\]/g;

function globSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      i++;
      if (glob.charAt(i + 1) === "/") {
        i++;
        out += "(?:.*/)?";
      } else out += ".*";
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(ESCAPE, "\\$&");
  }
  return out;
}

/**
 * One word of the path field as a test of a path, ignoring case: a glob when
 * it holds `*` or `?`, matched from any folder down (from the top when it
 * starts with `/`), else text the path contains.
 */
function term(word: string): (path: string) => boolean {
  if (!/[*?]/.test(word)) {
    const text = word.toLowerCase();
    return (path) => path.toLowerCase().includes(text);
  }
  const rooted = word.startsWith("/");
  const re = new RegExp(
    `^${rooted ? "" : "(?:.*/)?"}${globSource(rooted ? word.slice(1) : word)}$`,
    "i",
  );
  return (path) => re.test(path);
}

/** Whether a path passes the path field: it matches one of its words, if any, and none after `!`. */
export function pathMatcher(text: string): (path: string) => boolean {
  const words = text.split(/[\s,]+/).filter(Boolean);
  const wanted = words.filter((w) => !w.startsWith("!")).map(term);
  const unwanted = words
    .filter((w) => w.length > 1 && w.startsWith("!"))
    .map((w) => term(w.slice(1)));
  return (path) =>
    (wanted.length === 0 || wanted.some((t) => t(path))) && !unwanted.some((t) => t(path));
}

/**
 * The files a narrowing keeps, in their order. A path in `held` passes the
 * viewed choice whatever it is now, so a file ticked while its view hides
 * viewed files stays until the view changes.
 */
export function narrowFiles<F extends Pick<PullFileView, "path" | "status">>(
  files: readonly F[],
  n: FileNarrowing,
  isViewed: (f: F) => boolean,
  held: ReadonlySet<string> = new Set(),
): F[] {
  const onPath = pathMatcher(n.path);
  return files.filter(
    (f) =>
      onPath(f.path) &&
      (n.kinds.length === 0 || n.kinds.includes(f.status)) &&
      !(n.hideGenerated && foldReason(f.path)) &&
      (n.viewed === "any" || held.has(f.path) || isViewed(f) === (n.viewed === "viewed")),
  );
}

/** The narrowing in one spelling: kinds once each, in the menu's order. */
function normal(n: FileNarrowing): FileNarrowing {
  return { ...n, kinds: KINDS.filter((k) => n.kinds.includes(k)) };
}

export function sameNarrowing(a: FileNarrowing, b: FileNarrowing): boolean {
  return (
    a.path.trim() === b.path.trim() &&
    a.viewed === b.viewed &&
    a.hideGenerated === b.hideGenerated &&
    normal(a).kinds.join() === normal(b).kinds.join()
  );
}

export const isNarrowed = (n: FileNarrowing) => !sameNarrowing(n, ALL_FILES);

/** How many choices of the filter menu are set (the path field is counted apart). */
export const choicesSet = (n: FileNarrowing) =>
  (n.kinds.length > 0 ? 1 : 0) + (n.viewed !== "any" ? 1 : 0) + (n.hideGenerated ? 1 : 0);

type Kept = { views: FileView[]; picked: string | null };

function narrowingOf(value: unknown): FileNarrowing | null {
  if (typeof value !== "object" || value === null) return null;
  const n = value as Record<string, unknown>;
  return normal({
    path: typeof n.path === "string" ? n.path : "",
    kinds: Array.isArray(n.kinds) ? KINDS.filter((k) => (n.kinds as unknown[]).includes(k)) : [],
    viewed: VIEWED.find((v) => v === n.viewed) ?? "any",
    hideGenerated: n.hideGenerated === true,
  });
}

/** The views this browser keeps, and the one last picked; whatever does not read is left out. */
export function readKept(raw: string | null): Kept {
  try {
    const kept = JSON.parse(raw ?? "{}") as { views?: unknown; picked?: unknown };
    const views: FileView[] = [];
    for (const v of Array.isArray(kept.views) ? kept.views : []) {
      const name = typeof v?.name === "string" ? v.name.trim().slice(0, MAX_NAME) : "";
      const narrowing = narrowingOf(v?.narrowing);
      if (name && narrowing && !views.some((w) => w.name === name)) views.push({ name, narrowing });
    }
    const picked = views.find((v) => v.name === kept.picked)?.name ?? null;
    return { views: views.slice(0, MAX_VIEWS), picked };
  } catch {
    return { views: [], picked: null };
  }
}

function load(): Kept {
  try {
    return readKept(localStorage.getItem(KEY));
  } catch {
    return { views: [], picked: null };
  }
}

export type FileViews = ReturnType<typeof useFileViews>;

/**
 * The narrowing of one pull request's files, and the views saved in this
 * browser; the view picked last is picked again on the next pull request.
 * `scope` names the pull request, so files held on one are not on another.
 */
export function useFileViews(scope: string) {
  const [kept, setKept] = useState(load);
  const [narrowing, setNarrowing] = useState(
    () => kept.views.find((v) => v.name === kept.picked)?.narrowing ?? ALL_FILES,
  );
  const held = useRef({ key: "", paths: new Set<string>() });
  const picked = kept.views.find((v) => v.name === kept.picked) ?? null;
  const keep = (change: (k: Kept) => Kept) =>
    setKept((k) => {
      const next = change(k);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  const pick = (view: FileView | null) => {
    keep((k) => ({ ...k, picked: view?.name ?? null }));
    setNarrowing(view?.narrowing ?? ALL_FILES);
  };
  return {
    views: kept.views,
    /** The saved view picked, or null for all files. */
    picked,
    narrowing,
    /** Whether the narrowing differs from the picked view's (from all files when none is). */
    edited: picked ? !sameNarrowing(picked.narrowing, narrowing) : isNarrowed(narrowing),
    pick,
    change: (next: Partial<FileNarrowing>) => setNarrowing((n) => normal({ ...n, ...next })),
    /** Keeps the narrowing under a name, over a view of the same name, and picks it. */
    save: (name: string) => {
      const view = {
        name: name.trim().slice(0, MAX_NAME),
        narrowing: { ...narrowing, path: narrowing.path.trim() },
      };
      if (!view.name) return;
      keep((k) => {
        const at = k.views.findIndex((v) => v.name === view.name);
        const views = at >= 0 ? k.views.with(at, view) : [...k.views, view].slice(0, MAX_VIEWS);
        return { views, picked: view.name };
      });
      setNarrowing(view.narrowing);
    },
    /** Forgets a view, leaving the narrowing as it is; what it returns puts the view back. */
    remove: (view: FileView) => {
      const at = kept.views.findIndex((v) => v.name === view.name);
      const was = kept.picked === view.name;
      keep((k) => ({
        views: k.views.filter((v) => v.name !== view.name),
        picked: k.picked === view.name ? null : k.picked,
      }));
      return () =>
        keep((k) =>
          k.views.some((v) => v.name === view.name)
            ? k
            : {
                views: [...k.views.slice(0, at), view, ...k.views.slice(at)],
                picked: was ? view.name : k.picked,
              },
        );
    },
    /** The files the narrowing keeps; one it showed stays while only its viewed tick changed. */
    narrow: <F extends Pick<PullFileView, "path" | "status">>(
      files: readonly F[],
      isViewed: (f: F) => boolean,
    ): F[] => {
      const key = `${scope}\n${JSON.stringify(narrowing)}`;
      if (held.current.key !== key) held.current = { key, paths: new Set() };
      const shown = narrowFiles(files, narrowing, isViewed, held.current.paths);
      for (const f of shown) held.current.paths.add(f.path);
      return shown;
    },
  };
}

/** The list last returned while it holds the same items, so what is worked out from it is kept. */
export function useSameList<T>(list: readonly T[]): readonly T[] {
  const last = useRef(list);
  const same =
    last.current.length === list.length && last.current.every((item, i) => item === list[i]);
  if (!same) last.current = list;
  return last.current;
}
