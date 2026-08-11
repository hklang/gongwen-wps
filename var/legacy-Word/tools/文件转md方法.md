# PDF / Word / PPT 转 Markdown 方法

## 一、docx → md（Word 转 Markdown）★

**必须使用 `docx2md.py` 脚本，禁止用 `$doc.Content.Text` 纯文本提取。**

纯文本方式会丢失所有格式信息（标题层级、加粗、字体、字号），导致后续 md→docx 回排时排版错乱。

### 标准用法

```powershell
C:\ProgramData\anaconda3\python.exe tools\docx2md.py "输入文件.docx"
# 输出：同目录同名 .md

C:\ProgramData\anaconda3\python.exe tools\docx2md.py "输入文件.docx" "输出文件.md"
```

本机 Python 路径为 `C:\ProgramData\anaconda3\python.exe`（不能用 `python` 命令，会被 Windows 商店劫持）。

### 脚本原理

直接解析 docx 内部的 `word/document.xml`，**按字体/字号/加粗属性**识别标题层级：

| 识别条件 | MD 层级 | 说明 |
|---------|---------|------|
| 宋体/方正小标宋 ≥20pt | `#` 大标题 | |
| 黑体 15-18pt | `##` 一级标题 | 一、二、三... |
| 楷体 15-17pt + 加粗 | `###` 二级标题 | （一）（二）... |
| 仿宋 15-17pt + 整段加粗 + 无缩进 | `####` 三级标题 | 独立小标题 |
| 仿宋 + 段内加粗混排 | `**前缀。**正文` | 前缀加黑，正文正常 |
| 右对齐 | `<div align="right">` | 署名/日期 |
| 仿宋 + 无缩进 + 括号 | `*（注释）*` | |
| `w:pStyle=1` | `###` 二级标题 | 简报副标题 |
| `w:pStyle=a4` + "（第N期）" | `*期号*` | 期号行 |

### 关键处理规则

1. **加粗合并**：相邻加粗 `<w:r>` 自动合并为一个 `**...**` 区间，避免 `****` 双星号
2. **段内混排识别**：同段内如有加粗+非加粗 run，自动输出 `**前缀。**正文` 格式
3. **空行控制**：连续空 `<w:p>` 最多产生 1 个空行
4. **标题去重**：相同文字的大标题只保留一次
5. **闭环转换**：与 `md2docx_python.py` 配套，docx → md → docx 可保持格式一致

### 常见问题

| 问题 | 原因 | 解决 |
|------|------|------|
| 标题没识别成 `#`/`##` | docx 里用了非标准字体或字号 | 修改脚本 `H1_FONTS` / `H2_FONTS` 配置 |
| 加粗出现 `****` 双星号 | 旧版脚本未合并相邻 run | 更新到最新 docx2md.py |
| 段内混排没识别 | 原 docx 加粗边界不清晰 | 检查原 docx 加粗范围是否准确 |

## 二、pptx → md（PowerPoint 转 Markdown）

使用 PowerPoint COM 逐页提取：

```powershell
$ppt = New-Object -ComObject PowerPoint.Application
$pres = $ppt.Presentations.Open("完整路径.pptx")

$allText = @()
foreach ($slide in $pres.Slides) {
    $allText += "## 第 $($slide.SlideIndex) 页"
    foreach ($shape in $slide.Shapes) {
        if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
            $t = $shape.TextFrame.TextRange.Text.Trim()
            if ($t) { $allText += $t }
        }
    }
    $allText += ""
}
$pres.Close()
$ppt.Quit()

$cleaned = ($allText -join "`r`n`r`n")
[System.IO.File]::WriteAllText("输出.md", $cleaned, [System.Text.UTF8Encoding]::new($false))
```

**注意：**
- 能提取所有文本框内容，但不保留格式层级
- 图片、图表、SmartArt 中的文字无法提取
- 页面顺序保留，每页用 `## 第N页` 标记

## 三、pdf → md（PDF 转 Markdown）

### 方法 A：Python pdfplumber（推荐）

最可靠的方式，文本提取质量高：

```powershell
# 首次安装
C:\ProgramData\anaconda3\python.exe -m pip install pdfplumber
```

```python
import pdfplumber

with pdfplumber.open("输入.pdf") as pdf:
    pages = []
    for i, page in enumerate(pdf.pages):
        text = page.extract_text()
        if text:
            pages.append(f'## 第{i+1}页\n\n{text}')

with open("输出.md", "w", encoding="utf-8") as f:
    f.write('\n\n'.join(pages))
```

**注意：**
- 本机 Python 路径为 `C:\ProgramData\anaconda3\python.exe`（不能用 `python` 命令，会被 Windows 商店的假 python 劫持）
- 纯图片 PDF 无法提取文字（如扫描件）
- 双栏排版的 PDF 文字会碎片化（中文和英文交叉），后续需要人工整理

### 方法 B：Word COM 打开 PDF

仅适用于内容简单、体积较小的 PDF：

```powershell
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $word.Documents.Open("完整路径.pdf", $false, $true)
$text = $doc.Content.Text
$doc.Close()
$word.Quit()
```

**注意：**
- 大型 PDF（>10MB）或复杂排版会导致 Word 卡死
- 如果 Word 弹出转换对话框，脚本会挂住，需要手动杀 WINWORD 进程

### 方法 C：raw 正则提取（不可靠，仅作最后手段）

直接读 PDF 字节流，用正则匹配 `(文本)` 模式：

```powershell
$bytes = [System.IO.File]::ReadAllBytes("输入.pdf")
$text = [System.Text.Encoding]::UTF8.GetString($bytes)
$matches = [regex]::Matches($text, '\(([一-鿿\w\s\.\,\;\:\-]+)\)')
```

**注意：** 只能提取到字体名、元数据，正文几乎提取不到（因为 PDF 文本流是压缩的）。

## 四、批量转换脚本模板

```powershell
# 批量转换目录下所有 docx → md
$word = New-Object -ComObject Word.Application
$word.Visible = $false

Get-ChildItem "*.docx" | ForEach-Object {
    $doc = $word.Documents.Open($_.FullName)
    $text = $doc.Content.Text
    $doc.Close()
    
    $outName = $_.BaseName + ".md"
    $lines = $text -split "`r`n" | Where-Object { $_.Trim() -ne "" } | ForEach-Object { $_.Trim() }
    [System.IO.File]::WriteAllText($outName, ($lines -join "`r`n`r`n"), [System.Text.UTF8Encoding]::new($false))
    Write-Output "Done: $outName"
}

$word.Quit()
```

## 五、各方法效果对比

| 源格式 | 推荐方法 | 质量 | 速度 | 备注 |
|--------|---------|------|------|------|
| docx | Word COM | 高 | 快 | 单文件约2秒 |
| pptx | PowerPoint COM | 中 | 快 | 只提取文本，无层级 |
| pdf (文字) | Python pdfplumber | 高 | 中 | 需先安装库 |
| pdf (图文) | Word COM | 中 | 慢 | 大文件卡死 |
| pdf (扫描) | 无法提取 | — | — | 需要 OCR |
