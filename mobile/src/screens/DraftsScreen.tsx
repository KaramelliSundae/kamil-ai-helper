import {
  AlertDialog,
  Button,
  Column,
  HorizontalDivider,
  Icon,
  LazyColumn,
  LoadingIndicator,
  OutlinedButton,
  OutlinedTextField,
  Row,
  Text,
  TextButton,
  useMaterialColors,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize, fillMaxWidth, paddingAll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useState } from 'react';

import { api, Connection, Draft } from '../api';
import { icons } from '../icons';
import { Header, Notice, Panel, ShapeIcon, shapes, Refreshable } from '../ui';
import { useLoad } from '../useLoad';

function Field({ label, value }: { label: string; value: string }) {
  const colors = useMaterialColors();
  return (
    <Column verticalArrangement={{ spacedBy: 2 }}>
      <Text color={colors.onSurfaceVariant} style={{ typography: 'labelMedium' }}>
        {label}
      </Text>
      <Text color={colors.onSurface} style={{ typography: 'titleMedium', fontWeight: '600' }}>
        {value}
      </Text>
    </Column>
  );
}

/** The student's own edit, phone mode only: a server sends exactly what it stored and checks that by hash. */
function DraftEditor({ draft, busy, onSave, onCancel }: {
  draft: Draft;
  busy: boolean;
  onSave: (change: { to: string; subject: string; body: string }) => void;
  onCancel: () => void;
}) {
  const toState = useNativeState(draft.to);
  const subjectState = useNativeState(draft.subject);
  const bodyState = useNativeState(draft.body);
  const [to, setTo] = useState(draft.to);
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  return (
    <Panel>
      <OutlinedTextField value={toState} onValueChange={setTo} singleLine keyboardOptions={{ keyboardType: 'email', autoCorrectEnabled: false }} modifiers={[fillMaxWidth()]}>
        <OutlinedTextField.Label><Text>Kime</Text></OutlinedTextField.Label>
      </OutlinedTextField>
      <OutlinedTextField value={subjectState} onValueChange={setSubject} singleLine modifiers={[fillMaxWidth()]}>
        <OutlinedTextField.Label><Text>Konu</Text></OutlinedTextField.Label>
      </OutlinedTextField>
      <OutlinedTextField value={bodyState} onValueChange={setBody} minLines={6} maxLines={16} keyboardOptions={{ capitalization: 'sentences' }} modifiers={[fillMaxWidth()]}>
        <OutlinedTextField.Label><Text>Metin</Text></OutlinedTextField.Label>
      </OutlinedTextField>
      <Row modifiers={[fillMaxWidth()]} horizontalArrangement={{ spacedBy: 10 }}>
        <OutlinedButton enabled={!busy} onClick={onCancel} modifiers={[weight(1)]}>
          <Text>Vazgeç</Text>
        </OutlinedButton>
        <Button enabled={!busy && !!to.trim() && !!body.trim()} onClick={() => onSave({ to, subject, body })} modifiers={[weight(1)]}>
          <Text>Kaydet</Text>
        </Button>
      </Row>
    </Panel>
  );
}

function DraftCard({ draft, busy, sendLabel, onSend, onDiscard, onOpenInApp, onEdit }: {
  draft: Draft;
  busy: boolean;
  sendLabel: string;
  onSend: () => void;
  onDiscard: () => void;
  /** Phone mode: send it from the mail app instead, or edit it there first. */
  onOpenInApp?: () => void;
  onEdit?: () => void;
}) {
  const colors = useMaterialColors();
  return (
    <Panel>
      <Row horizontalArrangement={{ spacedBy: 14 }} verticalAlignment="center">
        <ShapeIcon
          icon={icons.outgoingMail}
          shape={shapes.Cookie12Sided}
          container={colors.tertiaryContainer}
          content={colors.onTertiaryContainer}
          dp={44}
        />
        <Column modifiers={[weight(1)]}>
          <Field label="Kime" value={draft.to} />
        </Column>
      </Row>
      {/* Set by the server when the draft looks like a mail asked for it: the student decides, warned. */}
      {draft.warnings?.length ? (
        <Notice tone="error">{`Dikkat:\n${draft.warnings.map((w) => `• ${w}`).join('\n')}`}</Notice>
      ) : null}
      <Field label="Konu" value={draft.subject} />
      <HorizontalDivider color={colors.outlineVariant} />
      <Text color={colors.onSurface} style={{ typography: 'bodyLarge', lineHeight: 24 }}>
        {draft.body}
      </Text>
      <Row modifiers={[fillMaxWidth()]} horizontalArrangement={{ spacedBy: 10 }}>
        <OutlinedButton enabled={!busy} onClick={onDiscard} modifiers={[weight(1)]}>
          <Icon source={icons.delete} size={18} />
          <Text modifiers={[paddingAll(4)]}>Sil</Text>
        </OutlinedButton>
        <Button enabled={!busy} onClick={onSend} modifiers={[weight(1)]}>
          <Icon source={icons.send} size={18} />
          <Text modifiers={[paddingAll(4)]}>{sendLabel}</Text>
        </Button>
      </Row>
      {onEdit ? (
        <TextButton enabled={!busy} onClick={onEdit}>
          <Text>Düzenle</Text>
        </TextButton>
      ) : null}
      {onOpenInApp ? (
        <TextButton enabled={!busy} onClick={onOpenInApp}>
          <Text>Mail uygulamasında aç</Text>
        </TextButton>
      ) : null}
    </Panel>
  );
}

export function DraftsScreen({ connection }: { connection: Connection }) {
  const load = useCallback(() => api.drafts(connection), [connection]);
  const { data, error, refreshing, refresh } = useLoad(load);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Draft | null>(null);
  const [canSend, setCanSend] = useState(connection.mode !== 'phone');
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api.canSendMail(connection).then(setCanSend, () => setCanSend(false));
  }, [connection, data]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await action();
      } catch (reason) {
        setActionError(reason instanceof Error ? reason.message : 'İşlem yapılamadı.');
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  const renderDraft = useCallback(
    ({ item }: { item: Draft }) => editing === item.id ? (
      <DraftEditor
        draft={item}
        busy={busy}
        onCancel={() => setEditing(null)}
        onSave={(change) => {
          setEditing(null);
          void act(() => api.updateDraft(connection, item, change));
        }}
      />
    ) : (
      <DraftCard
        draft={item}
        busy={busy}
        sendLabel={canSend ? 'Gönder' : 'Mailde aç'}
        onSend={() => setConfirming(item)}
        onOpenInApp={canSend ? () => void act(() => api.openDraftInMailApp(connection, item)) : undefined}
        onEdit={() => setEditing(item.id)}
        onDiscard={() => void act(() => api.discardDraft(connection, item))}
      />
    ),
    [act, busy, canSend, connection, editing],
  );

  return (
    <Refreshable refreshing={refreshing} onRefresh={() => void refresh()}>
      <LazyColumn
        modifiers={[fillMaxSize()]}
        contentPadding={{ start: 16, end: 16, bottom: 24 }}
        verticalArrangement={{ spacedBy: 12 }}>
        <Header
          title="Onaylar"
          subtitle={!canSend ? "Kamil'in taslakları mail uygulamanda açılır, göndermeyi sen yaparsın" : "Kamil'in yazdığı mailler, sen onaylamadan gitmez"}
        />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {actionError ? <Notice tone="error">{actionError}</Notice> : null}
        {note ? <Notice>{note}</Notice> : null}
        {!data && !error ? (
          <Row modifiers={[fillMaxWidth(), paddingAll(32)]} horizontalArrangement="center">
            <LoadingIndicator />
          </Row>
        ) : null}
        {data && data.length === 0 ? <Notice>Onay bekleyen taslak yok.</Notice> : null}
        <LazyColumn.Items data={data ?? []} keyExtractor={(draft) => draft.id} estimatedItemSize={320}>
          {renderDraft}
        </LazyColumn.Items>
      </LazyColumn>
      {/* A mail cannot be taken back, so sending always asks once more and names the recipient. */}
      {confirming ? (
        <AlertDialog onDismissRequest={() => setConfirming(null)}>
          <AlertDialog.Icon>
            <Icon source={icons.send} size={24} />
          </AlertDialog.Icon>
          <AlertDialog.Title>
            <Text>{canSend ? 'Mail gönderilsin mi?' : 'Mail uygulamasında açılsın mı?'}</Text>
          </AlertDialog.Title>
          <AlertDialog.Text>
            <Text>
              {(!canSend
                ? `${confirming.to} adresine yazılmış taslak mail uygulamanda açılacak; göndermeden önce son bir kez bak.`
                : `${confirming.to} adresine okul mailinden gidecek.`) +
                (confirming.warnings?.length ? `\n\nDikkat: ${confirming.warnings.join(' ')}` : '')}
            </Text>
          </AlertDialog.Text>
          <AlertDialog.ConfirmButton>
            <TextButton
              onClick={() => {
                const draft = confirming;
                setConfirming(null);
                void act(async () => {
                  const { sentCopy } = await api.sendDraft(connection, draft);
                  setNote(sentCopy === false ? "Mail gönderildi, ama Gönderilmiş klasörüne kopya bırakılamadı. Yalnızca Kamil'de görünür." : null);
                });
              }}>
              <Text>{canSend ? 'Gönder' : 'Aç'}</Text>
            </TextButton>
          </AlertDialog.ConfirmButton>
          <AlertDialog.DismissButton>
            <TextButton onClick={() => setConfirming(null)}>
              <Text>Vazgeç</Text>
            </TextButton>
          </AlertDialog.DismissButton>
        </AlertDialog>
      ) : null}
    </Refreshable>
  );
}
