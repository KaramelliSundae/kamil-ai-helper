"""Finding midterm and final dates.

Nothing about this is standard. A date may be in an announcement, in Canvas as an assignment, on the syllabus page, in a PDF
under Files, or behind a OneDrive link; often the syllabus only says "week 8". So everything found is kept with how far it can
be trusted, and something firmer replaces something weaker: an announced date beats a date in a syllabus, which beats a week.

All of this text comes from other people and is treated as hostile. It is only ever searched for dates here; no model reads it
and no instruction in it can do anything. What is kept is a date, fixed labels and a short quote shown as plain text.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from urllib.parse import urljoin, urlsplit

import httpx

from . import attendance
from .canvas import CanvasClient, parse_time
from .models import Item
from .text import html_to_text

ANNOUNCED = "announced"  # said by the teacher, in an announcement or in Canvas itself
SYLLABUS = "syllabus"  # a date written in the syllabus, which may still change
ESTIMATED = "estimated"  # the syllabus only names a week
TRUST = {ESTIMATED: 1, SYLLABUS: 2, ANNOUNCED: 3}

# How often a course with no syllabus yet is looked at again, chosen in Settings; a course with a syllabus never is. On a server
# this costs nothing, since documents are read right there. 0 turns syllabus reading off.
DEFAULT_CHECK_DAYS = 1
CHECK_DAY_CHOICES = (0, 1, 7)
MAX_FILES_PER_COURSE = 4
MIN_SYLLABUS_CHARS = 200  # less than this is a placeholder, not a syllabus
MAX_DOCUMENT_BYTES = 15 * 1024 * 1024
MAX_EVIDENCE_CHARS = 160
MAX_LINKS_PER_COURSE = 4
EARLIEST_DAYS, LATEST_DAYS = 240, 400  # a date further than this from today is a misreading, not this term's exam

MIDTERM = r"mid[\s-]?terms?(?:\s+exams?)?|ara\s*s[ıi]nav(?:[ıi])?|vize(?:\s*s[ıi]nav[ıi])?|vizesi"
FINAL = r"finals?(?:\s+exams?)?|final\s*s[ıi]nav[ıi]|finali|y[ıa]r[ıi]y[ıi]l\s*sonu(?:\s*s[ıi]nav[ıi])?|d[öo]nem\s*sonu(?:\s*s[ıi]nav[ıi])?"
KEYWORD = re.compile(rf"(?<![\w])(?P<midterm>{MIDTERM})(?![\w])|(?<![\w])(?P<final>{FINAL})(?![\w])", re.IGNORECASE)
# A line about results, weights or other work mentions an exam without saying when it is.
NOT_A_DATE = re.compile(
    r"sonu[çc]|result|grade|graded|notu|notlar|weight|%|y[üu]zde|percent|proje|project|report|rapor|paper|essay|"
    r"presentation|sunum|[öo]dev|homework|assignment|submission|submit|teslim|deliverable|draft|b[üu]t[üu]nleme|makeup|make-up|mazeret|review session|tekrar dersi",
    re.IGNORECASE,
)
PROJECT_LIKE = NOT_A_DATE

MONTHS = {
    "ocak": 1, "şubat": 2, "subat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "mayis": 5, "haziran": 6, "temmuz": 7, "ağustos": 8,
    "agustos": 8, "eylül": 9, "eylul": 9, "ekim": 10, "kasım": 11, "kasim": 11, "aralık": 12, "aralik": 12,
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3, "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6,
    "july": 7, "jul": 7, "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9, "october": 10, "oct": 10, "november": 11,
    "nov": 11, "december": 12, "dec": 12,
}
MONTH = "|".join(sorted(MONTHS, key=len, reverse=True))
DAY_MONTH = re.compile(rf"(?<![\d.])(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({MONTH})\b\.?(?:,?\s*(\d{{4}}))?", re.IGNORECASE)
MONTH_DAY = re.compile(rf"\b({MONTH})\b\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?(?![\d:])(?:,?\s*(\d{{4}}))?", re.IGNORECASE)
NUMERIC_YEAR = re.compile(r"(?<![\d.])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)")
NUMERIC_SHORT = re.compile(r"(?<![\d.:])(\d{1,2})[./](\d{1,2})(?![\d:.%])")
CLOCK_BEFORE = re.compile(r"(saat|at|time)\s*$", re.IGNORECASE)
WEEK_AFTER = re.compile(r"\b(?:week|wk|hafta)s?\s*[:#.]?\s*(\d{1,2})(?:\s*(?:-|–|—|and|ve|&|,)\s*(\d{1,2}))?", re.IGNORECASE)
WEEK_BEFORE = re.compile(r"(?<![\d.])(\d{1,2})(?:\s*(?:-|–|—)\s*(\d{1,2}))?(?:st|nd|rd|th|\.)?\s*(?:week|hafta)", re.IGNORECASE)
# A row of a course calendar: "8   Midterm Exam", the number right before the exam. In the first weeks of a term a number like that
# is a list item or a count, not a week, so only weeks an exam could really be in count.
TABLE_ROW = re.compile(r"\s*(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?\s*[.):|\-–]?\s*", re.IGNORECASE)
PLAUSIBLE_ROW_WEEKS = {"midterm": range(4, 13), "final": range(10, 19)}
NUMBER_AFTER = re.compile(r"\s*[-#]?\s*([1-3]|ii|i)\b(?!\.?\s*(?:hafta|week))", re.IGNORECASE)
NUMBER_BEFORE = re.compile(r"(?:([1-3])\s*(?:st|nd|rd|\.)|(birinci|first|ikinci|second))\s*$", re.IGNORECASE)
LONG_LIST_ITEM = 40  # "2. Vize: 20 Kasım" numbers the exam; "2. Ara sınav, dönemin 10. haftasında yapılır." numbers the list
MAX_WEEK = 18

SYLLABUS_WORDS = re.compile(r"syllabus|izlence|outline|course\s*(?:info|plan|description)|ders\s*(?:bilgi|plan|tan[ıi]t)", re.IGNORECASE)
FILE_SEARCHES = ("syllabus", "izlence", "outline", "course", "ders")
READABLE_FILE = re.compile(r"\.(pdf|docx)$", re.IGNORECASE)
LINK = re.compile(r"""https://[^\s"'<>)\]]+""")
LOGIN_HOSTS = ("login.microsoftonline.com", "login.live.com")


@dataclass(frozen=True)
class Found:
    kind: str  # midterm | final
    number: int  # 0 when there is only one
    starts_on: date
    ends_on: date | None  # a whole week, when only the week is known
    status: str
    week: int | None
    source: str  # announcement | canvas | syllabus | file | onedrive
    evidence: str
    url: str = ""


def term_start_guess(today: date) -> date:
    """When Canvas does not say: Turkish universities start around mid-September and mid-February."""
    if 8 <= today.month <= 12:
        start = date(today.year, 9, 22)
    elif today.month == 1:
        start = date(today.year - 1, 9, 22)
    else:
        start = date(today.year, 2, 16)
    return start - timedelta(days=start.weekday())


def _with_year(month: int, day: int, year: int | None, today: date) -> date | None:
    try:
        if year is not None:
            when = date(year + 2000 if year < 100 else year, month, day)
        else:
            when = date(today.year, month, day)
            if when < today - timedelta(days=EARLIEST_DAYS):
                when = date(today.year + 1, month, day)
            elif when > today + timedelta(days=LATEST_DAYS - 100):
                when = date(today.year - 1, month, day)
    except ValueError:
        return None
    return when if today - timedelta(days=EARLIEST_DAYS) <= when <= today + timedelta(days=LATEST_DAYS) else None


def find_date(text: str, today: date) -> date | None:
    """The first date in the text. Dates with a month's name come first, since "10.30" may well be a time."""
    for match in DAY_MONTH.finditer(text):
        when = _with_year(MONTHS[match[2].lower()], int(match[1]), int(match[3]) if match[3] else None, today)
        if when:
            return when
    for match in MONTH_DAY.finditer(text):
        when = _with_year(MONTHS[match[1].lower()], int(match[2]), int(match[3]) if match[3] else None, today)
        if when:
            return when
    for match in NUMERIC_YEAR.finditer(text):
        when = _with_year(int(match[2]), int(match[1]), int(match[3]), today)
        if when:
            return when
    for match in NUMERIC_SHORT.finditer(text):
        if CLOCK_BEFORE.search(text[: match.start()]):
            continue
        when = _with_year(int(match[2]), int(match[1]), None, today)
        if when:
            return when
    return None


def find_week(text: str) -> tuple[int, int] | None:
    for pattern in (WEEK_AFTER, WEEK_BEFORE):
        match = pattern.search(text)
        if match:
            first, last = int(match[1]), int(match[2] or match[1])
            if 1 <= first <= last <= MAX_WEEK:
                return first, last
    return None


def _number(text: str, start: int, end: int) -> int:
    after = NUMBER_AFTER.match(text[end:])
    if after:
        return {"i": 1, "ii": 2}.get(after[1].lower()) or int(after[1])
    before = NUMBER_BEFORE.search(text[:start])
    if before:
        if before[1]:
            if not text[: before.start()].strip() and len(text) >= LONG_LIST_ITEM:
                return 0
            return int(before[1])
        return 1 if before[2].lower() in ("birinci", "first") else 2
    return 0


def _chunks(text: str) -> list[str]:
    chunks: list[str] = []
    for line in text.splitlines():
        chunks.extend(part.strip() for part in re.split(r"(?<=[!?;])\s+|(?<=[a-zçğıöşü)]\.)\s+", line) if part.strip())
    return chunks


def find_exams(text: str, today: date, term_start: date | None, dated_status: str, source: str, url: str = "") -> list[Found]:
    """Every exam the text gives a time for. `dated_status` is how far a date in this kind of text can be trusted."""
    found: list[Found] = []
    chunks = _chunks(text)
    for index, chunk in enumerate(chunks):
        matches = list(KEYWORD.finditer(chunk))
        for position, match in enumerate(matches):
            # Two exams on one line: "Midterm: 14 Kasım, Final: 12 Ocak" or "14 Kasım Midterm, 12 Ocak Final". What comes before
            # the first of them says which way round the line is, and each exam gets only its own words.
            if len(matches) == 1:
                part = chunk
            elif find_date(chunk[: matches[0].start()], today) or find_week(chunk[: matches[0].start()]):
                part = chunk[matches[position - 1].end() if position else 0 : match.start()]
            else:
                part = chunk[match.end() : matches[position + 1].start() if position + 1 < len(matches) else len(chunk)]
            if NOT_A_DATE.search(part):
                continue
            kind = "midterm" if match["midterm"] else "final"
            number = _number(chunk, match.start(), match.end())
            evidence = chunk[:MAX_EVIDENCE_CHARS]
            when = find_date(part, today)
            # A bare exam name may be a table's first cell, with the date starting the next line. Any later date proves nothing.
            if when is None and len(chunks) > index + 1 and len(chunk) <= 24 and not KEYWORD.search(chunks[index + 1]):
                when = find_date(chunks[index + 1][:20], today)
            if when:
                found.append(Found(kind, number, when, None, dated_status, None, source, evidence, url))
                continue
            weeks = find_week(part)
            if weeks is None and position == 0 and not match[0].lower().endswith("s"):
                row = TABLE_ROW.fullmatch(chunk[: match.start()])
                if row and row[1] and int(row[1]) in PLAUSIBLE_ROW_WEEKS[kind] and int(row[1]) <= int(row[2] or row[1]) <= MAX_WEEK:
                    weeks = int(row[1]), int(row[2] or row[1])
            if weeks:
                start = term_start or term_start_guess(today)
                start -= timedelta(days=start.weekday())
                first = start + timedelta(weeks=weeks[0] - 1)
                last = start + timedelta(weeks=weeks[1] - 1, days=4)
                found.append(Found(kind, number, first, last, ESTIMATED, weeks[0], source, evidence, url))
    return found


def best(found: Iterable[Found], today: date) -> list[Found]:
    """One answer per exam: the most trusted, and among equals the next one to come."""
    chosen: dict[tuple[str, int], Found] = {}
    for item in found:
        key = (item.kind, item.number)
        old = chosen.get(key)
        rank = (TRUST[item.status], -abs((item.starts_on - today).days))
        if old is None or rank > (TRUST[old.status], -abs((old.starts_on - today).days)):
            chosen[key] = item
    # "Midterm" and "Midterm 1" are the same exam when only one of them has a date.
    for kind in ("midterm", "final"):
        if (kind, 0) in chosen and any(key[0] == kind and key[1] for key in chosen):
            plain = chosen.pop((kind, 0))
            if not any(item.starts_on == plain.starts_on for key, item in chosen.items() if key[0] == kind):
                free = min(n for n in range(1, 9) if (kind, n) not in chosen)
                chosen[(kind, free)] = plain
    return sorted(chosen.values(), key=lambda item: item.starts_on)


def is_exam_title(title: str) -> bool:
    """A Canvas assignment, quiz or event named after a midterm or final: it counts as that exam."""
    return bool(KEYWORD.search(title)) and not PROJECT_LIKE.search(title)


def exams_in_items(items: Iterable[Item], today: date, term_starts: dict[str, date]) -> dict[str, list[Found]]:
    """What Canvas itself says: announcements, and assignments or events named after an exam."""
    by_course: dict[str, list[Found]] = {}
    for item in items:
        if not item.course:
            continue
        if item.kind == "announcement":
            text = f"{item.title}\n{item.body}"
            found = find_exams(text, today, term_starts.get(item.course), ANNOUNCED, "announcement", item.url)
            # An announcement that gives only a week is the teacher's word on the week, and still not a date.
        elif item.kind in ("assignment", "quiz", "event") and item.due_at and is_exam_title(item.title):
            match = KEYWORD.search(item.title)
            found = [Found(
                "midterm" if match["midterm"] else "final", _number(item.title, match.start(), match.end()),
                item.due_at.date(), None, ANNOUNCED, None, "canvas", item.title[:MAX_EVIDENCE_CHARS], item.url,
            )]
        else:
            continue
        if found:
            by_course.setdefault(item.course, []).extend(found)
    return by_course


def is_onedrive(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return host in ("1drv.ms", "onedrive.live.com") or host.endswith(".sharepoint.com")


def fetch_onedrive(url: str, transport: httpx.BaseTransport | None = None) -> bytes | None:
    """The one kind of link ever fetched from text someone else wrote, because syllabi live there. Only Microsoft's own
    addresses, followed by hand so a redirect cannot lead elsewhere; no cookies and nothing of ours is sent; size limited. A link
    that asks for a login gives nothing, and the student gets a note instead."""
    with httpx.Client(timeout=30.0, transport=transport, follow_redirects=False) as client:
        current = url + ("&" if urlsplit(url).query else "?") + "download=1"
        for _ in range(6):
            if not is_onedrive(current) or urlsplit(current).scheme != "https":
                return None
            try:
                with client.stream("GET", current) as response:
                    if 300 <= response.status_code < 400:
                        current = urljoin(current, response.headers.get("location", ""))
                        continue
                    if response.status_code != 200:
                        return None
                    data = bytearray()
                    for chunk in response.iter_bytes():
                        data += chunk
                        if len(data) > MAX_DOCUMENT_BYTES:
                            return None
                    return bytes(data) if bytes(data[:4]) in (b"%PDF", b"PK\x03\x04") else None
            except httpx.HTTPError:
                return None
    return None


@dataclass
class CourseScan:
    found: list[Found]
    has_syllabus: bool
    term_start: date | None
    hint: str = ""
    attendance: list[dict[str, str]] = field(default_factory=list)


def scan_course(
    canvas: CanvasClient,
    course_id: int,
    today: date,
    read_document: Callable[[bytes], str],
    get_link: Callable[[str], bytes | None] = fetch_onedrive,
) -> CourseScan:
    """Looks through one course's syllabus page, its front page, its files and modules, and OneDrive links in them."""
    info = canvas.course_info(course_id)
    term = info.get("term") or {}
    started = parse_time(term.get("start_at")) or parse_time(info.get("start_at"))
    term_start = started.date() if started else None
    found: list[Found] = []
    has_syllabus = False
    hint = ""
    rules: dict[str, str] = {}  # what a course asks of attendance, and where it says so

    def note_attendance(source: str, text: str) -> None:
        for note in attendance.find_attendance(text):
            rules.setdefault(note, source)

    pages = [info.get("syllabus_body") or "", canvas.front_page(course_id)]
    modules = canvas.module_items(course_id)
    links: list[str] = []
    for page in pages:
        text = html_to_text(page) if page else ""
        if page is pages[0] and len(text) >= MIN_SYLLABUS_CHARS:
            has_syllabus = True
        found += find_exams(text, today, term_start, SYLLABUS, "syllabus")
        note_attendance("syllabus" if page is pages[0] else "ders sayfası", text)
        links += [link for link in LINK.findall(page) if is_onedrive(link)]
    for item in modules:
        if item.get("type") == "ExternalUrl" and is_onedrive(item.get("external_url") or ""):
            links.append(item["external_url"])

    files = {file["id"]: file for word in FILE_SEARCHES for file in canvas.course_files(course_id, word)}
    wanted = [
        file for file in files.values()
        if READABLE_FILE.search(file.get("display_name") or "") and SYLLABUS_WORDS.search(file.get("display_name") or "")
        and (file.get("size") or 0) <= MAX_DOCUMENT_BYTES and file.get("url")
    ]
    for file in wanted[:MAX_FILES_PER_COURSE]:
        data = canvas.download(file["url"])
        text = read_document(data) if data else ""
        if len(text) >= MIN_SYLLABUS_CHARS:
            has_syllabus = True
        found += find_exams(text, today, term_start, SYLLABUS, "file")
        note_attendance("syllabus dosyası", text)

    for link in list(dict.fromkeys(links))[:MAX_LINKS_PER_COURSE]:
        data = get_link(link)
        text = read_document(data) if data else ""
        if len(text) >= MIN_SYLLABUS_CHARS:
            has_syllabus = True
            found += find_exams(text, today, term_start, SYLLABUS, "onedrive", link)
            note_attendance("OneDrive", text)
        elif not has_syllabus:
            hint = "OneDrive linki açılamadı, giriş istiyor olabilir"
    notes = [{"source": source, "text": note} for note, source in rules.items()][:attendance.MAX_NOTES]
    return CourseScan(best(found, today), has_syllabus, term_start, hint if not has_syllabus else "", notes)


__all__ = [
    "ANNOUNCED", "CHECK_DAY_CHOICES", "CourseScan", "DEFAULT_CHECK_DAYS", "ESTIMATED", "Found", "SYLLABUS", "TRUST", "best", "exams_in_items", "fetch_onedrive",
    "find_date", "find_exams", "find_week", "is_onedrive", "scan_course", "term_start_guess",
]
