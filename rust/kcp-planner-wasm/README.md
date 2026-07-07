# kcp-planner-wasm

WebAssembly bindings for the deterministic KCP planner — the same Rust core that
builds the [`kcp-planner`](../kcp-planner) CLI, compiled for a browser tab.

"Protocol, not library" made literal: one core, byte-identical output whether it
targets a ~0.8 MB static binary or a ~445 KB WASM module.

## API

The boundary is deliberately thin — strings in, JSON strings out:

```js
import init, { plan, trace, diff_plans, validate } from "./pkg/kcp_planner_wasm.js";
await init();

plan(manifestYaml, task, optionsJson);   // → plan artifact JSON  (== `kcp-planner plan --json`)
trace(manifestYaml, task, optionsJson);   // → decision trace JSON (== `plan --trace --json`)
diff_plans(planAJson, planBJson);         // → plan diff JSON      (== `diff --json`)
validate(manifestYaml);                    // → lint report JSON    (== `validate --json`)
```

`optionsJson` is the same camelCase shape the conformance vectors use
(`{ "asOf": "…", "capabilities": { "role": "…", … }, "maxUnits": …, "contextBudget": … }`);
pass `""` for defaults. Errors never trap — a bad manifest or malformed options
returns `{"error":"…"}`.

Signature verification runs offline (inline material); a browser has no
filesystem, so a manifest whose signature lives in a local `.sig` file reads as
`unverifiable` (never fail-open). Unsigned manifests match the CLI exactly.

## Build

```bash
npm run build:wasm     # cargo → wasm-bindgen → wasm-opt, into docs/pkg/ (gitignored)
npm run wasm:parity    # verify byte-parity vs the native CLI
```

Toolchain: `rustup target add wasm32-unknown-unknown`,
`cargo install wasm-bindgen-cli` (matching the pinned `wasm-bindgen` version),
and `npm i -g binaryen` for `wasm-opt`.
