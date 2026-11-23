import { describe, expect, it } from "vitest";
import { nodeWebhookPost } from "../src/node/webhook-transport.js";

// On Node the server may sit on a private network, so a webhook's name is
// checked as the socket resolves it: any private, loopback, link-local or
// metadata address among its answers refuses the call before it connects.

const post = (addresses: string[]) => {
  const asked: string[] = [];
  const send = nodeWebhookPost(async (host) => {
    asked.push(host);
    return addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
  return { asked, send };
};

const init = { headers: { "content-type": "application/json" }, body: "{}" };

describe("a webhook posted from Node", () => {
  it.each([
    ["169.254.169.254"],
    ["127.0.0.1"],
    ["10.0.0.5"],
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["fd12::1"],
    ["93.184.216.34", "192.168.0.10"],
  ])("is refused when the name resolves to %s", async (...addresses) => {
    const { asked, send } = post(addresses);
    expect(await send(new URL("https://hooks.example.com/x"), init)).toEqual({ error: "refused" });
    expect(asked).toEqual(["hooks.example.com"]);
  });

  it("is refused when the name resolves to nothing", async () => {
    const { send } = post([]);
    expect(await send(new URL("https://hooks.example.com/x"), init)).toEqual({ error: "refused" });
  });
});
