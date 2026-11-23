import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddChannel, type LinkSent } from "./add-channel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const form = (over: { slack?: boolean } = {}) => {
  const added: (LinkSent | null)[] = [];
  render(
    <AddChannel
      onAdded={(confirming) => added.push(confirming)}
      full={false}
      email={false}
      slack={over.slack ?? true}
    />,
  );
  return added;
};

const fill = () => {
  fireEvent.change(screen.getByLabelText("Where"), { target: { value: "slack_dm" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ada" } });
  fireEvent.change(screen.getByLabelText("Slack member"), { target: { value: " U012AB3CD " } });
};
const add = () =>
  act(async () => void fireEvent.click(screen.getByRole("button", { name: "Add" })));

describe("adding a channel", () => {
  it("offers a Slack direct message only where the server sends them", () => {
    form({ slack: false });
    expect(screen.queryByRole("option", { name: "Slack direct message" })).toBeNull();
    cleanup();
    form();
    expect(screen.getByRole("option", { name: "Slack direct message" })).toBeTruthy();
  });

  it("sends a Slack member as member, and says a link is on its way", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(JSON.parse(String(init?.body)));
        return Response.json({ channel: {}, confirmationSent: true });
      }),
    );
    const added = form();
    fill();
    expect(
      screen.getByText(
        /If this is a member of the workspace, they get a direct message with a link to confirm first/,
      ),
    ).toBeTruthy();
    await add();
    expect(sent).toEqual([
      {
        kind: "slack_dm",
        name: "Ada",
        when: "blocking",
        digest: false,
        weekly: false,
        member: "U012AB3CD",
      },
    ]);
    expect(added).toEqual([{ name: "Ada", slack: true }]);
  });

  it("says in the server's words which member it refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "invalid_body",
            issues: [{ path: ["member"], message: "not a Slack member ID or email address" }],
          },
          { status: 400 },
        ),
      ),
    );
    form();
    fill();
    await add();
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not add it: not a Slack member ID or email address.",
    );
  });

  it("says Slack did not answer when it could not look the member up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "upstream_unreachable" }, { status: 502 })),
    );
    form();
    fill();
    await add();
    expect(screen.getByRole("alert").textContent).toBe(
      "Could not add it: Slack did not answer; try again.",
    );
  });
});
