/**
 * 本机工作区文件沙箱（仅扩展宿主）。
 * 对话/改稿的读写一律走 vscode.workspace.fs / WorkspaceEdit；
 * 云中转不得调用本模块，也不得持有写盘权限。
 */
const vscode = require("vscode");
const path = require("path");
const gwWs = require("./gongwenWorkspace");

function workspaceFolders() {
  return vscode.workspace.workspaceFolders || [];
}

function rootFor(mdPath) {
  return gwWs.resolveRoot(mdPath, workspaceFolders());
}

/** 目标是否在 root 内（防 .. 与盘符逃逸） */
function isInside(root, targetPath) {
  const r = path.resolve(root);
  const t = path.resolve(targetPath);
  const rKey = process.platform === "win32" ? r.toLowerCase() : r;
  const tKey = process.platform === "win32" ? t.toLowerCase() : t;
  if (rKey === tKey) return true;
  const rel = path.relative(r, t);
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * @param {string} mdAnchor 当前打开的 md（用于定位工作区根）
 * @param {string} targetPath 拟读/写路径
 * @param {{ mdOnly?: boolean }} [opts]
 * @returns {string} root
 */
function assertInWorkspace(mdAnchor, targetPath, opts) {
  const root = rootFor(mdAnchor || targetPath);
  if (!isInside(root, targetPath)) {
    throw new Error("禁止访问工作区外路径");
  }
  if (opts && opts.mdOnly) {
    if (path.extname(targetPath).toLowerCase() !== ".md") {
      throw new Error("工作区内对话仅允许操作 .md 文件");
    }
  }
  return root;
}

function asUri(p) {
  return typeof p === "string" ? vscode.Uri.file(path.resolve(p)) : p;
}

async function exists(p) {
  try {
    await vscode.workspace.fs.stat(asUri(p));
    return true;
  } catch (_) {
    return false;
  }
}

async function readText(p) {
  const buf = await vscode.workspace.fs.readFile(asUri(p));
  return Buffer.from(buf).toString("utf8");
}

async function writeText(p, text) {
  const uri = asUri(p);
  const dir = path.dirname(uri.fsPath);
  try {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
  } catch (_) { /* 已存在 */ }
  await vscode.workspace.fs.writeFile(
    uri,
    Buffer.from(String(text == null ? "" : text), "utf8")
  );
}

async function renameFile(oldPath, newPath) {
  const we = new vscode.WorkspaceEdit();
  we.renameFile(asUri(oldPath), asUri(newPath), { overwrite: false });
  const ok = await vscode.workspace.applyEdit(we);
  if (!ok) throw new Error("重命名失败");
}

/**
 * 对话侧创建 md：必须落在工作区内。
 * @param {string} mdAnchor
 * @param {string} targetPath
 * @param {string} text
 */
async function createMdInWorkspace(mdAnchor, targetPath, text) {
  let p = path.resolve(targetPath);
  if (path.extname(p).toLowerCase() !== ".md") p += ".md";
  assertInWorkspace(mdAnchor, p, { mdOnly: true });
  if (await exists(p)) throw new Error("目标已存在：" + path.basename(p));
  await writeText(p, text);
  return p;
}

module.exports = {
  rootFor,
  isInside,
  assertInWorkspace,
  exists,
  readText,
  writeText,
  renameFile,
  createMdInWorkspace,
  workspaceFolders,
};
