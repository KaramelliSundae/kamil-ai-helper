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
import { useCallback, useState } from 'react';

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

function DraftCard({ draft, busy, sendLabel, onSend, onDiscard }: {
  draft: Draft;
  busy: boolean;
  sendLabel: string;
  onSend: () => void;
  onDiscard: () => void;
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
    </Panel>
  );
}

export function DraftsScreen({ connection }: { connection: Connection }) {
  const load = useCallback(() => api.drafts(connection), [connection]);
  const { data, error, refreshing, refresh } = useLoad(load);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Draft | null>(null);

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
        sendLabel={connection.mode === 'phone' ? 'Mailde aç' : 'Gönder'}
        onSend={() => setConfirming(item)}
        onDiscard={() => void act(() => api.discardDraft(connection, item))}
      />
    ),
    [act, busy, connection],
  );

  return (
    <Refreshable refreshing={refreshing} onRefresh={() => void refresh()}>
      <LazyColumn
        modifiers={[fillMaxSize()]}
        contentPadding={{ start: 16, end: 16, bottom: 24 }}
        verticalArrangement={{ spacedBy: 12 }}>
        <Header
          title="Onaylar"
          subtitle={connection.mode === 'phone' ? "Kamil'in taslakları mail uygulamanda açılır, göndermeyi sen yaparsın" : "Kamil'in yazdığı mailler, sen onaylamadan gitmez"}
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
            <Text>{connection.mode === 'phone' ? 'Mail uygulamasında açılsın mı?' : 'Mail gönderilsin mi?'}</Text>
          </AlertDialog.Title>
          <AlertDialog.Text>
            <Text>
              {(connection.mode === 'phone'
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
              <Text>{connection.mode === 'phone' ? 'Aç' : 'Gönder'}</Text>
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
