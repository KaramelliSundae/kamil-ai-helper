# Kamil

Kamil is a personal study assistant for university students who use **Canvas**. It watches your courses,
reminds you of deadlines on your Android phone, answers questions about your coursework, and writes mail
drafts that only go out when you approve them. With a server it also reads your school mail (IMAP).

The app's interface is in Turkish.

> **Hızlı başlangıç (Türkçe):** [Releases](../../releases) sayfasından APK'yı telefona indirip kur → Ayarlar →
> **Sadece telefon** → Canvas adresini, Canvas erişim belirtecini ve (sohbet için) Gemini API anahtarını gir →
> **Kaydet ve başla** → bildirimlere izin ver. Sunucu gerekmez. Ayrıntılar aşağıda.

## Two ways to run it

| | **Phone only** | **With your own server** |
| --- | --- | --- |
| You need | An Android phone, a Canvas access token, a Gemini API key (only for chat) | The same, plus an always-on Linux machine with systemd |
| Canvas | The phone checks it about every 15 minutes | The server checks it every 10 minutes |
| School mail | Not read | Read over IMAP, inside a sandbox |
| Deadline reminders | Exact alarms 72, 24 and 3 hours before | Same, prepared by the server |
| Chat model | Gemini 3.8 Flash (cloud) | Gemini, or a local model (llama.cpp, Ollama, LM Studio) |
| Mail drafts | Open in your phone's mail app; you press send | Sent by the server after you approve them in the app |
| Google Tasks | No | Optional |

Start with **phone only**: it needs no other machine. Move to a server later if you want mail support or a
local model. The app has both, you choose in Settings.

## Phone only: setup

1. **Install the app.** Download the APK from [Releases](../../releases) on your phone and open it, or build
   it yourself (see [Android app](#android-app)). Android asks you to allow installs from that source once.
   Releases are signed with the certificate whose SHA-256 is
   `ef01b7e855f42298fd59dd269842b0b2f72002e6f478607fbebf853af10d2800` (CN=Kamil); later releases use the same
   key, so they install as updates.
2. **Canvas access token.** In Canvas: *Account → Settings → Approved Integrations → New Access Token*.
   Give it a name and an expiry date, then copy the token. Kamil only ever reads with it.
3. **Gemini API key (for chat).** Go to [Google AI Studio](https://aistudio.google.com), sign in, and choose
   *Get API key*. Without a key everything except chat still works.
4. In the app open **Ayarlar**, choose **Sadece telefon**, and fill in:
   - *Canvas adresi*: your school's Canvas address, for example `https://canvas.youruni.edu`
   - *Canvas erişim belirteci*: the token from step 2
   - *Gemini API anahtarı*: the key from step 3
   - *Gemini modeli*: `gemini-3.8-flash` by default; after saving, the app lists the Flash models your
     key can use
5. Tap **Kaydet ve başla**. Kamil checks the token with Canvas and the key with Google before it saves
   anything, then reads your courses once without notifying you about what is already there.
6. Tap **Bildirimlere izin ver**. From now on new assignments, changed due dates, grades and announcements
   arrive as notifications, and deadline reminders arrive on time even when the app is closed.

Your token and key are kept in Android's encrypted storage. Course data, chats and notes stay in the app's
private storage on the phone. **Bu telefondaki verileri sil** in Settings removes all of it.

**What goes to Google:** in chat, your question and the Canvas information Kamil looks up to answer it.
On Gemini's free tier Google may use this to improve its models; a paid key changes that. Nothing else
leaves the phone except requests to your Canvas.

## With your own server

The server runs on any always-on Linux machine with systemd: a home PC, a mini PC, a Raspberry Pi 4/5,
or a small cloud server. With Gemini as the model it needs no GPU and very little memory. See
[docs/server.md](docs/server.md) for the full guide. In short:

```sh
git clone <this repository> kamil && cd kamil
deploy/deploy.sh you@your-server         # copies to /opt/ai-ders and installs (run on your computer)
ssh -t you@your-server sudoedit /etc/ai-ders/env                                  # Canvas URL, mail, name
ssh -t you@your-server sudo /opt/ai-ders/deploy/linux/set-secrets.sh             # token, mail password
deploy/deploy.sh you@your-server         # again, to start everything
```

`set-secrets.sh` prints a device token once. In the app choose **Kendi sunucum**, enter the server's
address (`http://<server-ip>:8420`) and that token. Then add your Gemini key in the app's **Gemini** panel;
the server checks it with Google and keeps it, not the phone.

The phone must reach the server: on the same Wi-Fi this is the server's LAN address. To use it from
anywhere, put both on [Tailscale](https://tailscale.com); the installer picks the Tailscale address if
there is one.

## Android app

The app is built with Expo (React Native) and Jetpack Compose components (Material 3 Expressive). It is
Android only.

Build requirements: Linux or macOS with Node.js 22+, the Android SDK and a JDK 17 (Android Studio ships
both), and about 8 GB of free memory.

```sh
cd mobile
npm ci
./build.sh        # writes android/app/build/outputs/apk/release/app-release.apk
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

`build.sh` assumes Android Studio's paths (`~/android-studio/jbr`, `~/Android/Sdk`); set `JAVA_HOME` and
`ANDROID_HOME` if yours differ. The APK holds both arm64 (phones) and x86_64 (emulators).

`build.sh` signs with React Native's debug key, which every React Native project shares: fine for your
own phone, not for sharing, because a phone would then accept anyone's "update". To share a build, sign it
with your own key: `mobile/sign-release.sh kamil.apk` creates one on first use (back it up). Android only
installs an update signed with the same key as the installed app, so switching keys needs one uninstall.

**Updates in server mode:** run `mobile/publish.sh` on the server after building there. Phones then show
*Yeni sürüm hazır* and update themselves; the download is checked against its SHA-256.

## Notifications and chat

Pull down on **Bildirimler** to check Canvas (and mail, on a server) right away. Each notification shows what
holds now, not just what was true when it arrived: time left, *Süresi geçti*, *Teslim edildi* or the grade.
Slide a notification sideways, then tap **Sil** to delete it. While Kamil answers, the chat shows each step it
is taking.

## Security

Mail and Canvas content is treated as hostile input. A short version; the details are in
[docs/security.md](docs/security.md).

- **Read-only Canvas.** The Canvas client can only send GET requests, and it never follows a page link to
  another host, because the token goes with every request.
- **Mail is parsed in a sandbox.** On the server, every mail is read by a fresh process that has no network,
  no secrets, no writable disk and a short syscall allowlist. Images are decoded only there and redrawn as
  plain JPEGs. Remote images are never fetched. The phone never renders mail HTML.
- **Links are never visited** by the server or the app. A link opens only when you tap it, in your browser,
  and links outside your school ask first. Bare IPs, look-alike (punycode) domains and hidden usernames are
  flagged.
- **Prompt injection.** Kamil follows Meta's "Rule of Two": after it reads untrusted text, it cannot save
  notes or set reminders unless your own message asked for it. Untrusted text is fenced with a random
  boundary each time, and drafts get a red warning when the recipient looks like it came from a mail.
  Nothing is ever sent without you.
- **Secrets.** On the server they are stored with `systemd-creds` (bound to the TPM when there is one). On
  the phone they are in Android's encrypted storage.

## Configuration (server)

Set in `/etc/ai-ders/env` on the server; `deploy/env.example` has comments for each.

| Setting | Meaning |
| --- | --- |
| `CANVAS_URL` | Your school's Canvas, for example `https://canvas.youruni.edu` |
| `IMAP_HOST`, `IMAP_PORT` | School mail server; leave `IMAP_HOST` empty to run without mail |
| `MAIL_USER` | Your school mail address |
| `STUDENT_NAME` | Signs drafts and greets you |
| `SMTP_HOST`, `SMTP_PORT` | Sends approved drafts and the optional digest |
| `NOTIFY_EMAIL` | Optional daily digest by mail |
| `WEBMAIL_URL` | Optional, for the app's "open in webmail" button |
| `SCHOOL_DOMAIN` | Addresses under it count as your school's (default: the domain of `MAIL_USER`) |
| `GEMINI_MODEL` | Default `gemini-3.8-flash` |
| `LOCAL_LLM_URL` | Optional local OpenAI-compatible model server, for example `http://127.0.0.1:8080` |
| `GPU_GATE_URL` | Optional, for machines that lend the GPU to another program |
| `TIMEZONE`, `REMINDER_HOURS`, `CRITICAL_HOURS`, `QUIET_START`, `QUIET_END` | Reminder timing and quiet hours |
| `KEEP_AWAKE` | `yes` keeps a desktop or laptop server from sleeping |

## Development

```sh
uv sync
uv run pytest                     # server tests
cd mobile && npm ci && npx tsc --noEmit
```

`STATE_DIR=./.state MAIL_PARSER_SOCKET=inprocess uv run ai-ders check` tries the Canvas and mail
connections from your own computer (`inprocess` skips the mail sandbox, so use it only for testing).

| Path | What it is |
| --- | --- |
| `ai_ders/` | The server: watcher, agent, tools, API, mail sandbox |
| `deploy/` | Installer, systemd units, secret scripts |
| `mobile/` | The Android app |
| `mobile/src/phone/` | The phone-only backend: Canvas, storage, alarms, Gemini agent |
| `tests/` | Server tests, including prompt-injection and sandbox tests |
| `docs/` | Server guide and security design |

## License

[BSD Zero Clause](LICENSE): do whatever you want with it, no conditions, no attribution needed. It comes
with no warranty: check your deadlines yourself too.
