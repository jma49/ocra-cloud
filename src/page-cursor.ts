import { z } from "zod";

/** The last listed row's (created_at, id): the next page starts after it. */
export type PageCursor = { createdAt: Date; id: string };

export const optionalPageCursor = z
  .string()
  .regex(/^\d{1,15}_[\w-]{1,64}$/)
  .transform((raw): PageCursor => {
    const at = raw.indexOf("_");
    return { createdAt: new Date(Number(raw.slice(0, at))), id: raw.slice(at + 1) };
  })
  .optional();

export const encodePageCursor = (c: PageCursor) => `${c.createdAt.getTime()}_${c.id}`;
