from __future__ import annotations

import pytest

from ai_ders.config import Settings
from ai_ders.models import HIGH, LOW, NORMAL
from ai_ders.rules import mail_level
from ai_ders.text import html_to_text, normalize_tr, shorten


@pytest.mark.parametrize(
    "subject",
    [
        "COMP303 VİZE SINAVI",
        "Final sınav takvimi",
        "Ödev teslim tarihi uzatıldı",
        "Bugünkü ders iptal edildi",
        "Bütünleme programı",
        "Midterm exam room change",
        "Homework deadline",
        "Ders kaydı başladı",
        "DEVAMSIZLIK uyarısı",
    ],
)
def test_course_news_is_urgent(subject):
    assert mail_level("hoca@uni.example.edu", subject, "", {}) == HIGH


@pytest.mark.parametrize("subject", ["But I think so", "For example", "Bütün öğrencilere selam", "Finally here"])
def test_word_parts_do_not_trigger(subject):
    assert mail_level("arkadas@uni.example.edu", subject, "", {}) == NORMAL


def test_keyword_in_the_body_counts():
    assert mail_level("hoca@uni.example.edu", "Bilgi", "Yarınki sınav ertelendi", {}) == HIGH


def test_ordinary_mail_waits_for_the_digest():
    assert mail_level("arkadas@uni.example.edu", "Selam", "Nasılsın", {}) == NORMAL


def test_canvas_notification_mail_does_not_double_the_api():
    assert mail_level("notifications@instructure.com", "Yeni ödev: HW1", "", {}) == LOW


@pytest.mark.parametrize(
    ("sender", "headers"),
    [
        ("kulup@uni.example.edu", {"list-unsubscribe": "<x>"}),
        ("kulup@uni.example.edu", {"precedence": "bulk"}),
        ("no-reply@uni.example.edu", {}),
        ("sistem@uni.example.edu", {"auto-submitted": "auto-generated"}),
    ],
)
def test_bulk_mail_is_low(sender, headers):
    assert mail_level(sender, "Etkinlik duyurusu", "", headers) == LOW


def test_university_wide_exam_notice_beats_bulk_headers():
    assert mail_level("oidb@uni.example.edu", "Final sınav takvimi", "", {"list-id": "x"}) == HIGH


def test_normalize_handles_dotted_and_dotless_i():
    assert normalize_tr("SINAV") == "sınav"
    assert normalize_tr("VİZE") == "vize"


def test_html_to_text_drops_markup_and_scripts():
    html = "<style>p{}</style><p>Merhaba&nbsp;dünya</p><script>x()</script><ul><li>bir</li><li>iki</li></ul>"
    assert html_to_text(html) == "Merhaba dünya\n\n• bir\n• iki"
    assert html_to_text(None) == ""
    assert html_to_text("<p>Bir\r\niki</p>") == "Bir iki"  # a line end in HTML source is a space


def test_one_div_per_line_keeps_paragraphs_together():
    # Zimbra writes each line as a <div> and a blank line as <div><br></div>.
    html = "<div>Değerli öğrenciler,</div><div><br></div><div>Vize Salı</div><div>saat 10:00.</div>"
    assert html_to_text(html) == "Değerli öğrenciler,\n\nVize Salı\nsaat 10:00."


def test_link_targets_stay_visible_next_to_their_words():
    html = '<a href="https://evil.example/x">canvas.uni.example.edu</a> <a href="https://a.b/">https://a.b</a>'
    assert html_to_text(html) == "canvas.uni.example.edu (https://evil.example/x) https://a.b"
    assert html_to_text('<a href="mailto:x@y.z">yaz</a>') == "yaz"


def test_better_text_conversion_is_not_an_edit():
    from ai_ders.text import fingerprint

    old = "Değerli,\n\nVize\n\nSalı Başvuru"
    new = "Değerli,\n\nVize\nSalı\n• Başvuru (https://x.y/z)"
    assert fingerprint(old) == fingerprint(new)
    assert fingerprint("Vize Salı") != fingerprint("Vize Perşembe")


def test_shorten_keeps_the_limit():
    assert shorten("a" * 50, 10) == "a" * 9 + "…"
    assert shorten("kısa", 10) == "kısa"


def test_secrets_stay_out_of_settings_repr(monkeypatch, tmp_path):
    monkeypatch.setenv("AI_DERS_ENV_FILE", str(tmp_path / "missing"))
    monkeypatch.setenv("CANVAS_TOKEN", "gizli-token")
    monkeypatch.setenv("MAIL_PASSWORD", "gizli-sifre")
    settings = Settings.from_env()
    assert settings.canvas_token == "gizli-token"
    assert "gizli" not in repr(settings)


def test_secrets_are_not_read_from_the_env_file(monkeypatch, tmp_path):
    env_file = tmp_path / "env"
    env_file.write_text("CANVAS_TOKEN=dosyadaki\n")
    monkeypatch.setenv("AI_DERS_ENV_FILE", str(env_file))
    monkeypatch.delenv("CANVAS_TOKEN", raising=False)
    assert Settings.from_env().canvas_token is None


def test_credentials_directory_wins(monkeypatch, tmp_path):
    (tmp_path / "canvas_token").write_text("kimlik\n")
    monkeypatch.setenv("AI_DERS_ENV_FILE", str(tmp_path / "missing"))
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(tmp_path))
    monkeypatch.setenv("CANVAS_TOKEN", "ortam")
    assert Settings.from_env().canvas_token == "kimlik"


def test_list_items_wrapped_in_paragraphs_keep_their_bullet():
    assert html_to_text("<ul><li><p>Resmî çağrı</p></li><li><p>Başvuru</p></li></ul>") == "• Resmî çağrı\n\n• Başvuru"


def test_zimbra_object_spans_keep_the_space_after_them():
    html = ('<span>üzere <span class="Object" id="OBJ_PREFIX_DWT1_ZmEmailObjectHandler">kutuphane@uni.example.edu</span>'
            '</span>aracılığıyla.</span> <span class="Object">x@y.z</span>, sonra')
    assert html_to_text(html) == "üzere kutuphane@uni.example.edu aracılığıyla. x@y.z, sonra"
    assert html_to_text("<span>Sağ</span>lıklı") == "Sağlıklı"  # ordinary spans never get a space


def test_zimbra_date_objects_inside_a_word_stay_joined():
    html = ('<span class="Object" id="OBJ_PREFIX_DWT7_com_zimbra_date">Sal</span>ı ve '
            '<span class="Object" id="OBJ_PREFIX_DWT8_com_zimbra_date">Per</span>şembe, '
            '<span class="Object" id="OBJ_PREFIX_DWT9_com_zimbra_url">https://uni.example.edu</span>adresinde')
    assert html_to_text(html) == "Salı ve Perşembe, https://uni.example.edu adresinde"
