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

/**
 * True when one path is the other, or an ancestor of the other.
 *
 * The relation for SEEING a project mailbox, which runs both ways on purpose: a repo
 * root may read what its subdirectories were sent, and vice versa. Visibility here is
 * deliberately open — no silos.
 */
export function sameLineage(a: string, b: string): boolean {
  const x = normalizeProjectPath(a);
  const y = normalizeProjectPath(b);
  return x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
}

/**
 * True when a session working in `cwd` may CLAIM mail addressed to the project at `dir`.
 *
 * One-directional, unlike seeing it. Working inside a repo makes you a member of it;
 * being an ancestor of it does not. Treating those the same made a session opened in the
 * home directory a member of every project on the machine, and its per-turn hook drained
 * their mail on the way past.
 */
export function withinProject(cwd: string, dir: string): boolean {
  const x = normalizeProjectPath(cwd);
  const y = normalizeProjectPath(dir);
  return x === y || x.startsWith(y + "/");
}
