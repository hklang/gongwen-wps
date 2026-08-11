#!/usr/bin/env python3
"""系统原生文件选择对话框（Windows）。"""
import os
import subprocess
import sys

from session import CURRENT


def initial_dir(kind="docx"):
    """对话框初始目录：md 优先上次工作区，docx 优先文件原目录。"""
    if kind == "md":
        if CURRENT.get("work_dir") and os.path.isdir(CURRENT["work_dir"]):
            return CURRENT["work_dir"]
        if CURRENT.get("work_base"):
            w = os.path.join(CURRENT["work_base"], "work")
            if os.path.isdir(w):
                return w
    if CURRENT.get("work_base") and os.path.isdir(CURRENT["work_base"]):
        return CURRENT["work_base"]
    if CURRENT.get("md_path"):
        parent = os.path.dirname(CURRENT["md_path"])
        if os.path.basename(parent) == "work":
            return os.path.dirname(parent) if kind == "docx" else parent
        return parent
    home = os.path.expanduser("~")
    for docs in (os.path.join(home, "Documents"),
                 os.path.join(home, "OneDrive", "Documents")):
        if os.path.isdir(docs):
            return docs
    return home


def pick_file_dialog(kind="docx"):
    """弹出系统打开文件框，返回路径；取消返回 None。

    路径经 UTF-8 临时文件回传，避免控制台编码弄乱中文路径。
    """
    import platform
    import tempfile

    if platform.system() != "Windows":
        return None
    out = os.path.join(tempfile.gettempdir(), f"gongwen_pick_{os.getpid()}.txt")
    try:
        if os.path.exists(out):
            os.remove(out)
    except Exception:
        pass

    def _read_out():
        if not os.path.isfile(out):
            return None
        try:
            with open(out, "r", encoding="utf-8") as f:
                p = f.read().strip().strip('"')
        finally:
            try:
                os.remove(out)
            except Exception:
                pass
        return p or None

    if kind == "md":
        title = "打开 md 文件（继续编辑）"
        tk_types = "[('Markdown', '*.md'), ('所有文件', '*.*')]"
        ps_filter = "Markdown (*.md)|*.md|所有文件 (*.*)|*.*"
    elif kind in ("all", "file", "any"):
        title = "打开文稿"
        tk_types = (
            "[('文稿', '*.md;*.docx'), ('Markdown', '*.md'), "
            "('Word 文档', '*.docx'), ('所有文件', '*.*')]"
        )
        ps_filter = (
            "文稿 (*.md;*.docx)|*.md;*.docx|"
            "Markdown (*.md)|*.md|"
            "Word 文档 (*.docx)|*.docx|"
            "所有文件 (*.*)|*.*"
        )
    else:
        title = "打开 docx 文件"
        tk_types = "[('Word 文档', '*.docx'), ('所有文件', '*.*')]"
        ps_filter = "Word 文档 (*.docx)|*.docx|所有文件 (*.*)|*.*"

    script = (
        "import tkinter as tk, sys\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk(); root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        f"p = filedialog.askopenfilename(title={title!r}, "
        "initialdir=sys.argv[1] if len(sys.argv) > 1 else '', "
        f"filetypes={tk_types})\n"
        "open(sys.argv[2], 'w', encoding='utf-8').write(p or '')\n"
    )
    try:
        subprocess.run(
            [sys.executable, "-c", script, initial_dir(kind), out],
            timeout=1800,
        )
        p = _read_out()
        if p:
            return p
    except Exception:
        pass

    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.OpenFileDialog;"
        f"$d.Title = '{title}';"
        f"$d.Filter = '{ps_filter}';"
        "$d.InitialDirectory = @'\n" + initial_dir(kind) + "\n'@;"
        "if ($d.ShowDialog() -eq 'OK') {"
        "  $utf8 = New-Object System.Text.UTF8Encoding $false;"
        "  [IO.File]::WriteAllText(@'\n" + out + "\n'@, $d.FileName, $utf8)"
        "}"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", ps],
            timeout=1800,
        )
        p = _read_out()
        if p:
            return p
    except Exception:
        pass
    return None


def save_file_dialog(kind="md", default_name="未命名.md"):
    """弹出系统「另存为」框，返回路径；取消返回 None。"""
    import platform
    import tempfile

    if platform.system() != "Windows":
        return None
    out = os.path.join(tempfile.gettempdir(), f"gongwen_save_{os.getpid()}.txt")
    try:
        if os.path.exists(out):
            os.remove(out)
    except Exception:
        pass

    def _read_out():
        if not os.path.isfile(out):
            return None
        try:
            with open(out, "r", encoding="utf-8") as f:
                p = f.read().strip().strip('"')
        finally:
            try:
                os.remove(out)
            except Exception:
                pass
        return p or None

    title = "创建 md 文件"
    tk_types = "[('Markdown', '*.md'), ('所有文件', '*.*')]"
    ps_filter = "Markdown (*.md)|*.md|所有文件 (*.*)|*.*"
    init = initial_dir("md")
    name = default_name if str(default_name).lower().endswith(".md") else (
        str(default_name or "未命名") + ".md"
    )

    script = (
        "import tkinter as tk, sys, os\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk(); root.withdraw()\n"
        "root.attributes('-topmost', True)\n"
        f"p = filedialog.asksaveasfilename(title={title!r}, "
        "initialdir=sys.argv[1] if len(sys.argv) > 1 else '', "
        "initialfile=sys.argv[3] if len(sys.argv) > 3 else '未命名.md', "
        f"defaultextension='.md', filetypes={tk_types})\n"
        "open(sys.argv[2], 'w', encoding='utf-8').write(p or '')\n"
    )
    try:
        subprocess.run(
            [sys.executable, "-c", script, init, out, name],
            timeout=1800,
        )
        p = _read_out()
        if p:
            return p
    except Exception:
        pass

    ps = (
        "Add-Type -AssemblyName System.Windows.Forms;"
        "$d = New-Object System.Windows.Forms.SaveFileDialog;"
        f"$d.Title = '{title}';"
        f"$d.Filter = '{ps_filter}';"
        "$d.DefaultExt = 'md';"
        "$d.AddExtension = $true;"
        "$d.FileName = @'\n" + name + "\n'@;"
        "$d.InitialDirectory = @'\n" + init + "\n'@;"
        "if ($d.ShowDialog() -eq 'OK') {"
        "  $utf8 = New-Object System.Text.UTF8Encoding $false;"
        "  [IO.File]::WriteAllText(@'\n" + out + "\n'@, $d.FileName, $utf8)"
        "}"
    )
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-STA", "-Command", ps],
            timeout=1800,
        )
        p = _read_out()
        if p:
            return p
    except Exception:
        pass
    return None
