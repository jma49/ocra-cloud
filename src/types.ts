import type { SessionAccount } from "./db/accounts.js";
import type { Db } from "./db/client.js";
import type { Scoped } from "./db/scoped.js";

/**
 * What the app reads from its host: settings, secrets and rate limiters,
 * never the database binding, which each entry opens itself (src/index.ts
 * on Workers, src/node/ when self-hosted).
 */
export type AppBindings = Widen<Omit<Env, "DB">>;
/** A self-hosted server sets its own GitHub App and limits: any string, not the Worker's. */
type Widen<T> = { [K in keyof T]: NonNullable<T[K]> extends string ? string : T[K] };

export type AppEnv = {
  Bindings: AppBindings;
  Variables: {
    db: Db;
    /** Set by requireSession: the signed-in account and its scoped data. */
    session: SessionAccount;
    data: Scoped;
  };
};
