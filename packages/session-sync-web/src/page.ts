/** The standalone session-sync page served by the host. @module @deepseek-ai/dsh-session-sync-web/page */

/**
 * One self-contained page: no client bundle, no build step, and no data
 * rendering on the host — the page polls the same-origin API. Copy is in one
 * place and identifiers stay verbatim in code.
 * @returns the complete HTML document.
 */
export function sessionSyncPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session sync</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; padding: 1.5rem; max-width: 56rem; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  p.lede { margin: 0 0 1.25rem; color: #666; }
  fieldset { border: 1px solid #bbb; border-radius: 8px; margin: 0 0 1.25rem; padding: 1rem; }
  legend { font-weight: 600; padding: 0 .4rem; }
  label { display: block; margin: .5rem 0 .25rem; font-weight: 600; }
  input[type=text] { width: 100%; box-sizing: border-box; padding: .45rem .6rem; border: 1px solid #999; border-radius: 6px; }
  button { margin: .5rem .5rem 0 0; padding: .45rem .9rem; border-radius: 6px; border: 1px solid #888; background: transparent; cursor: pointer; }
  button.primary { background: #2456d6; border-color: #2456d6; color: #fff; }
  select { padding: .4rem; min-width: 22rem; max-width: 100%; }
  table { width: 100%; border-collapse: collapse; margin-top: .5rem; }
  th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #ddd; font-size: .92rem; vertical-align: top; }
  code { font-size: .85em; }
  .status { margin-top: .75rem; white-space: pre-wrap; font-size: .9rem; color: #444; }
  .status.error { color: #b3261e; }
  .ok { color: #1b6e3a; font-weight: 600; }
  .pending { color: #8a6d00; font-weight: 600; }
  .failed, .conflict { color: #b3261e; font-weight: 600; }
  .muted { color: #777; }
</style>
</head>
<body>
<h1>Session sync</h1>
<p class="lede">Publish this device's session trees to the sync directory, or import the trees another device published. The external cloud client moves the files between devices.</p>

<fieldset>
  <legend>Configuration</legend>
  <label for="root">Sync directory (root)</label>
  <input type="text" id="root" placeholder="/path/to/cloud-replicated/folder">
  <button class="primary" id="saveConfig">Save</button>
  <div class="status" id="configStatus"></div>
</fieldset>

<fieldset>
  <legend>Export a session tree</legend>
  <label for="rootSession">Root session</label>
  <select id="rootSession"><option value="">Loading…</option></select>
  <button class="primary" id="refreshSessions">Refresh list</button>
  <button id="exportSelected">Export selected tree</button>
  <div class="status" id="sessionsStatus"></div>
</fieldset>

<fieldset>
  <legend>Receive</legend>
  <button class="primary" id="scanButton">Scan sync directory</button>
  <button id="importButton">Import arrived trees</button>
  <div class="status" id="receiveStatus"></div>
</fieldset>

<fieldset>
  <legend>Operations</legend>
  <button id="refreshOperations">Refresh</button>
  <table id="operations"><thead><tr><th>Operation</th><th>Kind</th><th>Status</th><th>Root</th><th>Detail</th></tr></thead><tbody></tbody></table>
</fieldset>

<script type="module">
const rootInput = document.getElementById('root')
const configStatus = document.getElementById('configStatus')
const sessionsStatus = document.getElementById('sessionsStatus')
const receiveStatus = document.getElementById('receiveStatus')
const rootSession = document.getElementById('rootSession')
const operationsBody = document.querySelector('#operations tbody')

function note(element, text, isError = false) {
  element.textContent = text
  element.classList.toggle('error', isError)
}

async function api(path, init) {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = null }
  if (!response.ok) {
    throw new Error(body && typeof body.message === 'string' ? body.message : response.status + ' ' + response.statusText)
  }
  return body
}

async function loadConfig() {
  try {
    const config = await api('/api/session-sync/config')
    rootInput.value = config.root ?? ''
    note(configStatus, config.rootDiagnostic
      ? 'Configured root is not usable: ' + config.rootDiagnostic
      : config.root ? 'Configured root: ' + config.root : 'No sync root is configured.')
  } catch (error) {
    note(configStatus, 'Could not read the configuration: ' + error.message, true)
  }
}

document.getElementById('saveConfig').addEventListener('click', async () => {
  const root = rootInput.value.trim()
  note(configStatus, 'Saving…')
  try {
    const config = await api('/api/session-sync/config', { method: 'POST', body: JSON.stringify({ root }) })
    rootInput.value = config.root ?? ''
    note(configStatus, config.effectiveRoot
      ? 'Saved. Effective sync root: ' + config.effectiveRoot
      : 'Saved, but the value is not usable: ' + (config.rootDiagnostic ?? 'unknown'))
  } catch (error) {
    note(configStatus, 'Save failed; the previous value is still in effect: ' + error.message, true)
  }
})

async function loadSessions() {
  note(sessionsStatus, 'Loading sessions…')
  try {
    const value = await api('/api/session-sync/sessions')
    rootSession.textContent = ''
    for (const session of value.sessions) {
      const option = document.createElement('option')
      option.value = session.sessionId
      const title = session.title ?? session.sessionId
      const flags = [session.archived ? 'archived' : null, session.live ? 'live' : session.persisted ? 'persisted' : null]
        .filter(Boolean).join(', ')
      option.textContent = title + (flags ? ' (' + flags + ')' : '')
      rootSession.append(option)
    }
    if (value.sessions.length === 0) note(sessionsStatus, 'No root sessions exist yet.')
    else note(sessionsStatus, String(value.sessions.length) + ' root session(s) available.')
  } catch (error) {
    note(sessionsStatus, 'Could not list sessions: ' + error.message, true)
  }
}

document.getElementById('refreshSessions').addEventListener('click', loadSessions)

document.getElementById('exportSelected').addEventListener('click', async () => {
  const sessionId = rootSession.value
  if (!sessionId) {
    note(sessionsStatus, 'Select a root session first.', true)
    return
  }
  note(sessionsStatus, 'Export submitted; waiting for the result…')
  try {
    const operation = await api('/api/session-sync/export', { method: 'POST', body: JSON.stringify({ sessionId }) })
    note(sessionsStatus, 'Export operation ' + operation.id + ' accepted.')
  } catch (error) {
    note(sessionsStatus, 'Export was not accepted: ' + error.message, true)
  }
})

document.getElementById('scanButton').addEventListener('click', async () => {
  note(receiveStatus, 'Scan submitted…')
  try {
    await api('/api/session-sync/scan', { method: 'POST', body: '{}' })
    note(receiveStatus, 'Scan operation accepted; see the operation table for the result.')
  } catch (error) {
    note(receiveStatus, 'Scan was not accepted: ' + error.message, true)
  }
})

document.getElementById('importButton').addEventListener('click', async () => {
  note(receiveStatus, 'Import submitted…')
  try {
    await api('/api/session-sync/import', { method: 'POST', body: '{}' })
    note(receiveStatus, 'Import operation accepted; see the operation table for the result.')
  } catch (error) {
    note(receiveStatus, 'Import was not accepted: ' + error.message, true)
  }
})

function statusClass(status) {
  return { complete: 'ok', ready: 'ok', exported: 'ok', imported: 'ok', created: 'ok', appended: 'ok',
    pending: 'pending', skipped: 'muted', conflict: 'conflict', failed: 'failed' }[status] ?? ''
}

function operationDetail(operation) {
  const trees = operation.result?.trees ?? []
  const lines = []
  for (const tree of trees) {
    lines.push(tree.rootSessionId + ': ' + tree.status + (tree.reason ? ' — ' + tree.reason : ''))
    for (const session of tree.sessions) {
      lines.push('  ' + session.sessionId + ': ' + session.status + (session.reason ? ' — ' + session.reason : ''))
    }
    for (const directory of tree.createdDirectories ?? []) {
      lines.push('  directory ' + directory.path + ': ' + (directory.empty ? 'empty' : 'has files'))
    }
  }
  return lines.join('\\n')
}

async function loadOperations() {
  try {
    const value = await api('/api/session-sync/operations')
    operationsBody.textContent = ''
    for (const operation of value.operations) {
      const row = document.createElement('tr')
      const id = document.createElement('td'); id.textContent = operation.id
      const kind = document.createElement('td'); kind.textContent = operation.kind
      const status = document.createElement('td')
      const badge = document.createElement('span'); badge.className = statusClass(operation.status)
      badge.textContent = operation.status
      status.append(badge)
      const root = document.createElement('td'); root.textContent = operation.root
      const detail = document.createElement('td')
      const text = operation.error ?? operationDetail(operation)
      if (text) { const code = document.createElement('code'); code.textContent = text; detail.append(code) }
      row.append(id, kind, status, root, detail)
      operationsBody.append(row)
    }
  } catch (error) {
    console.error('could not list operations', error)
  }
}

document.getElementById('refreshOperations').addEventListener('click', loadOperations)
setInterval(loadOperations, 2000)

void loadConfig()
void loadSessions()
void loadOperations()
</script>
</body>
</html>
`
}
