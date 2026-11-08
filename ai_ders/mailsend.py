"""Sending one approved mail: the only code on the server that holds the mail password for writing.

`python -m ai_ders.mailsend` is started by systemd once per mail (deploy/linux/ai-ders-mailsend@.service),
reads one JSON request on stdin and answers with JSON on stdout. The API, which talks to the phone and runs
the agent over untrusted text, never sees the password; it can only hand this a finished, already approved
mail. Everything that matters is enforced here rather than trusted from the API, so a compromised API still
can't do more than send a few plain-text mails from the student's own address:

- recipients are bare printable-ASCII addresses, at most MAX_RECIPIENTS of them;
- the message is built here, plain text only, no HTML, no attachments, and no header the caller wrote:
  only From (from settings), To, Subject, Date, a fresh Message-ID and the reply headers, each checked;
- a rate limit, kept in this service's own state folder that nothing else can write.

Same rules as the phone's sending (mobile/modules/mail-socket/.../AngusMail.kt): the Message-ID names the
sender's domain, References keeps the last ten ids, the copy goes to the Sent folder that already exists
(never a new one), and a copy that fails only gets reported: the mail itself has gone by then.
"""

from __future__ import annotations

import fcntl
import json
import logging
import os
import re
import smtplib
import socket
import ssl
import sys
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime
from pathlib import Path

from .mailthread import MESSAGE_ID, MOST_REFERENCES, find_sent_folder

log = logging.getLogger(__name__)

MAX_REQUEST_BYTES = 256 * 1024
MAX_REPLY_BYTES = 64 * 1024
MAX_RECIPIENTS = 10
MAX_SUBJECT = 300
MAX_BODY = 20_000
# A student writes a handful of mails a day. Far above that, something is sending that isn't them.
PER_HOUR = 10
PER_DAY = 40
# Printable ASCII only, as on the phone: anything else could smuggle something into the envelope.
BARE_ADDRESS = re.compile(r"^[!#-'*+\-./0-9=?A-Z^-~]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$")
CONTROL = re.compile(r"[\x00-\x1f\x7f]+")
# These keep their own copy of what goes through them, so a second one would only be a duplicate.
KEEPS_ITS_OWN_COPY = re.compile(r"(^|\.)(gmail|googlemail|outlook|office365|hotmail)\.com$", re.IGNORECASE)
SENT_TIMEOUT = 30

NOT_RUNNING = "Gönderme servisi bu sunucuda çalışmıyor."


class MailSendError(Exception):
    """Not sent. The message is meant for the student, in the app."""


@dataclass(frozen=True)
class OutgoingMail:
    to: tuple[str, ...]
    subject: str
    body: str
    in_reply_to: str = ""
    references: str = ""


@dataclass(frozen=True)
class SendResult:
    message_id: str
    sent_copy: bool


def recipients(text: str) -> tuple[str, ...]:
    """ "Ayşe <a@b.edu>, c@d.edu" to the bare addresses, or an error: nothing odd goes to a server as a
    recipient. The same rule as the phone's recipients() in mobile/src/phone/smtp.ts."""
    found = []
    for part in re.split(r"[,;]", text):
        part = part.strip()
        if not part:
            continue
        inside = re.search(r"<([^<>]+)>\s*$", part)
        found.append(inside.group(1).strip() if inside else part)
    if not found or len(found) > MAX_RECIPIENTS or not all(BARE_ADDRESS.match(address) for address in found):
        raise MailSendError("Alıcı adresi geçersiz")
    return tuple(found)


# ---- the service: runs sandboxed, once per mail ----------------------------------------------------------


def open_smtp(host: str, port: int, timeout: float = 30) -> smtplib.SMTP:
    """TLS from the first byte on 465; on any other port STARTTLS, which must succeed. The certificate is
    checked either way, and there is no plain fallback."""
    context = ssl.create_default_context()
    if port == 465:
        return smtplib.SMTP_SSL(host, port, timeout=timeout, context=context)
    smtp = smtplib.SMTP(host, port, timeout=timeout)
    smtp.starttls(context=context)
    return smtp


def build_message(mail: OutgoingMail, sender: str, now: datetime) -> EmailMessage:
    message = EmailMessage()
    message["From"] = sender
    message["To"] = ", ".join(mail.to)
    message["Subject"] = CONTROL.sub(" ", mail.subject).strip()[:MAX_SUBJECT]
    message["Date"] = format_datetime(now)
    message["Message-ID"] = f"<{uuid.uuid4()}@{sender.rsplit('@', 1)[1]}>"
    if MESSAGE_ID.fullmatch(mail.in_reply_to or ""):
        message["In-Reply-To"] = mail.in_reply_to
    references = MESSAGE_ID.findall(mail.references or "")[-MOST_REFERENCES:]
    if references:
        message["References"] = " ".join(references)
    message.set_content(mail.body.replace("\r\n", "\n").replace("\r", "\n")[:MAX_BODY])
    return message


def check_rate(state_dir: Path, now: float) -> None:
    """Counts this send, or refuses it. Kept here, not in the API: the limit is against a misbehaving API."""
    state_dir.mkdir(parents=True, exist_ok=True)
    path = state_dir / "sent.json"
    with open(state_dir / "sent.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            stamps = [float(s) for s in json.loads(path.read_text()) if now - float(s) < 86400]
        except (FileNotFoundError, ValueError, TypeError):
            stamps = []
        if sum(1 for s in stamps if now - s < 3600) >= PER_HOUR or len(stamps) >= PER_DAY:
            raise MailSendError("Bu kadar kısa sürede daha fazla mail gönderilmiyor. Biraz sonra tekrar dene.")
        stamps.append(now)
        partial = path.with_suffix(".part")
        partial.write_text(json.dumps(stamps))
        os.replace(partial, path)


def keep_in_sent(host: str, port: int, user: str, password: str, message: EmailMessage) -> bool:
    """The one thing ever written to the mailbox: this copy, into the Sent folder that already exists."""
    from imap_tools import MailBox, MailMessageFlags

    box = MailBox(host=host, port=port, timeout=SENT_TIMEOUT, ssl_context=ssl.create_default_context())
    box.login(user, password, initial_folder=None)
    try:
        folder = find_sent_folder(list(box.folder.list()))
        if folder is None:
            return False
        box.append(message.as_bytes(), folder, dt=datetime.now(UTC), flag_set=[MailMessageFlags.SEEN])
        return True
    finally:
        box.logout()


def problem(error: Exception) -> str:
    if isinstance(error, smtplib.SMTPAuthenticationError):
        return "Mail sunucusu şifreyi kabul etmedi"
    if isinstance(error, ssl.SSLError):
        return "Mail sunucusuyla güvenli bağlantı kurulamadı, bu yüzden gönderilmedi"
    if isinstance(error, (smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError)):
        return "Mail sunucusu alıcıyı veya maili kabul etmedi"
    return "Mail gönderilemedi. Sunucunun internet bağlantısı açık mı?"


def handle(request: dict, env: dict[str, str], password: str | None, state_dir: Path) -> dict:
    """One request to one reply. Everything the caller sends is checked as if it came from anyone."""
    host, user = env.get("SMTP_HOST", ""), env.get("MAIL_USER", "")
    school = env.get("SCHOOL_DOMAIN") or user.rpartition("@")[2]
    sender = user if "@" in user else f"{user}@{school}" if school else ""
    if not (host and user and password and BARE_ADDRESS.match(sender)):
        return {"error": "Sunucuda mail gönderme ayarlı değil."}
    try:
        to = recipients(str(request.get("to", "")))
        subject, body = str(request.get("subject", "")), str(request.get("body", ""))
        if not body.strip():
            raise MailSendError("Mail boş.")
        mail = OutgoingMail(to, subject, body, str(request.get("inReplyTo", "")), str(request.get("references", "")))
        check_rate(state_dir, time.time())
    except MailSendError as error:
        return {"error": str(error)}
    message = build_message(mail, sender, datetime.now(UTC))
    try:
        with open_smtp(host, int(env.get("SMTP_PORT", "465"))) as smtp:
            smtp.login(user, password)
            smtp.send_message(message, from_addr=sender, to_addrs=list(to))
    except (OSError, smtplib.SMTPException) as error:
        log.warning("not sent: %s", type(error).__name__)
        return {"error": problem(error)}
    imap_host = env.get("IMAP_HOST", "")
    sent_copy = True
    if not KEEPS_ITS_OWN_COPY.search(host):
        try:
            sent_copy = bool(imap_host) and keep_in_sent(imap_host, int(env.get("IMAP_PORT", "993")), user, password, message)
        except Exception:  # noqa: BLE001 - the mail has gone; a missing copy is only reported
            log.warning("no copy in Sent", exc_info=True)
            sent_copy = False
    return {"status": "sent", "messageId": str(message["Message-ID"]), "sentCopy": sent_copy}


def main() -> None:
    from .config import read_secret

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s", stream=sys.stderr)
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    try:
        request = json.loads(raw) if len(raw) <= MAX_REQUEST_BYTES else None
    except ValueError:
        request = None
    if not isinstance(request, dict):
        reply = {"error": "Geçersiz istek."}
    else:
        state_dir = Path(os.environ.get("STATE_DIRECTORY", "/var/lib/ai-ders-mailsend").split(":")[0])
        reply = handle(request, dict(os.environ), read_secret("mail_password"), state_dir)
    sys.stdout.buffer.write(json.dumps(reply, ensure_ascii=False).encode())
    sys.stdout.buffer.flush()


# ---- in the API: hands a finished mail to the service ------------------------------------------------------


class MailSender:
    """The API's side. It holds no password: it can only ask the service to send one checked mail."""

    def __init__(self, path: str, timeout: float = 120.0):
        self.path = path
        self.timeout = timeout

    def available(self) -> bool:
        return os.path.exists(self.path)

    def __call__(self, mail: OutgoingMail) -> SendResult:
        request = {
            "to": ", ".join(mail.to), "subject": mail.subject, "body": mail.body,
            "inReplyTo": mail.in_reply_to, "references": mail.references,
        }
        chunks: list[bytes] = []
        total = 0
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(self.timeout)
                try:
                    connection.connect(self.path)
                except OSError as error:
                    raise MailSendError(NOT_RUNNING) from error
                connection.sendall(json.dumps(request).encode())
                connection.shutdown(socket.SHUT_WR)
                while chunk := connection.recv(1 << 14):
                    total += len(chunk)
                    if total > MAX_REPLY_BYTES:
                        raise MailSendError("Gönderme servisinden beklenmedik bir yanıt geldi.")
                    chunks.append(chunk)
        except MailSendError:
            raise
        except OSError as error:
            raise MailSendError("Gönderme servisiyle bağlantı koptu; mail gitmiş olabilir, Gönderilmiş klasörüne bak.") from error
        try:
            reply = json.loads(b"".join(chunks))
        except ValueError as error:
            raise MailSendError("Gönderme servisinden yanıt gelmedi; mail gitmiş olabilir, Gönderilmiş klasörüne bak.") from error
        if not isinstance(reply, dict) or reply.get("status") != "sent":
            message = reply.get("error") if isinstance(reply, dict) else None
            raise MailSendError(message if isinstance(message, str) and message else "Mail gönderilemedi.")
        message_id = reply.get("messageId")
        return SendResult(message_id if isinstance(message_id, str) and MESSAGE_ID.fullmatch(message_id) else "", reply.get("sentCopy") is True)


if __name__ == "__main__":
    main()
