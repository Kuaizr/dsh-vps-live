import { execSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const ESBUILD = 'node_modules/.bin/esbuild'
mkdirSync('lib', { recursive: true })

// Host half: ESM, deps stay external (resolved from the package's own node_modules).
execSync(
  `${ESBUILD} src/index.ts --bundle --platform=node --format=esm --target=node22 ` +
  '--external:playwright-core --external:ws --outfile=lib/index.js',
  { stdio: 'inherit' },
)

// Client half: CJS with react externals, wrapped in the DSH module-loader closure.
execSync(
  `${ESBUILD} src/client/index.tsx --bundle --platform=browser --format=cjs --target=es2022 ` +
  '--jsx=automatic --external:react --external:react/jsx-runtime --outfile=lib/client.raw.js',
  { stdio: 'inherit' },
)

const raw = readFileSync('lib/client.raw.js', 'utf8')
rmSync('lib/client.raw.js')
writeFileSync('lib/client.js', `window.__ModuleLoader__.load({
\tid: "@aether/dsh-browser-live",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
${raw}
\t\treturn module.exports;
\t}
});
`)
console.log('browser-live: built lib/index.js and lib/client.js')
