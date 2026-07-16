# Env-var access

**All tunable/global configuration goes through `src/config.ts`.** It is the one
place that reads `process.env`, parses/validates each value, and exports a frozen
`config` object. Modules import `config` and read `config.<field>` — they do not
read `process.env` directly.

Adding a new env var = add a field to `config.ts` (with a comment and a default),
then reference `config.<field>`. This keeps defaults and parsing in one place and
makes every knob discoverable.

```ts
// config.ts
strict: (process.env.CLAUDE_IPC_STRICT ?? "1") !== "0",
noRegister: process.env.CLAUDE_IPC_NO_REGISTER === "1",

// elsewhere
import { config } from "../config.ts";
if (config.noRegister) return;
```

## The one documented exception: per-session identity

Identity resolution at a process entry point reads env **and** hook-stdin
together to answer "who am I, this invocation" — not global config. These live at
the entry points, not in `config.ts`:

- `src/mcpServer.ts` `resolveIdentity()` — `CLAUDE_IPC_ALIAS` / `CLAUDE_IPC_SESSION`
  / `CLAUDE_IPC_TRANSCRIPT`, combined with `process.cwd()`.
- `src/hooks/shared.ts` `aliasFor()` — `CLAUDE_IPC_ALIAS` vs the hook's
  `session_id` / `session_title`, plus the recorded side-file alias.
- `src/hooks/sessionStart.ts` — `CLAUDE_IPC_TTY` passed straight to register.
- `src/cli.ts` `register` — `CLAUDE_CODE_SESSION_ID` names which session to
  rebind (the harness exports it to the session's Bash). Per-invocation identity,
  not global config.
- `src/cli.ts` `resolveSelfAlias()` — `CLAUDE_CODE_SESSION_ID` → this session's
  recorded alias, so `send`/`reply` infer `--from` without a session naming
  itself. Same per-invocation identity read as `register`, at the boundary.
- `src/tui/identity.ts` `sessionIdentity()` — the dashboard's entry-point copy
  of the `resolveSelfAlias()` read (importing it from `cli.ts` would cycle:
  cli → tui app → identity).

These are per-invocation identity, not shared configuration, so they stay at the
boundary. Everything else routes through `config.ts`.
