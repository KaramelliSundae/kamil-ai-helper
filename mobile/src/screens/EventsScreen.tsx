import {
  Column,
  LazyColumn,
  LoadingIndicator,
  Row,
  Text,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize, fillMaxWidth, paddingAll, Shapes, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useState } from 'react';

import { api, Connection, EventItem, ItemDetail } from '../api';
import { DetailSheet } from '../DetailSheet';
import { formatDate } from '../format';
import { icons } from '../icons';
import { Header, Notice, Panel, ShapeIcon, shapes, Refreshable } from '../ui';
import { useLoad } from '../useLoad';

function iconFor(event: EventItem) {
  if (event.type === 'reminder') return icons.schedule;
  if (event.type === 'graded') return icons.star;
  if (event.type === 'alert') return icons.error;
  if (event.itemKey.startsWith('mail:')) return icons.mail;
  if (event.itemKey.startsWith('announcement:')) return icons.campaign;
  return icons.assignment;
}

function EventRow({ item, onOpen }: { item: EventItem; onOpen: () => void }) {
  const colors = useMaterialColors();
  const critical = item.level === 'critical';
  const high = item.level === 'high';
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
            {item.title}
          </Text>
          {item.body ? (
            <Text color={colors.onSurfaceVariant} maxLines={4} overflow="ellipsis" style={{ typography: 'bodyMedium' }}>
              {item.body}
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

export function EventsScreen({ connection, openEventId, onOpened, onSolve }: {
  connection: Connection;
  /** A tapped phone notification: its details open as soon as the list has it. */
  openEventId: number | null;
  onOpened: () => void;
  onSolve?: (detail: ItemDetail) => void;
}) {
  const load = useCallback(() => api.events(connection), [connection]);
  const { data, error, refreshing, refresh } = useLoad(load);
  const [open, setOpen] = useState<EventItem | null>(null);
  const renderRow = useCallback(({ item }: { item: EventItem }) => <EventRow item={item} onOpen={() => setOpen(item)} />, []);

  useEffect(() => {
    if (openEventId === null || !data) return;
    const tapped = data.find((event) => event.id === openEventId);
    if (tapped) setOpen(tapped);
    onOpened();
  }, [data, onOpened, openEventId]);

  return (
    <Refreshable refreshing={refreshing} onRefresh={() => void refresh()}>
      <LazyColumn
        modifiers={[fillMaxSize()]}
        contentPadding={{ start: 16, end: 16, bottom: 24 }}
        verticalArrangement={{ spacedBy: 10 }}>
        <Header title="Bildirimler" subtitle={connection.mode === 'phone' ? 'Yeni ödevler, tarih değişiklikleri, notlar ve duyurular' : 'Yeni ödevler, tarih değişiklikleri, notlar ve önemli mailler'} />
        {error ? <Notice tone="error">{error}</Notice> : null}
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
          target={{ key: open.itemKey, title: open.title, body: open.body, url: open.url, when: open.createdAt }}
          onClose={() => setOpen(null)}
          onSolve={onSolve}
        />
      ) : null}
    </Refreshable>
  );
}
