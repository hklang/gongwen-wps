(function (global) {
  /**
   * 联调临时：用运维票直连中转，不走用户额度。
   * 正式上线前务必将 AUTO_BYPASS_QUOTA 改为 false。
   */
  var DEBUG = {
    AUTO_BYPASS_QUOTA: true,
    /** 与 editor/settings.py 本机中转票一致，仅供联调 */
    legacyToken: "gongwen-rly-7c4e9a2b1f08d635",
    email: "wps-debug@gongwen.local",
    password: "GongwenTest1"
  };

  var state = {
    mode: "login",
    registerMode: "open",
    busy: false,
    boot: null
  };

  function $(id) {
    return document.getElementById(id);
  }

  function ensureBase() {
    /* 现阶段固定本机中转，避免每次改完还要部署云机 */
    GwRelay.setBase("http://127.0.0.1:3000");
  }

  function tip(msg) {
    var el = $("aiTip");
    if (el) el.textContent = msg || "";
  }

  function fillDebugForm() {
    var email = $("gwAccEmail");
    var pass = $("gwAccPass");
    if (email && !email.value) email.value = DEBUG.email;
    if (pass && !pass.value) pass.value = DEBUG.password;
  }

  function setInviteVisible(on) {
    var inv = $("gwAccInviteWrap");
    if (!inv) return;
    inv.hidden = !on;
    inv.style.display = on ? "" : "none";
  }

  /** 写入运维票：mode=legacy，服务端不查用户额度 */
  function applyLegacyBypass() {
    if (!DEBUG.AUTO_BYPASS_QUOTA || !DEBUG.legacyToken) return false;
    GwRelay.setSession(
      {
        access_token: DEBUG.legacyToken,
        refresh_token: "",
        expires_in: 86400 * 365
      },
      "测试模式·不限额度"
    );
    try {
      GwRelay.storeSet(GwRelay.KEYS.refresh, "");
    } catch (e) {}
    return true;
  }

  /** 启动：优先运维票放行；否则再试测试账号登录 */
  function bootstrapDebugSession() {
    if (state.boot) return state.boot;
    ensureBase();
    state.boot = Promise.resolve()
      .then(function () {
        if (applyLegacyBypass()) return true;
        return GwRelay.ensureAccess().then(function (ok) {
          if (ok && GwRelay.tokens().access) return true;
          tip("正在用测试账号登录…");
          return GwRelay.login(DEBUG.email, DEBUG.password)
            .then(function () {
              return true;
            })
            .catch(function () {
              return GwRelay.register(DEBUG.email, DEBUG.password, "").then(
                function () {
                  return true;
                }
              );
            });
        });
      })
      .then(function (ok) {
        refreshButton();
        if (ok && GwRelay.tokens().access) {
          tip(
            DEBUG.AUTO_BYPASS_QUOTA
              ? "测试模式已开启 · 不限额度"
              : "测试账号已登录 · " + DEBUG.email
          );
          return true;
        }
        refreshTip();
        return false;
      })
      .catch(function () {
        refreshTip();
        return false;
      });
    return state.boot;
  }

  function ensureDom() {
    if ($("gwAccountBtn")) return;
    var actions = $("aiHeadActions");
    if (actions) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.id = "gwAccountBtn";
      btn.className = "ai-account-btn";
      btn.title = "账号";
      btn.textContent = "登录";
      /* 设置钮在左（⚙ | 账号）；若尚无设置钮则先占位，settings 会 insertBefore */
      actions.appendChild(btn);
      btn.onclick = function () {
        openModal();
      };
    }
    if ($("gwAccountModal")) return;
    var wrap = document.createElement("div");
    wrap.id = "gwAccountModal";
    wrap.className = "gw-acc-modal";
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="gw-acc-backdrop" data-acc-close></div>' +
      '<div class="gw-acc-card" role="dialog" aria-modal="true" aria-labelledby="gwAccTitle">' +
      '  <div class="gw-acc-head">' +
      '    <strong id="gwAccTitle">账号</strong>' +
      '    <button type="button" class="gw-acc-x" data-acc-close aria-label="关闭">×</button>' +
      "  </div>" +
      '  <div class="gw-acc-tabs" id="gwAccTabs">' +
      '    <button type="button" class="on" data-acc-mode="login">登录</button>' +
      '    <button type="button" data-acc-mode="register">注册</button>' +
      "  </div>" +
      '  <div class="gw-acc-body" id="gwAccForm">' +
      '    <label class="gw-acc-field">邮箱<input id="gwAccEmail" type="email" autocomplete="username" placeholder="you@example.com" /></label>' +
      '    <label class="gw-acc-field">密码<input id="gwAccPass" type="password" autocomplete="current-password" placeholder="至少 8 位" /></label>' +
      '    <label class="gw-acc-field" id="gwAccInviteWrap" hidden style="display:none">邀请码<input id="gwAccInvite" type="text" placeholder="可选 / 必填视开放策略" /></label>' +
      '    <p class="gw-acc-err" id="gwAccErr" hidden></p>' +
      "  </div>" +
      '  <div class="gw-acc-body" id="gwAccSigned" hidden>' +
      '    <p class="gw-acc-email" id="gwAccSignedEmail"></p>' +
      '    <p class="gw-acc-quota" id="gwAccQuota">额度加载中…</p>' +
      "  </div>" +
      '  <div class="gw-acc-foot">' +
      '    <button type="button" id="gwAccLogout" hidden>退出登录</button>' +
      '    <span class="spacer"></span>' +
      '    <button type="button" data-acc-close>取消</button>' +
      '    <button type="button" class="primary" id="gwAccSubmit">登录</button>' +
      "  </div>" +
      "</div>";
    document.body.appendChild(wrap);
    wrap.addEventListener("click", function (e) {
      if (e.target && e.target.getAttribute("data-acc-close") != null) {
        closeModal();
      }
    });
    $("gwAccTabs").onclick = function (e) {
      var b = e.target.closest("[data-acc-mode]");
      if (!b) return;
      setMode(b.getAttribute("data-acc-mode"));
    };
    $("gwAccSubmit").onclick = submit;
    $("gwAccLogout").onclick = logout;
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && $("gwAccountModal") && !$("gwAccountModal").hidden) {
        closeModal();
      }
    });
  }

  function setMode(mode) {
    state.mode = mode === "register" ? "register" : "login";
    Array.prototype.forEach.call(
      document.querySelectorAll("#gwAccTabs [data-acc-mode]"),
      function (b) {
        b.classList.toggle("on", b.getAttribute("data-acc-mode") === state.mode);
      }
    );
    $("gwAccTitle").textContent = state.mode === "register" ? "注册" : "登录";
    $("gwAccSubmit").textContent = state.mode === "register" ? "注册并登录" : "登录";
    setInviteVisible(
      state.mode === "register" && state.registerMode !== "closed"
    );
    fillDebugForm();
    setErr("");
  }

  function setErr(msg) {
    var el = $("gwAccErr");
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  function setBusy(on) {
    state.busy = !!on;
    var sub = $("gwAccSubmit");
    if (sub) sub.disabled = !!on;
  }

  function refreshButton() {
    var btn = $("gwAccountBtn");
    if (!btn) return;
    var t = GwRelay.tokens();
    if (t.access || t.refresh) {
      if (DEBUG.AUTO_BYPASS_QUOTA && t.email && t.email.indexOf("测试") >= 0) {
        btn.textContent = "测试";
        btn.title = "测试模式：不限额度";
      } else {
        var short = (t.email || "已登录").split("@")[0];
        if (short.length > 8) short = short.slice(0, 8) + "…";
        btn.textContent = short;
        btn.title = t.email ? "账号：" + t.email : "已登录";
      }
      btn.classList.add("on");
    } else {
      btn.textContent = "登录";
      btn.title = "登录账号后才能使用智能功能";
      btn.classList.remove("on");
    }
  }

  function refreshTip() {
    var t = GwRelay.tokens();
    if (DEBUG.AUTO_BYPASS_QUOTA && t.access) {
      tip("测试模式已开启 · 不限额度");
      return;
    }
    if (t.access || t.refresh) {
      tip(t.email ? "已登录 · " + t.email : "已登录");
    } else {
      tip("未登录 · 点右上角登录后可对话");
    }
  }

  function paintSigned(signed) {
    var form = $("gwAccForm");
    var box = $("gwAccSigned");
    var tabs = $("gwAccTabs");
    var submit = $("gwAccSubmit");
    var logoutBtn = $("gwAccLogout");
    if (!form || !box) return;
    form.hidden = !!signed;
    box.hidden = !signed;
    if (tabs) tabs.hidden = !!signed;
    if (submit) submit.hidden = !!signed;
    if (logoutBtn) logoutBtn.hidden = !signed;
    if (signed) {
      $("gwAccTitle").textContent = "账号与额度";
      var em = GwRelay.tokens().email || "已登录";
      $("gwAccSignedEmail").textContent = em;
      $("gwAccQuota").textContent = "额度加载中…";
      GwRelay.quota()
        .then(function (q) {
          if (!q || !q.ok) {
            $("gwAccQuota").textContent = "暂无法读取额度";
            return;
          }
          var p = q.plan || {};
          $("gwAccQuota").textContent =
            "今日剩余 " +
            q.remain_day +
            "/" +
            (p.daily_requests != null ? p.daily_requests : "—") +
            " · 本月 " +
            q.remain_month +
            "/" +
            (p.monthly_requests != null ? p.monthly_requests : "—") +
            (p.name ? " · " + p.name : "");
        })
        .catch(function () {
          $("gwAccQuota").textContent = "暂无法读取额度";
        });
    }
  }

  function openModal(opts) {
    ensureDom();
    ensureBase();
    setErr("");
    var forceForm = opts && opts.forceForm;
    var logged = GwRelay.isLoggedIn();
    if (logged && !forceForm) {
      paintSigned(true);
    } else {
      paintSigned(false);
      setMode(opts && opts.mode === "register" ? "register" : "login");
      fillDebugForm();
      GwRelay.health()
        .then(function (h) {
          state.registerMode = (h && h.register_mode) || "open";
          setMode(state.mode);
          fillDebugForm();
        })
        .catch(function () {});
    }
    $("gwAccountModal").hidden = false;
    var email = $("gwAccEmail");
    if (email && !($("gwAccForm") && $("gwAccForm").hidden)) {
      setTimeout(function () {
        email.focus();
      }, 30);
    }
  }

  function closeModal() {
    var m = $("gwAccountModal");
    if (m) m.hidden = true;
  }

  function submit() {
    if (state.busy) return;
    ensureBase();
    var email = ($("gwAccEmail").value || "").trim();
    var pass = $("gwAccPass").value || "";
    var invite = ($("gwAccInvite") && $("gwAccInvite").value) || "";
    if (!email || !pass) {
      setErr("请填写邮箱和密码");
      return;
    }
    if (state.mode === "register" && pass.length < 8) {
      setErr("密码至少 8 位");
      return;
    }
    if (
      state.mode === "register" &&
      state.registerMode === "invite" &&
      !String(invite).trim()
    ) {
      setErr("需要邀请码才能注册");
      return;
    }
    if (state.mode === "register" && state.registerMode === "closed") {
      setErr("当前未开放注册，请直接登录或联系开通");
      return;
    }
    setBusy(true);
    setErr("");
    var p =
      state.mode === "register"
        ? GwRelay.register(email, pass, invite)
        : GwRelay.login(email, pass);
    p.then(function () {
      $("gwAccPass").value = "";
      refreshButton();
      refreshTip();
      paintSigned(true);
      tip("登录成功");
    })
      .catch(function (e) {
        setErr(GwRelay.friendlyError(e));
      })
      .then(function () {
        setBusy(false);
      });
  }

  function logout() {
    GwRelay.clearSession();
    refreshButton();
    refreshTip();
    paintSigned(false);
    setMode("login");
    tip("已退出登录");
  }

  /** 发 AI 前：已登录账号则跟账号；否则测试模式用运维票；再否则弹登录 */
  function requireLogin() {
    ensureBase();
    var em = (GwRelay.tokens().email || "");
    if (em.indexOf("@") >= 0) {
      return GwRelay.ensureAccess().then(function (ok) {
        refreshButton();
        if (ok && GwRelay.tokens().access) return true;
        openModal({ forceForm: true, mode: "login" });
        tip("请先登录账号");
        var err = new Error("请先登录账号");
        err.status = 401;
        throw err;
      });
    }
    if (DEBUG.AUTO_BYPASS_QUOTA && applyLegacyBypass()) {
      refreshButton();
      return Promise.resolve(true);
    }
    return bootstrapDebugSession().then(function (ok) {
      refreshButton();
      if (ok && GwRelay.tokens().access) return true;
      openModal({ forceForm: true, mode: "login" });
      tip("请先登录账号（已预填测试账号）");
      var err = new Error("请先登录账号");
      err.status = 401;
      throw err;
    });
  }

  function init() {
    ensureBase();
    ensureDom();
    fillDebugForm();
    refreshButton();
    tip(DEBUG.AUTO_BYPASS_QUOTA ? "正在开启测试模式…" : "正在准备测试账号…");
    /* 清掉旧用户短票，避免继续撞额度 */
    if (DEBUG.AUTO_BYPASS_QUOTA) {
      try {
        GwRelay.clearSession();
      } catch (e0) {}
      state.boot = null;
    }
    bootstrapDebugSession().then(function (ok) {
      refreshButton();
      if (!ok) refreshTip();
    });
  }

  global.GwAccount = {
    init: init,
    open: openModal,
    close: closeModal,
    requireLogin: requireLogin,
    refresh: function () {
      refreshButton();
      refreshTip();
    }
  };
})(window);
