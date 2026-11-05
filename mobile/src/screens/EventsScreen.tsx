import {
  Box,
  Button,
  Column,
  HorizontalPager,
  HorizontalPagerHandle,
  Icon,
  LazyColumn,
  LoadingIndicator,
  Row,
  Surface,
  Text,
  TextButton,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize, fillMaxWidth, height, onSizeChanged, paddingAll, Shapes, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, Connection, EventItem, ItemDetail } from '../api';
import { DetailSheet } from '../DetailSheet';
import { eventView } from '../eventView';
import { formatDate } from '../format';
import { icons } from '../icons';
import { Header, Notice, Panel, Refreshable, rounded, ShapeIcon, shapes } from '../ui';
import { useLoad } from '../useLoad';

function iconFor(event: EventItem) {
  if (event.type === 'reminder') return icons.schedule;
  if (event.type === 'graded') return icons.star;
  if (event.type === 'alert') return icons.error;
  if (event.itemKey.startsWith('mail:')) return icons.mail;
  if (event.itemKey.startsWith('announcement:')) return icons.campaign;
  return icons.assignment;
}

function EventRow({ item, now, onOpen }: { item: EventItem; now: number; onOpen: () => void }) {
  const colors = useMaterialColors();
  const view = eventView(item, now);
  // A deadline that has passed or been handed in is history: it keeps its text but stops looking alarming.
  const critical = item.level === 'critical' && !view.over;
  const high = item.level === 'high' && !view.over;
  return (
    <Panel onClick={onOpen}>
      <Row horizontalArrangement={{ spacedBy: 16 }}>
        <ShapeIcon
          icon={iconFor(item)}
          shape={critical ? shapes.Boom : high ? shapes.Cookie7Sided : Shapes.Circle}
          container={critical ? colors.error : high ? colors.primaryContainer : colors.surfaceContainerHighest}
          content={critical ? colors.onError : high ? colors.onPrimaryContainer : colors.onSurfaceVariant}
          dp={44}
        />
        <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: 4 }}>
          <Text color={colors.onSurface} style={{ typography: 'titleMedium', fontWeight: '600' }}>
            {view.title}
          </Text>
          {view.status ? (
            <Text
              color={view.urgent ? colors.error : view.over ? colors.onSurfaceVariant : colors.primary}
              style={{ typography: 'labelLarge', fontWeight: '700' }}>
              {view.status}
            </Text>
          ) : null}
          {view.body ? (
            <Text color={colors.onSurfaceVariant} maxLines={4} overflow="ellipsis" style={{ typography: 'bodyMedium' }}>
              {view.body}
            </Text>
          ) : null}
          <Text color={colors.outline} style={{ typography: 'labelMedium' }}>
            {formatDate(item.createdAt)}
          </Text>
        </Column>
      </Row>
    </Panel>
  );
}

/**
 * Sliding a row only uncovers the delete page; deleting takes a tap on Sil as well, so neither a slip of the
 * thumb nor a quick flick can lose a notification. Slide back or tap Vazgeç to leave it.
 */
function SwipeRow({ item, now, onOpen, onDelete }: {
  item: EventItem;
  now: number;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const colors = useMaterialColors();
  const pager = useRef<HorizontalPagerHandle>(null);
  const [rowHeight, setRowHeight] = useState(0);
  return (
    <HorizontalPager ref={pager} pageSpacing={12} modifiers={[fillMaxWidth()]}>
      <Box modifiers={[fillMaxWidth(), onSizeChanged((size) => setRowHeight(size.height))]}>
        <EventRow item={item} now={now} onOpen={onOpen} />
      </Box>
      <Surface
        color={colors.errorContainer}
        shape={rounded(28)}
        modifiers={rowHeight ? [fillMaxWidth(), height(rowHeight)] : [fillMaxWidth()]}>
        <Row
          modifiers={[fillMaxSize(), paddingAll(12)]}
          horizontalArrangement={{ spacedBy: 8 }}
          verticalAlignment="center">
          <TextButton modifiers={[weight(1)]} onClick={() => void pager.current?.animateScrollToPage(0)}>
            <Text color={colors.onErrorContainer}>Vazgeç</Text>
          </TextButton>
          <Button
            modifiers={[weight(1)]}
            colors={{ containerColor: colors.error, contentColor: colors.onError }}
            onClick={onDelete}>
            <Icon source={icons.delete} size={18} tint={colors.onError} />
            <Text modifiers={[paddingAll(4)]} color={colors.onError}>Sil</Text>
          </Button>
        </Row>
      </Surface>
    </HorizontalPager>
  );
}

export function EventsScreen({ connection, openEventId, onOpened, onSolve }: {
  connection: Connection;
  /** A tapped phone notification: its details open as soon as the list has it. */
  openEventId: number | null;
  onOpened: () => void;
  onSolve?: (detail: ItemDetail) => void;
}) {
  const load = useCallback(() => api.events(connection), [connection]);
  const { data, setData, error, refreshing, refresh } = useLoad(load);
  const [open, setOpen] = useState<EventItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // Counts down from the moment the list was read, and moves on with every refresh.
  const now = useMemo(() => Date.now(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const pull = useCallback(() => {
    void refresh(async () => {
      // A failed check still shows the list, with a note that it may be behind.
      const result = await api.refreshEvents(connection).catch(() => ({ refreshed: false }));
      setStale(!result.refreshed);
      return api.events(connection);
    });
  }, [connection, refresh]);

  const remove = useCallback(
    async (event: EventItem) => {
      setActionError(null);
      setData((list) => list?.filter((other) => other.id !== event.id) ?? list);
      try {
        await api.deleteEvent(connection, event.id);
      } catch (reason) {
        setActionError(reason instanceof Error ? reason.message : 'Bildirim silinemedi.');
        void refresh();
      }
    },
    [connection, refresh, setData],
  );

  const renderRow = useCallback(
    ({ item }: { item: EventItem }) => (
      <SwipeRow item={item} now={now} onOpen={() => setOpen(item)} onDelete={() => void remove(item)} />
    ),
    [now, remove],
  );

  useEffect(() => {
    if (openEventId === null || !data) return;
    const tapped = data.find((event) => event.id === openEventId);
    if (tapped) setOpen(tapped);
    onOpened();
  }, [data, onOpened, openEventId]);

  const shown = open ? eventView(open, now) : null;
  return (
    <Refreshable refreshing={refreshing} onRefresh={pull}>
      <LazyColumn
        modifiers={[fillMaxSize()]}
        contentPadding={{ start: 16, end: 16, bottom: 24 }}
        verticalArrangement={{ spacedBy: 10 }}>
        <Header title="Bildirimler" subtitle={connection.mode === 'phone' ? 'Yeni ödevler, tarih değişiklikleri, notlar ve duyurular' : 'Yeni ödevler, tarih değişiklikleri, notlar ve önemli mailler'} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {actionError ? <Notice tone="error">{actionError}</Notice> : null}
        {stale && !error ? <Notice>Şu an yeni kontrol yapılamadı, liste son kontrolün sonucunu gösteriyor.</Notice> : null}
        {!data && !error ? (
          <Row modifiers={[fillMaxWidth(), paddingAll(32)]} horizontalArrangement="center">
            <LoadingIndicator />
          </Row>
        ) : null}
        {data && data.length === 0 ? (
          <Notice>Henüz bildirim yok. Yeni bir şey olunca burada ve telefonunun bildirimlerinde görünecek.</Notice>
        ) : null}
        <LazyColumn.Items data={data ?? []} keyExtractor={(item) => String(item.id)} estimatedItemSize={100}>
          {renderRow}
        </LazyColumn.Items>
      </LazyColumn>
      {open ? (
        <DetailSheet
          connection={connection}
          target={{ key: open.itemKey, title: shown?.title ?? open.title, body: shown?.body ?? open.body, url: open.url, when: open.createdAt }}
          onClose={() => setOpen(null)}
          onSolve={onSolve}
        />
      ) : null}
    </Refreshable>
  );
}
