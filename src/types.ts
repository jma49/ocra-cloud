import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { SessionAccount } from "./db/accounts.js";
import type { Scoped } from "./db/scoped.js";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    db: DrizzleD1Database;
    /** Set by requireSession: the signed-in account and its scoped data. */
    session: SessionAccount;
    data: Scoped;
  };
};
