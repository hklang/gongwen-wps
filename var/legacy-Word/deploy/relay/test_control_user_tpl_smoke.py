# -*- coding: utf-8 -*-
"""用户「我的模板」冒烟。"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-utpl-")
    os.environ["CONTROL_DB"] = str(Path(td) / "c.sqlite")
    os.environ["CONTROL_SECRET"] = "utpl-smoke"
    os.environ["CONTROL_REGISTER_MODE"] = "open"
    from control_db import init_db
    from control_auth import register
    import control_user_tpl as ut

    init_db()
    reg = register("utpl@test.local", "pass-utpl-1234", "")
    assert reg.get("ok"), reg
    uid = int(reg["user"]["id"])

    created = ut.create_user_template(
        uid, "我的骨架", "# 标题\n\n## 一\n\n", category_code="summary"
    )
    assert created["ok"] and created["template"]["id"]
    tid = created["template"]["id"]
    listed = ut.list_user_templates(uid)
    assert listed["ok"] and len(listed["templates"]) == 1
    got = ut.get_user_template(uid, tid)
    assert "## 一" in got["template"]["body_md"]
    upd = ut.update_user_template(uid, tid, title="改名", body_md="# 新\n")
    assert upd["template"]["title"] == "改名"
    # 越权：另一用户
    reg2 = register("utpl2@test.local", "pass-utpl-1234", "")
    uid2 = int(reg2["user"]["id"])
    try:
        ut.get_user_template(uid2, tid)
        raise SystemExit("FAIL cross-user read")
    except ValueError:
        pass
    ut.delete_user_template(uid, tid)
    assert ut.list_user_templates(uid)["templates"] == []
    print("USER TPL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
