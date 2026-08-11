/**
 * node Word/extension/test_materialTools.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const mt = require("./materialTools");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-mat-"));
const mat = path.join(root, "素材");
fs.mkdirSync(mat, { recursive: true });
const doc = path.join(root, "未命名.md");
fs.writeFileSync(doc, "# 未命名\n\n", "utf8");
fs.writeFileSync(
  path.join(mat, "开会通知.md"),
  "# 关于半年工作总结的通知\n\n请各部门报送上半年工作总结，重点写改革发展亮点与不足，附可核对数据。\n",
  "utf8"
);
fs.writeFileSync(path.join(mat, "说明.md"), "# 素材\n", "utf8");

const cat = mt.list_files(doc);
assert.ok(cat.ok, "list ok");
assert.ok(cat.items.some((x) => x.path === "未命名.md"));
assert.ok(cat.items.some((x) => x.path === "素材/开会通知.md"), "material in catalog");
assert.ok(!cat.items.some((x) => /说明\.md$/.test(x.path)), "skip 说明");

const hit = mt.search_materials(doc, "通知");
assert.ok(hit.ok && hit.hits.length >= 1, "search hits");
assert.ok(hit.hits[0].path.indexOf("开会通知") >= 0);

const rd = mt.read_file(doc, "素材/开会通知.md");
assert.ok(rd.ok && /半年工作总结/.test(rd.text));

let threw = false;
try {
  mt.resolveSafe(root, "../秘.md");
} catch (_) {
  threw = true;
}
assert.ok(threw, "block ..");

const parsed = mt.parseAgentPayload(
  JSON.stringify({
    type: "tool_calls",
    calls: [{ name: "read_file", arguments: { path: "素材/开会通知.md" } }],
  })
);
assert.strictEqual(parsed.kind, "tools");
assert.strictEqual(parsed.tool_calls[0].name, "read_file");

const fin = mt.parseAgentPayload(
  JSON.stringify({ reply: "好的", edit: { summary: "搭架", md: "# t\n" } })
);
assert.strictEqual(fin.kind, "final");
assert.ok(fin.edit && fin.edit.md);

const boot = mt.bootstrapMaterialReads(
  doc,
  "请读取通知，搭半年总结框架",
  "# 未命名\n\n",
  []
);
assert.ok(boot.readPaths.length >= 1, "bootstrap reads notice");
assert.ok(
  boot.toolResults.some((t) => t.name === "read_file" && t.result && t.result.ok),
  "bootstrap read ok"
);
assert.ok(/半年工作总结/.test(boot.toolResults.find((t) => t.name === "read_file").result.text));

// 关键词对不上文件名时，仍应从素材夹回退预读
fs.writeFileSync(
  path.join(mat, "某项目进展长文.md"),
  "# 某项目\n\n" + "完成投资进度节点并形成可核对成果。".repeat(20) + "\n",
  "utf8"
);
const disc = mt.discoverMaterialsForSuggest(doc, {
  selection: "",
  requirement: "【### （一）强化理论武装\n\n坚持把政治建设摆在首位】帮我把整篇初稿写好",
  docMd: "# 未命名\n\n",
});
assert.ok(disc.materials.length >= 1, "fallback read materials when keys miss names");
assert.ok(
  disc.materials.some((m) => /素材\//.test(m.path)),
  "fallback only under 素材/"
);

const rh = mt.rehydrateMaterialReads(
  doc,
  ["素材/开会通知.md"],
  []
);
assert.ok(rh.toolResults.length >= 1, "rehydrate read_set paths");
assert.ok(/半年工作总结/.test(rh.toolResults[0].result.text));

console.log("test_materialTools: ok");
