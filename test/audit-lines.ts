/** Audit events as sorted lines: events in one millisecond have no order to assert. */
export const auditLines = (events: { kind: string; detail: unknown }[]) =>
  events.map((e) => JSON.stringify([e.kind, e.detail])).sort();

/** The lines auditLines makes of these [kind, detail] pairs. */
export const lines = (...pairs: [string, unknown][]) => pairs.map((p) => JSON.stringify(p)).sort();
