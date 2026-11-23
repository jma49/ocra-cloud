import { afterEach } from "vitest";
import { clearCache } from "./cache.js";

// Pages open on the last answer for a read; one test's answers must not be another's.
afterEach(() => clearCache());

// Tests have no window to scroll: everything watched is near it, so lazily drawn diffs draw.
class NearObserver {
  constructor(private readonly seen: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.seen(
      [{ target, isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.IntersectionObserver = NearObserver as unknown as typeof IntersectionObserver;
