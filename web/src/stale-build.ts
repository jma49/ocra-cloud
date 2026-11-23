// A deploy replaces the lazy chunks an open tab still names, and the next
// page it opens fails to load. Loading the new build once fixes that; a
// second failure soon after is a real outage, left to the error page.

const KEY = "ocra:stale-build-reload";
const WINDOW_MS = 10_000;

let ahead = 0;

/**
 * Loads code ahead of need without the reload: a page that loads code only
 * because a link was hovered must not reload under the person (and lose a
 * draft); the click that follows fails to load and reloads then.
 */
export function loadAhead(load: () => Promise<unknown>): void {
  ahead++;
  load()
    .catch(() => {})
    .finally(() => ahead--);
}

export function reloadOnStaleBuild(target: Window = window) {
  target.addEventListener("vite:preloadError", (event) => {
    if (ahead > 0) {
      event.preventDefault();
      return;
    }
    const last = Number(read(target) ?? 0);
    if (Date.now() - last < WINDOW_MS) return;
    write(target, String(Date.now()));
    event.preventDefault();
    target.location.reload();
  });
}

function read(target: Window): string | null {
  try {
    return target.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function write(target: Window, value: string) {
  try {
    target.sessionStorage.setItem(KEY, value);
  } catch {}
}
