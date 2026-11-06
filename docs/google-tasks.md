# Google Tasks'ı bağlama

Kamil'de görev eklemenin iki yolu var.

| | Kurulumsuz paylaşım | Google hesabına bağlanma |
|---|---|---|
| Nerede | Yalnızca telefon modu | Telefon modu; sunucuda kendi istemcinle |
| Kurulum | Yok | Telefonda tek dokunuş; sürümü yayınlayanın bir kerelik hazırlığı |
| Nasıl eklenir | Android paylaşım ekranı açılır, uygulamayı sen seçersin | Doğrudan listene eklenir |
| Tarih | Metnin içinde gider | Görevin tarih alanına yazılır |
| Tarih sonradan değişirse | Kamil takip edemez | Kamil "güncelleyeyim mi?" diye sorar |

**Gemini anahtarı bu iş için yetmez.** Hangi model olursa olsun, API anahtarı yalnızca modeli çağırır; Google hesabındaki Tasks'a erişim vermez. Android'de de bir uygulamanın Google Tasks uygulamasına kendi başına görev eklemesinin belgelenmiş bir yolu yok. Bu yüzden doğrudan ekleme için Google izni gerekir.

## Telefonda bağlanma

**Ayarlar → Google Tasks → Google hesabına bağlan**. Açılan pencere adımları anlatır:

1. Görevlerinin durduğu hesabı seç.
2. "Google bu uygulamayı doğrulamadı" uyarısı çıkarsa **Gelişmiş**'e, sonra uygulamaya git'e bas.
3. Görevlerine erişim iznini onayla.

Telefonda istemci sırrı veya uzun ömürlü jeton durmaz. Android bir saatlik erişim jetonu verir ve izin geçerli olduğu sürece ekran açmadan yeniler.

## Sürümü yayınlayanın kurulumu

Bunu APK'yı imzalayan kişi bir kez yapar, kullanıcılar yapmaz. Hepsi [Google Cloud Console](https://console.cloud.google.com)'dadır.

1. **Proje aç:** [Yeni proje](https://console.cloud.google.com/projectcreate). Ad önemli değil.
2. **Tasks API'yi aç:** [Tasks API](https://console.cloud.google.com/apis/library/tasks.googleapis.com) sayfasında **Enable**.
3. **İzin ekranını kur:** [Auth overview](https://console.cloud.google.com/auth/overview) → **Get started**, kitle olarak **External**. [Branding](https://console.cloud.google.com/auth/branding) sayfasında:
   - **App name:** `Kamil`. Adda "google" geçmesin, Google reddedebilir.
   - **User support email:** Bu adres izin ekranında kullanıcılara görünebilir. Kişisel adresin görünmesin istiyorsan bu iş için ayrı bir Gmail aç.
   - **App logo:** Boş bırak. Logo yüklersen doğrulama başvurusu gerekir.
   - **Application home page:** `https://github.com/KaramelliSundae/kamil-ai-helper`
   - **Application privacy policy link:** `https://github.com/KaramelliSundae/kamil-ai-helper/blob/main/docs/privacy.md`
   - **Authorised domains:** `github.com`
   - **Developer contact email:** Kullanıcılara gösterilmez.
4. **Uygulamayı yayınla:** [Audience](https://console.cloud.google.com/auth/audience) → **Publish app**. Durum **In production** olmalı. "Testing"de bırakırsan Google izni 7 günde düşürür.
5. **Doğrulamayı atla:** Google uygulamanın doğrulanmadığını söyleyebilir. Az sayıda kişi için doğrulama başvurusu yapmak zorunda değilsin; aşağıdaki sınırları oku.
6. **Android istemcisi oluştur:** [Clients](https://console.cloud.google.com/auth/clients) → **Create client** → tür **Android**.
   - Paket adı: `com.aiders.mobile`
   - SHA-1: APK'yı imzaladığın sertifikanın parmak izi. Bu repodaki resmi sürümler için `2A:96:71:2E:35:83:53:39:67:05:41:63:B2:FF:66:69:99:F7:51:D6`. Kendi imzanla derlediysen `apksigner verify --print-certs kamil.apk` ile öğrenirsin.
   - "Use this client for an AI-powered agent" kutusunu **işaretleme**.

Paket adı ve SHA-1 sır değildir: ikisi de APK'nın içinden okunabilir, Google'ın uygulamayı tanımasını sağlar. Sır olan imza anahtarıdır, onu paylaşma. Bu istemcinin sırrı yoktur, uygulamaya veya repoya bir şey eklemen gerekmez.

## Sunucu modunda

Sunucu telefon olmadan çalıştığı için kendi izniyle çalışır. Aynı projede **Desktop app** türünde bir istemci oluştur, JSON dosyasını indir ve sunucuda çalıştır:

```bash
sudo /opt/ai-ders/deploy/linux/connect-google-tasks.sh /yol/client.json
```

Betik dosyayı işi bitince siler; izin sunucuda şifreli kimlik bilgisi olarak durur.

## Doğrulamayı atlamanın sınırları

Google'ın kurallarına göre:

- Doğrulanmamış bir projede kullanıcı sayısı, projenin ömrü boyunca **100 yeni kullanıcıyla** sınırlıdır ve sıfırlanmaz.
- İzin sırasında doğrulanmamış uygulama uyarısı görünebilir.

Daha çok kullanıcıya açılacaksa Google'ın doğrulama sürecinden geçmek gerekir.

## Gizlilik

- İzin yalnızca görevler içindir (`auth/tasks`); Gmail, Drive veya takvime erişmez.
- Hatırlatıcı önerisi için duyuru veya mail metni seçtiğin modele gider; mail ancak "Okul maili bulut modele gitsin" açıksa gider.
- Tasks'a yalnızca seçtiğin görev metni, kaynak başlığı ve varsa Canvas bağlantısı yazılır.
- İstediğin zaman iptal edebilirsin: Kamil'de **Bağlantıyı kaldır** ve [Google hesap izinleri](https://myaccount.google.com/permissions).

## Sorun çıkarsa

- **"Bu sürüm için Google istemcisi henüz kurulmamış":** Android istemcisi yok, ya da paket adı veya SHA-1 yanlış. 6. adıma bak. O zamana kadar paylaşım ekranı çalışır.
- **`access_denied` veya test kullanıcısı hatası:** Uygulama hâlâ **Testing**'de, 4. adıma dön.
- **Bir hafta sonra izin düştü:** Yine **Testing**'de kalmış demektir.
