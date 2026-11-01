// Where this Nebula is served: '/' at its own address, or under a prefix
// such as '/s/nebula/' behind a reverse proxy (hop Views, a cluster
// gateway). Read once at load from the address of the bundle itself — the
// built entry sits at <base>assets/index-<hash>.js — so one build works at
// any prefix with no configuration. The proxy strips the prefix on the way
// in; the server keeps its routes at '/'.
//
// The app was written with root-absolute addresses ('/api/…', '/?file=…')
// in many places. Rather than thread the prefix through every one, fetch
// and WebSocket are wrapped once, here, to put a root-absolute address under
// the base; links and image sources (which never pass through fetch) use
// withBase() explicitly. At the root ('/') none of this changes anything.

const ASSET_ENTRY = /^(.*\/)assets\/[^/]+\.js$/;

/** The base path ('/…/', always ending in a slash) for a bundle served at `moduleUrl`. */
export function computeBase(moduleUrl: string): string {
  try {
    const m = ASSET_ENTRY.exec(new URL(moduleUrl).pathname);
    return m ? m[1] : '/';
  } catch {
    return '/';
  }
}

export const BASE: string = computeBase(import.meta.url);

/** A root-absolute app path ('/api/x', '/?file=y') under the base; anything else unchanged. */
export function withBase(path: string, base: string = BASE): string {
  if (base === '/' || !path.startsWith('/') || path.startsWith('//')) return path;
  if (path === base.slice(0, -1) || path.startsWith(base)) return path;
  return base + path.slice(1);
}

/** A same-host absolute URL (http or ws) moved under the base; other hosts unchanged. */
export function urlWithBase(url: string, host: string, base: string = BASE): string {
  if (base === '/') return url;
  try {
    const u = new URL(url);
    if (u.host !== host) return url;
    const path = withBase(u.pathname, base);
    if (path === u.pathname) return url;
    u.pathname = path;
    return u.toString();
  } catch {
    return url;
  }
}

/** Wrap fetch and WebSocket so the app's root-absolute addresses reach this Nebula under its base. */
export function installBaseShims(base: string = BASE): void {
  if (base === '/' || typeof window === 'undefined') return;
  const w = window as Window & { __nebulaBaseShims?: boolean };
  if (w.__nebulaBaseShims) return;
  w.__nebulaBaseShims = true;

  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (typeof input === 'string') return originalFetch.call(window, withBase(input, base), init);
    if (input instanceof URL) return originalFetch.call(window, new URL(urlWithBase(input.toString(), window.location.host, base)), init);
    const moved = urlWithBase(input.url, window.location.host, base);
    return originalFetch.call(window, moved === input.url ? input : new Request(moved, input), init);
  };

  const OriginalWebSocket = window.WebSocket;
  const BasedWebSocket = function (url: string | URL, protocols?: string | string[]) {
    const raw = typeof url === 'string' ? url : url.toString();
    const moved = raw.startsWith('/') ? withBase(raw, base) : urlWithBase(raw, window.location.host, base);
    return protocols === undefined ? new OriginalWebSocket(moved) : new OriginalWebSocket(moved, protocols);
  } as unknown as typeof WebSocket;
  BasedWebSocket.prototype = OriginalWebSocket.prototype;
  Object.assign(BasedWebSocket, {
    CONNECTING: OriginalWebSocket.CONNECTING, OPEN: OriginalWebSocket.OPEN,
    CLOSING: OriginalWebSocket.CLOSING, CLOSED: OriginalWebSocket.CLOSED,
  });
  window.WebSocket = BasedWebSocket;
}

installBaseShims();
