const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

/** @type {vscode.OutputChannel|undefined} */
let channel;
/** @type {string|undefined} */
let filePath;
/** @type {string|undefined} 当前工程 .gongwen/logs 下的日志 */
let projectFilePath;
/** @type {string|undefined} */
let projectRootBound;
let seq = 0;

/**
 * @param {vscode.ExtensionContext} context
 */
function init(context) {
  channel = vscode.window.createOutputChannel("公文 MD");
  const dir = path.join(context.extensionPath, "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  filePath = path.join(dir, `gongwen-${day}.log`);
  info("activate", {
    extensionPath: context.extensionPath,
    logFile: filePath,
    vscode: vscode.version,
  });
  return channel;
}

function dayStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 绑定当前打开 md 所在工程：日志写入「工程根/.gongwen/logs/」。
 * @param {string} mdPath
 * @param {(p:string)=>string} [resolveRoot]
 */
function bindProject(mdPath, resolveRoot) {
  try {
    const abs = path.resolve(String(mdPath || ""));
    if (!abs) return;
    let root = abs;
    if (typeof resolveRoot === "function") {
      root = path.resolve(resolveRoot(abs));
    } else {
      root = path.dirname(abs);
    }
    if (projectRootBound === root && projectFilePath) return;
    const dir = path.join(root, ".gongwen", "logs");
    fs.mkdirSync(dir, { recursive: true });
    projectRootBound = root;
    projectFilePath = path.join(dir, `gongwen-${dayStamp()}.log`);
    info("log.bindProject", { root, projectLog: projectFilePath });
  } catch (e) {
    warn("log.bindProject.fail", {
      message: String(e && e.message ? e.message : e),
      mdPath: String(mdPath || ""),
    });
  }
}

function levelEnabled(level) {
  try {
    const cfg = vscode.workspace.getConfiguration("gongwen");
    const want = String(cfg.get("logLevel") || "info").toLowerCase();
    const order = { error: 0, warn: 1, info: 2, debug: 3 };
    return (order[level] ?? 2) <= (order[want] ?? 2);
  } catch (_) {
    return true;
  }
}

/**
 * @param {"error"|"warn"|"info"|"debug"} level
 * @param {string} event
 * @param {Record<string, unknown>} [data]
 */
function write(level, event, data) {
  if (!levelEnabled(level)) return;
  seq += 1;
  const ts = new Date().toISOString();
  const payload = data && Object.keys(data).length ? " " + safeJson(data) : "";
  const line = `[${ts}] #${seq} ${level.toUpperCase()} ${event}${payload}`;
  try {
    if (channel) channel.appendLine(line);
  } catch (_) {
    /* ignore */
  }
  appendLine(filePath, line);
  appendLine(projectFilePath, line);
  if (level === "error") {
    console.error("[gongwen]", event, data || "");
  } else if (level === "debug") {
    console.debug("[gongwen]", event, data || "");
  } else {
    console.log("[gongwen]", event, data || "");
  }
}

/** @param {string|undefined} fp @param {string} line */
function appendLine(fp, line) {
  if (!fp) return;
  try {
    fs.appendFileSync(fp, line + "\n", "utf8");
  } catch (_) {
    /* ignore */
  }
}

/** @param {unknown} v */
function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

function info(event, data) {
  write("info", event, data);
}
function warn(event, data) {
  write("warn", event, data);
}
function error(event, data) {
  write("error", event, data);
}
function debug(event, data) {
  write("debug", event, data);
}

function show() {
  if (channel) channel.show(true);
}

function getLogFile() {
  return projectFilePath || filePath;
}

function getProjectLogFile() {
  return projectFilePath;
}

module.exports = {
  init,
  bindProject,
  info,
  warn,
  error,
  debug,
  show,
  getLogFile,
  getProjectLogFile,
};
