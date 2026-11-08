"""The sending sandbox: what it builds, what it refuses, and its side of the socket."""

from __future__ import annotations

import json
import os
import smtplib
import socket
import ssl
import tempfile
import threading
from datetime import UTC, datetime
from email import message_from_bytes, policy

import pytest

from ai_ders import mailsend
from ai_ders.mailsend import MailSender, MailSendError, OutgoingMail, build_message, check_rate, handle, recipients

ENV = {"SMTP_HOST": "smtp.uni.example.edu", "SMTP_PORT": "465", "IMAP_HOST": "imap.uni.example.edu", "MAIL_USER": "ogrenci@uni.example.edu"}
NOW = datetime(2026, 11, 3, 12, 0, tzinfo=UTC)


class Smtp:
    """Records instead of sending."""

    sent: list = []
    error: Exception | None = None

    def __init__(self, host, port):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def login(self, user, password):
        self.user, self.password = user, password

    def send_message(self, message, from_addr, to_addrs):
        if Smtp.error:
            raise Smtp.error
        Smtp.sent.append((message, from_addr, to_addrs, self.port))


@pytest.fixture
def smtp(monkeypatch):
    Smtp.sent, Smtp.error = [], None
    copies = []
    monkeypatch.setattr(mailsend, "open_smtp", lambda host, port: Smtp(host, port))
    monkeypatch.setattr(mailsend, "keep_in_sent", lambda *args: copies.append(args) or True)
    return copies


@pytest.mark.parametrize(
    ("text", "found"),
    [
        ("hoca@uni.example.edu", ("hoca@uni.example.edu",)),
        ("Ayşe Hoca <a@uni.example.edu>, b@uni.example.edu; ", ("a@uni.example.edu", "b@uni.example.edu")),
    ],
)
def test_recipients_are_bare_addresses(text, found):
    assert recipients(text) == found


@pytest.mark.parametrize(
    "text",
    ["", "hoca", "hoca@uni.example.edu\r\nBcc: x@y.example", "hoca@uni.example.edu>x", "ş@uni.example.edu", "a@b", ",".join(["a@b.example"] * 11)],
)
def test_anything_odd_as_a_recipient_is_refused(text):
    with pytest.raises(MailSendError):
        recipients(text)


def test_the_message_is_plain_text_with_only_checked_headers():
    mail = OutgoingMail(
        ("hoca@uni.example.edu",), "Re: Vize\r\nBcc: x@y.example", "Merhaba\r\nhocam", "<b@uni.example.edu> extra",
        " ".join(f"<{n}@uni.example.edu>" for n in range(15)) + " <b@uni.example.edu>",
    )
    message = build_message(mail, "ogrenci@uni.example.edu", NOW)
    parsed = message_from_bytes(message.as_bytes(), policy=policy.default)
    assert parsed["Subject"] == "Re: Vize Bcc: x@y.example" and parsed["Bcc"] is None
    assert parsed["From"] == "ogrenci@uni.example.edu" and parsed["To"] == "hoca@uni.example.edu"
    assert parsed["Message-ID"].endswith("@uni.example.edu>")
    assert parsed["In-Reply-To"] is None  # not one bare id: left out rather than passed on
    assert parsed["References"].split() == [f"<{n}@uni.example.edu>" for n in range(6, 15)] + ["<b@uni.example.edu>"]
    assert parsed.get_content_type() == "text/plain" and parsed.get_content().replace("\r\n", "\n") == "Merhaba\nhocam\n"


def test_a_reply_names_the_mail_it_answers():
    mail = OutgoingMail(("hoca@uni.example.edu",), "Re: Vize", "x", "<b@uni.example.edu>", "<a@uni.example.edu> <b@uni.example.edu>")
    message = build_message(mail, "ogrenci@uni.example.edu", NOW)
    assert message["In-Reply-To"] == "<b@uni.example.edu>"
    assert message["References"] == "<a@uni.example.edu> <b@uni.example.edu>"


def test_the_rate_limit_holds_across_runs(tmp_path):
    for n in range(mailsend.PER_HOUR):
        check_rate(tmp_path, 1000.0 + n)
    with pytest.raises(MailSendError):
        check_rate(tmp_path, 1000.0 + mailsend.PER_HOUR)
    check_rate(tmp_path, 1000.0 + 3600 + 1)  # an hour later the first has aged out


def test_the_daily_limit(tmp_path):
    for n in range(mailsend.PER_DAY):
        check_rate(tmp_path, n * 400.0)
    with pytest.raises(MailSendError):
        check_rate(tmp_path, mailsend.PER_DAY * 400.0)


def test_a_broken_rate_file_starts_over_rather_than_blocking(tmp_path):
    (tmp_path / "sent.json").write_text("{bozuk")
    check_rate(tmp_path, 1000.0)
    assert json.loads((tmp_path / "sent.json").read_text()) == [1000.0]


def test_handle_sends_from_the_student_and_keeps_a_copy(smtp, tmp_path):
    reply = handle({"to": "Hoca <hoca@uni.example.edu>", "subject": "Konu", "body": "Metin"}, ENV, "sifre", tmp_path)
    assert reply["status"] == "sent" and reply["sentCopy"] is True and reply["messageId"].endswith("@uni.example.edu>")
    (message, sender, to, port), = Smtp.sent
    assert (sender, to, port) == ("ogrenci@uni.example.edu", ["hoca@uni.example.edu"], 465)
    assert len(smtp) == 1 and smtp[0][0] == "imap.uni.example.edu"


def test_a_server_that_keeps_its_own_copy_gets_no_second_one(smtp, tmp_path):
    reply = handle({"to": "a@b.example", "body": "x"}, {**ENV, "SMTP_HOST": "smtp.gmail.com"}, "sifre", tmp_path)
    assert reply["sentCopy"] is True and smtp == []


def test_handle_refuses_without_settings_or_body(smtp, tmp_path):
    assert "ayarlı değil" in handle({"to": "a@b.example", "body": "x"}, ENV, None, tmp_path)["error"]
    assert "ayarlı değil" in handle({"to": "a@b.example", "body": "x"}, {**ENV, "SMTP_HOST": ""}, "s", tmp_path)["error"]
    assert handle({"to": "a@b.example", "body": "  "}, ENV, "s", tmp_path) == {"error": "Mail boş."}
    assert handle({"to": "kotu", "body": "x"}, ENV, "s", tmp_path) == {"error": "Alıcı adresi geçersiz"}
    assert Smtp.sent == []


def test_a_user_name_without_a_domain_sends_from_the_school(smtp, tmp_path):
    env = {**ENV, "MAIL_USER": "ogrenci", "SCHOOL_DOMAIN": "uni.example.edu"}
    handle({"to": "a@b.example", "body": "x"}, env, "s", tmp_path)
    assert Smtp.sent[0][1] == "ogrenci@uni.example.edu"


@pytest.mark.parametrize(
    ("error", "words"),
    [
        (smtplib.SMTPAuthenticationError(535, b"no"), "şifreyi"),
        (ssl.SSLCertVerificationError("bad cert"), "güvenli bağlantı"),
        (smtplib.SMTPRecipientsRefused({}), "kabul etmedi"),
        (OSError("down"), "internet"),
    ],
)
def test_send_failures_are_explained(smtp, tmp_path, error, words):
    Smtp.error = error
    reply = handle({"to": "a@b.example", "body": "x"}, ENV, "s", tmp_path)
    assert words in reply["error"] and smtp == []


def test_a_failed_copy_is_only_reported(monkeypatch, smtp, tmp_path):
    def broken(*args):
        raise OSError("imap down")

    monkeypatch.setattr(mailsend, "keep_in_sent", broken)
    reply = handle({"to": "a@b.example", "body": "x"}, ENV, "s", tmp_path)
    assert reply["status"] == "sent" and reply["sentCopy"] is False


def test_port_465_is_tls_from_the_first_byte_and_others_must_starttls(monkeypatch):
    seen = []

    class Plain:
        def __init__(self, host, port, timeout):
            seen.append(("plain", port))

        def starttls(self, context):
            seen.append(("starttls", context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname))

    class Tls:
        def __init__(self, host, port, timeout, context):
            seen.append(("tls", port, context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname))

    monkeypatch.setattr(smtplib, "SMTP", Plain)
    monkeypatch.setattr(smtplib, "SMTP_SSL", Tls)
    mailsend.open_smtp("h", 465)
    mailsend.open_smtp("h", 587)
    assert seen == [("tls", 465, True), ("plain", 587), ("starttls", True)]


@pytest.fixture
def short_dir():
    # AF_UNIX paths are limited to about 100 bytes, which pytest's tmp_path can exceed on macOS.
    with tempfile.TemporaryDirectory(dir="/tmp") as directory:
        yield directory


def exchange(directory, answer):
    """One mail through MailSender to a stand-in service that answers `answer`."""
    path = os.path.join(directory, "s.sock")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(1)
    received: list = []

    def run():
        connection, _ = server.accept()
        with connection:
            chunks = []
            while chunk := connection.recv(4096):
                chunks.append(chunk)
            received.append(json.loads(b"".join(chunks)))
            connection.sendall(answer)
        server.close()

    thread = threading.Thread(target=run, daemon=True)
    thread.start()
    try:
        result = MailSender(path, timeout=5)(OutgoingMail(("a@b.example",), "K", "M", "<i@b.example>", "<r@b.example>"))
    finally:
        thread.join(5)
    return result, received


def test_the_client_hands_over_the_mail_and_reads_the_answer(short_dir):
    result, received = exchange(short_dir, b'{"status": "sent", "messageId": "<x@b.example>", "sentCopy": true}')
    assert received == [{"to": "a@b.example", "subject": "K", "body": "M", "inReplyTo": "<i@b.example>", "references": "<r@b.example>"}]
    assert (result.message_id, result.sent_copy) == ("<x@b.example>", True)


@pytest.mark.parametrize(
    ("answer", "words"),
    [(b'{"error": "Alici adresi gecersiz"}', "Alici adresi gecersiz"), (b"", "gitmiş olabilir"), (b"[1]", "gönderilemedi")],
)
def test_the_client_turns_any_other_answer_into_an_error(short_dir, answer, words):
    with pytest.raises(MailSendError, match=words):
        exchange(short_dir, answer)


def test_no_service_means_not_sent(short_dir):
    sender = MailSender(os.path.join(short_dir, "yok.sock"))
    assert sender.available() is False
    with pytest.raises(MailSendError, match="çalışmıyor"):
        sender(OutgoingMail(("a@b.example",), "K", "M"))
