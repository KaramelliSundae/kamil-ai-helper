# Running your own server

A server is optional: the app works on its own in phone-only mode. Run one if you want school mail
support, a local model, Google Tasks, or the daily digest by mail.

## What you need

- An always-on Linux machine with **systemd**: Fedora, Debian, Ubuntu, Arch, Raspberry Pi OS (64-bit) and
  similar. Windows 11 works through WSL2 with systemd enabled. With Gemini as the model, 2 GB of memory is
  plenty and no GPU is needed.
- [uv](https://docs.astral.sh/uv/getting-started/installation/) installed for the user you log in with.
- SSH access from your computer (the deploy script uses `ssh` and `rsync`), or a terminal on the machine.
- Your Canvas address and access token, and optionally your school mail address and password.

## Install

From your computer, in this repository:

```sh
deploy/deploy.sh you@your-server
```

This copies the project to `/opt/ai-ders` and runs `deploy/linux/install.sh` there as root. The installer:

- creates the `ai-ders` system user and its Python environment under `/opt/ai-ders`,
- installs the systemd units and starts the mail sandbox socket,
- writes `/etc/ai-ders/env` from `deploy/env.example` the first time,
- sets `API_HOST` to the machine's Tailscale address, or asks for a LAN address when there is none.

Installing directly on the machine instead: copy the repository to `/opt/ai-ders` and run
`sudo bash /opt/ai-ders/deploy/linux/install.sh`.

To skip typing the server every time, put `you@your-server` in a one-line file `deploy/.host` (ignored by
git). Then `deploy/deploy.sh` alone works.

## Configure

1. Edit the settings: `sudoedit /etc/ai-ders/env`. At least `CANVAS_URL`; for mail also `IMAP_HOST`,
   `MAIL_USER` and `SMTP_HOST`. Each setting is explained in the file.
2. Store the secrets: `sudo /opt/ai-ders/deploy/linux/set-secrets.sh`. It asks for the Canvas token and
   the mail password (press Enter to skip mail), and prints the **device token** for the app once. Note it.
3. Run the installer again (`deploy/deploy.sh you@your-server`), which starts the API and the timers.
4. Check: `ai-ders check` on the server tries Canvas and mail and prints only whether they worked.

## Connect the app

In the app: **Ayarlar → Kendi sunucum**. Enter `http://<API_HOST>:8420` and the device token, and tap
**Kaydet ve bağlan**. Then in the **Gemini** panel enter your Gemini API key: the server checks it with
Google and keeps it in its state folder (mode 0600). Instead you can store it as an encrypted credential
with `sudo /opt/ai-ders/deploy/linux/connect-gemini.sh`; a key stored that way cannot be changed from the
app.

The **Okul maili bulut modele gitsin** switch decides whether the cloud model may read your mail. It is off by
default: mail tools are then not offered to Gemini at all.

## Optional

- **Local model.** Run any OpenAI-compatible server on the same machine (llama.cpp's `llama-server`,
  Ollama, LM Studio) and set `LOCAL_LLM_URL`, for example `http://127.0.0.1:8080`. The app then offers both
  models; mail stays on your machine with the local one.
- **Google Tasks.** See [google-tasks.md](google-tasks.md). Create a Google Cloud project, enable the Tasks API, create an OAuth client of type
  *Desktop app*, and press *Publish app* under *Audience* ("In production"; in "Testing" Google drops the
  permission after 7 days). Google asks for a home page and a privacy policy address first: the steps are in the guide. You don't need
  Google's verification for your own use: ignore the "requires verification" banner and accept the "unverified app" warning when you give permission. Download
  the client JSON, copy it to the server and run
  `sudo /opt/ai-ders/deploy/linux/connect-google-tasks.sh /path/to/client.json`. The script deletes the
  file afterwards. Deadlines on the **Bugün** screen then have a button to add them to Google Tasks; tapping
  the check mark takes them out again, after asking.
- **Digest by mail.** Set `NOTIFY_EMAIL` and `SMTP_HOST`; a summary arrives each morning.
- **Keep a PC awake.** `KEEP_AWAKE=yes` stops a desktop or laptop server from going to sleep.
- **App updates.** Build the APK on the server and run `mobile/publish.sh`; phones in server mode update
  themselves.

## Server status in the app

On a server with a GPU gate (`GPU_GATE_URL`), **Ayarlar → Sunucu** shows what holds the GPU, free memory, the GPU's temperature and any jobs the gate runs. **Kamil'i öne al** gives the local model priority for 30 minutes. A server without a gate has none of this, and everything else works the same.

## Everyday commands

```sh
ai-ders poll        # one watcher round now
ai-ders upcoming    # what is due in the next 14 days
ai-ders check       # test the Canvas and mail connections
journalctl -u ai-ders-watcher -n 20      # what the last rounds did
systemd-analyze security ai-ders-mailparse@x.service   # the sandbox's exposure score
```

## Updating

Pull the repository and run `deploy/deploy.sh` again. Settings in `/etc/ai-ders` and the data in
`/var/lib/ai-ders` are kept.
