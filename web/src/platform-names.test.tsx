import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PlatformSelect, platformsText } from "./platform-names.js";

afterEach(cleanup);

describe("the platforms a deployment offers", () => {
  it("names only those it offers", () => {
    expect(platformsText(["github"])).toBe("GitHub");
    expect(platformsText(["github", "gitlab", "github"])).toBe("GitHub or GitLab");
    expect(platformsText([])).toBe("a code platform");
  });

  it("offers a choice only between two or more", () => {
    const pick = () => {};
    render(<PlatformSelect platforms={["github"]} value="github" onChange={pick} />);
    expect(screen.queryByLabelText("Platform")).toBeNull();
    render(<PlatformSelect platforms={["github", "gitlab"]} value="github" onChange={pick} />);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["GitHub", "GitLab"]);
  });
});
