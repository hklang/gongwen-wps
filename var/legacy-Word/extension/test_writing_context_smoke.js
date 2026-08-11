/**
 * 写作用上下文拼装冒烟（不打网）。
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const officialSync = require("./officialSync");
const gwWs = require("./gongwenWorkspace");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gw-official-"));
const pack = {
  pack_version: 1,
  categories: [{ id: 1, code: "summary", name: "总结", grp: "总结汇报" }],
  manuals: [
    {
      code: "summary-basic",
      category_id: 1,
      title: "要点",
      version: "1",
      body_md: "# 手册\n\n据实写数。",
    },
  ],
  templates: [],
  playbooks: [],
};
officialSync.writePack(root, pack);
const md = path.join(root, "a.md");
fs.writeFileSync(
  path.join(root, "ref.md"),
  "## 参照\n\n我们坚持实事求是。\n",
  "utf8"
);
const shared =
  "本段用于测试旧稿对照重合检测，内容足够长以便命中算法。";
fs.writeFileSync(md, "# t\n\n" + shared + "\n\n新写的一段。\n", "utf8");
fs.writeFileSync(
  path.join(root, "old.md"),
  "# 旧稿\n\n" + shared + "\n\n旧稿独有段落。\n",
  "utf8"
);
const land = gwWs.landUserTemplate(md, {
  category: "summary",
  title: "半年工作总结骨架",
  body_md: "# 骨架\n\n## 一、成绩\n\n## 二、问题\n\n",
});
if (!land.ok || !land.path) {
  console.error("FAIL land", land);
  process.exit(1);
}
const afterLand = gwWs.loadConfig(root);
if (afterLand.write && afterLand.write.templatePath) {
  console.error("FAIL land must not set templatePath", afterLand.write);
  process.exit(1);
}
const cfg = {
  write: {
    categoryCode: "summary",
    referencePath: "ref.md",
    comparePath: "old.md",
    templatePath: land.path,
  },
};
const wc = officialSync.buildWritingContext(md, [], cfg);
if (!wc.inject || wc.inject.indexOf("公文文种") < 0) {
  console.error("FAIL genre", wc);
  process.exit(1);
}
if (wc.inject.indexOf("当前模板") >= 0 || wc.inject.indexOf("## 一、成绩") >= 0) {
  console.error("FAIL template must not auto-inject", wc);
  process.exit(1);
}
if (wc.templatePath !== land.path) {
  console.error("FAIL templatePath meta", wc);
  process.exit(1);
}
if (wc.inject.indexOf("参照稿") < 0 || wc.inject.indexOf("实事求是") < 0) {
  console.error("FAIL reference", wc);
  process.exit(1);
}
if (wc.inject.indexOf("旧稿对照") < 0 || wc.inject.indexOf("重合") < 0) {
  console.error("FAIL compare", wc);
  process.exit(1);
}
if (wc.inject.indexOf("据实写数") >= 0) {
  console.error("FAIL manual should not inject locally", wc);
  process.exit(1);
}
const listed = gwWs.listProjectFiles(md);
if (!listed.templates || !listed.templates.length) {
  console.error("FAIL list templates", listed);
  process.exit(1);
}
const del = gwWs.deleteProjectMd(md, land.path);
if (!del.ok) {
  console.error("FAIL delete", del);
  process.exit(1);
}
console.log("WRITE CTX PASS");
