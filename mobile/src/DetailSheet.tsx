import {
  Box,
  Button,
  Column,
  FilledTonalButton,
  FlowRow,
  Icon,
  Image,
  LoadingIndicator,
  ModalBottomSheet,
  OutlinedButton,
  Row,
  Surface,
  Text,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import {
  background,
  clip,
  fillMaxWidth,
  height,
  padding,
  paddingAll,
  Shapes,
  size,
  verticalScroll,
  weight,
} from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';
import { Linking, useWindowDimensions } from 'react-native';

import { api, Attachment, Connection, ItemDetail } from './api';
import { appConfig } from './config';
import { ConfirmDialog } from './ConfirmDialog';
import { formatDate, tidyText, timeLeft } from './format';
import { icons } from './icons';
import { LinkDialog, MailBody } from './MailBody';
import { loadMailImage } from './mailImages';
import { hostOf, linkRisk, LinkRisk, splitSender } from './mailText';
import { TaskPicker } from './TaskPicker';
import { Notice, rounded, shapes } from './ui';

/** What the list already knows, shown until the full record arrives (and kept when there is none). */
export type DetailTarget = { key: string; title: string; body?: string; url?: string; when?: string };

const KIND_NAMES: Record<string, string> = {
  assignment: 'Ödev',
  quiz: 'Quiz',
  discussion: 'Tartışma',
  event: 'Etkinlik',
  announcement: 'Duyuru',
  message: 'Canvas mesajı',
  mail: 'Mail',
};
const WORK = new Set(['assignment', 'quiz', 'discussion']);
const UNREADABLE = '(açılamayan mail)';
const SHEET_GUTTER = 20;
const CARD_PADDING = 20;

export function DetailSheet({ connection, target, tasksEnabled, inTasks, onClose, onSolve }: {
  connection: Connection;
  target: DetailTarget;
  tasksEnabled?: boolean;
  inTasks?: boolean;
  onClose: () => void;
  /** Present when Gemini is connected. */
  onSolve?: (detail: ItemDetail) => void;
}) {
  const colors = useMaterialColors();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [taskAdded, setTaskAdded] = useState(!!inTasks);
  const [picking, setPicking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ url: string; host: string; risk: LinkRisk } | null>(null);

  // Canvas gives these links, but they are still checked: only links under the school domain open without asking.
  const openLink = (link: string) => {
    const risk = linkRisk(link);
    if (risk.level === 'school') void Linking.openURL(link);
    else setAsking({ url: link, host: hostOf(link), risk });
  };

  useEffect(() => {
    let live = true;
    api
      .item(connection, target.key)
      .then(
        (found) => {
          if (!live) return;
          setDetail(found);
          if (found.inTasks !== undefined) setTaskAdded(found.inTasks);
        },
        () => live && setDetail(null), // reminders and alerts have no record behind them
      )
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [connection, target.key]);

  const kind = detail?.kind ?? (target.key.startsWith('mail:') ? 'mail' : undefined);
  const mail = kind === 'mail';
  const work = !!kind && WORK.has(kind);
  const url = detail?.url || target.url || '';
  // With a record, only its own text: an assignment without a description must not show the reminder's line.
  const body = tidyText(detail ? detail.body : target.body ?? '');
  const when = detail?.postedAt ?? target.when ?? null;
  const unreadable = detail?.title === UNREADABLE;
  const files = detail?.attachments ?? [];
  // Only an announcement or a mail needs the model to say what the task is, and only when asked: an assignment names itself.
  const remindable = !!tasksEnabled && !!detail && !work && !unreadable;

  const addTask = async () => {
    setError(null);
    try {
      const { status } = await api.addTask(connection, target.key);
      setNote(status === 'exists' ? "Zaten Google Tasks'ta." : "Google Tasks'a eklendi.");
      setTaskAdded(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Eklenemedi.');
    }
  };

  const removeTask = async () => {
    setConfirmRemove(false);
    setError(null);
    try {
      await api.removeTask(connection, target.key);
      setNote("Google Tasks'tan çıkarıldı.");
      setTaskAdded(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Çıkarılamadı.');
    }
  };

  return (
    <ModalBottomSheet onDismissRequest={onClose} skipPartiallyExpanded={mail} containerColor={colors.surfaceContainerLow}>
      <Column
        modifiers={[fillMaxWidth(), verticalScroll(), padding(SHEET_GUTTER, 0, SHEET_GUTTER, 32)]}
        verticalArrangement={{ spacedBy: 16 }}>
        <Column verticalArrangement={{ spacedBy: 6 }}>
          {kind ? (
            <Text color={colors.primary} style={{ typography: 'labelLarge', fontWeight: '700' }}>
              {KIND_NAMES[kind] ?? kind}
            </Text>
          ) : null}
          <Text color={colors.onSurface} style={{ typography: 'headlineSmall', fontWeight: '700', lineBreak: 'heading' }}>
            {detail?.title ?? target.title}
          </Text>
        </Column>

        {mail && detail ? (
          <SenderRow sender={detail.sender} when={when} />
        ) : (
          <WorkInfo detail={detail} when={when} work={work} />
        )}

        <Surface color={colors.surfaceContainerLowest ?? colors.surface} shape={rounded(24)} modifiers={[fillMaxWidth()]}>
          <Column modifiers={[paddingAll(CARD_PADDING)]}>
            {loading ? (
              <LoadingIndicator modifiers={[paddingAll(16)]} />
            ) : unreadable ? (
              <Notice tone="error">
                Bu mail güvenli okuyucuda açılamadı: bozuk ya da zararlı olabilir. Gerekirse webmailde dikkatle bak.
              </Notice>
            ) : body ? (
              <MailBody body={body} />
            ) : (
              <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyLarge' }}>
                {files.some((f) => f.image) ? 'Bu mailde yazı yok, içerik görsellerde.' : 'Açıklama yok.'}
              </Text>
            )}
          </Column>
        </Surface>

        {files.length ? <Attachments connection={connection} files={files} /> : null}

        {error ? <Notice tone="error">{error}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        {picking ? (
          <TaskPicker
            connection={connection}
            itemKey={target.key}
            onCancel={() => setPicking(false)}
            onAdded={(status) => {
              setPicking(false);
              setTaskAdded(true);
              setNote(status === 'exists' ? "Zaten Google Tasks'ta." : "Google Tasks'a eklendi.");
            }}
          />
        ) : null}
        <FlowRow horizontalArrangement={{ spacedBy: 8 }} verticalArrangement={{ spacedBy: 8 }}>
          {work && detail && onSolve ? (
            <Button onClick={() => onSolve(detail)}>
              <Icon source={icons.cloud} size={18} />
              <Text modifiers={[paddingAll(4)]}>Gemini ile çöz</Text>
            </Button>
          ) : null}
          {(work && tasksEnabled || remindable) && taskAdded ? (
            <OutlinedButton onClick={() => setConfirmRemove(true)}>
              <Icon source={icons.taskDone} size={18} />
              <Text modifiers={[paddingAll(4)]}>Google Tasks'tan çıkar</Text>
            </OutlinedButton>
          ) : null}
          {work && tasksEnabled && !taskAdded ? (
            <FilledTonalButton onClick={() => void addTask()}>
              <Icon source={icons.addTask} size={18} />
              <Text modifiers={[paddingAll(4)]}>Google Tasks'a ekle</Text>
            </FilledTonalButton>
          ) : null}
          {remindable && !taskAdded && !picking ? (
            <FilledTonalButton onClick={() => { setNote(null); setPicking(true); }}>
              <Icon source={icons.addTask} size={18} />
              <Text modifiers={[paddingAll(4)]}>Hatırlatıcı ekle</Text>
            </FilledTonalButton>
          ) : null}
          {url ? (
            <OutlinedButton onClick={() => openLink(url)}>
              <Icon source={icons.openInNew} size={18} />
              <Text modifiers={[paddingAll(4)]}>Canvas'ta aç</Text>
            </OutlinedButton>
          ) : mail && appConfig().webmailUrl ? (
            <OutlinedButton onClick={() => openLink(appConfig().webmailUrl)}>
              <Icon source={icons.openInNew} size={18} />
              <Text modifiers={[paddingAll(4)]}>Webmailde aç</Text>
            </OutlinedButton>
          ) : null}
        </FlowRow>
      </Column>
      {asking ? <LinkDialog target={asking} onClose={() => setAsking(null)} /> : null}
      {confirmRemove ? (
        <ConfirmDialog
          title="Google Tasks'tan çıkarılsın mı?"
          text={`"${target.title}" görev listenden silinecek. Canvas'a ve mail kutuna bir şey olmaz.`}
          confirm="Çıkar"
          onConfirm={() => void removeTask()}
          onCancel={() => setConfirmRemove(false)}
        />
      ) : null}
    </ModalBottomSheet>
  );
}

function SenderRow({ sender, when }: { sender: string; when: string | null }) {
  const colors = useMaterialColors();
  const { name, address } = splitSender(sender);
  const initial = (name.match(/\p{L}/u)?.[0] ?? '?').toLocaleUpperCase('tr');
  return (
    <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center" modifiers={[fillMaxWidth()]}>
      <Box contentAlignment="center" modifiers={[size(44, 44), clip(shapes.Cookie9Sided), background(colors.primaryContainer)]}>
        <Text color={colors.onPrimaryContainer} style={{ typography: 'titleMedium', fontWeight: '700' }}>
          {initial}
        </Text>
      </Box>
      <Column modifiers={[weight(1)]}>
        <Text color={colors.onSurface} maxLines={1} overflow="ellipsis" style={{ typography: 'titleMedium', fontWeight: '600' }}>
          {name}
        </Text>
        {address && address !== name ? (
          <Text color={colors.onSurfaceVariant} maxLines={1} overflow="ellipsis" style={{ typography: 'bodySmall' }}>
            {address}
          </Text>
        ) : null}
      </Column>
      {when ? (
        <Text color={colors.outline} style={{ typography: 'labelMedium' }}>
          {formatDate(when)}
        </Text>
      ) : null}
    </Row>
  );
}

function WorkInfo({ detail, when, work }: { detail: ItemDetail | null; when: string | null; work: boolean }) {
  const colors = useMaterialColors();
  const who = detail ? detail.course || detail.sender : '';
  return (
    <Column verticalArrangement={{ spacedBy: 4 }}>
      {who ? (
        <Text color={colors.onSurfaceVariant} style={{ typography: 'titleSmall' }}>
          {who}
        </Text>
      ) : null}
      {detail?.dueAt ? (
        <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium', fontWeight: '600' }}>
          {`Son tarih: ${formatDate(detail.dueAt)} · ${timeLeft(detail.dueAt, Date.now())}`}
        </Text>
      ) : when ? (
        <Text color={colors.outline} style={{ typography: 'labelLarge' }}>
          {formatDate(when)}
        </Text>
      ) : null}
      {work && detail ? (
        <Text color={detail.submitted ? colors.primary : colors.error} style={{ typography: 'bodyMedium', fontWeight: '600' }}>
          {(detail.submitted ? 'Teslim edildi' : 'Henüz teslim edilmedi') + (detail.grade ? ` · Not: ${detail.grade}` : '')}
        </Text>
      ) : null}
    </Column>
  );
}

function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Images stay off until asked for, and come only as the server's sandbox re-drew them. Other files are listed. */
function Attachments({ connection, files }: { connection: Connection; files: Attachment[] }) {
  const colors = useMaterialColors();
  const { width: windowWidth } = useWindowDimensions();
  const images = files.filter((f) => f.image);
  const others = files.filter((f) => !f.image);
  const [shown, setShown] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const width = windowWidth - SHEET_GUTTER * 2 - CARD_PADDING * 2;

  const show = async () => {
    setLoading(true);
    setError(null);
    const loaded: Record<string, string> = {};
    for (const file of images) {
      try {
        loaded[file.image!] = await loadMailImage(connection, file.image!);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Görsel indirilemedi.');
      }
    }
    setShown(loaded);
    setLoading(false);
  };

  return (
    <Surface color={colors.surfaceContainerLowest ?? colors.surface} shape={rounded(24)} modifiers={[fillMaxWidth()]}>
      <Column modifiers={[paddingAll(CARD_PADDING)]} verticalArrangement={{ spacedBy: 12 }}>
        <Text color={colors.onSurface} style={{ typography: 'titleSmall', fontWeight: '700' }}>
          {`Ekler · ${files.length}`}
        </Text>
        {images.length && !Object.keys(shown).length ? (
          <Surface color={colors.secondaryContainer} contentColor={colors.onSecondaryContainer} shape={rounded(18)}
            onClick={loading ? undefined : () => void show()} modifiers={[fillMaxWidth()]}>
            <Row modifiers={[paddingAll(14)]} horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
              {loading ? <LoadingIndicator modifiers={[size(24, 24)]} /> : <Icon source={icons.image} size={22} tint={colors.onSecondaryContainer} />}
              <Column modifiers={[weight(1)]}>
                <Text style={{ typography: 'titleSmall', fontWeight: '600' }}>{`Görselleri göster (${images.length})`}</Text>
                <Text color={colors.onSurfaceVariant} style={{ typography: 'bodySmall' }}>
                  Sunucuda yalıtılmış olarak yeniden çizildi, gönderenin dosyası telefona gelmez.
                </Text>
              </Column>
            </Row>
          </Surface>
        ) : null}
        {images.map((file) =>
          shown[file.image!] ? (
            <Image key={file.image!} source={{ uri: shown[file.image!] }} contentScale="fit" contentDescription={file.name}
              modifiers={[fillMaxWidth(), height(Math.round((width * file.height) / Math.max(file.width, 1))), clip(Shapes.RoundedCorner(16))]} />
          ) : null,
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
        {others.map((file, index) => (
          <Row key={index} horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
            <Icon source={icons.attachment} size={20} tint={colors.onSurfaceVariant} />
            <Text color={colors.onSurface} maxLines={1} overflow="ellipsis" modifiers={[weight(1)]} style={{ typography: 'bodyMedium' }}>
              {file.name || 'adsız dosya'}
            </Text>
            <Text color={colors.outline} style={{ typography: 'labelMedium' }}>
              {fileSize(file.size)}
            </Text>
          </Row>
        ))}
        {others.length ? (
          <Text color={colors.outline} style={{ typography: 'bodySmall' }}>
            Dosyalar güvenlik için uygulamada açılmaz. Gerekirse webmailden indir.
          </Text>
        ) : null}
      </Column>
    </Surface>
  );
}
