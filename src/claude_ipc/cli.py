"""Command-line entry point for claude-ipc.

The human's thin client for sending, inspecting, and approving messages, plus
broker control. The full verb set arrives in Phase 4; this stub keeps the
``claude-ipc`` entry point importable and gives a clear status until then.
"""

import sys


def main(argv: list[str] | None = None) -> int:
    """Run the claude-ipc CLI. Currently a placeholder until Phase 4."""
    print("claude-ipc: CLI is implemented in Phase 4 (see docs/05-roadmap.md).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
