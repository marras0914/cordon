import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Binary — needs the shebang
    entry: { 'bin/cordon': 'src/bin/cordon.ts' },
    format: ['esm'],
    dts: false,
    clean: true,
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    // Public API
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
  },
]);
