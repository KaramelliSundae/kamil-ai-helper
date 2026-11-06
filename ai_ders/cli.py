"""Command line: `ai-ders poll`, `digest`, `upcoming`, `check`, `google-auth`, and `mode` with a GPU gate."""

from __future__ import annotations

import argparse
import logging
import sys
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx

from . import gtasks
from .canvas import CanvasClient
from .config import Settings
from .mailbox import Mailbox
from .docparse import SandboxedDocumentReader, read_here
from .mailparse import SandboxedParser, parse_here
from .notify import ConsoleNotifier, Notifier, SmtpNotifier, flush, format_time, send_digest
from .store import Store, to_time
from .watcher import run_poll

log = logging.getLogger(__name__)

GPU_MODES = ("assistant", "compute")


def build_canvas(settings: Settings) -> CanvasClient | None:
    if not (settings.canvas_url and settings.canvas_token):
        return None
    return CanvasClient(settings.canvas_url, settings.canvas_token)


def build_mailbox(settings: Settings) -> Mailbox | None:
    if not (settings.imap_host and settings.mail_user and settings.mail_password):
        return None
    if settings.mail_parser == "inprocess":
        log.warning("mail is parsed without the sandbox (MAIL_PARSER_SOCKET=inprocess)")
        parser = parse_here
    else:
        parser = SandboxedParser(settings.mail_parser)
    return Mailbox(
        settings.imap_host, settings.imap_port, settings.mail_user, settings.mail_password,
        parser=parser, image_dir=settings.image_dir,
    )


def build_document_reader(settings: Settings) -> Callable[[bytes], str]:
    return read_here if settings.mail_parser == "inprocess" else SandboxedDocumentReader(settings.doc_parser)


def build_notifier(settings: Settings, dry_run: bool) -> Notifier | None:
    """None when mail notifications are not set up: the watcher still runs and the app shows the events."""
    if dry_run:
        return ConsoleNotifier()
    if not (settings.smtp_host and settings.mail_user and settings.mail_password and settings.notify_email):
        log.warning("mail notifications are off: SMTP_HOST, MAIL_USER, mail_password and NOTIFY_EMAIL are all needed")
        return None
    return SmtpNotifier(settings)


def poll(settings: Settings, args: argparse.Namespace) -> int:
    now = datetime.now(UTC)
    store = Store(settings.db_path)
    canvas = build_canvas(settings)
    try:
        result = run_poll(store, settings, canvas, build_mailbox(settings), now, build_document_reader(settings))
        notifier = build_notifier(settings, args.dry_run)
        sent = flush(store, notifier, settings, now) if notifier else 0
    finally:
        if canvas:
            canvas.close()
        store.close()
    print(f"items={result.items} events={result.events} sent={sent} errors={len(result.errors)}")
    return 0


def digest(settings: Settings, args: argparse.Namespace) -> int:
    notifier = build_notifier(settings, args.dry_run)
    if notifier is None:
        return 0
    store = Store(settings.db_path)
    try:
        return 0 if send_digest(store, notifier, settings, datetime.now(UTC)) else 1
    finally:
        store.close()


def upcoming(settings: Settings, args: argparse.Namespace) -> int:
    now = datetime.now(UTC)
    store = Store(settings.db_path)
    try:
        for row in store.upcoming(now, now + timedelta(days=args.days)):
            print(f"{format_time(settings, to_time(row['due_at']))}  {row['course']}: {row['title']}")
    finally:
        store.close()
    return 0


def check(settings: Settings, args: argparse.Namespace) -> int:
    """Tries each connection once. Prints no message content and sends nothing."""
    failed = False
    canvas = build_canvas(settings)
    if canvas is None:
        print("canvas: CANVAS_URL veya token yok")
        failed = True
    else:
        try:
            print(f"canvas: bağlandı, {len(canvas.courses())} aktif ders")
        except Exception as error:  # noqa: BLE001 - this command reports every failure
            print(f"canvas: HATA {error}")
            failed = True
        finally:
            canvas.close()

    mailbox = build_mailbox(settings)
    if mailbox is None:
        print("mail: kapalı (IMAP_HOST, MAIL_USER ve şifre gerekir)")
    else:
        try:
            print(f"mail: bağlandı, {mailbox.check()}")
        except Exception as error:  # noqa: BLE001 - this command reports every failure
            print(f"mail: HATA {error}")
            failed = True
    return 1 if failed else 0


def mode(settings: Settings, args: argparse.Namespace) -> int:
    """`compute` leaves the GPU to work until `assistant` brings the model back. Needs GPU_GATE_URL."""
    url = settings.gpu_gate_url.rstrip("/")
    if not url:
        print("GPU_GATE_URL ayarlı değil")
        return 1
    try:
        if args.mode:
            httpx.post(f"{url}/mode", json={"mode": args.mode}, timeout=25.0).raise_for_status()
        print(httpx.get(f"{url}/state", timeout=10.0).json())
    except httpx.HTTPError as error:
        print(f"GPU kapısı: {error}")
        return 1
    return 0


def google_auth(settings: Settings, args: argparse.Namespace) -> int:
    """One-time Google Tasks consent. Prints the credentials JSON for connect-google-tasks.sh to encrypt."""
    try:
        print(gtasks.authorize(client_file=args.client_file))
    except gtasks.GoogleTasksError as error:
        print(f"hata: {error}", file=sys.stderr)
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(prog="ai-ders")
    commands = parser.add_subparsers(dest="command", required=True)
    for name, handler, description in (
        ("poll", poll, "one watcher round, then send what is due"),
        ("digest", digest, "send the daily digest"),
    ):
        command = commands.add_parser(name, help=description)
        command.add_argument("--dry-run", action="store_true", help="print instead of sending")
        command.set_defaults(handler=handler)
    command = commands.add_parser("upcoming", help="list work still to do")
    command.add_argument("--days", type=int, default=14)
    command.set_defaults(handler=upcoming)
    commands.add_parser("check", help="test the Canvas and mail connections").set_defaults(handler=check)
    command = commands.add_parser("mode", help="show or set who the GPU is reserved for (needs GPU_GATE_URL)")
    command.add_argument("mode", nargs="?", choices=GPU_MODES)
    command.set_defaults(handler=mode)
    google = commands.add_parser("google-auth", help="connect Google Tasks once")
    google.add_argument("--client-file", help="the client JSON downloaded from Google Cloud")
    google.set_defaults(handler=google_auth)

    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)  # it logs every request URL at INFO
    sys.exit(args.handler(Settings.from_env(), args))
