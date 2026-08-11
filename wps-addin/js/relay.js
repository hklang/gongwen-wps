(function (global) {
  var KEYS = {
    base: "gw_relay_base",
    access: "gw_access",
    refresh: "gw_refresh",
    email: "gw_email"
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
      email: storeGet(KEYS.email)
    };
  }

  function setSession(data, email) {
    if (data && data.access_token) storeSet(KEYS.access, data.access_token);
    if (data && data.refresh_token) storeSet(KEYS.refresh, data.refresh_token);
    if (email) storeSet(KEYS.email, email);
  }

  function clearSession() {
    storeSet(KEYS.access, "");
    storeSet(KEYS.refresh, "");
  }

  function request(method, path, body, useAuth) {
    var url = baseUrl() + path;
    var headers = { "Content-Type": "application/json", Accept: "application/json" };
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
        if (res.status === 401 && tokens().refresh) {
          return refreshOnce().then(function (ok) {
            if (!ok) {
              var err = new Error("需要登录短票（本轮未接登录 UI）");
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
          var err2 = new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
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
      headers: { "Content-Type": "application/json" },
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

  function suggest(md, requirement, capability, materials) {
    var body = {
      md: md,
      requirement: requirement || "",
      capability: capability === "strong" ? "strong" : "fast",
      count: 2
    };
    if (materials && materials.length) body.materials = materials;
    return request("POST", "/api/suggest", body);
  }

  function proofread(text) {
    return request("POST", "/api/proofread", {
      text: text,
      md: text,
      capability: "proof"
    });
  }

  function chat(message, contextMd, capability, allowEdit, materials) {
    var body = {
      message: message,
      context_md: contextMd || "",
      capability: capability === "strong" ? "strong" : "fast",
      allow_edit: !!allowEdit
    };
    if (materials && materials.length) body.materials = materials;
    return request("POST", "/api/chat", body);
  }

  global.GwRelay = {
    KEYS: KEYS,
    baseUrl: baseUrl,
    setBase: setBase,
    tokens: tokens,
    setSession: setSession,
    clearSession: clearSession,
    storeGet: storeGet,
    storeSet: storeSet,
    login: login,
    suggest: suggest,
    proofread: proofread,
    chat: chat
  };
})(window);
