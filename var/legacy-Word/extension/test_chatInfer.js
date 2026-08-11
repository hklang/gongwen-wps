/**
 * node Word/extension/test_chatInfer.js
 * 用例用虚构标题/素材，禁止依赖某一真实项目专名写进产品代码。
 */
const assert = require("assert");
const chatInfer = require("./chatInfer");

const msg =
  "【@素材/alpha-项目进展简报.md\n" +
  "【（二）推进阿尔法专项，夯实交付节点】帮我写一下这部分。也是重点读这个文件中找";

assert.ok(chatInfer.wantsApplyToFile(msg), "帮我写一下这部分 → 要落稿");
assert.ok(chatInfer.wantsFillSection(msg), "要填段");

const doc = [
  "# 示例文稿\n",
  "## 一、\n",
  "### （二）旧标题占位\n",
  "\n旧正文\n",
].join("\n");

const tools = [
  {
    name: "read_file",
    result: {
      ok: true,
      path: "素材/alpha-项目进展简报.md",
      text:
        "阿尔法专项按节点推进。一期已完成联调，二期正在安装关键设备，" +
        "倒排工期、挂图作战，目标季度内交付验收。\n\n" +
        "另有无关段落：关于食堂订餐流程的说明文字凑字数用。",
    },
  },
];

const edit = chatInfer.inferFillSectionEdit(msg, doc, tools);
assert.ok(edit && edit.md, "应生成可 Keep 的 edit");
assert.ok(/推进阿尔法专项/.test(edit.md), "应写入目标小标题");
assert.ok(/联调|关键设备|交付/.test(edit.md), "应从素材抽相关句");
assert.ok(!/食堂订餐/.test(edit.md), "不应整篇无关段落灌入");

const patched = chatInfer.patchChatResult(
  {
    allow_edit: true,
    message: msg,
    doc_md: doc,
    tool_results: tools,
    history: [],
  },
  { reply: "已读取素材，将阿尔法专项内容写入（二）…", edit: null }
);
assert.ok(patched.edit && patched.edit.md, "口头说写了 → 本地补 edit");
assert.ok(patched._localInfer);

const sampleBody =
  "本段为用户已写好的范例正文，用于校验本地是否原样保留范例而不改写成套话。" +
  "句式完整即可，后续段落应另据素材填充。";
const fullMsg =
  "【### （一）开篇示范段标题\n\n" +
  sampleBody +
  "】这部分已经写好了，非常好。你也知道怎么写了。帮我把整个文章的初稿写好，按照格式写入到文件里。";

assert.ok(chatInfer.wantsFullDraft(fullMsg), "整篇初稿意图");
const samples = chatInfer.extractSampleSections(fullMsg);
assert.ok(samples.length >= 1, "抽出范例段");
assert.ok(/开篇示范段标题/.test(samples[0].head));
assert.ok(samples[0].body.indexOf("用户已写好的范例") >= 0);

const sparseDoc = [
  "# 示例文稿\n",
  "## 一、\n",
  "### （一）旧标题\n",
  "\n【待补】\n",
  "### （二）推进阿尔法专项，夯实交付节点\n",
  "\n【待补】\n",
  "## 二、\n",
  "### （一）贝塔板块要点\n",
  "\n【待补】\n",
].join("\n");

const fullEdit = chatInfer.inferFullDraftEdit(fullMsg, sparseDoc, tools, []);
assert.ok(fullEdit && fullEdit.md, "整篇应出 edit");
assert.ok(/开篇示范段标题/.test(fullEdit.md), "范例标题写入");
assert.ok(/用户已写好的范例/.test(fullEdit.md), "范例正文写入");

const partialMd =
  "# 示例文稿\n\n" +
  "## 一、\n\n" +
  "### （一）旧标题\n\n【待补】\n\n" +
  "### （二）推进阿尔法专项，夯实交付节点\n\n" +
  "阿尔法专项已成立专班，按节点推进交付。\n\n" +
  "## 二、\n\n" +
  "### （一）贝塔板块要点\n\n【待补】\n";
assert.ok(
  chatInfer.isIncompleteFullDraft(partialMd, sparseDoc, fullMsg),
  "仅一段有正文 = 残缺"
);

const fixed = chatInfer.patchChatResult(
  {
    allow_edit: true,
    message: fullMsg,
    doc_md: sparseDoc,
    tool_results: tools,
    history: [],
  },
  {
    reply: "已按框架把整篇初稿补全写入文件。",
    edit: { summary: "补全（二）", md: partialMd },
  }
);
assert.ok(fixed.edit && fixed.edit.md, "残缺 edit 应被补全");
assert.ok(/用户已写好的范例|开篇示范段标题/.test(fixed.edit.md), "应写入范例（一）");
assert.ok(
  chatInfer.draftCoverage(fixed.edit.md).strong >= 2,
  "补全后至少两段有正文，got " + chatInfer.draftCoverage(fixed.edit.md).strong
);

const longPara =
  "这是一段足够长的已定正文，用来占位避免被误判为弱段，长度需要超过四十个汉字左右才稳妥。";
const continueDoc = [
  "# 示例文稿\n",
  "## 一、\n",
  "### （一）开篇示范段标题\n\n" + longPara + "\n",
  "### （二）推进阿尔法专项，夯实交付节点\n\n" + longPara + "\n",
  "### （三）聚力伽马工程，打造示范样板\n\n【待补】\n",
  "## 二、\n",
  "### （一）贝塔板块——完成回款节点\n\n【待补】\n",
].join("\n");
assert.ok(chatInfer.wantsContinueSection("继续下一段"));
const next = chatInfer.findNextPendingSection(continueDoc);
assert.ok(next && /伽马工程/.test(next.head), "下一段应是伽马工程");
const contEdit = chatInfer.inferNextPendingEdit("继续下一段", continueDoc, tools);
assert.ok(contEdit && contEdit.md, "继续下一段应出 edit");
assert.ok(/伽马工程/.test(contEdit.md), "续写目标仍是伽马");
assert.ok(
  !/第一议题|政绩观|政治建设摆在首位/.test(contEdit.md),
  "续写不得灌入政治套话"
);
const noMat = chatInfer.inferNextPendingEdit("继续下一段", continueDoc, []);
assert.strictEqual(noMat, null, "无素材时不生成假续写");
const blocked = chatInfer.patchChatResult(
  {
    allow_edit: true,
    message: "帮我把整篇初稿写好写入文件",
    doc_md: continueDoc,
    tool_results: [],
    history: [],
  },
  {
    reply: "已写入全文",
    edit: { summary: "编造", md: continueDoc + "\n\n编造的一段业绩数字12345万元\n" },
  }
);
assert.ok(blocked._blockedNoMaterial, "无素材据实写作必须拦截");
assert.ok(
  !blocked.edit || !/12345万元/.test(blocked.edit.md || ""),
  "拦截后不得保留编造数字"
);

const citeWrite = chatInfer.patchChatResult(
  {
    allow_edit: true,
    message: "@12345答复.md\n把重写后的答复落入到这个文件中",
    doc_md: "# 旧\n\n旧正文占位足够长以便改写。\n",
    tool_results: [
      {
        name: "read_file",
        result: { ok: true, path: "12345答复.md", text: "短" },
      },
    ],
    history: [],
  },
  {
    reply: "已写入",
    edit: {
      summary: "重写答复",
      md: "# 答复\n\n经核查，现将有关情况函复如下。\n",
    },
  }
);
assert.ok(!citeWrite._blockedNoMaterial, "@ 落入文件不得按无素材拦截");
assert.ok(citeWrite.edit && citeWrite.edit.md, "@ 落入应保留 edit");
assert.strictEqual(citeWrite.edit.rename, "12345答复.md", "应指向目标文件名");

const contPatched = chatInfer.patchChatResult(
  {
    allow_edit: true,
    message: "继续下一段",
    doc_md: continueDoc,
    tool_results: tools,
    history: [],
  },
  { reply: "继续补写下一段…", edit: null }
);
assert.ok(contPatched.edit && contPatched.edit.md, "继续下一段口头 → 本地 edit");

// 源码不得再出现业务专名词表
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "chatInfer.js"), "utf8");
const mat = fs.readFileSync(path.join(__dirname, "materialTools.js"), "utf8");
[
  "大冬会",
  "航博",
  "置业",
  "致远",
  "政绩观",
  "第一议题",
  "把牢政治方向",
  "深耕经营主业",
  "夯实管理根基",
  "2026年上半年工作总结",
].forEach((ban) => {
  assert.ok(src.indexOf(ban) < 0, "chatInfer.js 不得含硬编码：" + ban);
  assert.ok(mat.indexOf(ban) < 0, "materialTools.js 不得含硬编码：" + ban);
});

console.log("test_chatInfer: ok");
