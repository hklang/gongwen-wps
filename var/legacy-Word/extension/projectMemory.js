/**
 * 工程长期记忆：.gongwen/memory.md（本机；换会话仍带）。
 */
const fs = require("fs");
const path = require("path");
const gwWs = require("./gongwenWorkspace");

const MEMORY_REL = path.join(".gongwen", "memory.md");
const MAX_INJECT = 1500;

function memoryPath(root) {
  return path.join(path.resolve(root), MEMORY_REL);
}

function ensureFile(root) {
  const fp = memoryPath(root);
  const dir = path.dirname(fp);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(fp)) {
    fs.writeFileSync(
      fp,
      "# 工程记忆\n\n> 写稿约定、通知要点、已定框架。换会话仍会带给模型。\n\n",
      "utf8"
    );
  }
  return fp;
}

function readMemory(mdPath, folders) {
  const root = gwWs.resolveRoot(mdPath, folders);
  const fp = memoryPath(root);
  if (!fs.existsSync(fp)) {
    return { ok: true, path: MEMORY_REL.replace(/\\/g, "/"), text: "", inject: "" };
  }
  const text = fs.readFileSync(fp, "utf8");
  const inject = text.trim().slice(0, MAX_INJECT);
  return {
    ok: true,
    path: MEMORY_REL.replace(/\\/g, "/"),
    text,
    inject,
  };
}

function writeMemory(mdPath, folders, text) {
  const root = gwWs.resolveRoot(mdPath, folders);
  const fp = ensureFile(root);
  fs.writeFileSync(fp, String(text || ""), "utf8");
  return { ok: true, path: MEMORY_REL.replace(/\\/g, "/") };
}

function appendMemory(mdPath, folders, note) {
  const body = String(note || "").trim();
  if (!body) return { ok: false, error: "内容为空" };
  const root = gwWs.resolveRoot(mdPath, folders);
  const fp = ensureFile(root);
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, "").replace("T", " ");
  const block = "\n## " + stamp + "\n\n" + body + "\n";
  fs.appendFileSync(fp, block, "utf8");
  return { ok: true, path: MEMORY_REL.replace(/\\/g, "/") };
}

/** Keep 框架后：从 md 抽 ## 标题写入记忆 */
function appendScaffoldMemory(mdPath, folders, md, summary) {
  const text = String(md || "");
  const heads = [];
  text.split(/\n/).forEach((line) => {
    const m = line.trim().match(/^##\s+(.+)$/);
    if (m && heads.indexOf(m[1].trim()) < 0) heads.push(m[1].trim());
  });
  if (!heads.length && !summary) return { ok: true, skipped: true };
  const bits = [];
  if (summary) bits.push(String(summary).trim());
  if (heads.length) bits.push("已定框架章节：" + heads.slice(0, 12).join("；"));
  return appendMemory(mdPath, folders, bits.join("\n"));
}

/** 读到通知类文件后记一行要点（截前几行） */
function appendNoticeRead(mdPath, folders, relPath, content) {
  const rel = String(relPath || "").trim();
  if (!rel || !/通知|要求|提纲/.test(rel)) return { ok: true, skipped: true };
  const lines = String(content || "")
    .split(/\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!lines.length) return { ok: true, skipped: true };
  return appendMemory(
    mdPath,
    folders,
    "已读「" + rel + "」要点：\n- " + lines.join("\n- ")
  );
}

module.exports = {
  readMemory,
  writeMemory,
  appendMemory,
  appendScaffoldMemory,
  appendNoticeRead,
  MAX_INJECT,
};
