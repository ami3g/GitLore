import { useEffect, useCallback } from 'react';
import type { IPCEvents } from '../../shared/ipc-types';

/** Type-safe wrapper over window.gitlore exposed by preload */
export function useGitLore() {
  return window.gitlore;
}

/** Subscribe to a main→renderer IPC event. Returns cleanup function. */
export function useIPCEvent<K extends keyof IPCEvents>(
  channel: K,
  handler: (data: IPCEvents[K]) => void,
) {
  useEffect(() => {
    const unsub = window.gitlore.on(channel, handler);
    return () => { unsub(); };
  }, [channel, handler]);
}
