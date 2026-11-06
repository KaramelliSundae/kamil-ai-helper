# Security design

Kamil reads content that other people write: school mail (spam filters let a lot through), Canvas
announcements, messages from classmates. All of it is treated as hostile. The goal is that a malicious mail
or announcement can, at worst, produce a misleading notification or a draft you will see before anything
happens, and never run code, reach your secrets, or make Kamil act on its own.

## Where untrusted content goes

| Content | Where it is handled | What it can reach |
| --- | --- | --- |
| Raw mail (MIME, headers, HTML, images) | The mail sandbox on the server | Nothing: no network, no secrets, no disk |
| Mail and Canvas text | The watcher, the agent, the app | Plain text only; nothing is rendered or fetched |
| Mail images | Decoded in the sandbox, redrawn as new JPEGs | The phone decodes only those JPEGs, and only on tap |
| Raw mail in phone-only mode | JavaScript on the phone, text only | Attachments and images are never decoded; see below |
| Links | Shown as text with their real host | Opened only by you, in your browser |
| Text in the model's prompt | Fenced, with taint tracking | Tools that change state are gated |

## The mail sandbox (server)

The watcher downloads each mail as raw bytes over IMAP (read-only, `BODY.PEEK`, so mail stays unread) and
never parses it. `ai-ders-mailparse@.service` is started by systemd once per mail and reads it on stdin:

- no network at all (`PrivateNetwork`, `IPAddressDeny=any`, `RestrictAddressFamilies=none`),
- a throwaway user (`DynamicUser`), no credentials, and the state and settings folders made inaccessible,
- a read-only system and no writable files (`ProtectSystem=strict`, `LimitFSIZE=0`),
- nothing outside the interpreter can be executed (`NoExecPaths=/`), not even a shell,
- a syscall allowlist measured with `strace` on real mail; any other syscall kills the process,
- 384 MB of memory, 30 seconds, 4 tasks.

`systemd-analyze security` rates it 0.2 out of 10 (0 is best). A mail that crashes the parser is kept as
"(açılamayan mail)"; if the sandbox is missing entirely, the poll fails and is retried, so no mail is lost.

Images are decoded only inside the sandbox, and only as JPEG, PNG, GIF or WebP; most recent decoder bugs
in Pillow were in formats outside that list. Each image is redrawn into a new JPEG without metadata and at
most 1600 px. The watcher then checks the JPEG's structure without decoding it: only the exact layout the
encoder writes passes, so even a hijacked sandbox cannot hand the phone anything else. Remote images
(`http://` in the HTML) are never downloaded. Other attachments are listed by name and size and never
stored or opened.

When the sandbox is not available (for example on macOS during development), `MAIL_PARSER_SOCKET=inprocess`
parses in the watcher itself. Use that only for testing.

## Links

Nothing on the server or in the app ever visits a link from content, with one narrow exception: syllabi often live on OneDrive,
so the exam scan may fetch `1drv.ms`, `onedrive.live.com` and `*.sharepoint.com` links found on a course's own syllabus page, front
page or modules. It sends no cookies or credentials, follows redirects by hand and only to those same addresses, stops at 15 MB,
and accepts only a PDF or Word file, which then goes to the document sandbox. A link that asks for a login simply gives nothing.
 HTML links keep their real target
next to their words, so a link cannot hide where it goes. In the app the risk check is plain text
inspection of the address: hosts under your school domain open directly; everything else asks first and
shows the real host; bare IP addresses, punycode (look-alike) domains, hidden usernames
(`https://school.edu@evil.example`) and plain `http` are flagged as suspicious. Service labels such as
"Microsoft Teams" are given only for the exact domain, never for a look-alike.

## School mail in phone-only mode

There is no sandbox on a phone, so the phone does much less with a mail than the server does:

- **The connection.** `mobile/modules/mail-socket` opens TLS only, with no plain mode and no way to turn the checks off: Android must
  trust the certificate and the certificate must name the server. A failure stops before the password is sent.
- **Read-only.** The client uses `EXAMINE` and `BODY.PEEK`, and has no command that changes a mailbox.
- **Parsing.** `phone/mailparse.ts` is JavaScript. It reads headers and text parts, at most 256 KB of a mail, and lists attachment
  names without decoding them. No image, attachment or HTML is opened, rendered or fetched, and no link is followed.
- **The password** is in Android's encrypted storage and goes only to that mail server.
- **Gemini.** Mail reaches the model only if you turn on **Okul maili Gemini'ye gitsin**. Without it the mail tools are not offered at
  all, and `get_assignment` refuses mail keys. With it, mail is fenced and taints the turn, as on the server.

## Syllabi and exam dates

A syllabus is untrusted like any attachment. On a server, PDF and Word files are read by `ai-ders-docparse@.service`, the same
sandbox as the mail parser. What comes out is searched for dates and for sentences about attendance; no model reads the file. A
date, fixed labels, a short quote shown as plain text and those sentences are all that is kept. Attendance sentences reach the model
only when you ask about attendance, inside the same untrusted fence as a mail, which limits that turn the same way. In phone-only mode there is no sandbox,
so files go to Gemini if you have a key and have not turned syllabus reading off, and its answer is searched the same way.

## Prompt injection

Filters and "ignore instructions in the data" prompts are bypassed by adaptive attacks, so the rules are in
code, not in the model's goodwill. Kamil follows Meta's "Agents Rule of Two": one session should not read
untrusted input, hold private data, and change lasting state all at once.

- **Fencing.** Mail, announcement and assignment text reaches the model between
  `<guvenilmeyen_icerik sinir="…">` markers with a random boundary drawn for every question. Anything in
  the text that looks like the marker, however it is spelled, is defused, so a mail cannot "close the
  fence" and speak as the system.
- **Taint.** Reading untrusted text marks the turn and the conversation. In a tainted turn Kamil may save a
  note or set a reminder only if your own message asked for one. Notes saved from such content stay fenced
  in every later prompt.
- **Drafts.** Kamil cannot send mail. A draft gets a visible warning when its recipient is outside your
  school, when the address was neither typed by you nor the sender of a stored message, or when you never
  asked for a mail. On the server a draft goes out only after you approve it in the app, and only if it is
  exactly what you saw (hash check). In phone-only mode it opens in your mail app and you send it.
- **No dangerous tools.** There is no shell, no web access and no Canvas write. The tool list is closed and
  tested.
- **Output stays inert.** The chat renders no links or images, so an answer cannot leak data without a tap.

`tests/test_agent.py` runs a scripted model that obeys every instruction in a malicious mail: no note is
planted, no reminder is set, and its draft arrives with all three warnings.

**Live steps in chat.** While Kamil works, the chat shows what it is doing ("Maillerde arıyor"). These are
fixed labels chosen by tool name. No text from a mail or from the model's arguments reaches them, so a
hostile text cannot write its own status on the screen.

## App updates

The app updates only from your own server or from this project's GitHub Releases, and only when you tap. It compares
version numbers, downloads the APK, checks its SHA-256, and hands it to Android's installer. Android asks you to confirm
and refuses any APK not signed with the key of the installed app, so a tampered download or a stranger's build cannot
replace it. The check sends GitHub nothing about you beyond the request itself.

## The other server services

The model server (with a local model), the API and the watcher run with extra systemd hardening as well:
no other processes in view, no writable-executable memory, ordinary service syscalls only. A local model
server sees only the GPU devices, may only listen on its own port, and cannot read the state folder or the
secrets, because the prompts it reads carry mail text.

Pulling to refresh the notifications asks for a watcher round without giving the API any new power: it holds
no Canvas token and cannot start services, it only writes a file that `ai-ders-watcher.path` watches, at most
once a minute. The round runs in the watcher's own sandbox.

The API listens on one private address (`API_HOST`) and every route needs the device token. Gemini keys
entered in the app are checked with Google first and stored in the state folder with mode 0600, and are
never sent back to the app.

## Secrets

- **Server:** `systemd-creds`, bound to the machine's TPM when it has one, otherwise to the host key.
  Services receive them as credentials, never as environment variables or files in `/etc`.
- **Phone:** `expo-secure-store` (Android Keystore). The data file is in the app's private storage.

## What goes to Google with Gemini

Your question and the information Kamil looks up for it: Canvas data, and mail only if you turned on
**Okul maili Gemini'ye gitsin** on a server. On Gemini's free tier Google may use this to improve its
models. Use a local model on a server if that matters to you.

## Limits

This is a hardened Linux sandbox, not a virtual machine: a kernel exploit is the remaining way out. gVisor
or a VM would be the next step for a stronger threat model. Keep the server updated, and update Pillow when
it ships a security fix (`uv lock --upgrade-package pillow`, then deploy).
