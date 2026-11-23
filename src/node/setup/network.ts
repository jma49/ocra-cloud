import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { Agent, type Dispatcher, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { certificates } from "./settings.js";

// How the server reaches the company's network: a certificate authority of
// its own and a proxy. Node reads NODE_EXTRA_CA_CERTS only when it starts
// and its fetch ignores HTTPS_PROXY, so both are applied here, for this
// process and for the git and CLI each review runs (../checkout.ts passes
// these variables on).

export type Network = {
  ca?: string | undefined;
  proxy?: string | undefined;
  noProxy?: string | undefined;
};

// Read before any saved authority is added: a later start may remove it.
const DEFAULT_CA = tls.getCACertificates("default");

/** The trusted authorities: Node's own and the environment's, with `ca` added. */
function trusted(ca: string | undefined): string[] {
  return ca ? [...DEFAULT_CA, ...certificates(ca)] : [...DEFAULT_CA];
}

/** What a connection test fetches through: `network` as given, not yet the process's. */
export function dispatcherFor(network: Network): Dispatcher {
  const connect = network.ca ? { ca: trusted(network.ca) } : {};
  if (!network.proxy) return new Agent({ connect });
  return new EnvHttpProxyAgent({
    httpsProxy: network.proxy,
    httpProxy: network.proxy,
    ...(network.noProxy ? { noProxy: network.noProxy } : {}),
    connect,
    requestTls: connect,
    proxyTls: connect,
  });
}

const NETWORK_VARS = [
  "NODE_EXTRA_CA_CERTS",
  "GIT_SSL_CAINFO",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;

/**
 * Applies the saved authority and proxy to this process, where `original`,
 * its environment as it started, set none of its own; `env` is what the
 * children get, set again on each start. The authority goes to a file the
 * children read too: Node's NODE_EXTRA_CA_CERTS, and for git a whole
 * bundle, since GIT_SSL_CAINFO replaces the system's.
 */
export async function applyNetwork(
  saved: Network,
  original: Readonly<Record<string, string | undefined>>,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const name of NETWORK_VARS) {
    if (original[name] === undefined) delete env[name];
    else env[name] = original[name];
  }
  const ca = !original.NODE_EXTRA_CA_CERTS ? saved.ca : undefined;
  tls.setDefaultCACertificates(trusted(ca));
  if (ca) {
    const dir = await mkdtemp(join(tmpdir(), "ocra-ca-"));
    const own = join(dir, "company-ca.pem");
    const bundle = join(dir, "bundle.pem");
    await writeFile(own, `${certificates(ca).join("\n")}\n`);
    await writeFile(bundle, `${trusted(ca).join("\n")}\n`);
    env.NODE_EXTRA_CA_CERTS = own;
    env.GIT_SSL_CAINFO ||= bundle;
  }
  if (saved.proxy && !original.HTTPS_PROXY && !original.https_proxy) {
    env.HTTPS_PROXY = saved.proxy;
    env.HTTP_PROXY ||= saved.proxy;
    if (saved.noProxy && !original.NO_PROXY && !original.no_proxy) env.NO_PROXY = saved.noProxy;
  }
  const proxied = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  // Node's own fetch is left alone until a proxy is first set.
  if (proxied || replaced) setGlobalDispatcher(proxied ? new EnvHttpProxyAgent() : new Agent());
  replaced ||= !!proxied;
}

let replaced = false;
