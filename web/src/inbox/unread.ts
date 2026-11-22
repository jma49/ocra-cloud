import { useCallback, useState } from "react";
import {
  MAX_SEEN_BULK,
  type PullSeenBulkRequest,
  type PullUnreadReason,
} from "../../../src/shared/index.js";
import { api } from "../api.js";
import type { InboxAnswer, Row } from "./sections.js";

export const UNREAD_REASON: Record<PullUnreadReason, string> = {
  new: "New to you",
  marked: "Marked unread",
  commits: "New commits",
  merged: "Merged",
  ocra_review: "New ocra review",
  activity: "New activity",
};

const keyOf = (r: Pick<Row, "host" | "id">) => `${r.host}:${r.id}`;

function marked(answer: InboxAnswer, rows: Row[], read: boolean): InboxAnswer {
  const keys = new Set(rows.map(keyOf));
  return {
    platforms: answer.platforms.map((p) => ({
      ...p,
      pulls: p.pulls.map((pull) => {
        if (!keys.has(keyOf({ host: p.host, id: pull.id }))) return pull;
        const { unreadReason: _, ...rest } = pull;
        return read
          ? { ...rest, unread: false }
          : { ...rest, unread: true, unreadReason: "marked" };
      }),
    })),
  };
}

function requests(rows: Row[], read: boolean): PullSeenBulkRequest[] {
  const out: PullSeenBulkRequest[] = [];
  for (let i = 0; i < rows.length; i += MAX_SEEN_BULK) {
    const pulls = rows.slice(i, i + MAX_SEEN_BULK);
    out.push(
      read
        ? {
            read,
            pulls: pulls.map(({ platform, repo, number, updatedAt, head }) => ({
              platform,
              repo,
              number,
              updatedAt,
              head,
            })),
          }
        : { read, pulls: pulls.map(({ platform, repo, number }) => ({ platform, repo, number })) },
    );
  }
  return out;
}

type Change = (edit: (data: InboxAnswer) => InboxAnswer) => () => void;

/** Marks inbox rows read or unread: shown at once, taken back when the server refuses. */
export function useUnreadMarks(change: Change) {
  const [failed, setFailed] = useState<unknown>(null);
  const mark = useCallback(
    (rows: Row[], read: boolean) => {
      const changing = rows.filter((r) => r.unread === read);
      if (changing.length === 0) return;
      setFailed(null);
      const undo = change((answer) => marked(answer, changing, read));
      Promise.all(
        requests(changing, read).map((body) =>
          api("/pulls/seen/bulk", { method: "POST", body: JSON.stringify(body) }),
        ),
      ).catch((e) => {
        undo();
        setFailed(e);
      });
    },
    [change],
  );
  /** The pull request's page marks it read itself; the list only stops showing the dot. */
  const opened = useCallback(
    (row: Row) => {
      if (row.unread) change((answer) => marked(answer, [row], true));
    },
    [change],
  );
  return { mark, opened, failed };
}
