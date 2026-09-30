/**
 * Client bundle build. The shared preset lives in the harness checkout this
 * repository develops against; it emits the closure-factory `lib/client.js`
 * the client-modules plugin serves at `/plugins/<id>/client.js`, resolving
 * the `dsh.client.inject` externals through the loader module table.
 *
 * The preset hardcodes its own checkout as the repository root, so a working
 * bundle build requires this package to be reachable as a harness workspace
 * member (for example a symlink under `packages/`). The sibling-checkout
 * location below covers the standalone typecheck/edit case.
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const preset = [
  // In-workspace member: packages/<group>/<pkg> with the preset at packages/client/.
  resolve(here, '../../client/tsdown.client.ts'),
  // Sibling checkout (agent-drop's DSH_HARNESS_ROOT default).
  resolve(here, '../../../deepseek-harness/packages/client/tsdown.client.ts'),
].find(candidate => existsSync(candidate))
if (preset === undefined) throw new Error('tsdown: cannot locate the harness client preset (tsdown.client.ts)')

const { clientBundle } = await import(preset)

export default clientBundle('@deepseek-ai/dsh-session-sync-client', ['lib/index.js'])
