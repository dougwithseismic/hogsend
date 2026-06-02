/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HOGSEND_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
