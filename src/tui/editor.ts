/**
 * Hand a compose body to $EDITOR and take the result back. The caller is
 * responsible for having left the alternate screen first (the app unmounts its
 * AlternateScreen while this runs) — this only manages the file and the spawn.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.ts";

export async function editInEditor(initial: string): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "ipc-compose-"));
  const file = join(dir, "message.md");
  try {
    writeFileSync(file, initial);
    const editor = config.editor.split(/\s+/);
    const proc = Bun.spawn([...editor, file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    const code = await proc.exited;
    if (code !== 0) return null; // editor aborted — keep what the textarea had
    return readFileSync(file, "utf8").replace(/\n$/, "");
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
