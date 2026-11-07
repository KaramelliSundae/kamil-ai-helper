import {
  AlertDialog,
  Button,
  Column,
  HorizontalDivider,
  Icon,
  LazyColumn,
  LoadingIndicator,
  OutlinedButton,
  Row,
  Text,
  TextButton,
  useMaterialColors,
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

function DraftCard({ draft, busy, sendLabel, onSend, onDiscard, onOpenInApp }: {
  draft: Draft;
  busy: boolean;
  sendLabel: string;
  onSend: () => void;
  onDiscard: () => void;
  /** Phone mode: send it from the mail app instead, or edit it there first. */
  onOpenInApp?: () => void;
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
    ({ item }: { item: Draft }) => (
      <DraftCard
        draft={item}
        busy={busy}
        sendLabel={canSend ? 'Gönder' : 'Mailde aç'}
        onSend={() => setConfirming(item)}
        onOpenInApp={connection.mode === 'phone' && canSend ? () => void act(() => api.openDraftInMailApp(item)) : undefined}
        onDiscard={() => void act(() => api.discardDraft(connection, item))}
      />
    ),
    [act, busy, canSend, connection],
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
                void act(() => api.sendDraft(connection, draft));
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
