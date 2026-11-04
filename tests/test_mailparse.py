from __future__ import annotations

import base64
import io
import json
import os
import socket
import threading
from email.message import EmailMessage

import pytest
from PIL import Image

from ai_ders.mailbox import Mailbox
from ai_ders.mailparse import (
    IMAGE_SIDE,
    MailParseError,
    SandboxedParser,
    SandboxUnavailable,
    clean_image,
    from_reply,
    parse,
    parse_here,
)


def picture(fmt: str = "PNG", size=(40, 30), **save) -> bytes:
    out = io.BytesIO()
    Image.new("RGBA" if fmt == "PNG" else "RGB", size, (200, 30, 30, 255) if fmt == "PNG" else (200, 30, 30)).save(out, fmt, **save)
    return out.getvalue()


def mail_with(*parts: tuple[bytes, str, str], html: str = "<p>Afiş ekte</p>") -> bytes:
    message = EmailMessage()
    message["From"] = "Uni Notices <notices@uni.example.edu>"
    message["Subject"] = "Üniversite Talks"
    message.set_content("Afiş ekte")
    message.add_alternative(html, subtype="html")
    for data, maintype_sub, name in parts:
        maintype, subtype = maintype_sub.split("/")
        message.add_attachment(data, maintype=maintype, subtype=subtype, filename=name)
    return message.as_bytes()


def test_images_come_back_as_new_jpegs_without_the_senders_bytes():
    original = picture("PNG")
    parsed = parse_here(mail_with((original, "image/png", "afis.png")))
    [attachment] = parsed.attachments
    assert attachment.name == "afis.png" and attachment.image is not None
    clean = parsed.images[attachment.image]
    assert clean.startswith(b"\xff\xd8\xff") and clean != original
    assert (attachment.width, attachment.height) == (40, 30)


def test_metadata_does_not_survive_the_re_encoding():
    exif = Image.Exif()
    exif[0x010E] = "gizli konum notu"  # ImageDescription
    original = picture("JPEG", exif=exif.tobytes())
    assert b"gizli konum" in original
    clean, _, _ = clean_image(original)
    assert b"gizli konum" not in clean


def test_large_images_are_scaled_down():
    _, width, height = clean_image(picture("JPEG", size=(4000, 1000)))
    assert width == IMAGE_SIDE and height == 400


def test_a_decompression_bomb_is_refused(monkeypatch):
    monkeypatch.setattr("ai_ders.mailparse.MAX_PIXELS", 1000)
    assert clean_image(picture("PNG", size=(100, 100))) is None


def test_broken_or_unexpected_images_are_listed_but_not_kept():
    parsed = parse_here(mail_with(
        (b"\x89PNG\r\n\x1a\nnot really", "image/png", "bozuk.png"),
        (picture("BMP"), "image/png", "aslinda-bmp.png"),  # a format outside the allowed decoders
        (b"%PDF-1.7", "application/pdf", "form.pdf"),
    ))
    assert [(a.name, a.image) for a in parsed.attachments] == [
        ("bozuk.png", None), ("aslinda-bmp.png", None), ("form.pdf", None),
    ]
    assert parsed.images == {}


def test_only_the_headers_the_rules_use_leave_the_sandbox():
    message = EmailMessage()
    message["From"] = "a@b.c"
    message["List-Id"] = "duyuru"
    message["X-Secret-Tracking"] = "abc"
    message.set_content("x")
    assert parse_here(message.as_bytes()).headers == {"list-id": "duyuru"}


def test_a_tampered_reply_is_held_to_the_normal_shape():
    good = parse(mail_with((picture(), "image/png", "a.png")))
    fake = dict(good, attachments=[dict(good["attachments"][0], jpeg=base64.b64encode(b"<svg>").decode())])
    assert from_reply(fake).images == {}
    huge = dict(good, attachments=[dict(good["attachments"][0], width=99999)])
    assert from_reply(huge).images == {}
    with pytest.raises(MailParseError):
        from_reply(["not", "an", "object"])
    with pytest.raises(MailParseError):
        from_reply({"error": "MemoryError"})


def serve_once(path: str, reply: bytes | None):
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)
    received: list[bytes] = []

    def run():
        connection, _ = server.accept()
        with connection:
            data = b""
            while chunk := connection.recv(65536):
                data += chunk
            received.append(data)
            if reply is not None:
                connection.sendall(reply)
        server.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    return thread, received


@pytest.fixture
def short_socket_path():
    # AF_UNIX paths are limited to about 100 bytes, which pytest's tmp_path can exceed on macOS.
    path = f"/tmp/ai-ders-test-{os.getpid()}.sock"
    yield path
    if os.path.exists(path):
        os.unlink(path)


def test_the_sandbox_gets_the_raw_mail_and_its_answer_is_used(short_socket_path):
    raw = mail_with()
    thread, received = serve_once(short_socket_path, json.dumps(parse(raw)).encode())
    parsed = SandboxedParser(short_socket_path, timeout=5)(raw)
    thread.join(5)
    assert received == [raw] and parsed.subject == "Üniversite Talks"


def test_a_sandbox_killed_mid_mail_marks_only_that_mail(short_socket_path):
    thread, _ = serve_once(short_socket_path, None)
    with pytest.raises(MailParseError):
        SandboxedParser(short_socket_path, timeout=5)(mail_with())
    thread.join(5)


def test_no_sandbox_is_an_outage_not_a_bad_mail(short_socket_path):
    with pytest.raises(SandboxUnavailable):
        SandboxedParser(short_socket_path, timeout=5)(b"x")


def test_clean_images_are_written_by_hash(tmp_path):
    parsed = parse_here(mail_with((picture(), "image/png", "a.png")))
    Mailbox("h", 993, "u", "p", parser=parse_here, image_dir=tmp_path / "img")._keep_images(parsed)
    [image] = parsed.images
    assert (tmp_path / "img" / f"{image}.jpg").read_bytes() == parsed.images[image]


@pytest.mark.parametrize("source", [
    lambda: picture("PNG"), lambda: picture("JPEG", size=(3000, 2000)), lambda: picture("GIF"), lambda: picture("WEBP"),
])
def test_everything_the_sandbox_makes_passes_the_shape_check(source):
    from ai_ders.mailparse import is_clean_jpeg

    clean, width, height = clean_image(source())
    assert is_clean_jpeg(clean, width, height)


def test_anything_else_fails_the_shape_check():
    from ai_ders.mailparse import is_clean_jpeg

    clean, width, height = clean_image(picture("PNG"))
    exif = clean[:2] + b"\xff\xe1\x00\x08Exif\x00\x00" + clean[2:]
    assert not is_clean_jpeg(clean + b"<script>", width, height)  # a second file after the end
    assert not is_clean_jpeg(clean + b"PK\x03\x04", width, height)
    assert not is_clean_jpeg(exif, width, height)  # metadata segment
    assert not is_clean_jpeg(clean, width + 1, height)  # not the size it claims
    assert not is_clean_jpeg(picture("JPEG", progressive=True), 40, 30)  # a frame type we never write
    assert not is_clean_jpeg(b"\xff\xd8\xff\xd9", 1, 1)
