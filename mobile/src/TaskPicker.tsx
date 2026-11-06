import {
  Button,
  Column,
  Icon,
  LoadingIndicator,
  OutlinedTextField,
  Row,
  Surface,
  Text,
  TextButton,
  useMaterialColors,
  useNativeState,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, paddingAll, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useEffect, useState } from 'react';

import { api, Connection, TaskOption } from './api';
import { shortDay } from './format';
import { icons } from './icons';
import { Notice, rounded } from './ui';

const OWN = 'own';

function Choice({ title, detail, chosen, onClick }: { title: string; detail?: string; chosen: boolean; onClick: () => void }) {
  const colors = useMaterialColors();
  return (
    <Surface
      color={chosen ? colors.secondaryContainer : colors.surfaceContainerHigh}
      shape={rounded(16)}
      onClick={onClick}
      modifiers={[fillMaxWidth()]}>
      <Row modifiers={[paddingAll(12)]} horizontalArrangement={{ spacedBy: 10 }} verticalAlignment="center">
        <Column modifiers={[weight(1)]}>
          <Text color={chosen ? colors.onSecondaryContainer : colors.onSurface} style={{ typography: 'bodyMedium', fontWeight: '600' }}>{title}</Text>
          {detail ? <Text color={colors.onSurfaceVariant} style={{ typography: 'labelMedium' }}>{detail}</Text> : null}
        </Column>
        {chosen ? <Icon source={icons.taskDone} size={20} tint={colors.onSecondaryContainer} /> : null}
      </Row>
    </Surface>
  );
}

/** What the model proposes for this announcement or mail, and always the student's own wording as the last choice. */
export function TaskPicker({ connection, itemKey, onAdded, onCancel }: {
  connection: Connection;
  itemKey: string;
  onAdded: (status: string) => void;
  onCancel: () => void;
}) {
  const colors = useMaterialColors();
  const ownState = useNativeState('');
  const [own, setOwn] = useState('');
  const [options, setOptions] = useState<TaskOption[] | null>(null);
  const [chosen, setChosen] = useState<number | typeof OWN | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.suggestTask(connection, itemKey).then(
      (reply) => {
        if (!live) return;
        setOptions(reply.options);
        setChosen(reply.options.length === 1 ? 0 : reply.options.length ? null : OWN);
      },
      (reason: unknown) => {
        if (!live) return;
        setOptions([]);
        setChosen(OWN);
        setError(reason instanceof Error ? reason.message : 'Öneri alınamadı.');
      },
    );
    return () => {
      live = false;
    };
  }, [connection, itemKey]);

  const add = async () => {
    const option = typeof chosen === 'number' ? options?.[chosen] : null;
    setBusy(true);
    setError(null);
    try {
      const { status } = await api.addTask(connection, itemKey, option ?? { title: own.trim() });
      onAdded(status);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Eklenemedi.');
      setBusy(false);
    }
  };

  if (!options) {
    return (
      <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
        <LoadingIndicator />
        <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>Kamil ne ekleyeceğini düşünüyor…</Text>
      </Row>
    );
  }
  const ready = chosen === OWN ? own.trim().length > 0 : chosen !== null;
  return (
    <Column modifiers={[fillMaxWidth()]} verticalArrangement={{ spacedBy: 8 }}>
      <Text color={colors.onSurface} style={{ typography: 'titleSmall', fontWeight: '700' }}>
        {options.length === 0 ? 'Ne hatırlatayım?' : options.length === 1 ? 'Bunu ekleyeyim mi?' : 'Hangisini ekleyeyim?'}
      </Text>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {options.map((option, index) => (
        <Choice
          key={option.title}
          title={option.title}
          detail={option.due ? shortDay(option.due) : undefined}
          chosen={chosen === index}
          onClick={() => setChosen(index)}
        />
      ))}
      {options.length ? <Choice title="Kendim yazayım" chosen={chosen === OWN} onClick={() => setChosen(OWN)} /> : null}
      {chosen === OWN ? (
        <OutlinedTextField value={ownState} onValueChange={setOwn} singleLine modifiers={[fillMaxWidth()]}>
          <OutlinedTextField.Label>
            <Text>Görev</Text>
          </OutlinedTextField.Label>
        </OutlinedTextField>
      ) : null}
      <Row horizontalArrangement={{ spacedBy: 8 }} verticalAlignment="center">
        <Button enabled={ready && !busy} onClick={() => void add()}>
          <Text>{busy ? 'Ekleniyor…' : 'Ekle'}</Text>
        </Button>
        <TextButton enabled={!busy} onClick={onCancel}>
          <Text>Vazgeç</Text>
        </TextButton>
      </Row>
    </Column>
  );
}
