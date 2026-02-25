# Sandbox Security Review

## Scope

Goal: ensure sandbox configuration provides comprehensive read/write/network protections for **bash commands**, **built-in tools**, and (as far as possible) **extension tools**.

This review compares:
- **Main branch** sandbox extension
- **Current branch** sandbox + access-guard extensions

## Findings

### Main branch (`examples/extensions/sandbox`)

- Enforces **OS-level sandboxing** for `bash` and user `!` bash using `@anthropic-ai/sandbox-runtime`.
- **No tool-level protection** for built-in tools (`read`, `write`, `edit`, `grep`, `find`, `ls`).
- `/sandbox` command only reports config; it does not enforce any path rules for tools.

**Conclusion:** In main, sandbox configuration does **not** protect built-in tools at all.

### Current branch (`sandbox` + `access-guard`)

#### Sandbox extension
- Adds a **tool_call path guard** for built-in tools:
  - `read`, `grep`, `find`, `ls` checked against `denyRead`
  - `write`, `edit` checked against `denyWrite` + `allowWrite`
- Uses `path-guard.ts` with stronger semantics:
  - Expands `~` and relative paths
  - Resolves and checks directory containment (with `realpathSync` when possible)
  - `allowWrite` is default-deny; `denyWrite` patterns override
- **Fail-closed for bash**: if sandbox init fails, bash is blocked
- Tool guard runs whenever sandbox config is enabled, independent of OS sandbox init

#### Access-guard extension
- Standalone tool guard example using **substring matching** (`includes()`)
- Reads only `filesystem.denyRead` / `filesystem.denyWrite`
- Does **not** enforce `allowWrite` default-deny
- Designed to be lightweight and usable without OS sandbox

**Conclusion:** Current branch adds real tool-level protection **in the sandbox extension**, independent of OS sandbox initialization.

## Coverage vs Objective

| Surface | Main branch | Current branch | Notes |
|---|---|---|---|
| Bash filesystem access | Yes (OS sandbox) | Yes (OS sandbox) | Config-driven |
| Bash network access | Yes (OS sandbox) | Yes (OS sandbox) | Config-driven |
| Built-in tools (read/write/edit/grep/find/ls) | No | Yes (path guard) | Active when sandbox config enabled |
| Custom tools / extensions | No | No | Can bypass unless they opt into checks |

## Options Assessment

### 1) Keep protections **inside sandbox extension** (single extension)
**Pros**
- Single config file (`sandbox.json`) governs both OS and tool-level restrictions
- Stronger semantics (`path-guard.ts`) than substring matching
- One extension to install and reason about

**Cons**
- Tool guard disabled only when `--no-sandbox` or `enabled: false`
- Custom tools still unguarded

**Assessment:** Cohesive with SRP — both OS and tool-level enforcement are the same responsibility.

### 2) Split into **separate access-guard extension**
**Pros**
- Can be enabled independently of OS sandbox
- Simpler logic

**Cons**
- Weaker matching, no `allowWrite` default-deny
- Two extensions required for full coverage
- Duplicated config handling

**Assessment:** OK as a teaching example; not sufficient for comprehensive security.

### 3) Hybrid: keep sandbox extension, **decouple tool guard from OS sandbox init**
**Pros**
- Built-in tools still protected even if OS sandbox unavailable
- Single extension

**Cons**
- Needs clear policy for `--no-sandbox`

**Assessment:** Best alignment with “comprehensive protections.”

### 4) Override built-in tools instead of tool_call guard
**Pros**
- Strong per-tool enforcement

**Cons**
- More complex, risk of tool result shape drift
- Still doesn’t protect custom tools

**Assessment:** Not worth it unless tool_call is insufficient.

## Recommendation (Security Architecture)

Use **one sandbox extension** that provides both:
- OS-level sandboxing for bash and user bash
- Tool-level guard for built-in tools based on `sandbox.json`

Keep `access-guard` as a standalone example only, not the primary security path.

## Decisions

- Tool guard remains active when OS sandbox fails to initialize.
- `--no-sandbox` disables both OS sandboxing and the tool guard.
