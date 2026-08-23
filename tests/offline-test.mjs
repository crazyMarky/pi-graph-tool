/** v0.2.3 离线验证（0 token）：fake-pi 捕获工具 → 直调 execute → 预中止信号跳过全部节点 */
import ext from "../index.js";

const registered = {};
ext({ registerTool: (t) => { registered[t.name] = t; } });
const tool = registered.graph_run;
if (!tool) { console.error("❌ graph_run 未注册"); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "✅" : "❌"} ${name}`); };

// T1 新字段通过规划（预中止 → 全部 skipped，details 含 waves/edges）
{
  const ac = new AbortController(); ac.abort();
  const r = await tool.execute("t", { subtasks: [
    { id: "qa",  title: "短判定", prompt: "只回复：合格", minOutputChars: 0 },
    { id: "dev", title: "工具节点", prompt: "读取 note.txt", tools: ["read", "bash"], workdir: "nodes/dev" },
    { id: "rpt", title: "长报告", prompt: "写报告 {{qa}}", dependsOn: ["qa"], outputCap: 100 },
  ]}, ac.signal);
  const d = r.details;
  check("T1a 新字段全部通过规划（无 schema/代码报错）", !d.error);
  check("T1b 全部节点 skipped（预中止，0 LLM 调用）", d.nodes.every(n => n.status === "skipped"));
  check("T1c 两波分层正确 qa,dev | rpt", JSON.stringify(d.waves) === JSON.stringify([["qa","dev"],["rpt"]]));
  check("T1d 边含显式 qa→rpt", d.edges.some(e => e.from === "qa" && e.to === "rpt"));
}
// T2 护栏回归
{
  const ac = new AbortController();
  const bad = async (sub, name) => { const r = await tool.execute("t", sub, ac.signal); check(name, r.details.error === true); };
  await bad({ subtasks: [] }, "T2a 空 subtasks 拒绝");
  await bad({ subtasks: [{ id:"a", title:"a", prompt:"x" }, { id:"a", title:"a", prompt:"y" }] }, "T2b 重复 id 拒绝");
  await bad({ subtasks: [{ id:"a", title:"a", prompt:"{{b}}" }, { id:"b", title:"b", prompt:"{{a}}" }] }, "T2c 隐式边成环拒绝");
  await bad({ subtasks: [{ id:"a", title:"a", prompt:"x", dependsOn:["ghost"] }] }, "T2d 未知依赖拒绝");
}
console.log(`\n离线验证：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
