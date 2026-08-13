import { isIP } from 'net';

const HOSTNAME_RE = /^(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)$/;

export function isLoopbackBindHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  const version = isIP(host);
  if (version === 4) return host.split('.')[0] === '127';
  return version === 6 && host === '::1';
}

export function assertSafeNoAuthBind(host: string): void {
  if (!isLoopbackBindHost(host)) {
    throw new Error('Nebula no-auth mode requires a literal loopback bind host');
  }
}

/** The host the operator explicitly chose (CLI beats env), or undefined. */
export function explicitBindHost(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--host') return argv[index + 1];
    if (value.startsWith('--host=')) return value.slice('--host='.length);
  }
  return environment.NEBULA_BIND_HOST;
}

export function resolveBindHost(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const candidate = (explicitBindHost(argv, environment) ?? '0.0.0.0').trim();
  if (
    candidate.length === 0
    || candidate.length > 253
    || /[\u0000-\u0020\u007f/\\?#@]/.test(candidate)
    || (isIP(candidate) === 0 && !HOSTNAME_RE.test(candidate))
  ) {
    throw new Error(`Invalid Nebula bind host: ${JSON.stringify(candidate)}`);
  }
  return candidate;
}

/**
 * Bind host for explicit no-auth mode. An unauthenticated server must never
 * listen on the network ACCIDENTALLY, but the quickstart
 * (`NEBULA_NO_AUTH=true npx nebula-notebook`) must still boot: no chosen host
 * defaults to loopback, and only an explicitly non-loopback choice is refused.
 */
export function resolveNoAuthBindHost(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (explicitBindHost(argv, environment) === undefined) return '127.0.0.1';
  const host = resolveBindHost(argv, environment);
  assertSafeNoAuthBind(host);
  return host;
}
