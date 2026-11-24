import { describe, expect, it } from "vitest";
import { holdOrder } from "./hold-order.js";
import type { ShownSection } from "./sections.js";

const section = (ids: string[], title = "s"): ShownSection =>
  ({
    key: "view:a",
    title,
    view: {} as ShownSection["view"],
    rows: ids.map((id) => ({ host: "github.com", id, title: id })),
  }) as unknown as ShownSection;
const ids = (s: ShownSection[]) => s[0]?.rows.map((r) => r.id);

describe("holding the inbox's order", () => {
  it("keeps rows where they were, new ones last and gone ones dropped", () => {
    const before = [section(["a", "b", "c"])];
    const next = [section(["d", "c", "a"])];
    expect(ids(holdOrder(before, next))).toEqual(["a", "c", "d"]);
  });

  it("takes each row's new contents", () => {
    const next = [section(["b", "a"], "new")];
    expect(holdOrder([section(["a", "b"])], next)[0]?.title).toBe("new");
  });
});
