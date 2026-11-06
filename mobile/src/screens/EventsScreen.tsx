import {
  Box,
  Button,
  Column,
  FilterChip,
  HorizontalPager,
  HorizontalPagerHandle,
  Icon,
  LazyColumn,
  LazyRow,
  LoadingIndicator,
  Row,
  SegmentedButton,
  SingleChoiceSegmentedButtonRow,
  Surface,
  Text,
  TextButton,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize, fillMaxWidth, height, onSizeChanged, paddingAll, Shapes, weight, width } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, Connection, EventItem, EventSource, ItemDetail } from '../api';
import { DetailSheet } from '../DetailSheet';
import { eventView } from '../eventView';
import { formatDate } from '../format';
import { icons } from '../icons';
import { Header, Notice, Panel, Refreshable, rounded, ShapeIcon, shapes } from '../ui';
import { useLoad } from '../useLoad';

/** An event from an older server has no list of its own, so its key decides. */
function sourceOf(event: EventItem): EventSource {
  return event.source ?? (event.itemKey.startsWith('mail:') ? 'mail' : 'canvas');
}

/** An event from an older server has no read mark. It counts as read, so nothing looks new for ever. */
function isUnread(event: EventItem): boolean {
  return event.read === false;
}

type Filter = 'all' | 'unread' | 'important' | 'announcement' | 'work' | 'exam' | 'grade' | 'message' | 'reminder';

const CANVAS_FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tümü' },
  { id: 'unread', label: 'Okunmamış' },
  { id: 'announcement', label: 'Duyuru' },
  { id: 'work', label: 'Ödev' },
  { id: 'exam', label: 'Sınav' },
  { id: 'grade', label: 'Not' },
  { id: 'message', label: 'Mesaj' },
  { id: 'reminder', label: 'Hatırlatma' },
];
const MAIL_FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Tümü' },
  { id: 'unread', label: 'Okunmamış' },
  { id: 'important', label: 'Önemli' },
];

function matches(event: EventItem, filter: Filter): boolean {
  switch (filter) {
    // Deadlines have their own page, so reminders stay out of the reading list unless asked for.
    case 'all': return event.type !== 'reminder';
    case 'unread': return isUnread(event);
    case 'important': return event.level === 'critical' || event.level === 'high';
    case 'announcement': return event.itemKey.startsWith('announcement:');
    case 'exam': return event.type === 'exam';
    case 'grade': return event.type === 'graded';
    case 'message': return event.itemKey.startsWith('message:');
    case 'reminder': return event.type === 'reminder';
    case 'work':
      return event.type !== 'reminder' && event.type !== 'graded' && event.type !== 'exam' && event.type !== 'alert'
        && !event.itemKey.startsWith('announcement:') && !event.itemKey.startsWith('message:');
  }
}

/** When it really arrived. New mail and announcements carry their own time; the watcher only saw them some minutes later. */
function arrivedAt(event: EventItem): number {
  const posted = event.type === 'new' ? event.current?.postedAt : null;
  return Date.parse(posted ?? event.createdAt) || 0;
}

function iconFor(event: EventItem) {
  if (event.type === 'exam') return icons.quiz;
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
          <Row horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
            {isUnread(item) ? <Surface color={colors.primary} shape={rounded(50)} modifiers={[height(10), width(10)]}><Box /></Surface> : null}
            <Text
              color={colors.onSurface}
              modifiers={[weight(1)]}
              style={{ typography: 'titleMedium', fontWeight: isUnread(item) ? '800' : '500' }}>
              {view.title}
            </Text>
          </Row>
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
function SwipeRow({ item, now, onOpen, onDelete, onToggleRead }: {
  item: EventItem;
  now: number;
  onOpen: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
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
          <TextButton
            modifiers={[weight(1.2)]}
            onClick={() => {
              onToggleRead();
              void pager.current?.animateScrollToPage(0);
            }}>
            <Text color={colors.onErrorContainer}>{isUnread(item) ? 'Okundu' : 'Okunmadı'}</Text>
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
  const [list, setList] = useState<EventSource>('canvas');
  const [filter, setFilter] = useState<Filter>('all');
  const [course, setCourse] = useState<string | null>(null);
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

  const setRead = useCallback(
    async (event: EventItem, read: boolean) => {
      if (isUnread(event) === !read) return;
      setActionError(null);
      setData((events) => events?.map((other) => (other.id === event.id ? { ...other, read } : other)) ?? events);
      try {
        await api.setEventRead(connection, event.id, read);
      } catch (reason) {
        setActionError(reason instanceof Error ? reason.message : 'Bildirim işaretlenemedi.');
        void refresh();
      }
    },
    [connection, refresh, setData],
  );

  const openEvent = useCallback((event: EventItem) => {
    setOpen(event);
    void setRead(event, true);
  }, [setRead]);

  const markAllRead = useCallback(async () => {
    setActionError(null);
    setData((events) => events?.map((event) => (sourceOf(event) === list ? { ...event, read: true } : event)) ?? events);
    try {
      await api.markAllRead(connection, list);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Bildirimler işaretlenemedi.');
      void refresh();
    }
  }, [connection, list, refresh, setData]);

  const renderRow = useCallback(
    ({ item }: { item: EventItem }) => (
      <SwipeRow
        item={item}
        now={now}
        onOpen={() => openEvent(item)}
        onDelete={() => void remove(item)}
        onToggleRead={() => void setRead(item, isUnread(item))}
      />
    ),
    [now, openEvent, remove, setRead],
  );

  useEffect(() => {
    if (openEventId === null || !data) return;
    const tapped = data.find((event) => event.id === openEventId);
    if (tapped) {
      setList(sourceOf(tapped));
      openEvent(tapped);
    }
    onOpened();
  }, [data, onOpened, openEvent, openEventId]);

  const shown = open ? eventView(open, now) : null;
  const unreadIn = (source: EventSource) => data?.filter((event) => sourceOf(event) === source && isUnread(event)).length ?? 0;
  const label = (name: string, source: EventSource) => (unreadIn(source) ? `${name} (${unreadIn(source)})` : name);
  const inList = useMemo(() => data?.filter((event) => sourceOf(event) === list) ?? [], [data, list]);
  const visible = useMemo(
    () => inList
      .filter((event) => matches(event, filter) && (!course || event.current?.course === course))
      .sort((a, b) => arrivedAt(b) - arrivedAt(a) || b.id - a.id),
    [course, filter, inList],
  );
  const filters = (list === 'canvas' ? CANVAS_FILTERS : MAIL_FILTERS).filter(
    (option) => option.id === 'all' || option.id === 'unread' || option.id === filter || inList.some((event) => matches(event, option.id)),
  );
  const courses = useMemo(
    () => (list === 'canvas' ? [...new Set(inList.map((event) => event.current?.course).filter((name): name is string => !!name))].sort() : []),
    [inList, list],
  );
  const switchList = (next: EventSource) => {
    setList(next);
    setFilter('all');
    setCourse(null);
  };
  return (
    <Refreshable refreshing={refreshing} onRefresh={pull}>
      {/* A new newest or another filter starts again from the top: what just arrived is what this page is for. */}
      <LazyColumn
        key={`${list}-${filter}-${course}-${visible[0]?.id ?? 0}`}
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
        <SingleChoiceSegmentedButtonRow modifiers={[fillMaxWidth()]}>
          <SegmentedButton selected={list === 'canvas'} onClick={() => switchList('canvas')}>
            <SegmentedButton.Label>
              <Text>{label('Canvas', 'canvas')}</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
          <SegmentedButton selected={list === 'mail'} onClick={() => switchList('mail')}>
            <SegmentedButton.Label>
              <Text>{label('E-posta', 'mail')}</Text>
            </SegmentedButton.Label>
          </SegmentedButton>
        </SingleChoiceSegmentedButtonRow>
        <LazyRow modifiers={[fillMaxWidth()]} horizontalArrangement={{ spacedBy: 8 }}>
          {filters.map((option) => (
            <FilterChip key={option.id} selected={filter === option.id} onClick={() => setFilter(option.id)}>
              <FilterChip.Label>
                <Text>{option.label}</Text>
              </FilterChip.Label>
            </FilterChip>
          ))}
        </LazyRow>
        {courses.length > 1 ? (
          <LazyRow modifiers={[fillMaxWidth()]} horizontalArrangement={{ spacedBy: 8 }}>
            {courses.map((name) => (
              <FilterChip key={name} selected={course === name} onClick={() => setCourse(course === name ? null : name)}>
                <FilterChip.Label>
                  <Text>{name}</Text>
                </FilterChip.Label>
              </FilterChip>
            ))}
          </LazyRow>
        ) : null}
        {unreadIn(list) ? (
          <Row modifiers={[fillMaxWidth()]} horizontalArrangement="end">
            <TextButton onClick={() => void markAllRead()}>
              <Text>Tümünü okundu say</Text>
            </TextButton>
          </Row>
        ) : null}
        {data && visible.length === 0 ? (
          <Notice>
            {filter !== 'all' || course
              ? 'Bu filtreye uyan bildirim yok.'
              : `${list === 'mail' ? 'Henüz mail bildirimi yok.' : 'Henüz Canvas bildirimi yok.'} Yeni bir şey olunca burada ve telefonunun bildirimlerinde görünecek.`}
          </Notice>
        ) : null}
        <LazyColumn.Items data={visible} keyExtractor={(item) => String(item.id)} estimatedItemSize={100}>
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
