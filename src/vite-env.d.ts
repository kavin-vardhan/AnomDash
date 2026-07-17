interface ImportMetaEnv {
  readonly VITE_CONTROL_TOKEN?: string
  readonly VITE_CAPTURES_ROOT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
