import type { CordonConfig } from './types.js';

/**
 * Type-safe config helper. Identity at runtime — exists purely for TypeScript
 * autocompletion and validation when authoring cordon.config.ts.
 */
export function defineConfig(config: CordonConfig): CordonConfig {
  return config;
}
