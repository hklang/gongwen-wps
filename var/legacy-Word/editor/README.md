# 公文所见即所得编辑器

> **2026-08 主路径**：VS Code 扩展 `Word/extension`（Custom Editor 嵌入本目录 `editor.html`）+ 云中转 `Word/deploy/relay`。  
> 安装与用法以 [`../extension/README.md`](../extension/README.md) 为准；商业化见 [`../specs/2026-08-11-商业化总方案.md`](../specs/2026-08-11-商业化总方案.md)。  
> 下文保留本机 `python app.py` 历史叙事，供离线对照；**工程根不再默认 `work\` 唯一布局**（扩展以打开的 md 所在工程 + `素材/` 为准）。

人机双向写公文的小工具。本机也可：`python app.py` 打开浏览器编辑；正式交付走扩展嵌入。

## 怎么用

```bash
cd Word/editor
python app.py            # 启动（可带端口，如 python app.py 9000）
```

浏览器打开 `http://127.0.0.1:8765`：

| 操作 | 作用 |
|------|------|
| **打开docx文件** | 弹**系统原生文件选择框**（跟 Word 打开文件一样）选 `.docx`（或 `.md`）→ 工作目录自动设为它所在目录，后台转 md 并打开 |
| **保存** | 立即把当前内容写回本地 md（平时编辑停顿1~2秒也会自动存） |
| **关闭** | 先保存再清空编辑区，不丢数据 |
| **导出 docx** | 后台自动转 docx 并下载（Word 打开即真分页） |
| **重新加载** | 重新读取磁盘上的 md（看 Claude 改了什么） |

人机双写已挂在正式编辑器右侧（`/` 或 `/editor.html`）：默认「对话」；「精修」固定 3 套方案。工具栏锁头=授权改稿并锁左侧；左侧文件右键可「引用」到对话（`@文件`）。预览时强制锁定；采用写回同一正文。

工具栏可选提供商 **MiniMax / DeepSeek**。DeepSeek 模型：`deepseek-v4-flash`、`deepseek-v4-pro`（`settings.py` 填 `DEEPSEEK_API_KEY`）。

独立 UX 演示页仍可用：`/demo-dual-write.html`  
出方案/对话走 `POST /api/suggest`、`/api/chat`。配置见 `settings.example.py`。

## 工作区规则

- **打开哪个文件，就以哪个文件所在目录作为工作目录**，不再需要手动设置
- 工作目录 = 文件所在目录下的 `work\` 文件夹，如打开 `D:\汇报\工作总结.docx`：
  - 工作目录：`D:\汇报\work\`
  - `工作总结.md` —— 转换出的正文（实时自动保存的就是它）
  - `工作总结.docx` —— 导出的成品（不覆盖你的源文件 `D:\汇报\工作总结.docx`）
  - `快照\` —— 每次保存的备份
- **重开同名文档不覆盖**：`work\工作总结.md` 已存在（上次编辑过）就直接打开它，绝不重新转换覆盖
- 服务器重启后自动恢复上次打开的工作区（记录在 `state.json`，已 gitignore）

## 数据安全

- 编辑实时自动保存到工作目录的 `<文档名>.md`（原子写入，写一半不会产生坏文件）
- 每次保存自动留一份快照到 `快照/`（保留最近 20 份，md 坏了随时找回）
- 关闭/切走页面时强制补一次保存
- 你打开的原始 docx 永不覆盖；导出 docx 是放在 `work\` 里的全新文件
- **重开同名文档直接加载已有 md**：上次编辑的东西不会因为重新打开而丢
- 前端每 3 秒检测本地 md 是否被外部（Claude）改动，变了会提示并同步

## 双向协作

- 你编辑 → 自动存到 `D:\汇报\work\工作总结.md` → Claude 在 VSCode 打开该文件即可读、可改
- Claude 改完保存 → 网页 3 秒内自动同步

## 双向转换

复用 `../tools/docx2md.py` 与 `../tools/md2docx.py`（一行不改）。公文排版映射见 `../tools/README.md`，编辑器显示样式见 `gongwen.css`。

## 文件结构

```
Word/editor/
├── app.py            ← 入口（python app.py）
├── session.py        ← 工作区会话 / 快照 / 打开文档
├── dialogs.py        ← 系统文件选择框
├── server.py         ← HTTP 路由与静态资源
├── editor.html           ← 前端界面
├── demo-dual-write.html  ← 人机双写 UX 演示（md 切片）
├── suggest.py            ← MiniMax 出方案
├── settings.example.py   ← 配置模板（复制为 settings.py）
├── settings.py           ← 本地 Key/模型（gitignore）
├── gongwen.css           ← 公文皮肤
├── test_app.py           ← 单元/集成测试
├── vendor/vditor/        ← Vditor（本地打包）
├── state.json            ← 上次工作区（自动生成，已 gitignore）
└── README.md
```

## 移植

整个 `editor/` 目录复制到任意项目即可用（前提：该项目 `../tools/` 下有 `docx2md.py`、`md2docx.py`，且已 `pip install python-docx`）。

## 注意

- 工作目录 = 打开文件所在目录的 `work\`；`work\` 里是临时工作用的，正式稿导出 docx 后放到你要提交的位置
- 生成 docx 前请关闭 Word 中打开的 `<文档名>.docx`，否则报权限错误
- 若 `python` 被 Windows 商店劫持，用 anaconda 全路径 `C:\ProgramData\anaconda3\python.exe app.py`
- 编辑器不做分页/页码，真分页由导出后的 docx 在 Word 里完成
