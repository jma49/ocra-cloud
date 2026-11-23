import type { CodePlatformKind } from "../../../src/shared/index.js";

// What a new account still has to do before ocra reviews its pull requests,
// worked out from what the console already reads. Pure, so each order of
// events is a test.

export type SetupFacts = {
  /** This server reviews pull requests itself (auto review). */
  hosted: boolean;
  platforms: {
    platform: CodePlatformKind;
    linked: boolean;
    installUrl: string | null;
    repositories: unknown[];
  }[];
  keys: number;
  enrolled: number;
  cliSignedIn: boolean;
  reviews: number;
};

export type SetupStep = {
  key: "connect" | "choose" | "key" | "enroll" | "cli" | "review";
  title: string;
  done: boolean;
  /** Where the step is done: a console path, or an external page. */
  to?: string;
  external?: boolean;
  label?: string;
};

export function setupSteps(f: SetupFacts): SetupStep[] {
  const key: SetupStep = {
    key: "key",
    title: "Add a provider key",
    done: f.keys > 0,
    to: "/keys",
    label: "Add a key",
  };
  if (!f.hosted)
    return [
      key,
      { key: "cli", title: "Install the CLI and sign in", done: f.cliSignedIn },
      { key: "review", title: "Review a change", done: f.reviews > 0, to: "/reviews" },
    ];
  const linked = f.platforms.filter((p) => p.linked);
  const install = linked.find((p) => p.installUrl)?.installUrl ?? null;
  return [
    {
      key: "connect",
      title: "Connect GitHub or GitLab",
      done: linked.length > 0,
      to: "/repositories",
      label: "Connect",
    },
    {
      key: "choose",
      title: "Choose the repositories ocra may read",
      done: linked.some((p) => p.repositories.length > 0),
      ...(install
        ? { to: install, external: true, label: "Choose repositories" }
        : { to: "/repositories", label: "Open Repositories" }),
    },
    key,
    {
      key: "enroll",
      title: "Turn on auto review for a repository",
      done: f.enrolled > 0,
      to: "/auto-review",
      label: "Set up auto review",
    },
    {
      key: "review",
      title: "Get the first review",
      done: f.reviews > 0,
      to: "/reviews",
    },
  ];
}

/** The step to do now: the first one not done, once every one before it is. */
export const currentStep = (steps: SetupStep[]) => steps.find((s) => !s.done);
