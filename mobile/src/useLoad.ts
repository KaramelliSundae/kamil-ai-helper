import { useCallback, useEffect, useState } from 'react';

/** Loads on mount and on refresh, and keeps the last good data if a refresh fails. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (loader: () => Promise<T> = load) => {
    setRefreshing(true);
    try {
      setData(await loader());
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Beklenmeyen bir hata oldu.');
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { data, setData, error, refreshing, refresh };
}
