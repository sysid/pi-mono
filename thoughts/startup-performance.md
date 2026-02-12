# pi CLI Startup Performance Investigation

**Date:** 2026-02-12
**Symptom:** `pi` takes 10+ seconds to start on cold filesystem cache
**Status:** Root cause identified, fix requires upstream changes

## Summary

The `pi` CLI eagerly loads **1,288 Node.js modules** at import time — before `main()` even runs.
On cold filesystem cache this takes **10-12+ seconds**. On warm cache ~1-1.5s.

Three dependency trees account for **730 of 1,288 modules** (57%):

| Dependency | Modules | Warm cache | Import chain |
|---|---|---|---|
| `@aws-sdk` + `@smithy` (Bedrock) | ~1,025 (80%!) | ~370ms | `register-builtins.ts` → `amazon-bedrock.ts` |
| `cli-highlight` + `highlight.js` | ~255 | ~364ms | `main.ts` → `theme.ts` |
| `google-auth-library` + `gaxios` | ~192 | ~125ms | `register-builtins.ts` → `google-vertex.ts` |

## Root Cause

### 1. All providers loaded eagerly via `register-builtins.ts`

**File:** `packages/ai/src/providers/register-builtins.ts`

```typescript
// Lines 2-10: ALL provider implementations imported at top level
import { streamBedrock, streamSimpleBedrock } from "./amazon-bedrock.js";
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";
import { streamGoogleVertex, streamSimpleGoogleVertex } from "./google-vertex.js";
// ... 6 more providers ...

// Line 73: called as TOP-LEVEL SIDE EFFECT on import
registerBuiltInApiProviders();
```

This file is re-exported from `packages/ai/src/index.ts:14`:
```typescript
export * from "./providers/register-builtins.js";
```

Which means **any import from `@mariozechner/pi-ai`** triggers loading ALL provider implementations,
including their heavy transitive dependencies (AWS SDK, Google auth, etc.) — even when the user
only uses one provider (e.g., `github-copilot`).

The AWS SDK alone (`@aws-sdk/client-bedrock-runtime` + `@smithy/*`) accounts for **~1,025 modules**,
which is **80% of all module loads** at startup.

### 2. Syntax highlighting loaded eagerly via `theme.ts`

**File:** `packages/coding-agent/src/modes/interactive/theme/theme.ts:7`

```typescript
import { highlight, supportsLanguage } from "cli-highlight";
```

`cli-highlight` imports `highlight.js` which loads ~255 modules.
This is imported even for `--version` and `--help`.

### 3. Cold vs warm filesystem cache

Node.js resolves and reads each module file from disk. On macOS:

- **Warm cache** (files in memory): ~1-1.5s for 1,288 modules
- **Cold cache** (after memory pressure or fresh boot): 10-12+ seconds

The user's typical experience is cold cache because other applications consume memory between
`pi` invocations.

## Evidence

### Module count profiling

```
Baseline (all deps):                    1,288 modules, ~1,050ms warm
With @aws-sdk/@smithy mocked out:         263 modules,   ~530ms warm  (-80% modules)
With all 3 heavy deps mocked out:         558 modules,   ~820ms warm  (-57% modules)
```

### Cold cache measurement

```
$ time node -e "require('./dist/main.js')"
# First run (cold): 9.3s
# Second run (warm): 1.2s
```

### Actual pi command

```
$ time pi -p "say hi"
# 20.4s total (cold cache, includes import + main() + API call)

$ time pi --version
# 1.9s (warm cache — but all 1,288 modules still loaded for --version!)
```

### Per-provider API key check

```
modelRegistry.getAvailable(): 1ms  (fast, no network calls)
getApiKeyForProvider(github-copilot): 0ms  (cached OAuth token)
```

The model registry and auth are NOT the bottleneck. It's purely module I/O.

## Proposed Fix: Lazy Loading

### 1. Lazy provider registration (biggest impact)

Change `register-builtins.ts` to register providers with lazy loaders instead of eager imports:

```typescript
// BEFORE: all providers imported eagerly
import { streamBedrock } from "./amazon-bedrock.js";
registerApiProvider({ api: "bedrock-converse-stream", stream: streamBedrock });

// AFTER: providers loaded on first use
registerApiProvider({
  api: "bedrock-converse-stream",
  stream: async (...args) => {
    const { streamBedrock } = await import("./amazon-bedrock.js");
    return streamBedrock(...args);
  },
});
```

This would eliminate ~1,025 modules (AWS SDK) and ~192 modules (Google auth) from startup
for users who don't use those providers.

### 2. Lazy syntax highlighting

Change `theme.ts` to lazy-load `cli-highlight`:

```typescript
// BEFORE
import { highlight, supportsLanguage } from "cli-highlight";

// AFTER
let _highlight: typeof import("cli-highlight") | undefined;
async function getHighlighter() {
  if (!_highlight) _highlight = await import("cli-highlight");
  return _highlight;
}
```

This saves ~255 modules and is especially impactful for non-interactive invocations
(`--version`, `--help`, print mode).

### 3. Alternative: bundling

The existing `bun build --compile` target (`npm run build:binary`) creates a single binary
that eliminates per-module filesystem I/O. This is already available but may not be the
default install path.

## Expected Improvement

| Scenario | Before | After (lazy) |
|---|---|---|
| Modules loaded (github-copilot user) | 1,288 | ~300-400 |
| Warm cache startup | ~1.5s | ~0.5-0.7s |
| Cold cache startup | 10-12s | ~3-4s |
| `--version` / `--help` | ~1.5s | ~0.3s |

## Files Involved

- `packages/ai/src/providers/register-builtins.ts` — eager provider registration (primary target)
- `packages/ai/src/index.ts` — barrel re-export that triggers loading
- `packages/ai/src/providers/amazon-bedrock.ts` — imports `@aws-sdk/client-bedrock-runtime`
- `packages/ai/src/providers/google-vertex.ts` — imports `google-auth-library`
- `packages/coding-agent/src/modes/interactive/theme/theme.ts` — imports `cli-highlight`
- `packages/coding-agent/src/main.ts` — top-level imports pull everything in
- `packages/coding-agent/src/core/timings.ts` — existing `PI_TIMING=1` instrumentation

## Reproduction

```bash
# Cold cache timing (flush disk cache first or wait for memory pressure)
time pi --version

# Module count
node -e "
const {Module} = require('module');
let c=0; const o=Module._load;
Module._load = function(){c++;return o.apply(this,arguments)};
require('/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/main.js');
console.log('Modules:', c);
"

# Per-package module count
node -e "
const {Module} = require('module');
const o=Module._load; const m={};
Module._load = function(r){
  const k=r.split('/').slice(0,r.startsWith('@')?2:1).join('/');
  m[k]=(m[k]||0)+1; return o.apply(this,arguments);
};
require('/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/main.js');
Object.entries(m).sort((a,b)=>b[1]-a[1]).slice(0,20).forEach(([k,v])=>console.log(v,k));
"

# Profile with built-in timings
PI_TIMING=1 pi
```
