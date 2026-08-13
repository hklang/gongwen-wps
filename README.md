# gongwen-wps

公文「人机双写」— **WPS 文字加载项**独立工程（与「半年工作总结」个人材料仓分离）。

## 目录

| 路径 | 说明 |
|------|------|
| `wps-addin/` | WPS JS 加载项（主力开发） |
| `wps-addin/js/contextKernel.js` | 对话上下文：意图、任务卡、**清单+fetch_context** |
| `wps-addin/js/qualityKernel.js` | 聪明程度：写前对齐、参照指纹、交稿闸/深检 |
| `wps-addin/js/gwlog.js` | 侧栏调试环状日志 |
| `wps-addin/js/settingsStore.js` | 设置 v2 落盘（场景引擎/词库/事实） |
| `wps-addin/ui/settings.html` | **独立设置窗**（ShowDialog，约 920×720） |
| `specs/` | 现行规格（含上下文 / 聪明程度 / 设置系统 / 评测台） |
| `Code/想构思.md` · `写代码.md` · `推版本.md` | 构思与交付纪律 |
| `var/legacy-Word/` | **旧项目参考**；本机中转暂仍从此启动（`deploy/relay`） |

## 调试

```powershell
# 1）本机中转（现阶段默认；Key 读自 var/legacy-Word/editor/settings.py）
cd var\legacy-Word\deploy\relay
powershell -ExecutionPolicy Bypass -File .\start_local.ps1

# 2）WPS 加载项
cd wps-addin
npx wpsjs debug -s
```

加载项默认连 `http://127.0.0.1:3000`。对话自动落盘；主窗最小化不再关助手窗。用户可点「清空」主动清对话。

**上下文 + 聪明程度（商用）**

- 上下文取舍：**要啥给啥**（首包清单 → 模型 `fetch_context` / 读素材）；规格见 `specs/2026-08-12-WPS对话上下文·要啥给啥.md`
- 出结论/多份：**flash 多轮取数** → 宿主打包 tool 结果 → **一次 pro 出终稿**；界面不选手动能力档
- 工程右键 **设为参照稿**（学口气，禁照抄）；出稿后 **交稿闸** 检查单
- 出稿后自动一趟交稿挑刺（不重写全文）
- 评测题：`specs/2026-08-12-WPS聪明程度评测台.md`
- 调试：侧栏灰字**双击**复制 `GwLog`（含 `ctx.trace` / `quality.*`）

> 中转 `suggest.py` 的「本轮焦点 / 写前对齐」纪律在 `var/legacy-Word/deploy/relay` 与 `editor` 各有一份，改纪律时请两边同步（未正式迁仓前）。

功能区 **开始 → 公文**：

| 按钮 | 作用 |
|------|------|
| **打开公文助手** | 独立窗 `workspace.html`（左工程 + 右 AI） |
| 仅工程窗 | 独立小窗 `projpane.html` |

工程栏：

- 列表只认 **doc / docx**（工程根默认=当前文档目录）
- **改绑** 打开当前工程目录，选中后自动建 `素材/` `模板/` `版本/` `.gongwen/`
- **连点两次** 或右键「用 WPS 打开」→ 只读新标签
- 右键「引用」→ 抽正文给 AI；「设为参照稿」→ 学口气；「版本」旁 **存版本** → 当前稿快照到 `版本/`
- 读 doc/docx 会短暂 Open；**正文按修改时间做内存缓存**，同一文件连续发送不再反复打开闪屏（点「刷新」会清缓存）

AI 侧栏：

- 右上角 **⚙ 设置**（独立窗：通用 / 校对场景 / 词库 / 事实口径 / 高级）· **登录**（联调可自动测试模式，不限额度）
- **校对**：选区|全文 → 开始；内容重复等按场景配方；词库/事实口径在设置里配
- **素材旁「刷新」**：全量重建 `.gongwen/materials-index.json`；发送前会按修改时间增量同步
- **撰写工具环**：模型可按需读本机素材（精读现抽）；界面只显示用户自己的 `@引用`，不刷自动已读列表
- **撰写**：点选 **一级/二级/三级/正文**（可多选）→ 可钉范围 → **出结论/给多份** → 卡片落稿
- **精修**：钉住 → 充填 / 润色出方案 → 预览 / 采用；钉住旁 **还原**；**再钉住会清空旧方案**
- 写回保留段末回车，避免与下一段粘连

规格：`specs/2026-08-13-WPS设置系统设计.md`、`specs/2026-08-13-WPS校对内容重复.md`

> WPS 12.1.0.26895+ 的 `CreateTaskPane` 会挡 Ribbon，**暂放弃停靠**，改用 `ShowDialog`。改 ribbon 后请完全退出再开 WPS。

## 与旧仓关系

- 个人材料仓：`涛总个人材料/半年工作总结`（文稿）
- 本仓 `var/legacy-Word`：旧产品代码快照，**新改动不要写进 var**
- VS Code 扩展 / editor / relay 以 var 为参考，后续再正式迁入本仓模块
