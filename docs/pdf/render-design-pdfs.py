#!/usr/bin/env python3
"""Render the Marketplace Engine design markdown into styled PDFs."""
import re
import sys
import subprocess
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageBreak, PageTemplate,
                                Paragraph, Preformatted, Spacer, Table, TableStyle,
                                KeepTogether, NextPageTemplate)

def font(spec):
    return subprocess.check_output(["fc-match", "-f", "%{file}", spec], text=True).strip()

pdfmetrics.registerFont(TTFont("DJ", font("DejaVu Sans")))
pdfmetrics.registerFont(TTFont("DJ-B", font("DejaVu Sans:bold")))
pdfmetrics.registerFont(TTFont("DJ-I", font("DejaVu Sans:italic")))
pdfmetrics.registerFont(TTFont("DJM", font("DejaVu Sans Mono")))
pdfmetrics.registerFont(TTFont("DJM-B", font("DejaVu Sans Mono:bold")))
pdfmetrics.registerFontFamily("DJ", normal="DJ", bold="DJ-B", italic="DJ-I", boldItalic="DJ-B")

INK = colors.HexColor("#14213d")
ACCENT = colors.HexColor("#c2410c")
MUTED = colors.HexColor("#5b6472")
RULE = colors.HexColor("#d6dae2")
PANEL = colors.HexColor("#f4f6f9")

ss = getSampleStyleSheet()
S = {
    "body": ParagraphStyle("body", parent=ss["Normal"], fontName="DJ", fontSize=9.5,
                           leading=14.5, textColor=colors.HexColor("#1f2733"),
                           spaceAfter=7, alignment=TA_LEFT),
    "h1": ParagraphStyle("h1", fontName="DJ-B", fontSize=17, leading=21, textColor=INK,
                         spaceBefore=6, spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="DJ-B", fontSize=12.5, leading=16, textColor=INK,
                         spaceBefore=16, spaceAfter=6),
    "h3": ParagraphStyle("h3", fontName="DJ-B", fontSize=10.5, leading=14, textColor=ACCENT,
                         spaceBefore=11, spaceAfter=4),
    "h4": ParagraphStyle("h4", fontName="DJ-B", fontSize=9.5, leading=13, textColor=MUTED,
                         spaceBefore=9, spaceAfter=3),
    "li": ParagraphStyle("li", fontName="DJ", fontSize=9.5, leading=14, spaceAfter=0,
                         textColor=colors.HexColor("#1f2733")),
    "libullet": ParagraphStyle("libullet", fontName="DJ", fontSize=9.5, leading=14,
                               textColor=ACCENT),
    "cell": ParagraphStyle("cell", fontName="DJ", fontSize=8.2, leading=11.5,
                           textColor=colors.HexColor("#1f2733")),
    "cellh": ParagraphStyle("cellh", fontName="DJ-B", fontSize=8.2, leading=11.5,
                            textColor=colors.white),
    "code": ParagraphStyle("code", fontName="DJM", fontSize=7.4, leading=10.2,
                           textColor=colors.HexColor("#12304a")),
    "toc": ParagraphStyle("toc", fontName="DJ", fontSize=9.5, leading=17,
                          textColor=colors.HexColor("#1f2733")),
    "coverTitle": ParagraphStyle("ct", fontName="DJ-B", fontSize=30, leading=35,
                                 textColor=colors.white),
    "coverSub": ParagraphStyle("cs", fontName="DJ", fontSize=13, leading=19,
                               textColor=colors.HexColor("#c9d4e6")),
    "coverMeta": ParagraphStyle("cm", fontName="DJ", fontSize=9.5, leading=16,
                                textColor=colors.HexColor("#9fb0c8")),
}

INLINE = [
    (re.compile(r"`([^`]+)`"), r'<font face="DJM" size="8.6" color="#9a3412">\1</font>'),
    (re.compile(r"\*\*([^*]+)\*\*"), r"<b>\1</b>"),
]

def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def inline(t):
    t = esc(t)
    for pat, rep in INLINE:
        t = pat.sub(rep, t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)",
               r'<link href="\2" color="#1d4ed8">\1</link>', t)
    return t

def code_block(lines, width):
    txt = "\n".join(lines) or " "
    longest = max((len(l) for l in lines), default=1)
    avail = width - 18
    size = S["code"].fontSize
    per = pdfmetrics.stringWidth("M", "DJM", size)
    if longest * per > avail:
        size = max(5.2, size * avail / (longest * per))
    cs = ParagraphStyle("codeAuto", parent=S["code"], fontSize=size, leading=size * 1.38)
    tbl = Table([[Preformatted(txt, cs)]], colWidths=[width])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), PANEL),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    return [Spacer(1, 3), tbl, Spacer(1, 9)]

def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]

def table_block(rows, width):
    header = [Paragraph(inline(c), S["cellh"]) for c in rows[0]]
    body = [[Paragraph(inline(c), S["cell"]) for c in r] for r in rows[1:]]
    ncol = len(rows[0])
    colw = [width / ncol] * ncol
    if ncol == 3:
        colw = [width * 0.26, width * 0.30, width * 0.44]
    elif ncol == 2:
        colw = [width * 0.36, width * 0.64]
    elif ncol == 4:
        colw = [width * 0.19, width * 0.24, width * 0.15, width * 0.42]
    tbl = Table([header] + body, colWidths=colw, repeatRows=1)
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), INK),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    for i in range(1, len(body) + 1):
        if i % 2 == 0:
            style.append(("BACKGROUND", (0, i), (-1, i), colors.HexColor("#fafbfd")))
    tbl.setStyle(TableStyle(style))
    return [Spacer(1, 3), tbl, Spacer(1, 10)]

BLOCK_START = re.compile(r"^(#{1,4}\s|[-*]\s|\d+\.\s|>\s|\||```|-{3,}$)")

def unwrap(md):
    """Join soft-wrapped source lines so a paragraph or list item is one logical line."""
    out, buf, fenced = [], None, False
    for ln in md.split("\n"):
        st = ln.strip()
        if st.startswith("```"):
            if buf is not None:
                out.append(buf); buf = None
            fenced = not fenced
            out.append(ln)
            continue
        if fenced:
            out.append(ln)
            continue
        if not st:
            if buf is not None:
                out.append(buf); buf = None
            out.append("")
            continue
        if BLOCK_START.match(st) or st.startswith("|"):
            if buf is not None:
                out.append(buf); buf = None
            if st.startswith("|") or st.startswith("#") or st.startswith("```") or re.match(r"^-{3,}$", st):
                out.append(st)
            else:
                buf = st
            continue
        if buf is None:
            buf = st
        else:
            buf += " " + st
    if buf is not None:
        out.append(buf)
    return "\n".join(out)


def bullet_row(bullet, text, width):
    """List item as a 2-column table so wrapped lines stay aligned under the text."""
    t = Table([[Paragraph(bullet, S["libullet"]), Paragraph(inline(text), S["li"])]],
              colWidths=[9 * mm, width - 9 * mm])
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 6), ("LEFTPADDING", (1, 0), (1, 0), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def parse(md, width, sections):
    out = []
    lines = unwrap(md).split("\n")
    i = 0
    pending = []

    def flush():
        nonlocal pending
        if pending:
            out.append(Paragraph(inline(" ".join(pending)), S["body"]))
            pending = []

    while i < len(lines):
        ln = lines[i]
        st = ln.strip()
        if st.startswith("```"):
            flush()
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.extend(code_block(buf, width))
            continue
        if st.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            flush()
            rows = [split_row(st)]
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            out.extend(table_block(rows, width))
            continue
        m = re.match(r"^(#{1,4})\s+(.*)$", st)
        if m:
            flush()
            lvl = len(m.group(1))
            txt = m.group(2)
            if lvl == 1:
                out.append(Paragraph(inline(txt), S["h1"]))
                out.append(Spacer(1, 2))
            elif lvl == 2:
                sections.append(re.sub(r"^\d+\.\s*", "", txt))
                out.append(KeepTogether([
                    Paragraph(inline(txt), S["h2"]),
                    Table([[""]], colWidths=[width], rowHeights=[1.6],
                          style=TableStyle([("BACKGROUND", (0, 0), (-1, -1), ACCENT)])),
                    Spacer(1, 6),
                ]))
            else:
                out.append(Paragraph(inline(txt), S["h3" if lvl == 3 else "h4"]))
            i += 1
            continue
        if not st:
            flush()
            i += 1
            continue
        if re.match(r"^[-*]\s+", st):
            flush()
            out.append(bullet_row("\u2022", re.sub(r"^[-*]\s+", "", st), width))
            i += 1
            continue
        m = re.match(r"^(\d+)\.\s+(.*)$", st)
        if m:
            flush()
            out.append(bullet_row(m.group(1) + ".", m.group(2), width))
            i += 1
            continue
        if st.startswith("> "):
            flush()
            out.append(bullet_row("\u2502", st[2:], width))
            i += 1
            continue
        if re.match(r"^-{3,}$", st):
            i += 1
            continue
        pending.append(st)
        i += 1
    flush()
    return out


class Doc(BaseDocTemplate):
    def __init__(self, path, title, subtitle, brand="Marketplace Engine (AutoPost)",
                 footer_note="Internal — confidential", **kw):
        BaseDocTemplate.__init__(self, path, pagesize=A4, title=title,
                                 author="Marketplace Engine", **kw)
        self.docTitle = title
        self.subtitle = subtitle
        self.brand = brand
        self.footer_note = footer_note
        w, h = A4
        m = 20 * mm
        frame = Frame(m, 20 * mm, w - 2 * m, h - 20 * mm - 26 * mm, id="body")
        cover = Frame(m, m, w - 2 * m, h - 2 * m, id="cover")
        self.addPageTemplates([
            PageTemplate(id="cover", frames=[cover], onPage=self.draw_cover),
            PageTemplate(id="body", frames=[frame], onPage=self.draw_chrome),
        ])

    def draw_cover(self, canv, doc):
        w, h = A4
        canv.saveState()
        canv.setFillColor(INK)
        canv.rect(0, 0, w, h, stroke=0, fill=1)
        canv.setFillColor(ACCENT)
        canv.rect(0, h - 250, 62 * mm, 6, stroke=0, fill=1)
        canv.restoreState()

    def draw_chrome(self, canv, doc):
        w, h = A4
        canv.saveState()
        canv.setFont("DJ", 7.5)
        canv.setFillColor(MUTED)
        canv.drawString(20 * mm, h - 14 * mm, self.docTitle)
        canv.drawRightString(w - 20 * mm, h - 14 * mm, self.brand)
        canv.setStrokeColor(RULE)
        canv.setLineWidth(0.5)
        canv.line(20 * mm, h - 16 * mm, w - 20 * mm, h - 16 * mm)
        canv.line(20 * mm, 15 * mm, w - 20 * mm, 15 * mm)
        canv.drawString(20 * mm, 11 * mm, self.footer_note)
        canv.drawRightString(w - 20 * mm, 11 * mm, "Page %d" % (doc.page - 1))
        canv.restoreState()


def build(src, out, title, subtitle, version, date,
          brand="Marketplace Engine (AutoPost)", cover_brand="Marketplace&nbsp;Engine",
          cover_meta=None, footer_note="Internal — confidential", contents=True):
    md = open(src, encoding="utf-8").read()
    md = re.sub(r"^#\s+.*\n", "", md, count=1)
    doc = Doc(out, title, subtitle, brand=brand, footer_note=footer_note)
    width = doc.width
    sections = []
    body = parse(md, width, sections)

    story = []
    story.append(Spacer(1, 78 * mm))
    story.append(Paragraph(cover_brand, S["coverSub"]))
    story.append(Spacer(1, 6))
    story.append(Paragraph(title, S["coverTitle"]))
    story.append(Spacer(1, 10))
    story.append(Paragraph(subtitle, S["coverSub"]))
    story.append(Spacer(1, 26))
    story.append(Paragraph(
        cover_meta if cover_meta is not None else
        "Version %s &nbsp;·&nbsp; %s<br/>Repository: bradroberts88/marketplace-engine-core<br/>"
        "Product codename: AutoPost" % (version, date), S["coverMeta"]))
    story.append(NextPageTemplate("body"))
    story.append(PageBreak())

    if contents:
        story.append(Paragraph("Contents", S["h1"]))
        story.append(Spacer(1, 4))
        rows = [[Paragraph("%d." % (n + 1), S["toc"]), Paragraph(inline(s), S["toc"])]
                for n, s in enumerate(sections)]
        toc = Table(rows, colWidths=[12 * mm, width - 12 * mm])
        toc.setStyle(TableStyle([
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LEFTPADDING", (0, 0), (-1, -1), 0),
            ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
            ("LINEBELOW", (0, 0), (-1, -2), 0.25, RULE),
            ("TEXTCOLOR", (0, 0), (0, -1), ACCENT),
        ]))
        story.append(toc)
        story.append(PageBreak())
    story.extend(body)

    doc.build(story)
    print("wrote", out)


if __name__ == "__main__":
    date = sys.argv[1]
    build("docs/TECHNICAL-DESIGN.md", "docs/pdf/Marketplace-Engine-Technical-Design.pdf",
          "Technical design document", "System architecture, trust boundaries and failure behaviour",
          "1.0", date)
    build("docs/SOFTWARE-DESIGN.md", "docs/pdf/Marketplace-Engine-Software-Design.pdf",
          "Software design document", "Module structure, interfaces and testing strategy",
          "1.0", date)
    build("docs/PI-CONNECT-DEFECT-REGISTER.md", "docs/pdf/Pi-Connect-Defect-Register.pdf",
          "Pi connection defect register",
          "Every connection defect found, ranked, with its current status",
          "1.0", date)
    build("docs/PI-OWNERS-GUIDE.md", "docs/pdf/Pi-Owners-Guide.pdf",
          "Getting started with your Pi",
          "A plain-English owner's guide — no technical knowledge needed",
          "1.0", date,
          brand="QConnect", cover_brand="QConnect",
          cover_meta="Version 1.0 &nbsp;·&nbsp; %s<br/>Keep this leaflet with your Pi<br/>"
          "QCAI Support &nbsp;·&nbsp; 1-855-782-6824 &nbsp;·&nbsp; support@quantumconnectai.com"
          % date,
          footer_note="Owner's guide — QCAI Support 1-855-782-6824")
    build("docs/PI-OWNERS-HANDOUT.md", "docs/pdf/Pi-Owners-Handout.pdf",
          "Your Pi — the one-page version",
          "Plug in, get online, who to call",
          "1.0", date,
          brand="QConnect", cover_brand="QConnect",
          cover_meta="Version 1.0 &nbsp;·&nbsp; %s<br/>"
          "QCAI Support &nbsp;·&nbsp; 1-855-782-6824 &nbsp;·&nbsp; support@quantumconnectai.com"
          % date,
          footer_note="QCAI Support 1-855-782-6824",
          contents=False)
    build("docs/PI-BATCH-TRACKER.md", "docs/pdf/Pi-Batch-Tracker.pdf",
          "Pi batch tracker",
          "Wireless, cable and AT&T cellular — one row per card",
          "1.0", date,
          brand="QConnect", cover_brand="QConnect",
          cover_meta="Version 1.0 &nbsp;·&nbsp; %s<br/>Print and keep on the bench" % date,
          footer_note="Bench tracker",
          contents=False)
