# Kamil Privacy Policy

Kamil is a free, open-source study assistant for Android. This policy covers the official Kamil app from this repository.

There is no Kamil account, and Kamil's authors run no server that receives your data. The app has no ads, analytics or crash reporting.

## What stays on your phone

In phone mode, your Canvas address and token, your AI key, your school mail login and what Kamil has read are stored only on your phone. Secrets are kept in Android's encrypted storage. **Bu telefondaki verileri sil** in Settings removes them.

In server mode, the same data is kept on the server you connect to, which you or someone you chose runs. Its owner is responsible for it.

## Where your data goes

Kamil connects only to the services you set up:

| Service | What it receives | When |
| --- | --- | --- |
| Your school's Canvas | Your token and read requests. Kamil does not submit or change anything there. | At each check |
| Your school's mail server | Your login and read requests. Kamil reads mail read-only, sends only a mail you approve, and puts its copy in your Sent folder. | At each check, if you added mail |
| The AI provider you chose (Gemini, OpenRouter or another service) | Your questions and the Canvas information Kamil looks up to answer them. Mail, only if you turn on **Okul maili bulut modele gitsin**. The text of an announcement or mail when you tap **Hatırlatıcı ekle**. | When you use these features |
| Google Tasks | The tasks you choose to add, and changes to them. | Only if you connect your Google account |
| GitHub | A request for the latest version and its release notes. GitHub can see your IP address. | When Kamil checks for updates |

Each provider handles what it receives under its own terms. On Gemini's free tier, Google may use it to improve its models.

## Google user data

If you choose **Google hesabına bağlan**, Kamil asks for one permission, Google Tasks (`https://www.googleapis.com/auth/tasks`). It does not get access to your Gmail or Drive. Only if you also use **Takvime ekle** with a Google connection does it ask for a second permission, `https://www.googleapis.com/auth/calendar.events`, which can add and change events but does not read your calendar; it adds only the event you picked. Without that permission, Android's own calendar app opens with the event filled in instead.

- Kamil uses this permission only to add the tasks you choose, to change their date when you agree, and to remove them when you ask.
- It sends your task list to no one. Nothing from Google Tasks goes to an AI provider or to Kamil's authors.
- Android gives the app an access token that lasts about an hour. It is not saved by Kamil, and no long-lived Google token is kept on the phone.
- Your Google user data is not sold, not used for advertising, and not used to train AI models.

Kamil's use of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

To stop this access, choose **Bağlantıyı kaldır** in Kamil and remove Kamil from your [Google account permissions](https://myaccount.google.com/permissions).

## Children

Kamil is meant for university students and is not directed at children under 13.

## Changes and contact

Changes to this policy appear in this file and in its history on GitHub. For questions, [open an issue](https://github.com/KaramelliSundae/kamil-ai-helper/issues).

---

## Türkçe özet

Kamil'in hesabı, reklamı ve analitiği yoktur; geliştiricilerine veriniz gelmez. Verileriniz telefonunuzda veya bağlandığınız sunucuda durur ve yalnızca kurduğunuz servislere gider: Canvas, okul maili, seçtiğiniz yapay zeka sağlayıcısı, bağlarsanız Google Tasks ve güncelleme denetimi için GitHub.

Google hesabınızı bağlarsanız Kamil yalnızca Tasks iznini ister ve seçtiğiniz görevleri ekleyip değiştirir. Görev listeniz hiçbir yere gönderilmez, satılmaz, reklamda veya model eğitiminde kullanılmaz. İzni istediğiniz zaman Google hesap izinlerinden kaldırabilirsiniz.
