/**
 * pi-graph-tool —— 给 Pi 装上图工程的 Wave 调度能力（R2 改造核心）
 * ====================================================================
 * v0.1.1（经代码审计修复）：
 *   ① 重试路径补传 modelOverride（消除参数不一致）
 *   ② TUI 安全日志：交互模式走 onUpdate 官方通道，仅非 TTY 时 console.log
 *   ③ 单节点超时兜底（默认 300s，PI_GRAPH_NODE_TIMEOUT_MS 可调）
 *   ④ 加固：违约节点并行重试；入参护栏（空/超 12 个子任务拒绝）
 * 安装位置：<项目>/.pi/extensions/pi-graph-tool/index.js（项目级，自动加载）
 *
 * 它做什么：
 *   注册一个 graph_run 工具。主 agent（LLM）判断出若干子任务【互不依赖】时，
 *   主动调用它 → 扩展在同一进程内并行拉起 N 个 Pi 子代理（Wave 调度）→
 *   全部落定后做契约校验（空输出/崩溃的节点单独重试一次）→
 *   聚合各节点摘要返回主上下文（轻量引用，防上下文膨胀）。
 *
 * 与 R1（graph.mjs）的本质区别：
 *   R1：我的外部脚本编排 Pi —— 图在 Pi 外面
 *   R2：Pi 自己长出图能力 —— LLM 在对话中自主决定何时并行（图在 Pi 里面）
 *
 * 图工程概念落地对照：
 *   - Fan-out 并行      → Promise.allSettled（不是 all：单点崩溃不击穿屏障）
 *   - Barrier           → await 全部落定后才聚合
 *   - 节点契约          → 非空文本；违规只重跑该节点，不重跑整层
 *   - 轻量引用          → 每节点输出截断后回传，保护主上下文窗口
 *   - 上下文隔离        → 子代理独立会话窗口，token 不进主上下文
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- 模型解析：环境自适应，零硬编码 ----
// 优先级：
//   1. 环境变量 PI_GRAPH_MODEL_JSON（完整 Model 对象 JSON，高级用法）
//   2. 项目本地 .pi-agent/（有 models.json + auth.json 就用它，如我们的 GLM 环境）
//   3. 都没有 → 用使用者自己的全局 Pi 配置（~/.pi/agent，即他们平时用的模型）
// 这样任何人装上扩展即可用，子代理自动跟随他自己的模型与密钥。
function resolveModel() {
	if (process.env.PI_GRAPH_MODEL_JSON) {
		try { return JSON.parse(process.env.PI_GRAPH_MODEL_JSON); } catch {}
	}
	return undefined; // undefined = 让 Pi 按当前环境默认解析
}

// 子代理的认证目录：优先用项目里的 .pi-agent（如果存在），否则回退全局 ~/.pi/agent
function resolveAgentDir() {
	const local = path.join(process.cwd(), ".pi-agent");
	return fs.existsSync(local) ? local : undefined;
}

// 取最后一条"有文本"的 assistant 消息（跳过纯工具调用的空消息）
function lastText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const c = m.content;
		const text = typeof c === "string" ? c : Array.isArray(c)
			? c.filter((p) => p.type === "text").map((p) => p.text).join("")
			: "";
		if (text.trim()) return text.trim();
	}
	return "";
}

// ---- 单节点超时：默认 300s，可用 PI_GRAPH_NODE_TIMEOUT_MS 调整 ----
// v0.1.1 修复③：防止挂死的 LLM 调用把整个 Wave 拖死。
// 超时的节点表现为"违约"（输出为空），自动走既有重试机制，无需特殊分支。
const NODE_TIMEOUT_MS = Number(process.env.PI_GRAPH_NODE_TIMEOUT_MS) || 300_000;

// ---- 单个图节点 = 一个进程内 Pi 子代理 ----
async function runSubNode(title, prompt, agentDir, signal, modelOverride) {
	const t0 = Date.now();
	const { session } = await createAgentSession({
		agentDir,
		cwd: process.cwd(),
		model: modelOverride ?? resolveModel(),
		noTools: "all", // 子节点做纯调研，禁工具保安全提速；需要工具的节点可放开
		// 注意：noTools:"all" 同时禁用了子代理的 graph_run —— 结构上防止无限递归
	});
	const agent = session.agent;

	// 中止传播：主工具调用被 abort 时，杀掉子代理
	const onAbort = () => { try { agent.abort(); } catch {} };
	signal?.addEventListener("abort", onAbort, { once: true });

	// v0.1.1 修复③：单节点超时兜底
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; try { agent.abort(); } catch {} }, NODE_TIMEOUT_MS);

	try {
		await agent.prompt(prompt);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
	return { title, text: lastText(session.messages), seconds: (Date.now() - t0) / 1000, timedOut };
}

export default function (pi) {
	pi.registerTool({
		name: "graph_run",
		label: "Graph Run（并行图调度）",
		description:
			"并行执行多个互不依赖的子任务（图工程 Wave 调度）。" +
			"每个子任务在一个独立的 Pi 子代理中运行，全部完成后聚合各节点结果。" +
			"适用于：多角度调研、批量生成、独立验证等可并行场景。" +
			"注意：只把【互不依赖】的子任务放进来；有依赖关系的任务应分多次调用。",
		promptSnippet: "graph_run: 并行执行互不依赖的子任务（Wave 调度）",
		promptGuidelines: [
			"当待办的子任务互不依赖时，用一次 graph_run 并行完成，而不是逐个串行处理",
		],
		parameters: Type.Object({
			subtasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "子任务短名（如 '概念调研'）" }),
					prompt: Type.String({ description: "给该子代理的完整独立指令，需自包含背景" }),
				}),
				{ description: "互不依赖的子任务列表（建议 2-8 个）" },
			),
		}),

		async execute(toolCallId, params, signal, onUpdate) {
			const agentDir = resolveAgentDir();
			const modelOverride = resolveModel();
			const t0 = Date.now();

			// v0.1.1 修复②：TUI 安全日志。
			// 交互模式（TTY）下 console.log 会破坏 Pi 的终端 UI——改走官方流式通道 onUpdate；
			// 仅在非 TTY（SDK / print / CI）时保留 console.log，方便脚本调试。
			const log = (m) => {
				try { onUpdate?.({ content: [], details: { status: m } }); } catch {}
				if (!process.stdout.isTTY) console.log(`  [graph_run] ${m}`);
			};

			// v0.1.1 加固：入参护栏（防空/防过猛 fan-out 触发限流）
			const MAX_SUBTASKS = 12;
			if (!Array.isArray(params.subtasks) || params.subtasks.length === 0) {
				return { content: [{ type: "text", text: "graph_run 错误：subtasks 不能为空。" }], details: { error: true } };
			}
			if (params.subtasks.length > MAX_SUBTASKS) {
				return {
					content: [{ type: "text", text: `graph_run 错误：一次最多 ${MAX_SUBTASKS} 个子任务（当前 ${params.subtasks.length} 个），请拆成多次调用。` }],
					details: { error: true },
				};
			}

			log(`Wave 启动：${params.subtasks.length} 个子代理并行`);

			// ===== Fan-out + Barrier：allSettled（对比 Promise.all 的单点击穿问题）=====
			const settled = await Promise.allSettled(
				params.subtasks.map((st) => runSubNode(st.title, st.prompt, agentDir, signal, modelOverride)),
			);

			// ===== 契约校验：输出非空才算履约；违规节点单独重试（不重跑整层）=====
			const results = [];
			const violations = [];
				settled.forEach((r, i) => {
					if (r.status === "fulfilled" && r.value.text.length > 20) {
						results.push(r.value);
					} else {
						const reason = r.status === "rejected"
							? String(r.reason?.message ?? r.reason).slice(0, 100)
							: (r.value?.timedOut
								? `节点超时（>${Math.round(NODE_TIMEOUT_MS / 1000)}s）`
								: "输出为空或过短（契约违规）");
						log(`⚠️ [${params.subtasks[i].title}] ${reason} → 仅重试该节点`);
						violations.push({ i, reason });
					}
				});

				// v0.1.1 修复①：重试补传 modelOverride（此前靠 runSubNode 内部兜底侥幸生效）
				// v0.1.1 加固：多个违约节点并行重试（原为串行 for 循环）
				await Promise.allSettled(violations.map(async (v) => {
					const st = params.subtasks[v.i];
					try {
						const retry = await runSubNode(
							st.title,
							st.prompt + "\n\n注意：请直接以文本形式输出你的完整结果。",
							agentDir,
							signal,
							modelOverride,
						);
						if (retry.text.length > 20) {
							retry.retried = true;
							results.push(retry);
							log(`✅ [${st.title}] 重试成功`);
						} else {
							log(`❌ [${st.title}] 重试后仍违约，放弃该节点（不影响其余结果）`);
						}
					} catch (e) {
						log(`❌ [${st.title}] 重试异常：${String(e?.message ?? e).slice(0, 80)}（不影响其余结果）`);
					}
				}));

			// ===== 聚合返回：轻量引用（每节点截断，防主上下文膨胀）=====
			const CAP = 1200;
			const sections = results.map((r) => {
				const body = r.text.length > CAP
					? r.text.slice(0, CAP) + `\n…（已截断，原 ${r.text.length} 字）`
					: r.text;
				return `### ${r.title}${r.retried ? "（重试后成功）" : ""}\n${body}`;
			});
			const waveSeconds = (Date.now() - t0) / 1000;

			const summary =
				`graph_run 完成：${results.length}/${params.subtasks.length} 个节点成功` +
				`（并行耗时 ${waveSeconds.toFixed(1)}s；失败重试 ${violations.length} 个）\n\n` +
				sections.join("\n\n");

			log(`Wave 完成：${results.length}/${params.subtasks.length} 成功，${waveSeconds.toFixed(1)}s`);

			return {
				content: [{ type: "text", text: summary }],
				details: {
					nodes: results.map((r) => ({
						title: r.title, seconds: Number(r.seconds.toFixed(1)),
						chars: r.text.length, retried: !!r.retried,
					})),
					waveSeconds: Number(waveSeconds.toFixed(1)),
					violations,
				},
			};
		},
	});
}
