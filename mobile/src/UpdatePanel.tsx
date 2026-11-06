import {
  Button,
  FilledTonalButton,
  LinearWavyProgressIndicator,
  LoadingIndicator,
  Row,
  Text,
  TextButton,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { Connection, Release } from './api';
import { icons } from './icons';
import { Notice, Panel, ShapeIcon, shapes } from './ui';
import { cancelUpdate, findUpdate, installedVersion, installUpdate, UpdateStage, updateStage } from './update';

function stageText(stage: UpdateStage): string {
  switch (stage.kind) {
    case 'downloading': return stage.fraction === null ? 'İndiriliyor…' : `İndiriliyor… %${Math.round(stage.fraction * 100)}`;
    case 'checking': return 'Dosya kontrol ediliyor…';
    case 'installing': return 'Kurulum ekranı açıldı.';
    case 'idle': return '';
  }
}

/** Checks for a newer app on mount. `onlyWhenAvailable` hides it until there is something to install. */
export function UpdatePanel({ connection, onlyWhenAvailable }: { connection: Connection | null; onlyWhenAvailable?: boolean }) {
  const colors = useMaterialColors();
  const stage = useSyncExternalStore(updateStage.subscribe, updateStage.get);
  const [release, setRelease] = useState<Release | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upToDate, setUpToDate] = useState(false);
  const installed = installedVersion();

  const check = useCallback(async () => {
    setError(null);
    setUpToDate(false);
    setBusy(true);
    try {
      const found = await findUpdate(connection);
      setRelease(found);
      setUpToDate(!found);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Güncelleme denetlenemedi.');
    } finally {
      setBusy(false);
    }
  }, [connection]);

  useEffect(() => {
    void check();
  }, [check]);

  const install = async () => {
    if (!release) return;
    setError(null);
    try {
      await installUpdate(connection, release);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Güncelleme kurulamadı.');
    }
  };

  if (onlyWhenAvailable && !release) return null;

  const working = stage.kind !== 'idle';
  const onColor = release ? colors.onTertiaryContainer : colors.onSurfaceVariant;
  return (
    <Panel color={release ? colors.tertiaryContainer : undefined}>
      <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
        <ShapeIcon
          icon={icons.sparkle}
          shape={shapes.Sunny}
          container={release ? colors.tertiary : colors.secondaryContainer}
          content={release ? colors.onTertiary : colors.onSecondaryContainer}
          dp={40}
        />
        <Text
          color={release ? colors.onTertiaryContainer : colors.onSurface}
          style={{ typography: 'titleLarge', fontWeight: '700' }}>
          {release ? 'Yeni sürüm hazır' : 'Uygulama'}
        </Text>
      </Row>
      <Text color={onColor} style={{ typography: 'bodyMedium' }}>
        {release
          ? `Kurulu: ${installed.name} (${installed.code}). Yeni: ${release.versionName} (${release.versionCode}).`
          : `Sürüm ${installed.name} (${installed.code}).${upToDate ? ' Bu en son sürüm.' : ''}`}
      </Text>
      {/* Above the buttons: this panel is often the last thing on the screen, and what follows it can end up out of sight. */}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {working ? (
        <>
          <Text color={onColor} style={{ typography: 'labelLarge', fontWeight: '700' }}>{stageText(stage)}</Text>
          {stage.kind === 'downloading' ? (
            <LinearWavyProgressIndicator progress={stage.fraction} modifiers={[fillMaxWidth()]} />
          ) : null}
          {stage.kind === 'downloading' && stage.cancellable ? (
            <TextButton onClick={cancelUpdate}>
              <Text>İptal</Text>
            </TextButton>
          ) : null}
        </>
      ) : (
        <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
          {release ? (
            <Button onClick={() => void install()}>
              <Text>Güncelle</Text>
            </Button>
          ) : (
            <FilledTonalButton enabled={!busy} onClick={() => void check()}>
              <Text>{busy ? 'Denetleniyor…' : 'Güncellemeleri denetle'}</Text>
            </FilledTonalButton>
          )}
          {busy ? <LoadingIndicator /> : null}
        </Row>
      )}
    </Panel>
  );
}
