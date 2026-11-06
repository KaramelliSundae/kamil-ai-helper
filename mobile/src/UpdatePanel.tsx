import { Button, FilledTonalButton, LoadingIndicator, Row, Text, useMaterialColors } from '@expo/ui/jetpack-compose';
import { useCallback, useEffect, useState } from 'react';

import { Connection, Release } from './api';
import { icons } from './icons';
import { Notice, Panel, ShapeIcon, shapes } from './ui';
import { findUpdate, installedVersion, installUpdate } from './update';

/** Checks for a newer app on mount. `onlyWhenAvailable` hides it until there is something to install. */
export function UpdatePanel({ connection, onlyWhenAvailable }: { connection: Connection | null; onlyWhenAvailable?: boolean }) {
  const colors = useMaterialColors();
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
    setBusy(true);
    try {
      await installUpdate(connection, release);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Güncelleme kurulamadı.');
    } finally {
      setBusy(false);
    }
  };

  if (onlyWhenAvailable && !release) return null;

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
      <Text color={release ? colors.onTertiaryContainer : colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>
        {release
          ? `Kurulu: ${installed.name} (${installed.code}). Yeni: ${release.versionName} (${release.versionCode}).`
          : `Sürüm ${installed.name} (${installed.code}).${upToDate ? ' Bu en son sürüm.' : ''}`}
      </Text>
      <Row horizontalArrangement={{ spacedBy: 12 }} verticalAlignment="center">
        {release ? (
          <Button enabled={!busy} onClick={() => void install()}>
            <Text>{busy ? 'İndiriliyor…' : 'Güncelle'}</Text>
          </Button>
        ) : (
          <FilledTonalButton enabled={!busy} onClick={() => void check()}>
            <Text>{busy ? 'Denetleniyor…' : 'Güncellemeleri denetle'}</Text>
          </FilledTonalButton>
        )}
        {busy ? <LoadingIndicator /> : null}
      </Row>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Panel>
  );
}
