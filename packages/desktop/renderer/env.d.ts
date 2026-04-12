/// <reference types="vite/client" />

import type { GitLoreAPI } from '../main/preload';

declare global {
  interface Window {
    gitlore: GitLoreAPI;
  }
}

export {};
