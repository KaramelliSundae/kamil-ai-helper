"""The records every source produces."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

# critical: sent at once, even in quiet hours. high: sent at once outside quiet hours.
# normal and low: wait for the daily digest.
CRITICAL = "critical"
HIGH = "high"
NORMAL = "normal"
LOW = "low"


@dataclass(frozen=True)
class Attachment:
    """A file that came with a mail. Only images are kept, and only as the sandbox re-encoded them."""

    name: str
    type: str
    size: int
    image: str | None = None  # sha256 of the clean JPEG in the image folder
    width: int = 0
    height: int = 0


@dataclass(frozen=True)
class Item:
    """One thing the student may need to know about. `key` is stable across polls."""

    key: str
    kind: str  # assignment | quiz | discussion | event | announcement | message | mail
    title: str
    course: str = ""
    url: str = ""
    sender: str = ""
    body: str = ""
    due_at: datetime | None = None
    posted_at: datetime | None = None
    grade: str | None = None
    submitted: bool = False
    level: str = HIGH
    attachments: tuple[Attachment, ...] = ()
