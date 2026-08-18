/**
 * 校对条三键：划选写入账号云库（词典 / 必改 / 数据）。
 */
(function (global) {
  var MAX_WORD = 40;

  function $(id) {
    return document.getElementById(id);
  }

  function tip(msg) {
    var el = $("aiTip");
    if (el) el.textContent = msg || "";
  }

  function selText() {
    try {
      return String(
        (global.GwDoc && GwDoc.getSelectionText && GwDoc.getSelectionText()) ||
          ""
      ).trim();
    } catch (e) {
      return "";
    }
  }

  function needUser() {
    if (global.GwAccount && GwAccount.ensureUserAccount) {
      return GwAccount.ensureUserAccount();
    }
    return GwRelay.me().catch(function () {
      if (global.GwAccount && GwAccount.open) {
        GwAccount.open({ forceForm: true, mode: "login" });
      }
      var err = new Error("写入词库需要登录账号");
      err.status = 401;
      throw err;
    });
  }

  function fail(e) {
    var msg =
      (GwRelay.friendlyError && GwRelay.friendlyError(e)) ||
      (e && e.message) ||
      "失败";
    tip(msg);
    try {
      alert(msg);
    } catch (e2) {}
  }

  function hidePanel() {
    var p = $("proofIngestPanel");
    if (!p) return;
    p.hidden = true;
    p.innerHTML = "";
  }

  function splitMustfix(raw) {
    var s = String(raw || "").trim();
    var m = s.match(/^(.{1,40})\s*(?:→|->|／|\/)\s*(.{1,40})$/);
    if (m) return { wrong: m[1].trim(), right: m[2].trim() };
    return { wrong: s.slice(0, MAX_WORD), right: "" };
  }

  function activeCard() {
    return (
      (global.GwProofUi && GwProofUi.activeItem && GwProofUi.activeItem()) ||
      null
    );
  }

  function ingestWhitelist() {
    var w = selText().replace(/\s+/g, "").slice(0, MAX_WORD);
    if (!w) {
      tip("请先在正文划选");
      return;
    }
    needUser()
      .then(function () {
        return GwRelay.mutateUserProof({ op: "add_whitelist", word: w });
      })
      .then(function () {
        tip("已写入词典「" + w + "」");
      })
      .catch(fail);
  }

  function ingestMustfix() {
    var raw = selText();
    var pair = raw ? splitMustfix(raw) : { wrong: "", right: "" };
    if (!pair.right) {
      var card = activeCard();
      var orig = card ? String(card.original || "").trim() : "";
      var sug = card ? String(card.suggestion || "").trim() : "";
      if (orig && sug) {
        pair = {
          wrong: orig.slice(0, MAX_WORD),
          right: sug.slice(0, MAX_WORD)
        };
      }
    }
    if (!pair.wrong || !pair.right) {
      tip(raw ? "请先划选「错→对」，或点一条校对结果" : "请先在正文划选");
      return;
    }
    needUser()
      .then(function () {
        return GwRelay.mutateUserProof({
          op: "add_mustfix",
          wrong: pair.wrong,
          right: pair.right
        });
      })
      .then(function () {
        tip("已写入必改「" + pair.wrong + " → " + pair.right + "」");
      })
      .catch(fail);
  }

  function todayYmd() {
    var d = new Date();
    function pad(n) {
      return n < 10 ? "0" + n : String(n);
    }
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function cnDay(ymd) {
    var m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return ymd || "";
    return m[1] + "年" + Number(m[2]) + "月" + Number(m[3]) + "日";
  }

  function ingestFacts() {
    var text = selText();
    if (!text) {
      tip("请先在正文划选");
      return;
    }
    if (text.length > 4000) {
      tip("选区过长，请划一小段再收录");
      return;
    }
    hidePanel();
    var day = todayYmd();
    needUser()
      .then(function () {
        return GwRelay.mutateUserProof({
          op: "add_facts",
          snippet: text,
          recorded_at: day
        });
      })
      .then(function () {
        tip("已收录（" + cnDay(day) + "）");
      })
      .catch(fail);
  }

  function absorbIssue(kind, item) {
    if (!item) return Promise.resolve();
    if (kind === "whitelist") {
      var w = String(item.original || "").trim().slice(0, MAX_WORD);
      if (!w) return Promise.reject(new Error("没有可收入的原文"));
      return needUser().then(function () {
        return GwRelay.mutateUserProof({ op: "add_whitelist", word: w });
      });
    }
    var wrong = String(item.original || "").trim().slice(0, MAX_WORD);
    var right = String(item.suggestion || "").trim().slice(0, MAX_WORD);
    if (!wrong || !right) return Promise.reject(new Error("这条没有成对写法"));
    return needUser().then(function () {
      return GwRelay.mutateUserProof({
        op: "add_mustfix",
        wrong: wrong,
        right: right
      });
    });
  }

  function init() {
    var wrap = $("proofIngestWrap");
    if (!wrap) return;
    wrap.onclick = function (e) {
      var b = e.target.closest("[data-ingest]");
      if (!b) return;
      var k = b.getAttribute("data-ingest");
      if (k === "whitelist") ingestWhitelist();
      else if (k === "mustfix") ingestMustfix();
      else if (k === "facts") ingestFacts();
    };
  }

  global.GwProofIngest = { init: init, absorbIssue: absorbIssue, hidePanel: hidePanel };
})(window);
