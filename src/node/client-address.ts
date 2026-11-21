/**
 * The client's address on a self-hosted server: the socket's peer, or, behind
 * `trustedHops` proxies that each append the address they were reached from
 * to X-Forwarded-For, the entry the outermost of them appended. Entries left
 * of it are the client's own words and never trusted.
 */
export function clientAddress(
  socketAddress: string | undefined,
  forwardedFor: string | null,
  trustedHops: number,
): string | undefined {
  if (trustedHops > 0 && forwardedFor) {
    const hops = forwardedFor.split(",").map((entry) => entry.trim());
    const entry = hops[hops.length - trustedHops];
    if (entry) return unmapped(entry);
  }
  return socketAddress === undefined ? undefined : unmapped(socketAddress);
}

// A dual-stack listener reports IPv4 peers as ::ffff:a.b.c.d, which would
// count every IPv4 client in one IPv6 /64.
const unmapped = (address: string) => address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
