import type { Connection, ServerConnection } from './api';
import type { GpuState } from './types';

/** Room for a build's own touches. This one has none, so these draw nothing. */
export function ServerReport(_props: { connection: ServerConnection }) {
  return null;
}

export function TodayKamil(_props: { connection: Connection; gpu?: GpuState | null; onUpdated: () => Promise<unknown> }) {
  return null;
}

export function ChatGreeter() {
  return null;
}

export const WaitingFigure: (() => React.JSX.Element) | null = null;
