import { Button, Column, Icon, LoadingIndicator, Row, Surface, Text, TextButton, useMaterialColors } from '@expo/ui/jetpack-compose';
import { fillMaxWidth, paddingAll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';

import { api, CalendarOption, Connection } from './api';
import { clockTime, shortDay } from './format';
import { icons } from './icons';
import { Notice, rounded } from './ui';

/** "14 Kas Cmt, 14:00–15:30" for an event with an hour, "14 Kas Cmt" for one with only a day. */
function when(option: CalendarOption): string {
  if (option.start.length === 10) {
    return option.end && option.end !== option.start ? `${shortDay(option.start)} – ${shortDay(option.end)}` : shortDay(option.start);
  }
  const at = (iso: string) => clockTime(new Date(iso).getTime());
  const range = option.end && option.end.slice(0, 10) === option.start.slice(0, 10) ? `${at(option.start)}–${at(option.end)}` : at(option.start);
  return `${shortDay(option.start.slice(0, 10))}, ${range}`;
}

function Choice({ option, chosen, onClick }: { option: CalendarOption; chosen: boolean; onClick: () => void }) {
  const colors = useMaterialColors();
  return (
    <Surface
      color={chosen ? colors.secondaryContainer : colors.surfaceContainerHigh}
      shape={rounded(16)}
      onClick={onClick}
      modifiers={[fillMaxWidth()]}>
      <Row modifiers={[paddingAll(12)]} horizontalArrangement={{ spacedBy: 10 }} verticalAlignment="center">
        <Column modifiers={[weight(1)]}>
          <Text color={chosen ? colors.onSecondaryContainer : colors.onSurface} style={{ typography: 'bodyMedium', fontWeight: '600' }}>{option.title}</Text>
          <Text color={colors.onSurfaceVariant} style={{ typography: 'labelMedium' }}>{when(option)}</Text>
          {option.location ? <Text color={colors.onSurfaceVariant} style={{ typography: 'labelMedium' }}>{option.location}</Text> : null}
        </Column>
        {chosen ? <Icon source={icons.taskDone} size={20} tint={colors.onSecondaryContainer} /> : null}
      </Row>
    </Surface>
  );
}

/**
 * What the model finds in this mail or announcement worth a calendar entry. Nothing is added until the student taps Ekle on
 * one of them, so a mail cannot put anything in the calendar by itself.
 */
export function EventPicker({ connection, itemKey, onAdded, onCancel }: {
  connection: Connection;
  itemKey: string;
  onAdded: (status: string) => void;
  onCancel: () => void;
}) {
  const colors = useMaterialColors();
  const [options, setOptions] = useState<CalendarOption[] | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.suggestEvents(connection, itemKey).then(
      (reply) => {
        if (!live) return;
        setOptions(reply.events);
        setChosen(reply.events.length === 1 ? 0 : null);
      },
      (reason: unknown) => {
        if (!live) return;
        setOptions([]);
        setError(reason instanceof Error ? reason.message : 'Öneri alınamadı.');
      },
    );
    return () => {
      live = false;
    };
  }, [connection, itemKey]);

  const add = async () => {
    const option = chosen === null ? null : options?.[chosen];
    if (!option) return;
    setBusy(true);
    setError(null);
    try {
      onAdded((await api.addEvent(connection, itemKey, option)).status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Eklenemedi.');
      setBusy(false);
    }
  };

  if (!options) {
    return (
      <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
        <LoadingIndicator />
        <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>Kamil etkinlik arıyor…</Text>
      </Row>
    );
  }
  return (
    <Column modifiers={[fillMaxWidth()]} verticalArrangement={{ spacedBy: 8 }}>
      <Text color={colors.onSurface} style={{ typography: 'titleSmall', fontWeight: '700' }}>
        {options.length === 0 ? (error ? 'Etkinlik önerisi alınamadı' : 'Takvime eklenecek bir şey bulamadım') : options.length === 1 ? 'Bunu takvime ekleyeyim mi?' : 'Hangisini takvime ekleyeyim?'}
      </Text>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {options.map((option, index) => (
        <Choice key={`${option.title}|${option.start}`} option={option} chosen={chosen === index} onClick={() => setChosen(index)} />
      ))}
      <Row horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
        {options.length ? (
          <Button enabled={chosen !== null && !busy} onClick={() => void add()}>
            <Text>{busy ? 'Ekleniyor…' : 'Ekle'}</Text>
          </Button>
        ) : null}
        <TextButton enabled={!busy} onClick={onCancel}>
          <Text>{options.length ? 'Vazgeç' : 'Tamam'}</Text>
        </TextButton>
      </Row>
    </Column>
  );
}
