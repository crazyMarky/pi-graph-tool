#!/usr/bin/env node
/**
 * pi-graph-tool 可视化服务器（零依赖，Node ≥ 18）
 * ====================================================================
 * 读取 PI_GRAPH_TRACE_DIR 里 graph_run 落盘的 JSONL 执行事件，
 * 通过 SSE 实时推送给 ui/index.html 渲染 Wave 调度动画。
 *
 * 用法（两个终端）：
 *   终端 1（跑任务）：
 *     export PI_GRAPH_TRACE_DIR=/tmp/pgt-traces
 *     cd <装了本扩展的项目> && pi "帮我调研 A、B、C 然后对比汇总"
 *   终端 2（看动画）：
 *     PI_GRAPH_TRACE_DIR=/tmp/pgt-traces node ui/server.mjs
 *     打开 http://localhost:8788
 *
 * 端点：
 *   GET /                     → 可视化页面（ui/index.html）
 *   GET /api/runs             → 历史 run 列表（按时间倒序）
 *   GET /api/run/:name        → 单个 run 的完整 JSONL
 *   GET /events[?run=name]    → SSE 实时流；缺省跟随最新 run，
 *                               出现更新的 run 时以 new_run 事件收流，
 *                               浏览器 EventSource 自动重连切到新 run
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// ---- 参数 ----
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PORT = Number(argOf("port", process.env.PORT ?? 8788));
const RUN_CWD = argOf("cwd", process.env.PI_GRAPH_UI_CWD ?? process.cwd());
const RUN_MODEL = argOf("model", process.env.PI_GRAPH_UI_MODEL ?? "");
const TRACE_DIR = argOf("dir", process.env.PI_GRAPH_TRACE_DIR ?? path.join(here, "..", "traces"));
fs.mkdirSync(TRACE_DIR, { recursive: true });

const listRuns = () =>
	fs.readdirSync(TRACE_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const st = fs.statSync(path.join(TRACE_DIR, f));
			return { name: f, mtime: st.mtimeMs, size: st.size };
		})
		.sort((a, b) => b.mtime - a.mtime);

const json = (res, code, body) => {
	res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
	res.end(JSON.stringify(body));
};

// ---- SSE：先推已有内容，再轮询增量（400ms 足够看动画，且跨平台稳）----
function streamRun(req, res, file) {
	const full = path.join(TRACE_DIR, file);
	if (!fs.existsSync(full)) return json(res, 404, { error: "run 不存在" });
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
		"Access-Control-Allow-Origin": "*",
	});
	const send = (line) => res.write(`data: ${line}\n\n`);
	let offset = 0;
	const pump = () => {
		try {
			const st = fs.statSync(full);
			if (st.size > offset) {
				const fd = fs.openSync(full, "r");
				const buf = Buffer.alloc(st.size - offset);
				fs.readSync(fd, buf, 0, buf.length, offset);
				fs.closeSync(fd);
				offset = st.size;
				for (const line of buf.toString("utf8").split("\n")) if (line.trim()) send(line);
			}
		} catch { /* 文件被轮换等瞬时状态：下个周期再读 */ }
	};
	pump();
	let closed = false;
	req.on("close", () => { closed = true; clearInterval(timer); clearInterval(watch); });
	const timer = setInterval(pump, 400);
	// 出现更新的 run 时主动收流，让 EventSource 重连到最新（跟随模式）
	let watch = 0;
	if (!req.url.includes("run=")) {
		watch = setInterval(() => {
			const runs = listRuns();
			if (runs.length > 0 && runs[0].name !== file) {
				send(JSON.stringify({ t: "new_run", file: runs[0].name }));
				res.end();
				clearInterval(timer); clearInterval(watch);
			}
		}, 2000);
	}
}

// ---- 输入框后端：无头跑一次 pi，产出 trace 由 /events 跟随，最终回答返回给页面 ----
let running = null;
function startRun(message, res) {
	if (running) return json(res, 409, { error: "已有任务在运行，请等它结束" });
	const args = ["-p", message, "--no-session"];
	if (RUN_MODEL) args.push("--model", RUN_MODEL);
	const proc = spawn("pi", args, { cwd: RUN_CWD, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	let out = "", err = "";
	proc.stdout.on("data", (d) => { out += d; });
	proc.stderr.on("data", (d) => { err += d; });
	const killer = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 15 * 60_000);
	running = proc;
	proc.on("close", (code) => {
		clearTimeout(killer); running = null;
		json(res, 200, { code, stdout: out.slice(-20000), stderr: err.slice(-500) });
	});
}

const server = http.createServer((req, res) => {
	const url = new URL(req.url, "http://x");
	if (req.method === "POST" && url.pathname === "/run") {
		let body = "";
		req.on("data", (c) => { body += c; if (body.length > 100_000) req.destroy(); });
		req.on("end", () => {
			try { const { message } = JSON.parse(body || "{}"); if (!message || !String(message).trim()) return json(res, 400, { error: "message 不能为空" }); startRun(String(message), res); }
			catch (e) { json(res, 500, { error: "启动失败：" + (e?.message ?? e) }); }
		});
		return;
	}
	if (url.pathname === "/" || url.pathname === "/index.html") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		res.end(fs.readFileSync(path.join(here, "index.html")));
	} else if (url.pathname === "/api/runs") {
		json(res, 200, listRuns());
	} else if (url.pathname.startsWith("/api/run/")) {
		const name = url.pathname.slice("/api/run/".length);
		if (!/^[\w.-]+\.jsonl$/.test(name)) return json(res, 400, { error: "非法文件名" });
		const full = path.join(TRACE_DIR, name);
		if (!fs.existsSync(full)) return json(res, 404, { error: "run 不存在" });
		res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
		res.end(fs.readFileSync(full, "utf8"));
	} else if (url.pathname === "/events") {
		const pinned = url.searchParams.get("run");
		const runs = listRuns();
		const file = pinned && /^[\w.-]+\.jsonl$/.test(pinned) ? pinned : (runs[0]?.name ?? "");
		if (!file) {
			res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });
			res.write("retry: 3000\n\n");
			const watch = setInterval(() => {
				const r = listRuns();
				if (r.length > 0) { clearInterval(watch); res.end(); } // 收流触发重连
			}, 2000);
			req.on("close", () => clearInterval(watch));
			return;
		}
		streamRun(req, res, file);
	} else {
		json(res, 404, { error: "not found" });
	}
});

server.listen(PORT, () => {
	console.log(`pi-graph-tool UI → http://localhost:${PORT}`);
	console.log(`追踪目录：${TRACE_DIR}`);
	console.log(`提示：任务侧需设置 PI_GRAPH_TRACE_DIR 并指向同一目录`);
});
