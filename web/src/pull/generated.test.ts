import { expect, it } from "vitest";
import { foldReason } from "./generated.js";

it("folds lock files, vendored copies and generated code, and nothing else", () => {
  expect(foldReason("package-lock.json")).toBe("lock");
  expect(foldReason("apps/web/pnpm-lock.yaml")).toBe("lock");
  expect(foldReason("Cargo.lock")).toBe("lock");
  expect(foldReason("go.sum")).toBe("lock");
  expect(foldReason("vendor/github.com/x/y.go")).toBe("vendored");
  expect(foldReason("lib/third_party/z.c")).toBe("vendored");
  expect(foldReason("src/api.generated.ts")).toBe("generated");
  expect(foldReason("proto/user.pb.go")).toBe("generated");
  expect(foldReason("static/app.min.js")).toBe("generated");
  expect(foldReason("src/__generated__/schema.ts")).toBe("generated");
  expect(foldReason("src/__snapshots__/a.test.ts.snap")).toBe("generated");
  expect(foldReason("src/vendors.ts")).toBeNull();
  expect(foldReason("src/generate.ts")).toBeNull();
  expect(foldReason("package.json")).toBeNull();
});
