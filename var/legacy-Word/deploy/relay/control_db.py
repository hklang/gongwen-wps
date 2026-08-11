# -*- coding: utf-8 -*-
"""控制面 SQLite：账号 / 套餐 / 用量 / 模型路由（非用户文稿库）。"""
from __future__ import annotations

import os
import sqlite3
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DB = HERE / "data" / "control.sqlite"

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  pass_salt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  token_ver INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL DEFAULT '',
  expires_at REAL NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  monthly_requests INTEGER NOT NULL DEFAULT 300,
  daily_requests INTEGER NOT NULL DEFAULT 50,
  max_chars INTEGER NOT NULL DEFAULT 20000,
  capabilities TEXT NOT NULL DEFAULT 'fast,proof',
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  expire_at REAL NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  api TEXT NOT NULL,
  capability TEXT NOT NULL DEFAULT '',
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  chars_in INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_user_time ON usage_events(user_id, created_at);

CREATE TABLE IF NOT EXISTS model_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  capability TEXT NOT NULL,
  task TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_route_cap_task_prov_model
  ON model_routes(capability, task, provider, model);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS manuals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES categories(id),
  title TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1',
  body_md TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES categories(id),
  title TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1',
  body_md TEXT NOT NULL DEFAULT '',
  published INTEGER NOT NULL DEFAULT 1,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS user_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL DEFAULT '',
  category_code TEXT NOT NULL DEFAULT '',
  body_md TEXT NOT NULL DEFAULT '',
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_user_templates_uid
  ON user_templates(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS playbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  category_id INTEGER REFERENCES categories(id),
  title TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1',
  stages_json TEXT NOT NULL DEFAULT '[]',
  published INTEGER NOT NULL DEFAULT 1,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  plan_code TEXT NOT NULL DEFAULT 'free',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used_count INTEGER NOT NULL DEFAULT 0,
  expire_at REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  seat_limit INTEGER NOT NULL DEFAULT 5,
  manual_pack TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS org_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id INTEGER NOT NULL REFERENCES orgs(id),
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  created_at REAL NOT NULL
);
"""


def db_path() -> Path:
    raw = (os.environ.get("CONTROL_DB") or "").strip()
    return Path(raw) if raw else DEFAULT_DB


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.executescript(SCHEMA)
        now = time.time()
        cur = conn.execute("SELECT id FROM plans WHERE code=?", ("free",))
        if not cur.fetchone():
            conn.execute(
                "INSERT INTO plans(code,name,monthly_requests,daily_requests,max_chars,capabilities,created_at)"
                " VALUES(?,?,?,?,?,?,?)",
                ("free", "试用", 100, 20, 12000, "fast,proof", now),
            )
        cur = conn.execute("SELECT id FROM plans WHERE code=?", ("pro",))
        if not cur.fetchone():
            conn.execute(
                "INSERT INTO plans(code,name,monthly_requests,daily_requests,max_chars,capabilities,created_at)"
                " VALUES(?,?,?,?,?,?,?)",
                ("pro", "专业", 2000, 200, 50000, "fast,strong,proof", now),
            )
        # 默认路由：标准=deepseek flash；增强=deepseek pro（可后台改成 openai）
        defaults = [
            ("fast", "chat", "deepseek", "deepseek-v4-flash", 100),
            ("fast", "suggest", "deepseek", "deepseek-v4-flash", 100),
            ("fast", "proofread", "deepseek", "deepseek-v4-flash", 100),
            ("strong", "chat", "deepseek", "deepseek-v4-pro", 100),
            ("strong", "suggest", "deepseek", "deepseek-v4-pro", 100),
            ("proof", "proofread", "deepseek", "deepseek-v4-flash", 100),
        ]
        for cap, task, prov, model, w in defaults:
            exists = conn.execute(
                "SELECT id FROM model_routes WHERE capability=? AND task=? AND provider=? AND model=?",
                (cap, task, prov, model),
            ).fetchone()
            if not exists:
                conn.execute(
                    "INSERT INTO model_routes(capability,task,provider,model,weight,enabled)"
                    " VALUES(?,?,?,?,?,1)",
                    (cap, task, prov, model, w),
                )
        # 旧库迁移：踢人立刻作废 access
        cols = {
            r[1]
            for r in conn.execute("PRAGMA table_info(users)").fetchall()
        }
        if "token_ver" not in cols:
            conn.execute(
                "ALTER TABLE users ADD COLUMN token_ver INTEGER NOT NULL DEFAULT 0"
            )
        cat_cols = {
            r[1]
            for r in conn.execute("PRAGMA table_info(categories)").fetchall()
        }
        if "grp" not in cat_cols:
            conn.execute(
                "ALTER TABLE categories ADD COLUMN grp TEXT NOT NULL DEFAULT ''"
            )
        _seed_official_content(conn, now)
        conn.commit()


def _ensure_category(
    conn: sqlite3.Connection,
    code: str,
    name: str,
    grp: str,
    sort: int,
    now: float,
) -> int:
    row = conn.execute(
        "SELECT id FROM categories WHERE code=?", (code,)
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE categories SET name=?, grp=?, sort=?, published=1 WHERE id=?",
            (name, grp, sort, int(row["id"])),
        )
        return int(row["id"])
    cur = conn.execute(
        "INSERT INTO categories(code,name,grp,sort,published,created_at)"
        " VALUES(?,?,?,?,1,?)",
        (code, name, grp, sort, now),
    )
    return int(cur.lastrowid)


def _seed_official_content(conn: sqlite3.Connection, now: float) -> None:
    """官方分类/手册/模板种子（可后台改；禁止存用户文稿）。"""
    seeds = [
        ("notice", "通知", "日常行文", 10),
        ("circular", "通报", "日常行文", 20),
        ("letter", "函", "日常行文", 30),
        ("request", "请示", "日常行文", 40),
        ("report", "报告", "日常行文", 50),
        ("reply", "批复", "日常行文", 60),
        ("opinion", "意见", "日常行文", 70),
        ("minutes", "纪要", "日常行文", 80),
        ("summary", "工作总结 / 汇报", "总结汇报", 110),
        ("special-report", "对上专项汇报", "总结汇报", 120),
        ("duty-report", "述职述廉报告", "总结汇报", 130),
        ("situation", "情况说明", "总结汇报", 140),
        ("speech", "大会讲话", "会议讲话", 210),
        ("address", "致辞", "会议讲话", 220),
        ("host", "主持词", "会议讲话", 230),
        ("stance", "表态发言", "会议讲话", 240),
        ("dsh-personal", "民主生活会（个人）", "党内生活", 310),
        ("dsh-team", "民主生活会（班子）", "党内生活", 320),
        ("org-life", "组织生活会发言", "党内生活", 330),
        ("research", "调研报告", "调研宣传", 410),
        ("experience", "经验材料", "调研宣传", 420),
        ("brief", "信息稿 / 简讯", "调研宣传", 430),
        ("plan", "工作方案", "制度方案", 510),
        ("rules", "实施细则", "制度方案", 520),
        ("checklist", "责任清单", "制度方案", 530),
    ]
    ids = {}
    for code, name, grp, sort in seeds:
        ids[code] = _ensure_category(conn, code, name, grp, sort, now)
    cat_id = ids["summary"]
    if not conn.execute("SELECT id FROM manuals WHERE code=?", ("summary-basic",)).fetchone():
        conn.execute(
            "INSERT INTO manuals(code,category_id,title,version,body_md,published,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (
                "summary-basic",
                cat_id,
                "工作总结写作要点（试用包）",
                "2026.08",
                "# 工作总结写作要点\n\n"
                "1. **先架子后血肉**：先定一、二、三级标题，再填事实与数据。\n"
                "2. **据实写数**：数字必须来自本机「素材/」可核对材料，禁止编造。\n"
                "3. **防重复**：对照往年总结，少写撞车段落。\n"
                "4. **收束克制**：问题与打算一般不单立大标题，文末一段点到即可；忌空话套话堆砌。\n",
                1,
                now,
            ),
        )
    _seed_more_templates(conn, ids, now)
    if not conn.execute(
        "SELECT id FROM playbooks WHERE code=?", ("summary-flow",)
    ).fetchone():
        import json
        from control_content import SUMMARY_FLOW_STAGES

        conn.execute(
            "INSERT INTO playbooks(code,category_id,title,version,stages_json,published,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (
                "summary-flow",
                cat_id,
                "工作总结分步写",
                "2026.08",
                json.dumps(SUMMARY_FLOW_STAGES, ensure_ascii=False),
                1,
                now,
            ),
        )


def _seed_template(
    conn: sqlite3.Connection,
    code: str,
    category_id: int,
    title: str,
    body_md: str,
    now: float,
    version: str = "2026.08.11",
) -> None:
    row = conn.execute("SELECT id FROM templates WHERE code=?", (code,)).fetchone()
    if row:
        conn.execute(
            "UPDATE templates SET category_id=?, title=?, version=?, body_md=?,"
            " published=1, updated_at=? WHERE id=?",
            (category_id, title, version, body_md, now, int(row["id"])),
        )
        return
    conn.execute(
        "INSERT INTO templates(code,category_id,title,version,body_md,published,updated_at)"
        " VALUES(?,?,?,?,?,?,?)",
        (code, category_id, title, version, body_md, 1, now),
    )


def _seed_more_templates(
    conn: sqlite3.Connection, ids: dict, now: float
) -> None:
    """各文种多套参考骨架（可后台改；重启/init 会按 code 覆盖更新）。"""
    _end_brief = (
        "\n"
        "回顾【时段】工作，虽取得一定进展，但对照组织要求和干部职工期盼仍有差距，"
        "主要是【一两句点到即可，勿单立「存在问题」标题】。"
        "下一步，将【一两句打算即可，勿单立「下步工作」标题】，"
        "以过硬作风和实绩向组织和【单位】交账。\n"
    )

    # —— 日常行文 ——
    _seed_template(
        conn,
        "notice-meeting",
        ids["notice"],
        "会议通知",
        "# 关于召开【待补】会议的通知\n\n"
        "各【待补】：\n\n"
        "定于【时间】在【地点】召开【会议名称】。现将有关事项通知如下：\n\n"
        "## 一、会议时间\n\n【待补】\n\n"
        "## 二、会议地点\n\n【待补】\n\n"
        "## 三、参会人员\n\n【待补】\n\n"
        "## 四、会议议程\n\n1. 【待补】\n2. 【待补】\n\n"
        "## 五、有关要求\n\n【待补】\n\n"
        "特此通知。\n\n【发文机关】\n【日期】\n",
        now,
    )
    _seed_template(
        conn,
        "notice-work",
        ids["notice"],
        "工作安排通知",
        "# 关于【待补】工作安排的通知\n\n"
        "各【待补】：\n\n"
        "为【目的】，现将有关事项通知如下：\n\n"
        "## 一、总体要求\n\n【待补】\n\n"
        "## 二、主要任务\n\n"
        "### （一）【待补】\n\n"
        "### （二）【待补】\n\n"
        "## 三、进度安排\n\n【待补】\n\n"
        "## 四、组织保障\n\n【待补】\n\n"
        "特此通知。\n\n【发文机关】\n【日期】\n",
        now,
    )
    _seed_template(
        conn,
        "notice-forward",
        ids["notice"],
        "转发类通知",
        "# 关于转发《【待补】》的通知\n\n"
        "各【待补】：\n\n"
        "现将《【待补】》转发给你们，并结合实际提出如下要求，请一并贯彻落实。\n\n"
        "## 一、提高认识，迅速传达学习\n\n【待补】\n\n"
        "## 二、结合实际，细化落实措施\n\n【待补】\n\n"
        "## 三、强化督导，确保取得实效\n\n【待补】\n\n"
        "特此通知。\n\n【发文机关】\n【日期】\n",
        now,
    )
    _seed_template(
        conn,
        "letter-ask",
        ids["letter"],
        "商请函骨架",
        "# 关于【待补】的函\n\n"
        "【主送机关】：\n\n"
        "【缘由一句】。现函请如下：\n\n"
        "## 一、【事项】\n\n【说明、依据、诉求】\n\n"
        "## 二、【配合事项 / 时间节点】\n\n【待补】\n\n"
        "请予支持为盼。\n\n【发文机关】\n【日期】\n",
        now,
    )
    _seed_template(
        conn,
        "letter-reply",
        ids["letter"],
        "复函骨架",
        "# 关于【待补】的复函\n\n"
        "【主送机关】：\n\n"
        "你单位《关于【待补】的函》收悉。经研究，现函复如下：\n\n"
        "## 一、【意见要点】\n\n【待补】\n\n"
        "## 二、【落实要求 / 联系方式】\n\n【待补】\n\n"
        "特此函复。\n\n【发文机关】\n【日期】\n",
        now,
    )

    # —— 工作总结 / 汇报（问题与打算不单立标题，文末一段带过）——
    _seed_template(
        conn,
        "summary-skeleton",
        ids["summary"],
        "半年工作总结骨架",
        "# 【单位/姓名】【年份】上半年工作总结\n\n"
        "【职务】  【姓名】\n\n"
        "&nbsp;\n\n"
        "根据工作分工，【分管范围一句】。半年来，**紧扣中心大局**，突出【关键词】，"
        "较好完成既定目标任务。现将有关情况汇报如下：\n\n"
        "## 一、坚持政治引领，强化大局意识\n\n"
        "### （一）加强理论学习，不断提高政治站位\n\n"
        "【传达贯彻上级精神、正确政绩观、一岗双责等，据实写】\n\n"
        "### （二）服务中心大局，推动重点任务落地\n\n"
        "【服务全市/集团中心工作的具体事项与进展】\n\n"
        "## 二、突出主责主业，推动工作提质增效\n\n"
        "### （一）【板块/任务一】\n\n【事实与数据，来自素材】\n\n"
        "### （二）【板块/任务二】\n\n【事实与数据】\n\n"
        "### （三）【板块/任务三】\n\n【事实与数据】\n\n"
        "## 三、加强作风建设，守牢安全廉洁底线\n\n"
        "### （一）转作风、优服务，提升执行力\n\n"
        "【深入一线、马上就办、闭环落实等】\n\n"
        "### （二）压实安全责任，防范化解风险\n\n"
        "【检查、整改、制度等】\n\n"
        "### （三）深化廉政建设，打造阳光廉洁工程\n\n"
        "【教育、制度、监督；关键环节防控】\n\n"
        + _end_brief,
        now,
    )
    _seed_template(
        conn,
        "summary-annual",
        ids["summary"],
        "年度工作总结骨架",
        "# 【单位/姓名】【年份】年度工作总结\n\n"
        "【职务】  【姓名】\n\n"
        "&nbsp;\n\n"
        "一年来，坚持以习近平新时代中国特色社会主义思想为指导，全面贯彻上级决策部署，"
        "紧扣【年度主题】，统筹推进政治建设、主责主业和作风建设。现将有关情况报告如下：\n\n"
        "## 一、坚持政治统领，把准正确方向\n\n"
        "### （一）深学细悟，筑牢思想根基\n\n【待补】\n\n"
        "### （二）对标对表，落实上级部署\n\n【待补】\n\n"
        "## 二、聚焦主责主业，全年工作成效\n\n"
        "### （一）【待补】\n\n"
        "### （二）【待补】\n\n"
        "### （三）【待补】\n\n"
        "## 三、狠抓作风建设，涵养良好政治生态\n\n"
        "### （一）改进作风、密切联系群众\n\n【待补】\n\n"
        "### （二）严守纪律规矩，落实一岗双责\n\n【待补】\n\n"
        + _end_brief.replace("【时段】", "全年"),
        now,
    )
    _seed_template(
        conn,
        "summary-brief",
        ids["summary"],
        "简要工作汇报骨架",
        "# 关于【待补】工作情况的汇报\n\n"
        "【主送/场合一句】。现将有关情况简要汇报如下：\n\n"
        "## 一、工作进展\n\n【节点、数据、完成情况】\n\n"
        "## 二、主要做法与亮点\n\n【2～3条即可】\n\n"
        "## 三、需协调支持的事项\n\n【如无可写「暂无」；困难建议可并入本段】\n\n"
        "下步将【一句打算】，确保【目标】落地见效。\n",
        now,
    )
    _seed_template(
        conn,
        "summary-team",
        ids["summary"],
        "班子工作总结骨架",
        "# 【单位】领导班子【年份】【上半年/年度】工作总结\n\n"
        "&nbsp;\n\n"
        "【时段】以来，【单位】领导班子坚持以习近平新时代中国特色社会主义思想为指导，"
        "全面落实上级党委决策部署，坚持政治统领、团结干事、廉洁从政，"
        "推动【中心工作】取得新进展。现将班子履职情况报告如下：\n\n"
        "## 一、加强政治建设，发挥把方向管大局作用\n\n"
        "### （一）理论武装走深走实\n\n"
        "【党委理论学习中心组、专题研讨、传达贯彻等】\n\n"
        "### （二）坚决贯彻上级决策部署\n\n"
        "【重大事项研究、政治把关、服务中心大局】\n\n"
        "### （三）坚持民主集中制，增强班子合力\n\n"
        "【议事规则、集体决策、沟通协调】\n\n"
        "## 二、聚焦主责主业，推动事业高质量发展\n\n"
        "### （一）【重点工作一】\n\n【班子统筹推进的事实与数据】\n\n"
        "### （二）【重点工作二】\n\n【待补】\n\n"
        "### （三）【重点工作三】\n\n【待补】\n\n"
        "## 三、加强作风建设，涵养良好政治生态\n\n"
        "### （一）改进作风、真抓实干\n\n"
        "【调研督导、一线办公、为基层减负等】\n\n"
        "### （二）落实全面从严治党主体责任\n\n"
        "【一岗双责、警示教育、风险防控】\n\n"
        "### （三）带头发扬斗争精神，破解难题\n\n"
        "【啃硬骨头、化解矛盾、回应关切】\n\n"
        "回顾【时段】，班子工作取得一定成效，但对标上级要求和干部群众期盼仍有不足，"
        "主要是【一两句即可】。下一步，班子将【一两句打算即可】，"
        "以更高标准、更实作风推动各项工作再上新台阶。\n",
        now,
    )

    # —— 述职报告 / 述职述廉 ——
    _seed_template(
        conn,
        "duty-personal",
        ids["duty-report"],
        "个人述职述廉报告骨架",
        "# 【姓名】【年份】【上半年/年度】个人述职述廉报告\n\n"
        "【职务】  【姓名】\n\n"
        "&nbsp;\n\n"
        "根据组织安排，现就本人【时段】履职尽责和廉洁自律情况报告如下：\n\n"
        "## 一、加强政治建设，不断提高政治判断力、政治领悟力、政治执行力\n\n"
        "### （一）深学细悟党的创新理论\n\n"
        "【学习习近平新时代中国特色社会主义思想、参加组织生活等】\n\n"
        "### （二）对标对表抓落实\n\n"
        "【贯彻党中央和上级决策部署、服务中心大局的具体行动】\n\n"
        "### （三）严肃党内政治生活\n\n"
        "【双重组织生活、批评与自我批评、报告个人有关事项等】\n\n"
        "## 二、忠实履行岗位职责，推动分管工作落地见效\n\n"
        "### （一）【分管领域一】\n\n【事实与数据】\n\n"
        "### （二）【分管领域二】\n\n【事实与数据】\n\n"
        "### （三）【急难险重任务】\n\n【攻坚突破情况】\n\n"
        "## 三、加强作风建设，严格廉洁自律\n\n"
        "### （一）转作风、强执行\n\n"
        "【深入基层、务实重行、反对形式主义官僚主义】\n\n"
        "### （二）落实一岗双责，抓好分管领域党风廉政建设\n\n"
        "【教育提醒、制度执行、风险点防控】\n\n"
        "### （三）严守纪律规矩，管好亲属和身边人\n\n"
        "【中央八项规定精神、廉洁从业、个人事项】\n\n"
        "总的看，【时段】工作有进步，但对照组织和群众要求仍有差距，"
        "主要是【一两句点到即可】。下一步，我将【一两句打算即可】，"
        "以更高标准履行职责、以更严要求廉洁从政，不负组织信任。\n",
        now,
    )
    _seed_template(
        conn,
        "duty-personal-half",
        ids["duty-report"],
        "个人述职述廉（半年）骨架",
        "# 【姓名】【年份】上半年个人述职述廉报告\n\n"
        "【职务】  【姓名】\n\n"
        "&nbsp;\n\n"
        "根据工作分工，【分管范围】。半年来，本人坚持政治统领、干净干事，"
        "现将述职述廉情况汇报如下：\n\n"
        "## 一、把准政治方向，做到「两个维护」\n\n"
        "### （一）强化理论武装\n\n【待补】\n\n"
        "### （二）服务中心、狠抓落实\n\n【待补】\n\n"
        "## 二、履职尽责，完成重点目标任务\n\n"
        "### （一）【待补】\n\n"
        "### （二）【待补】\n\n"
        "### （三）【待补】\n\n"
        "## 三、改进作风、廉洁从政\n\n"
        "### （一）作风建设\n\n【待补】\n\n"
        "### （二）廉洁自律与一岗双责\n\n【待补】\n\n"
        "半年来工作仍有不足，主要是【一句】。下半年将【一句】，"
        "确保全年目标任务落地，以实绩交账、以干净立身。\n",
        now,
    )

    # —— 讲话 / 党内 / 专项 ——
    _seed_template(
        conn,
        "speech-work",
        ids["speech"],
        "工作会议讲话骨架",
        "# 在【待补】会议上的讲话\n\n"
        "同志们：\n\n"
        "今天召开这次会议，主要任务是【目的一句】。下面，我讲三点意见。\n\n"
        "## 一、充分肯定成绩，进一步增强做好工作的信心\n\n【待补】\n\n"
        "## 二、清醒认识形势，准确把握重点任务\n\n【待补】\n\n"
        "## 三、压实责任、改进作风，确保落地见效\n\n【待补】\n\n"
        "同志们，【收束一句】。\n",
        now,
    )
    _seed_template(
        conn,
        "speech-open",
        ids["speech"],
        "开幕致辞骨架",
        "# 在【待补】开幕式上的致辞\n\n"
        "各位来宾、同志们、朋友们：\n\n"
        "大家好！\n\n"
        "在【时节/背景】，我们迎来【活动名称】。我谨代表【单位】，"
        "对各位嘉宾表示热烈欢迎和诚挚感谢！\n\n"
        "## 一、【活动意义 / 祝贺】\n\n【待补】\n\n"
        "## 二、【介绍亮点 / 期望】\n\n【待补】\n\n"
        "## 三、预祝圆满成功\n\n"
        "预祝本次【活动】圆满成功！祝各位嘉宾身体健康、工作顺利！\n\n"
        "谢谢大家！\n",
        now,
    )
    _seed_template(
        conn,
        "dsh-personal-1",
        ids["dsh-personal"],
        "民主生活会个人发言骨架",
        "# 民主生活会个人对照检查材料\n\n"
        "【姓名】【职务】\n\n"
        "&nbsp;\n\n"
        "按照本次民主生活会要求，本人紧扣【主题】，深入查摆问题。现作对照检查如下：\n\n"
        "## 一、学习体会\n\n【待补】\n\n"
        "## 二、对照检查存在的问题\n\n"
        "### （一）政治忠诚 / 政治能力方面\n\n【待补】\n\n"
        "### （二）担当作为 / 工作作风方面\n\n【待补】\n\n"
        "### （三）廉洁自律方面\n\n【待补】\n\n"
        "## 三、原因分析\n\n【思想、政治、作风、纪律根源】\n\n"
        "## 四、整改措施\n\n【具体、可检验】\n\n",
        now,
    )
    _seed_template(
        conn,
        "dsh-team-1",
        ids["dsh-team"],
        "民主生活会班子对照检查骨架",
        "# 【单位】领导班子民主生活会对照检查材料\n\n"
        "&nbsp;\n\n"
        "按照上级部署和本次民主生活会要求，班子紧扣【主题】，"
        "深入查摆问题、剖析根源。现将对照检查情况报告如下：\n\n"
        "## 一、会议主题与会前准备\n\n【学习研讨、征求意见、谈心谈话等】\n\n"
        "## 二、上次民主生活会整改落实情况\n\n【待补】\n\n"
        "## 三、对照检查存在的突出问题\n\n"
        "### （一）政治建设方面\n\n【待补】\n\n"
        "### （二）作风建设方面\n\n【待补】\n\n"
        "### （三）担当作为 / 高质量发展方面\n\n【待补】\n\n"
        "### （四）全面从严治党方面\n\n【待补】\n\n"
        "## 四、原因分析\n\n【待补】\n\n"
        "## 五、努力方向和整改措施\n\n【待补】\n\n",
        now,
    )
    _seed_template(
        conn,
        "special-report-1",
        ids["special-report"],
        "对上专项汇报骨架",
        "# 关于【待补】情况的专项汇报\n\n"
        "【主送机关 / 汇报场合】：\n\n"
        "## 一、基本情况\n\n【背景、范围、时点】\n\n"
        "## 二、主要做法与成效\n\n【分条写，数据据实】\n\n"
        "## 三、困难问题与工作建议\n\n"
        "【问题与建议可合并写；如需请示，单列「请示事项」一句】\n\n"
        "下一步将【一句】，请【领导/上级】给予指导支持。\n",
        now,
    )
