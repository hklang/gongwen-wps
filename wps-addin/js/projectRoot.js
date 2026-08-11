/**
 * 公文工程根：默认=当前打开文档所在目录，并自动创建 素材/模板/版本。
 * 「绑定」可改绑其它文件夹（手动覆盖，直到下次跟当前文档同步策略变更）。
 */
(function (global) {
  var ROOT_KEY = "gongwen.projectRoot";
  var NAME_KEY = "gongwen.projectName";
  var MANUAL_KEY = "gongwen.projectRootManual";
  var INDEX_KEY = "gongwen.projectIndex";
  var CITE_KEY = "gongwen.citePaths";
  var MATERIAL_DIR = "素材";
  var TEMPLATE_DIR = "模板";
  var VERSION_DIR = "版本";
  var META_DIR = ".gongwen";
  var LIST_RE = /\.docx?$/i;
  var OFFICE_RE = /\.docx?$/i;

  function storeGet(k) {
    try {
      if (global.GwRelay && GwRelay.storeGet) return GwRelay.storeGet(k) || "";
    } catch (e) {}
    try {
      return localStorage.getItem(k) || "";
    } catch (e2) {
      return "";
    }
  }

  function storeSet(k, v) {
    try {
      if (global.GwRelay && GwRelay.storeSet) {
        GwRelay.storeSet(k, v);
        return;
      }
    } catch (e) {}
    try {
      localStorage.setItem(k, String(v == null ? "" : v));
    } catch (e2) {}
  }

  function normSlash(p) {
    return String(p || "").replace(/\//g, "\\");
  }

  function normRel(rel) {
    return String(rel || "")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/^\/+/, "")
      .trim();
  }

  function joinRoot(root, rel) {
    var r = String(root || "").replace(/[\\\/]+$/, "");
    var p = normRel(rel).replace(/\//g, "\\");
    return p ? r + "\\" + p : r;
  }

  function baseName(p) {
    var s = normRel(p);
    var i = s.lastIndexOf("/");
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function titleOf(name) {
    return String(name || "").replace(/\.docx?$/i, "");
  }

  function getFso() {
    try {
      if (typeof ActiveXObject !== "undefined") {
        return new ActiveXObject("Scripting.FileSystemObject");
      }
    } catch (e) {}
    try {
      if (global.Application && Application.FileSystemObject) {
        return Application.FileSystemObject;
      }
    } catch (e2) {}
    return null;
  }

  /** WPS JS 原生磁盘 API（ShowDialog/TaskPane 里通常有，FSO 往往没有） */
  function getWpsFs() {
    try {
      if (global.Application && Application.FileSystem) return Application.FileSystem;
    } catch (e) {}
    try {
      if (global.wps && wps.FileSystem) return wps.FileSystem;
    } catch (e2) {}
    return null;
  }

  function hasDiskApi() {
    return !!(getWpsFs() || getFso());
  }

  function fsExists(abs) {
    var p = normSlash(abs);
    var fs = getWpsFs();
    if (fs) {
      try {
        if (typeof fs.existsSync === "function") return !!fs.existsSync(p);
        if (typeof fs.Exists === "function") return !!fs.Exists(p);
      } catch (e) {}
    }
    var fso = getFso();
    if (fso) {
      try {
        return !!(fso.FolderExists(p) || fso.FileExists(p));
      } catch (e2) {}
    }
    return false;
  }

  function fsMkdir(abs) {
    var p = normSlash(abs);
    if (fsExists(p)) return true;
    var fs = getWpsFs();
    if (fs) {
      try {
        if (typeof fs.mkdirSync === "function") {
          fs.mkdirSync(p);
          return true;
        }
        if (typeof fs.CreateFolder === "function") {
          fs.CreateFolder(p);
          return true;
        }
      } catch (e) {}
    }
    var fso = getFso();
    if (fso) {
      try {
        fso.CreateFolder(p);
        return true;
      } catch (e2) {}
    }
    return false;
  }

  function fsWriteText(abs, text) {
    var p = normSlash(abs);
    var fs = getWpsFs();
    if (fs) {
      try {
        if (typeof fs.WriteFile === "function") {
          fs.WriteFile(p, String(text || ""));
          return true;
        }
        if (typeof fs.writeFileString === "function") {
          fs.writeFileString(p, String(text || ""));
          return true;
        }
        if (typeof fs.writeFileSync === "function") {
          fs.writeFileSync(p, String(text || ""));
          return true;
        }
      } catch (e) {}
    }
    var fso = getFso();
    if (fso) {
      try {
        var ts = fso.CreateTextFile(p, true);
        ts.Write(String(text || ""));
        ts.Close();
        return true;
      } catch (e2) {}
    }
    return false;
  }

  function fsReadText(abs) {
    var p = normSlash(abs);
    var fs = getWpsFs();
    if (fs) {
      try {
        if (typeof fs.ReadFile === "function") return String(fs.ReadFile(p) || "");
        if (typeof fs.readFileString === "function")
          return String(fs.readFileString(p) || "");
        if (typeof fs.readFileSync === "function")
          return String(fs.readFileSync(p) || "");
      } catch (e) {}
    }
    var fso = getFso();
    if (fso) {
      try {
        if (!fso.FileExists(p)) return null;
        var ts = fso.OpenTextFile(p, 1, false, -2);
        var text = ts.ReadAll();
        ts.Close();
        return String(text || "");
      } catch (e2) {}
    }
    return null;
  }

  function fsRemoveFile(abs) {
    var p = normSlash(abs);
    var fs = getWpsFs();
    if (fs) {
      try {
        if (typeof fs.Remove === "function") {
          fs.Remove(p);
          return true;
        }
        if (typeof fs.unlinkSync === "function") {
          fs.unlinkSync(p);
          return true;
        }
        if (typeof fs.DeleteFile === "function") {
          fs.DeleteFile(p);
          return true;
        }
      } catch (e) {}
    }
    var fso = getFso();
    if (fso) {
      try {
        fso.DeleteFile(p);
        return true;
      } catch (e2) {}
    }
    return false;
  }

  function fsReaddirNames(absDir) {
    var p = normSlash(absDir);
    var fs = getWpsFs();
    if (fs && typeof fs.readdirSync === "function") {
      try {
        var arr = fs.readdirSync(p);
        if (!arr) return [];
        if (typeof arr.length === "number") {
          var out = [];
          for (var i = 0; i < arr.length; i++) {
            var ent = arr[i];
            if (ent == null) continue;
            if (typeof ent === "string") out.push(ent);
            else if (ent.name) out.push(String(ent.name));
            else if (ent.Name) out.push(String(ent.Name));
            else out.push(String(ent));
          }
          return out;
        }
      } catch (e) {}
    }
    var fso = getFso();
    if (fso) {
      try {
        if (!fso.FolderExists(p)) return [];
        var folder = fso.GetFolder(p);
        var names = [];
        if (typeof Enumerator !== "undefined") {
          var files = new Enumerator(folder.Files);
          for (; !files.atEnd(); files.moveNext()) {
            names.push(String(files.item().Name || ""));
          }
        } else {
          var col = folder.Files;
          var n = Number(col.Count) || 0;
          for (var j = 1; j <= n; j++) {
            try {
              names.push(String(col.Item(j).Name || ""));
            } catch (eItem) {}
          }
        }
        return names;
      } catch (e2) {}
    }
    return null;
  }

  function getRoot() {
    return String(storeGet(ROOT_KEY) || "").replace(/[\\\/]+$/, "");
  }

  function getName() {
    var n = storeGet(NAME_KEY);
    if (n) return n;
    var root = getRoot();
    return root ? baseName(root.replace(/\\/g, "/")) : "";
  }

  function setRoot(absPath, name, manual) {
    var root = String(absPath || "").replace(/[\\\/]+$/, "");
    storeSet(ROOT_KEY, root);
    storeSet(NAME_KEY, name || baseName(root.replace(/\\/g, "/")));
    storeSet(MANUAL_KEY, manual ? "1" : "");
    ensureProjectLayout(root);
    return root;
  }

  function clearRoot() {
    storeSet(ROOT_KEY, "");
    storeSet(NAME_KEY, "");
    storeSet(MANUAL_KEY, "");
  }

  function isManualRoot() {
    return storeGet(MANUAL_KEY) === "1";
  }

  /** 当前打开文档所在文件夹；未保存则空 */
  function activeDocumentFolder() {
    try {
      var app = global.Application;
      if (!app || !app.ActiveDocument) return "";
      var doc = app.ActiveDocument;
      var path = "";
      try {
        path = String(doc.Path || "").trim();
      } catch (e1) {}
      if (!path) {
        try {
          var full = String(doc.FullName || "").trim();
          if (full && /[\\\/]/.test(full)) {
            path = full.replace(/[\\\/][^\\\/]+$/, "");
          }
        } catch (e2) {}
      }
      return String(path || "").replace(/[\\\/]+$/, "");
    } catch (e) {
      return "";
    }
  }

  function ensureProjectLayout(root) {
    if (!root) return { ok: false, error: "无根路径" };
    if (!hasDiskApi()) return { ok: false, error: "无磁盘 API（FileSystem/FSO）" };
    try {
      if (!fsExists(root)) return { ok: false, error: "目录不存在" };
      [MATERIAL_DIR, TEMPLATE_DIR, VERSION_DIR, META_DIR].forEach(function (sub) {
        fsMkdir(joinRoot(root, sub));
      });
      try {
        var meta = joinRoot(root, META_DIR + "\\wps.json");
        if (!fsExists(meta)) {
          fsWriteText(
            meta,
            JSON.stringify({
              version: 1,
              name: getName() || baseName(root.replace(/\\/g, "/")),
              root: root
            })
          );
        }
      } catch (eMeta) {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /** 若当前在 素材/模板/版本/.gongwen 内，上抬到工程根 */
  function liftToProjectRoot(dir) {
    var d = String(dir || "").replace(/[\\\/]+$/, "");
    if (!d) return "";
    var leaf = baseName(d.replace(/\\/g, "/"));
    if (
      leaf === MATERIAL_DIR ||
      leaf === TEMPLATE_DIR ||
      leaf === VERSION_DIR ||
      leaf === META_DIR
    ) {
      return d.replace(/[\\\/][^\\\/]+$/, "");
    }
    return d;
  }

  function pathUnderRoot(root, abs) {
    if (!root || !abs) return false;
    var r = normSlash(root).replace(/\\+$/, "").toLowerCase() + "\\";
    var a = normSlash(abs).replace(/\\+$/, "").toLowerCase();
    return a === r.slice(0, -1) || a.indexOf(r) === 0;
  }

  /**
   * 解析工程根：默认跟当前文档目录；手动改绑优先；未保存则回退已存根。
   * 打开素材内文件后不得把根改成「…\素材」。
   */
  function resolveRoot() {
    if (isManualRoot()) {
      var man = getRoot();
      if (man) {
        ensureProjectLayout(man);
        return { root: man, source: "manual", name: getName() };
      }
    }
    var stored = getRoot();
    var dir = liftToProjectRoot(activeDocumentFolder());
    if (dir) {
      // 已有工程根，且活动文档仍在该树下 → 保持，避免打开素材后根漂移
      if (stored && pathUnderRoot(stored, dir)) {
        ensureProjectLayout(stored);
        return { root: stored, source: "active", name: getName() };
      }
      if (stored && pathUnderRoot(stored, activeDocumentFolder())) {
        ensureProjectLayout(stored);
        return { root: stored, source: "active", name: getName() };
      }
      setRoot(dir, baseName(dir.replace(/\\/g, "/")), false);
      return { root: dir, source: "active", name: getName() };
    }
    if (stored) {
      ensureProjectLayout(stored);
      return { root: stored, source: "stored", name: getName() };
    }
    return { root: "", source: "none", name: "", unsaved: true };
  }

  /** 打开/读文件：优先沿用已存根，避免 resolve 把根改飞 */
  function absFromRel(rel) {
    var pathRel = normRel(rel);
    if (!pathRel || pathRel.indexOf("..") >= 0) return "";
    var root = getRoot();
    if (!root) {
      root = resolveRoot().root;
    }
    if (!root) return "";
    var abs = joinRoot(root, pathRel);
    if (hasDiskApi() && !fsExists(abs)) {
      var lifted = liftToProjectRoot(activeDocumentFolder());
      if (lifted && lifted !== root) {
        var alt = joinRoot(lifted, pathRel);
        if (fsExists(alt)) return alt;
      }
    }
    return abs;
  }

  function readIndex() {
    try {
      var raw = storeGet(INDEX_KEY);
      var j = raw ? JSON.parse(raw) : null;
      if (j && typeof j === "object") return j;
    } catch (e) {}
    return { materials: [], templates: [], versions: [], docs: [] };
  }

  function writeIndex(idx) {
    try {
      storeSet(INDEX_KEY, JSON.stringify(idx || {}));
    } catch (e) {}
  }

  function pickFolder() {
    var app = global.Application;
    if (!app || typeof app.FileDialog !== "function") {
      return { ok: false, error: "当前环境无 FileDialog" };
    }
    try {
      var dlg = app.FileDialog(4);
      dlg.Title = "改绑公文工程文件夹";
      if (dlg.Show() !== -1) return { ok: false, cancelled: true };
      var path = dlg.SelectedItems.Item(1);
      if (!path) return { ok: false, error: "未选中文件夹" };
      setRoot(path, "", true);
      return { ok: true, root: getRoot(), name: getName(), source: "manual" };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  /** 取消手动改绑，恢复跟随当前文档 */
  function followActiveDocument() {
    storeSet(MANUAL_KEY, "");
    return resolveRoot();
  }

  function listFilesInFolder(absDir, relPrefix, limit) {
    var out = [];
    var max = limit || 40;
    var names = fsReaddirNames(absDir);
    if (!names) return out;
    names = names.slice().sort();
    for (var j = 0; j < names.length && out.length < max; j++) {
      var name = String(names[j] || "");
      if (!LIST_RE.test(name) || name.charAt(0) === ".") continue;
      var rel = normRel((relPrefix ? relPrefix + "/" : "") + name);
      out.push({
        path: rel,
        title: titleOf(name),
        kind: "office"
      });
    }
    return out;
  }

  function listFromDisk(root) {
    if (!hasDiskApi() || !root) return null;
    try {
      if (!fsExists(root)) return null;
      var via = getWpsFs() ? "wpsfs" : "fso";
      return {
        docs: listFilesInFolder(root, "", 30),
        materials: listFilesInFolder(joinRoot(root, MATERIAL_DIR), MATERIAL_DIR, 40),
        templates: listFilesInFolder(joinRoot(root, TEMPLATE_DIR), TEMPLATE_DIR, 40),
        versions: listFilesInFolder(joinRoot(root, VERSION_DIR), VERSION_DIR, 40),
        via: via
      };
    } catch (e) {
      return null;
    }
  }

  function listFromIndex() {
    var idx = readIndex();
    return {
      docs: idx.docs || [],
      materials: idx.materials || [],
      templates: idx.templates || [],
      versions: idx.versions || [],
      via: "index"
    };
  }

  function listProjectFiles() {
    var resolved = resolveRoot();
    var root = resolved.root;
    if (!root) {
      return {
        ok: false,
        unbound: true,
        unsaved: !!resolved.unsaved,
        name: "",
        docs: [],
        materials: [],
        templates: [],
        versions: [],
        source: resolved.source
      };
    }
    var listed = listFromDisk(root) || listFromIndex();
    return {
      ok: true,
      name: resolved.name || getName(),
      root: root,
      source: resolved.source,
      docs: listed.docs,
      materials: listed.materials,
      templates: listed.templates,
      versions: listed.versions,
      via: listed.via,
      fso: hasDiskApi(),
      disk: hasDiskApi()
    };
  }

  function cleanDocText(t) {
    return String(t == null ? "" : t).replace(/\r/g, "\n");
  }

  /**
   * 从已打开或临时只读打开的 doc/docx 抽纯文本。
   * 临时打开后关闭，并尽量回到原先活动文档。
   */
  function extractOfficeText(abs) {
    var app = global.Application;
    if (!app || !app.Documents) {
      return { ok: false, error: "无 Documents 接口" };
    }
    var pathNorm = normSlash(abs);
    var prev = null;
    try {
      prev = app.ActiveDocument;
    } catch (e0) {}

    try {
      var docs = app.Documents;
      var count = Number(docs.Count) || 0;
      for (var i = 1; i <= count; i++) {
        try {
          var d0 = docs.Item(i);
          var full = "";
          try {
            full = String(d0.FullName || "");
          } catch (e1) {}
          if (full && samePath(full, pathNorm)) {
            var tx0 = "";
            try {
              tx0 = cleanDocText(d0.Content.Text);
            } catch (e2) {
              return { ok: false, error: "已打开文档无法读正文" };
            }
            return { ok: true, text: tx0, via: "open-doc" };
          }
        } catch (eItem) {}
      }
    } catch (eScan) {}

    var opened = null;
    try {
      try {
        opened = app.Documents.Open(pathNorm, false, true, false);
      } catch (eA) {
        try {
          opened = app.Documents.Open(pathNorm, false, true);
        } catch (eB) {
          opened = app.Documents.Open(pathNorm);
        }
      }
      var tx = "";
      try {
        tx = cleanDocText(opened.Content.Text);
      } catch (eTxt) {
        try {
          opened.Close(false);
        } catch (eC0) {}
        return { ok: false, error: "无法读取正文" };
      }
      try {
        opened.Close(false);
      } catch (eClose) {}
      opened = null;
      if (prev) {
        try {
          prev.Activate();
        } catch (eAct) {}
      }
      return { ok: true, text: tx, via: "temp-open" };
    } catch (eOpen) {
      if (opened) {
        try {
          opened.Close(false);
        } catch (eC1) {}
      }
      if (prev) {
        try {
          prev.Activate();
        } catch (eAct2) {}
      }
      return { ok: false, error: String(eOpen.message || eOpen) };
    }
  }

  function readTextRel(rel) {
    resolveRoot();
    var root = getRoot();
    var pathRel = normRel(rel);
    if (!root || !pathRel) return { ok: false, error: "无工程或路径" };
    if (pathRel.indexOf("..") >= 0) return { ok: false, error: "非法路径" };
    var abs = joinRoot(root, pathRel);
    if (!OFFICE_RE.test(pathRel)) {
      return { ok: false, error: "仅支持读取 doc / docx" };
    }
    if (hasDiskApi() && !fsExists(abs)) {
      return { ok: false, error: "文件不存在" };
    }
    var r = extractOfficeText(abs);
    if (!r.ok) return r;
    return { ok: true, path: pathRel, text: r.text, via: r.via };
  }

  function deleteRel(rel) {
    resolveRoot();
    var root = getRoot();
    var pathRel = normRel(rel);
    if (!root || !pathRel) return { ok: false, error: "无工程或路径" };
    if (pathRel.indexOf("..") >= 0) return { ok: false, error: "非法路径" };
    var abs = joinRoot(root, pathRel);
    if (!hasDiskApi()) return { ok: false, error: "本机无法删文件（无 FileSystem）" };
    if (!fsExists(abs)) return { ok: false, error: "文件不存在" };
    if (!fsRemoveFile(abs)) return { ok: false, error: "删除失败" };
    return { ok: true };
  }

  function getCitePaths() {
    try {
      var raw = storeGet(CITE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr)
        ? arr.map(normRel).filter(function (p) {
            return p && OFFICE_RE.test(p);
          })
        : [];
    } catch (e) {
      return [];
    }
  }

  function setCitePaths(list) {
    storeSet(CITE_KEY, JSON.stringify((list || []).map(normRel).filter(Boolean)));
  }

  function samePath(a, b) {
    return (
      normSlash(a).replace(/\\+$/, "").toLowerCase() ===
      normSlash(b).replace(/\\+$/, "").toLowerCase()
    );
  }

  /**
   * 只读打开到 WPS 新标签；若已打开则切到该文档（不重复开）。
   */
  function openInWpsReadOnly(rel) {
    var abs = absFromRel(rel);
    if (!abs) return { ok: false, error: "无工程或路径" };
    if (!LIST_RE.test(abs)) {
      return { ok: false, error: "仅支持打开 doc / docx" };
    }
    if (hasDiskApi() && !fsExists(abs)) {
      return { ok: false, error: "文件不存在：\n" + abs };
    }
    var app = global.Application;
    if (!app || !app.Documents) {
      return { ok: false, error: "无 Documents 接口" };
    }
    try {
      var docs = app.Documents;
      var count = Number(docs.Count) || 0;
      for (var i = 1; i <= count; i++) {
        try {
          var d = docs.Item(i);
          var full = "";
          try {
            full = String(d.FullName || "");
          } catch (e1) {}
          if (full && samePath(full, abs)) {
            try {
              d.Activate();
            } catch (e2) {}
            return { ok: true, reused: true, path: normRel(rel) };
          }
        } catch (eItem) {}
      }
    } catch (eScan) {}

    try {
      // 官方示例：Open(path, null, true) 只读
      app.Documents.Open(abs, null, true);
      return { ok: true, reused: false, path: normRel(rel) };
    } catch (eOpen) {
      try {
        app.Documents.Open(abs, false, true);
        return { ok: true, reused: false, path: normRel(rel) };
      } catch (eOpen2) {
        try {
          app.Documents.Open(abs);
          return {
            ok: true,
            reused: false,
            path: normRel(rel),
            warn: "已打开（可能非只读）"
          };
        } catch (eOpen3) {
          return {
            ok: false,
            error: "打开失败：" + String(eOpen3.message || eOpen3) + "\n" + abs
          };
        }
      }
    }
  }

  function addCite(rel) {
    var p = normRel(rel);
    if (!p) return { ok: false, error: "空路径" };
    if (!OFFICE_RE.test(p)) {
      return { ok: false, error: "仅可引用 doc / docx" };
    }
    var list = getCitePaths();
    if (list.indexOf(p) >= 0) return { ok: true, exists: true, path: p };
    list.push(p);
    setCitePaths(list);
    return { ok: true, path: p };
  }

  function removeCite(rel) {
    var p = normRel(rel);
    setCitePaths(
      getCitePaths().filter(function (x) {
        return x !== p;
      })
    );
  }

  function loadCitedMaterials(maxChars) {
    var cap = maxChars || 6000;
    var out = [];
    var left = cap;
    getCitePaths().forEach(function (p) {
      if (left <= 0) return;
      var r = readTextRel(p);
      var text = r.ok ? String(r.text || "").slice(0, left) : "";
      left -= text.length;
      out.push({ path: p, title: titleOf(baseName(p)), text: text, ok: !!r.ok });
    });
    return out;
  }

  global.GwProject = {
    ROOT_KEY: ROOT_KEY,
    CITE_KEY: CITE_KEY,
    getRoot: getRoot,
    getName: getName,
    setRoot: setRoot,
    clearRoot: clearRoot,
    resolveRoot: resolveRoot,
    activeDocumentFolder: activeDocumentFolder,
    ensureProjectLayout: ensureProjectLayout,
    followActiveDocument: followActiveDocument,
    isManualRoot: isManualRoot,
    pickFolder: pickFolder,
    listProjectFiles: listProjectFiles,
    readTextRel: readTextRel,
    deleteRel: deleteRel,
    getCitePaths: getCitePaths,
    setCitePaths: setCitePaths,
    absFromRel: absFromRel,
    openInWpsReadOnly: openInWpsReadOnly,
    addCite: addCite,
    removeCite: removeCite,
    loadCitedMaterials: loadCitedMaterials,
    baseName: baseName,
    normRel: normRel,
    getFso: getFso,
    getWpsFs: getWpsFs,
    hasDiskApi: hasDiskApi
  };
})(window);
