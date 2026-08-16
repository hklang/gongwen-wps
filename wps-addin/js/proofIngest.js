/**
 * 校对条「收入」：划选写入账号云库。
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
    return GwRelay.me().catch(function () {
      if (global.GwAccount && GwAccount.open) {
        GwAccount.open({ forceForm: true, mode: "login" });
      }
      var err = new Error("收入需要登录账号");
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

  function closeMenu() {
    var m = $("proofIngestMenu");
    if (m) m.hidden = true;
  }

  function hidePanel() {
    var p = $("proofIngestPanel");
    if (!p) return;
    p.hidden = true;
    p.innerHTML = "";
  }

  function showPanel(html) {
    var p = $("proofIngestPanel");
    if (!p) return;
    p.innerHTML = html;
    p.hidden = false;
  }

  function splitMustfix(raw) {
    var s = String(raw || "").trim();
    var m = s.match(/^(.{1,40})\s*(?:→|->|／|\/)\s*(.{1,40})$/);
    if (m) return { wrong: m[1].trim(), right: m[2].trim() };
    return { wrong: s.slice(0, MAX_WORD), right: "" };
  }

  function ingestWhitelist() {
    var w = selText().replace(/\s+/g, "").slice(0, MAX_WORD);
    if (!w) {
      alert("请先在正文划选要收入的词");
      return;
    }
    needUser()
      .then(function () {
        return GwRelay.mutateUserProof({ op: "add_whitelist", word: w });
      })
      .then(function () {
        tip("已收入白名单「" + w + "」");
      })
      .catch(fail);
  }

  function ingestMustfix() {
    var pair = splitMustfix(selText());
    if (!pair.wrong) {
      alert("请先划选错误写法（或「错→对」）");
      return;
    }
    if (!pair.right) {
      pair.right = String(
        window.prompt("「" + pair.wrong + "」的正确写法", "") || ""
      ).trim();
    }
    if (!pair.right) return;
    needUser()
      .then(function () {
        return GwRelay.mutateUserProof({
          op: "add_mustfix",
          wrong: pair.wrong,
          right: pair.right
        });
      })
      .then(function () {
        tip("已收入必改「" + pair.wrong + " → " + pair.right + "」");
      })
      .catch(fail);
  }

  function ingestFacts() {
    var text = selText();
    if (!text) {
      alert("请先划选含数字的正文");
      return;
    }
    tip("正在抽出数字…");
    needUser()
      .then(function () {
        return GwRelay.mutateUserProof({ op: "extract_facts", text: text });
      })
      .then(function (data) {
        var items = (data && data.items) || [];
        if (!items.length) {
          tip("选区里没有抽出数字");
          alert("选区里没有抽出可对照的数字");
          return;
        }
        showPanel(
          '<p class="ai-proof-ingest-h">抽出 ' +
            items.length +
            " 条，确认后入库</p>" +
            items
              .map(function (it, i) {
                return (
                  '<label class="ai-proof-ingest-row"><input type="checkbox" checked data-fi="' +
                  i +
                  '" /> ' +
                  String(it.label || "") +
                  "　" +
                  String(it.value || "") +
                  String(it.unit || "") +
                  "</label>"
                );
              })
              .join("") +
            '<div class="ai-proof-ingest-acts">' +
            '<button type="button" class="primary" id="proofFactOk">确认收入</button>' +
            '<button type="button" id="proofFactCancel">取消</button></div>'
        );
        $("proofFactCancel").onclick = hidePanel;
        $("proofFactOk").onclick = function () {
          var picked = [];
          Array.prototype.forEach.call(
            $("proofIngestPanel").querySelectorAll("[data-fi]"),
            function (cb) {
              if (cb.checked) picked.push(items[Number(cb.getAttribute("data-fi"))]);
            }
          );
          if (!picked.length) {
            alert("请至少勾一条");
            return;
          }
          GwRelay.mutateUserProof({ op: "add_facts", items: picked })
            .then(function () {
              hidePanel();
              tip("已收入 " + picked.length + " 条数字");
            })
            .catch(fail);
        };
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
    var btn = $("proofIngest");
    var menu = $("proofIngestMenu");
    if (!btn || !menu) return;
    btn.onclick = function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    };
    menu.onclick = function (e) {
      var b = e.target.closest("[data-ingest]");
      if (!b) return;
      closeMenu();
      var k = b.getAttribute("data-ingest");
      if (k === "whitelist") ingestWhitelist();
      else if (k === "mustfix") ingestMustfix();
      else if (k === "facts") ingestFacts();
    };
    document.addEventListener("click", function (e) {
      if (!e.target.closest || e.target.closest("#proofIngestWrap")) return;
      closeMenu();
    });
  }

  global.GwProofIngest = { init: init, absorbIssue: absorbIssue, hidePanel: hidePanel };
})(window);
