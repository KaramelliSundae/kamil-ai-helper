import {
  AlertDialog,
  Button,
  Column,
  FilledTonalButton,
  FlowRow,
  LoadingIndicator,
  OutlinedButton,
  OutlinedTextField,
  Row,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Spacer,
  SuggestionChip,
  Switch,
  Text,
  TextButton,
  useMaterialColors,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize, fillMaxWidth, height, padding, verticalScroll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';
import type { ImageSourcePropType } from 'react-native';

import { ServerReport } from '../aziz';
import { ServerStatus } from '../ServerStatus';
import { api, Connection, GeminiSettings, saveConnection, ServerConnection } from '../api';
import { askForNotifications, notificationsAllowed, sendTestNotification } from '../background';
import { icons } from '../icons';
import { checkMailAccount, forgetMail, mailProblem, parseMailHost } from '../phone/mail';
import { DEFAULT_GEMINI_MODEL, loadMailSettings, loadPhoneSettings, modelChoices, saveMailAccount, saveMailToGemini } from '../phone/settings';
import { readState } from '../phone/store';
import { poll } from '../phone/watcher';
import { connectPhone, forgetPhone } from '../phone/setup';
import { Header, Notice, Panel, ShapeIcon, shapes, SectionTitle } from '../ui';
import { UpdatePanel } from '../UpdatePanel';

type Props = { connection: Connection | null; onSaved: (connection: Connection | null) => void };

function Field({ label, placeholder, state, onChange, secret, uri }: {
  label: string;
  placeholder?: string;
  state: ReturnType<typeof useNativeState<string>>;
  onChange: (value: string) => void;
  secret?: boolean;
  uri?: boolean;
}) {
  return (
    <OutlinedTextField
      value={state}
      onValueChange={onChange}
      singleLine
      visualTransformation={secret ? 'password' : undefined}
      keyboardOptions={{ keyboardType: secret ? 'password' : uri ? 'uri' : 'text', autoCorrectEnabled: false }}
      modifiers={[fillMaxWidth()]}>
      <OutlinedTextField.Label>
        <Text>{label}</Text>
      </OutlinedTextField.Label>
      {placeholder ? (
        <OutlinedTextField.Placeholder>
          <Text>{placeholder}</Text>
        </OutlinedTextField.Placeholder>
      ) : null}
    </OutlinedTextField>
  );
}

function Hint({ children }: { children: string }) {
  const colors = useMaterialColors();
  return (
    <Text color={colors.onSurfaceVariant} style={{ typography: 'bodySmall' }}>
      {children}
    </Text>
  );
}

function Busy({ busy, label, enabled, onClick }: { busy: boolean; label: string; enabled: boolean; onClick: () => void }) {
  return (
    <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
      <Button enabled={enabled && !busy} onClick={onClick} modifiers={[weight(1)]}>
        <Text>{busy ? 'Bekle…' : label}</Text>
      </Button>
      {busy ? <LoadingIndicator /> : null}
    </Row>
  );
}

/** No server at all: Canvas and Gemini straight from this phone. */
function PhonePanel({ connection, onSaved }: Props) {
  const urlState = useNativeState('');
  const tokenState = useNativeState('');
  const keyState = useNativeState('');
  const modelState = useNativeState(DEFAULT_GEMINI_MODEL);
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState(DEFAULT_GEMINI_MODEL);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);

  useEffect(() => {
    loadPhoneSettings().then((saved) => {
      urlState.set(saved.canvasUrl);
      tokenState.set(saved.canvasToken);
      keyState.set(saved.geminiKey);
      modelState.set(saved.geminiModel);
      setUrl(saved.canvasUrl);
      setToken(saved.canvasToken);
      setKey(saved.geminiKey);
      setModel(saved.geminiModel);
    }, () => undefined);
  }, [keyState, modelState, tokenState, urlState]);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await connectPhone({ canvasUrl: url, canvasToken: token, geminiKey: key, geminiModel: model });
      modelState.set(result.model);
      setModel(result.model);
      setModels(result.models);
      await saveConnection({ mode: 'phone' });
      onSaved({ mode: 'phone' });
      setMessage(
        `Hazır: ${result.name || 'Canvas'} bağlandı, ${result.items} kayıt okundu.` +
          (key.trim() ? ` Kamil ${result.model} ile çalışacak.` : ' Gemini anahtarı olmadan sohbet kapalı.'),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kurulamadı.');
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setConfirmForget(false);
    await forgetPhone();
    for (const state of [urlState, tokenState, keyState]) state.set('');
    setUrl('');
    setToken('');
    setKey('');
    if (connection?.mode === 'phone') onSaved(null);
    setMessage('Bu telefondaki tüm Kamil verileri ve anahtarlar silindi.');
  };

  return (
    <Panel>
      <SectionTitle icon={icons.today} title="Telefon" />
      <Hint>Sunucu gerekmez: telefon Canvas'a ve Gemini'ye kendisi bağlanır, verileri yalnızca bu telefonda tutar. Okul mailini aşağıdan ekleyebilirsin.</Hint>
      <Field label="Canvas adresi" placeholder="https://canvas.okulun.edu" state={urlState} onChange={setUrl} uri />
      <Field label="Canvas erişim belirteci" state={tokenState} onChange={setToken} secret />
      <Hint>Canvas'ta Hesap → Ayarlar → Yeni erişim belirteci. Kamil bununla yalnızca okur, hiçbir şey göndermez.</Hint>
      <Field label="Gemini API anahtarı (isteğe bağlı)" state={keyState} onChange={setKey} secret />
      <Field label="Gemini modeli" state={modelState} onChange={setModel} />
      <Hint>Anahtarı aistudio.google.com'dan alırsın. Ücretsiz katmanda Google yazdıklarını eğitim için kullanabilir.</Hint>
      {models.length ? (
        <FlowRow horizontalArrangement={{ spacedBy: 8 }} verticalArrangement={{ spacedBy: 8 }}>
          {modelChoices(models).map((name) => (
            <SuggestionChip key={name} onClick={() => { modelState.set(name); setModel(name); }}>
              <SuggestionChip.Label>
                <Text>{name}</Text>
              </SuggestionChip.Label>
            </SuggestionChip>
          ))}
        </FlowRow>
      ) : null}
      <Spacer modifiers={[height(4)]} />
      <Busy busy={busy} label="Kaydet ve başla" enabled={url.trim().length > 0 && token.trim().length > 0} onClick={() => void save()} />
      {message ? <Notice>{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {connection?.mode === 'phone' ? (
        <OutlinedButton onClick={() => setConfirmForget(true)}>
          <Text>Bu telefondaki verileri sil</Text>
        </OutlinedButton>
      ) : null}
      {confirmForget ? (
        <AlertDialog onDismissRequest={() => setConfirmForget(false)}>
          <AlertDialog.Title>
            <Text>Her şey silinsin mi?</Text>
          </AlertDialog.Title>
          <AlertDialog.Text>
            <Text>Canvas belirteci, Gemini anahtarı, sohbetler, notlar ve taslaklar bu telefondan silinir. Canvas'taki hiçbir şey değişmez.</Text>
          </AlertDialog.Text>
          <AlertDialog.ConfirmButton>
            <TextButton onClick={() => void forget()}>
              <Text>Sil</Text>
            </TextButton>
          </AlertDialog.ConfirmButton>
          <AlertDialog.DismissButton>
            <TextButton onClick={() => setConfirmForget(false)}>
              <Text>Vazgeç</Text>
            </TextButton>
          </AlertDialog.DismissButton>
        </AlertDialog>
      ) : null}
    </Panel>
  );
}

/** School mail on the phone itself: read-only, over TLS only, and kept from Gemini unless the student says otherwise. */
function PhoneMailPanel({ connection }: { connection: Connection | null }) {
  const colors = useMaterialColors();
  const hostState = useNativeState('');
  const userState = useNativeState('');
  const passwordState = useNativeState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [connected, setConnected] = useState(false);
  const [toGemini, setToGemini] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadMailSettings().then((saved) => {
      hostState.set(saved.host);
      setHost(saved.host);
      userState.set(saved.user);
      setUser(saved.user);
      setConnected(!!saved.host);
      setToGemini(saved.toGemini);
    });
    void readState().then((state) => setError(state.meta.mailError ?? null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const count = await checkMailAccount({ host: host.trim(), user: user.trim(), password });
      await saveMailAccount(host.trim(), user.trim(), password);
      passwordState.set('');
      setPassword('');
      setConnected(true);
      setMessage(`Bağlandı. Gelen kutusunda ${count} mail var. Son iki hafta sessizce okunacak, yeni gelenler Bildirimler'de görünür.`);
      if (connection?.mode === 'phone') void poll().catch(() => undefined);
    } catch (reason) {
      setError(mailProblem(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    await forgetMail();
    hostState.set('');
    setHost('');
    userState.set('');
    setUser('');
    passwordState.set('');
    setPassword('');
    setConnected(false);
    setToGemini(false);
    setError(null);
    setMessage('Mail hesabı ve okunan mailler bu telefondan silindi.');
  };

  return (
    <Panel>
      <SectionTitle icon={icons.mail} title="Okul maili" />
      <Hint>Telefon mailini kendisi okur, yalnızca şifreli bağlantıyla. Okunmamış mail okunmamış kalır; Kamil mail silmez, göndermez. Şifren yalnızca bu telefonda, şifreli durur.</Hint>
      <Field label="Mail sunucusu (IMAP)" placeholder="posta.okulun.edu.tr" state={hostState} onChange={setHost} uri />
      <Field label="Kullanıcı adı veya mail adresi" state={userState} onChange={setUser} uri />
      <Field label={connected ? 'Şifre (değiştirmek için)' : 'Şifre'} state={passwordState} onChange={setPassword} secret />
      <Hint>Sunucu adını okulunun bilgi işleminden öğrenebilirsin. Gmail gibi servisler normal şifre yerine uygulama şifresi ister.</Hint>
      {connected ? (
        <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
          <Column modifiers={[weight(1)]}>
            <Text color={colors.onSurface} style={{ typography: 'titleSmall' }}>Okul maili Gemini'ye gitsin</Text>
            <Hint>Kapalıyken mailler yalnızca Bildirimler'de durur, sohbette Gemini görmez. Açarsan Kamil'in okuduğu mail metinleri Google'a gider.</Hint>
          </Column>
          <Switch
            value={toGemini}
            onCheckedChange={(on) => {
              setToGemini(on);
              void saveMailToGemini(on);
            }}
          />
        </Row>
      ) : null}
      <Busy
        busy={busy}
        label={connected ? 'Kaydet ve dene' : 'Bağlan'}
        enabled={!!parseMailHost(host) && user.trim().length > 0 && password.length > 0}
        onClick={() => void save()}
      />
      {connected ? (
        <OutlinedButton onClick={() => void remove()}>
          <Text>Mail hesabını kaldır</Text>
        </OutlinedButton>
      ) : null}
      {message ? <Notice>{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Panel>
  );
}

/** Your own always-on server: it also reads school mail, inside its sandbox. */
function ServerPanel({ connection, onSaved }: Props) {
  const current = connection?.mode === 'server' ? connection : null;
  const serverState = useNativeState(current?.server ?? '');
  const tokenState = useNativeState(current?.token ?? '');
  const [server, setServer] = useState(current?.server ?? '');
  const [token, setToken] = useState(current?.token ?? '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const next: ServerConnection = { mode: 'server', server: server.trim(), token: token.trim() };
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.chatSetup(next); // only a connection that answers is kept
      await saveConnection(next);
      onSaved(next);
      setMessage('Bağlandı.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Bağlanılamadı.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel>
      <SectionTitle icon={icons.dns} title="Sunucu" />
      <Hint>Her zaman açık bir bilgisayarda çalışan Kamil sunucusu. Okul mailini de okur, bildirimleri o hazırlar.</Hint>
      <Field label="Adres" placeholder="http://192.168.1.20:8420" state={serverState} onChange={setServer} uri />
      <Field label="Token" state={tokenState} onChange={setToken} secret />
      <Hint>Token, sunucuda set-secrets.sh ilk çalıştığında bir kez gösterilir.</Hint>
      <Spacer modifiers={[height(4)]} />
      <Busy busy={busy} label="Kaydet ve bağlan" enabled={server.trim().length > 0 && token.trim().length > 0} onClick={() => void save()} />
      {message ? <Notice>{message}</Notice> : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Panel>
  );
}

/** Gemini on the server: the key is checked by the server with Google and kept there, not on the phone. */
function ServerGeminiPanel({ connection }: { connection: ServerConnection }) {
  const colors = useMaterialColors();
  const keyState = useNativeState('');
  const modelState = useNativeState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [settings, setSettings] = useState<GeminiSettings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const show = (next: GeminiSettings) => {
    setSettings(next);
    modelState.set(next.model);
    setModel(next.model);
  };

  useEffect(() => {
    api.geminiSettings(connection).then(show, () => setSettings(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  const act = async (action: () => Promise<GeminiSettings>) => {
    setBusy(true);
    setError(null);
    try {
      show(await action());
      keyState.set('');
      setKey('');
      setModels(await api.geminiModels(connection).catch(() => []));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Kaydedilemedi.');
    } finally {
      setBusy(false);
    }
  };

  if (!settings) return null;
  return (
    <Panel>
      <SectionTitle icon={icons.cloud} title="Gemini" />
      <Text color={settings.connected ? colors.primary : colors.onSurfaceVariant} style={{ typography: 'bodyMedium', fontWeight: '600' }}>
        {settings.connected ? `Bağlı: ${settings.model}${settings.source === 'server' ? ' (anahtar sunucuda ayarlı)' : ''}` : 'Bağlı değil'}
      </Text>
      {settings.source !== 'server' ? <Field label="Gemini API anahtarı" state={keyState} onChange={setKey} secret /> : null}
      <Field label="Model" state={modelState} onChange={setModel} />
      {models.length ? (
        <FlowRow horizontalArrangement={{ spacedBy: 8 }} verticalArrangement={{ spacedBy: 8 }}>
          {modelChoices(models).map((name) => (
            <SuggestionChip key={name} onClick={() => { modelState.set(name); setModel(name); }}>
              <SuggestionChip.Label>
                <Text>{name}</Text>
              </SuggestionChip.Label>
            </SuggestionChip>
          ))}
        </FlowRow>
      ) : null}
      {settings.connected ? (
        <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
          <Column modifiers={[weight(1)]}>
            <Text color={colors.onSurface} style={{ typography: 'titleSmall' }}>Okul maili Gemini'ye gitsin</Text>
            <Hint>Kapalıyken Gemini maillerini görmez. Açarsan mail metinleri Google'a gider.</Hint>
          </Column>
          <Switch value={settings.mailAllowed} onCheckedChange={(on) => void act(() => api.setGeminiSettings(connection, { mailAllowed: on }))} />
        </Row>
      ) : null}
      <Busy
        busy={busy}
        label={key.trim() ? 'Anahtarı kaydet' : 'Modeli kaydet'}
        enabled={key.trim().length > 0 || (settings.connected && model.trim().length > 0)}
        onClick={() => void act(() => api.setGeminiSettings(connection, key.trim() ? { key: key.trim(), model: model.trim() || undefined } : { model: model.trim() }))}
      />
      {settings.connected && settings.source === 'app' ? (
        <OutlinedButton onClick={() => void act(() => api.deleteGeminiKey(connection))}>
          <Text>Anahtarı sunucudan sil</Text>
        </OutlinedButton>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Panel>
  );
}

const SYLLABUS_CHOICES = [
  { days: 1, label: 'Her gün' },
  { days: 7, label: 'Haftada bir' },
  { days: 0, label: 'Kapalı' },
];

/** A course's syllabus often goes up weeks into the term, so a course without one is looked at again. How often is up to the student. */
function SyllabusCheckPanel({ connection }: { connection: Connection }) {
  const colors = useMaterialColors();
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    api.syllabusCheck(connection).then((reply) => { if (live) setDays(reply.days); }, () => undefined);
    return () => { live = false; };
  }, [connection]);
  if (days === null) return null; // an older server has no such setting
  const choose = (next: number) => {
    setDays(next);
    void api.setSyllabusCheck(connection, next).catch(() => undefined);
  };
  return (
    <Panel>
      <SectionTitle icon={icons.quiz} title="Sınav taraması" />
      <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>
        {connection.mode === 'phone'
          ? "Duyurular her kontrolde taranır. Syllabus'u henüz bulunmayan dersler ise burada seçtiğin sıklıkla yeniden bakılır; bulununca bir daha bakılmaz. Her dosya bir Gemini isteği harcar. Kapalıyken Gemini'ye dosya gitmez."
          : "Duyurular her kontrolde taranır. Syllabus'u henüz bulunmayan dersler ise burada seçtiğin sıklıkla yeniden bakılır; bulununca bir daha bakılmaz. Dosyalar sunucunda okunur, API ücreti yoktur."}
      </Text>
      <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
        {SYLLABUS_CHOICES.map((choice) => (
          <SegmentedButton key={choice.days} selected={days === choice.days} onClick={() => choose(choice.days)}>
            <SegmentedButton.Label>
              <Text>{choice.label}</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
        ))}
      </SingleChoiceSegmentedButtonRow>
    </Panel>
  );
}

export function SettingsScreen({ connection, onSaved }: Props) {
  const colors = useMaterialColors();
  const [mode, setMode] = useState<'phone' | 'server'>(connection?.mode ?? 'phone');
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    notificationsAllowed().then(setAllowed, () => setAllowed(false));
  }, [connection]);

  return (
    <Column modifiers={[fillMaxSize(), verticalScroll(), padding(16, 0, 16, 24)]} verticalArrangement={{ spacedBy: 14 }}>
      <Header title="Ayarlar" />

      <Panel>
        <Text color={colors.onSurface} style={{ typography: 'titleMedium', fontWeight: '700' }}>
          Kamil nerede çalışsın?
        </Text>
        <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
          <SegmentedButton selected={mode === 'phone'} onClick={() => setMode('phone')}>
            <SegmentedButton.Label>
              <Text>Sadece telefon</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
          <SegmentedButton selected={mode === 'server'} onClick={() => setMode('server')}>
            <SegmentedButton.Label>
              <Text>Kendi sunucum</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
        </SingleChoiceSegmentedButtonRow>
      </Panel>

      {mode === 'phone' ? <PhonePanel connection={connection} onSaved={onSaved} /> : <ServerPanel connection={connection} onSaved={onSaved} />}
      {mode === 'phone' ? <PhoneMailPanel connection={connection} /> : null}
      {mode === 'server' && connection?.mode === 'server' ? <ServerReport connection={connection} /> : null}
      {mode === 'server' && connection?.mode === 'server' ? <ServerStatus connection={connection} showModes /> : null}
      {mode === 'server' && connection?.mode === 'server' ? <ServerGeminiPanel connection={connection} /> : null}

      <Panel>
        <SectionTitle icon={icons.notifications} title="Bildirimler" />
        <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>
          {allowed
            ? 'Açık. Telefon yaklaşık 15 dakikada bir yenilere bakar; son tarih hatırlatmaları zamanında gelir. Gece 00:00–08:00 arası yalnızca son saatler bildirilir.'
            : 'Kapalı. Yeni ödev, son tarih ve önemli duyurular için izin ver.'}
        </Text>
        {allowed ? (
          <FilledTonalButton onClick={() => void sendTestNotification()}>
            <Text>Deneme bildirimi gönder</Text>
          </FilledTonalButton>
        ) : (
          <Button onClick={() => void askForNotifications().then(setAllowed)}>
            <Text>Bildirimlere izin ver</Text>
          </Button>
        )}
      </Panel>

      {connection ? <SyllabusCheckPanel connection={connection} /> : null}
      <UpdatePanel connection={connection} />
    </Column>
  );
}
