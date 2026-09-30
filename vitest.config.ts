import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/** Read the generated alias base, dropping full-line comments. */
function readAliasBase(): Record<string, string[]> {
  const content = readFileSync(join(root, 'tsconfig.base.json'), 'utf8').replace(/^\s*\/\/.*$/gmu, '')
  const parsed = JSON.parse(content) as { compilerOptions?: { paths?: Record<string, string[]> } }
  return parsed.compilerOptions?.paths ?? {}
}

/**
 * Runtime file for one declaration the alias base names, following the same
 * convention as the published `exports` maps: a package root loads its bundled
 * `lib/index.js`, and a subpath loads its own emitted module.
 * @param declarationTarget - absolute declaration path from the alias base.
 * @param subpath - the part of the package name after the package itself.
 * @returns the runtime module path, or `undefined` when nothing matches.
 */
function runtimeOf(declarationTarget: string, subpath: string | undefined): string | undefined {
  const source = /^(.*)\/lib\/types\/(.+?)\.d\.ts$/u.exec(declarationTarget)
  if (source === null) return undefined
  const packageRoot = source[1] as string
  const file = source[2] as string
  const candidates = subpath === undefined || subpath === ''
    // Vendor bundles ship as ESM (`.js`) or as a dual `.mjs`/`.cjs` pair.
    ? [join(packageRoot, 'lib', 'index.js'), join(packageRoot, 'lib', 'index.mjs')]
    : [join(packageRoot, 'lib', `${file}.js`), join(packageRoot, 'lib', 'types', `${file}.js`)]
  return candidates.find(candidate => existsSync(candidate))
}

/**
 * Resolve every `@deepseek-ai/*` import the way the Harness resolves it: the
 * Harness packages from the sibling checkout, and the plugins owned here from
 * this repository's sources, so a test exercises this working tree. Longest
 * prefix first, so a subpath alias wins over its bare package name.
 */
function aliases(): { find: string, replacement: string }[] {
  const entries: { find: string, replacement: string }[] = []
  for (const [name, targets] of Object.entries(readAliasBase())) {
    const target = targets[0]
    if (target === undefined) continue
    const absolute = resolve(root, target)
    if (!existsSync(absolute)) continue
    const replacement = absolute.endsWith('.d.ts')
      ? runtimeOf(absolute, name.slice('@deepseek-ai/'.length).split('/').slice(1).join('/'))
      : statSync(absolute).isDirectory() ? join(absolute, 'index.ts') : absolute
    if (replacement === undefined || !existsSync(replacement)) continue
    entries.push({ find: name, replacement })
  }
  return entries.sort((left, right) => right.find.length - left.find.length)
}

export default defineConfig({
  resolve: { alias: aliases() },
  test: {
    include: ['packages/*/tests/**/*.spec.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
