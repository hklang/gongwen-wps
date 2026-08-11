"""pptx -> md 转换脚本（直接解析 zip 内 XML，无需 PowerPoint COM）

用法:
  python pptx2md.py input.pptx [output.md]

原理: pptx 是 zip，内部 ppt/slides/slideN.xml 存各页内容。
      提取所有 <a:t> 文本节点，按页输出，每页用 `## 第N页` 标记。
      同一个文本框(Shape <p:sp> -> <p:txBody>) 内的段落用换行分隔。
"""
import sys
import os
import re
import zipfile
from xml.etree import ElementTree as ET

A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'


def _qn(tag):
    """a:p -> {A}p ; a:t -> {A}t"""
    prefix, local = tag.split(':')
    ns = A if prefix == 'a' else P
    return f'{{{ns}}}{local}'


def slide_number(name):
    """ppt/slides/slide1.xml -> 1"""
    m = re.search(r'slide(\d+)\.xml$', name)
    return int(m.group(1)) if m else -1


def extract_slide_text(xml_bytes):
    """从单个 slide xml 提取文本，返回段落字符串列表（每个文本框一段/多段）"""
    root = ET.fromstring(xml_bytes)
    blocks = []

    # 所有文本框 txBody（含普通文本框、表格单元格内的也会被 a:t 覆盖）
    # 直接遍历所有 a:p 段落，收集其下 a:t
    for p in root.iter(_qn('a:p')):
        texts = [t.text for t in p.iter(_qn('a:t')) if t.text]
        line = ''.join(texts).strip()
        if line:
            blocks.append(line)

    # 若 a:p 未覆盖，兜底取所有 a:t
    if not blocks:
        texts = [t.text for t in root.iter(_qn('a:t')) if t.text]
        line = ''.join(texts).strip()
        if line:
            blocks.append(line)

    return blocks


def convert(pptx_path, md_path=None):
    if md_path is None:
        md_path = os.path.splitext(pptx_path)[0] + '.md'

    if not os.path.exists(pptx_path):
        print(f'ERROR: File not found: {pptx_path}')
        sys.exit(1)

    slides = []
    with zipfile.ZipFile(pptx_path) as z:
        names = [n for n in z.namelist() if re.match(r'ppt/slides/slide\d+\.xml$', n)]
        names.sort(key=slide_number)
        print(f'INFO: Found {len(names)} slides')
        for n in names:
            with z.open(n) as f:
                blocks = extract_slide_text(f.read())
            slides.append((slide_number(n), blocks))

    lines = []
    for idx, (num, blocks) in enumerate(slides):
        if idx == 0:
            lines.append(f'## 第 {num} 页')
        else:
            lines.append('')
            lines.append(f'## 第 {num} 页')
        lines.extend(blocks)

    content = '\n'.join(lines) + '\n'
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f'DONE: {md_path}')
    print(f'  Lines: {len(lines)}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pptx_file = sys.argv[1]
    md_file = sys.argv[2] if len(sys.argv) > 2 else None
    convert(pptx_file, md_file)
