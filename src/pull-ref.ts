import { z } from "zod";
import { CODE_PLATFORMS } from "./shared/domain.js";

const SEGMENT = /^(?!\.{1,2}$)[\w.-]+$/;

/** `owner/repo` or `group/subgroup/repo`, each part a plain name. */
export const repoName = z
  .string()
  .max(255)
  .refine((name) => {
    const parts = name.split("/");
    return parts.length >= 2 && parts.every((part) => SEGMENT.test(part));
  }, "not a repository path");

export const repoRef = { platform: z.enum(CODE_PLATFORMS), repo: repoName };
export const pullRef = {
  ...repoRef,
  number: z.coerce
    .number()
    .int()
    .min(1)
    .max(2 ** 31 - 1),
};
export const sha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);
