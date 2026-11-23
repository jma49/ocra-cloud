import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateBranch } from "./update-branch.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const HEAD = "a".repeat(40);
const pull = { platform: "github", repo: "octo/api", number: 7 };

const press = () => fireEvent.click(screen.getByRole("button", { name: "Update branch" }));

it("sends the head it read, says the platform took it, and looks again a little later", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const fetch = vi.fn(async () => Response.json({ outcome: "updating" }));
  vi.stubGlobal("fetch", fetch);
  const onChanged = vi.fn();
  render(<UpdateBranch pull={pull} head={HEAD} onChanged={onChanged} />);
  press();
  expect(await screen.findByText(/updating the branch/)).toBeTruthy();
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain("/pulls/update-branch");
  expect(JSON.parse(String(init.body))).toEqual({ ...pull, head: HEAD });
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Update branch" })).toHaveProperty("disabled", true);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(onChanged).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Update branch" })).toHaveProperty("disabled", false),
  );
});

it("says why nothing moved, and reads the page again at once", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ outcome: "conflicts" })),
  );
  const onChanged = vi.fn();
  render(<UpdateBranch pull={pull} head={HEAD} onChanged={onChanged} />);
  press();
  expect(await screen.findByText(/only a manual merge resolves it/)).toBeTruthy();
  expect(onChanged).toHaveBeenCalledTimes(1);
});

it("reads the pull request again, once, when its head moved since the page read it", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "stale" }, { status: 409 })),
  );
  const onChanged = vi.fn();
  const { rerender } = render(<UpdateBranch pull={pull} head={HEAD} onChanged={onChanged} />);
  press();
  expect((await screen.findByRole("alert")).textContent).toContain("moved since");
  rerender(<UpdateBranch pull={pull} head={HEAD} onChanged={() => onChanged()} />);
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});

it("names a used-up platform allowance", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "upstream_unreachable", reason: "platform_rate_limited" },
        { status: 502 },
      ),
    ),
  );
  render(<UpdateBranch pull={pull} head={HEAD} onChanged={() => undefined} />);
  press();
  expect((await screen.findByRole("alert")).textContent).toContain("hourly allowance");
});
