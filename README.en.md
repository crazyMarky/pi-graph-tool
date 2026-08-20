# pi-graph-tool

**English** | [简体中文](./README.md)

**Graph engineering extension for [Pi](https://pi.dev): lets your agent autonomously organize subtasks into a DAG — same-wave parallelism, multi-wave topological scheduling, and node-to-node data routing.**

```
You:    "Research React, Vue, and Svelte, then compare them for me"

Pi:     graph_run submits a 4-node DAG
              React ┐
              Vue   ├── (parallel Wave 1) ──→ Compare (Wave 2, receives all three results)
              Svelte┘
```

## What's new in v0.2: full DAG support

v0.1 could only parallelize *independent* tasks (a single layer, zero edges). v0.2 adds three core capabilities:

| Capability | Usage | Notes |
|---|---|---|
| **Dependency declaration** | `dependsOn: ["react", "vue"]` | Declares edges; the extension validates and detects cycles |
| **Multi-Wave scheduling** | automatic | Kahn topological layering: parallel within a wave, barrier between waves |
| **Node-to-node data routing** | write `{{react}}` in a prompt | Replaced with the upstream node's output before execution; a forgotten `dependsOn` is inferred automatically |

Plus a DAG-specific **failure semantic**: if a node still violates its contract after retry, all of its descendants are transitively **skipped** — unrelated branches are unaffected.

## Install

```bash
# from this repo
pi install git:github.com/crazyMarky/pi-graph-tool

# or from npm (after publish)
pi install npm:pi-graph-tool
```

Manual:

```bash
mkdir -p .pi/extensions
cp -r pi-graph-tool .pi/extensions/    # project-level (recommended)
# or copy to ~/.pi/agent/extensions/ for global effect
```

## Verify installation

1. **Existence**: start `pi`, ask *"What tools do you have? What does graph_run do?"*
2. **Behavioral**: make a multi-task request and look for the `[graph_run] Graph planned: 4 nodes / 2 waves / 3 edges` log line
3. **Outcome**: time serial vs DAG execution on the same batch of tasks

## Parameter protocol

`graph_run` takes a `subtasks` array; each element is a DAG node:

| Field | Required | Description |
|---|---|---|
| `id` | no | Unique short node id (e.g. `"react"`); defaults to `n1`, `n2`, … Referenced by `dependsOn` and `{{id}}` |
| `title` | yes | Short task name, used in result display |
| `prompt` | yes | Complete standalone instruction for the sub-agent. May contain `{{id}}` placeholders replaced with upstream output at runtime |
| `dependsOn` | no | Array of upstream node ids; this node runs only after all of them succeed |

Example — three research branches plus one comparison:

```json
{
  "subtasks": [
    { "id": "react",  "title": "Research React",  "prompt": "Research the current React ecosystem: core features, strengths, risks. Output a ~300-word summary." },
    { "id": "vue",    "title": "Research Vue",    "prompt": "Research the current Vue ecosystem: core features, strengths, risks. Output a ~300-word summary." },
    { "id": "svelte", "title": "Research Svelte", "prompt": "Research the current Svelte ecosystem: core features, strengths, risks. Output a ~300-word summary." },
    {
      "id": "compare",
      "title": "Compare",
      "prompt": "Below are research results for three frontend frameworks. Compare them and give an adoption recommendation:\nReact: {{react}}\nVue: {{vue}}\nSvelte: {{svelte}}",
      "dependsOn": ["react", "vue", "svelte"]
    }
  ]
}
```

Execution shape: Wave 1 = React/Vue/Svelte in parallel → all fulfill their contracts → Wave 2 = the comparison node starts with all three results injected.

Omitting all `dependsOn` degrades to v0.1's single-wave parallelism — fully backward compatible.

## How it works

```
graph_run({ subtasks })
   │
   ▼
① Graph planning
   ├─ Normalize & dedupe ids; validate dependsOn refs (unknown id / self-dep → error)
   ├─ Implicit edges: prompt references {{id}} without a declared dependency → auto-added
   └─ Kahn topological layering into waves (cycle found → error, LLM retries the call)
   │
   ▼
② Wave loop (w = 1..N)
   ├─ Failure cascade: nodes whose upstream isn't ok → skipped (transitively; no API quota wasted)
   ├─ Fan-out: one in-process Pi sub-agent per node this wave (isolated session context);
   │          {{id}} placeholders already replaced with upstream output (data routing, capped)
   ├─ Barrier: Promise.allSettled waits for the whole wave (single failure never pierces it)
   └─ Contract check: violating nodes (empty output / crash / timeout) retried once in isolation
   │
   ▼
③ Aggregate & return
   └─ Grouped by wave, each node truncated into the main context (lightweight reference, default 6000 chars, configurable)
```

### Graph engineering concepts mapped to code

| Concept | Implementation |
|---|---|
| DAG declaration (nodes + edges) | `subtasks[].dependsOn` explicit edges + `{{id}}` placeholder implicit edges |
| Topological layering (Wave scheduling) | Kahn's algorithm, repeatedly extracting ready nodes |
| Fan-out + Barrier | `Promise.allSettled` within each wave |
| Node-to-node data routing | `{{id}}` → upstream output injection (full fidelity by default, cap only guards pathological outputs) |
| Failure cascade | Upstream not ok → all descendants marked skipped |
| Node contract | >20 chars of output; violation retries that node only, never the whole wave |
| Lightweight reference | Per-node return truncated to 6000 chars by default (`PI_GRAPH_OUTPUT_CAP`, 0 = no cap) |
| Context isolation | Independent sub-agent session per node (in-memory, never written to disk, never pollutes the `pi --resume` session list); tokens never enter main context |
| Recursion guard | Sub-agents run with `noTools: "all"` — structurally cannot call graph_run |

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `PI_GRAPH_NODE_TIMEOUT_MS` | `300000` | Per-node timeout in ms; a timeout counts as a contract violation |
| `PI_GRAPH_ROUTE_CAP` | `100000` | Truncation length per upstream output injected downstream. Full fidelity by default — the cap only guards pathological runaway outputs; `0` = no cap |
| `PI_GRAPH_OUTPUT_CAP` | `6000` | Truncation length per node result returned to the main context; `0` = no cap |
| `PI_GRAPH_MODEL_JSON` | — | Full Model object JSON overriding the sub-agent model |

> On truncation: **routing (upstream → downstream) is full-fidelity by default** — the downstream sub-agent's context is isolated and fresh, and truncating its inputs directly corrupts pipeline semantics. **Return to main context** stays a lightweight reference (protecting the main conversation window), relaxed to 6000 chars by default; lower it or set 0 if many nodes strain the main context. The better way to control information volume is constraining output length in node prompts (e.g. "output a ~300-word summary").

Model resolution priority: `PI_GRAPH_MODEL_JSON` → project `.pi-agent/` → global `~/.pi/agent` (follows whatever model and keys you normally use; zero hardcoding).

## Measured gains (v0.1 parallel benchmark, Zhipu GLM-4.5)

| Scale | Serial | Parallel | Speedup |
|------|:---:|:---:|:---:|
| 3 subtasks | 57-60s | 40s | **1.44x** |
| 6 subtasks | 117s | 53s | **2.20x** |

Multi-wave pipelines (like the 3+1 shape above) gain additionally: the comparison node no longer waits in a serial queue — it starts with full context the moment the research wave settles.

## Limitations (stated honestly)

- Sub-agents are pure LLM (no tools) — suited to research / generation / comparison; nodes needing tools must opt out of `noTools`
- Barriers between waves: Wave 2 waits for all of Wave 1 — the price of guaranteed dependency readiness, and standard DAG scheduling behavior
- The LLM chooses the wave structure autonomously when it detects dependencies (a feature); force it with "use graph_run"
- Recommend ≤12 subtasks per call (rate-limit guard; more is rejected)
- Verified on GLM-4.5; Claude/OpenAI theoretically compatible (zero hardcoding) but untested

## Benchmark (reproduce it yourself)

The `bench/` directory ships an A/B script: serial (single session, one task at a time — the no-extension equivalent) vs graph-style (replicating this extension's wave fan-out + data routing):

```bash
cd bench
npm install
node bench.mjs
```

It prints total times, the speedup, and one key diagnostic — **the slowest Wave-1 node**: if it approaches "serial per-task time × task count", your account/model is being queued server-side and parallel gains approach zero; if it stays near the per-task time, the concurrency is real. Reference (GLM-4.5, small tasks): 1.63x speedup, slowest Wave-1 node 4.2s vs 3.4s serial per-task.

## License

[MIT](./LICENSE)
