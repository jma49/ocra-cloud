import { readFileSync } from "node:fs";
import { withFiles } from "./env.js";
import { setupCode } from "./setup/code.js";

// Prints the code that opens the server's settings page (./setup/code.ts):
// `docker compose exec ocra node dist/setup-code.mjs`.

const env = withFiles(process.env, (path) => readFileSync(path, "utf8"));
if (!env.SESSION_SECRET) throw new Error("set SESSION_SECRET or SESSION_SECRET_FILE");
console.log(await setupCode(env.SESSION_SECRET));
