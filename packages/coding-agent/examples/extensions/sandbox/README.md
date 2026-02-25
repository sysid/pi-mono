# Sandbox Extension

OS-level and application-level sandboxing for the pi coding agent, restricting filesystem access
and network calls.

## Use Case

LLM agents execute arbitrary tool calls. Without sandboxing, the agent can:

- **Read secrets**: `~/.ssh/id_rsa`, `~/.aws/credentials`, `~/.gnupg/` keys
- **Write sensitive files**: `.env`, `*.pem`, `*.key`
- **Exfiltrate data**: `curl` to arbitrary domains
- **Modify system files**: write outside the project directory

This extension enforces restrictions at two independent layers so that both shell commands and
built-in tools are constrained.

## Security Boundary

```
┌──────────────────────────────────────────────────┐
│                    LLM Agent                     │
│                                                  │
│   bash commands            built-in tools        │
│   (cat, curl, rm, ...)     (read, write, edit,   │
│                             grep, find, ls)      │
│         │                        │               │
│         ▼                        ▼               │
│   ┌───────────┐          ┌─────────────┐         │
│   │  OS-Level │          │  Path Guard │         │
│   │  Sandbox  │          │  (tool_call │         │
│   │           │          │   handler)  │         │
│   │ sandbox-  │          │             │         │
│   │ exec/bwrap│          │ path-guard  │         │
│   └───────────┘          │ .ts         │         │
│         │                └─────────────┘         │
│         ▼                        ▼               │
│               Filesystem / Network               │
└──────────────────────────────────────────────────┘
```

**Layer 1 — OS sandbox** (`sandbox-exec` on macOS, `bubblewrap` on Linux): Kernel-enforced
restrictions on all bash commands. Handles filesystem deny/allow rules and network domain filtering
at the process level.

**Layer 2 — Path guard** (`tool_call` event handler): Application-level interception of pi's
built-in file tools before they reach the Node.js `fs` module. Enforces the same
`denyRead`/`allowWrite`/`denyWrite` rules from the sandbox config.

### What Is Protected

| Tool | Layer | Mechanism |
|------|-------|-----------|
| `bash` | OS sandbox | Command wrapped via `SandboxManager.wrapWithSandbox()` |
| `read` | Path guard | `tool_call` handler checks `denyRead` directories |
| `write` | Path guard | `tool_call` handler checks `denyWrite` patterns + `allowWrite` paths |
| `edit` | Path guard | `tool_call` handler checks `denyWrite` patterns + `allowWrite` paths |
| `grep` | Path guard | `tool_call` handler checks `denyRead` directories |
| `find` | Path guard | `tool_call` handler checks `denyRead` directories |
| `ls` | Path guard | `tool_call` handler checks `denyRead` directories |
| User `!` bash | OS sandbox | `user_bash` event handler wraps command |

## Setup

1. Copy the `sandbox/` directory to `~/.pi/agent/extensions/`
2. Run `npm install` inside the copied directory
3. Linux additionally requires: `bubblewrap`, `socat`, `ripgrep`

## Usage

```bash
# Run with sandbox enabled (default config)
pi -e ~/.pi/agent/extensions/sandbox

# Run with sandbox explicitly disabled
pi -e ~/.pi/agent/extensions/sandbox --no-sandbox

# Inside a session, inspect the active config
/sandbox
```

## Configuration

Config files are loaded and merged in order (later wins):

1. Built-in defaults (see below)
2. `~/.pi/agent/sandbox.json` (global)
3. `<cwd>/.pi/sandbox.json` (project-local)

### Example `.pi/sandbox.json`

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": ["github.com", "*.github.com", "registry.npmjs.org"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

### Configuration Fields

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | `boolean` | Enable/disable the entire sandbox. Default: `true` |
| `network.allowedDomains` | `string[]` | Domains the agent can reach. Supports `*` wildcards. |
| `network.deniedDomains` | `string[]` | Domains explicitly blocked. |
| `filesystem.denyRead` | `string[]` | Directory paths the agent cannot read from. Supports `~` and `.` expansion. |
| `filesystem.allowWrite` | `string[]` | Directory paths the agent can write to. Default-deny: writes outside these paths are blocked. Supports `~` and `.` expansion. |
| `filesystem.denyWrite` | `string[]` | Filename patterns the agent cannot write, even inside allowed directories. Takes precedence over `allowWrite`. |
| `ignoreViolations` | `Record<string, string[]>` | Passed to `@anthropic-ai/sandbox-runtime`. Suppress specific OS-level violation categories. |
| `enableWeakerNestedSandbox` | `boolean` | Passed to `@anthropic-ai/sandbox-runtime`. Allow weaker nested sandbox profiles. |

### Default Configuration

```json
{
  "enabled": true,
  "network": {
    "allowedDomains": [
      "npmjs.org", "*.npmjs.org", "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org", "*.pypi.org",
      "github.com", "*.github.com", "api.github.com",
      "raw.githubusercontent.com"
    ],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

## Enforcement Rules

### Read Restrictions

`denyRead` entries are **directory paths**. Path specials (`~`, `.`, `./sub`) are expanded at runtime.

A read is **blocked** if the resolved file path equals or is under any `denyRead` directory:

```
read ~/.ssh/id_rsa
  → resolved: /Users/you/.ssh/id_rsa
  → denyRead: ~/.ssh → /Users/you/.ssh
  → /Users/you/.ssh/id_rsa is under /Users/you/.ssh
  → BLOCKED
```

### Write Restrictions

Writes are checked in two stages — **deny first, then allow**:

1. **`denyWrite`** (filename patterns, checked first — deny wins):
   - Literal: `.env` matches only `.env`
   - Suffix glob: `*.pem` matches `cert.pem`, `server.pem`
   - Prefix glob: `.env.*` matches `.env.local`, `.env.production`

2. **`allowWrite`** (directory paths, default-deny):
   - The resolved file path must be under at least one `allowWrite` directory
   - If not under any allowed path → **BLOCKED**

```
write /work/project/.env.local
  → denyWrite: .env.* matches .env.local
  → BLOCKED (deny wins, even though /work/project is under allowWrite ".")

write /work/project/src/main.ts
  → denyWrite: no pattern matches
  → allowWrite: "." → /work/project, file is under it
  → ALLOWED

write /etc/passwd
  → denyWrite: no pattern matches
  → allowWrite: "." → /work/project, "/tmp"
  → /etc/passwd is under neither
  → BLOCKED
```

## Fail-Closed Behavior

The extension is designed to fail safely:

| Scenario | Behavior |
|----------|----------|
| Sandbox init succeeds | All restrictions enforced |
| Sandbox init **fails** | Bash commands are **blocked**; tool guard remains active. Error message shown. |
| `--no-sandbox` flag | All restrictions disabled (explicit user choice) |
| `enabled: false` in config | All restrictions disabled (explicit user choice) |
| Unsupported platform | OS sandbox disabled; tool guard remains active |

If sandbox initialization fails, the agent cannot run bash commands at all. Tool guard still applies to built-in tools. Use `--no-sandbox` to explicitly opt out of **all** protection.

## Known Limitations

**Symlinks**: The path guard follows symlinks via `realpathSync()` when both the file and directory
exist on disk. However, if a symlink target does not yet exist at check time, the guard falls back
to string-based path comparison. A symlink created between the check and the actual I/O operation
could bypass the guard (TOCTOU).

**TOCTOU**: There is an inherent time-of-check-to-time-of-use gap between the `tool_call` path
check and the actual filesystem operation. The OS-level sandbox does not have this issue since it's
enforced atomically by the kernel.

**Custom tools**: Only built-in tools (`bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`) are
guarded. Tools registered by other extensions are not intercepted by the path guard.

**Config reload**: Configuration is loaded once at session start. Changes to `sandbox.json` during
a session require restarting pi.

**Pattern matching**: `denyWrite` uses simple basename patterns (literal, `*.ext`, `prefix.*`).
Full glob or regex patterns are not supported. `denyRead` uses directory containment, not filename
patterns.

**Platform support**: OS-level sandboxing requires macOS (`sandbox-exec`) or Linux (`bubblewrap`).
Windows is not supported. The path guard layer works on all platforms and activates whenever the
sandbox config is enabled (even if OS sandboxing is unavailable).

## Manual Test Plan

Run each test from a project directory with the sandbox extension loaded:

```bash
pi -e ./packages/coding-agent/examples/extensions/sandbox
```

### Test 1: Verify Sandbox Active

```
/sandbox
```

Expected: Config summary including OS sandbox/tool guard status and denyRead/allowWrite/denyWrite entries.

### Test 2: Path Guard — Read Denied

Ask the agent:

> Read the file ~/.ssh/id_rsa

| What to check | Expected |
|---------------|----------|
| Notification | "Sandbox blocked read: ~/.ssh/id_rsa" |
| Tool result | Blocked with reason mentioning `~/.ssh` |
| File contents | NOT returned to the agent |

Repeat for `~/.aws/credentials` and `~/.gnupg/secring.gpg`.

### Test 3: Path Guard — Read Allowed

Ask the agent:

> Read the file package.json

| What to check | Expected |
|---------------|----------|
| Notification | None (no block) |
| Tool result | File contents returned normally |

### Test 4: Path Guard — Write Denied (denyWrite pattern)

Ask the agent:

> Write "SECRET=foo" to the file .env

| What to check | Expected |
|---------------|----------|
| Notification | "Sandbox blocked write: .env" |
| Tool result | Blocked with reason mentioning `.env` pattern |
| File on disk | `.env` NOT created/modified |

Repeat for `.env.local` (matches `.env.*`), `cert.pem` (matches `*.pem`), `server.key` (matches `*.key`).

### Test 5: Path Guard — Write Denied (outside allowWrite)

Ask the agent:

> Write "pwned" to /etc/test-sandbox

| What to check | Expected |
|---------------|----------|
| Notification | "Sandbox blocked write: /etc/test-sandbox" |
| Tool result | Blocked — not under any allowWrite path |
| File on disk | NOT created |

### Test 6: Path Guard — Write Allowed

Ask the agent:

> Write "hello" to /tmp/sandbox-test.txt

| What to check | Expected |
|---------------|----------|
| Notification | None (no block) |
| Tool result | File written successfully |

Also test writing a normal project file (e.g. `src/test-sandbox.ts`).

### Test 7: OS Sandbox — Bash Read Denied

Ask the agent:

> Run: cat ~/.ssh/id_rsa

| What to check | Expected |
|---------------|----------|
| bash exit code | Non-zero (OS sandbox denied) |
| Output | Permission denied or empty |

### Test 8: OS Sandbox — Bash Write Denied

Ask the agent:

> Run: echo "pwned" > /etc/test-sandbox

| What to check | Expected |
|---------------|----------|
| bash exit code | Non-zero |
| Output | Permission denied |

### Test 9: OS Sandbox — Bash Allowed

Ask the agent:

> Run: echo "hello" > /tmp/sandbox-bash-test.txt && cat /tmp/sandbox-bash-test.txt

| What to check | Expected |
|---------------|----------|
| bash exit code | 0 |
| Output | "hello" |

### Test 10: OS Sandbox — Network Denied

Ask the agent:

> Run: curl -s https://evil.example.com

| What to check | Expected |
|---------------|----------|
| bash exit code | Non-zero |
| Output | Connection refused or timeout |

### Test 11: OS Sandbox — Network Allowed

Ask the agent:

> Run: curl -sI https://github.com | head -1

| What to check | Expected |
|---------------|----------|
| bash exit code | 0 |
| Output | HTTP status line (e.g. `HTTP/2 200`) |

### Test 12: Fail-Closed — Init Failure

Break sandbox init by providing an invalid config:

```bash
mkdir -p .pi && echo '{"filesystem":' > .pi/sandbox.json
pi -e ./packages/coding-agent/examples/extensions/sandbox
```

| What to check | Expected |
|---------------|----------|
| Startup notification | Error about sandbox init failure |
| Ask agent to run any bash command | Error: "Sandbox initialization failed. Use --no-sandbox to run without protection." |
| `/sandbox` output | Status shows OS sandbox FAILED (bash blocked), tool guard enabled |

Clean up: `rm .pi/sandbox.json`

### Test 13: Explicit Disable — `--no-sandbox`

```bash
pi -e ./packages/coding-agent/examples/extensions/sandbox --no-sandbox
```

| What to check | Expected |
|---------------|----------|
| Startup notification | "Sandbox disabled via --no-sandbox" |
| `cat ~/.ssh/id_rsa` via bash | Works (no OS sandbox) |
| `read ~/.ssh/id_rsa` via tool | Works (no path guard) |

### Test 14: Path Guard — grep/find/ls on Restricted Paths

Ask the agent:

> Search for "password" in ~/.aws/

| What to check | Expected |
|---------------|----------|
| Notification | "Sandbox blocked read: ~/.aws/" |
| Tool result | Blocked |

Repeat with `find` and `ls` targeting `~/.ssh`.

### Summary Matrix

```
Test  Layer        Operation  Direction  Expected
────  ───────────  ─────────  ─────────  ────────
 1    —            /sandbox   —          Config shown
 2    Path guard   read       denied     BLOCKED
 3    Path guard   read       allowed    OK
 4    Path guard   write      denied     BLOCKED (pattern)
 5    Path guard   write      denied     BLOCKED (outside allowWrite)
 6    Path guard   write      allowed    OK
 7    OS sandbox   bash read  denied     BLOCKED
 8    OS sandbox   bash write denied     BLOCKED
 9    OS sandbox   bash write allowed    OK
10    OS sandbox   network    denied     BLOCKED
11    OS sandbox   network    allowed    OK
12    Fail-closed  bash       init fail  BLOCKED
13    --no-sandbox all        disabled   OK (unrestricted)
14    Path guard   grep/find  denied     BLOCKED
```
