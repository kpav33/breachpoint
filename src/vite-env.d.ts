/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Colyseus server URL, e.g. wss://game.example.com (defaults to ws://<host>:2567). */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
