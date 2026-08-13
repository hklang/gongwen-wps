/**
 * 设置 v2：场景引擎 + 词库 + 数据核验表；本机 PluginStorage / localStorage
 * 见 specs/2026-08-13-02-WPS设置系统设计.md
 */
(function (global) {
  var KEY_V2 = "gongwen.settings.v2";
  var KEY_V1 = "gongwen.settings.v1";

  var ENGINE_LABELS = [
    { id: "punctuation", name: "标点", group: "quick" },
    { id: "format", name: "公文格式", group: "quick" },
    { id: "dictionary", name: "词库", group: "quick" },
    { id: "typo", name: "错别字", group: "quick" },
    { id: "grammar", name: "语法", group: "quick" },
    { id: "sensitive", name: "政治规范", group: "quick" },
    { id: "style", name: "风格", group: "deep" },
    { id: "logic", name: "逻辑", group: "deep" },
    { id: "dataverify", name: "数据核验", group: "deep" },
    { id: "duplicate", name: "内容重复", group: "deep" }
  ];

  var SCENES_DEFAULT = {
    政务公文: [
      "punctuation",
      "format",
      "dictionary",
      "typo",
      "grammar",
      "sensitive",
      "duplicate"
    ],
    新闻资讯: ["dictionary", "typo", "punctuation", "sensitive"],
    个人写作: ["dictionary", "typo", "punctuation"]
  };

  function defaultSettings() {
    return {
      version: 2,
      suite: { count: 3, optView: "diff", requireSelection: true },
      proof: {
        sensitivity: "normal",
        defaultScope: "full",
        scene: "政务公文",
        sceneEngineMap: JSON.parse(JSON.stringify(SCENES_DEFAULT)),
        whitelist: [],
        mustfix: [],
        factGroups: [
          { id: "default", name: "默认", enabled: true, items: [] }
        ],
        factGroupId: "default"
      }
    };
  }

  function storeGet(k) {
    try {
      if (global.Application && Application.PluginStorage) {
        var p = Application.PluginStorage.getItem(k);
        if (p != null && p !== "") return String(p);
      }
    } catch (e1) {}
    try {
      return localStorage.getItem(k) || "";
    } catch (e2) {
      return "";
    }
  }

  function storeSet(k, v) {
    try {
      if (global.Application && Application.PluginStorage) {
        Application.PluginStorage.setItem(k, String(v == null ? "" : v));
      }
    } catch (e1) {}
    try {
      localStorage.setItem(k, String(v == null ? "" : v));
    } catch (e2) {}
  }

  function clone(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function normalizeMustfix(arr) {
    return (Array.isArray(arr) ? arr : [])
      .map(function (x) {
        return {
          wrong: String((x && (x.wrong || x.word)) || "").trim(),
          right: String((x && (x.right || x.correction)) || "").trim()
        };
      })
      .filter(function (x) {
        return x.wrong && x.right;
      })
      .slice(0, 500);
  }

  function normalizeWhitelist(arr) {
    var out = [];
    var seen = {};
    (Array.isArray(arr) ? arr : []).forEach(function (w) {
      var s = String(w || "").trim().slice(0, 40);
      if (!s || seen[s]) return;
      seen[s] = 1;
      out.push(s);
    });
    return out.slice(0, 500);
  }

  function mergeSceneMap(raw) {
    var map = clone(SCENES_DEFAULT);
    if (!raw || typeof raw !== "object") return map;
    Object.keys(raw).forEach(function (k) {
      if (Array.isArray(raw[k])) {
        map[k] = raw[k].filter(function (id) {
          return ENGINE_LABELS.some(function (e) {
            return e.id === id;
          });
        });
      }
    });
    return map;
  }

  function migrateFromV1(v1) {
    var d = defaultSettings();
    if (!v1 || typeof v1 !== "object") return d;
    if (v1.suite && typeof v1.suite === "object") {
      if (v1.suite.count != null) d.suite.count = Number(v1.suite.count) || 3;
      if (v1.suite.optView) d.suite.optView = v1.suite.optView === "new" ? "new" : "diff";
      if (v1.suite.requireSelection != null) {
        d.suite.requireSelection = !!v1.suite.requireSelection;
      }
    }
    if (v1.proof && typeof v1.proof === "object") {
      if (v1.proof.sensitivity) d.proof.sensitivity = v1.proof.sensitivity;
      if (v1.proof.defaultScope) d.proof.defaultScope = v1.proof.defaultScope;
      if (v1.proof.engines && typeof v1.proof.engines === "object") {
        var ids = ENGINE_LABELS.map(function (e) {
          return e.id;
        }).filter(function (id) {
          return !!v1.proof.engines[id];
        });
        if (ids.length) {
          d.proof.sceneEngineMap["政务公文"] = ids;
          d.proof.scene = "政务公文";
        }
      }
    }
    return d;
  }

  function normalize(raw) {
    var d = defaultSettings();
    if (!raw || typeof raw !== "object") return d;
    if (raw.suite && typeof raw.suite === "object") {
      var c = Number(raw.suite.count);
      d.suite.count = c >= 2 && c <= 6 ? Math.floor(c) : 3;
      d.suite.optView = raw.suite.optView === "new" ? "new" : "diff";
      d.suite.requireSelection = raw.suite.requireSelection !== false;
    }
    if (raw.proof && typeof raw.proof === "object") {
      var p = raw.proof;
      var sens = p.sensitivity;
      d.proof.sensitivity =
        sens === "strict" || sens === "relaxed" ? sens : "normal";
      d.proof.defaultScope =
        p.defaultScope === "selection" ? "selection" : "full";
      d.proof.scene =
        p.scene && SCENES_DEFAULT[p.scene] ? p.scene : "政务公文";
      d.proof.sceneEngineMap = mergeSceneMap(p.sceneEngineMap);
      d.proof.whitelist = normalizeWhitelist(p.whitelist);
      d.proof.mustfix = normalizeMustfix(p.mustfix);
      if (Array.isArray(p.factGroups) && p.factGroups.length) {
        d.proof.factGroups = p.factGroups.map(function (g, i) {
          return {
            id: String((g && g.id) || "g" + i),
            name: String((g && g.name) || "组" + (i + 1)).slice(0, 40),
            enabled: !g || g.enabled !== false,
            items: Array.isArray(g.items)
              ? g.items
                  .map(function (it) {
                    return {
                      label: String((it && it.label) || "").trim(),
                      value: String((it && it.value) || "").trim(),
                      unit: String((it && it.unit) || "").trim(),
                      aliases: Array.isArray(it && it.aliases)
                        ? it.aliases.map(String)
                        : []
                    };
                  })
                  .filter(function (it) {
                    return it.label && it.value;
                  })
                  .slice(0, 200)
              : []
          };
        });
      }
      var ids = d.proof.factGroups.map(function (g) {
        return g.id;
      });
      d.proof.factGroupId =
        p.factGroupId && ids.indexOf(p.factGroupId) >= 0
          ? p.factGroupId
          : d.proof.factGroups[0].id;
    }
    return d;
  }

  var cache = null;

  function load() {
    if (cache) return cache;
    var raw2 = storeGet(KEY_V2);
    if (raw2) {
      try {
        cache = normalize(JSON.parse(raw2));
        return cache;
      } catch (e) {}
    }
    var raw1 = storeGet(KEY_V1);
    if (raw1) {
      try {
        cache = migrateFromV1(JSON.parse(raw1));
        save(cache);
        return cache;
      } catch (e2) {}
    }
    cache = defaultSettings();
    return cache;
  }

  function save(next) {
    cache = normalize(next || load());
    try {
      storeSet(KEY_V2, JSON.stringify(cache));
      storeSet("gongwen.settings.rev", String(Date.now()));
    } catch (e) {}
    return cache;
  }

  function get() {
    return load();
  }

  function proofEngineIds(cfg) {
    var s = cfg || load();
    var scene = (s.proof && s.proof.scene) || "政务公文";
    var map = (s.proof && s.proof.sceneEngineMap) || SCENES_DEFAULT;
    var list = map[scene] || SCENES_DEFAULT["政务公文"] || [];
    if (!list.length) return ["typo", "grammar"];
    return list.slice();
  }

  function proofSensitivity(cfg) {
    var s = (cfg || load()).proof;
    var x = s && s.sensitivity;
    return x === "strict" || x === "relaxed" ? x : "normal";
  }

  function proofDefaultScope(cfg) {
    return (cfg || load()).proof.defaultScope === "selection"
      ? "selection"
      : "full";
  }

  function proofWhitelist(cfg) {
    return normalizeWhitelist(((cfg || load()).proof || {}).whitelist);
  }

  function proofMustfix(cfg) {
    return normalizeMustfix(((cfg || load()).proof || {}).mustfix);
  }

  function proofFacts(cfg) {
    var s = (cfg || load()).proof || {};
    var groups = s.factGroups || [];
    var out = [];
    groups.forEach(function (g) {
      if (!g || g.enabled === false) return;
      (g.items || []).forEach(function (it) {
        if (it && it.label && it.value) out.push(it);
      });
    });
    return out.slice(0, 40);
  }

  function suiteCount(cfg) {
    var n = Number((cfg || load()).suite.count);
    return n >= 2 && n <= 6 ? Math.floor(n) : 3;
  }

  function suiteOptView(cfg) {
    return (cfg || load()).suite.optView === "new" ? "new" : "diff";
  }

  function suiteRequireSelection(cfg) {
    return (cfg || load()).suite.requireSelection !== false;
  }

  global.GwSettings = {
    KEY: KEY_V2,
    ENGINE_LABELS: ENGINE_LABELS,
    SCENES_DEFAULT: SCENES_DEFAULT,
    defaultSettings: defaultSettings,
    clone: clone,
    load: load,
    get: get,
    save: save,
    normalize: normalize,
    proofEngineIds: proofEngineIds,
    proofSensitivity: proofSensitivity,
    proofDefaultScope: proofDefaultScope,
    proofWhitelist: proofWhitelist,
    proofMustfix: proofMustfix,
    proofFacts: proofFacts,
    suiteCount: suiteCount,
    suiteOptView: suiteOptView,
    suiteRequireSelection: suiteRequireSelection,
    reload: function () {
      cache = null;
      return load();
    }
  };
})(window);
