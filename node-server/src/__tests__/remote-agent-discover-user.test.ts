// @vitest-environment node
/**
 * Discovering the username on the user's machine.
 *
 * Lab report: "for continue session on remote machine I cannot use it until I
 * put in my username — I thought it should already know." Nebula can in fact
 * find it: the reverse tunnel reaches the user's sshd, and `whoami` over it
 * answers authoritatively. The only guess needed is WHICH login to try, and
 * the server's own username is the overwhelmingly common answer (it is also
 * what plain `ssh localhost` would use).
 */

import { describe, it, expect } from 'vitest';
import { candidateUsernames, parseWhoami } from '../terminal/remote-agent-identity';

describe('candidateUsernames', () => {
  it('tries the server username first — the same login plain ssh would use', () => {
    expect(candidateUsernames('jianzhou', undefined)[0]).toBe('jianzhou');
  });

  it('puts an explicit hint ahead of the server username, without dropping it', () => {
    const list = candidateUsernames('svc-account', 'jzhou');
    expect(list[0]).toBe('jzhou');
    expect(list).toContain('svc-account');
  });

  it('de-duplicates and drops blanks', () => {
    expect(candidateUsernames('jianzhou', 'jianzhou')).toEqual(['jianzhou']);
    expect(candidateUsernames('', '  ')).toEqual([]);
  });

  it('rejects logins that are not safe to put in an ssh argument', () => {
    // A username reaches an ssh command line; anything outside the POSIX
    // login-name set is refused rather than escaped.
    expect(candidateUsernames('root; rm -rf /', undefined)).toEqual([]);
    expect(candidateUsernames('a b', undefined)).toEqual([]);
    expect(candidateUsernames('ok_user-1.x', undefined)).toEqual(['ok_user-1.x']);
  });
});

describe('parseWhoami', () => {
  it('takes the login from a marked line, ignoring login-shell chatter', () => {
    expect(parseWhoami('Last login: Tue\nNB_USER=jianzhou\n')).toBe('jianzhou');
  });

  it('returns null when the marker is absent or empty (auth failed, or no shell)', () => {
    expect(parseWhoami('Permission denied (publickey).')).toBe(null);
    expect(parseWhoami('NB_USER=\n')).toBe(null);
  });

  it('refuses a marker value that is not a plausible login', () => {
    expect(parseWhoami('NB_USER=not a login\n')).toBe(null);
  });
});
