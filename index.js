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
 * v0.2.3 节点档案（三个全局常量升级为每节点可覆盖，修复组内测评 F3）：
 *   - subtasks[].tools    —— 工具白名单（如 ["read","bash"]）：默认无工具不变，声明后
 *                            该子代理获得指定工具；graph_run 被结构性排除（白名单不含
 *                            + excludeTools 双保险），递归防护不弱于全禁方案
 *   - subtasks[].workdir  —— 工具节点的独立工作目录（防并行 write/bash 互相踩踏）
 *   - subtasks[].minOutputChars —— 契约阈值每节点可调（默认 20；简短任务设 0 豁免），
 *                            全局默认可用 PI_GRAPH_MIN_OUTPUT_CHARS 调整
 *   - subtasks[].outputCap     —— 回传截断每节点可调（默认 6000）
 *   - 重试语义软化：阈值只触发"一次挽回机会"，重试后【非空即接受】——
 *                            简洁但合法的输出不再被误杀（F3：视觉 QA 4/6 误判违约）
 *   设计原则：全局 env 退为默认值，任务异构性由每节点档案表达
 * v0.2.4 执行追踪出口（配套 ui/ 可视化）：
 *   - 设置 PI_GRAPH_TRACE_DIR 后，每次 graph_run 把执行过程以 JSONL 事件流落盘
 *     （plan / wave_start / node_ok / violation / retry / skip / done），
 *     `node ui/server.mjs` 读取这些事件实时渲染 Wave 调度动画
 *   - 默认关闭、全程 try/catch 包裹：追踪永不影响图执行本身
 *   - v0.3.0：node_delta 事件实时流式节点过程（文本增量 120ms 合并 + 工具调用），
 *     产出全文不再截断。注意：trace 含 prompt 与产出全文，目录请勿外传
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
// v0.2.3：契约阈值可配置（F3 修复）——长度是启发式不是法律：
//   阈值只用来触发"一次挽回机会"（重试），重试后只要非空即接受，不再据此丢弃节点。
//   视觉判定/是否类等天然简短的任务，按节点设 minOutputChars: 0 即豁免。
const MIN_OUTPUT_CHARS = intEnv("PI_GRAPH_MIN_OUTPUT_CHARS", 20);

// ---- v0.2.4 执行追踪：把 graph_run 的执行过程以 JSONL 事件流落盘，供 ui/ 实时可视化 ----
// 用法：export PI_GRAPH_TRACE_DIR=/tmp/pgt-traces（目录不存在会自动创建）
// 设计约束：①默认关闭（不设 env 完全零开销零副作用）②任何异常就地吞掉——
//           追踪通道挂了也绝不影响图执行本身 ③文件句柄 unref，不拖住进程退出
let traceRunId = null;
function trace(ev) {
	try {
		const dir = process.env.PI_GRAPH_TRACE_DIR;
		if (!dir) return;
		if (traceStream === null) {
			traceRunId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
			fs.mkdirSync(dir, { recursive: true });
			traceStream = fs.createWriteStream(path.join(dir, `${traceRunId}.jsonl`), { flags: "a" });
			traceStream.on("error", () => { try { traceStream.destroy(); } catch {} traceStream = false; });
			traceStream.on("close", () => { traceStream = false; });
		}
		if (traceStream) traceStream.write(JSON.stringify({ ts: Date.now(), run: traceRunId, ...ev }) + "\n");
	} catch {}
}
let traceStream = null; // null=未初始化 | false=不可用 | WriteStream=可用

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
		// ---- v0.2.3 节点档案：全局 env 为默认值，每节点可按需覆盖（F3 修复 + 工具白名单）----
		tools: Array.isArray(st.tools) ? [...new Set(st.tools.map((t) => String(t).trim()).filter(Boolean))] : undefined,
		minOutputChars: Number.isFinite(st.minOutputChars) && st.minOutputChars >= 0 ? Math.floor(st.minOutputChars) : undefined,
		outputCap: Number.isFinite(st.outputCap) && st.outputCap >= 0 ? Math.floor(st.outputCap) : undefined,
		workdir: typeof st.workdir === "string" && st.workdir.trim() ? st.workdir.trim() : undefined,
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
	const inferredEdges = [];
	for (const n of nodes) {
		for (const m of n.prompt.matchAll(PLACEHOLDER_RE)) {
			const ref = m[1];
			if (byId.has(ref) && ref !== n.id && !n.dependsOn.includes(ref)) {
				n.dependsOn.push(ref);
				inferredEdges.push({ from: ref, to: n.id });
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
	return { nodes, byId, waves, inferredEdges };
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
// v0.2.3：节点档案驱动的工具策略——
//   默认（无 tools）：noTools:"all"，纯 LLM 调研，快且省 token（上下文经济学优势）
//   声明 tools 白名单：只启用列出的工具（如 read/bash），graph_run 被结构性排除——
//     双保险：白名单不含它 + excludeTools 显式禁用，递归防护不弱于全禁方案
//   声明 workdir：工具节点在独立目录工作，避免并行 write/bash 互相踩踏
async function runSubNode(node, prompt, agentDir, signal, modelOverride, onEvent) {
	const t0 = Date.now();
	const sessionOpts = {
		agentDir,
		model: modelOverride ?? resolveModel(),
		sessionManager: SessionManager.inMemory(), // 子代理会话纯内存：不落盘、不污染用户的会话列表
	};
	if (node.tools && node.tools.length > 0) {
		sessionOpts.cwd = node.workdir ? path.join(process.cwd(), node.workdir) : process.cwd();
		if (node.workdir) fs.mkdirSync(sessionOpts.cwd, { recursive: true });
		sessionOpts.tools = node.tools; // 白名单：只启用列出的工具
		sessionOpts.excludeTools = ["graph_run"]; // 结构性递归防护（即使白名单误含 graph_run 也被剔除）
	} else {
		sessionOpts.cwd = process.cwd();
		sessionOpts.noTools = "all"; // 默认纯调研：禁工具保安全提速
	}
	const { session } = await createAgentSession(sessionOpts);
	const agent = session.agent;

	// v0.3.0 节点级事件流：订阅子代理会话事件，转发文本增量（120ms 合并）与工具调用，
	// 供 ui/ 实时展示"过程"（node_delta）。onEvent 缺省时零开销。
	let buf = "", bufTimer = null;
	const unsubscribe = onEvent ? session.subscribe((ev) => {
		try {
			if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
				buf += ev.assistantMessageEvent.delta ?? "";
				if (!bufTimer) bufTimer = setTimeout(() => {
					bufTimer = null;
					if (buf) { onEvent({ kind: "text", delta: buf }); buf = ""; }
				}, 120);
			} else if (ev.type === "tool_execution_start") {
				onEvent({ kind: "tool", tool: ev.toolName });
			}
		} catch {}
	}) : null;

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
		if (bufTimer) { clearTimeout(bufTimer); if (buf && onEvent) { try { onEvent({ kind: "text", delta: buf }); } catch {} } }
		try { unsubscribe?.(); } catch {}
		signal?.removeEventListener("abort", onAbort);
	}
	return { title: node.title, text: lastText(session.messages), seconds: (Date.now() - t0) / 1000, timedOut };
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
			"每节点可选档案：tools 声明工具白名单（如 [\"read\",\"bash\"]，graph_run 永不可用）；" +
			"minOutputChars 调契约阈值（视觉判定/是否类简短任务设 0）；outputCap 调回传截断；workdir 给工具节点独立工作目录。" +
			"适用于：多角度调研、流水线式加工（先拆解→再各自展开→最后汇总）、批量生成、独立验证等。" +
			"注意：依赖关系必须无环；只把相关的子任务放进同一次调用。",
		promptSnippet: "graph_run: 把子任务组成 DAG，同波并行、跨波按依赖执行，支持 {{id}} 数据路由",
		promptGuidelines: [
			"当待办子任务较多时，用一次 graph_run 组成 DAG 完成：无依赖的节点省略 dependsOn（同波并行），后置步骤用 dependsOn 声明依赖并在 prompt 中用 {{上游id}} 引用其输出",
		],
		parameters: Type.Object({
			subtasks: Type.Array(
				Type.Object({
					id: Type.Optional(Type.String({ description: "节点唯一短 id（如 'search'）。省略时默认为 n1、n2…；dependsOn 与 {{id}} 引用它" })),
					title: Type.String({ description: "子任务短名（如 '概念调研'），用于结果展示" }),
					prompt: Type.String({ description: "给该子代理的完整独立指令，需自包含背景。可包含 {{id}} 占位符，运行前会被替换为该上游节点的输出（自动补充对应依赖边）" }),
					dependsOn: Type.Optional(Type.Array(Type.String({ description: "本节点依赖的上游节点 id 列表；这些节点成功后本节点才会执行" }))),
					tools: Type.Optional(Type.Array(Type.String({ description: "该子代理可用的工具白名单（如 [\"read\",\"bash\"]）。省略 = 纯 LLM 无工具（默认，快且省 token）；需要读文件/执行命令的节点才声明。graph_run 永远不可用（防递归）" }))),
					minOutputChars: Type.Optional(Type.Integer({ minimum: 0, description: "该节点的最小输出字符数（默认 20，全局可用 PI_GRAPH_MIN_OUTPUT_CHARS 调）。视觉判定/是否类等天然简短的任务设 0 豁免。注意：阈值只触发一次挽回重试，重试后非空即接受，不会丢弃节点" })),
					outputCap: Type.Optional(Type.Integer({ minimum: 0, description: "该节点结果回传主上下文的截断字符数（默认 6000，全局可用 PI_GRAPH_OUTPUT_CAP 调）；0 = 不截断。汇总/长报告节点可调大，QA/判定节点可调小" })),
					workdir: Type.Optional(Type.String({ description: "该子代理的工作目录（相对当前目录，如 \"nodes/research\"）。声明了 tools 的节点建议设置，避免并行工具节点互相踩踏文件" })),
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
			trace({
				t: "plan",
				nodes: nodes.map((n) => ({
					id: n.id, title: n.title, wave: n.wave + 1, dependsOn: [...n.dependsOn],
					tools: n.tools ?? [], minOutputChars: n.minOutputChars ?? MIN_OUTPUT_CHARS, outputCap: n.outputCap ?? OUTPUT_CAP, workdir: n.workdir,
				})),
				waves: waves.map((wave) => wave.map((n) => n.id)),
				edges: nodes.flatMap((n) => n.dependsOn.map((d) => ({ from: d, to: n.id }))),
				inferredEdges: plan.inferredEdges,
			});

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
					trace({ t: "abort" });
					break;
				}
				// 失败级联：上游非 ok（失败或被跳过）的节点标记 skipped，本波不执行
				for (const n of waves[w]) {
					const bad = n.dependsOn.filter((d) => byId.get(d).status !== "ok");
					if (bad.length > 0) {
						n.status = "skipped";
						n.skipReason = `上游 ${bad.join("、")} 未成功`;
						log(`⏭️ [${n.title}] 跳过：${n.skipReason}`);
						trace({ t: "skip", id: n.id, reason: n.skipReason });
					}
				}
				const batch = waves[w].filter((n) => n.status === "pending");
				if (batch.length === 0) continue;

				log(`Wave ${w + 1}/${waves.length} 启动：${batch.length} 个子代理并行` +
					(batch.some((n) => n.tools?.length) ? `（含工具节点：${batch.filter((n) => n.tools?.length).map((n) => `${n.id}[${n.tools.join("/")}]`).join("、")}）` : ""));
				trace({ t: "wave_start", wave: w + 1, total: waves.length, nodes: batch.map((n) => n.id), at: Date.now() - t0 });
				const settled = await Promise.allSettled(
					batch.map((n) => runSubNode(n, renderPrompt(n, byId), agentDir, signal, modelOverride, (e) => trace({ t: "node_delta", id: n.id, ...e }))),
				);

				// 契约校验：输出超过（节点阈值 ?? 全局阈值）才算首过履约；否则单独重试（不重跑整波）
				const violations = [];
				settled.forEach((r, i) => {
					const n = batch[i];
					const minChars = n.minOutputChars ?? MIN_OUTPUT_CHARS;
					if (r.status === "fulfilled" && r.value.text.length > minChars) {
						n.status = "ok";
						n.result = r.value;
						trace({ t: "node_ok", id: n.id, seconds: Number(r.value.seconds.toFixed(1)), chars: r.value.text.length, text: r.value.text });
					} else {
						const reason = r.status === "rejected"
							? String(r.reason?.message ?? r.reason).slice(0, 100)
							: (r.value?.timedOut
								? `节点超时（>${Math.round(NODE_TIMEOUT_MS / 1000)}s）`
								: `输出为空或过短（实际 ${r.value?.text?.length ?? 0} 字 / 阈值 ${minChars}，触发一次挽回重试）`);
						log(`⚠️ [${n.title}] ${reason} → 仅重试该节点`);
						trace({ t: "violation", id: n.id, reason, firstChars: r.status === "fulfilled" ? (r.value?.text?.length ?? 0) : 0 });
						violations.push({ n, reason, firstText: r.status === "fulfilled" ? (r.value?.text ?? "") : "" });
					}
				});
				violationsTotal.push(...violations.map((v) => ({ id: v.n.id, title: v.n.title, reason: v.reason })));

				// 违约节点并行隔离重试一次。v0.2.3 自适应挽回策略（实测教训：对"只回复两个字"类
				// prompt 追加"输出完整结果"会自相矛盾，把模型逼成空输出）：
				//   首答为空   → 轻推一句让它开口（不提"完整"，避免与简洁类任务冲突）
				//   首答非空但短 → 用【原题】重试（不改写指令），从两次结果中打捞较长者
				// 接受准则：两次中有任一非空即 ok——阈值只负责触发挽回机会，不丢弃节点（F3）。
				// （中止后不再重试——重试等于无视用户的中止指令拉起新子代理）
				const toRetry = signal?.aborted ? [] : violations;
				await Promise.allSettled(toRetry.map(async ({ n, firstText }) => {
					try {
						const nudge = firstText.trim() ? "" : "\n\n注意：请直接以文本形式输出你的回答。";
						trace({ t: "retry_start", id: n.id });
						const retry = await runSubNode(n, renderPrompt(n, byId) + nudge, agentDir, signal, modelOverride, (e) => trace({ t: "node_delta", id: n.id, retry: true, ...e }));
						const candidates = [retry.text, firstText].filter((t) => t && t.trim().length > 0);
						if (candidates.length > 0) {
							const best = candidates.reduce((a, b) => (b.length > a.length ? b : a));
							retry.text = best;
							retry.retried = true;
							n.status = "ok";
							n.result = retry;
							log(`✅ [${n.title}] 重试挽回成功${best === firstText ? "（沿用首答）" : ""}`);
							trace({ t: "node_ok", id: n.id, seconds: Number(retry.seconds.toFixed(1)), chars: retry.text.length, text: retry.text, retried: true, salvaged: best === firstText ? "first" : "retry" });
						} else {
							n.status = "failed";
							log(`❌ [${n.title}] 两次尝试均无有效输出，放弃该节点（其后代将被跳过，不影响其他分支）`);
							trace({ t: "node_failed", id: n.id, reason: "两次尝试均无有效输出" });
						}
					} catch (e) {
						n.status = "failed";
						log(`❌ [${n.title}] 重试异常：${String(e?.message ?? e).slice(0, 80)}（其后代将被跳过，不影响其他分支）`);
						trace({ t: "node_failed", id: n.id, reason: `重试异常：${String(e?.message ?? e).slice(0, 80)}` });
					}
				}));
				trace({ t: "wave_end", wave: w + 1, at: Date.now() - t0 });
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
					// v0.2.3：截断阈值按节点生效（n.outputCap ?? 全局 OUTPUT_CAP）；0 = 该节点不截断
					const cap = n.outputCap ?? OUTPUT_CAP;
					const body = cap > 0 && n.result.text.length > cap
						? n.result.text.slice(0, cap) + `\n…（已截断，原 ${n.result.text.length} 字）`
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
			trace({ t: "done", ok: okCount, failed: failedCount, skipped: skippedCount, total: nodes.length, waveSeconds: Number(waveSeconds.toFixed(1)), violations: violationsTotal.length });

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
