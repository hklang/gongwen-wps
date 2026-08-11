/**
 * 工程聊天历史（本机 .gongwen/chats/）。云端不存。
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const gwWs = require("./gongwenWorkspace");

const CHATS_DIR = "chats";
const INDEX_FILE = "index.json";

function chatsDir(root) {
  const dir = path.join(path.resolve(root), ".gongwen", CHATS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function indexPath(root) {
  return path.join(chatsDir(root), INDEX_FILE);
}

function sessionPath(root, sid) {
  const safe = String(sid || "").replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(chatsDir(root), "session-" + safe + ".json");
}

function readJson(fp) {
  if (!fs.existsSync(fp)) return null;
  try {
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch (_) {
    return null;
  }
}

function writeJson(fp, data) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, fp);
}

function loadIndex(root) {
  const data = readJson(indexPath(root));
  if (data && typeof data === "object" && Array.isArray(data.sessions)) return data;
  return { version: 1, activeId: "", sessions: [] };
}

function saveIndex(root, index) {
  index.version = 1;
  index.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, "");
  writeJson(indexPath(root), index);
}

function rootOf(mdPath, folders) {
  return gwWs.resolveRoot(mdPath, folders);
}

function newSession(mdPath, folders, title) {
  const root = rootOf(mdPath, folders);
  gwWs.ensureDir(root);
  const sid = crypto.randomBytes(6).toString("hex");
  const now = new Date().toISOString().replace(/\.\d+Z$/, "");
  const cur = path.relative(root, path.resolve(mdPath)).split(path.sep).join("/");
  const payload = {
    id: sid,
    title: String(title || "新会话").trim() || "新会话",
    createdAt: now,
    updatedAt: now,
    docPath: cur,
    messages: [],
  };
  writeJson(sessionPath(root, sid), payload);
  const idx = loadIndex(root);
  const sessions = (idx.sessions || []).filter((s) => s.id !== sid);
  sessions.unshift({
    id: sid,
    title: payload.title,
    updatedAt: now,
    docPath: cur,
  });
  idx.sessions = sessions.slice(0, 30);
  idx.activeId = sid;
  saveIndex(root, idx);
  return { ok: true, id: sid, title: payload.title, messages: [], docPath: cur };
}

function loadActive(mdPath, folders) {
  const root = rootOf(mdPath, folders);
  gwWs.ensureDir(root);
  const idx = loadIndex(root);
  const sid = String(idx.activeId || "").trim();
  if (!sid || !fs.existsSync(sessionPath(root, sid))) {
    return newSession(mdPath, folders, "默认会话");
  }
  const data = readJson(sessionPath(root, sid)) || {};
  return {
    ok: true,
    id: sid,
    title: data.title || "会话",
    messages: Array.isArray(data.messages) ? data.messages : [],
    docPath: data.docPath || "",
    summary: data.summary || "",
    readSet: Array.isArray(data.readSet) ? data.readSet : [],
  };
}

function listSessions(mdPath, folders) {
  const root = rootOf(mdPath, folders);
  gwWs.ensureDir(root);
  const idx = loadIndex(root);
  return { ok: true, activeId: idx.activeId || "", sessions: idx.sessions || [] };
}

function saveSession(mdPath, folders, sessionId, messages, title, meta) {
  const root = rootOf(mdPath, folders);
  gwWs.ensureDir(root);
  const sid = String(sessionId || "").trim();
  if (!sid) return { ok: false, error: "缺少会话 id" };
  const now = new Date().toISOString().replace(/\.\d+Z$/, "");
  const cur = path.relative(root, path.resolve(mdPath)).split(path.sep).join("/");
  const prev = readJson(sessionPath(root, sid)) || {};
  let titleFinal = String(title || prev.title || "").trim();
  if (!titleFinal && Array.isArray(messages)) {
    for (const m of messages) {
      if (m && m.role === "user" && m.content) {
        titleFinal = String(m.content).slice(0, 40);
        break;
      }
    }
  }
  if (!titleFinal) titleFinal = "会话";
  const clean = [];
  for (const m of messages || []) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = String(m.content || "").trim();
    if (!content) continue;
    // 不把「正在读取」类系统噪声当正文长期堆（短日志可留）
    if (m.role === "assistant" && /^（正在读取/.test(content)) continue;
    clean.push({ role: m.role, content: content.slice(0, 20000) });
  }
  const m = meta && typeof meta === "object" ? meta : {};
  let compact;
  try {
    const mt = require("./materialTools");
    compact = mt.maybeCompactSummary(
      clean,
      m.summary != null ? m.summary : prev.summary,
      m.readSet != null ? m.readSet : prev.readSet
    );
  } catch (_) {
    compact = {
      summary: String(m.summary != null ? m.summary : prev.summary || ""),
      readSet: Array.isArray(m.readSet)
        ? m.readSet
        : Array.isArray(prev.readSet)
          ? prev.readSet
          : [],
    };
  }
  const payload = {
    id: sid,
    title: titleFinal,
    createdAt: prev.createdAt || now,
    updatedAt: now,
    docPath: cur,
    messages: clean.slice(-80),
    summary: compact.summary || "",
    readSet: compact.readSet || [],
  };
  writeJson(sessionPath(root, sid), payload);
  const idx = loadIndex(root);
  const others = (idx.sessions || []).filter((s) => s.id !== sid);
  others.unshift({
    id: sid,
    title: titleFinal,
    updatedAt: now,
    docPath: cur,
  });
  idx.sessions = others.slice(0, 30);
  idx.activeId = sid;
  saveIndex(root, idx);
  return { ok: true, id: sid, title: titleFinal };
}

function switchSession(mdPath, folders, sessionId) {
  const root = rootOf(mdPath, folders);
  const sid = String(sessionId || "").trim();
  const fp = sessionPath(root, sid);
  if (!sid || !fs.existsSync(fp)) return { ok: false, error: "会话不存在" };
  const data = readJson(fp) || {};
  const idx = loadIndex(root);
  idx.activeId = sid;
  saveIndex(root, idx);
  return {
    ok: true,
    id: sid,
    title: data.title || "会话",
    messages: Array.isArray(data.messages) ? data.messages : [],
    docPath: data.docPath || "",
    summary: data.summary || "",
    readSet: Array.isArray(data.readSet) ? data.readSet : [],
  };
}

module.exports = {
  loadActive,
  listSessions,
  saveSession,
  newSession,
  switchSession,
};
