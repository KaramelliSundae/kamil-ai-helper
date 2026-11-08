"""ai_ders.fchost/fcguest and ai_ders.dphost/dpguest are thin, near-identical wrappers around the
shared ai_ders.vmhost/vmguest machinery (tested on their own in test_vmhost.py/test_vmguest.py). The
risk in code this repetitive is a copy-paste mistake - the mail host picking the doc guest's
/init-doc, say - so this checks the one thing each wrapper is actually responsible for: which rdinit
it asks for, and how it shapes a reply."""

from __future__ import annotations

from unittest.mock import patch

from ai_ders import dphost, fchost
from ai_ders.dpguest import build_reply as doc_build_reply
from ai_ders.docparse import parse as doc_parse
from ai_ders.mailparse import parse as mail_parse


def test_fchost_boots_the_mail_guest():
    with patch("ai_ders.fchost.run_vm", return_value=b"{}") as run_vm, patch(
        "sys.stdin.buffer.read", return_value=b"raw"
    ):
        fchost.main()
    assert run_vm.call_args.kwargs["rdinit"] == "/init-mail"


def test_dphost_boots_the_document_guest():
    with patch("ai_ders.dphost.run_vm", return_value=b'{"text": "hi"}') as run_vm, patch(
        "sys.stdin.buffer.read", return_value=b"raw"
    ):
        dphost.main()
    assert run_vm.call_args.kwargs["rdinit"] == "/init-doc"


def test_fcguest_build_reply_is_mailparse_parse():
    # fcguest.py passes mailparse.parse straight through: it already returns a reply dict.
    from ai_ders.fcguest import main as fcguest_main

    assert fcguest_main.__module__ == "ai_ders.fcguest"
    # Nothing to wrap for mail, so there's no fcguest.build_reply - the module-level `parse` import
    # from mailparse *is* the reply builder. Confirm it's the real one, not a stray local redefinition.
    import ai_ders.fcguest as fcguest

    assert fcguest.parse is mail_parse


def test_dpguest_build_reply_wraps_text_in_a_dict():
    # docparse.parse() returns a bare string; the guest's wire contract needs a dict, same shape
    # ai_ders.docparse.main() itself produces ({"text": ...}), not ai_ders.mailparse's (already a dict).
    assert doc_build_reply(b"not a real pdf or docx") == {"text": doc_parse(b"not a real pdf or docx")}
