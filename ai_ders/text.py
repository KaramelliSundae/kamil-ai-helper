"""Text helpers: HTML to plain text and Turkish-aware normalisation."""

from __future__ import annotations

import re
from html.parser import HTMLParser

SKIPPED_TAGS = {"script", "style", "head", "title", "template", "noscript"}
# Paragraph tags leave a blank line around them; line tags only end the line. Mail programs such as
# Zimbra write one <div> per line, so treating <div> as a paragraph split every sentence apart.
PARAGRAPH_TAGS = {"p", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "blockquote", "hr"}
LINE_TAGS = {"div", "tr", "li", "dt", "dd", "section", "article", "header", "footer"}
LINK_SCHEMES = ("http://", "https://")


class _TextExtractor(HTMLParser):
    """Collects the visible text. Breaks are held back until the next text, so empty markup adds none."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.pending = 0
        self.skipping = 0
        self.pre = 0
        self.bullet = False
        self.space_after = False
        self.spans: list[tuple[bool, int]] = []
        self.links: list[tuple[str, int]] = []

    def _break(self, lines: int) -> None:
        self.pending = max(self.pending, lines)

    def _write(self, text: str) -> None:
        if self.pending and self.parts:
            self.parts.append("\n" * self.pending)
            text = text.lstrip(" ")
        if self.space_after and text[:1] and not text[:1].isspace() and text[:1] not in ".,;:!?)]}'\"":
            text = " " + text
        self.space_after = False
        if self.bullet:  # held until the item's first words, so "<li><p>…" does not leave a lone bullet
            text = "• " + text.lstrip(" ")
            self.bullet = False
        self.pending = 0
        self.parts.append(text)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in SKIPPED_TAGS:
            self.skipping += 1
        elif self.skipping:
            return
        elif tag == "br":
            self.pending = min(self.pending + 1, 2)
        elif tag in PARAGRAPH_TAGS:
            self._break(2)
            if tag == "hr":
                self._write("———")
                self._break(2)
        elif tag in LINE_TAGS:
            self._break(1)
            if tag == "li":
                self.bullet = True
        elif tag in ("td", "th"):
            self.parts.append(" ")
        elif tag == "pre":
            self.pre += 1
            self._break(2)
        elif tag == "a":
            href = (dict(attrs).get("href") or "").strip()
            self.links.append((href, len(self.parts)))
        elif tag == "span":
            # Zimbra wraps what it recognises in "object" spans. After an address or link it drops the space in
            # the HTML ("kutuphane@uni.edu.tr</span>aracılığıyla"), while its date objects can sit inside a word
            # ("<span>Sal</span>ı"). Only address and link objects get their space back.
            # Decided by what the object holds, not by Zimbra's id names, which differ between versions.
            values = dict(attrs)
            is_object = "Object" in (values.get("class") or "").split() or (values.get("id") or "").startswith("OBJ_PREFIX_")
            self.spans.append((is_object, len(self.parts)))

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag == "a":
            self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in SKIPPED_TAGS:
            self.skipping = max(0, self.skipping - 1)
        elif self.skipping:
            return
        elif tag in PARAGRAPH_TAGS:
            self._break(2)
        elif tag in LINE_TAGS:
            self._break(1)
        elif tag == "pre":
            self.pre = max(0, self.pre - 1)
            self._break(2)
        elif tag == "span" and self.spans:
            is_object, start = self.spans.pop()
            if is_object and re.search(r"@|://|^www\.", "".join(self.parts[start:]).strip()):
                self.space_after = True
        elif tag == "a" and self.links:
            href, start = self.links.pop()
            shown = "".join(self.parts[start:]).strip()
            # The real target stays visible next to the words, so a link cannot hide where it goes.
            if href.lower().startswith(LINK_SCHEMES) and shown and href.rstrip("/") not in shown:
                self.parts.append(f" ({href})")

    def handle_data(self, data: str) -> None:
        if self.skipping:
            return
        data = data.replace("\xa0", " ")
        if not self.pre:
            data = re.sub(r"\s+", " ", data)
        if not data.strip():
            if not self.pending and self.parts and not self.parts[-1].endswith((" ", "\n")):
                self.parts.append(" ")
            self.space_after = False
            return
        self._write(data)


def html_to_text(html: str | None) -> str:
    if not html:
        return ""
    parser = _TextExtractor()
    parser.feed(html)
    parser.close()
    text = "".join(parser.parts).replace("\r", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def fingerprint(text: str) -> str:
    """What counts as an edit: the words. Layout, bullets and link targets written out by html_to_text
    are left out, so a better text conversion does not report every announcement as changed."""
    text = re.sub(r"\s*\(https?://[^\s)]*\)", "", text or "")
    return re.sub(r"[\s•—]+", "", text)


def clean_text(text: str | None) -> str:
    """Plain mail text: Windows line ends, trailing spaces and long runs of blank lines removed."""
    if not text:
        return ""
    text = re.sub(r"[ \t]+\n", "\n", text.replace("\r\n", "\n").replace("\r", "\n"))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def normalize_tr(text: str) -> str:
    """Lowercases with Turkish rules, so 'İLAN' and 'ilan' compare equal."""
    if not text:
        return ""
    return text.translate(str.maketrans({"İ": "i", "I": "ı"})).lower()


def shorten(text: str, limit: int) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
