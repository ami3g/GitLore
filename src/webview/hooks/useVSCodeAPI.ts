import { useEffect } from 'react';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '../../types/index';

interface VSCodeAPI {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

// acquireVsCodeApi() must be called exactly once
let api: VSCodeAPI | undefined;

export function getVSCodeAPI(): VSCodeAPI {
  if (!api) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api = (window as any).acquireVsCodeApi() as VSCodeAPI;
  }
  return api;
}

export function useVSCodeListener(
  handler: (message: ExtensionToWebviewMessage) => void
) {
  useEffect(() => {
    const listener = (event: MessageEvent<ExtensionToWebviewMessage>) => {
      handler(event.data);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [handler]);
}
