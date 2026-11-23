import type { NotifyKind, NotifyWhen } from "../../../src/shared/index.js";

export const KIND_LABEL: Record<NotifyKind, string> = {
  slack: "Slack",
  wecom: "WeCom",
  email: "Email",
  webhook: "Webhook",
  slack_dm: "Slack direct message",
};
export const WHEN_LABEL: Record<NotifyWhen, string> = {
  blocking: "Blocking reviews",
  findings: "Reviews with findings",
  every: "Every review",
};
