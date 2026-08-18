# -*- coding: utf-8 -*-
"""用户校对云库冒烟：隔离、幂等、上限。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-uproof-")
    os.environ["CONTROL_DB"] = str(Path(td) / "c.sqlite")
    os.environ["CONTROL_SECRET"] = "uproof-smoke"
    os.environ["CONTROL_REGISTER_MODE"] = "open"
    from control_auth import register
    from control_db import init_db
    import control_user_proof as up

    init_db()
    uid = int(register("uproof@test.local", "pass-uproof-1234", "")["user"]["id"])
    uid2 = int(register("uproof2@test.local", "pass-uproof-1234", "")["user"]["id"])

    a = up.add_whitelist(uid, "国能投")
    assert a["ok"] and a["item"]["word"] == "国能投"
    again = up.add_whitelist(uid, "国能投")
    assert again["item"]["id"] == a["item"]["id"]

    mf = up.add_mustfix(uid, "帐号", "账号")
    assert mf["item"]["right"] == "账号"
    up.add_mustfix(uid, "帐号", "账户")
    listed = up.list_user_proof(uid)
    assert listed["mustfix"][0]["right"] == "账户"

    facts = up.add_facts(
        uid,
        [
            {
                "snippet": "党员大会专题学习　16次\n线上学习　5次",
                "recorded_at": "2026-08-18",
            }
        ],
    )
    assert "16次" in facts["items"][0]["snippet"]
    assert facts["items"][0]["recorded_at"] == "2026-08-18"

    pack = up.pack_for_proofread(uid)
    assert "国能投" in pack["whitelist"]
    assert pack["mustfix"][0]["wrong"] == "帐号"
    assert pack["facts"][0]["snippet"].startswith("党员大会")
    assert pack["facts"][0]["recorded_at"] == "2026-08-18"

    other = up.list_user_proof(uid2)
    assert other["whitelist"] == [] and other["mustfix"] == [] and other["facts"] == []
    try:
        up.delete_item(uid2, "whitelist", a["item"]["id"])
        raise SystemExit("FAIL cross-user delete")
    except ValueError:
        pass

    up.delete_item(uid, "whitelist", a["item"]["id"])
    up.delete_item(uid, "mustfix", listed["mustfix"][0]["id"])
    up.delete_item(uid, "facts", facts["items"][0]["id"])
    empty = up.list_user_proof(uid)
    assert empty["whitelist"] == [] and empty["mustfix"] == [] and empty["facts"] == []

    try:
        up.add_facts(uid, [])
        raise SystemExit("FAIL empty facts")
    except ValueError:
        pass

    import proofread as pr

    block = pr._facts_block(pack["facts"])
    assert "2026年8月18日收录" in block
    assert "党员大会专题学习" in block
    legacy = pr._facts_block(
        [{"label": "营收", "value": "12.3", "unit": "亿元"}]
    )
    assert "营收: 12.3亿元" in legacy

    td2 = tempfile.mkdtemp(prefix="gongwen-uproof-mig-")
    os.environ["CONTROL_DB"] = str(Path(td2) / "old.sqlite")
    import sqlite3
    from control_db import db_path

    old = db_path()
    old.parent.mkdir(parents=True, exist_ok=True)
    raw = sqlite3.connect(str(old))
    raw.execute(
        "CREATE TABLE user_proof_facts ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT,"
        "user_id INTEGER NOT NULL,"
        "label TEXT NOT NULL,"
        "value TEXT NOT NULL,"
        "unit TEXT NOT NULL DEFAULT '',"
        "aliases TEXT NOT NULL DEFAULT '',"
        "created_at REAL NOT NULL,"
        "UNIQUE(user_id, label))"
    )
    raw.commit()
    raw.close()
    from control_db import init_db as init_again

    init_again()
    uid3 = int(register("uproof3@test.local", "pass-uproof-1234", "")["user"]["id"])
    mig = up.add_facts(
        uid3, [{"snippet": "整段口径", "recorded_at": "2026-08-18"}]
    )
    assert mig["items"][0]["snippet"] == "整段口径"
    print("USER PROOF PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
