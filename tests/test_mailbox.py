from __future__ import annotations

from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime

from ai_ders.mailbox import MAX_BODY_BYTES, MAX_PER_POLL, MAX_SENT_PER_POLL, UNREADABLE, Cursor, Mailbox
from ai_ders.mailparse import MailParseError, SandboxUnavailable, parse_here
from ai_ders.models import HIGH, NORMAL

import pytest


def raw_mail(subject: str = "Merhaba", text: str = "gövde", html: str = "") -> bytes:
    message = EmailMessage()
    message["From"] = "Hoca <hoca@uni.example.edu>"
    message["To"] = "ogrenci@uni.example.edu"
    message["Subject"] = subject
    message["Date"] = format_datetime(datetime(2026, 11, 3, 10, 0, tzinfo=UTC))
    message.set_content(text)
    if html:
        message.add_alternative(html, subtype="html")
    return message.as_bytes()


class FakeClient:
    """imaplib's UID FETCH, answering the way Zimbra does."""

    def __init__(self, box: FakeBox):
        self.box = box

    def uid(self, command, uid, what):
        assert command == "FETCH"
        self.box.fetched.append((int(uid), what))
        raw, size = self.box.messages[int(uid)]
        if what == "(RFC822.SIZE)":
            return "OK", [f"1 (UID {uid} RFC822.SIZE {size})".encode()]
        assert "PEEK" in what, "reading must never mark a mail as seen"
        part = raw.split(b"\n\n")[0] + b"\n\n" if "HEADER" in what else raw
        return "OK", [(f"1 (UID {uid} BODY[] {{{len(part)}}}".encode(), part), b")"]


class FakeBox:
    def __init__(self, messages: dict[int, bytes | tuple[bytes, int]], uidvalidity=5, uidnext=200):
        self.messages = {uid: m if isinstance(m, tuple) else (m, len(m)) for uid, m in messages.items()}
        self.readonly: bool | None = None
        self.queries: list[str] = []
        self.fetched: list[tuple[int, str]] = []
        self.logged_out = False
        self.client = FakeClient(self)
        status = {"UIDVALIDITY": uidvalidity, "UIDNEXT": uidnext}
        self.folders: list = []
        self.selected: str | None = None
        self.folder = type("Folder", (), {
            "set": self._select, "status": lambda _self, folder, names: status, "list": lambda _self: self.folders,
        })()

    def __call__(self, **kwargs):
        return self

    def _select(self, folder, readonly=False):
        self.readonly = readonly
        self.selected = folder

    def login(self, user, password, initial_folder="INBOX"):
        self.initial_folder = initial_folder

    def uids(self, criteria):
        self.queries.append(str(criteria))
        return [str(uid) for uid in self.messages]

    def logout(self):
        self.logged_out = True


def mailbox_for(box: FakeBox, parser=parse_here, image_dir=None) -> Mailbox:
    return Mailbox("mail.uni.example.edu", 993, "u", "p", parser=parser, image_dir=image_dir, factory=box)


def test_folder_is_opened_read_only_and_mail_stays_unread():
    box = FakeBox({101: raw_mail()})
    items, _ = mailbox_for(box).fetch_new(Cursor(5, 100))
    assert box.readonly is True
    assert box.initial_folder is None  # never selected read-write, even briefly
    assert [i.sender for i in items] == ["Hoca <hoca@uni.example.edu>"]
    assert box.logged_out


def test_every_mail_goes_through_the_parser_as_raw_bytes():
    seen: list[bytes] = []

    def parser(raw):
        seen.append(raw)
        return parse_here(raw)

    mailbox_for(FakeBox({101: raw_mail("Vize")}), parser=parser).fetch_new(Cursor(5, 100))
    assert len(seen) == 1 and b"Subject: Vize" in seen[0]


def test_first_run_starts_from_now():
    box = FakeBox({150: raw_mail()}, uidnext=151)
    items, cursor = mailbox_for(box).fetch_new(None)
    assert items == [] and cursor == Cursor(5, 150)
    assert box.fetched == []


def test_first_run_reads_recent_mail_and_leaves_it_unread():
    box = FakeBox({150: raw_mail(), 140: raw_mail()}, uidnext=151)
    items, cursor = mailbox_for(box).fetch_recent(datetime(2026, 10, 20, 12, 0, tzinfo=UTC))
    assert [i.key for i in items] == ["mail:5:140", "mail:5:150"]
    assert cursor == Cursor(5, 150)
    assert "SINCE 20-Oct-2026" in box.queries[0]
    assert box.readonly is True and box.logged_out


def test_recent_mail_is_capped_to_the_newest():
    box = FakeBox({uid: raw_mail() for uid in range(1, MAX_PER_POLL + 6)}, uidnext=MAX_PER_POLL + 6)
    items, _ = mailbox_for(box).fetch_recent(datetime(2026, 10, 20, tzinfo=UTC))
    assert len(items) == MAX_PER_POLL and items[0].key == "mail:5:6"


def test_mail_arriving_during_the_first_run_is_not_read_twice():
    box = FakeBox({151: raw_mail()}, uidnext=151)  # 151 came in after STATUS
    _, cursor = mailbox_for(box).fetch_recent(datetime(2026, 10, 20, tzinfo=UTC))
    assert cursor == Cursor(5, 151)


def test_imap_star_quirk_does_not_repeat_the_newest_mail():
    # "101:*" matches UID 100 when 100 is the newest message.
    box = FakeBox({100: raw_mail()}, uidnext=101)
    items, cursor = mailbox_for(box).fetch_new(Cursor(5, 100))
    assert items == [] and cursor == Cursor(5, 100)


def test_renumbered_folder_restarts_instead_of_misreading_uids():
    box = FakeBox({7: raw_mail()}, uidvalidity=9, uidnext=8)
    items, cursor = mailbox_for(box).fetch_new(Cursor(5, 100))
    assert items == [] and cursor == Cursor(9, 7)


def test_cursor_advances_to_the_last_mail_read():
    box = FakeBox({103: raw_mail(), 101: raw_mail()})
    items, cursor = mailbox_for(box).fetch_new(Cursor(5, 100))
    assert [i.key for i in items] == ["mail:5:101", "mail:5:103"]
    assert cursor == Cursor(5, 103)


def test_huge_mail_is_kept_from_its_header_alone():
    box = FakeBox({101: (raw_mail("Dev ek", text="x" * 50), MAX_BODY_BYTES + 1)})
    items, _ = mailbox_for(box).fetch_new(Cursor(5, 100))
    assert items[0].title == "Dev ek" and items[0].body == ""
    assert (101, "(BODY.PEEK[HEADER])") in box.fetched and (101, "(BODY.PEEK[])") not in box.fetched


def test_a_mail_the_parser_cannot_read_is_kept_as_unreadable():
    def broken(raw):
        raise MailParseError("killed")

    items, cursor = mailbox_for(FakeBox({101: raw_mail()}), parser=broken).fetch_new(Cursor(5, 100))
    assert [(i.title, i.level) for i in items] == [(UNREADABLE, NORMAL)]
    assert cursor == Cursor(5, 101)


def test_a_missing_sandbox_fails_the_poll_instead_of_losing_mail():
    def gone(raw):
        raise SandboxUnavailable("no socket")

    with pytest.raises(OSError):
        mailbox_for(FakeBox({101: raw_mail()}), parser=gone).fetch_new(Cursor(5, 100))


def test_html_only_mail_becomes_text_and_sets_the_level():
    items, _ = mailbox_for(FakeBox({101: raw_mail(text="", html="<p>Vize <b>Salı</b></p>")})).fetch_new(Cursor(5, 100))
    assert items[0].body == "Vize Salı"
    assert items[0].level == HIGH


def test_blank_subject_gets_a_title():
    items, _ = mailbox_for(FakeBox({101: raw_mail(subject="")})).fetch_new(Cursor(5, 100))
    assert items[0].title == "(konusuz)"


def test_html_part_wins_over_a_generated_plain_part():
    raw = raw_mail(text="Sa ğlıklı günler", html="<p>Sağlıklı günler</p>")
    items, _ = mailbox_for(FakeBox({101: raw})).fetch_new(Cursor(5, 100))
    assert items[0].body == "Sağlıklı günler"


def test_plain_only_mail_loses_windows_line_ends_and_blank_runs():
    raw = raw_mail(text="Merhaba,\r\n\r\n\r\n\r\nVize Salı.  \r\n")
    items, _ = mailbox_for(FakeBox({101: raw})).fetch_new(Cursor(5, 100))
    assert items[0].body == "Merhaba,\n\nVize Salı."


def folder(name, *flags, delim="/"):
    return type("FolderInfo", (), {"name": name, "flags": flags, "delim": delim})()


def sent_mail(subject="Re: Vize", message_id="<s1@uni.example.edu>") -> bytes:
    message = EmailMessage()
    message["From"] = "ogrenci@uni.example.edu"
    message["To"] = "Hoca <hoca@uni.example.edu>"
    message["Subject"] = subject
    message["Message-ID"] = message_id
    message["In-Reply-To"] = "<b@uni.example.edu>"
    message["References"] = "<a@uni.example.edu> <b@uni.example.edu>"
    message["Date"] = format_datetime(datetime(2026, 11, 3, 10, 0, tzinfo=UTC))
    message.set_content("Teşekkürler")
    return message.as_bytes()


def test_the_sent_folder_is_found_by_its_flag_then_by_name():
    box = FakeBox({7: sent_mail()}, uidnext=8)
    box.folders = [folder("INBOX"), folder("Gönderilmiş"), folder("Giden", "\\Sent")]
    items, cursor = mailbox_for(box).fetch_sent(None, datetime(2026, 10, 20, tzinfo=UTC))
    assert box.selected == "Giden" and box.readonly is True and box.initial_folder is None
    item, = items
    assert (item.key, item.sender, item.reply_to, item.level) == ("mail:out:5:7", "Sen", "hoca@uni.example.edu", NORMAL)
    assert (item.thread, item.message_id) == ("<a@uni.example.edu>", "<s1@uni.example.edu>")
    assert cursor == Cursor(5, 7) and box.logged_out


def test_a_sent_folder_named_like_the_phone_expects():
    box = FakeBox({}, uidnext=1)
    box.folders = [folder("INBOX"), folder("INBOX/Sent Items")]
    assert mailbox_for(box).fetch_sent(None, datetime(2026, 10, 20, tzinfo=UTC)) == ([], Cursor(5, 0))
    assert box.selected == "INBOX/Sent Items"


def test_no_sent_folder_is_not_an_error_and_none_is_made():
    box = FakeBox({})
    box.folders = [folder("INBOX"), folder("Arşiv")]
    assert mailbox_for(box).fetch_sent(None, datetime(2026, 10, 20, tzinfo=UTC)) is None
    assert box.selected is None and box.logged_out


def test_sent_mail_is_read_a_few_at_a_time():
    box = FakeBox({uid: sent_mail() for uid in range(1, 51)}, uidnext=51)
    box.folders = [folder("Sent", "\\Sent")]
    first, cursor = mailbox_for(box).fetch_sent(None, datetime(2026, 10, 20, tzinfo=UTC))
    assert len(first) == MAX_SENT_PER_POLL and cursor == Cursor(5, 50)  # history: only the newest few
    later, cursor = mailbox_for(box).fetch_sent(Cursor(5, 10), datetime(2026, 10, 20, tzinfo=UTC))
    assert len(later) == MAX_SENT_PER_POLL and cursor == Cursor(5, 10 + MAX_SENT_PER_POLL)  # the rest next round
