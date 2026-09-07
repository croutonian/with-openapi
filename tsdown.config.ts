import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  // Emit `dist/index.js` / `dist/index.d.ts` rather than `.mjs` / `.d.mts`, to
  // match the `exports` block in package.json. `"type": "module"` already
  // marks the package as ESM, so a plain `.js` extension is unambiguous.
  fixedExtension: false,
})
