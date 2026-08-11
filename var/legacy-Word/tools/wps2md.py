"""wps(.doc 二进制 OLE2) -> md 转换脚本

用法:
  python wps2md.py input.wps [output.md]

原理: .wps(OLE2 复合文档) 经 antiword 提取纯文本(中文用 UTF-8 映射)，
      再按公文编号模式补充 md 标题层级：
        首个非空段(通常居中)        -> # 标题
        一、二、三 ... 天干序号      -> ## 一级标题
        （一）（二）...             -> ### 二级标题
        其余                        -> 正文(去缩进)
"""
import sys
import os
import re
import subprocess

# 天干/中文数字序号用于一级标题: 一、二、... 、
H2_RE = re.compile(r'^[一二三四五六七八九十]+、')
# （一）（二）全角括号数字
H3_RE = re.compile(r'^（[一二三四五六七八九十]+）')
# 半角括号 (一)(二) 也算
H3_RE2 = re.compile(r'^\([一二三四五六七八九十]+\)')


def extract_text(wps_path):
    """用 antiword 提取文本，返回行列表"""
    # 尝试常见 antiword 路径
    candidates = ['antiword', '/mingw64/bin/antiword', r'C:\Program Files\antiword\antiword.exe']
    cmd = None
    for c in candidates:
        try:
            subprocess.run([c, '-h'], stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, check=False)
            cmd = c
            break
        except FileNotFoundError:
            continue
    if cmd is None:
        raise RuntimeError('未找到 antiword，请安装 antiword 或将其加入 PATH')

    # antiword 中文映射文件名通常为 UTF-8.txt；若无则回退默认
    for mapping in ['UTF-8.txt', '8859-1.txt', '']:
        args = [cmd]
        if mapping:
            args += ['-m', mapping]
        args.append(wps_path)
        try:
            r = subprocess.run(args, capture_output=True)
            txt = r.stdout.decode('utf-8', errors='replace')
            if '大' in txt or '一' in txt or '、' in txt or len(txt) > 50:
                return txt.split('\n')
        except Exception:
            continue
    # 最后兜底：直接取原始字节按 utf-8 解
    r = subprocess.run([cmd, wps_path], capture_output=True)
    return r.stdout.decode('utf-8', errors='replace').split('\n')


def to_md(lines, md_path):
    out = []
    seen_title = False
    prev_blank = False

    for raw in lines:
        # 去掉行首尾空白，但保留用于判断
        stripped = raw.strip()
        if not stripped:
            if out and not prev_blank:
                out.append('')
                prev_blank = True
            continue
        prev_blank = False

        # 第一个非空段 → 标题（公文标题通常居中，antiword 输出带大量前导空格）
        if not seen_title:
            out.append(f'# {stripped}')
            seen_title = True
            if out and out[-1] != '':
                pass
            continue

        # 一级标题
        if H2_RE.match(stripped):
            if out and out[-1] != '':
                out.append('')
            out.append(f'## {stripped}')
            continue
        # 二级标题
        if H3_RE.match(stripped) or H3_RE2.match(stripped):
            if out and out[-1] != '':
                out.append('')
            out.append(f'### {stripped}')
            continue
        # 正文（antiword 已无字体信息，去缩进即可）
        out.append(stripped)

    # 压缩多余空行
    cleaned = []
    for ln in out:
        if ln == '' and cleaned and cleaned[-1] == '':
            continue
        cleaned.append(ln)

    content = '\n'.join(cleaned) + '\n'
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(content)
    print(f'DONE: {md_path}')
    print(f'  Lines: {len(cleaned)}')


def convert(wps_path, md_path=None):
    if md_path is None:
        md_path = os.path.splitext(wps_path)[0] + '.md'
    if not os.path.exists(wps_path):
        print(f'ERROR: File not found: {wps_path}')
        sys.exit(1)
    lines = extract_text(wps_path)
    to_md(lines, md_path)


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    convert(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None)
