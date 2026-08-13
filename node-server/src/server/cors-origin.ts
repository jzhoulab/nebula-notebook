import { isIP } from 'net';

function isLiteralLoopback(hostname: string): boolean {
  const normalized = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const version = isIP(normalized);
  if (version === 4) return normalized.split('.')[0] === '127';
  if (version === 6) return normalized === '::1';
  return normalized.toLowerCase() === 'localhost';
}

export function isTrustedBrowserOrigin(
  origin: string,
  configuredOrigins: readonly string[] = [],
): boolean {
  if (configuredOrigins.includes(origin)) return true;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    if (parsed.pathname !== '/') return false;
    return isLiteralLoopback(parsed.hostname);
  } catch {
    return false;
  }
}
