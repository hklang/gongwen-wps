"""docx -> md 转换脚本（保留格式层级，支持 md2docx 回排）

用法:
  python docx2md.py input.docx [output.md]

识别规则（基于字体/字号/加粗；字体缺失时按文案编号回退）:
  宋体/方正小标宋 >=20pt 居中  → # 大标题
  黑体 15-18pt                → ## 一级标题
  楷体 15-17pt + 加粗          → ### 二级标题
  仿宋 15-17pt + 加粗 + 无缩进 → #### 三级标题
  文案「一、xxx」（整段≤80字）  → ## 一级标题（字体回退）
  文案「（一）xxx」（整段≤80字）→ ### 二级标题（字体回退）
  仿宋 段内混排(前加黑后正常)   → **前缀。**正文
  仿宋 整段加黑               → **整段**
  右对齐 / 居中短署名          → <div align="right">xxx</div>
  仿宋 无缩进 + 括号           → *（注释）*
  仿宋 首行缩进               → 普通正文

与 md2docx.py 配合可实现 docx → md → docx 闭环转换。
"""
import sys
import os
import re
import zipfile
from xml.etree import ElementTree as ET

# === 命名空间 ===
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
WPML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

# === 标题识别配置 ===
H1_FONTS = ['方正大标宋', '方正小标宋', '方正小标宋简体', '宋体']
H1_MIN_PT = 20
H2_FONTS = ['黑体']
H2_PTS = {15, 16, 18}
H3_FONTS = ['楷体', '楷体_GB2312']
H3_PTS = {15, 16, 17}
BODY_FONTS = ['仿宋', '仿宋_GB2312']
BODY_PTS = {15, 16, 17}

# 中文编号：字体缺失时按文案识别标题层级
_CN_NUM = r'[一二三四五六七八九十百千零〇两]+'
_H2_TEXT = re.compile(rf'^{_CN_NUM}、')          # 一、二、…
_H3_TEXT = re.compile(rf'^（{_CN_NUM}）')         # （一）（二）…


def _elem(tag):
    return f'{{{W}}}{tag}'


def _get_font_info(rPr):
    """从 w:rPr 提取字体名、字号(half-pts)、是否加粗"""
    font_name = None
    font_size = None
    is_bold = False

    if rPr is None:
        return font_name, font_size, is_bold

    rFonts = rPr.find(_elem('rFonts'))
    if rFonts is not None:
        font_name = rFonts.get(f'{{{W}}}eastAsia') or rFonts.get(f'{{{W}}}ascii')

    sz = rPr.find(_elem('sz'))
    if sz is not None:
        val = sz.get(f'{{{W}}}val')
        if val:
            font_size = int(val) // 2  # half-points → pt

    b = rPr.find(_elem('b'))
    if b is not None:
        val = b.get(f'{{{W}}}val')
        # 无 val 或 val=1/true → 加粗；val=0/false → 不加粗
        if val is None or val in ('1', 'true'):
            is_bold = True

    return font_name, font_size, is_bold


def _get_paragraph_style(pPr):
    """获取段落样式ID"""
    if pPr is None:
        return None
    pStyle = pPr.find(_elem('pStyle'))
    if pStyle is not None:
        return pStyle.get(f'{{{W}}}val')
    return None


def _get_indent(pPr):
    """获取段落缩进信息，返回 (first_line_chars, first_line_pts)"""
    if pPr is None:
        return None, None
    ind = pPr.find(_elem('ind'))
    if ind is None:
        return None, None
    chars = ind.get(f'{{{W}}}firstLineChars')
    pts = ind.get(f'{{{W}}}firstLine')
    return int(chars) if chars else None, int(pts) if pts else None


def _get_alignment(pPr):
    """获取段落对齐方式"""
    if pPr is None:
        return None
    jc = pPr.find(_elem('jc'))
    if jc is not None:
        val = jc.get(f'{{{W}}}val')
        return val
    return None


def _get_run_marks(rPr):
    """下划线 / 字体色 / 高亮底。"""
    marks = {'bold': False, 'underline': False, 'color': None, 'black_bg': False}
    if rPr is None:
        return marks
    _, _, is_bold = _get_font_info(rPr)
    marks['bold'] = is_bold

    u = rPr.find(_elem('u'))
    if u is not None:
        val = u.get(f'{{{W}}}val')
        if val is None or val.lower() not in ('none', '0', 'false'):
            marks['underline'] = True

    color = rPr.find(_elem('color'))
    if color is not None:
        val = (color.get(f'{{{W}}}val') or '').upper()
        if val and val not in ('AUTO', '000000', '000000'):
            marks['color'] = val

    hl = rPr.find(_elem('highlight'))
    if hl is not None:
        val = (hl.get(f'{{{W}}}val') or '').lower()
        if val == 'black':
            marks['black_bg'] = True

    shd = rPr.find(_elem('shd'))
    if shd is not None:
        fill = (shd.get(f'{{{W}}}fill') or '').upper()
        if fill in ('000000', '000'):
            marks['black_bg'] = True

    return marks


def _extract_runs(para_elem):
    """提取段落 run，合并相邻同标记片段。返回 [(text, marks), ...]。"""
    runs = para_elem.findall(_elem('r'))
    result = []

    for r in runs:
        rPr = r.find(_elem('rPr'))
        marks = _get_run_marks(rPr)
        texts = []
        for t in r.findall(_elem('t')):
            if t.text:
                texts.append(t.text)
        if not texts:
            continue
        text = ''.join(texts)
        if result and result[-1][1] == marks:
            result[-1] = (result[-1][0] + text, marks)
        else:
            result.append((text, marks))

    return result


def parse_docx(filepath):
    """解析 docx 文件，返回段落列表"""
    paragraphs = []

    with zipfile.ZipFile(filepath) as z:
        if 'word/document.xml' not in z.namelist():
            raise ValueError('Not a valid .docx: word/document.xml not found')
        with z.open('word/document.xml') as f:
            tree = ET.parse(f)

    root = tree.getroot()
    para_elems = root.findall(f'.//{_elem("p")}')

    for p_elem in para_elems:
        pPr = p_elem.find(_elem('pPr'))

        # 获取首 run 字体信息
        first_rPr = None
        first_r = p_elem.find(_elem('r'))
        if first_r is not None:
            first_rPr = first_r.find(_elem('rPr'))

        first_font, first_size, first_bold = _get_font_info(first_rPr)
        style_id = _get_paragraph_style(pPr)
        indent_chars, indent_pts = _get_indent(pPr)
        alignment = _get_alignment(pPr)
        runs = _extract_runs(p_elem)

        # 获取全文
        full_text = ''.join(t for t, _ in runs).strip()

        paragraphs.append({
            'text': full_text,
            'runs': runs,
            'first_font': first_font,
            'first_size': first_size,
            'first_bold': first_bold,
            'style_id': style_id,
            'indent_chars': indent_chars,
            'indent_pts': indent_pts,
            'alignment': alignment,
        })

    return paragraphs


def classify_paragraph(p):
    """分类段落，返回 (type, md_text)"""
    text = p['text']
    runs = p['runs']
    style = p['style_id']
    font = p['first_font'] or ''
    size = p['first_size']
    bold = p['first_bold']
    align = p['alignment']
    indent_chars = p['indent_chars']

    if not text:
        return 'empty', ''

    # style=a4 → 期号行或日期署名
    if style == 'a4':
        if re.match(r'（第.*期）', text):
            return 'period', f'*{text}*'
        else:
            return 'meta', text

    # style=1 → 二级标题(简报副标题)
    if style == '1':
        return 'h3', f'### {text}'

    # H1: 宋体/方正大标宋/方正小标宋 >=20pt
    is_h1_font = any(f in font for f in H1_FONTS)
    if is_h1_font and size and size >= H1_MIN_PT:
        return 'h1', f'# {text}'

    # H2: 黑体 15-18pt
    is_h2_font = any(f in font for f in H2_FONTS)
    if is_h2_font and size in H2_PTS:
        return 'h2', f'## {text}'

    # H3: 楷体 15-17pt + 加粗
    is_h3_font = any(f in font for f in H3_FONTS)
    if is_h3_font and size in H3_PTS and bold:
        return 'h3', f'### {text}'

    # 文本模式回退：源稿未用黑体/楷体、或字号写在样式里 run 无 sz 时
    # 「一、xxx」→ 一级；「（一）xxx」→ 二级（整段即标题，不含正文）
    if _H2_TEXT.match(text) and len(text) <= 80:
        return 'h2', f'## {text}'
    if _H3_TEXT.match(text) and len(text) <= 80:
        return 'h3', f'### {text}'

    # H4: 仿宋 15-17pt + 整段加粗 + 无缩进
    is_body_font = any(f in font for f in BODY_FONTS)
    if is_body_font and size in BODY_PTS:
        has_bold = any(m.get('bold') for _, m in runs)
        all_bold = all(m.get('bold') for _, m in runs if _)
        has_extra = any(
            m.get('underline') or m.get('color') or m.get('black_bg')
            for _, m in runs
        )

        # 段内混排：加黑混排，或带下划线/颜色/黑底
        if (has_bold and not all_bold) or has_extra:
            return 'body_mixed', _build_inline_md(runs)

        # 整段加黑
        if all_bold and text:
            if indent_chars is not None and indent_chars == 0:
                return 'h4', f'#### {text}'
            return 'body_bold', f'**{text}**'

        if align == 'right':
            return 'right', f'<div align="right">{text}</div>'

        if indent_chars is not None and indent_chars == 0:
            if re.match(r'^（.+）$', text):
                return 'comment', f'*{text}*'

        return 'body', text

    # 居中短行（如署名）：按公文规范改为右对齐
    if align == 'center' and len(text) <= 40 and not _H2_TEXT.match(text) and not _H3_TEXT.match(text):
        return 'right', f'<div align="right">{text}</div>'

    # 右对齐兜底
    if align == 'right':
        return 'right', f'<div align="right">{text}</div>'

    # fallback: 普通正文（再扫一遍编号标题，覆盖无字体信息的段落）
    if _H2_TEXT.match(text) and len(text) <= 80:
        return 'h2', f'## {text}'
    if _H3_TEXT.match(text) and len(text) <= 80:
        return 'h3', f'### {text}'
    if runs and any(
        m.get('underline') or m.get('color') or m.get('black_bg') or m.get('bold')
        for _, m in runs
    ):
        return 'body_mixed', _build_inline_md(runs)
    return 'body', text


def _is_red_color(val):
    if not val:
        return False
    c = val.upper().lstrip('#')
    return c in ('FF0000', 'F00', 'C00000', 'FF0') or (
        len(c) == 6 and c[0:2] == 'FF' and c[2:4] == '00' and c[4:6] == '00'
    )


def _build_inline_md(runs):
    """段内混排 → md/HTML：加黑 / 下划线 / 红字 / 黑底白字。"""
    parts = []
    for text, m in runs:
        if not text:
            continue
        t = text
        if m.get('bold'):
            t = f'**{t}**'
        if m.get('underline'):
            t = f'<u>{t}</u>'
        if m.get('black_bg'):
            t = f'<span style="background:#000;color:#fff">{t}</span>'
        elif _is_red_color(m.get('color')):
            t = f'<span style="color:red">{t}</span>'
        parts.append(t)
    return ''.join(parts)


def convert(docx_path, md_path=None):
    if md_path is None:
        md_path = os.path.splitext(docx_path)[0] + '.md'

    if not os.path.exists(docx_path):
        print(f'ERROR: File not found: {docx_path}')
        sys.exit(1)

    paragraphs = parse_docx(docx_path)
    print(f'INFO: Found {len(paragraphs)} paragraphs')

    lines = []
    prev_blank = False
    seen_h1 = set()

    for p in paragraphs:
        ptype, md_text = classify_paragraph(p)

        if ptype == 'empty':
            # 连续空行合并为一个
            if not prev_blank and lines:
                lines.append('')
                prev_blank = True
            continue
        prev_blank = False

        # H1 去重
        if ptype == 'h1':
            clean = md_text[2:]  # strip '# '
            if clean in seen_h1:
                continue
            seen_h1.add(clean)

        # 标题前加空行
        if ptype in ('h1', 'h2', 'h3', 'h4', 'period') and lines and lines[-1] != '':
            lines.append('')

        lines.append(md_text)

        # 段落后空一行，便于 md / 编辑器分段
        lines.append('')
        prev_blank = True

    # 去掉末尾多余空行，保留一个换行
    while lines and lines[-1] == '':
        lines.pop()
    content = '\n'.join(lines) + '\n'
    with open(md_path, 'w', encoding='utf-8') as f:
        f.write(content)

    print(f'DONE: {md_path}')
    print(f'  Lines: {len(lines)}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    docx_file = sys.argv[1]
    md_file = sys.argv[2] if len(sys.argv) > 2 else None
    convert(docx_file, md_file)
