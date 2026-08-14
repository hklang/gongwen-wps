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
  var STYLE_REF_KEY = "gongwen.styleRefRel";
  var MATERIAL_DIR = "素材";
  var TEMPLATE_DIR = "模板";
  var VERSION_DIR = "版本";
  var VERSION_BOOKMARK = "书签";
  var VERSION_AUTO = "自动";
  var VERSION_AUTO_WRITE = "撰写";
  var VERSION_AUTO_SUITE = "精修";
  var AUTO_VERSION_KEEP = 10;
  var META_DIR = ".gongwen";
  var LIST_RE = /\.docx?$/i;
  var OFFICE_RE = /\.docx?$/i;
  var TEXT_RE = /\.(md|txt)$/i;
  var READABLE_RE = /\.(docx?|md|txt)$/i;
  /** 正文内存缓存：避免每次发送 Documents.Open 闪屏 */
  var textCache = {};

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

  /** @returns {{size:number,mtime:number}|null} mtime 为秒级 unix */
  function fsStat(abs) {
    var p = normSlash(abs);
    var fs = getWpsFs();
    if (fs && typeof fs.statSync === "function") {
      try {
        var st = fs.statSync(p);
        if (!st) return null;
        var m =
          st.mtimeMs != null
            ? Number(st.mtimeMs) / 1000
            : st.mtime
              ? new Date(st.mtime).getTime() / 1000
              : 0;
        return {
          size: Number(st.size || st.Size || 0) || 0,
          mtime: m || 0
        };
      } catch (e) {}
    }
    var fso = getFso();
    if (fso) {
      try {
        if (!fso.FileExists(p)) return null;
        var f = fso.GetFile(p);
        var mt = 0;
        try {
          mt = new Date(f.DateLastModified).getTime() / 1000;
        } catch (e2) {}
        return { size: Number(f.Size) || 0, mtime: mt || 0 };
      } catch (e3) {}
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
    if (!root) return { ok: false, error: "无根路径", created: [] };
    if (!hasDiskApi()) {
      return { ok: false, error: "无磁盘 API（FileSystem/FSO）", created: [] };
    }
    try {
      var r = String(root || "").replace(/[\\\/]+$/, "");
      if (!fsExists(r)) return { ok: false, error: "目录不存在：" + r, created: [] };
      var created = [];
      var missing = [];
      [MATERIAL_DIR, TEMPLATE_DIR, VERSION_DIR, META_DIR].forEach(function (sub) {
        var p = joinRoot(r, sub);
        if (fsExists(p)) return;
        if (fsMkdir(p) && fsExists(p)) created.push(sub);
        else missing.push(sub);
      });
      [VERSION_BOOKMARK, VERSION_AUTO].forEach(function (sub) {
        var p = joinRoot(r, VERSION_DIR + "\\" + sub);
        if (fsExists(p)) return;
        if (fsMkdir(p) && fsExists(p)) created.push(VERSION_DIR + "/" + sub);
        else missing.push(VERSION_DIR + "/" + sub);
      });
      [VERSION_AUTO_WRITE, VERSION_AUTO_SUITE].forEach(function (sub) {
        var p = joinRoot(r, VERSION_DIR + "\\" + VERSION_AUTO + "\\" + sub);
        if (fsExists(p)) return;
        if (fsMkdir(p) && fsExists(p))
          created.push(VERSION_DIR + "/" + VERSION_AUTO + "/" + sub);
        else missing.push(VERSION_DIR + "/" + VERSION_AUTO + "/" + sub);
      });
      try {
        var meta = joinRoot(r, META_DIR + "\\wps.json");
        if (!fsExists(meta)) {
          var wrote = fsWriteText(
            meta,
            JSON.stringify({
              version: 1,
              name: getName() || baseName(r.replace(/\\/g, "/")),
              root: r,
              updatedAt: new Date().toISOString()
            })
          );
          if (wrote) created.push(".gongwen/wps.json");
        }
      } catch (eMeta) {}
      if (missing.length) {
        return {
          ok: false,
          error: "未能创建：" + missing.join("、"),
          created: created,
          missing: missing
        };
      }
      return { ok: true, created: created, root: r };
    } catch (e) {
      return { ok: false, error: String(e.message || e), created: [] };
    }
  }

  function currentProjectStartPath() {
    var resolved = resolveRoot();
    if (resolved.root) return resolved.root;
    var active = liftToProjectRoot(activeDocumentFolder());
    return active || "";
  }

  function pickFolder() {
    var app = global.Application;
    if (!app || typeof app.FileDialog !== "function") {
      return { ok: false, error: "当前环境无 FileDialog" };
    }
    try {
      var start = currentProjectStartPath();
      var dlg = app.FileDialog(4);
      dlg.Title = "改绑公文工程文件夹（将创建 素材/模板/版本）";
      try {
        dlg.AllowMultiSelect = false;
      } catch (eAllow) {}
      if (start) {
        try {
          // 末尾必须带 \，否则会当成「文件夹名」而不是进入该目录
          dlg.InitialFileName = String(start).replace(/[\\\/]+$/, "") + "\\";
        } catch (eInit) {}
      }
      if (dlg.Show() !== -1) return { ok: false, cancelled: true };
      var path = dlg.SelectedItems.Item(1);
      if (!path) return { ok: false, error: "未选中文件夹" };
      path = String(path).replace(/[\\\/]+$/, "");
      setRoot(path, baseName(path.replace(/\\/g, "/")), true);
      var layout = ensureProjectLayout(getRoot());
      if (!layout.ok) {
        return {
          ok: false,
          error: "已改绑，但工程夹创建失败：" + (layout.error || ""),
          root: getRoot(),
          name: getName(),
          layout: layout
        };
      }
      return {
        ok: true,
        root: getRoot(),
        name: getName(),
        source: "manual",
        created: layout.created || [],
        layout: layout
      };
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

  function relExists(rel) {
    var abs = absFromRel(rel);
    return !!(abs && fsExists(abs));
  }

  /** 自动档：文件还在即可还。份数上限由 prune 删旧，不在这里用名单卡灰。 */
  function isAutoRestoreable(relPath) {
    var rel = normRel(relPath);
    return !!(rel && relExists(rel));
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

  /** 取消手动改绑，恢复跟随当前文档 */
  function followActiveDocument() {
    storeSet(MANUAL_KEY, "");
    return resolveRoot();
  }

  function listFilesInFolder(absDir, relPrefix, limit, nameRe) {
    var out = [];
    var max = !limit || limit <= 0 ? 1e9 : limit;
    var re = nameRe || LIST_RE;
    var names = fsReaddirNames(absDir);
    if (!names) return out;
    names = names.slice().sort();
    var dir = normSlash(String(absDir || "").replace(/[\\\/]+$/, ""));
    for (var j = 0; j < names.length && out.length < max; j++) {
      var name = String(names[j] || "");
      if (!re.test(name) || name.charAt(0) === ".") continue;
      var rel = normRel((relPrefix ? relPrefix + "/" : "") + name);
      var abs = dir + "\\" + name;
      var st = fsStat(abs);
      out.push({
        path: rel,
        title: titleOf(name),
        kind: OFFICE_RE.test(name) ? "office" : "text",
        size: st ? st.size : 0,
        mtime: st ? st.mtime : 0
      });
    }
    return out;
  }

  function sortByMtimeDesc(arr) {
    return (arr || []).slice().sort(function (a, b) {
      var mb = Number(b.mtime) || 0;
      var ma = Number(a.mtime) || 0;
      /* stat 失败时 mtime=0，当作刚写入，避免刚存的档被排到最旧再删掉 */
      if (!mb) mb = 1e15;
      if (!ma) ma = 1e15;
      return mb - ma;
    });
  }

  /** 自动档文件名以 YYYYMMDD-HHMMSS_ 开头，比 mtime 可靠 */
  function stampFromRel(rel) {
    var n = baseName(rel);
    var m = /^(\d{8}-\d{6})/.exec(n);
    return m ? m[1] : "";
  }

  function sortAutoNewest(arr) {
    return (arr || []).slice().sort(function (a, b) {
      var sb = stampFromRel(b.path);
      var sa = stampFromRel(a.path);
      if (sb !== sa) return sb > sa ? 1 : -1;
      var mb = Number(b.mtime) || 0;
      var ma = Number(a.mtime) || 0;
      if (!mb) mb = 1e15;
      if (!ma) ma = 1e15;
      return mb - ma;
    });
  }

  function listVersionLanes(root) {
    var bookmarks = listFilesInFolder(
      joinRoot(root, VERSION_DIR + "\\" + VERSION_BOOKMARK),
      VERSION_DIR + "/" + VERSION_BOOKMARK,
      60,
      LIST_RE
    );
    var legacy = listFilesInFolder(
      joinRoot(root, VERSION_DIR),
      VERSION_DIR,
      60,
      LIST_RE
    );
    legacy.forEach(function (it) {
      it.legacyFlat = true;
      it.lane = "bookmark";
    });
    bookmarks.forEach(function (it) {
      it.lane = "bookmark";
      it.restoreable = true;
    });
    legacy.forEach(function (it) {
      it.restoreable = true;
    });
    var autos = sortAutoNewest(
      listFilesInFolder(
        joinRoot(root, VERSION_DIR + "\\" + VERSION_AUTO + "\\" + VERSION_AUTO_WRITE),
        VERSION_DIR + "/" + VERSION_AUTO + "/" + VERSION_AUTO_WRITE,
        200,
        LIST_RE
      ).concat(
        listFilesInFolder(
          joinRoot(
            root,
            VERSION_DIR + "\\" + VERSION_AUTO + "\\" + VERSION_AUTO_SUITE
          ),
          VERSION_DIR + "/" + VERSION_AUTO + "/" + VERSION_AUTO_SUITE,
          200,
          LIST_RE
        )
      )
    );
    autos.forEach(function (it) {
      it.lane = "auto";
      it.restoreable = true;
    });
    var allBookmarks = sortByMtimeDesc(bookmarks.concat(legacy));
    return {
      bookmarks: allBookmarks,
      autos: autos,
      versions: allBookmarks.concat(autos)
    };
  }

  function listFromDisk(root) {
    if (!hasDiskApi() || !root) return null;
    try {
      if (!fsExists(root)) return null;
      var via = getWpsFs() ? "wpsfs" : "fso";
      var lanes = listVersionLanes(root);
      return {
        docs: listFilesInFolder(root, "", 30, LIST_RE),
        materials: listFilesInFolder(
          joinRoot(root, MATERIAL_DIR),
          MATERIAL_DIR,
          40,
          READABLE_RE
        ),
        templates: listFilesInFolder(
          joinRoot(root, TEMPLATE_DIR),
          TEMPLATE_DIR,
          40,
          READABLE_RE
        ),
        versions: lanes.versions,
        versionBookmarks: lanes.bookmarks,
        versionAutos: lanes.autos,
        via: via
      };
    } catch (e) {
      return null;
    }
  }

  function listFromIndex() {
    var idx = readIndex();
    var versions = idx.versions || [];
    return {
      docs: idx.docs || [],
      materials: idx.materials || [],
      templates: idx.templates || [],
      versions: versions,
      versionBookmarks: versions,
      versionAutos: [],
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
        versionBookmarks: [],
        versionAutos: [],
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
      versions: listed.versions || [],
      versionBookmarks: listed.versionBookmarks || [],
      versionAutos: listed.versionAutos || [],
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
   * 注意：Open/Close/Activate 会导致 WPS 闪一下——调用方须靠 textCache 避免重复抽。
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
          var cur = null;
          try {
            cur = app.ActiveDocument;
          } catch (eCur) {}
          if (!cur || !samePath(String(cur.FullName || ""), String(prev.FullName || ""))) {
            prev.Activate();
          }
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

  function textCacheKey(rel) {
    return normRel(rel).toLowerCase();
  }

  function clearTextCache(rel) {
    if (!rel) {
      textCache = {};
      return;
    }
    delete textCache[textCacheKey(rel)];
  }

  function readTextRel(rel, opts) {
    opts = opts || {};
    resolveRoot();
    var root = getRoot();
    var pathRel = normRel(rel);
    if (!root || !pathRel) return { ok: false, error: "无工程或路径" };
    if (pathRel.indexOf("..") >= 0) return { ok: false, error: "非法路径" };
    var abs = joinRoot(root, pathRel);
    if (!READABLE_RE.test(pathRel)) {
      return { ok: false, error: "仅支持读取 doc / docx / md / txt" };
    }
    if (hasDiskApi() && !fsExists(abs)) {
      clearTextCache(pathRel);
      return { ok: false, error: "文件不存在" };
    }
    var st = absStatRel(pathRel) || { size: 0, mtime: 0 };
    var ck = textCacheKey(pathRel);
    var hit = textCache[ck];
    if (
      !opts.force &&
      hit &&
      hit.text != null &&
      ((Number(st.mtime) || Number(st.size))
        ? Number(hit.mtime) === Number(st.mtime) &&
          Number(hit.size) === Number(st.size)
        : true)
    ) {
      return {
        ok: true,
        path: pathRel,
        text: hit.text,
        via: (hit.via || "cache") + "+cache"
      };
    }
    if (TEXT_RE.test(pathRel)) {
      var tx = fsReadText(abs);
      if (tx == null) return { ok: false, error: "无法读取文本文件", path: pathRel };
      var textOk = cleanDocText(tx);
      textCache[ck] = {
        mtime: st.mtime || 0,
        size: st.size || 0,
        text: textOk,
        via: "text",
        at: Date.now()
      };
      return { ok: true, path: pathRel, text: textOk, via: "text" };
    }
    var r = extractOfficeText(abs);
    if (!r.ok) return r;
    textCache[ck] = {
      mtime: st.mtime || 0,
      size: st.size || 0,
      text: r.text,
      via: r.via || "office",
      at: Date.now()
    };
    return { ok: true, path: pathRel, text: r.text, via: r.via };
  }

  function absStatRel(rel) {
    resolveRoot();
    var root = getRoot();
    var pathRel = normRel(rel);
    if (!root || !pathRel || pathRel.indexOf("..") >= 0) return null;
    return fsStat(joinRoot(root, pathRel));
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

  function getStyleRefRel() {
    return normRel(storeGet(STYLE_REF_KEY));
  }

  function setStyleRef(rel) {
    var pathRel = normRel(rel);
    if (!pathRel) return { ok: false, error: "空路径" };
    if (pathRel.indexOf("..") >= 0) return { ok: false, error: "非法路径" };
    if (!READABLE_RE.test(pathRel)) {
      return { ok: false, error: "参照稿仅支持 doc / docx / md / txt" };
    }
    storeSet(STYLE_REF_KEY, pathRel);
    try {
      if (typeof window !== "undefined" && window.dispatchEvent) {
        window.dispatchEvent(
          new CustomEvent("gw-style-ref", { detail: { rel: pathRel } })
        );
      }
    } catch (eEv) {}
    return { ok: true, path: pathRel };
  }

  function clearStyleRef() {
    storeSet(STYLE_REF_KEY, "");
    try {
      if (typeof window !== "undefined" && window.dispatchEvent) {
        window.dispatchEvent(
          new CustomEvent("gw-style-ref", { detail: { rel: "" } })
        );
      }
    } catch (eEv2) {}
    return { ok: true };
  }

  function getCitePaths() {
    try {
      var raw = storeGet(CITE_KEY);
      var arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr)
        ? arr.map(normRel).filter(function (p) {
            return p && READABLE_RE.test(p);
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
    if (!READABLE_RE.test(p)) {
      return { ok: false, error: "仅可引用 doc / docx / md / txt" };
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

  function pad2(n) {
    n = Number(n) || 0;
    return n < 10 ? "0" + n : String(n);
  }

  function versionTimeStamp() {
    var d = new Date();
    return (
      d.getFullYear() +
      pad2(d.getMonth() + 1) +
      pad2(d.getDate()) +
      "-" +
      pad2(d.getHours()) +
      pad2(d.getMinutes()) +
      pad2(d.getSeconds())
    );
  }

  function safeFileName(name) {
    return String(name || "未命名")
      .replace(/[\\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "未命名";
  }

  function fsCopyFile(src, dst) {
    var a = normSlash(src);
    var b = normSlash(dst);
    var fs = getWpsFs();
    if (fs) {
      var copyFns = ["copyFileSync", "CopyFile", "copyFile", "CopySync"];
      for (var ci = 0; ci < copyFns.length; ci++) {
        var fn = copyFns[ci];
        if (typeof fs[fn] !== "function") continue;
        try {
          fs[fn](a, b);
          if (fsExists(b)) return true;
        } catch (e) {}
      }
    }
    var fso = getFso();
    if (fso) {
      try {
        fso.CopyFile(a, b, true);
        return fsExists(b);
      } catch (e2) {}
    }
    return false;
  }

  function callDocSaveAs(doc, path) {
    var p = normSlash(path);
    var errs = [];
    try {
      if (doc.SaveAs2) {
        doc.SaveAs2(p);
        return { ok: true, via: "SaveAs2" };
      }
    } catch (e1) {
      errs.push("SaveAs2:" + (e1.message || e1));
    }
    try {
      if (doc.SaveAs2) {
        doc.SaveAs2(p, 16);
        return { ok: true, via: "SaveAs2/16" };
      }
    } catch (e1b) {
      errs.push("SaveAs2/16:" + (e1b.message || e1b));
    }
    try {
      if (doc.SaveAs) {
        doc.SaveAs(p);
        return { ok: true, via: "SaveAs" };
      }
    } catch (e2) {
      errs.push("SaveAs:" + (e2.message || e2));
    }
    try {
      if (doc.SaveCopyAs) {
        doc.SaveCopyAs(p);
        return { ok: true, via: "SaveCopyAs" };
      }
    } catch (e3) {
      errs.push("SaveCopyAs:" + (e3.message || e3));
    }
    return { ok: false, error: errs.join(" | ") || "无可用 Save 方法" };
  }

  function autoKindName(kind) {
    return kind === "suite" ? VERSION_AUTO_SUITE : VERSION_AUTO_WRITE;
  }

  function autoLaneRel(kind) {
    return VERSION_DIR + "/" + VERSION_AUTO + "/" + autoKindName(kind);
  }

  function autoKindFromRel(rel) {
    var n = normRel(rel);
    var suitePrefix =
      VERSION_DIR + "/" + VERSION_AUTO + "/" + VERSION_AUTO_SUITE + "/";
    return n.indexOf(suitePrefix) === 0 ? "suite" : "write";
  }

  /**
   * 存版本到指定轨：书签=用户手动；自动=AI落稿（撰写/精修分夹）。
   * 优先磁盘复制，其次 SaveCopyAs / SaveAs2。
   */
  function saveToVersionLane(lane, kind) {
    var steps = [];
    try {
      var laneRel =
        lane === "auto"
          ? autoLaneRel(kind)
          : VERSION_DIR + "/" + VERSION_BOOKMARK;
      var resolved = resolveRoot();
      var root = resolved.root;
      if (!root) {
        return {
          ok: false,
          error: resolved.unsaved
            ? "请先保存当前文档以确定工程目录"
            : "无工程根，请先保存文档或改绑"
        };
      }
      ensureProjectLayout(root);
      steps.push("root=" + root);
      steps.push("lane=" + laneRel);

      var verDir = joinRoot(root, laneRel.replace(/\//g, "\\"));
      if (!fsExists(verDir) && !fsMkdir(verDir)) {
        return { ok: false, error: "无法创建版本目录：\n" + verDir };
      }

      var app = global.Application;
      if (!app || !app.ActiveDocument) {
        return { ok: false, error: "当前无打开文档" };
      }
      var doc = app.ActiveDocument;
      var rawName = "";
      var full = "";
      var wasSaved = true;
      try {
        rawName = String(doc.Name || "");
      } catch (e0) {}
      try {
        full = String(doc.FullName || "");
      } catch (e1) {}
      try {
        wasSaved = doc.Saved !== false;
      } catch (e2) {}

      if (!rawName) rawName = "未命名.docx";
      if (!/\.docx?$/i.test(rawName)) rawName = rawName + ".docx";

      var outName = versionTimeStamp() + "_" + safeFileName(rawName);
      var rel = normRel(laneRel + "/" + outName);
      var abs = joinRoot(root, rel);
      steps.push("target=" + abs);

      var hasDiskPath = !!(full && /[\\/]/.test(full) && full !== rawName);
      var saved = false;
      var via = "";

      if (hasDiskPath) {
        try {
          if (!wasSaved) doc.Save();
        } catch (eSave) {
          steps.push("Save原稿失败:" + (eSave.message || eSave));
        }
        if (fsCopyFile(full, abs) && fsExists(abs)) {
          saved = true;
          via = "copy";
        } else {
          steps.push("copy失败");
        }
      } else {
        steps.push("原稿未落盘");
      }

      if (!saved) {
        try {
          doc.SaveCopyAs(abs);
          if (fsExists(abs)) {
            saved = true;
            via = "SaveCopyAs";
          } else {
            steps.push("SaveCopyAs无文件");
          }
        } catch (eCopyAs) {
          steps.push("SaveCopyAs:" + (eCopyAs.message || eCopyAs));
        }
      }

      if (!saved && hasDiskPath) {
        var r1 = callDocSaveAs(doc, abs);
        steps.push("存版本:" + (r1.via || r1.error || "?"));
        if (r1.ok && fsExists(abs)) {
          saved = true;
          via = "SaveAs2-restore";
          var r2 = callDocSaveAs(doc, full);
          steps.push("还原:" + (r2.via || r2.error || "?"));
          try {
            if (wasSaved) doc.Saved = true;
          } catch (eSaved) {}
          if (!r2.ok) {
            via = "SaveAs2";
          }
        }
      } else if (!saved) {
        var rNew = callDocSaveAs(doc, abs);
        if (rNew.ok && fsExists(abs)) {
          saved = true;
          via = rNew.via;
          steps.push("新稿另存成功");
        } else {
          steps.push("新稿另存:" + (rNew.error || "失败"));
        }
      }

      if (!saved) {
        return {
          ok: false,
          error: "存版本失败\n目标：" + abs + "\n" + steps.join("\n")
        };
      }

      var result = { ok: true, path: rel, abs: abs, via: via, lane: laneRel };
      if (lane === "auto") {
        result.pruned = pruneAutoVersions(root, rel, kind);
      }
      return result;
    } catch (e) {
      return {
        ok: false,
        error: "存版本异常：" + String(e.message || e) + "\n" + steps.join("\n")
      };
    }
  }

  function saveBookmarkVersion() {
    return saveToVersionLane("bookmark");
  }

  /** 兼容旧名：头栏/工程栏「存版本」= 书签 */
  function saveActiveToVersion() {
    return saveBookmarkVersion();
  }

  function saveAutoVersion(kind) {
    return saveToVersionLane("auto", kind === "suite" ? "suite" : "write");
  }

  /** 自动轨按撰写/精修分夹，各留最近 AUTO_VERSION_KEEP 份 */
  function pruneAutoVersions(root, keepRel, kind) {
    var k = kind || autoKindFromRel(keepRel);
    var relPrefix = autoLaneRel(k);
    var dir = joinRoot(root, relPrefix.replace(/\//g, "\\"));
    if (!fsExists(dir)) return { removed: 0 };
    var files = sortAutoNewest(
      listFilesInFolder(dir, relPrefix, 0, LIST_RE)
    );
    var keep = normRel(keepRel || "");
    var removed = 0;
    var i;
    for (i = 0; i < files.length; i++) {
      if (keep && files[i].path === keep) continue;
      if (i < AUTO_VERSION_KEEP) continue;
      var del = deleteRel(files[i].path);
      if (del && del.ok) removed++;
    }
    return {
      removed: removed,
      kept: Math.min(files.length, AUTO_VERSION_KEEP)
    };
  }

  /** 清空某一自动夹（撰写或精修）；不改正文、不动书签 */
  function clearAutoLane(kind) {
    var resolved = resolveRoot();
    var root = resolved.root;
    if (!root) return { ok: false, error: "无工程根" };
    var k = kind === "suite" ? "suite" : "write";
    var relPrefix = autoLaneRel(k);
    var dir = joinRoot(root, relPrefix.replace(/\//g, "\\"));
    if (!fsExists(dir)) return { ok: true, removed: 0 };
    var files = listFilesInFolder(dir, relPrefix, 0, LIST_RE);
    var removed = 0;
    var i;
    for (i = 0; i < files.length; i++) {
      var del = deleteRel(files[i].path);
      if (del && del.ok) removed++;
    }
    return { ok: true, removed: removed };
  }

  /** 恢复某版本覆盖当前活动稿。文件还在即可还。 */
  function restoreVersionToActive(relPath) {
    try {
      var root = resolveRoot().root;
      if (!root) return { ok: false, error: "无工程根" };
      var rel = normRel(relPath);
      if (!rel) return { ok: false, error: "路径无效" };

      var app = global.Application;
      if (!app || !app.ActiveDocument) {
        return { ok: false, error: "当前无打开文档" };
      }
      var doc = app.ActiveDocument;
      var full = "";
      var wasSaved = true;
      try {
        full = String(doc.FullName || "");
      } catch (e1) {}
      try {
        wasSaved = doc.Saved !== false;
      } catch (e2) {}

      if (!full || !/[\\/]/.test(full)) {
        return { ok: false, error: "请先保存当前文档到工程目录后再恢复" };
      }

      var srcAbs = joinRoot(root, rel);
      if (!fsExists(srcAbs)) {
        return { ok: false, error: "版本文件不存在：" + rel };
      }

      // 先备份当前稿到自动轨
      var backup = saveAutoVersion(autoKindFromRel(rel));
      if (!backup.ok) {
        return {
          ok: false,
          error: "恢复前备份失败：" + (backup.error || "")
        };
      }

      if (!wasSaved) {
        try {
          doc.Save();
        } catch (eSave) {
          return { ok: false, error: "请先保存当前修改后再恢复" };
        }
      }

      try {
        doc.Close(0);
      } catch (eClose) {
        return {
          ok: false,
          error: "无法关闭当前文档：" + String(eClose.message || eClose)
        };
      }

      if (!fsCopyFile(srcAbs, full)) {
        try {
          app.Documents.Open(full);
        } catch (eRe) {}
        return { ok: false, error: "复制版本文件失败" };
      }

      try {
        app.Documents.Open(full);
      } catch (eOpen) {
        return {
          ok: false,
          error: "已覆盖文件但重新打开失败：" + String(eOpen.message || eOpen)
        };
      }

      return {
        ok: true,
        restored: rel,
        active: full,
        backup: backup.path
      };
    } catch (e) {
      return { ok: false, error: String(e.message || e) };
    }
  }

  function safeTemplateFileName(categoryCode, title) {
    var code =
      String(categoryCode || "tpl")
        .replace(/[^\w\-]+/g, "")
        .slice(0, 32) || "tpl";
    var base =
      String(title || "骨架")
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40) || "骨架";
    return code + "-" + base + ".md";
  }

  /**
   * 云端骨架落到本机「模板/」（只落盘，不改当前 docx）。
   * opts: { title, category|categoryCode, body_md|bodyMd, force }
   */
  function landTemplate(opts) {
    var o = opts || {};
    var resolved = resolveRoot();
    var root = resolved && resolved.root;
    if (!root) {
      return { ok: false, error: "请先打开已保存的文稿或绑定工程文件夹" };
    }
    var layout = ensureProjectLayout(root);
    if (!layout.ok) {
      return { ok: false, error: layout.error || "无法创建模板目录" };
    }
    var body = String(o.body_md || o.bodyMd || "").trim();
    if (!body) return { ok: false, error: "模板正文为空" };
    var code = String(o.category || o.categoryCode || "tpl").trim() || "tpl";
    var title = String(o.title || "骨架").trim() || "骨架";
    var force = !!o.force;
    var name = safeTemplateFileName(code, title);
    var abs = joinRoot(root, TEMPLATE_DIR + "\\" + name);
    var rel = (TEMPLATE_DIR + "/" + name).replace(/\\/g, "/");
    if (fsExists(abs) && !force) {
      return {
        ok: false,
        need_confirm: true,
        path: rel,
        error: "已存在同名模板"
      };
    }
    var text = body.endsWith("\n") ? body : body + "\n";
    if (!fsWriteText(abs, text)) {
      return { ok: false, error: "写入失败：" + abs };
    }
    try {
      storeSet("gongwen.proj.need_refresh", String(Date.now()));
    } catch (eFlag) {}
    return {
      ok: true,
      path: rel,
      absolute: abs,
      title: title,
      category: code
    };
  }

  global.GwProject = {
    ROOT_KEY: ROOT_KEY,
    CITE_KEY: CITE_KEY,
    VERSION_DIR: VERSION_DIR,
    MATERIAL_DIR: MATERIAL_DIR,
    TEMPLATE_DIR: TEMPLATE_DIR,
    META_DIR: META_DIR,
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
    clearTextCache: clearTextCache,
    absStatRel: absStatRel,
    fsStat: fsStat,
    fsExists: fsExists,
    fsReadText: fsReadText,
    fsWriteText: fsWriteText,
    joinRoot: joinRoot,
    deleteRel: deleteRel,
    getCitePaths: getCitePaths,
    setCitePaths: setCitePaths,
    absFromRel: absFromRel,
    relExists: relExists,
    isAutoRestoreable: isAutoRestoreable,
    openInWpsReadOnly: openInWpsReadOnly,
    saveActiveToVersion: saveActiveToVersion,
    saveBookmarkVersion: saveBookmarkVersion,
    saveAutoVersion: saveAutoVersion,
    clearAutoLane: clearAutoLane,
    restoreVersionToActive: restoreVersionToActive,
    AUTO_VERSION_KEEP: AUTO_VERSION_KEEP,
    addCite: addCite,
    removeCite: removeCite,
    loadCitedMaterials: loadCitedMaterials,
    getStyleRefRel: getStyleRefRel,
    setStyleRef: setStyleRef,
    clearStyleRef: clearStyleRef,
    baseName: baseName,
    normRel: normRel,
    titleOf: titleOf,
    getFso: getFso,
    getWpsFs: getWpsFs,
    hasDiskApi: hasDiskApi,
    landTemplate: landTemplate,
    safeTemplateFileName: safeTemplateFileName
  };
})(window);
