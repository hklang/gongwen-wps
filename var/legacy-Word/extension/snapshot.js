const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const log = require("./log");

/** @param {string} mdPath */
function snapDirFor(mdPath) {
  return path.join(path.dirname(mdPath), "快照");
}

/** @param {number} n */
function pad2(n) {
  return n < 10 ? "0" + n : String(n);
}

function stamp() {
  const d = new Date();
  return (
    d.getFullYear() +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    "_" +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

/**
 * @param {string} mdPath
 * @param {number} keep
 * @returns {Promise<string|undefined>}
 */
async function writeSnapshot(mdPath, keep) {
  try {
    if (!fs.existsSync(mdPath)) {
      log.warn("snapshot.missingSource", { path: mdPath });
      return undefined;
    }
    const dir = snapDirFor(mdPath);
    fs.mkdirSync(dir, { recursive: true });
    let dst = path.join(dir, `快照_${stamp()}.md`);
    let i = 2;
    while (fs.existsSync(dst)) {
      dst = path.join(dir, `快照_${stamp()}_${i}.md`);
      i += 1;
    }
    await fs.promises.copyFile(mdPath, dst);
    const st = await fs.promises.stat(dst);

    const keepN = Math.max(5, Math.min(100, keep || 20));
    const names = (await fs.promises.readdir(dir))
      .filter((f) => f.startsWith("快照_") && f.endsWith(".md"))
      .sort();
    const overflow = names.slice(0, Math.max(0, names.length - keepN));
    for (const f of overflow) {
      try {
        await fs.promises.unlink(path.join(dir, f));
        log.debug("snapshot.prune", { file: f });
      } catch (e) {
        log.warn("snapshot.pruneFail", { file: f, message: String(e) });
      }
    }
    log.info("snapshot.written", {
      source: mdPath,
      snap: dst,
      bytes: st.size,
      keep: keepN,
      total: names.length - overflow.length + 1,
    });
    return dst;
  } catch (e) {
    log.error("snapshot.fail", {
      path: mdPath,
      message: String(e && e.message ? e.message : e),
    });
    return undefined;
  }
}

/** @param {string} mdPath */
async function revealSnapDir(mdPath) {
  const dir = snapDirFor(mdPath);
  fs.mkdirSync(dir, { recursive: true });
  log.info("snapshot.reveal", { dir });
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
}

module.exports = { snapDirFor, writeSnapshot, revealSnapDir };
