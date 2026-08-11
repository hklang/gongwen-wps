/**
 * 本机语料：旧稿段落重合（防重复），不上云。
 */
const fs = require("fs");
const path = require("path");

function paragraphs(md) {
  return String(md || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.replace(/\s+/g, "").length >= 20);
}

function norm(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[，。；、：:·\-—_（）()【】\[\]"""'']/g, "");
}

/**
 * @returns {{ hits: { excerpt: string, reason: string }[], comparePath: string }}
 */
function compareDrafts(currentMd, compareAbs, compareRel) {
  const rel = String(compareRel || "").replace(/\\/g, "/");
  if (!compareAbs || !fs.existsSync(compareAbs)) {
    return {
      hits: [],
      comparePath: rel,
      missing: true,
    };
  }
  const oldRaw = fs.readFileSync(compareAbs, "utf8");
  const curParas = paragraphs(currentMd);
  const oldParas = paragraphs(oldRaw);
  const curBlob = norm(currentMd);
  const hits = [];
  const seen = new Set();
  for (const op of oldParas) {
    const n = norm(op);
    if (n.length < 20 || seen.has(n)) continue;
    let hit = false;
    let reason = "";
    if (curBlob.indexOf(n) >= 0) {
      hit = true;
      reason = "与旧稿段落高度重合";
    } else {
      for (const cp of curParas) {
        const cn = norm(cp);
        if (cn.length < 20) continue;
        if (cn.indexOf(n) >= 0 || n.indexOf(cn) >= 0) {
          hit = true;
          reason = "与当前稿某段交叉重合";
          break;
        }
      }
    }
    if (hit) {
      seen.add(n);
      hits.push({
        excerpt: op.replace(/\s+/g, " ").trim().slice(0, 120),
        reason,
      });
    }
    if (hits.length >= 8) break;
  }
  return { hits, comparePath: rel, missing: false };
}

function formatCompareInject(result) {
  if (!result || result.missing) {
    return (
      "【旧稿对照】" +
      (result && result.comparePath ? result.comparePath : "") +
      "\n（对照文件不存在，请重新选择）"
    );
  }
  if (!result.hits.length) {
    return (
      "【旧稿对照】" +
      result.comparePath +
      "\n未发现明显重合段落；仍须避免套话照搬。"
    );
  }
  const lines = result.hits.map(
    (h, i) => (i + 1) + ". (" + h.reason + ") " + h.excerpt
  );
  return (
    "【旧稿对照 · 疑似重复】" +
    result.comparePath +
    "\n请改写下列撞车处，勿整段照搬：\n" +
    lines.join("\n")
  );
}

function resolveAbs(root, rel) {
  const r = String(rel || "")
    .trim()
    .replace(/\\/g, "/");
  if (!r || !root) return "";
  return path.join(path.resolve(root), r.replace(/\//g, path.sep));
}

module.exports = {
  paragraphs,
  compareDrafts,
  formatCompareInject,
  resolveAbs,
};
