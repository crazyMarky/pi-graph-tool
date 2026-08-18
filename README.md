# pi-graph-tool

**Graph engineering for [Pi](https://pi.dev) — let your agent parallelize independent subtasks autonomously.**

为 [Pi Coding Agent](https://pi.dev) 装上图工程并行能力：当对话中包含多个**互不依赖**的子任务时，Pi 会自动调用 `graph_run` 工具，把子任务分给多个并行子代理同时执行，全部完成后汇总结果。

```
你说：  "帮我调研 A、B、C 三件事，然后汇总给我"
Pi 做：  识别 A/B/C 互不依赖 → 3 个子代理并行执行 → 汇总返回
```

**实测收益**（智谱 GLM-4.5，真实可复现）：

| 规模 | 串行 | 并行 | 加速比 |
|------|:---:|:---:|:---:|
| 3 个子任务 | 57-60s | 40s | **1.44x** |
| 6 个子任务 | 117s | 53s | **2.20x** |

---

## Install / 安装

```bash
# from this repo / 从本仓库安装
pi install git:github.com/crazyMarky/pi-graph-tool

# or from npm (after publish) / 或发布 npm 后
pi install npm:pi-graph-tool
```

Manual / 手动安装：

```bash
mkdir -p .pi/extensions
cp -r pi-graph-tool .pi/extensions/    # 项目级（推荐）
# 或拷到 ~/.pi/agent/extensions/ 全局生效
```

## Verify / 验证安装

Three levels / 三级验证：

1. **存在性**：启动 `pi`，问它 *"你有哪些工具？graph_run 是干什么的？"*
2. **行为性**：提出多任务请求，终端出现 `[graph_run] Wave 启动：N 个子代理并行` 日志
3. **效果性**：同一批任务，串行 vs 并行对照计时（3 任务约 1.4x）

## How it works / 工作原理

- Registers a `graph_run` tool; the **main LLM decides** when subtasks are independent and calls it
- Sub-agents run in-process via Pi SDK, each with an isolated session context
- `Promise.allSettled` → single-node failure never kills the wave
- Contract check (non-empty output) → violating node retried once, in isolation
- Results truncated to 1200 chars per node (lightweight reference, protects main context)

Concepts mapped to code / 图工程概念与代码对照：

| Concept 概念 | Implementation 实现 |
|---|---|
| Fan-out + Barrier | `Promise.allSettled` |
| Node contract 节点契约 | non-empty check + single-node retry |
| Lightweight reference 轻量引用 | 1200-char truncation |
| Context isolation 上下文隔离 | per-node independent session |

## Limitations / 限制（如实说明）

- Sub-agents are pure-LLM (no tools) — suited for research/generation/comparison tasks
- The LLM may choose **not** to parallelize when it detects dependencies (a feature); force with "用 graph_run"
- Recommend ≤ 8 subtasks per call (API rate limits)
- Verified on GLM-4.5; Claude/OpenAI theoretically compatible (zero hardcoding) but not yet tested — you can be the first

## License

[MIT](./LICENSE)
