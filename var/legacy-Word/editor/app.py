#!/usr/bin/env python3
"""公文所见即所得编辑器 —— 本地后端入口

用法:
    python app.py [端口]
启动后浏览器打开 http://127.0.0.1:8765
依赖: python-docx（tools/docx2md.py、tools/md2docx.py 已需要）
"""
import sys
from http.server import ThreadingHTTPServer

# 供 test_app 与外部 `import app` 使用的稳定导出
from dialogs import initial_dir, pick_file_dialog  # noqa: F401
from server import Handler  # noqa: F401
from session import (  # noqa: F401
    BASE, CURRENT, KEEP_SNAPS, STATE_FILE, TOOLS,
    atomic_write, clear_session, cur, has_session, load_state,
    md_hash, open_document, read_md, run_converter, save_state, save_version, snapshot,
)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    load_state()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"公文所见即所得编辑器已启动： http://127.0.0.1:{port}")
    if has_session():
        print(f"已恢复工作目录：{CURRENT['work_dir']}")
    else:
        print("首次「打开docx」→ 旁路 work\\；关闭后「打开md」继续编辑")
    print("浏览器打开上面的地址。按 Ctrl+C 停止。")
    server.serve_forever()


if __name__ == "__main__":
    main()
