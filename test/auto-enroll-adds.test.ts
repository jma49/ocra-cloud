import { describe, expect, it } from "vitest";
import { githubInstallationAdds } from "../src/auto-review/auto-enroll.js";

// What an installation_repositories delivery hands the enroll step: the
// repositories it adds, at most as many as one account enrolls.

const delivery = (action: string, count: number) => ({
  action,
  installation: { id: 7 },
  repositories_added: Array.from({ length: count }, (_, i) => ({ id: i, full_name: `o/r${i}` })),
});

describe("an installation's added repositories", () => {
  it("are read only from an added delivery, at most a hundred", () => {
    expect(githubInstallationAdds("installation_repositories", delivery("removed", 1))).toBeNull();
    expect(githubInstallationAdds("installation", delivery("added", 1))).toBeNull();
    expect(githubInstallationAdds("installation_repositories", delivery("added", 0))).toBeNull();
    const adds = githubInstallationAdds("installation_repositories", delivery("added", 150));
    expect(adds?.installationId).toBe("7");
    expect(adds?.repos).toHaveLength(100);
    expect(adds?.repos[0]).toEqual({ id: "0", fullName: "o/r0" });
  });
});
