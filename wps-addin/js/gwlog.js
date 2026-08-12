/**
 * 插件调试日志：控制台 + localStorage 环形缓冲。
 * 控制台：GwLog.dump() / GwLog.copy() / GwLog.clear()
 */
(function (global) {
  var KEY = "gongwen.debug.log.v1";
  var MAX = 500;
  var buf = [];

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return;
      var arr = JSON.parse(raw);
      if (Array.isArray(arr)) buf = arr.slice(-MAX);
    } catch (e) {}
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(buf.slice(-MAX)));
    } catch (e) {}
  }

  function trunc(v) {
    if (v == null) return "";
    if (typeof v === "string") {
      return v.length > 600 ? v.slice(0, 600) + "…" : v;
    }
    try {
      var s = JSON.stringify(v);
      return s.length > 800 ? s.slice(0, 800) + "…" : s;
    } catch (e) {
      return String(v);
    }
  }

  function push(level, tag, detail) {
    var row = {
      t: new Date().toISOString(),
      level: level || "info",
      tag: String(tag || ""),
      detail: trunc(detail)
    };
    buf.push(row);
    if (buf.length > MAX) buf = buf.slice(-MAX);
    save();
    try {
      var fn =
        level === "error"
          ? console.error
          : level === "warn"
            ? console.warn
            : console.log;
      fn.call(console, "[gw:" + row.tag + "]", detail == null ? "" : detail);
    } catch (e2) {}
    return row;
  }

  function dump() {
    return buf.slice();
  }

  function text() {
    return buf
      .map(function (r) {
        return r.t + "\t" + r.level + "\t" + r.tag + "\t" + r.detail;
      })
      .join("\n");
  }

  function copy() {
    var t = text();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(
        function () {
          return true;
        },
        function () {
          return false;
        }
      );
    }
    return Promise.resolve(false);
  }

  function clear() {
    buf = [];
    save();
  }

  load();
  push("info", "log.boot", {
    href: String((global.location && location.href) || ""),
    ua: String((global.navigator && navigator.userAgent) || "").slice(0, 120)
  });

  global.GwLog = {
    info: function (tag, d) {
      return push("info", tag, d);
    },
    warn: function (tag, d) {
      return push("warn", tag, d);
    },
    error: function (tag, d) {
      return push("error", tag, d);
    },
    dump: dump,
    text: text,
    copy: copy,
    clear: clear,
    size: function () {
      return buf.length;
    }
  };
})(window);
