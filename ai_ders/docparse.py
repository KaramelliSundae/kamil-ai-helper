"""Reads one untrusted document in the sandbox: raw bytes on stdin, plain text as JSON on stdout, then exits. It has no network,
no secrets and no writable disk, the same as the mail parser, because a syllabus PDF is as hostile as any attachment."""

from __future__ import annotations

import io
import json
import re
import socket
import sys
import zipfile

MAX_INPUT_BYTES = 16 * 1024 * 1024
MAX_PAGES = 40
MAX_TEXT_CHARS = 200_000
MAX_DOCX_XML_BYTES = 8 * 1024 * 1024
MAX_REPLY_BYTES = 2 * MAX_TEXT_CHARS * 4


def read_pdf(data: bytes) -> str:
    from pypdf import PdfReader

    parts: list[str] = []
    for page in PdfReader(io.BytesIO(data)).pages[:MAX_PAGES]:
        parts.append(page.extract_text() or "")
        if sum(map(len, parts)) > MAX_TEXT_CHARS:
            break
    return "\n".join(parts)


def read_docx(data: bytes) -> str:
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        info = archive.getinfo("word/document.xml")
        if info.file_size > MAX_DOCX_XML_BYTES:
            return ""
        xml = archive.read(info).decode("utf-8", "replace")
    # Plain text is all that is wanted, so no XML parser, and none of what they can be made to do.
    xml = re.sub(r"</w:(?:p|tr)>", "\n", xml)
    xml = re.sub(r"</w:tc>", "  ", xml)
    text = re.sub(r"<[^>]+>", "", xml)
    return text.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'")


def parse(data: bytes) -> str:
    if data[:4] == b"%PDF":
        return read_pdf(data)[:MAX_TEXT_CHARS]
    if data[:4] == b"PK\x03\x04":
        return read_docx(data)[:MAX_TEXT_CHARS]
    return ""


def main() -> None:
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    try:
        text = "" if len(data) > MAX_INPUT_BYTES else parse(data)
    except Exception:  # noqa: BLE001 - a broken document is an empty one
        text = ""
    sys.stdout.write(json.dumps({"text": text}))


class SandboxedDocumentReader:
    """Hands one document to the socket-activated sandbox. If that fails, the document simply reads as empty."""

    def __init__(self, path: str, timeout: float = 60.0):
        self.path = path
        self.timeout = timeout

    def __call__(self, data: bytes) -> str:
        chunks: list[bytes] = []
        total = 0
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(self.timeout)
                connection.connect(self.path)
                connection.sendall(data)
                connection.shutdown(socket.SHUT_WR)
                while chunk := connection.recv(1 << 16):
                    total += len(chunk)
                    if total > MAX_REPLY_BYTES:
                        return ""
                    chunks.append(chunk)
            text = json.loads(b"".join(chunks)).get("text", "")
        except (OSError, ValueError, AttributeError):
            return ""
        return text if isinstance(text, str) else ""


def read_here(data: bytes) -> str:
    """Reads in this process, unsandboxed. For tests and development only."""
    try:
        return parse(data)
    except Exception:  # noqa: BLE001
        return ""


if __name__ == "__main__":
    main()
