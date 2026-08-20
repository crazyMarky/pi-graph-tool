/**
 * pi-graph-tool —— 给 Pi 装上真正的 DAG 图工程能力（v0.2）
 * ====================================================================
 * v0.2 在 v0.1 单波并行的基础上补齐三块图工程核心能力：
 *   ① 依赖声明   —— 子任务可声明 dependsOn（边），扩展负责校验与环检测
 *   ② 多 Wave    —— Kahn 拓扑分层，同层并行、层间屏障，自动按波次推进
 *   ③ 数据路由   —— prompt 中的 {{id}} 占位符在运行前替换为上游节点输出；
 *                   引用了某节点却忘声明依赖时，自动推断隐式边
 * 另有 DAG 特有的失败语义：节点重试后仍违约 → 其所有后代级联跳过（skip），
 * 无关分支不受影响。
 *
 * v0.1 的既有保障全部保留：allSettled 屏障、节点契约 + 隔离重试、
 * 单节点超时兜底、abort 传播、入参护栏、上下文隔离、轻量引用。
 *
 * v0.2.1 修正截断策略（吸取实测教训：2000 字路由截断丢失 3/4 上游内容，汇总失真）：
 *   - 数据路由默认全保真（仅留 100k 字符病态护栏，ROUTE_CAP=0 可完全关闭）
 *   - 回传主上下文放宽到 6000 字符，且可用 PI_GRAPH_OUTPUT_CAP 调整（0 = 不截断）
 * v0.2.2 默认体验修复（面向"装上即用"的大多数用户）：
 *   - 子代理会话改为纯内存（SessionManager.inMemory）——不再把一次性会话写进
 *     用户的会话列表，`pi --resume` 选择器不被 graph_run 的子代理垃圾淹没
 *   - 中止语义：用户 abort 后，剩余波次不再启动、违约节点不再重试、
 *     未执行节点统一标记 skipped 后正常聚合返回
 *   - 空 prompt 在规划期快速拒绝（此前要浪费 2 次 LLM 调用才失败）
 * v0.2.3 触发条件修正（实测教训：知识型问答建图 = 直答 15s vs 图调度 150s，负优化 10 倍）：
 *   - description / promptGuidelines 明确"何时别用"——能直接回答的综合问答直接答，
 *     只有每个子任务都需大量独立工作时才建图
 *
 * 安装位置：<项目>/.pi/extensions/pi-graph-tool/index.js（项目级，自动加载）
 *
 * 图工程概念落地对照：
 *   - DAG 声明          → subtasks[].dependsOn（显式边）+ {{id}} 占位符（隐式边）
 *   - 拓扑分层          → Kahn 算法：反复取出"依赖全部就绪"的节点构成一个 Wave
 *   - Fan-out + Barrier → Wave 内 Promise.allSettled（单点崩溃不击穿屏障）
 *   - 节点数据路由      → {{id}} 替换为上游输出（默认全保真，仅病态输出截断）
 *   - 失败级联          → 上游非 ok 的节点标记 skipped，不执行、不占 API 配额
 *   - 节点契约          → 非空文本（>20 字符）；违约只重跑该节点，不重跑整波
 *   - 轻量引用          → 每节点回传默认截断至 6000 字符（可调），保护主上下文窗口
 *   - 上下文隔离        → 每节点独立 Pi 子代理会话，token 不进主上下文
 */

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// ---- 模型解析：环境自适应，零硬编码 ----
// 优先级：
//   1. 环境变量 PI_GRAPH_MODEL_JSON（完整 Model 对象 JSON，高级用法）
//   2. 项目本地 .pi-agent/（有就让它接管认证）
//   3. 都没有 → 用使用者自己的全局 Pi 配置（~/.pi/agent，即他们平时用的模型）
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

// ---- 可调参数（环境变量）----
function intEnv(name, fallback) {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v >= 0 ? v : fallback;
}
const NODE_TIMEOUT_MS = intEnv("PI_GRAPH_NODE_TIMEOUT_MS", 300_000); // 单节点超时
// 数据路由默认全保真：下游子代理的上下文是隔离且全新的，其职责就是消费上游输出，
// 截断会破坏流水线语义。ROUTE_CAP 仅作为病态输出的护栏（如上游跑飞输出几十万字）。
const ROUTE_CAP = intEnv("PI_GRAPH_ROUTE_CAP", 100_000); // 注入时单个上游输出的截断长度；0 = 不截断
// 回传主上下文保持轻量引用，但默认放宽到 6000 字符（主 agent 需要足够信息回应用户）；
// 节点多、主上下文紧张时可调小，0 = 不截断。
const OUTPUT_CAP = intEnv("PI_GRAPH_OUTPUT_CAP", 6_000);
const MAX_SUBTASKS = 12; // 入参护栏：防过猛 fan-out 触发限流
const MIN_OUTPUT_CHARS = 20; // 节点契约：输出至少 20 字符才算履约

// {{id}} 占位符：匹配 {{ research }} / {{n1}} 等；未命中任何节点 id 时原样保留
const PLACEHOLDER_RE = /\{\{\s*([^{}\s]+)\s*\}\}/g;

// ---- 图规划：id 归一、边校验、隐式边推断、Kahn 拓扑分层 ----
// 返回 { nodes, byId, waves }；发现结构性问题直接 throw（由 execute 捕获后回报 LLM）
function planGraph(raw, log) {
	const nodes = raw.map((st, i) => ({
		id: String(st.id ?? `n${i + 1}`).trim(),
		title: String(st.title ?? `任务${i + 1}`),
		prompt: String(st.prompt ?? ""),
		dependsOn: [...new Set((st.dependsOn ?? []).map((d) => String(d).trim()).filter(Boolean))],
		status: "pending", // pending → ok | failed | skipped
		result: null,
		wave: -1,
	}));
	const byId = new Map(nodes.map((n) => [n.id, n]));

	const dup = nodes.find((n, i) => nodes.findIndex((m) => m.id === n.id) !== i);
	if (dup) throw new Error(`存在重复的节点 id "${dup.id}"，每个节点的 id 必须唯一。`);

	const empty = nodes.find((n) => !n.prompt.trim());
	if (empty) throw new Error(`节点 "${empty.id}"（${empty.title}）的 prompt 为空，每个子任务都需要完整独立的指令。`);

	for (const n of nodes) {
		for (const d of n.dependsOn) {
			if (!byId.has(d)) {
				throw new Error(`节点 "${n.id}" 的 dependsOn 引用了不存在的 id "${d}"。合法 id：${[...byId.keys()].join(", ")}。`);
			}
			if (d === n.id) throw new Error(`节点 "${n.id}" 不能依赖它自己。`);
		}
	}

	// 隐式边推断：prompt 里引用了 {{id}} 却没声明依赖 → 自动补边（LLM 常忘写 dependsOn）
	for (const n of nodes) {
		for (const m of n.prompt.matchAll(PLACEHOLDER_RE)) {
			const ref = m[1];
			if (byId.has(ref) && ref !== n.id && !n.dependsOn.includes(ref)) {
				n.dependsOn.push(ref);
				log(`边推断："${n.id}" 的 prompt 引用了 {{${ref}}} → 自动补充依赖边`);
			}
		}
	}

	// Kahn 分层：反复取出"依赖全部完成"的节点 → 同属一个 Wave
	// 取不出任何节点 = 剩下的节点互相成环
	const waves = [];
	const done = new Set();
	const remaining = new Set(nodes);
	while (remaining.size > 0) {
		const wave = [...remaining].filter((n) => n.dependsOn.every((d) => done.has(d)));
		if (wave.length === 0) {
			throw new Error(`检测到依赖环，涉及节点：${[...remaining].map((n) => n.id).join("、")}。请调整 dependsOn 打破循环。`);
		}
		for (const n of wave) {
			n.wave = waves.length;
			remaining.delete(n);
			done.add(n.id);
		}
		waves.push(wave);
	}
	return { nodes, byId, waves };
}

// ---- 数据路由：把 {{id}} 替换为上游节点输出（带定界符与截断，防子代理上下文膨胀）----
// 未解析的占位符（引用不存在/未成功的节点）原样保留
function renderPrompt(node, byId) {
	return node.prompt.replace(PLACEHOLDER_RE, (whole, ref) => {
		const up = byId.get(ref);
		if (!up || up.status !== "ok") return whole;
		const body = ROUTE_CAP > 0 && up.result.text.length > ROUTE_CAP
			? up.result.text.slice(0, ROUTE_CAP) + `\n…（已截断，原 ${up.result.text.length} 字）`
			: up.result.text;
		return `\n<<< 上游节点 "${up.title}"（${ref}）的输出 >>>\n${body}\n<<< 结束 >>>\n`;
	});
}

// ---- 单个图节点 = 一个进程内 Pi 子代理 ----
async function runSubNode(title, prompt, agentDir, signal, modelOverride) {
	const t0 = Date.now();
	const { session } = await createAgentSession({
		agentDir,
		cwd: process.cwd(),
		model: modelOverride ?? resolveModel(),
		sessionManager: SessionManager.inMemory(), // 子代理会话纯内存：不落盘、不污染用户的会话列表
		noTools: "all", // 子节点做纯调研，禁工具保安全提速；需要工具的节点可放开
		// 注意：noTools:"all" 同时禁用了子代理的 graph_run —— 结构上防止无限递归
	});
	const agent = session.agent;

	// 中止传播：主工具调用被 abort 时，杀掉子代理
	const onAbort = () => { try { agent.abort(); } catch {} };
	signal?.addEventListener("abort", onAbort, { once: true });

	// 单节点超时兜底：超时的节点表现为"违约"，自动走既有重试机制，无需特殊分支
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
		label: "Graph Run（DAG 图调度）",
		description:
			"把多个子任务组成 DAG 并行/分波执行（图工程 Wave 调度）。" +
			"每个子任务在一个独立的 Pi 子代理中运行；互不依赖的节点同波并行，" +
			"有依赖的节点通过 dependsOn 声明，等上游完成后在下一波执行；" +
			"prompt 中的 {{id}} 占位符会被替换为对应上游节点的输出（节点间数据路由）。" +
			"适用于：每个子任务都需要大量独立工作的场景——深度调研、长文生成、流水线式加工（先拆解→再各自展开→最后汇总）、独立验证。" +
			"注意：依赖关系必须无环；只把相关的子任务放进同一次调用。" +
			"重要：如果你能凭已有知识直接回答（如综合对比类问答），直接回答——并行生成多份长文再汇总反而慢得多。",
		promptSnippet: "graph_run: 把子任务组成 DAG，同波并行、跨波按依赖执行，支持 {{id}} 数据路由（仅限每个子任务都很重的场景）",
		promptGuidelines: [
			"仅当每个子任务都需要大量独立工作（深度调研报告、长文生成、独立验证等，串行预计要几十秒以上）时才用 graph_run：无依赖的节点省略 dependsOn（同波并行），后置步骤用 dependsOn 声明并在 prompt 中用 {{上游id}} 引用其输出",
			"能凭已有知识直接回答的综合性问题（如\"调研/对比 N 个概念并总结\"）不要用 graph_run——直接回答只需一次生成，比并行生成多份长文再汇总快得多",
		],
		parameters: Type.Object({
			subtasks: Type.Array(
				Type.Object({
					id: Type.Optional(Type.String({ description: "节点唯一短 id（如 'search'）。省略时默认为 n1、n2…；dependsOn 与 {{id}} 引用它" })),
					title: Type.String({ description: "子任务短名（如 '概念调研'），用于结果展示" }),
					prompt: Type.String({ description: "给该子代理的完整独立指令，需自包含背景。可包含 {{id}} 占位符，运行前会被替换为该上游节点的输出（自动补充对应依赖边）" }),
					dependsOn: Type.Optional(Type.Array(Type.String({ description: "本节点依赖的上游节点 id 列表；这些节点成功后本节点才会执行" }))),
				}),
				{ description: "组成 DAG 的子任务列表（建议 2-12 个）。依赖必须无环" },
			),
		}),

		async execute(toolCallId, params, signal, onUpdate) {
			const agentDir = resolveAgentDir();
			const modelOverride = resolveModel();
			const t0 = Date.now();

			// TUI 安全日志：交互模式走 onUpdate 官方通道；仅非 TTY（SDK/CI）时 console.log
			const log = (m) => {
				try { onUpdate?.({ content: [], details: { status: m } }); } catch {}
				if (!process.stdout.isTTY) console.log(`  [graph_run] ${m}`);
			};

			// 入参护栏
			if (!Array.isArray(params.subtasks) || params.subtasks.length === 0) {
				return { content: [{ type: "text", text: "graph_run 错误：subtasks 不能为空。" }], details: { error: true } };
			}
			if (params.subtasks.length > MAX_SUBTASKS) {
				return {
					content: [{ type: "text", text: `graph_run 错误：一次最多 ${MAX_SUBTASKS} 个子任务（当前 ${params.subtasks.length} 个），请拆成多次调用。` }],
					details: { error: true },
				};
			}

			// 图规划：校验 + 隐式边 + 拓扑分层（失败回报 LLM，让它修正后重试调用）
			let plan;
			try {
				plan = planGraph(params.subtasks, log);
			} catch (e) {
				return { content: [{ type: "text", text: `graph_run 错误：${e.message}` }], details: { error: true } };
			}
			const { nodes, byId, waves } = plan;

			log(`图规划完成：${nodes.length} 个节点 / ${waves.length} 个 Wave / ${nodes.reduce((s, n) => s + n.dependsOn.length, 0)} 条边`);

			const violationsTotal = [];

			// ===== 多 Wave 主循环：波内 fan-out + allSettled 屏障，波间按拓扑序推进 =====
			for (let w = 0; w < waves.length; w++) {
				// 用户中止：剩余节点全部跳过，立即收尾（不再拉起新的子代理）
				if (signal?.aborted) {
					for (const n of nodes) {
						if (n.status === "pending") {
							n.status = "skipped";
							n.skipReason = "调用已被用户中止";
						}
					}
					log("检测到中止信号：跳过所有剩余节点");
					break;
				}
				// 失败级联：上游非 ok（失败或被跳过）的节点标记 skipped，本波不执行
				for (const n of waves[w]) {
					const bad = n.dependsOn.filter((d) => byId.get(d).status !== "ok");
					if (bad.length > 0) {
						n.status = "skipped";
						n.skipReason = `上游 ${bad.join("、")} 未成功`;
						log(`⏭️ [${n.title}] 跳过：${n.skipReason}`);
					}
				}
				const batch = waves[w].filter((n) => n.status === "pending");
				if (batch.length === 0) continue;

				log(`Wave ${w + 1}/${waves.length} 启动：${batch.length} 个子代理并行`);
				const settled = await Promise.allSettled(
					batch.map((n) => runSubNode(n.title, renderPrompt(n, byId), agentDir, signal, modelOverride)),
				);

				// 契约校验：输出达标才算履约；违约节点单独重试（不重跑整波）
				const violations = [];
				settled.forEach((r, i) => {
					const n = batch[i];
					if (r.status === "fulfilled" && r.value.text.length > MIN_OUTPUT_CHARS) {
						n.status = "ok";
						n.result = r.value;
					} else {
						const reason = r.status === "rejected"
							? String(r.reason?.message ?? r.reason).slice(0, 100)
							: (r.value?.timedOut
								? `节点超时（>${Math.round(NODE_TIMEOUT_MS / 1000)}s）`
								: "输出为空或过短（契约违规）");
						log(`⚠️ [${n.title}] ${reason} → 仅重试该节点`);
						violations.push({ n, reason });
					}
				});
				violationsTotal.push(...violations.map((v) => ({ id: v.n.id, title: v.n.title, reason: v.reason })));

				// 违约节点并行隔离重试一次；仍失败则标记 failed（其后代将在后续波中级联跳过）
				// （中止后不再重试——重试等于无视用户的中止指令拉起新子代理）
				const toRetry = signal?.aborted ? [] : violations;
				await Promise.allSettled(toRetry.map(async ({ n }) => {
					try {
						const retry = await runSubNode(
							n.title,
							renderPrompt(n, byId) + "\n\n注意：请直接以文本形式输出你的完整结果。",
							agentDir,
							signal,
							modelOverride,
						);
						if (retry.text.length > MIN_OUTPUT_CHARS) {
							retry.retried = true;
							n.status = "ok";
							n.result = retry;
							log(`✅ [${n.title}] 重试成功`);
						} else {
							n.status = "failed";
							log(`❌ [${n.title}] 重试后仍违约，放弃该节点（其后代将被跳过，不影响其他分支）`);
						}
					} catch (e) {
						n.status = "failed";
						log(`❌ [${n.title}] 重试异常：${String(e?.message ?? e).slice(0, 80)}（其后代将被跳过，不影响其他分支）`);
					}
				}));
			}

			// 收尾清扫：中止等边界情况下仍为 pending 的节点统一标记为 skipped
			for (const n of nodes) {
				if (n.status === "pending") {
					n.status = "skipped";
					n.skipReason = n.skipReason ?? "调用已被用户中止";
				}
			}

			// ===== 聚合返回：按 Wave 分组 + 轻量引用（每节点截断，防主上下文膨胀）=====
			const okCount = nodes.filter((n) => n.status === "ok").length;
			const skippedCount = nodes.filter((n) => n.status === "skipped").length;
			const failedCount = nodes.filter((n) => n.status === "failed").length;
			const waveSeconds = (Date.now() - t0) / 1000;

			const sections = [];
			for (let w = 0; w < waves.length; w++) {
				sections.push(`—— Wave ${w + 1} ——`);
				for (const n of waves[w]) {
					if (n.status === "ok") {
						const body = OUTPUT_CAP > 0 && n.result.text.length > OUTPUT_CAP
							? n.result.text.slice(0, OUTPUT_CAP) + `\n…（已截断，原 ${n.result.text.length} 字）`
							: n.result.text;
						sections.push(`### ${n.title}${n.result.retried ? "（重试后成功）" : ""}\n${body}`);
					} else if (n.status === "skipped") {
						sections.push(`### ${n.title} —— 已跳过（${n.skipReason}）`);
					} else {
						sections.push(`### ${n.title} —— 失败（重试后仍未履行契约）`);
					}
				}
			}

			const summary =
				`graph_run 完成：${okCount}/${nodes.length} 个节点成功` +
				`（${waves.length} 个 Wave，并行耗时 ${waveSeconds.toFixed(1)}s` +
				`${violationsTotal.length ? `；违约重试 ${violationsTotal.length} 个` : ""}` +
				`${skippedCount ? `；级联跳过 ${skippedCount} 个` : ""}` +
				`${failedCount ? `；最终失败 ${failedCount} 个` : ""}）\n\n` +
				sections.join("\n\n");

			log(`图执行完成：${okCount}/${nodes.length} 成功，${waves.length} Wave，${waveSeconds.toFixed(1)}s`);

			return {
				content: [{ type: "text", text: summary }],
				details: {
					waves: waves.map((wave) => wave.map((n) => n.id)),
					edges: nodes.flatMap((n) => n.dependsOn.map((d) => ({ from: d, to: n.id }))),
					nodes: nodes.map((n) => ({
						id: n.id,
						title: n.title,
						wave: n.wave + 1,
						status: n.status,
						seconds: n.status === "ok" ? Number(n.result.seconds.toFixed(1)) : undefined,
						chars: n.status === "ok" ? n.result.text.length : undefined,
						retried: !!(n.status === "ok" && n.result.retried),
						skipReason: n.skipReason,
					})),
					waveSeconds: Number(waveSeconds.toFixed(1)),
					violations: violationsTotal,
				},
			};
		},
	});
}
