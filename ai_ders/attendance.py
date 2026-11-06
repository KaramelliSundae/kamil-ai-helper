"""Finding what attendance a course asks for. Schools rarely give it for every course, so this only collects the sentences
that exist. Kamil reads them when the student asks; they are other people's text, and nothing acts on them."""

from __future__ import annotations

import re

MAX_NOTES = 6
NOTE_CHARS = 280

ATTENDANCE = re.compile(
    r"attendance|\battend(?:ing)?\b|absen(?:ce|ces|t|teeism)\b|\bmiss(?:es|ing)?\b[^.]{0,40}\b(?:class|lecture|session)|"
    r"devams[ıi]z|yoklama|devam\s*(?:zorunlu|mecburi|[şs]art|ko[şs]ul|y[üu]k[üu]ml[üu]|oran|durum)|"
    r"ders(?:e|lere|lerin|in)\s+(?:\S+\s+){0,3}devam|(?:%\s*\d+|\d+\s*%|y[üu]zde\s*\d+)\S*\s+(?:\S+\s+){0,2}devam|"
    r"ders(?:e|lere)\s+kat[ıi]l[ıi]m|kat[ıi]l[ıi]m\s*zorunlu",
    re.IGNORECASE,
)
FIGURE = re.compile(r"%\s*\d|\d\s*%|y[üu]zde\s*\d|percent|\d+\s*(?:hafta|week|ders\b|class|saat|hour|lecture|session|kez|times)", re.IGNORECASE)
# A sentence that only mentions attending says nothing: it needs a figure or a duty.
DUTY = re.compile(
    r"zorunlu|mecburi|[şs]art|mandatory|compulsory|required|obligatory|\bmust\b|\bf[xzf]\b|\bdz\b|kal[ıi]r|ba[şs]ar[ıi]s[ıi]z|"
    r"\bfail|will be taken|al[ıi]n[ıi]r|al[ıi]nacak",
    re.IGNORECASE,
)
SENTENCE_END = re.compile(r"(?<=[.!?;])\s+")


def find_attendance(text: str) -> list[str]:
    """The sentences that say something about attendance, those with a figure first."""
    notes: list[str] = []
    for paragraph in re.split(r"\n\s*\n", text):
        for sentence in SENTENCE_END.split(" ".join(paragraph.split())):
            match = ATTENDANCE.search(sentence)
            if match and (FIGURE.search(sentence) or DUTY.search(sentence)):
                start = max(0, match.start() - NOTE_CHARS // 2)
                notes.append(sentence[start:start + NOTE_CHARS])
    unique = list(dict.fromkeys(notes))
    unique.sort(key=lambda note: not FIGURE.search(note))
    return unique[:MAX_NOTES]
