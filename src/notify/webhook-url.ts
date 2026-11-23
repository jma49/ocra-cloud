// Which addresses a webhook channel may post to: HTTPS to a public host,
// decided on the URL as `new URL()` normalised it (a decimal, octal or hex
// IPv4 address is a dotted one by then), and again on each address its name
// resolves to where the host can see them (src/node/webhook-transport.ts).
// Never a private, loopback, link-local, shared, documentation, multicast
// or metadata address, nor a name only a local resolver knows.

const MAX_URL = 2048;

/** IPv4 ranges no webhook goes to, as [first octets, prefix length]. */
const V4_BLOCKED: [number[], number][] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 88, 99], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224], 4],
  [[240], 4],
];

const BLOCKED_NAMES = ["localhost", "metadata", "metadata.google.internal"];
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".onion"];

function v4Octets(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

function v4Public(octets: number[]): boolean {
  const n = ((octets[0] ?? 0) << 24) | ((octets[1] ?? 0) << 16) | ((octets[2] ?? 0) << 8);
  return !V4_BLOCKED.some(([start, bits]) => {
    const s = ((start[0] ?? 0) << 24) | ((start[1] ?? 0) << 16) | ((start[2] ?? 0) << 8);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((n >>> 0) & mask) >>> 0 === ((s >>> 0) & mask) >>> 0;
  });
}

/** The eight 16-bit groups of an IPv6 address, or undefined when it is not one. */
function v6Groups(text: string): number[] | undefined {
  let t = text.toLowerCase();
  if (t.includes("%")) return undefined;
  const dotted = t.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    const o = v4Octets(dotted[1]);
    if (!o) return undefined;
    const hex = (a = 0, b = 0) => ((a << 8) | b).toString(16);
    t = `${t.slice(0, -dotted[1].length)}${hex(o[0], o[1])}:${hex(o[2], o[3])}`;
  }
  const halves = t.split("::");
  if (halves.length > 2) return undefined;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (![...head, ...rest].every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return undefined;
  return [
    ...head.map((g) => Number.parseInt(g, 16)),
    ...Array<number>(fill).fill(0),
    ...rest.map((g) => Number.parseInt(g, 16)),
  ];
}

/**
 * Only global unicast (2000::/3), and not 6to4 (2002::/16), NAT64
 * (64:ff9b::/96 is outside it anyway) or documentation (2001:db8::/32)
 * space, which can name private IPv4 addresses or none at all.
 */
function v6Public(g: number[]): boolean {
  const first = g[0] ?? 0;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return false;
  if (first === 0x2001 && (g[1] ?? 0) === 0x0db8) return false;
  // Teredo (2001:0::/32) carries an obfuscated IPv4 address.
  if (first === 0x2001 && (g[1] ?? 0) === 0) return false;
  return true;
}

/** Whether an IP address (dotted IPv4, or IPv6 without brackets) is one a webhook may reach. */
export function publicAddress(ip: string): boolean {
  const v4 = v4Octets(ip);
  if (v4) return v4Public(v4);
  const v6 = v6Groups(ip);
  return v6 ? v6Public(v6) : false;
}

/**
 * The webhook's URL as it will be called, or undefined when it may not be:
 * https, no credentials or fragment, port 443 or one above 1023, and a
 * public IP address or a name with a dot that no local resolver owns.
 */
export function webhookUrl(raw: string): URL | undefined {
  if (raw.length > MAX_URL) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
  if (url.port && Number(url.port) !== 443 && Number(url.port) < 1024) return undefined;
  if (!hostAllowed(url.hostname)) return undefined;
  return url;
}

function hostAllowed(hostname: string): boolean {
  if (hostname.startsWith("[")) return publicAddress(hostname.slice(1, -1));
  const host = hostname.replace(/\.$/, "");
  // An empty label (`localhost..`) is no name a resolver should be asked for.
  if (host.split(".").includes("")) return false;
  if (v4Octets(host)) return publicAddress(host);
  // Anything else new URL took as a number is not a name to resolve.
  if (/^[\d.]+$/.test(host) || /^0x/i.test(host)) return false;
  if (!host.includes(".")) return false;
  if (BLOCKED_NAMES.includes(host)) return false;
  return !BLOCKED_SUFFIXES.some((s) => host.endsWith(s));
}
