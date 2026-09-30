/**
 * Locale dictionaries for the session-sync client plugin. The namespace is
 * owned here and merged into the framework's LocaleNamespaceMap, so a missing
 * or extra key at any use site is a compile error.
 */
import type { LocaleDictOf } from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary keys owned by the `sessionSync.actions` namespace. */
export type SessionSyncActionsKey =
  | 'menu.export'
  | 'toast.exported'
  | 'toast.exportFailed'
  | 'shortcut.noSession'
  | 'shortcut.blank'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The session-sync export action and its feedback copy. */
    'sessionSync.actions': SessionSyncActionsKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'sessionSync.actions'

export const zh: LocaleDictOf<typeof NS> = {
  'menu.export': '导出会话',
  'toast.exported': '已导出会话树：{count} 个会话',
  'toast.exportFailed': '导出失败：{reason}',
  'shortcut.noSession': '没有正在查看的会话',
  'shortcut.blank': '空白会话还没有可导出的内容',
}

export const en: LocaleDictOf<typeof NS> = {
  'menu.export': 'Export session',
  'toast.exported': 'Exported the session tree ({count} sessions)',
  'toast.exportFailed': 'Export failed: {reason}',
  'shortcut.noSession': 'No session is open',
  'shortcut.blank': 'A blank session has nothing to export',
}
