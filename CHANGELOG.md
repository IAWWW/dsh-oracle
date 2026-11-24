# Changelog

## 1.0.0 — first public release

- **Oracle** sidebar page: on-demand SSH snapshot with CPU usage, load average, memory and disk charts, colored by pressure and refreshed only when asked.
- **Files** explorer: VS Code-style folder tree with lazy folder loading, bounded pagination, and plain-text previews. Read-only, filtered, scoped to a chosen absolute directory, defaulting to `/home/ubuntu`.
- **Chat** with a dedicated agent: bounded snapshot tool plus a shell command runner (`oracle_exec`) that returns exit code, stdout and stderr, with a 32 KiB per-stream cap, adjustable deadline, and a short refusal list for machine-destroying commands.
- Oracle chats group under their own **Oracle** workspace; the newest transcript is resumed after a Harness restart, and **New chat** starts a fresh one.
- No background work: every action is one SSH process that ends with it. No polling, no tunnel, no heartbeat, no idle socket.
- Authenticated Host routes behind the Harness connection fence; the tool set, not a browser connection, is the permission boundary.
