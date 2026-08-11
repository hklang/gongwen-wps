# -*- coding: utf-8 -*-
"""本地错别字规则：真笔误要报，量词/馆号不报。"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PY = ROOT / "proofread.py"
spec = importlib.util.spec_from_file_location("proofread", PY)
m = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(m)


def originals(text: str) -> list[str]:
    return [e["original"] for e in m.run_typo_local(text)]


def main() -> int:
    fails: list[str] = []

    def ok(cond: bool, msg: str) -> None:
        print(("OK  " if cond else "FAIL") + " " + msg)
        if not cond:
            fails.append(msg)

    sample = (
        "我紧23扣三条主线。"
        "取得证200余本。"
        "心A馆与心B馆。"
        "完成成24榀。"
        "构A线推进。"
        "余17栋、目39栋。"
        "楼9层至15层。"
        "厦B塔封顶。"
        "紧abc扣试验。"
        "提速绿电f布局，突破并网。"
    )
    got = originals(sample)
    ok("紧23扣" in got, "紧23扣 应报")
    ok("紧abc扣" in got, "紧abc扣 应报")
    ok("电f布" in got, "绿电f布局 → 电f布 应报")
    for bad in (
        "证200余", "心A馆", "心B馆", "成24榀", "构A线",
        "余17栋", "目39栋", "楼9层", "至15层", "厦B塔",
    ):
        ok(bad not in got, f"{bad} 不应报")

    print("got:", got)
    if fails:
        print("FAILED:", "; ".join(fails))
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
