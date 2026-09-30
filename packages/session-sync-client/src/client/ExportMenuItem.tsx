/**
 * The export action: one `sidebar.workspaces.session.menu.item` row. The slot
 * declaration (ui-workspace's browser registration) binds the menu open state
 * and the shortcut catalog, so the row renders the command's effective
 * binding beside its label — the same way the shipped rows do.
 */
import { IconDownloadOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'

/** Behavior the registration injects: submit the export and report the settled outcome. */
export interface ExportSessionInjected {
  /** Export the row's session tree; feedback arrives through the overlay toast. */
  exportSession: (sessionId: string) => void
}

/** Props of the menu row: owner share + locale seat + the entry's own injected share. */
export type ExportSessionMenuItemProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<typeof NS>
  & InjectFace<ExportSessionInjected>

/**
 * Menu row (order 500): export the row's session tree through the sync
 * service; `separatorBefore` opens the plugin group after the shipped archive
 * row (400).
 * @param props - row identity, menu open state, shortcut catalog, and the export share.
 * @returns the row.
 */
export function ExportSessionMenuItem({
  sessionId, useMenuOpenState, useShortcuts, exportSession, t,
}: ExportSessionMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sessionSync.exportSession'))
  return (
    <MenuItemButton
      separatorBefore
      shortcut={shortcut}
      icon={<IconDownloadOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        exportSession(sessionId)
      }}
    >
      {t('menu.export')}
    </MenuItemButton>
  )
}
