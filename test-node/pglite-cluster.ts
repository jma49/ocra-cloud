import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite, type PGliteOptions } from "@electric-sql/pglite";
import { inject } from "vitest";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgliteCluster: string;
  }
}

// A PGlite started without a data directory runs initdb in WASM first: about
// 2.5 s of one core when idle, past a hook's 10 s on a loaded machine, where
// loading a dumped cluster takes 0.4 s. So initdb runs once per run, here,
// before any test file, and each file starts from its dump.
export default async function setup(project: TestProject) {
  const dir = await mkdtemp(join(tmpdir(), "ocra-pglite-"));
  const file = join(dir, "cluster.tar");
  const pglite = await PGlite.create();
  await writeFile(file, Buffer.from(await (await pglite.dumpDataDir("none")).arrayBuffer()));
  await pglite.close();
  project.provide("pgliteCluster", file);
  return () => rm(dir, { recursive: true, force: true });
}

/** An empty Postgres in this process, started from the run's initialised cluster. */
export async function freshPglite(options: PGliteOptions = {}) {
  const cluster = new Blob([await readFile(inject("pgliteCluster"))]);
  return PGlite.create({ ...options, loadDataDir: cluster });
}
