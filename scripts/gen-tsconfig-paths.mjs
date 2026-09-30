/**
 * Generate `tsconfig.base.json` path aliases for this project.
 *
 * The plugins in `packages/` are DeepSeek Harness plugins: they import
 * `@deepseek-ai/dsh-*` (and the vendored `@deepseek-ai/cordis`,
 * `@deepseek-ai/cosmokit`, `@deepseek-ai/schemastery`) by package name, which
 * the Harness resolves from its own workspace at runtime. For typechecking and
 * tests in this checkout, those names resolve to the sibling
 * `deepseek-harness` working tree, so both sides agree on the exact contracts
 * under development. The four packages owned here resolve to this repository's
 * own sources.
 *
 * Usage: `node scripts/gen-tsconfig-paths.mjs`
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const harness = resolve(process.env.DSH_HARNESS_ROOT ?? join(root, '..', 'deepseek-harness'))

/** Read one JSONC tsconfig, dropping full-line comments. */
function readJsonc(path) {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gmu, ''))
}

/** Package name -> source entry, for the packages this repository owns. */
const owned = {
  '@deepseek-ai/dsh-session-sync-format': './packages/session-sync-format/src',
  '@deepseek-ai/dsh-session-sync-format/types': './packages/session-sync-format/src/types.ts',
  '@deepseek-ai/dsh-session-sync': './packages/session-sync/src',
  '@deepseek-ai/dsh-session-sync/types': './packages/session-sync/src/types.ts',
  '@deepseek-ai/dsh-session-sync/backend': './packages/session-sync/src/backend.ts',
  '@deepseek-ai/dsh-session-sync/paths': './packages/session-sync/src/paths.ts',
  '@deepseek-ai/dsh-session-sync-dir': './packages/session-sync-dir/src',
  '@deepseek-ai/dsh-session-sync-web': './packages/session-sync-web/src',
}

const harnessBase = readJsonc(join(harness, 'tsconfig.base.json'))
const paths = {}

/**
 * One harness path entry (`./packages/<group>/<pkg>/src[/<file>.ts]`) resolves
 * to the declaration the harness build published for it. Typechecking against
 * built declarations keeps the harness internals out of this program and
 * mirrors what any consumer of the published packages sees.
 */
function declarationTarget(entry) {
  const normalized = entry.replace(/^\.\//u, '')
  const match = /^(.*?\/src)(?:\/(.+?))?\.?ts?$/u.exec(normalized) ?? /^(.*?\/src)$/u.exec(normalized)
  if (match === null) return undefined
  const [, sourceRoot, file] = match
  const candidate = resolve(harness, sourceRoot, '..', 'lib', 'types', file === undefined ? 'index.d.ts' : `${file}.d.ts`)
  return existsSync(candidate) ? candidate : undefined
}

for (const [name, targets] of Object.entries(harnessBase.compilerOptions.paths)) {
  if (name in owned) continue
  const resolved = targets
    .map(declarationTarget)
    .filter(target => target !== undefined)
  if (resolved.length === 0) continue
  paths[name] = resolved.map((absolute) => {
    const relativeToRoot = relative(root, absolute).split('\\').join('/')
    return relativeToRoot.startsWith('.') ? relativeToRoot : `./${relativeToRoot}`
  })
}

// The harness declares its client subpaths as one wildcard
// (`@deepseek-ai/dsh-client-star/client`), which cannot be mirrored verbatim
// here: the alias must resolve to that package's built client declarations.
// Expand the wildcard against the packages that have one, so a client plugin
// in this repository can load the slot/service contract merges by the same
// specifiers the harness programs use.
const clientPackages = join(harness, 'packages', 'client')
if (existsSync(clientPackages)) {
  for (const entry of readdirSync(clientPackages, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const declaration = join(clientPackages, entry.name, 'lib', 'types', 'client', 'index.d.ts')
    if (!existsSync(declaration)) continue
    try {
      const manifest = JSON.parse(readFileSync(join(clientPackages, entry.name, 'package.json'), 'utf8'))
      if (typeof manifest.name !== 'string') continue
      paths[`${manifest.name}/client`] = [relative(root, declaration).split('\\').join('/')]
    } catch {
      // An unreadable manifest is not an alias candidate.
    }
  }
}

/**
 * Client plugin sources are TSX with `react-jsx`, so the JSX runtime and
 * React value types must resolve. The harness workspace owns the React
 * toolchain; alias the newest `@types/react` it has installed.
 */
let reactTypes
const pnpmStore = join(harness, 'node_modules', '.pnpm')
if (existsSync(pnpmStore)) {
  const candidates = readdirSync(pnpmStore)
    .filter(name => name.startsWith('@types+react@'))
    .sort()
  const newest = candidates.at(-1)
  if (newest !== undefined) {
    const candidate = join(pnpmStore, newest, 'node_modules', '@types', 'react')
    if (existsSync(join(candidate, 'index.d.ts'))) reactTypes = candidate
  }
}
if (reactTypes !== undefined) {
  paths.react = [relative(root, join(reactTypes, 'index.d.ts')).split('\\').join('/')]
  paths['react/jsx-runtime'] = [relative(root, join(reactTypes, 'jsx-runtime.d.ts')).split('\\').join('/')]
}

for (const [name, target] of Object.entries(owned)) paths[name] = [target]

// Project references stay out of this base: the harness publishes its own
// build, and the alias map already types every import.
const { composite, incremental, declaration, declarationMap, sourceMap, ...rest } = harnessBase.compilerOptions

const base = {
  compilerOptions: {
    ...rest,
    // `paths` resolve relative to this file; no deprecated `baseUrl` needed.
    paths,
  },
}

writeFileSync(join(root, 'tsconfig.base.json'), `${JSON.stringify(base, null, 2)}\n`)
const harnessOnly = Object.keys(paths).length - Object.keys(owned).length
process.stdout.write(
  `gen-tsconfig-paths: wrote tsconfig.base.json (${harnessOnly} harness alias(es) from ${harness}, ${Object.keys(owned).length} local alias(es))\n`,
)
