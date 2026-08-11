"""app / session / dialogs / server 单元与集成测试。"""
import http.client
import json
import os
import tempfile
import threading
import unittest

import app
import dialogs
import session


def _clear_session():
    # 就地清空，保持与 session.CURRENT / app.CURRENT 同一对象
    session.CURRENT.update(
        work_base=None, work_dir=None, md_path=None,
        docx_path=None, snap_dir=None,
    )


def _open_in_tmp(tmp, name="测试.docx", md="# 标题\n\n正文"):
    """在 tmp 下造一份 docx 并打开，工作目录应为 tmp（同目录 md）。"""
    src = os.path.join(tmp, name + ".src.md")
    docx = os.path.join(tmp, name)
    with open(src, "w", encoding="utf-8") as f:
        f.write(md)
    rc, _, err = app.run_converter("md2docx.py", src, docx)
    if rc != 0:
        raise AssertionError(err)
    r = app.open_document(docx)
    if not r.get("ok"):
        raise AssertionError(r)
    return r, docx


class TestCore(unittest.TestCase):
    def test_atomic_write_creates_and_replaces(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.md")
            app.atomic_write(p, "第一版")
            with open(p, encoding="utf-8") as f:
                self.assertEqual(f.read(), "第一版")
            app.atomic_write(p, "第二版")
            with open(p, encoding="utf-8") as f:
                self.assertEqual(f.read(), "第二版")
            self.assertFalse(os.path.exists(p + ".tmp"))

    def test_snapshot_keeps_cap(self):
        with tempfile.TemporaryDirectory() as d:
            old = dict(session.CURRENT)
            old_state = session.STATE_FILE
            session.STATE_FILE = os.path.join(d, "state.json")
            try:
                _open_in_tmp(d)
                for _ in range(app.KEEP_SNAPS + 5):
                    app.snapshot()
                snap = os.path.join(d, "快照")
                count = len([f for f in os.listdir(snap) if f.startswith("快照_")])
                self.assertEqual(count, app.KEEP_SNAPS)
            finally:
                session.CURRENT.clear()
                session.CURRENT.update(old)
                session.STATE_FILE = old_state

    def test_load_state_ignores_missing_md(self):
        # md 已删的会话不应恢复
        with tempfile.TemporaryDirectory() as d:
            old = dict(session.CURRENT)
            old_state = session.STATE_FILE
            session.STATE_FILE = os.path.join(d, "state.json")
            _clear_session()
            with open(session.STATE_FILE, "w", encoding="utf-8") as f:
                json.dump({
                    "session": {
                        "work_dir": d,
                        "md_path": os.path.join(d, "不存在.md"),
                        "docx_path": os.path.join(d, "x.docx"),
                        "snap_dir": os.path.join(d, "快照"),
                    },
                }, f)
            try:
                app.load_state()
                self.assertFalse(app.has_session())
            finally:
                session.CURRENT.clear()
                session.CURRENT.update(old)
                session.STATE_FILE = old_state

    def test_load_state_restores_md_workdir(self):
        # 打开 md 后的会话（工作目录=md 所在目录）应能恢复
        with tempfile.TemporaryDirectory() as d:
            old = dict(session.CURRENT)
            old_state = session.STATE_FILE
            session.STATE_FILE = os.path.join(d, "state.json")
            _clear_session()
            md = os.path.join(d, "稿.md")
            with open(md, "w", encoding="utf-8") as f:
                f.write("# 恢复我")
            with open(session.STATE_FILE, "w", encoding="utf-8") as f:
                json.dump({
                    "session": {
                        "work_base": d, "work_dir": d, "md_path": md,
                        "docx_path": os.path.join(d, "稿.docx"),
                        "snap_dir": os.path.join(d, "快照"),
                    },
                }, f)
            try:
                app.load_state()
                self.assertTrue(app.has_session())
                self.assertEqual(app.CURRENT["work_dir"], d)
                self.assertEqual(app.CURRENT["md_path"], md)
            finally:
                session.CURRENT.clear()
                session.CURRENT.update(old)
                session.STATE_FILE = old_state


class TestRoundtrip(unittest.TestCase):
    def test_md_docx_md_roundtrip(self):
        md = (
            "# 2026年上半年个人工作总结\n\n"
            "## 一、坚持政治引领\n\n"
            "### （一）加强理论学习\n\n"
            "**一是统筹推进。**始终坚持第一议题学习。\n\n"
            "| 序号 | 项目 |\n|------|------|\n| 1 | 大冬会 |\n\n"
            '<div align="right">二〇二六年八月</div>\n'
        )
        with tempfile.TemporaryDirectory() as d:
            m1 = os.path.join(d, "a.md")
            d1 = os.path.join(d, "a.docx")
            m2 = os.path.join(d, "b.md")
            with open(m1, "w", encoding="utf-8") as f:
                f.write(md)
            rc, _, err = app.run_converter("md2docx.py", m1, d1)
            self.assertEqual(rc, 0, err)
            rc, _, err = app.run_converter("docx2md.py", d1, m2)
            self.assertEqual(rc, 0, err)
            with open(m2, encoding="utf-8") as f:
                out = f.read()
            for key in ["2026年上半年个人工作总结", "一、坚持政治引领", "（一）加强理论学习",
                        "统筹推进", "大冬会", "二〇二六年八月", "序号", "1"]:
                self.assertIn(key, out)

    def test_inline_marks_roundtrip(self):
        """下划线 / 红字 / 黑底白字：md→docx→md 保留。"""
        md = (
            '普通<u>下划线</u>继续。\n\n'
            '这是<span style="color:red">红字</span>标注。\n\n'
            '这是<span style="background:#000;color:#fff">黑底</span>强调。\n'
        )
        with tempfile.TemporaryDirectory() as d:
            m1 = os.path.join(d, "a.md")
            d1 = os.path.join(d, "a.docx")
            m2 = os.path.join(d, "b.md")
            with open(m1, "w", encoding="utf-8") as f:
                f.write(md)
            rc, _, err = app.run_converter("md2docx.py", m1, d1)
            self.assertEqual(rc, 0, err)
            rc, _, err = app.run_converter("docx2md.py", d1, m2)
            self.assertEqual(rc, 0, err)
            with open(m2, encoding="utf-8") as f:
                out = f.read()
            self.assertIn("<u>", out)
            self.assertIn("下划线", out)
            self.assertIn("color:red", out)
            self.assertIn("红字", out)
            self.assertIn("background:#000", out)
            self.assertIn("黑底", out)


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workdir = tempfile.mkdtemp()
        cls.old_current = dict(session.CURRENT)
        cls.old_state = session.STATE_FILE
        _clear_session()
        session.STATE_FILE = os.path.join(cls.workdir, "state.json")
        from http.server import ThreadingHTTPServer
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        session.CURRENT.clear()
        session.CURRENT.update(cls.old_current)
        session.STATE_FILE = cls.old_state

    def setUp(self):
        _clear_session()

    def _request(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        conn.request(method, path, body=body, headers=headers or {})
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res.status, data

    def test_save_requires_open(self):
        status, data = self._request("POST", "/api/save",
                                     json.dumps({"md": "你好"}).encode("utf-8"),
                                     {"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertIn("请先打开", json.loads(data)["error"])

    def test_close_clears_session(self):
        _open_in_tmp(self.workdir, "关闭测试.docx", "# 关掉我\n\n正文")
        self.assertTrue(app.has_session())
        status, data = self._request("POST", "/api/close")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)["ok"])
        self.assertFalse(app.has_session())
        # 磁盘 md 仍在
        self.assertTrue(os.path.isfile(os.path.join(self.workdir, "关闭测试.md")))
        status, data = self._request("GET", "/api/content")
        self.assertEqual(json.loads(data)["work_dir"], "")
        self.assertEqual(json.loads(data)["md"], "")

    def test_save_and_content(self):
        _open_in_tmp(self.workdir, "保存测试.docx", "# 原始\n\n原文")
        status, _ = self._request("POST", "/api/save",
                                  json.dumps({"md": "你好，公文"}).encode("utf-8"),
                                  {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        status, data = self._request("GET", "/api/content")
        self.assertEqual(status, 200)
        body = json.loads(data)
        self.assertEqual(body["md"], "你好，公文")
        self.assertTrue(body["hash"])
        self.assertEqual(body["work_dir"], self.workdir)

    def test_save_version_to_var(self):
        _open_in_tmp(self.workdir, "版本测试.docx", "# 版本A\n\n正文")
        status, data = self._request("POST", "/api/save-version")
        self.assertEqual(status, 200, data)
        body = json.loads(data)
        self.assertTrue(body["ok"])
        self.assertTrue(body["filename"].startswith("版本测试_"))
        self.assertTrue(body["filename"].endswith(".md"))
        # 版本落在工作区根「版本/」
        ver_path = os.path.join(self.workdir, "版本", body["filename"])
        self.assertTrue(os.path.isfile(ver_path), ver_path)
        # 工作区原 md 仍在
        self.assertTrue(os.path.isfile(os.path.join(self.workdir, "版本测试.md")))

    def test_export_docx(self):
        _open_in_tmp(self.workdir, "导出测试.docx")
        self._request("POST", "/api/save",
                      json.dumps({"md": "# 标题\n\n正文"}).encode("utf-8"),
                      {"Content-Type": "application/json"})
        status, data = self._request("GET", "/api/export?fmt=docx")
        self.assertEqual(status, 200)
        self.assertTrue(data.startswith(b"PK"))
        self.assertGreater(len(data), 100)

    def test_open_pick_route(self):
        # 「打开docx文件」→ 原生文件对话框（mock）→ 工作目录=文件所在目录
        md = "# 原生打开\n\n正文"
        src_md = os.path.join(self.workdir, "pick.src.md")
        docx = os.path.join(self.workdir, "原生打开.docx")
        with open(src_md, "w", encoding="utf-8") as f:
            f.write(md)
        rc, _, err = app.run_converter("md2docx.py", src_md, docx)
        self.assertEqual(rc, 0, err)
        old_pick = dialogs.pick_file_dialog
        dialogs.pick_file_dialog = lambda kind="docx": docx
        try:
            status, data = self._request("POST", "/api/open-pick?kind=docx")
            self.assertEqual(status, 200, data)
            r = json.loads(data)
            self.assertTrue(r["ok"], r)
            self.assertEqual(r["filename"], "原生打开.docx")
            self.assertEqual(r["work_dir"], self.workdir)
            self.assertEqual(app.CURRENT["work_dir"], self.workdir)
            self.assertEqual(app.CURRENT["md_path"], os.path.join(self.workdir, "原生打开.md"))
        finally:
            dialogs.pick_file_dialog = old_pick

    def test_open_pick_cancel(self):
        old_pick = dialogs.pick_file_dialog
        dialogs.pick_file_dialog = lambda kind="docx": None
        try:
            status, _ = self._request("POST", "/api/open-pick")
            self.assertEqual(status, 400)
        finally:
            dialogs.pick_file_dialog = old_pick

    def test_content_empty_when_no_session(self):
        status, data = self._request("GET", "/api/content")
        self.assertEqual(status, 200)
        body = json.loads(data)
        self.assertEqual(body["work_dir"], "")
        self.assertEqual(body["md"], "")


class TestOpenPath(unittest.TestCase):
    """打开文档：工作目录 = 文件所在目录（不套 work/）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._old_current = dict(session.CURRENT)
        self._old_state = session.STATE_FILE
        _clear_session()
        session.STATE_FILE = os.path.join(self.tmp, "state.json")

    def tearDown(self):
        session.CURRENT.clear()
        session.CURRENT.update(self._old_current)
        session.STATE_FILE = self._old_state

    def _make_docx(self, path, md):
        m = path + ".src.md"
        with open(m, "w", encoding="utf-8") as f:
            f.write(md)
        rc, _, err = app.run_converter("md2docx.py", m, path)
        self.assertEqual(rc, 0, err)

    def test_open_path_builds_work_next_to_docx(self):
        # 打开哪个文件，工作目录就是它所在目录；md 落同目录
        docx = os.path.join(self.tmp, "工作总结.docx")
        self._make_docx(docx, "# 测试标题\n\n正文内容")
        r = app.open_document(docx)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["filename"], "工作总结.docx")
        w = app.CURRENT["work_dir"]
        self.assertEqual(w, self.tmp)
        self.assertEqual(app.CURRENT["md_path"], os.path.join(self.tmp, "工作总结.md"))
        self.assertEqual(app.CURRENT["docx_path"], os.path.join(self.tmp, "工作总结.docx"))
        self.assertTrue(os.path.exists(os.path.join(self.tmp, "工作总结.md")))
        self.assertTrue(os.path.isdir(os.path.join(self.tmp, "快照")))
        self.assertEqual(r["md"].rstrip("\n"), "# 测试标题\n\n正文内容")
        with open(session.STATE_FILE, encoding="utf-8") as f:
            st = json.load(f)
        self.assertNotIn("base", st)
        self.assertEqual(st["session"]["work_dir"], w)

    def test_open_path_reopen_needs_confirm(self):
        # 重开同名 docx：已有 md 时不覆盖，返回 need_confirm
        docx = os.path.join(self.tmp, "报告.docx")
        self._make_docx(docx, "# 原始内容")
        r1 = app.open_document(docx)
        self.assertTrue(r1["ok"], r1)
        md_path = app.CURRENT["md_path"]
        app.atomic_write(md_path, "# 我在本地改过\n\n新的编辑")
        r2 = app.open_document(docx)  # force=False
        self.assertFalse(r2["ok"])
        self.assertTrue(r2.get("need_confirm"))
        with open(md_path, encoding="utf-8") as f:
            self.assertEqual(f.read().rstrip("\n"), "# 我在本地改过\n\n新的编辑")

    def test_open_path_force_overwrites_md(self):
        # force=True：按 docx 重新转换覆盖 md（覆盖前有快照）
        docx = os.path.join(self.tmp, "报告.docx")
        self._make_docx(docx, "# 来自Word")
        r1 = app.open_document(docx)
        self.assertTrue(r1["ok"], r1)
        md_path = app.CURRENT["md_path"]
        app.atomic_write(md_path, "# 本地改过\n\n应被覆盖")
        r2 = app.open_document(docx, force=True)
        self.assertTrue(r2["ok"], r2)
        self.assertIn("来自Word", r2["md"])
        self.assertNotIn("应被覆盖", r2["md"])
        snap = os.path.join(self.tmp, "快照")
        self.assertTrue(any(f.startswith("快照_") for f in os.listdir(snap)))

    def test_open_path_missing_file(self):
        r = app.open_document(os.path.join(self.tmp, "不存在.docx"))
        self.assertFalse(r["ok"])

    def test_open_path_bad_extension(self):
        bad = os.path.join(self.tmp, "a.txt")
        with open(bad, "w", encoding="utf-8") as f:
            f.write("x")
        r = app.open_document(bad)
        self.assertFalse(r["ok"])

    def test_open_path_chinese_dirname(self):
        # 中文目录名也能正确打开（工作目录 = 该目录）
        d = os.path.join(self.tmp, "涛总个人材料", "半年工作总结")
        os.makedirs(d)
        docx = os.path.join(d, "2026年上半年个人工作总结（涛总）.docx")
        self._make_docx(docx, "# 中文路径\n\n正文")
        r = app.open_document(docx)
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["work_dir"], d)
        self.assertTrue(os.path.isfile(os.path.join(d, "2026年上半年个人工作总结（涛总）.md")))

    def test_open_path_md_source(self):
        # 打开 md：所在目录就是工作目录
        src = os.path.join(self.tmp, "草稿.md")
        with open(src, "w", encoding="utf-8") as f:
            f.write("# 草稿\n\n内容")
        r = app.open_document(src)
        self.assertTrue(r["ok"], r)
        self.assertEqual(app.CURRENT["work_dir"], self.tmp)
        self.assertEqual(app.CURRENT["md_path"], src)
        self.assertTrue(os.path.isdir(os.path.join(self.tmp, "快照")))
        self.assertEqual(r["md"].rstrip("\n"), "# 草稿\n\n内容")

    def test_open_path_md_in_work_direct(self):
        # 打开 work\\xxx.md：工程根上抬到 work 的父目录
        w = os.path.join(self.tmp, "work")
        os.makedirs(w)
        md = os.path.join(w, "总结.md")
        with open(md, "w", encoding="utf-8") as f:
            f.write("# 已有编辑\n\n正文保留")
        r = app.open_document(md)
        self.assertTrue(r["ok"], r)
        self.assertEqual(app.CURRENT["work_dir"], self.tmp)
        self.assertEqual(app.CURRENT["md_path"], md)
        self.assertFalse(os.path.isdir(os.path.join(w, "work")))
        self.assertEqual(r["md"].rstrip("\n"), "# 已有编辑\n\n正文保留")


if __name__ == "__main__":
    unittest.main()
