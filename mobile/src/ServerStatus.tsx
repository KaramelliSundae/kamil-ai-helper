import {
  Button,
  Column,
  OutlinedButton,
  Row,
  Text,
  useMaterialColors,
} from '@expo/ui/jetpack-compose';
import { fillMaxWidth, weight } from '@expo/ui/jetpack-compose/modifiers';
import { useCallback, useEffect, useState } from 'react';

import { api, ServerConnection } from './api';
import { ConfirmDialog } from './ConfirmDialog';
import { icons } from './icons';
import type { GpuState, ServerJob } from './types';
import { Choices, Notice, Panel, SectionTitle } from './ui';

const REFRESH_MS = 5000;
const STATUS: Record<string, string> = {
  running: 'Çalışıyor',
  queued: 'Sırada',
  done: 'Bitti',
  failed: 'Hata verdi',
  cancelled: 'İptal edildi',
  interrupted: 'Durduruldu',
};

function headline(state: GpuState): string {
  const running = state.jobs?.find((job) => job.gpu && job.status === 'running');
  if (state.server?.up) return `${state.server.name} sunucusu açık, Kamil diskte.`;
  if (running?.server) return `GPU'da sunucu açık: ${running.label || running.id}`;
  if (running) return `GPU'da hesaplama işi var: ${running.label || running.id}`;
  if (state.llmActive) return 'Kamil GPU\'da, hazır.';
  return state.blocked ?? 'Kamil diskte, ilk soruda açılır.';
}

function minutes(seconds: number): string {
  return `${Math.max(1, Math.ceil(seconds / 60))} dk`;
}

function sinceLastCheck(iso: string): string {
  const passed = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return passed < 1 ? 'az önce' : `${passed} dk önce`;
}

function Stat({ name, value }: { name: string; value: string }) {
  const colors = useMaterialColors();
  return (
    <Row modifiers={[fillMaxWidth()]} horizontalArrangement="spaceBetween">
      <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>{name}</Text>
      <Text color={colors.onSurface} style={{ typography: 'bodyMedium', fontWeight: '600' }}>{value}</Text>
    </Row>
  );
}

function JobRow({ job }: { job: ServerJob }) {
  const colors = useMaterialColors();
  return (
    <Row horizontalArrangement={{ spacedBy: 8 }}>
      <Column modifiers={[weight(1)]}>
        <Text color={colors.onSurface} maxLines={1} overflow="ellipsis" style={{ typography: 'bodyMedium', fontWeight: '600' }}>
          {job.label || job.id}
        </Text>
        <Text color={colors.onSurfaceVariant} style={{ typography: 'bodySmall' }}>
          {`${job.gpu ? 'GPU' : 'İşlemci'} · ${STATUS[job.status] ?? job.status}${job.note ? ` · ${job.note}` : ''}`}
        </Text>
      </Column>
    </Row>
  );
}

/** What the server is doing right now. Renders nothing on a server that does not share its GPU. */
export function ServerStatus({ connection, showModes = false }: { connection: ServerConnection; showModes?: boolean }) {
  const colors = useMaterialColors();
  const [state, setState] = useState<GpuState | null>(null);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirmKamil, setConfirmKamil] = useState(false);
  // Shown at once: the server's answer takes a moment, and a button that waits for it looks broken.
  const [choosing, setChoosing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await api.gpu(connection);
    setState(next);
    setLastPollAt(next.lastPollAt ?? null);
  }, [connection]);

  useEffect(() => {
    void load().catch(() => setState(null));
    const ticker = setInterval(() => void load().catch(() => undefined), REFRESH_MS);
    return () => clearInterval(ticker);
  }, [load]);

  const act = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sunucu bunu yapamadı.');
    }
  };

  if (!state) return null;
  const system = state.system;
  const jobs = state.jobs ?? [];
  const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued');
  const recent = jobs.filter((job) => !active.includes(job)).slice(-2).reverse();
  const gpuJob = active.some((job) => job.gpu && job.status === 'running');
  const server = state.server;
  const serverHolds = !!server?.up || active.some((job) => job.server && job.gpu && job.status === 'running');
  const priority = state.prioritySeconds ?? 0;
  const setPriority = (on: boolean) => act(() => api.setKamilPriority(connection, on));
  const chooseMode = async (mode: string) => {
    // Leaving Compute closes what holds the GPU, so that takes a second word.
    if (mode === 'assistant' && serverHolds) {
      setConfirmKamil(true);
      return;
    }
    setChoosing(mode);
    await act(() => api.setGpuMode(connection, mode));
    setChoosing(null);
  };

  return (
    <Panel>
      <SectionTitle icon={icons.memory} title="Sunucu durumu" />
      <Text color={colors.onSurface} style={{ typography: 'bodyLarge', fontWeight: '600' }}>{headline(state)}</Text>
      {system?.ramAvailableGib !== undefined ? (
        <Column verticalArrangement={{ spacedBy: 2 }}>
          <Stat name="Boş bellek" value={`${system.ramAvailableGib} / ${system.ramTotalGib} GB`} />
          <Stat name="GPU belleği" value={`${system.vramUsedMib} / ${system.vramTotalMib} MB`} />
          <Stat name="GPU sıcaklığı" value={`${system.gpuTempC} °C`} />
          <Stat name="İşlemci yükü" value={`${system.load} (${system.cores} çekirdek)`} />
        </Column>
      ) : null}
      {lastPollAt ? <Stat name="Son kontrol" value={sinceLastCheck(lastPollAt)} /> : null}
      {[...active, ...recent].map((job) => <JobRow key={job.id} job={job} />)}

      {priority > 0 ? (
        <>
          <Text color={colors.primary} style={{ typography: 'labelLarge', fontWeight: '700' }}>
            {`Kamil öncelikli, işler ${minutes(priority)} bekliyor`}
          </Text>
          <OutlinedButton onClick={() => void setPriority(false)}>
            <Text>Önceliği bitir</Text>
          </OutlinedButton>
        </>
      ) : state.mode !== 'compute' && !serverHolds && (active.length > 0 || !state.llmActive) ? (
        <Button onClick={() => (gpuJob ? setAsking(true) : void setPriority(true))}>
          <Text>Kamil'i öne al</Text>
        </Button>
      ) : null}

      {showModes ? (
        <>
          <Text color={colors.onSurfaceVariant} style={{ typography: 'bodyMedium' }}>
            AI-Asistan'da Kamil hazır bekler; GPU isteyen bir iş gelince yer açar, iş bitince döner. Compute'ta GPU offload işlerine kalır, sunucular sen söylemeden açılmaz, Kamil'in yerel modeli sen geri alana kadar kapalıdır.
          </Text>
          <Choices
            value={choosing ?? state.mode}
            onChange={(mode) => void chooseMode(mode)}
            options={[
              { value: 'assistant', label: 'AI-Asistan' },
              { value: 'compute', label: 'Compute' },
            ]}
          />
        </>
      ) : null}
      {error ? <Notice tone="error">{error}</Notice> : null}
      {confirmKamil ? (
        <ConfirmDialog
          title="Emin misin?"
          text={`${server?.up ? `${server.name} sunucusu` : 'GPU\'daki sunucu'} açık. AI-Asistan'a geçersen kapanır${server?.busy ? ' ve şu an çalışan işi durur' : ''}, Kamil geri döner.`}
          confirm="Kapat ve geç"
          onConfirm={() => {
            setConfirmKamil(false);
            setChoosing('assistant');
            void act(() => api.setGpuMode(connection, 'assistant')).finally(() => setChoosing(null));
          }}
          onCancel={() => setConfirmKamil(false)}
        />
      ) : null}
      {asking ? (
        <ConfirmDialog
          title="Çalışan iş durdurulsun mu?"
          text="Kamil 30 dakika öncelikli olur. GPU'daki iş durur, süre bitince baştan başlar; şimdiye kadarki ilerlemesi kaybolabilir."
          confirm="Kamil'i öne al"
          onConfirm={() => {
            setAsking(false);
            void setPriority(true);
          }}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </Panel>
  );
}
