# claude-ipc badge ↔ gcc tab-title coexistence

By default the broker writes the WHOLE tab title (`📨 N · alias`) straight to a
peer's pty (Phase 7). That fights the gcc tab-title system, which re-renders the
whole title every turn — so on a gcc session the two race (last writer per turn
wins). Two clean ways to coexist:

## Recommended — let gcc own the title; add an IPC *segment*
1. Disable the broker badge: run the broker with `CLAUDE_IPC_BADGE=0`.
2. Add an `ipc` segment to your gcc tab-title that runs, cheaply, each turn — it
   uses the dedicated count op (one indexed lookup, no message parsing):
   ```bash
   n=$(claude-ipc count "$SESSION_ALIAS" 2>/dev/null || echo 0)
   [ "$n" -gt 0 ] && printf '📨%s ' "$n"
   ```
   Render it alongside your existing status/mode/intent/focus segments. The gcc
   system stays the title owner; IPC is just one more segment — no clobber, and
   it survives the per-turn re-render because gcc itself draws it.

## Alternative — broker badge only (no gcc tab-title on that tab)
Leave `CLAUDE_IPC_BADGE=1` (default). Fine for tabs that don't run the gcc
tab-title system (the badge is then the sole title writer, and it's idle-proof).
On gcc sessions, prefer the segment approach above.
