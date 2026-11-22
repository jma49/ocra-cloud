import { reviewUploadSchema } from "@open-cr-agent/cloud-contract";
import { eq } from "drizzle-orm";
import { identities } from "../src/db/schema.js";
import { scoped } from "../src/db/scoped.js";
import { parseFindings } from "../src/findings.js";
import { reviewRow } from "../src/reviews.js";
import { finding, upload } from "./finding-uploads.js";
import { db } from "./helpers.js";

// A PR-mode review whose finding carries a checked fix, for the tests of
// showing and committing it.

export const HEAD = "a".repeat(40);
export const FILE = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const FIX = { fixStartLine: 2, fixEndLine: 2, fixReplacement: "const b = 20;" };

/** A PR-mode review of the signed-in account with one finding; the finding's id. */
export async function seed(repository: string, number: number, over: Record<string, unknown> = {}) {
  const [identity] = await db.select().from(identities).where(eq(identities.subject, "42"));
  const data = scoped(db, identity?.accountId ?? "");
  const { reviewersDropped: _, ...row } = reviewRow(
    // The contract's schema fills the defaults the route's body would have.
    reviewUploadSchema.parse({
      ...upload("run-1", []),
      pullRequest: { repository, number, headSha: HEAD },
    }),
  );
  const [shared] = parseFindings([finding()]).rows;
  if (!shared) throw new Error("the finding was not read");
  const stored = await data.insertReview(row, [{ ...shared, ...FIX, ...over }], {
    dailyUploads: 10,
    maxFindings: 10,
  });
  if (stored.outcome !== "stored") throw new Error(stored.outcome);
  const [f] = await data.findingsOf(stored.id);
  return { id: f?.id ?? "", reviewId: stored.id, data };
}
