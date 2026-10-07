/** Hosts a container must reach directly (its own opencode server), never through the proxy. */
const DEFAULT_NO_PROXY = ["localhost", "127.0.0.1"];

/**
 * The environment a container's HTTP(S) clients need to route through the egress proxy.
 * opencode and git both honour these (opencode: docs/network; git: libcurl), so the proxy
 * is the only path out. See docs/egress.md.
 */
export function proxyEnv(
  proxyUrl: string,
  noProxy: string[] = DEFAULT_NO_PROXY,
): Record<string, string> {
  const bypass = noProxy.join(",");
  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: bypass,
    no_proxy: bypass,
  };
}

/** Render the proxy environment as a systemd `EnvironmentFile` for the container. */
export function renderProxyEnv(proxyUrl: string, noProxy?: string[]): string {
  const env = noProxy === undefined ? proxyEnv(proxyUrl) : proxyEnv(proxyUrl, noProxy);
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}
