import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let loaded
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(definition) {
        assert.equal(definition.id, '@aether/dsh-browser-live')
        loaded = definition.factory((id) => {
          if (id === 'react' || id === 'react/jsx-runtime') return {}
          throw new Error(`unexpected client dependency: ${id}`)
        })
      },
    },
  },
}

vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
assert.equal(typeof loaded?.apply, 'function')
assert.deepEqual([...loaded.inject], ['slots', 'sidebarRightTabs'])
console.log('browser-live: DSH client module loader smoke test passed')
