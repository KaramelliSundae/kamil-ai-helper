import {
  Box,
  Button,
  Column,
  FilledTonalButton,
  FilterChip,
  HorizontalPager,
  HorizontalPagerHandle,
  Icon,
  IconButton,
  LazyColumn,
  LazyRow,
  LoadingIndicator,
  Row,
  Surface,
  Text,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize, fillMaxWidth, height, onSizeChanged, padding, paddingAll, Shapes, weight, width } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, Connection, EventItem, EventSource } from '../api';
import { ConfirmDialog } from '../ConfirmDialog';
import { courseIcon } from '../courseIcon';
import { DetailSheet } from '../DetailSheet';
import { arrivedAt, eventRow, eventView, groupByDay, ListEntry, rowTime } from '../eventView';
import { icons } from '../icons';
import { collapseThreads } from '../mailThread';
import { Choices, groupedShape, Header, Notice, Refreshable, rounded, ShapeIcon, shapes } from '../ui';
import { useLoad } from '../useLoad';
import { CoursePicker } from './CoursePicker';
import { GradesView } from './GradesView';

/** An event from an older server has no list of its own, so its key decides. */
function sourceOf(event: EventItem): EventSource {
  return event.source ?? (event.itemKey.startsWith('mail:') ? 'mail' : 'canvas');
}

/** An event from an older server has no read mark. It counts as read, so nothing looks new for ever. */
function isUnread(event: EventItem): boolean {
  return event.read === false;
}

type Filter = 'all' | 'unread' | 'important' | 'conversation' | 'files' | 'school' | 'announcement' | 'work' | 'exam' | 'grade' | 'message' | 'reminder' | 'grades';

const FILTERS: Record<EventSource, { id: Filter; label: string }[]> = {
  canvas: [
    { id: 'unread', label: 'Okunmamış' },
    { id: 'announcement', label: 'Duyuru' },
    { id: 'work', label: 'Ödev' },
    { id: 'exam', label: 'Sınav' },
    { id: 'grade', label: 'Not Girildi' },
    { id: 'message', label: 'Mesaj' },
    { id: 'reminder', label: 'Hatırlatma' },
    // Canvas's Grades page as a table, not a kind of notification: it has its own view.
    { id: 'grades', label: 'Tüm Notlar' },
  ],
  mail: [
    { id: 'unread', label: 'Okunmamış' },
    { id: 'important', label: 'Önemli' },
    { id: 'conversation', label: 'Konuşma' },
    { id: 'files', label: 'Ekli' },
    { id: 'school', label: 'Okuldan' },
  ],
};

function matches(event: EventItem, filter: Filter): boolean {
  switch (filter) {
    // Deadlines have their own page, so reminders stay out of the reading list unless asked for.
    case 'all': return event.type !== 'reminder';
    case 'unread': return isUnread(event);
    case 'important': return event.level === 'critical' || event.level === 'high';
    case 'conversation': return threadSize(event) > 1;
    case 'files': return !!event.hasFiles;
    case 'school': return !!event.fromSchool;
    case 'announcement': return event.itemKey.startsWith('announcement:');
    case 'exam': return event.type === 'exam';
    case 'grade': return event.type === 'graded';
    case 'message': return event.itemKey.startsWith('message:');
    case 'reminder': return event.type === 'reminder';
    case 'grades': return false;
    case 'work':
      return event.type !== 'reminder' && event.type !== 'graded' && event.type !== 'exam' && event.type !== 'alert'
        && !event.itemKey.startsWith('announcement:') && !event.itemKey.startsWith('message:');
  }
}

function iconFor(event: EventItem) {
  if (event.type === 'exam') return courseIcon(event.current?.course ?? event.title.split(': ')[0]);
  if (event.type === 'reminder') return icons.schedule;
  if (event.type === 'graded') return icons.star;
  if (event.type === 'alert') return icons.error;
  if (event.itemKey.startsWith('mail:')) return icons.mail;
  if (event.itemKey.startsWith('announcement:')) return icons.campaign;
  if (event.itemKey.startsWith('message:')) return icons.forum;
  return icons.assignment;
}

/** How many mails a conversation's row stands for. */
function threadSize(item: EventItem): number {
  return new Set((item.threadEvents ?? []).map((one) => one.itemKey)).size;
}

function EventCard({ item, now, shape, onOpen }: {
  item: EventItem;
  now: number;
  shape: ReturnType<typeof groupedShape>;
  onOpen: () => void;
}) {
  const colors = useMaterialColors();
  const view = eventRow(item, now);
  const unread = isUnread(item);
  // A deadline that has passed or been handed in is history: it keeps its text but stops looking alarming.
  const critical = item.level === 'critical' && !view.over;
  const high = item.level === 'high' && !view.over;
  return (
    <Surface color={unread ? colors.surfaceContainerHigh : colors.surfaceContainerLow} shape={shape} onClick={onOpen} modifiers={[fillMaxWidth()]}>
      <Row modifiers={[paddingAll(14)]} horizontalArrangement={{ spacedBy: 12 }}>
        <ShapeIcon
          icon={iconFor(item)}
          shape={critical ? shapes.Boom : high ? shapes.Cookie7Sided : Shapes.Circle}
          container={critical ? colors.error : high ? colors.primaryContainer : colors.surfaceContainerHighest}
          content={critical ? colors.onError : high ? colors.onPrimaryContainer : colors.onSurfaceVariant}
          dp={40}
        />
        <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: 2 }}>
          <Row horizontalArrangement={{ spacedBy: 6 }} verticalAlignment="center">
            {unread ? <Surface color={colors.primary} shape={rounded(50)} modifiers={[height(8), width(8)]}><Box /></Surface> : null}
            <Text color={colors.primary} maxLines={1} overflow="ellipsis" modifiers={[weight(1)]} style={{ typography: 'labelMedium', fontWeight: '700' }}>
              {view.label}
            </Text>
            <Text color={colors.onSurfaceVariant} style={{ typography: 'labelSmall' }}>{rowTime(arrivedAt(item), now)}</Text>
          </Row>
          <Text
            color={unread ? colors.onSurface : colors.onSurfaceVariant}
            maxLines={2}
            overflow="ellipsis"
            style={{ typography: 'titleSmall', fontWeight: unread ? '700' : '500' }}>
            {threadSize(item) > 1 ? `${view.headline} (${threadSize(item)})` : view.headline}
          </Text>
          {view.preview ? (
            <Text color={colors.onSurfaceVariant} maxLines={2} overflow="ellipsis" style={{ typography: 'bodySmall' }}>
              {view.preview}
            </Text>
          ) : null}
          {view.status ? (
            <Text
              color={view.urgent ? colors.error : view.over ? colors.onSurfaceVariant : colors.primary}
              style={{ typography: 'labelMedium', fontWeight: '700' }}>
              {view.status}
            </Text>
          ) : null}
        </Column>
      </Row>
    </Surface>
  );
}

/**
 * Sliding a row only uncovers its actions; deleting takes a tap on Sil as well, so neither a slip of the thumb nor a
 * quick flick can lose a notification. Slide back to leave it.
 */
function SwipeRow({ item, now, shape, onOpen, onDelete, onToggleRead }: {
  item: EventItem;
  now: number;
  shape: ReturnType<typeof groupedShape>;
  onOpen: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
}) {
  const colors = useMaterialColors();
  const pager = useRef<HorizontalPagerHandle>(null);
  const [rowHeight, setRowHeight] = useState(0);
  return (
    <HorizontalPager ref={pager} pageSpacing={8} modifiers={[fillMaxWidth()]}>
      <Box modifiers={[fillMaxWidth(), onSizeChanged((size) => setRowHeight(size.height))]}>
        <EventCard item={item} now={now} shape={shape} onOpen={onOpen} />
      </Box>
      <Surface
        color={colors.surfaceContainerHighest}
        shape={shape}
        modifiers={rowHeight ? [fillMaxWidth(), height(rowHeight)] : [fillMaxWidth()]}>
        <Row modifiers={[fillMaxSize(), paddingAll(10)]} horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
          <FilledTonalButton
            modifiers={[weight(1)]}
            onClick={() => {
              onToggleRead();
              void pager.current?.animateScrollToPage(0);
            }}>
            <Icon source={icons.doneAll} size={18} />
            <Text modifiers={[padding(6, 0, 0, 0)]}>{isUnread(item) ? 'Okundu' : 'Okunmadı'}</Text>
          </FilledTonalButton>
          <Button
            modifiers={[weight(1)]}
            colors={{ containerColor: colors.error, contentColor: colors.onError }}
            onClick={onDelete}>
            <Icon source={icons.delete} size={18} tint={colors.onError} />
            <Text modifiers={[padding(6, 0, 0, 0)]} color={colors.onError}>Sil</Text>
          </Button>
        </Row>
      </Surface>
    </HorizontalPager>
  );
}

export function EventsScreen({ connection, openEventId, onOpened, onOpenDrafts }: {
  connection: Connection;
  /** A tapped phone notification: its details open as soon as the list has it. */
  openEventId: number | null;
  onOpened: () => void;
  onOpenDrafts: () => void;
}) {
  const colors = useMaterialColors();
  const load = useCallback(() => api.events(connection), [connection]);
  const { data, setData, error, refreshing, refresh } = useLoad(load);
  const loadGrades = useCallback(() => api.grades(connection), [connection]);
  const grades = useLoad(loadGrades);
  const [open, setOpen] = useState<EventItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [list, setList] = useState<EventSource>('canvas');
  const [filter, setFilter] = useState<Filter>('all');
  const [course, setCourse] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [tasksEnabled, setTasksEnabled] = useState(false);
  // Counts down from the moment the list was read, and moves on with every refresh.
  const now = useMemo(() => Date.now(), [data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    api.chatSetup(connection).then((setup) => { if (live) setTasksEnabled(!!setup.features?.tasks); }, () => undefined);
    return () => { live = false; };
  }, [connection]);

  const pull = useCallback(() => {
    void refresh(async () => {
      // A failed check still shows the list, with a note that it may be behind.
      const result = await api.refreshEvents(connection).catch(() => ({ refreshed: false }));
      setStale(!result.refreshed);
      return api.events(connection);
    }).then(() => grades.refresh());
  }, [connection, grades, refresh]);

  const remove = useCallback(
    async (event: EventItem) => {
      setActionError(null);
      const ids = new Set((event.threadEvents ?? [event]).map((one) => one.id));
      setData((events) => events?.filter((other) => !ids.has(other.id)) ?? events);
      try {
        await Promise.all([...ids].map((id) => api.deleteEvent(connection, id)));
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
      const changing = (event.threadEvents ?? [event]).filter((one) => isUnread(one) === read);
      const ids = new Set(changing.map((one) => one.id));
      setData((events) => events?.map((other) => (ids.has(other.id) ? { ...other, read } : other)) ?? events);
      try {
        await Promise.all([...ids].map((id) => api.setEventRead(connection, id, read)));
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

  useEffect(() => {
    if (openEventId === null || !data) return;
    const tapped = collapseThreads(data, arrivedAt).find((event) => (event.threadEvents ?? [event]).some((one) => one.id === openEventId));
    if (tapped) {
      setList(sourceOf(tapped));
      setFilter('all');
      setCourse(null);
      openEvent(tapped);
    }
    onOpened();
  }, [data, onOpened, openEvent, openEventId]);

  const shown = open ? eventView(open, now) : null;
  const unreadIn = (source: EventSource) => collapseThreads(data ?? [], arrivedAt).filter((event) => sourceOf(event) === source && isUnread(event)).length ?? 0;
  const inList = useMemo(() => {
    const rows = data?.filter((event) => sourceOf(event) === list) ?? [];
    return list === 'mail' ? collapseThreads(rows, arrivedAt) : rows;
  }, [data, list]);
  const ofCourse = useMemo(() => inList.filter((event) => !course || event.current?.course === course), [course, inList]);
  const visible = useMemo(
    () => ofCourse.filter((event) => matches(event, filter)).sort((a, b) => arrivedAt(b) - arrivedAt(a) || b.id - a.id),
    [filter, ofCourse],
  );
  const entries = useMemo(() => groupByDay(visible, now), [now, visible]);
  const chips = FILTERS[list]
    .map((option) => ({ ...option, count: ofCourse.filter((event) => matches(event, option.id)).length }))
    .filter((option) => option.count > 0 || option.id === filter || option.id === 'grades');
  const courses = useMemo(
    () => (list === 'canvas'
      ? [...new Set([...inList.map((event) => event.current?.course), ...(grades.data?.courses.map((one) => one.name) ?? [])].filter((name): name is string => !!name))].sort()
      : []),
    [grades.data, inList, list],
  );
  const inGrades = list === 'canvas' && filter === 'grades';
  // Reminders stay out of this: the list does not show them unless asked, and nothing should go that was not on screen.
  const readOnes = inList.filter((event) => event.read === true && event.type !== 'reminder');

  const clearRead = async () => {
    setClearing(false);
    setActionError(null);
    const doomed = new Set(readOnes.map((event) => event.id));
    setData((events) => events?.filter((event) => !doomed.has(event.id)) ?? events);
    try {
      for (const id of doomed) await api.deleteEvent(connection, id);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : 'Bildirimler silinemedi.');
      void refresh();
    }
  };

  const switchList = (next: EventSource) => {
    setList(next);
    setFilter('all');
    setCourse(null);
  };

  const renderEntry = useCallback(
    ({ item }: { item: ListEntry }) => (item.kind === 'head' ? (
      <Text
        color={colors.onSurfaceVariant}
        modifiers={[padding(6, item.key === entries[0]?.key ? 0 : 12, 0, 4)]}
        style={{ typography: 'labelLarge', fontWeight: '700' }}>
        {item.label}
      </Text>
    ) : (
      <SwipeRow
        item={item.event}
        now={now}
        shape={groupedShape(item.first, item.last)}
        onOpen={() => openEvent(item.event)}
        onDelete={() => void remove(item.event)}
        onToggleRead={() => void setRead(item.event, isUnread(item.event))}
      />
    )),
    [colors, entries, now, openEvent, remove, setRead],
  );

  return (
    <Refreshable refreshing={refreshing} onRefresh={pull}>
      <Column modifiers={[fillMaxSize()]}>
        {/* Fixed above the list: always in reach, and not re-created when the list below it starts again from the top. */}
        <Column modifiers={[fillMaxWidth(), padding(16, 0, 16, 10)]} verticalArrangement={{ spacedBy: 10 }}>
          <Header
            title="Bildirimler"
            actions={inGrades ? null : (
              <>
                {unreadIn(list) ? (
                  <IconButton onClick={() => void markAllRead()}>
                    <Icon source={icons.doneAll} size={24} tint={colors.onSurfaceVariant} contentDescription="Tümünü okundu say" />
                  </IconButton>
                ) : null}
                {readOnes.length ? (
                  <IconButton onClick={() => setClearing(true)}>
                    <Icon source={icons.deleteAll} size={24} tint={colors.onSurfaceVariant} contentDescription="Okunmuşları sil" />
                  </IconButton>
                ) : null}
              </>
            )}
          />
          <Choices
            value={list}
            onChange={switchList}
            options={[
              { value: 'canvas', label: 'Canvas', count: unreadIn('canvas') },
              { value: 'mail', label: 'E-posta', count: unreadIn('mail') },
            ]}
          />
        </Column>
        <LazyRow modifiers={[fillMaxWidth()]} contentPadding={{ start: 16, end: 16 }} horizontalArrangement={{ spacedBy: 8 }}>
          {courses.length > 1 && !inGrades ? <CoursePicker courses={courses} course={course} onChange={setCourse} /> : null}
          <FilterChip key="all" selected={filter === 'all'} onClick={() => setFilter('all')}>
            <FilterChip.Label>
              <Text>{`Tümü ${ofCourse.filter((event) => matches(event, 'all')).length}`}</Text>
            </FilterChip.Label>
          </FilterChip>
          {chips.map((option) => (
            <FilterChip key={option.id} selected={filter === option.id} onClick={() => setFilter(filter === option.id ? 'all' : option.id)}>
              <FilterChip.Label>
                <Text>{option.id === 'grades' ? option.label : `${option.label} ${option.count}`}</Text>
              </FilterChip.Label>
            </FilterChip>
          ))}
        </LazyRow>
        {inGrades ? (
          <GradesView gradebook={grades.data} known={courses} error={grades.error} />
        ) : (
        <LazyColumn
          key={`${list}-${filter}-${course}-${visible[0]?.id ?? 0}`}
          modifiers={[fillMaxWidth(), weight(1)]}
          contentPadding={{ start: 16, end: 16, top: 6, bottom: 24 }}
          verticalArrangement={{ spacedBy: 3 }}>
          {error ? <Notice tone="error">{error}</Notice> : null}
          {actionError ? <Notice tone="error">{actionError}</Notice> : null}
          {stale && !error ? <Notice>Şu an yeni kontrol yapılamadı, liste son kontrolün sonucunu gösteriyor.</Notice> : null}
          {!data && !error ? (
            <Row modifiers={[fillMaxWidth(), paddingAll(32)]} horizontalArrangement="center">
              <LoadingIndicator />
            </Row>
          ) : null}
          {data && visible.length === 0 ? (
            <Notice>
              {filter !== 'all' || course
                ? 'Bu filtreye uyan bildirim yok.'
                : `${list === 'mail' ? 'Henüz mail bildirimi yok.' : 'Henüz Canvas bildirimi yok.'} Yeni bir şey olunca burada ve telefonunun bildirimlerinde görünecek.`}
            </Notice>
          ) : null}
          <LazyColumn.Items data={entries} keyExtractor={(entry) => entry.key} estimatedItemSize={92}>
            {renderEntry}
          </LazyColumn.Items>
        </LazyColumn>
        )}
      </Column>
      {clearing ? (
        <ConfirmDialog
          title="Okunmuşlar silinsin mi?"
          text={`${list === 'mail' ? 'E-posta' : 'Canvas'} listesindeki okunmuş ${readOnes.length} bildirim silinecek. Canvas'a ve mail kutuna bir şey olmaz.`}
          confirm="Sil"
          onConfirm={() => void clearRead()}
          onCancel={() => setClearing(false)}
        />
      ) : null}
      {open ? (
        <DetailSheet
          connection={connection}
          target={{ earlier: (open.threadEvents ?? []).map((one) => one.itemKey).filter((key, index, keys) => key !== open.itemKey && keys.indexOf(key) === index), key: open.itemKey, title: shown?.title ?? open.title, body: shown?.body ?? open.body, url: open.url, when: open.createdAt }}
          tasksEnabled={tasksEnabled}
          onClose={() => setOpen(null)}
          onOpenDrafts={onOpenDrafts}
          onChanged={() => void refresh()}
        />
      ) : null}
    </Refreshable>
  );
}
