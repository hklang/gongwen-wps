(function (global) {
  var KEYS = {
    base: "gw_relay_base",
    access: "gw_access",
    refresh: "gw_refresh",
    email: "gw_email",
    accessExp: "gw_access_exp"
  };

  function storage() {
    try {
      return global.Application && global.Application.PluginStorage;
    } catch (e) {
      return null;
    }
  }

  function storeGet(k) {
    var s = storage();
    if (s) {
      try {
        var v = s.getItem(k);
        if (v != null && v !== "") return String(v);
      } catch (e) {}
    }
    try {
      return localStorage.getItem(k) || "";
    } catch (e2) {
      return "";
    }
  }

  function storeSet(k, v) {
    var s = storage();
    if (s) {
      try {
        s.setItem(k, String(v == null ? "" : v));
      } catch (e) {}
    }
    try {
      localStorage.setItem(k, String(v == null ? "" : v));
    } catch (e2) {}
  }

  function baseUrl() {
    return String(storeGet(KEYS.base) || "").replace(/\/+$/, "");
  }

  function setBase(url) {
    storeSet(KEYS.base, String(url || "").replace(/\/+$/, ""));
  }

  function tokens() {
    return {
      access: storeGet(KEYS.access),
      refresh: storeGet(KEYS.refresh),
      email: storeGet(KEYS.email),
      exp: Number(storeGet(KEYS.accessExp) || 0) || 0
    };
  }

  function setSession(data, email) {
    if (!data) return;
    if (data.access_token) storeSet(KEYS.access, data.access_token);
    if (data.refresh_token) storeSet(KEYS.refresh, data.refresh_token);
    var em =
      email ||
      (data.user && data.user.email) ||
      storeGet(KEYS.email) ||
      "";
    if (em) storeSet(KEYS.email, em);
    var exp =
      Math.floor(Date.now() / 1000) + Number(data.expires_in || 1800) - 60;
    storeSet(KEYS.accessExp, String(exp));
  }

  function clearSession() {
    storeSet(KEYS.access, "");
    storeSet(KEYS.refresh, "");
    storeSet(KEYS.email, "");
    storeSet(KEYS.accessExp, "0");
  }

  function isLoggedIn() {
    return !!(tokens().access || tokens().refresh);
  }

  function friendlyError(err) {
    if (!err) return "请求失败";
    var status = err.status;
    var msg = String(err.message || err || "");
    if (status === 401 || /unauthorized|请先登录|登录/i.test(msg)) {
      return "请先登录账号";
    }
    if (status === 402 || /额度|quota|用尽/i.test(msg)) {
      return "额度已用尽，请联系开通或明日再试";
    }
    if (status === 429) return "请求过于频繁，请稍后再试";
    if (status === 503) return msg || "服务维护中";
    if (
      /Failed to fetch|NetworkError|网络|ECONNREFUSED|timed out|Timeout|aborted|AbortError/i.test(
        msg
      )
    ) {
      return (
        "中转无响应（" +
        (baseUrl() || "未配置地址") +
        "）。未启动，或请求过久被中断——确认 127.0.0.1:3000 后重发。"
      );
    }
    return msg || "请求失败";
  }

  function request(method, path, body, useAuth) {
    var url = baseUrl() + path;
    var headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Gongwen-Client": "wps-addin"
    };
    if (useAuth !== false) {
      var t = tokens().access;
      if (t) headers.Authorization = "Bearer " + t;
    }
    return fetch(url, {
      method: method,
      headers: headers,
      body: body == null ? undefined : JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (text) {
        var json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (e) {
          json = { raw: text };
        }
        if (res.status === 401 && useAuth !== false && tokens().refresh) {
          return refreshOnce().then(function (ok) {
            if (!ok) {
              clearSession();
              var err = new Error("请先登录账号");
              err.status = 401;
              throw err;
            }
            return request(method, path, body, useAuth);
          });
        }
        if (!res.ok) {
          var msg =
            (json && (json.error || json.message || json.detail)) ||
            "HTTP " + res.status;
          var err2 = new Error(
            typeof msg === "string" ? msg : JSON.stringify(msg)
          );
          err2.status = res.status;
          err2.body = json;
          throw err2;
        }
        return json;
      });
    });
  }

  var refreshing = null;
  function refreshOnce() {
    if (refreshing) return refreshing;
    var rt = tokens().refresh;
    if (!rt) return Promise.resolve(false);
    refreshing = fetch(baseUrl() + "/api/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Gongwen-Client": "wps-addin"
      },
      body: JSON.stringify({ refresh_token: rt })
    })
      .then(function (res) {
        return res.json().then(function (j) {
          if (!res.ok || !j || !j.access_token) return false;
          setSession(j, tokens().email);
          return true;
        });
      })
      .catch(function () {
        return false;
      })
      .then(function (ok) {
        refreshing = null;
        return ok;
      });
    return refreshing;
  }

  /** 保证有可用 access；过期则 refresh。无票则 false。 */
  function ensureAccess() {
    var t = tokens();
    var now = Math.floor(Date.now() / 1000);
    if (t.access && t.exp > now + 5) return Promise.resolve(true);
    if (t.access && !t.exp) return Promise.resolve(true);
    if (!t.refresh) return Promise.resolve(!!t.access);
    return refreshOnce().then(function (ok) {
      return !!ok || !!tokens().access;
    });
  }

  function health() {
    return request("GET", "/api/health", null, false);
  }

  function login(email, password) {
    return request(
      "POST",
      "/api/auth/login",
      { email: email, password: password },
      false
    ).then(function (data) {
      if (!data || !data.access_token) throw new Error("登录响应无 token");
      setSession(data, email);
      return data;
    });
  }

  function register(email, password, inviteCode) {
    return request(
      "POST",
      "/api/auth/register",
      {
        email: email,
        password: password,
        invite_code: String(inviteCode || "").trim()
      },
      false
    ).then(function (data) {
      if (!data || !data.access_token) throw new Error("注册响应无 token");
      setSession(data, email);
      return data;
    });
  }

  function me() {
    return request("GET", "/api/auth/me");
  }

  function quota() {
    return request("GET", "/api/quota");
  }

  function suggest(md, requirement, capability, materials, extra) {
    var body = {
      md: md,
      requirement: requirement || "",
      capability: capability === "strong" ? "strong" : "fast",
      count: 2
    };
    if (materials && materials.length) body.materials = materials;
    if (extra && typeof extra === "object") {
      if (extra.workspace) body.workspace = extra.workspace;
      if (extra.read_set) body.read_set = extra.read_set;
      if (Array.isArray(extra.items) && extra.items.length)
        body.items = extra.items;
      if (extra.count != null) body.count = extra.count;
      if (extra.tab) body.tab = extra.tab;
    }
    return request("POST", "/api/suggest", body);
  }

  function proofread(text, engines, extra) {
    var body = {
      text: text,
      md: text,
      capability: "proof"
    };
    if (engines && engines.length) body.engines = engines;
    if (extra && typeof extra === "object") {
      if (extra.sensitivity) body.sensitivity = extra.sensitivity;
      if (extra.whitelist) body.whitelist = extra.whitelist;
      if (extra.mustfix) body.mustfix = extra.mustfix;
      if (extra.facts) body.facts = extra.facts;
    }
    return request("POST", "/api/proofread", body);
  }

  function chat(message, contextMd, capability, allowEdit, materials, extra) {
    var body = {
      message: message,
      context_md: contextMd || "",
      capability: capability === "strong" ? "strong" : "fast",
      allow_edit: !!allowEdit
    };
    if (materials && materials.length) body.materials = materials;
    if (extra && typeof extra === "object") {
      [
        "workspace",
        "tool_results",
        "read_set",
        "force_final",
        "session_summary",
        "project_memory",
        "history",
        "doc_md",
        "assistant_reasoning",
        "gather_only",
        "want_options",
        "write_levels",
        "option_count"
      ].forEach(function (k) {
        if (extra[k] != null) body[k] = extra[k];
      });
    }
    return request("POST", "/api/chat", body);
  }

  function genres() {
    return request("GET", "/api/genres", null, false);
  }

  function listTemplates(categoryCode) {
    var q = encodeURIComponent(String(categoryCode || "").trim());
    return request("GET", "/api/templates?category=" + q, null, false);
  }

  function getTemplate(code, categoryCode) {
    var q =
      "?code=" +
      encodeURIComponent(String(code || "").trim()) +
      "&category=" +
      encodeURIComponent(String(categoryCode || "").trim());
    return ensureAccess().then(function (ok) {
      if (!ok) {
        var err = new Error("请先登录账号");
        err.status = 401;
        return Promise.reject(err);
      }
      return request("GET", "/api/template" + q);
    });
  }

  function listUserTemplates() {
    return ensureAccess().then(function (ok) {
      if (!ok) {
        var err = new Error("请先登录账号");
        err.status = 401;
        return Promise.reject(err);
      }
      return request("GET", "/api/user/templates");
    });
  }

  function getUserTemplate(id) {
    return ensureAccess().then(function (ok) {
      if (!ok) {
        var err = new Error("请先登录账号");
        err.status = 401;
        return Promise.reject(err);
      }
      return request(
        "GET",
        "/api/user/templates?id=" + encodeURIComponent(String(id || ""))
      );
    });
  }

  function mutateUserTemplate(body) {
    return ensureAccess().then(function (ok) {
      if (!ok) {
        var err = new Error("请先登录账号");
        err.status = 401;
        return Promise.reject(err);
      }
      return request("POST", "/api/user/templates", body || {});
    });
  }

  function getUserProof() {
    return ensureAccess().then(function (ok) {
      if (!ok) {
        var err = new Error("请先登录账号");
        err.status = 401;
        return Promise.reject(err);
      }
      return request("GET", "/api/user/proof");
    });
  }

  function mutateUserProof(body) {
    return ensureAccess().then(function (ok) {
      if (!ok) {
        var err = new Error("请先登录账号");
        err.status = 401;
        return Promise.reject(err);
      }
      return request("POST", "/api/user/proof", body || {});
    });
  }

  global.GwRelay = {
    KEYS: KEYS,
    baseUrl: baseUrl,
    setBase: setBase,
    tokens: tokens,
    setSession: setSession,
    clearSession: clearSession,
    isLoggedIn: isLoggedIn,
    ensureAccess: ensureAccess,
    friendlyError: friendlyError,
    storeGet: storeGet,
    storeSet: storeSet,
    health: health,
    login: login,
    register: register,
    me: me,
    quota: quota,
    suggest: suggest,
    proofread: proofread,
    chat: chat,
    genres: genres,
    listTemplates: listTemplates,
    getTemplate: getTemplate,
    listUserTemplates: listUserTemplates,
    getUserTemplate: getUserTemplate,
    mutateUserTemplate: mutateUserTemplate,
    getUserProof: getUserProof,
    mutateUserProof: mutateUserProof
  };
})(window);
