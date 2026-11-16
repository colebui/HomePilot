import { execFileSync } from 'node:child_process';

/** Keychain "service" name under which HomePilot secrets are stored on macOS. */
export const KEYCHAIN_SERVICE = 'homepilot';

/**
 * Resolve a secret by name. Order: environment variable, then (macOS only) the login Keychain.
 * The value is returned to the caller and never logged, cached to disk or included in errors.
 *
 * Store one with (the command prompts for the value, so it stays out of shell history):
 *   security add-generic-password -U -s homepilot -a OPENROUTER_API_KEY -w
 *
 * NOTE: the Keychain lookup was written on Linux and has NOT been run on a real Mac yet.
 */
export function resolveSecret(name: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const fromEnv = env[name];
  if (fromEnv) return fromEnv;
  if (process.platform !== 'darwin') return undefined;
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
