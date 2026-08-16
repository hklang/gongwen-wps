# -*- coding: utf-8 -*-
"""校对只走模型：无本地规则函数。"""
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


def main() -> int:
    fails: list[str] = []

    def ok(cond: bool, msg: str) -> None:
        print(("OK  " if cond else "FAIL") + " " + msg)
        if not cond:
            fails.append(msg)

    for name in (
        "run_punctuation",
        "run_format",
        "run_dictionary",
        "run_typo_local",
        "_is_quantity_strip",
    ):
        ok(not hasattr(m, name), name + " 应已删除")

    for eid, meta in m.ENGINE_META.items():
        ok(meta.get("kind") == "llm", eid + " 应为 llm")

    p = m._prompt("punctuation", "normal")
    ok("标点" in p, "标点走模型提示")
    ok("核稿纪律" in p, "共用核稿纪律")
    ok("用词少字" in p, "标点不改用词")
    ok("最小出错片段" in p, "共用要求最小片段")
    typo = m._prompt("typo", "normal")
    ok("怎么查" in typo and "事实没变" in typo, "错字有判据")
    ok("整句放过" in typo, "错字要求混排仍报")
    banned = ("2600平方米", "积2600平", "紧23扣", "深a学", "25笔", "30张")
    for eid in m.ENGINE_META:
        blob = m._prompt(eid, "normal")
        hit = [b for b in banned if b in blob]
        ok(not hit, eid + " 不写数量/夹字例")
    ok(not hasattr(m, "is_alnum_strip"), "不在终检里替模型判数量")
    d = m._mustfix_block([{"wrong": "帐号", "right": "账号"}])
    ok("帐号" in d and "账号" in d, "必改进证据块")
    ok(m._mustfix_block([]) == "", "空必改不跑词库证据")

    long = "标题\n\n一段话里有错X字然后结束。"
    short = "错X字"
    i = long.index(short)
    merged = m.deterministic_merge(
        [
            {
                "start": 0,
                "end": len(long),
                "original": long,
                "suggestion": long.replace(short, "错字"),
                "type": "format",
                "reason": "整段",
            },
            {
                "start": i,
                "end": i + len(short),
                "original": short,
                "suggestion": "错字",
                "type": "typo",
                "reason": "短",
            },
        ],
        long,
    )
    ok(len(merged) == 1 and merged[0]["original"] == short, "重叠留最短片段")
    ok("综合" not in str(merged[0].get("reason") or ""), "不拼综合理由")

    print("FAILED:" if fails else "ALL PASS", "; ".join(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
