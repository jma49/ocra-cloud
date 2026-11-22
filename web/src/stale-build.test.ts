import { afterEach, describe, expect, it, vi } from "vitest";
import { reloadOnStaleBuild } from "./stale-build.js";

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

function fakeWindow() {
  const target = new EventTarget() as unknown as Window;
  const reload = vi.fn();
  Object.assign(target, { location: { reload }, sessionStorage });
  reloadOnStaleBuild(target);
  const fail = () => target.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
  return { reload, fail };
}

describe("a chunk a deploy removed", () => {
  it("loads the new build once, and leaves a second failure soon after to the error page", () => {
    vi.useFakeTimers();
    const { reload, fail } = fakeWindow();
    expect(fail()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(fail()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(11_000);
    fail();
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
