import { Column, LazyColumn, Row, Surface, Text, useMaterialColors } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, padding, paddingAll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useMemo, useState } from 'react';

import type { GradeRow, Gradebook } from '../types';
import { groupedShape, Notice } from '../ui';
import { CoursePicker } from './CoursePicker';

const when = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function stamp(iso: string | null): string {
  return iso ? when.format(new Date(iso)) : '';
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

/** "50 / 100", or "– / 100" for work with no mark, as Canvas's own table has it. */
function scoreText(row: GradeRow): string {
  if (row.status === 'excused') return 'Muaf';
  // Non-breaking spaces: "100 / 100" is never split across two lines.
  const points = row.points === null ? '' : `\u00A0/\u00A0${number(row.points)}`;
  if (row.score !== null) return `${number(row.score)}${points}`;
  // "Bekliyor" is too long to share a line with the points, so the points go under it.
  return row.waiting ? `Bekliyor\n${points.trimStart()}` : `–${points}`;
}

const STATUS = { late: 'geç', missing: 'eksik', excused: 'muaf', '': '' } as const;

const NAME = 2.7;
const DATE = 1.9;
const STATE = 1.2;
const SCORE = 2.1;

function Cell({ weightOf, children, bold, color }: { weightOf: number; children: string; bold?: boolean; color?: string }) {
  const colors = useMaterialColors();
  return (
    <Text
      color={color ?? colors.onSurface}
      modifiers={[weight(weightOf)]}
      style={{ typography: 'bodySmall', fontWeight: bold ? '700' : '400' }}>
      {children}
    </Text>
  );
}

function Head() {
  const colors = useMaterialColors();
  const cell = (weightOf: number, text: string) => (
    <Text color={colors.onSurfaceVariant} modifiers={[weight(weightOf)]} style={{ typography: 'labelSmall', fontWeight: '700' }}>{text}</Text>
  );
  return (
    <Row modifiers={[fillMaxWidth(), padding(14, 6, 14, 4)]} horizontalArrangement={{ spacedBy: 6 }}>
      {cell(NAME, 'Ad')}
      {cell(DATE, 'Son tarih')}
      {cell(DATE, 'Teslim')}
      {cell(STATE, 'Durum')}
      {cell(SCORE, 'Puan')}
    </Row>
  );
}

function Line({ row, first, last }: { row: GradeRow; first: boolean; last: boolean }) {
  const colors = useMaterialColors();
  return (
    <Surface color={colors.surfaceContainerLow} shape={groupedShape(first, last)} modifiers={[fillMaxWidth()]}>
      <Row modifiers={[fillMaxWidth(), paddingAll(14)]} horizontalArrangement={{ spacedBy: 6 }} verticalAlignment="center">
        <Column modifiers={[weight(NAME)]}>
          <Text color={colors.primary} style={{ typography: 'bodySmall', fontWeight: '700' }}>{row.name}</Text>
          {row.group ? <Text color={colors.onSurfaceVariant} style={{ typography: 'labelSmall' }}>{row.group}</Text> : null}
        </Column>
        <Cell weightOf={DATE}>{stamp(row.dueAt)}</Cell>
        <Cell weightOf={DATE}>{stamp(row.submittedAt)}</Cell>
        <Cell weightOf={STATE} color={row.status === 'missing' ? colors.error : colors.onSurfaceVariant}>{STATUS[row.status]}</Cell>
        <Cell weightOf={SCORE} bold>{scoreText(row)}</Cell>
      </Row>
    </Surface>
  );
}

/** Canvas's Grades page: one course at a time, as a table. It only shows; no row of it ever notifies. */
export function GradesView({ gradebook, error }: { gradebook: Gradebook | null; error: string | null }) {
  const colors = useMaterialColors();
  const courses = gradebook?.courses ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const course = courses.find((one) => one.name === chosen) ?? courses[0];
  const rows = useMemo(
    () => [...(course?.rows ?? [])].sort((a, b) => (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999')),
    [course],
  );
  return (
    <LazyColumn modifiers={[fillMaxWidth(), weight(1)]} contentPadding={{ start: 16, end: 16, top: 6, bottom: 24 }} verticalArrangement={{ spacedBy: 3 }}>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {courses.length > 1 ? (
        <Column modifiers={[padding(0, 0, 0, 8)]}>
          <Row horizontalArrangement="start">
            <CoursePicker courses={courses.map((one) => one.name)} course={course?.name ?? null} onChange={setChosen} all={false} />
          </Row>
        </Column>
      ) : null}
      {gradebook && courses.length === 0 ? <Notice>Henüz not tablosu yok. Canvas bir kez okununca burada görünecek.</Notice> : null}
      {course && rows.length === 0 ? <Notice>Bu derste henüz ödev yok.</Notice> : null}
      {rows.length ? <Head /> : null}
      <LazyColumn.Items data={rows.map((row, index) => ({ row, index }))} keyExtractor={(entry) => `${course?.id}-${entry.index}-${entry.row.name}`} estimatedItemSize={64}>
        {({ item }: { item: { row: GradeRow; index: number } }) => (
          <Line row={item.row} first={item.index === 0} last={item.index === rows.length - 1} />
        )}
      </LazyColumn.Items>
      {gradebook?.updatedAt ? (
        <Text color={colors.onSurfaceVariant} modifiers={[padding(6, 10, 6, 0)]} style={{ typography: 'labelSmall' }}>
          {`Son okuma: ${stamp(gradebook.updatedAt)}. Yeni bir not girilince bildirim yine eskisi gibi gelir.`}
        </Text>
      ) : null}
    </LazyColumn>
  );
}
