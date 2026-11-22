import type { LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CodePlatformKind } from "../../src/shared/index.js";
import { api } from "./api.js";
import { platformsText } from "./platform-names.js";
import { Link } from "./router.js";
import { EmptyState, LoadError, Loading, useLoad } from "./ui.js";

// One of the user's connected repositories, chosen in a page's head and kept
// in its address, for pages that read a repository's files live.

type Listed = {
  platforms: {
    platform: CodePlatformKind;
    repositories: { id: string; fullName: string }[];
  }[];
};
export type RepoChoice = { platform: CodePlatformKind; repo: string };

const keyOf = (r: RepoChoice) => `${r.platform}:${r.repo}`;

function fromAddress(): RepoChoice | null {
  const q = new URLSearchParams(location.search);
  const platform = q.get("platform");
  const repo = q.get("repo");
  return (platform === "github" || platform === "gitlab") && repo ? { platform, repo } : null;
}

/** The repository the page shows: the address's, else the first connected one. */
export function useRepoChoice(path: string) {
  const listed = useLoad(() => api<Listed>("/platforms/repos"));
  const choices: RepoChoice[] = (listed.data?.platforms ?? []).flatMap((p) =>
    p.repositories.map((r) => ({ platform: p.platform, repo: r.fullName })),
  );
  const [picked, setPicked] = useState<RepoChoice | null>(fromAddress);
  const repo = picked ?? choices[0] ?? null;
  const pick = (r: RepoChoice) => {
    setPicked(r);
    history.replaceState(null, "", `${path}?${new URLSearchParams(r)}`);
  };
  const select = choices.length > 0 && (
    <select
      className="input"
      aria-label="Repository"
      value={repo ? keyOf(repo) : ""}
      onChange={(e) => {
        const r = choices.find((c) => keyOf(c) === e.target.value);
        if (r) pick(r);
      }}
    >
      {picked && !choices.some((c) => keyOf(c) === keyOf(picked)) && (
        <option value={keyOf(picked)}>{picked.repo}</option>
      )}
      {choices.map((c) => (
        <option key={keyOf(c)} value={keyOf(c)}>
          {c.repo}
        </option>
      ))}
    </select>
  );
  /** The page's body for the chosen repository, or why there is none yet. */
  const body = (icon: LucideIcon, render: (repo: RepoChoice, key: string) => ReactNode) =>
    listed.error && !listed.data ? (
      <LoadError what="your repositories" error={listed.error} retry={listed.reload} />
    ) : !listed.data ? (
      <Loading what="your repositories" />
    ) : !repo ? (
      <div className="card">
        <EmptyState
          icon={icon}
          title="No repository to read"
          action={
            <Button variant="outline" render={<Link to="/repositories" />}>
              Connect under Repositories
            </Button>
          }
        >
          Connect {platformsText(listed.data.platforms.map((p) => p.platform))} under Repositories,
          and its repositories show up here.
        </EmptyState>
      </div>
    ) : (
      render(repo, keyOf(repo))
    );
  return { select, body };
}
