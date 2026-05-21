/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Triple-slash references above pull in the type augmentations that
 * vite-plugin-pwa ships, so `import.meta.env` is typed and the
 * `virtual:pwa-register` virtual module resolves to its proper
 * `registerSW` signature.
 *
 * If you add custom VITE_* env vars, extend ImportMetaEnv here:
 *
 *   interface ImportMetaEnv {
 *     readonly VITE_FACE_API_MODELS?: string;
 *   }
 *   interface ImportMeta { readonly env: ImportMetaEnv; }
 */
interface ImportMetaEnv {
  /** Optional override for the face-api model weights base URL. */
  readonly VITE_FACE_API_MODELS?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
