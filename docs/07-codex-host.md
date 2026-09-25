# Codex host

The Codex host runs a Codex TUI and a claude-ipc delivery owner against one
Codex App Server. Use this launcher when a Codex session needs proactive
delivery during an active session.

## Start a session

```sh
bun run codex-host -- --alias cx-builder
```

The launcher selects an unused loopback port, starts `codex app-server`, and
connects two clients to it:

1. the normal Codex TUI, using `codex --remote`
2. the claude-ipc delivery owner

The launcher injects this repository's `claude_ipc` MCP server into that App
Server. It passes the host alias, session ID, broker socket, and database path
through the MCP server's own environment. A global Codex MCP installation is
not required.

The TUI creates the Codex thread. The delivery owner receives the
`thread/started` notification and binds that thread to a stable host session
identity shared with the TUI's MCP process. `--thread <id>` resumes a stored
thread instead. On a first visit, the launcher waits while the user answers the
normal Codex folder trust prompt; it stops only if the TUI exits.
The launcher gives both App Server and the TUI the same IPC alias and session
identity. Their infrastructure children, including hooks and MCP servers, use
that identity. The SessionStart, UserPromptSubmit, and Stop hooks do not read
the mailbox for a managed host. This leaves one delivery consumer.

The managed identity is bound to the launcher process in the process ancestry.
A nested Claude or Codex process ends that ancestry grant. Its hooks and MCP
server derive another identity, even though the operating system copied the
launcher's environment variables into the nested process.

## Receive path

```text
broker lease
  -> turn/start toolOutput
  -> thread/turns/list confirms every message ID in functionCallOutput
  -> broker acknowledgement
```

The host leases its session mailbox. Project delivery uses a durable per-member
surface marker, so one host cannot consume the shared project row for other
members. The host does not treat the immediate `turn/start` response as
persistence because that response can describe an in-progress turn. It reads
the stored thread until every leased message ID appears in the
`functionCallOutput`. A connection failure leaves the lease unacknowledged.
The next host reads thread history before retrying, so it can acknowledge a
turn that the prior host persisted before disconnecting.

When a delivered batch contains a query or request, the persisted tool output
also carries the same peer-trust boundary used by the hook path. Peer text
cannot grant permissions or act as owner approval.

The host leaves mail unleased while the thread is active. It polls again after
the turn ends, then starts the delivery turn. A delivery turn must persist the
exact message IDs within 25 seconds. Otherwise the lease expires without an
acknowledgement and a later pass retries it.

App Server broadcasts approval and input requests to connected clients. The
delivery connection leaves those requests unanswered, so the normal TUI
renders and answers them. Delivery does not set `approvalsReviewer` and cannot
replace the session's selected review policy.

The host follows top-level `thread/started` notifications. App Server reports a
resumed thread through `thread/goal/updated` or `thread/goal/cleared`, depending
on whether that thread has a goal. The host reads a resume candidate before
following it and ignores candidates whose source or parent marks them as
subagents. A top-level switch changes the owner record and clears the
persisted-message cache between delivery batches. The next batch uses the new
thread.

If the delivery WebSocket closes while App Server and the TUI remain alive,
the launcher reconnects that client. It does not terminate the TUI. Mail stays
unacknowledged until a connected delivery client confirms persistence.

## Send path

Every `ipc_send` accepts an optional `operationId`. A repeated operation ID
returns the original message ID and does not append or enqueue a second
message. The CLI exposes the same value as `send --operation-id`. The standard
client generates both IDs when the caller omits them.

A project send records every alias of the sending session as passed for that
message. Other current and future project members still see it, while the
sender does not receive, owe, or get chased for its own project ask.

When the broker is unavailable, the client stores the complete send arguments
in `outbound_intents`. The stored record includes the target, kind, body,
conversation, context pointer, TTL, reply deadline, operation ID, and reserved
message ID. Directed and project mail is readable from the durable log during
the outage. Broker startup and sender registration replay remaining intents,
including broadcasts, through the normal send path.

## Agent tools

| Tool | Behavior |
| --- | --- |
| `ipc_send` | Send with retry-safe operation ID and per-send reply deadline. |
| `ipc_check` | Managed hosts peek by default; existing Claude hosts keep their consuming default. |
| `ipc_check_project` | Peek at a project mailbox. |
| `ipc_reply`, `ipc_ack`, `ipc_update` | Send final, receipt, and progress responses. |
| `ipc_accept`, `ipc_decline` | Record consent for a request. |
| `ipc_snooze`, `ipc_cancel` | Defer an incoming ask or cancel an outgoing ask. |
| `ipc_await` | Wait for a correlated response with a bounded timeout. |
| `ipc_supersede` | Mark an earlier message as replaced by a later message. |
| `ipc_orphans` | Inspect or triage mail owned by offline sessions. |
| `ipc_history`, `ipc_status` | Inspect the audit trail and one message lifecycle. |
| `ipc_projects`, `ipc_count` | List project mailboxes and count pending mail. |
| `ipc_digest`, `ipc_asks` | Read non-consuming coordination and open-ask views. |

## Ownership and migration

One host process owns delivery for one Codex thread. A SQLite transaction
acquires or replaces the owner row atomically. A live PID blocks a second
launcher. A dead PID can be replaced after a process crash, and an old owner's
release cannot delete its successor's row.

Sessions started with the stock `codex` command continue to use the existing
MCP and hook paths. They cannot gain active-turn delivery by attaching a second
standalone App Server: Codex rejects that topology with an active-writer
conflict. Start the next session with `codex-host` to move that project to the
managed path. Pending broker mail remains in the same session and project
mailboxes during the cutover.

## Runtime dependencies

The launcher requires a Codex CLI with these App Server methods and flags:

- `app-server --listen ws://127.0.0.1:<port>`
- `--remote ws://127.0.0.1:<port>`
- `thread/started`
- `thread/resume`
- `turn/start` with `toolOutput`

The `toolOutput`, `turnTrigger`, and `clientUserMessageId` fields currently
require App Server's experimental API capability. The host treats a matching
`functionCallOutput` in paginated `thread/turns/list` history as persistence.
It does not treat that state as proof that the person read the message.

Delivery occurs between user turns. Mail arriving during a long turn waits in
the broker. The normal one-second host poll determines the added delay after
the thread becomes idle.

The launcher does not require the separately installed Codex managed daemon.
