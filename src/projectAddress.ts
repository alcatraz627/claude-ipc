/**
 * Project mailboxes: a durable address for "whoever works on this project"
 * rather than one session — mail waits for the next session in that directory
 * tree instead of dying with a closed one. An address is `proj:` + an absolute
 * path. Membership is lineage (ancestor or descendant of the session's cwd);
 * anyone may peek, only members consume. Design + evidence: activation report
 * 11 (closed-mail mining).
 */

export const PROJECT_PREFIX = "proj:";

export function isProjectAddress(addr: string): boolean {
  return addr.startsWith(PROJECT_PREFIX);
}

/** Canonical form: absolute path, no trailing slash (except root). */
export function normalizeProjectPath(p: string): string {
  let out = p.trim();
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

export function projectAddress(path: string): string {
  return PROJECT_PREFIX + normalizeProjectPath(path);
}

export function projectPath(addr: string): string {
  return normalizeProjectPath(addr.slice(PROJECT_PREFIX.length));
}

/** True when one path is the other, or an ancestor of the other. */
export function sameLineage(a: string, b: string): boolean {
  const x = normalizeProjectPath(a);
  const y = normalizeProjectPath(b);
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}
