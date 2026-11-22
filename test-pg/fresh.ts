import { reset } from "./db.js";
import { env, rateLimits } from "./workers.js";

// Files share their worker's modules: each starts on an empty database and
// fresh rate limits, as each Worker test file gets its own D1.
await reset();
Object.assign(env, rateLimits());
