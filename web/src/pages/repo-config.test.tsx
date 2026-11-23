import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoConfigView } from "../../../src/shared/index.js";
import { RepoConfig } from "./RepoConfig.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

const BLOB = "a".repeat(40);
const TEXT = '{\n  "model": "standard"\n}\n';
const view = (over: Partial<RepoConfigView> = {}): RepoConfigView => ({
  platform: "github",
  repo: "acme/payments",
  branch: "main",
  commit: "c".repeat(40),
  file: "config",
  path: ".ocra/config.json",
  blobId: BLOB,
  text: TEXT,
  value: { model: "standard" },
  parseError: null,
  errors: [],
  moreErrors: false,
  refusal: null,
  schema: "https://example.test/schema/config.json",
  lastCommit: null,
  ...over,
});

/** Serves the page: the file as read, and what a change answers. */
function serve(read: RepoConfigView, answer: () => Response) {
  const asked: string[] = [];
  const sent: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        return answer();
      }
      if (url === "/api/platforms/repos")
        return Response.json({
          platforms: [
            { platform: "github", repositories: [{ id: "1", fullName: "acme/payments" }] },
          ],
        });
      asked.push(url);
      return Response.json(url.includes("file=rules") ? { ...read, file: "rules" } : read);
    }),
  );
  return { asked, sent };
}

const editor = async () =>
  (await screen.findByLabelText("Contents of .ocra/config.json")) as HTMLTextAreaElement;
const type = (box: HTMLTextAreaElement, value: string) =>
  fireEvent.change(box, { target: { value } });
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("the Review config page", () => {
  it("sends an edit on the blob it read, and says which pull request it opened", async () => {
    const { asked, sent } = serve(view(), () =>
      Response.json({
        outcome: "done",
        path: ".ocra/config.json",
        pull: { number: 9, url: "https://github.com/acme/payments/pull/9" },
      }),
    );
    render(<RepoConfig />);
    const box = await editor();
    expect(box.value).toBe(TEXT);
    expect(asked).toEqual(["/api/repo-config?platform=github&repo=acme%2Fpayments&file=config"]);
    expect(button("Open pull request").disabled).toBe(true);
    type(box, '{ "model": "top" }');
    await act(async () => void fireEvent.click(button("Open pull request")));
    expect(sent).toEqual([
      {
        platform: "github",
        repo: "acme/payments",
        file: "config",
        text: '{ "model": "top" }',
        expected: BLOB,
        direct: false,
      },
    ]);
    expect(screen.getByRole("link", { name: "pull request #9" })).toBeTruthy();
  });

  it("does not send what is not JSON", async () => {
    const { sent } = serve(view(), () => Response.json({}));
    render(<RepoConfig />);
    type(await editor(), '{ "model": ');
    expect(screen.getByText(/Not JSON yet/)).toBeTruthy();
    expect(button("Open pull request").disabled).toBe(true);
    expect(sent).toEqual([]);
  });

  it("shows where the server refused a change, by its path in the file", async () => {
    serve(view(), () =>
      Response.json(
        {
          error: "invalid_body",
          issues: [{ path: ["text", "reviewers", 0, "effort"], message: "is not a known effort" }],
        },
        { status: 400 },
      ),
    );
    render(<RepoConfig />);
    type(await editor(), '{ "reviewers": [{ "effort": "most" }] }');
    await act(async () => void fireEvent.click(button("Open pull request")));
    expect(screen.getByText("reviewers.0.effort")).toBeTruthy();
    expect(screen.getByText(/is not a known effort/)).toBeTruthy();
  });

  it("starts a file the branch does not have from its schema, and sends no blob", async () => {
    const { sent } = serve(view({ blobId: null, text: null, value: null }), () =>
      Response.json({ outcome: "done", path: ".ocra/config.json", pull: null }),
    );
    render(<RepoConfig />);
    const box = await editor();
    expect(JSON.parse(box.value)).toEqual({ $schema: "https://example.test/schema/config.json" });
    fireEvent.click(screen.getByLabelText(/Commit to main instead/));
    await act(async () => void fireEvent.click(button("Commit")));
    expect(sent).toMatchObject([{ expected: null, direct: true }]);
    expect(await screen.findByText(/Committed/)).toBeTruthy();
  });

  it("lists what a review would refuse in the file as it is, and offers to read it again after a conflict", async () => {
    const { asked } = serve(
      view({ errors: [{ path: ["budget"], message: "must be a number" }], moreErrors: true }),
      () => Response.json({ outcome: "conflict", path: ".ocra/config.json", pull: null }),
    );
    render(<RepoConfig />);
    const box = await editor();
    expect(screen.getByText("budget")).toBeTruthy();
    expect(screen.getByText(/And more/)).toBeTruthy();
    type(box, "{}");
    await act(async () => void fireEvent.click(button("Open pull request")));
    expect(screen.getByText(/changed since this page read it/)).toBeTruthy();
    await act(async () => void fireEvent.click(button("Read it again")));
    expect(asked).toHaveLength(2);
  });

  it("reads the rules file when asked for it", async () => {
    const { asked } = serve(view(), () => Response.json({}));
    render(<RepoConfig />);
    await editor();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Rules" })));
    expect(asked.at(-1)).toContain("file=rules");
  });
});
