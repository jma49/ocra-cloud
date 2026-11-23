import { afterEach } from "vitest";
import { clearCache } from "./cache.js";

// Pages open on the last answer for a read; one test's answers must not be another's.
afterEach(() => clearCache());
