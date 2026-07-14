import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reclaimStaleMarkers } from "../src/broker/sweeper.ts";

// Tier-3 #14 — the two side-channel dirs (blocked/ per-ask markers, alias-by-sid/
// session→name files) had no reclaim; they grew for the life of the install. The
// sweeper now cleans the dead ones, conservatively enough never to deafen a live
// session by removing an alias file it still polls.
describe("reclaimStaleMarkers", () => {
  let home: string;
  let blockedDir: string;
  let aliasDir: string;
  const NOW = 1_000_000;
  const STALE = 24 * 3600;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "reclaim-"));
    blockedDir = join(home, "blocked");
    aliasDir = join(home, "alias-by-sid");
    mkdirSync(blockedDir, { recursive: true });
    mkdirSync(aliasDir, { recursive: true });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const touch = (path: string, ageSeconds: number): void => {
    const t = NOW - ageSeconds;
    utimesSync(path, t, t);
  };

  test("a blocked marker for a purged message is reclaimed; one for a live message is kept", () => {
    writeFileSync(join(blockedDir, "msg-gone"), "");
    writeFileSync(join(blockedDir, "msg-live"), "");
    const r = reclaimStaleMarkers({
      blockedDir,
      aliasDir,
      hasMessage: (id) => id === "msg-live",
      liveSessionIds: new Set(),
      now: NOW,
      aliasStaleS: STALE,
    });
    expect(r.blocked).toBe(1);
    expect(existsSync(join(blockedDir, "msg-gone"))).toBe(false);
    expect(existsSync(join(blockedDir, "msg-live"))).toBe(true); // still a real ask
  });

  test("a stale alias file with no live session is reclaimed", () => {
    const f = join(aliasDir, "dead-sid");
    writeFileSync(f, "old-name");
    touch(f, STALE + 10); // older than the window
    const r = reclaimStaleMarkers({
      blockedDir,
      aliasDir,
      hasMessage: () => false,
      liveSessionIds: new Set(),
      now: NOW,
      aliasStaleS: STALE,
    });
    expect(r.alias).toBe(1);
    expect(existsSync(f)).toBe(false);
  });

  test("a live session's alias file is NEVER reclaimed — even if it's old on disk", () => {
    const f = join(aliasDir, "live-sid");
    writeFileSync(f, "current-name");
    touch(f, STALE + 9999); // ancient mtime...
    const r = reclaimStaleMarkers({
      blockedDir,
      aliasDir,
      hasMessage: () => false,
      liveSessionIds: new Set(["live-sid"]), // ...but the session is registered
      now: NOW,
      aliasStaleS: STALE,
    });
    expect(r.alias).toBe(0);
    expect(existsSync(f)).toBe(true); // deafening a live session is the failure this guards
  });

  test("a recently-touched alias file is kept even with no registry entry (grace for a just-departed session)", () => {
    const f = join(aliasDir, "recent-sid");
    writeFileSync(f, "name");
    touch(f, 60); // one minute ago
    const r = reclaimStaleMarkers({
      blockedDir,
      aliasDir,
      hasMessage: () => false,
      liveSessionIds: new Set(),
      now: NOW,
      aliasStaleS: STALE,
    });
    expect(r.alias).toBe(0);
    expect(existsSync(f)).toBe(true);
  });

  test("a rename-in-flight .tmp file is left alone", () => {
    const f = join(aliasDir, "sid.12345.tmp");
    writeFileSync(f, "half-written");
    touch(f, STALE + 10);
    const r = reclaimStaleMarkers({
      blockedDir,
      aliasDir,
      hasMessage: () => false,
      liveSessionIds: new Set(),
      now: NOW,
      aliasStaleS: STALE,
    });
    expect(r.alias).toBe(0);
    expect(existsSync(f)).toBe(true);
  });

  test("missing dirs are a no-op, never a throw", () => {
    expect(() =>
      reclaimStaleMarkers({
        blockedDir: join(home, "nope"),
        aliasDir: join(home, "also-nope"),
        hasMessage: () => false,
        liveSessionIds: new Set(),
        now: NOW,
        aliasStaleS: STALE,
      }),
    ).not.toThrow();
  });
});
