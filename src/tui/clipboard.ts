/**
 * Put text on the system clipboard. macOS-first (pbcopy), matching where the
 * broker runs today; a failure returns false so the caller can toast an honest
 * error instead of claiming a copy that didn't happen.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    proc.stdin.write(text);
    await proc.stdin.end();
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
