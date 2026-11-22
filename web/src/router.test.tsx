import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Button } from "@/components/ui/button";
import { Link } from "./router.js";

afterEach(cleanup);

describe("Link", () => {
  it("renders as a coss Button and still navigates in the page", () => {
    history.replaceState(null, "", "/");
    render(
      <Button variant="outline" render={<Link to="/reviews" />}>
        All reviews
      </Button>,
    );
    const link = screen.getByRole("link", { name: "All reviews" });
    expect(link.getAttribute("data-slot")).toBe("button");
    expect(link.getAttribute("href")).toBe("/reviews");
    fireEvent.click(link);
    expect(location.pathname).toBe("/reviews");
  });
});
