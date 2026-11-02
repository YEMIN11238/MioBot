"""Bounded local text extraction. No macros, scripts, links, shell or OCR."""
import json
import os
from pathlib import Path
import re
import sys
import zipfile

LIMIT = 24000
MAX_FILE = 10 * 1024 * 1024
MAX_PAGES = 50


def output(value):
    print(json.dumps(value, ensure_ascii=False))


def fail(code, message):
    output({"ok": False, "error": {"code": code, "message": message}})
    raise SystemExit(0)


def limits():
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
        try:
            resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
        except (ValueError, OSError):
            pass
    except (ImportError, ValueError, OSError):
        pass


def main():
    limits()
    if len(sys.argv) != 3:
        fail("INVALID_FILE", "文件参数无效。")
    path, extension = Path(sys.argv[1]), sys.argv[2]
    if extension not in (".txt", ".md", ".pdf", ".docx") or not path.is_file() or path.is_symlink() or not 0 < path.stat().st_size <= MAX_FILE:
        fail("INVALID_FILE", "文件格式或大小不符合要求。")
    pieces, pages, truncated, notice = [], None, False, ""
    if extension in (".txt", ".md"):
        raw = path.read_bytes()
        try:
            if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
                text = raw.decode("utf-16")
            else:
                try:
                    text = raw.decode("utf-8-sig")
                except UnicodeDecodeError:
                    text = raw.decode("gb18030")
        except UnicodeError:
            fail("UNSUPPORTED_ENCODING", "文本编码无法识别，请另存为UTF-8后上传。")
        if "\x00" in text or sum(ord(c) < 9 or 13 < ord(c) < 32 for c in text[:10000]) > 10:
            fail("INVALID_FILE", "这个文件不像纯文本文件。")
        pieces = [text]
    elif extension == ".pdf":
        if path.read_bytes()[:5] != b"%PDF-":
            fail("INVALID_FILE", "文件内容不是PDF。")
        from pypdf import PdfReader
        reader = PdfReader(str(path), strict=True)
        if reader.is_encrypted:
            fail("ENCRYPTED_FILE", "暂不支持加密PDF，请先提供可读取的副本。")
        pages = len(reader.pages)
        truncated = pages > MAX_PAGES
        size = 0
        for page in reader.pages[:MAX_PAGES]:
            part = page.extract_text() or ""
            pieces.append(part)
            size += len(part)
            if size > LIMIT:
                truncated = True
                break
        if not any(part.strip() for part in pieces):
            fail("OCR_REQUIRED", "PDF没有可提取文字，可能是扫描图片；当前未内置OCR。")
        notice = "PDF最多读取前50页；未识别图像中的文字。"
    else:
        if not zipfile.is_zipfile(path):
            fail("INVALID_FILE", "文件内容不是DOCX。")
        with zipfile.ZipFile(path) as package:
            entries = package.infolist()
            if len(entries) > 2000 or sum(entry.file_size for entry in entries) > 30 * 1024 * 1024:
                fail("DOCUMENT_TOO_COMPLEX", "DOCX解压体积或条目数量超出限额。")
            for entry in entries:
                name = entry.filename.lower()
                if entry.flag_bits & 1 or entry.file_size > 10 * 1024 * 1024 or entry.file_size > 1024 * 1024 and entry.file_size > max(1, entry.compress_size) * 200:
                    fail("DOCUMENT_TOO_COMPLEX", "DOCX包含加密内容或压缩比例过大的条目。")
                if name.startswith("/") or ".." in name.replace("\\", "/").split("/") or "vbaproject" in name or name.endswith((".exe", ".js", ".vbs", ".ps1")):
                    fail("ACTIVE_CONTENT", "文档包含不支持的活动内容。")
                if name.endswith((".xml", ".rels")) and re.search(br"<!\s*(?:DOCTYPE|ENTITY)", package.read(entry), re.I):
                    fail("ACTIVE_CONTENT", "文档包含不支持的XML外部实体。")
            if "word/document.xml" not in package.namelist():
                fail("INVALID_FILE", "文件没有有效的Word正文。")
        from docx import Document
        document = Document(str(path))
        pieces = [paragraph.text for paragraph in document.paragraphs]
        for table in document.tables:
            pieces.extend(" | ".join(cell.text for cell in row.cells) for row in table.rows)
        notice = "读取Word正文段落和表格，不执行宏或读取外部链接。"
    text = "\n".join(pieces).strip()
    truncated = truncated or len(text) > LIMIT
    if not text:
        fail("EMPTY_DOCUMENT", "文件中没有可读取的正文。")
    output({"ok": True, "text": text[:LIMIT], "truncated": truncated, "pages": pages, "notice": notice})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        fail("FILE_PARSE_FAILED", "文件无法安全解析，可能已损坏或内容过于复杂。")
