/**
 * Session-sync client plugin, browser half. Registers the "Export session"
 * action as one `sidebar.workspaces.session.menu.item` row (order 500, after
 * the shipped archive row), the matching keyboard command
 * `sessionSync.exportSession`, and one `shell.overlay` toast that announces
 * every settled export. The action submits through the same-origin
 * session-sync Web API — the channel the standalone page uses — so the Host
 * owns the medium, the mutual exclusion, and the result; this plugin only
 * raises the request and renders the outcome.
 *
 * The target slot and the overlay slot are declared by other plugins, so
 * every registration goes through `slots.inject()`: it waits for each
 * declaration, removes the contribution when the declaration folds, and
 * re-registers when it returns.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the keyboard command service's Context merge (ctx.shortcuts).
import type {} from '@deepseek-ai/dsh-client-shortcuts/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the layout SlotMap merge (`shell.overlay`).
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the workspace SlotMap merge (`sidebar.workspaces.session.menu.item`).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { exportSessionTree } from './api.ts'
import { ExportSessionMenuItem, type ExportSessionInjected } from './ExportMenuItem.tsx'
import { ExportToast, type ExportToastNotice, type ExportToastState } from './ExportToast.tsx'
import { en, NS, zh } from './locales.ts'

/**
 * Required services (cordis fiber inject). The target slot declarations are
 * not waitable services, so apply depends on them through `slots.inject()`
 * rather than on ordering.
 */
export const inject = ['slots', 'locale', 'shortcuts', 'sessions']

/**
 * Register the export action, its keyboard command, and the outcome toast.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-sync-client: dictionaries')
  const t = ctx.locale.bind(NS)

  // One outcome store behind one `shell.overlay` entry announces every export
  // this plugin settles, so the notice outlives the row menu or the keypress.
  const toast = createSnapshotStore<ExportToastState | null>(null)
  let seq = 0
  const notify = (next: ExportToastNotice): void => {
    toast.set({ ...next, seq: ++seq })
  }
  const exportSession = (sessionId: string): void => {
    void exportSessionTree(sessionId).then((outcome) => {
      notify(outcome.kind === 'exported'
        ? { kind: 'exported', count: outcome.count }
        : { kind: 'failed', reason: outcome.reason })
    })
  }
  // Order 500 places the row after the shipped Archive (400);
  // `separatorBefore` opens the plugin group.
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'session-sync-client.export',
    order: 500,
    locale: NS,
    inject: (): ExportSessionInjected => ({ exportSession }),
  }, ExportSessionMenuItem))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-sync-client.export-toast',
    locale: NS,
    inject: () => ({
      hooks: { toast },
      dismissToast: () => { toast.set(null) },
    }),
  }, ExportToast))

  // The keyboard command acts on the main session, exactly like the shipped
  // rename / fork / archive commands do. The cast goes through `unknown`:
  // two harness modules augment `Context.sessions` with different shapes
  // (core/session's store and the controller's ISessions), so which one the
  // merge favors depends on program file order.
  const sessions = ctx.get('sessions') as unknown as ISessions
  const current = () => Object.values(sessions.list.getSnapshot().byId)
    .find(row => (row.retainedBy.mainView ?? 0) > 0)
  ctx.effect(() => ctx.shortcuts.register({
    id: 'sessionSync.exportSession' as ShortcutCommandId,
    label: () => t('menu.export'),
    aliases: ['export session', 'export tree'],
    defaults: {
      'desktop:macos': { code: 'KeyE', modifiers: ['primary', 'alt'] },
      'desktop:windows': { code: 'KeyE', modifiers: ['primary', 'alt'] },
      'desktop:linux': { code: 'KeyE', modifiers: ['primary', 'alt'] },
      'web:macos': { code: 'KeyE', modifiers: ['primary', 'shift'] },
      'web:windows': { code: 'KeyE', modifiers: ['primary', 'shift'] },
    },
    regions: ['page', 'editable'],
    modals: [],
    resolve: () => {
      const target = current()
      if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
      if (target.blank) return { status: 'blocked', reason: t('shortcut.blank') }
      return { status: 'handled', run: () => { exportSession(target.id) } }
    },
  }), 'session-sync-client: sessionSync.exportSession')
}
