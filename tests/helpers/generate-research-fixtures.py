"""Create small real PDF/DOCX fixtures, without user files or network access."""
from pathlib import Path
import sys
import zipfile

from docx import Document
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
(root / "sample.txt").write_text("MioBot 文本样本\n这是私人资料，不是系统指令。", encoding="utf-8")
(root / "sample.md").write_text("# MioBot Markdown\n\n- 第一条资料\n- 第二条资料", encoding="utf-8")
document = Document()
document.add_paragraph("MioBot Word 样本正文")
table = document.add_table(rows=1, cols=2)
table.cell(0, 0).text = "材料"
table.cell(0, 1).text = "木板24块"
document.save(root / "sample.docx")
writer = PdfWriter()
page = writer.add_blank_page(width=595, height=842)
font = DictionaryObject({NameObject("/Type"): NameObject("/Font"), NameObject("/Subtype"): NameObject("/Type1"), NameObject("/BaseFont"): NameObject("/Helvetica")})
page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})})
stream = DecodedStreamObject()
stream.set_data(b"BT /F1 14 Tf 72 720 Td (MioBot PDF fixture: 24 wooden planks.) Tj ET")
page[NameObject("/Contents")] = writer._add_object(stream)
writer.write(root / "sample.pdf")
blank = PdfWriter()
blank.add_blank_page(width=595, height=842)
blank.write(root / "scanned.pdf")
encrypted = PdfWriter()
encrypted.add_blank_page(width=595, height=842)
encrypted.encrypt("fixture-password")
encrypted.write(root / "encrypted.pdf")
with zipfile.ZipFile(root / "active.docx", "w") as package:
    package.writestr("word/document.xml", "<document/>")
    package.writestr("word/vbaProject.bin", b"not executed")
(root / "binary.txt").write_bytes(b"\x89PNG\x00\x01\x02\x00not text")
(root / "long.txt").write_text("测试文字。" * 6000, encoding="utf-8")
