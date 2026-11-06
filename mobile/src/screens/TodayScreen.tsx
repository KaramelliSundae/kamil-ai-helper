import {
  Column,
  FilledTonalButton,
  FilledTonalIconButton,
  Icon,
  IconButton,
  LazyColumn,
  LoadingIndicator,
  Row,
  Surface,
  Text,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxSize, fillMaxWidth, padding, paddingAll, weight } from '@expo/ui/jetpack-compose/modifiers';
import type { BuiltinShape } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useMemo, useState } from 'react';
import type { ImageSourcePropType } from 'react-native';

import { api, Connection, Exam, GpuState, ItemDetail, Upcoming } from '../api';
import { courseIcon } from '../courseIcon';
import { DetailSheet } from '../DetailSheet';
import { ConfirmDialog } from '../ConfirmDialog';
import { TodayKamil } from '../kamil';
import { guest } from '../husamettin';
import { ServerStatus } from '../ServerStatus';
import { daysUntil, examOrder, formatDate, isSoon, longDate, shortDay, timeLeft } from '../format';
import { icons } from '../icons';
import { Choices, Header, Notice, Panel, rounded, ShapeIcon, shapes, Refreshable } from '../ui';
import { UpdatePanel } from '../UpdatePanel';
import { useLoad } from '../useLoad';

const KINDS: Record<string, { icon: ImageSourcePropType; shape: BuiltinShape }> = {
  assignment: { icon: icons.assignment, shape: shapes.Cookie9Sided },
  quiz: { icon: icons.quiz, shape: shapes.Clover4Leaf },
  discussion: { icon: icons.forum, shape: shapes.Cookie6Sided },
  event: { icon: icons.event, shape: shapes.SoftBurst },
};

/** Something else has the GPU or is waiting for it, so the student may want to step in from here. */
function sharesGpu(gpu: GpuState): boolean {
  return gpu.gpuOwner === 'job' || !!gpu.keepOffSeconds || !!gpu.prioritySeconds
    || !!gpu.jobs?.some((job) => job.status === 'queued' || job.status === 'running');
}

function modelStatus(gpu: GpuState): string {
  if (gpu.llmActive) return 'Kamil hazır';
  return gpu.blocked ? `Kamil bekliyor: ${gpu.blocked}` : 'Kamil açılıyor';
}

const EXAM_STATUS = { announced: 'Duyuruldu', syllabus: 'Syllabus', estimated: 'Tahmini' } as const;

function examName(exam: Exam): string {
  return (exam.kind === 'midterm' ? 'Vize' : 'Final') + (exam.number ? ` ${exam.number}` : '');
}

function examWhen(exam: Exam): string {
  if (exam.status !== 'estimated' || !exam.endsOn) return shortDay(exam.startsOn);
  return `${exam.week}. hafta · ${shortDay(exam.startsOn, true)} – ${shortDay(exam.endsOn, true)}`;
}

function ExamRow({ exam, now, onOpen, onAddTask, onRemoveTask }: {
  exam: Exam;
  now: number;
  onOpen: () => void;
  onAddTask?: () => void;
  onRemoveTask?: () => void;
}) {
  const colors = useMaterialColors();
  const left = daysUntil(exam.startsOn, now);
  const near = exam.status !== 'estimated' && left <= 7;
  const firm = exam.status === 'announced';
  return (
    <Panel onClick={onOpen}>
      <Row horizontalArrangement={{ spacedBy: 14 }} verticalAlignment="center">
        <ShapeIcon
          icon={courseIcon(exam.course)}
          shape={exam.kind === 'final' ? shapes.Boom : shapes.Clover4Leaf}
          container={near ? colors.errorContainer : colors.secondaryContainer}
          content={near ? colors.onErrorContainer : colors.onSecondaryContainer}
        />
        <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: 2 }}>
          <Text color={colors.primary} style={{ typography: 'labelLarge', fontWeight: '600' }}>{exam.course}</Text>
          <Text color={colors.onSurface} style={{ typography: 'titleMedium', fontWeight: '600' }}>{examName(exam)}</Text>
          <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>{examWhen(exam)}</Text>
          <Row horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
            <Surface
              color={firm ? colors.tertiaryContainer : colors.surfaceContainerHighest}
              contentColor={firm ? colors.onTertiaryContainer : colors.onSurfaceVariant}
              shape={rounded(50)}>
              <Text modifiers={[padding(10, 4, 10, 4)]} style={{ typography: 'labelMedium', fontWeight: '700' }}>{EXAM_STATUS[exam.status]}</Text>
            </Surface>
            {left >= 0 ? (
              <Text color={near ? colors.error : colors.onSurfaceVariant} style={{ typography: 'labelMedium', fontWeight: '700' }}>
                {left === 0 ? 'Bugün' : left === 1 ? 'Yarın' : `${left} gün kaldı`}
              </Text>
            ) : null}
          </Row>
        </Column>
        {exam.inTasks ? (
          <IconButton enabled={!!onRemoveTask} onClick={() => onRemoveTask?.()}>
            <Icon source={icons.taskDone} size={22} tint={colors.primary} contentDescription="Google Tasks'ta, çıkarmak için dokun" />
          </IconButton>
        ) : onAddTask ? (
          <FilledTonalIconButton onClick={onAddTask}>
            <Icon source={icons.addTask} size={22} contentDescription="Google Tasks'a ekle" />
          </FilledTonalIconButton>
        ) : null}
      </Row>
    </Panel>
  );
}

function DueRow({ item, now, onOpen, onAddTask, onRemoveTask }: {
  item: Upcoming;
  now: number;
  onOpen: () => void;
  onAddTask?: () => void;
  onRemoveTask?: () => void;
}) {
  const colors = useMaterialColors();
  const soon = isSoon(item.dueAt, now);
  const kind = KINDS[item.kind] ?? KINDS.assignment;
  return (
    <Panel onClick={onOpen}>
      <Row horizontalArrangement={{ spacedBy: 14 }} verticalAlignment="center">
        <ShapeIcon
          icon={kind.icon}
          shape={kind.shape}
          container={soon ? colors.errorContainer : colors.secondaryContainer}
          content={soon ? colors.onErrorContainer : colors.onSecondaryContainer}
        />
        <Column modifiers={[weight(1)]} verticalArrangement={{ spacedBy: 2 }}>
          <Text color={colors.primary} style={{ typography: 'labelLarge', fontWeight: '600' }}>
            {item.course || 'Genel'}
          </Text>
          <Text color={colors.onSurface} maxLines={2} overflow="ellipsis" style={{ typography: 'titleMedium', fontWeight: '600' }}>
            {item.title}
          </Text>
          <Row horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
            <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>
              {formatDate(item.dueAt)}
            </Text>
            <Surface
              color={soon ? colors.error : colors.tertiaryContainer}
              contentColor={soon ? colors.onError : colors.onTertiaryContainer}
              shape={rounded(50)}>
              <Text modifiers={[padding(10, 4, 10, 4)]} style={{ typography: 'labelMedium', fontWeight: '700' }}>
                {timeLeft(item.dueAt, now)}
              </Text>
            </Surface>
          </Row>
        </Column>
        {item.inTasks ? (
          <IconButton enabled={!!onRemoveTask} onClick={() => onRemoveTask?.()}>
            <Icon source={icons.taskDone} size={22} tint={colors.primary} contentDescription="Google Tasks'ta, çıkarmak için dokun" />
          </IconButton>
        ) : onAddTask ? (
          <FilledTonalIconButton onClick={onAddTask}>
            <Icon source={icons.addTask} size={22} contentDescription="Google Tasks'a ekle" />
          </FilledTonalIconButton>
        ) : null}
      </Row>
    </Panel>
  );
}

function Summary({ upcoming, gpu, now }: { upcoming: Upcoming[]; gpu: GpuState; now: number }) {
  const colors = useMaterialColors();
  const week = upcoming.filter((item) => new Date(item.dueAt).getTime() - now < 7 * 24 * 3600 * 1000).length;
  const soon = upcoming.filter((item) => isSoon(item.dueAt, now)).length;
  return (
    <Panel color={colors.primaryContainer} radius={36}>
      <Row horizontalArrangement={{ spacedBy: 16 }} verticalAlignment="center">
        <Text color={colors.onPrimaryContainer} style={{ typography: 'displayLarge', fontWeight: '800' }}>
          {String(week)}
        </Text>
        <Column modifiers={[weight(1)]}>
          <Text color={colors.onPrimaryContainer} style={{ typography: 'titleLarge', fontWeight: '700' }}>
            {week === 0 ? 'Bu hafta teslim yok' : 'teslim bu hafta'}
          </Text>
          <Text color={colors.onPrimaryContainer} style={{ typography: 'bodyLarge' }}>
            {soon > 0 ? `${soon} tanesi 24 saat içinde` : 'Önümüzdeki 24 saat boş'}
          </Text>
        </Column>
      </Row>
      <Row horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
        <Icon source={icons.sparkle} size={16} tint={colors.onPrimaryContainer} />
        <Text color={colors.onPrimaryContainer} style={{ typography: 'labelLarge' }}>
          {modelStatus(gpu)}
        </Text>
      </Row>
    </Panel>
  );
}

export function TodayScreen({ connection, onOpenDrafts, onSolve }: {
  connection: Connection;
  onOpenDrafts: () => void;
  onSolve?: (detail: ItemDetail) => void;
}) {
  const colors = useMaterialColors();
  const load = useCallback(() => api.today(connection), [connection]);
  const { data, error, refreshing, refresh } = useLoad(load);
  const [open, setOpen] = useState<Upcoming | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [tab, setTab] = useState<'work' | 'exams'>('work');
  const [openExam, setOpenExam] = useState<Exam | null>(null);
  const [removing, setRemoving] = useState<{ key: string; title: string } | null>(null);
  const now = Date.now();
  const tasksEnabled = !!data?.tasksEnabled;

  const addTask = useCallback(
    async (item: { key: string }) => {
      setTaskError(null);
      try {
        await api.addTask(connection, item.key);
        void refresh();
      } catch (reason) {
        setTaskError(reason instanceof Error ? reason.message : "Google Tasks'a eklenemedi.");
      }
    },
    [connection, refresh],
  );

  const removeTask = async (item: { key: string }) => {
    setRemoving(null);
    setTaskError(null);
    try {
      await api.removeTask(connection, item.key);
      void refresh();
    } catch (reason) {
      setTaskError(reason instanceof Error ? reason.message : "Google Tasks'tan çıkarılamadı.");
    }
  };

  const exams = useMemo(() => examOrder(data?.exams ?? [], Date.now()), [data]);
  const missing = data?.examsMissing ?? [];
  const renderExam = useCallback(
    ({ item }: { item: Exam }) => (
      <ExamRow
        exam={item}
        now={Date.now()}
        onOpen={() => setOpenExam(item)}
        onAddTask={tasksEnabled ? () => void addTask(item) : undefined}
        onRemoveTask={tasksEnabled ? () => setRemoving({ key: item.key, title: `${item.course}: ${examName(item)}` }) : undefined}
      />
    ),
    [addTask, tasksEnabled],
  );

  const renderRow = useCallback(
    ({ item }: { item: Upcoming }) => (
      <DueRow
        item={item}
        now={Date.now()}
        onOpen={() => setOpen(item)}
        onAddTask={tasksEnabled ? () => void addTask(item) : undefined}
        onRemoveTask={tasksEnabled ? () => setRemoving(item) : undefined}
      />
    ),
    [addTask, tasksEnabled],
  );

  return (
    <Refreshable refreshing={refreshing} onRefresh={() => void refresh()}>
      <LazyColumn
        modifiers={[fillMaxSize()]}
        contentPadding={{ start: 16, end: 16, bottom: 24 }}
        verticalArrangement={{ spacedBy: 12 }}>
        <Header title="Bugün" subtitle={longDate(now)} />
        {error ? <Notice tone="error">{error}</Notice> : null}
        {taskError ? <Notice tone="error">{taskError}</Notice> : null}
        <TodayKamil connection={connection} gpu={data?.gpu} upcoming={data?.upcoming} onUpdated={refresh} guest={guest} />
        {data ? <Summary upcoming={data.upcoming} gpu={data.gpu} now={now} /> : null}
        <UpdatePanel connection={connection} onlyWhenAvailable />
        {connection.mode === 'server' && data && sharesGpu(data.gpu) ? <ServerStatus connection={connection} /> : null}
        {!data && !error ? (
          <Row modifiers={[fillMaxWidth(), paddingAll(32)]} horizontalArrangement="center">
            <LoadingIndicator />
          </Row>
        ) : null}
        {data && data.pendingDrafts > 0 ? (
          <Panel color={colors.tertiaryContainer}>
            <Text color={colors.onTertiaryContainer} style={{ typography: 'titleMedium', fontWeight: '600' }}>
              {`Onay bekleyen ${data.pendingDrafts} mail taslağı var`}
            </Text>
            <FilledTonalButton onClick={onOpenDrafts}>
              <Text>Taslaklara bak</Text>
            </FilledTonalButton>
          </Panel>
        ) : null}
        {data ? (
          <Choices
            value={tab}
            onChange={setTab}
            options={[
              { value: 'work', label: 'Ödevler', count: data.upcoming.length },
              { value: 'exams', label: 'Sınavlar', count: exams.length },
            ]}
          />
        ) : null}
        {tab === 'work' && data ? (
          <Text color={colors.onSurfaceVariant} modifiers={[paddingAll(4)]} style={{ typography: 'titleSmall', fontWeight: '600' }}>
            {data.upcoming.length ? 'Önümüzdeki 14 gün' : 'Önümüzdeki 14 günde teslim yok.'}
          </Text>
        ) : null}
        {tab === 'exams' && data && !exams.length && !missing.length ? (
          <Notice>Henüz sınav tarihi bulamadım. Duyuruları ve syllabus'ları taramaya devam ediyorum.</Notice>
        ) : null}
        {tab === 'work' ? (
          <LazyColumn.Items data={data?.upcoming ?? []} keyExtractor={(item) => item.key} estimatedItemSize={110}>
            {renderRow}
          </LazyColumn.Items>
        ) : (
          <LazyColumn.Items data={exams} keyExtractor={(exam) => exam.key} estimatedItemSize={120}>
            {renderExam}
          </LazyColumn.Items>
        )}
        {tab === 'exams' && missing.length ? (
          <Notice>
            {`Tarihi bulunamayan: ${missing.map((row) => row.course).join(', ')}. Syllabus eklenince kendim bakarım.${
              missing.some((row) => row.hint) ? ` ${[...new Set(missing.map((row) => row.hint).filter(Boolean))].join(' ')}.` : ''
            }`}
          </Notice>
        ) : null}
      </LazyColumn>
      {removing ? (
        <ConfirmDialog
          title="Google Tasks'tan çıkarılsın mı?"
          text={`"${removing.title}" görev listenden silinecek. Canvas'a bir şey olmaz.`}
          confirm="Çıkar"
          onConfirm={() => void removeTask(removing)}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
      {openExam ? (
        <DetailSheet
          connection={connection}
          target={{
            key: openExam.key,
            title: `${openExam.course}: ${examName(openExam)}`,
            body: `${examWhen(openExam)}\n${EXAM_STATUS[openExam.status]}${openExam.evidence ? `\n\n${openExam.evidence}` : ''}`,
            url: openExam.url,
          }}
          onClose={() => setOpenExam(null)}
        />
      ) : null}
      {open ? (
        <DetailSheet
          connection={connection}
          target={{ key: open.key, title: open.title, url: open.url }}
          tasksEnabled={tasksEnabled}
          inTasks={open.inTasks}
          onClose={() => {
            setOpen(null);
            void refresh();
          }}
          onSolve={onSolve}
        />
      ) : null}
    </Refreshable>
  );
}
