# Sysid Extensions to pi-mono Sandbox

This documents all modifications on the `sysid` branch relative to upstream `main`.

## Overview

The `sysid` branch adds several features to the sandbox extension and the
coding-agent monorepo. All changes live in `packages/coding-agent/`.

| Feature | Files | Commit |
|---------|-------|--------|
| Path guard (tool-level enforcement) | `sandbox/path-guard.ts`, `sandbox/index.ts` | `fddab8cd` |
| Tool guard without OS sandbox | `sandbox/index.ts` | `f4e4d7a9` |
| Patched sandbox-runtime (sysid fork) | `sandbox/package.json` | `7331fc39` |
| `enableWeakerNetworkIsolation` passthrough | `sandbox/index.ts` | _(uncommitted)_ |
| Vim editor extension | `extensions/vim-editor.ts` | `08b394e8` |
| Access guard extension | `extensions/access-guard.ts` | `1f267728` |
| CODEX system prompt | `SYSID_SYSTEM_PROMPT.md` | `b497c8f2` |
| Makefile (binary install + sandbox dev) | `Makefile`, `sandbox/Makefile` | `43e29a2b` |

---

## 1. Path Guard (In-Process Tool Enforcement)

**Problem:** The upstream sandbox only wraps `bash` commands via
`sandbox-exec` / bubblewrap. Built-in tools (`read`, `write`, `edit`, `grep`,
`find`, `ls`) bypass the OS sandbox entirely because they run in-process.

**Solution:** `path-guard.ts` implements filesystem access checks
(`isReadBlocked`, `isWriteBlocked`) that enforce the same `denyRead`,
`allowWrite`, `denyWrite` rules on built-in tools via the `tool_call` event.

Key design decisions:
- `denyWrite` takes precedence over `allowWrite` (deny-first)
- Write access is default-deny: paths must be under an `allowWrite` entry
- `~` expansion and symlink resolution via `realpathSync`
- Glob-like basename matching (`*.pem`, `.env.*`)

### Files

```
sandbox/path-guard.ts       -- Pure functions: isReadBlocked, isWriteBlocked, etc.
sandbox/path-guard.test.ts  -- Unit tests (228 lines, covers edge cases)
sandbox/index.ts            -- Registers tool_call handler using path-guard
```

## 2. Tool Guard Without OS Sandbox

**Problem:** When `SandboxManager.initialize()` fails (unsupported platform,
missing dependencies, permissions), the original code silently fell back to
unsandboxed mode with no file-access restrictions at all.

**Solution:** Introduced `sandboxFailed` and `toolGuardEnabled` flags. On init
failure, tool guard stays active (blocking built-in tool access to restricted
paths) while bash commands are blocked entirely. This provides defense-in-depth
even without OS-level sandboxing.

**Behavior matrix:**

| Condition | Bash | Built-in tools |
|-----------|------|----------------|
| Sandbox OK | Sandboxed | Path-guarded |
| Sandbox failed | BLOCKED | Path-guarded |
| `--no-sandbox` | Unsandboxed | Unguarded |
| Config `enabled: false` | Unsandboxed | Unguarded |

## 3. Patched Sandbox-Runtime (sysid Fork)

**Problem:** The upstream `@anthropic-ai/sandbox-runtime` does not support
certain configuration flags needed for Go toolchain TLS (see section 4).

**Solution:** `package.json` pins the dependency to `github:sysid/sandbox-runtime#sysid`.

```json
"dependencies": {
    "@anthropic-ai/sandbox-runtime": "github:sysid/sandbox-runtime#sysid"
}
```

This fork includes the `enableWeakerNetworkIsolation` support in the native
sandbox profiles.

## 4. `enableWeakerNetworkIsolation` Passthrough

**Problem:** Go tools (`gh`, etc.) fail with `x509: OSStatus -26276` inside
the sandbox because `com.apple.trustd.agent` is blocked by default network
isolation. Setting `enableWeakerNetworkIsolation: true` in
`~/.pi/agent/sandbox.json` had no effect because the extension did not pass
the flag to `SandboxManager.initialize()`.

**Solution:** Added `enableWeakerNetworkIsolation` to the `SandboxConfig`
interface and `deepMerge`, then passed it through to `SandboxManager.initialize()`.

Config example (`~/.pi/agent/sandbox.json`):
```json
{
    "enableWeakerNetworkIsolation": true
}
```

## 5. Other Extensions (Outside Sandbox)

### Vim Editor (`extensions/vim-editor.ts`)
Registers a custom editor tool that opens files in `$EDITOR` (typically vim/neovim)
with terminal integration.

### Access Guard (`extensions/access-guard.ts`)
A standalone tool-call guard (separate from sandbox) that provides configurable
access restrictions via `ACCESS_GUARD.md`.

### CODEX System Prompt (`SYSID_SYSTEM_PROMPT.md`)
Custom system prompt for use with CODEX-style workflows.

---

## Development

### Prerequisites

```bash
# From monorepo root
npm install

# Sandbox extension dependencies (separate package, NOT a workspace member)
cd packages/coding-agent/examples/extensions/sandbox
npm install
```

### Makefile (sandbox/)

The sandbox extension has its own `Makefile` for local development:

```
make test          # Run path-guard unit tests
make test-watch    # Watch mode
make test-verbose  # Verbose output
make lint          # Biome lint
make lint-fix      # Autofix lint findings
make check         # lint + test
make install       # Install deps at ~/.pi/agent/extensions/sandbox
make deps          # Install monorepo deps
```

### Monorepo Makefile

The root-level `Makefile` at the monorepo root provides:
- `make binary` -- Build and install the `pi` binary locally

### Running Tests

```bash
# Path guard tests (fast, pure functions)
cd packages/coding-agent
npx vitest run examples/extensions/sandbox/path-guard.test.ts

# Sandbox extension integration tests
npx vitest run test/sandbox-extension.test.ts

# All tests
npx vitest run
```

### Testing Gotcha: Dual Module Resolution

The sandbox extension has its **own `node_modules/`** (it is NOT a workspace
member). This means `@anthropic-ai/sandbox-runtime` resolves to a different
copy than the one seen by tests in `test/`.

In `test/sandbox-extension.test.ts`, mocking must cover BOTH resolution paths:

```typescript
const { mockSandboxManager } = vi.hoisted(() => ({
    mockSandboxManager: { initialize: vi.fn(), reset: vi.fn(), ... },
}));

// Mock for test file's resolution
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: mockSandboxManager }));
// Mock for extension's own node_modules resolution
vi.mock("../examples/extensions/sandbox/node_modules/@anthropic-ai/sandbox-runtime",
    () => ({ SandboxManager: mockSandboxManager }));
```

Without the second `vi.mock`, the extension calls the real
`SandboxManager.initialize` from its own `node_modules`, and spy assertions
silently pass/fail incorrectly. The `vi.hoisted()` ensures both factories
share the same spy instance.

### macOS `com.apple.provenance` Gotcha

When `npm install` runs inside a sandboxed process, macOS stamps files with
`com.apple.provenance`. Subsequent sandboxed processes may get `EPERM` when
reading those files. Fix:

```bash
xattr -r -d com.apple.provenance node_modules/
```

Or reinstall outside of a sandbox.
