/**
 * 素材/模板索引：落盘 .gongwen/materials-index.json
 * 索引只服务选型；写数必须走 read_file 现抽。
 */
(function (global) {
  var INDEX_REL = ".gongwen/materials-index.json";
  var SUMMARY_CHARS = 500;
  var SUMMARY_CHARS_TPL = 350;

  function emptyIndex(root) {
    return {
      version: 1,
      root: root || "",
      updatedAt: "",
      files: []
    };
  }

  function load() {
    if (!global.GwProject) return emptyIndex("");
    var root = GwProject.getRoot();
    if (!root) return emptyIndex("");
    var abs = GwProject.joinRoot(root, INDEX_REL);
    try {
      if (!GwProject.fsExists(abs)) return emptyIndex(root);
      var raw = GwProject.fsReadText(abs);
      if (!raw) return emptyIndex(root);
      var obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.files)) return emptyIndex(root);
      obj.root = root;
      return obj;
    } catch (e) {
      return emptyIndex(root);
    }
  }

  function save(idx) {
    if (!global.GwProject) return { ok: false, error: "无 GwProject" };
    var root = GwProject.getRoot();
    if (!root) return { ok: false, error: "无工程根" };
    GwProject.ensureProjectLayout(root);
    var payload = {
      version: 1,
      root: root,
      updatedAt: new Date().toISOString(),
      files: (idx && idx.files) || []
    };
    var abs = GwProject.joinRoot(root, INDEX_REL);
    var ok = GwProject.fsWriteText(abs, JSON.stringify(payload, null, 2));
    return ok
      ? { ok: true, count: payload.files.length, updatedAt: payload.updatedAt }
      : { ok: false, error: "写入索引失败" };
  }

  function makeSummary(text, lim) {
    var t = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    var n = lim || SUMMARY_CHARS;
    if (t.length <= n) return t;
    return t.slice(0, n) + "…";
  }

  function buildEntry(it, zone) {
    var rel = GwProject.normRel(it.path);
    var st = GwProject.absStatRel(rel) || {
      size: it.size || 0,
      mtime: it.mtime || 0
    };
    var entry = {
      rel: rel,
      title: it.title || GwProject.titleOf(GwProject.baseName(rel)),
      ext: (/\.[^.]+$/.exec(rel) || [""])[0].toLowerCase(),
      zone: zone,
      size: st.size || 0,
      mtime: st.mtime || 0,
      summary: "",
      summaryChars: 0,
      ok: false,
      error: ""
    };
    var rd = GwProject.readTextRel(rel);
    if (!rd.ok) {
      entry.error = rd.error || "读失败";
      return entry;
    }
    var lim = zone === "templates" ? SUMMARY_CHARS_TPL : SUMMARY_CHARS;
    entry.summary = makeSummary(rd.text, lim);
    entry.summaryChars = entry.summary.length;
    entry.ok = true;
    return entry;
  }

  function collectListed() {
    var listed = GwProject.listProjectFiles();
    if (!listed.ok) return { ok: false, error: "无法列出工程文件", items: [] };
    var items = [];
    (listed.materials || []).forEach(function (it) {
      items.push({ it: it, zone: "materials" });
    });
    (listed.templates || []).forEach(function (it) {
      items.push({ it: it, zone: "templates" });
    });
    return { ok: true, items: items, listed: listed };
  }

  function rebuildFull(onProgress) {
    var root = GwProject.getRoot();
    if (!root) return { ok: false, error: "无工程根" };
    var col = collectListed();
    if (!col.ok) return col;
    var files = [];
    for (var i = 0; i < col.items.length; i++) {
      var row = col.items[i];
      if (onProgress) {
        try {
          onProgress({
            phase: "full",
            current: i + 1,
            total: col.items.length,
            path: row.it.path
          });
        } catch (eP) {}
      }
      files.push(buildEntry(row.it, row.zone));
    }
    var saved = save({ version: 1, root: root, files: files });
    if (!saved.ok) return saved;
    return {
      ok: true,
      mode: "full",
      count: files.length,
      okCount: files.filter(function (f) {
        return f.ok;
      }).length,
      updatedAt: saved.updatedAt
    };
  }

  function syncIncremental(onProgress) {
    var root = GwProject.getRoot();
    if (!root) return { ok: false, error: "无工程根" };
    var prev = load();
    if (!prev.files || !prev.files.length) return rebuildFull(onProgress);
    var map = {};
    prev.files.forEach(function (f) {
      map[f.rel] = f;
    });
    var col = collectListed();
    if (!col.ok) return col;
    var files = [];
    var changed = 0;
    for (var i = 0; i < col.items.length; i++) {
      var row = col.items[i];
      var rel = GwProject.normRel(row.it.path);
      var st = GwProject.absStatRel(rel) || {
        size: row.it.size || 0,
        mtime: row.it.mtime || 0
      };
      var old = map[rel];
      var need =
        !old ||
        !old.ok ||
        Number(old.mtime) !== Number(st.mtime) ||
        Number(old.size) !== Number(st.size);
      if (onProgress) {
        try {
          onProgress({
            phase: "incr",
            current: i + 1,
            total: col.items.length,
            path: rel,
            changed: need
          });
        } catch (eP2) {}
      }
      if (need) {
        changed += 1;
        files.push(buildEntry(row.it, row.zone));
      } else {
        files.push(old);
      }
    }
    var saved = save({ version: 1, root: root, files: files });
    if (!saved.ok) return saved;
    return {
      ok: true,
      mode: "incr",
      count: files.length,
      changed: changed,
      okCount: files.filter(function (f) {
        return f.ok;
      }).length,
      updatedAt: saved.updatedAt
    };
  }

  function workspaceForAi() {
    var idx = load();
    var root = GwProject.getRoot() || "";
    var catalog = [];
    var materials = [];
    var templates = [];
    (idx.files || []).forEach(function (f) {
      var item = {
        path: f.rel,
        title: f.title,
        zone: f.zone,
        bytes: f.size,
        summary: f.summary || "",
        mtime: f.mtime,
        ok: !!f.ok
      };
      catalog.push({
        path: f.rel,
        title: f.title,
        zone: f.zone,
        bytes: f.size
      });
      if (f.zone === "materials") materials.push(item);
      if (f.zone === "templates") templates.push(item);
    });
    return {
      name: GwProject.getName() || "",
      root: root,
      catalog: catalog,
      materials: materials,
      templates: templates,
      files: catalog
    };
  }

  global.GwMaterialIndex = {
    INDEX_REL: INDEX_REL,
    load: load,
    save: save,
    rebuildFull: rebuildFull,
    syncIncremental: syncIncremental,
    workspaceForAi: workspaceForAi
  };
})(window);
