# -*- coding: utf-8 -*-
"""S2 官方内容包冒烟。"""
from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


def main() -> int:
    td = tempfile.mkdtemp(prefix="gongwen-content-")
    os.environ["CONTROL_DB"] = str(Path(td) / "c.sqlite")
    os.environ["CONTROL_SECRET"] = "content-smoke"
    from control_db import init_db
    from control_content import content_pack, content_index, upsert_manual, upsert_playbook

    init_db()
    idx = content_index()
    assert idx["ok"] and len(idx["categories"]) >= 1
    assert len(idx["manuals"]) >= 1
    assert len(idx["templates"]) >= 1
    assert len(idx.get("playbooks") or []) >= 1
    pack = content_pack()
    assert pack["manuals"][0]["body_md"]
    pbs = pack.get("playbooks") or []
    assert pbs and len(pbs[0].get("stages") or []) >= 5
    upsert_manual(
        "summary-basic",
        "工作总结写作要点（试用包）",
        "# 更新\n\n测试热更新 " + str(int(time.time())),
        version="2026.08.1",
    )
    upsert_playbook(
        "summary-flow",
        "工作总结分步写",
        pbs[0]["stages"],
        version="2026.08.1",
    )
    pack2 = content_pack()
    assert "测试热更新" in pack2["manuals"][0]["body_md"]
    print("CONTENT ALL PASS")
    print(
        "cats=",
        len(pack["categories"]),
        "manuals=",
        len(pack["manuals"]),
        "playbooks=",
        len(pbs),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
