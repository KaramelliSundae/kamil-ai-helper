"""Settings.

Values come from the process environment, then from an env file (KEY=VALUE lines): the path in
AI_DERS_ENV_FILE, otherwise /etc/ai-ders/env. The process environment wins.

Secrets never live in that file. On the server they come from systemd credentials
(CREDENTIALS_DIRECTORY), which are encrypted to this machine's TPM. For development they can be set
in the process environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from zoneinfo import ZoneInfo

DEFAULT_ENV_FILE = "/etc/ai-ders/env"


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return values
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def read_secret(name: str) -> str | None:
    directory = os.environ.get("CREDENTIALS_DIRECTORY")
    if directory:
        path = Path(directory) / name
        if path.exists():
            return path.read_text(encoding="utf-8").strip() or None
    return os.environ.get(name.upper()) or None


@dataclass(frozen=True)
class Settings:
    canvas_url: str
    imap_host: str
    imap_port: int
    smtp_host: str
    smtp_port: int
    mail_user: str | None
    notify_email: str | None
    student_name: str | None
    gemini_model: str
    mail_parser: str
    school_domain: str
    webmail_url: str
    local_llm_url: str
    gpu_gate_url: str
    state_dir: Path
    timezone: ZoneInfo
    reminder_hours: tuple[int, ...]
    critical_hours: int
    quiet_start: int
    quiet_end: int
    canvas_token: str | None = field(default=None, repr=False)
    mail_password: str | None = field(default=None, repr=False)
    api_token: str | None = field(default=None, repr=False)
    google_tasks: str | None = field(default=None, repr=False)
    gemini_key: str | None = field(default=None, repr=False)
    doc_parser: str = "/run/ai-ders-docparse.sock"

    @property
    def db_path(self) -> Path:
        return self.state_dir / "ai-ders.sqlite3"

    @property
    def image_dir(self) -> Path:
        """Mail images as the sandbox re-encoded them, named by their SHA-256."""
        return self.state_dir / "mail-images"

    @classmethod
    def from_env(cls, overrides: dict[str, str] | None = None) -> Settings:
        env_file = Path(os.environ.get("AI_DERS_ENV_FILE") or DEFAULT_ENV_FILE)
        values = {**read_env_file(env_file), **os.environ, **(overrides or {})}

        def get(name: str, default: str | None = None) -> str | None:
            value = values.get(name)
            return value if value not in (None, "") else default

        hours = sorted((int(h) for h in get("REMINDER_HOURS", "72,24,3").split(",")), reverse=True)
        return cls(
            # No defaults for the school: each one is set in the env file (see deploy/env.example).
            canvas_url=(get("CANVAS_URL") or "").rstrip("/"),
            imap_host=get("IMAP_HOST") or "",
            imap_port=int(get("IMAP_PORT", "993")),
            smtp_host=get("SMTP_HOST") or "",
            smtp_port=int(get("SMTP_PORT", "587")),
            mail_user=get("MAIL_USER"),
            notify_email=get("NOTIFY_EMAIL"),
            student_name=get("STUDENT_NAME"),
            gemini_model=get("GEMINI_MODEL", "gemini-3.8-flash"),
            # The sandbox's socket. "inprocess" parses unsandboxed, for development only.
            mail_parser=get("MAIL_PARSER_SOCKET", "/run/ai-ders-mailparse.sock"),
            doc_parser=get("DOC_PARSER_SOCKET", "/run/ai-ders-docparse.sock"),
            # Mail from addresses under this domain counts as the school's; by default the student's own.
            school_domain=(get("SCHOOL_DOMAIN") or (get("MAIL_USER") or "").rpartition("@")[2]).lower(),
            webmail_url=get("WEBMAIL_URL") or "",
            # An OpenAI-compatible server on this machine (llama-server, Ollama, LM Studio). Empty: Gemini only.
            local_llm_url=get("LOCAL_LLM_URL") or "",
            # Optional: a gate that lends the GPU to another program and stops the model meanwhile.
            gpu_gate_url=get("GPU_GATE_URL") or "",
            state_dir=Path(get("STATE_DIR", "/var/lib/ai-ders")),
            timezone=ZoneInfo(get("TIMEZONE", "Europe/Istanbul")),
            reminder_hours=tuple(hours),
            critical_hours=int(get("CRITICAL_HOURS", "3")),
            quiet_start=int(get("QUIET_START", "0")),
            quiet_end=int(get("QUIET_END", "8")),
            canvas_token=read_secret("canvas_token"),
            mail_password=read_secret("mail_password"),
            api_token=read_secret("api_token"),
            google_tasks=read_secret("google_tasks"),
            gemini_key=read_secret("gemini_key"),
        )
