# dsh-oracle

**On-demand SSH dashboard and command console for a Linux server, inside DeepSeek Harness.** Open the page to see how the machine is doing, browse its files, and talk to an assistant that can actually run things on it — without a tunnel, an agent daemon, or anything installed on the server.

Category: **Development & Operations**.

## What changes after installing

- An **Oracle** entry in the left sidebar. Opening it takes a snapshot over SSH — CPU usage, load, memory, disk, uptime — and disconnects again. There is no polling: a chart moves only when you press **Refresh**.
- A **Files** explorer in the same page: a VS Code-style folder tree with a text preview beside it. It starts at `/home/ubuntu` and accepts any absolute directory the SSH account can read. It is read-only, and it skips links, mounted subdirectories, credential-shaped names, and sensitive system locations; hidden entries such as `.config` or `.ssh` are listed normally, dimmed, with the same name filtering inside them.
- A **Chat** tab whose assistant has two tools: a bounded snapshot reader, and a shell command runner on the server. `sudo` works wherever the account has passwordless sudo, so installs, service restarts, file edits and deletions all work from the conversation.
- Chats are grouped under their own **Oracle** workspace instead of **Ungrouped**, and the newest transcript is resumed after a Harness restart, so coming back to the page continues the same conversation.
- **New chat** starts a fresh transcript; older ones stay readable in the sidebar and keep their tools.

## Install

Source repository (no build step, plain JavaScript):

```bash
dsh plugin --profile desktop add github:IAWWW/dsh-oracle
```

Add `--profile <name>` for a different profile.

## Requirements

- A local OpenSSH alias, `oracle`, that connects to the server. The page never invents a destination: it runs `/usr/bin/ssh … oracle`.
- The host key already trusted in `known_hosts`, and either an unencrypted key or an agent holding the passphrase — the plugin runs SSH in batch mode and never prompts.
- Linux with `/usr/bin/python3` on the server. Nothing is installed there and no daemon runs.

Set up the alias once:

```sshconfig
Host oracle
    HostName <server-ip-or-name>
    User <login>
    IdentityFile ~/.ssh/<key>
    IdentitiesOnly yes
```

## Safety

- Every action is a fresh SSH process that ends with the action. The plugin disables forwarding, multiplexing, proxy commands, and TTY allocation; it never stores credentials.
- The Oracle chat is the boundary: any Oracle chat has the two tools, and no other session has either of them. Commands are not individually approved, so the transcript is the audit trail — and remote output is treated as untrusted data, since a hostile log could try to steer the assistant.
- The command runner refuses a short list of machine-destroying commands (`rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs). That is an accident brake, not a security boundary, and no substitute for a least-privileged SSH account.
- A command keeps running on the server if the browser goes away; it is bounded only by its deadline.

## Note

The read-only version that shipped first could only look; the chat could not run anything, and answered "paste me the output of `ps`". The command runner exists because that is what the page is for.
