/**
 * A/B 基准：串行（无扩展等价：单会话逐个处理）vs 图调度（复刻 pi-graph-tool 的
 * Wave fan-out + 全保真数据路由 + 隔离子代理会话）。
 *
 * 用法：
 *   cd bench
 *   npm install
 *   node bench.mjs
 *
 * 成本说明：任务刻意很小（~120 字概括），每轮 8 次 LLM 调用 × 2 轮 × 2 方案。
 * 判读要点：
 *   - 加速比 > 1 说明服务商确实并发处理请求
 *   - 若 "Wave1 最慢节点" 接近 "串行单耗 × 任务数"，说明请求在服务商侧被排队，
 *     并行收益趋近 0（此时该账号/模型下不建议依赖 graph_run 提速）
 */
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const TASKS = [
	{ id: "react", prompt: "用约120字概括 React 的核心设计理念与定位，直接输出正文，不要客套。" },
	{ id: "vue", prompt: "用约120字概括 Vue 的核心设计理念与定位，直接输出正文，不要客套。" },
	{ id: "svelte", prompt: "用约120字概括 Svelte 的核心设计理念与定位，直接输出正文，不要客套。" },
];
const COMPARE_SERIAL = "现在基于你前面输出的三段概括，用约100字总结三者最关键的差异。直接输出正文。";

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

const NODE_TIMEOUT_MS = 240_000;

async function newNodeSession() {
	const { session } = await createAgentSession({
		sessionManager: SessionManager.inMemory(), // 与扩展子代理一致：内存会话，不污染会话列表
		noTools: "all",
	});
	return session;
}

async function timedPrompt(session, prompt) {
	const t0 = Date.now();
	const agent = session.agent;
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; try { agent.abort(); } catch {} }, NODE_TIMEOUT_MS);
	try {
		await agent.prompt(prompt);
	} finally {
		clearTimeout(timer);
	}
	return { text: lastText(session.messages), seconds: (Date.now() - t0) / 1000, timedOut };
}

// ---- 串行：一个会话顺序处理（无扩展时主 agent 的行为）----
async function serialRun() {
	const session = await newNodeSession();
	const t0 = Date.now();
	const steps = [];
	for (const t of TASKS) {
		const r = await timedPrompt(session, t.prompt);
		steps.push({ id: t.id, seconds: r.seconds, chars: r.text.length });
	}
	const cmp = await timedPrompt(session, COMPARE_SERIAL);
	steps.push({ id: "compare", seconds: cmp.seconds, chars: cmp.text.length });
	return { total: (Date.now() - t0) / 1000, steps };
}

// ---- 图调度：每节点独立会话，Wave1 并行，Wave2 路由汇总（复刻扩展行为）----
async function graphRun() {
	const t0 = Date.now();
	const wave1 = await Promise.all(TASKS.map(async (t) => {
		const s = await newNodeSession();
		const r = await timedPrompt(s, t.prompt);
		return { id: t.id, ...r };
	}));
	const routed =
		"以下是三段前端框架概括：\nReact：{{react}}\nVue：{{vue}}\nSvelte：{{svelte}}\n" +
		"用约100字总结三者最关键的差异。直接输出正文。"
			.replace("{{react}}", wave1[0].text)
			.replace("{{vue}}", wave1[1].text)
			.replace("{{svelte}}", wave1[2].text);
	const cmpSession = await newNodeSession();
	const cmp = await timedPrompt(cmpSession, routed);
	const steps = [
		...wave1.map((r) => ({ id: r.id, seconds: r.seconds, chars: r.text.length })),
		{ id: "compare", seconds: cmp.seconds, chars: cmp.text.length },
	];
	return { total: (Date.now() - t0) / 1000, steps };
}

function fmtRun(name, r) {
	const detail = r.steps.map((s) => `${s.id}:${s.seconds.toFixed(1)}s/${s.chars}字`).join("  ");
	console.log(`${name}: 总计 ${r.total.toFixed(1)}s   [${detail}]`);
	return r;
}

console.log(`node ${process.version}; 小任务 A/B 基准（2 轮交错）`);
const results = { serial: [], graph: [] };
for (let round = 1; round <= 2; round++) {
	console.log(`—— 第 ${round} 轮 ——`);
	results.serial.push(fmtRun("串行(无扩展等价)", await serialRun()));
	results.graph.push(fmtRun("图调度等价    ", await graphRun()));
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sTotal = avg(results.serial.map((r) => r.total));
const gTotal = avg(results.graph.map((r) => r.total));
console.log("\n—— 汇总 ——");
console.log(`串行平均: ${sTotal.toFixed(1)}s   图调度平均: ${gTotal.toFixed(1)}s   加速比: ${(sTotal / gTotal).toFixed(2)}x`);
const s1 = results.serial.flatMap((r) => r.steps.filter((x) => x.id !== "compare"));
const w1max = results.graph.map((r) => Math.max(...r.steps.filter((x) => x.id !== "compare").map((x) => x.seconds)));
const s1avg = avg(s1.map((x) => x.seconds));
console.log(`调研步平均单耗(串行): ${s1avg.toFixed(1)}s；Wave1 最慢节点平均: ${avg(w1max).toFixed(1)}s（若接近 ${s1avg.toFixed(1)}s × 3 之和的一半以上，说明服务商在排队并发请求）`);
