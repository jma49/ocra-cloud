import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Makes a Compose deployment's secrets on its first start, once each, and
// never replaces one (selfhost/docker-compose.yml):
// `node dist/make-secrets.mjs <secrets dir> <database password dir>`.
// The database's password sits apart, readable by the database's own user.

const [secrets, database] = process.argv.slice(2);
if (!secrets || !database)
  throw new Error("usage: make-secrets <secrets dir> <database password dir>");

const made: string[] = [];
const make = (path: string, value: string, mode: number) => {
  try {
    writeFileSync(path, `${value}\n`, { flag: "wx", mode });
    made.push(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
};
make(join(secrets, "master_key"), randomBytes(32).toString("base64"), 0o400);
make(join(secrets, "session_secret"), randomBytes(32).toString("base64"), 0o400);
// Letters and digits: it goes in a URL.
make(join(database, "db_password"), randomBytes(24).toString("hex"), 0o444);

console.log(
  made.length > 0
    ? { level: "info", event: "secrets_made", made, keep: "back them up: selfhost/backup.sh" }
    : { level: "info", event: "secrets_kept" },
);
