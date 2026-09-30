/**
 * Transient outcome notice for session-tree exports. Every export — a row
 * menu action or the keyboard command — reports its settled outcome into one
 * store, and one `shell.overlay` entry renders it as the app-wide banner, so
 * the notice outlives the row menu that asked for it.
 */
import { IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { NS } from './locales.ts'

/** One reported export outcome, before the banner keys it with a sequence. */
export type ExportToastNotice =
  | {
    readonly kind: 'exported'
    /** Number of exported sessions, for the success banner. */
    readonly count: number
  }
  | {
    readonly kind: 'failed'
    /** Failure reason, for the failure banner. */
    readonly reason: string
  }

/** One reported export outcome; `seq` keys the banner so a re-show restarts it. */
export type ExportToastState = ExportToastNotice & {
  readonly seq: number
}

/** The observable notice store the action wiring reports into. */
export type ExportToastStore = SnapshotStore<ExportToastState | null>

/** Props of the `shell.overlay` entry: the notice hook, its dismissal, and the locale seat. */
export type ExportToastProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<typeof NS>
  & InjectFace<{
    hooks: {
      /** The notice on display, or none. */
      toast: ExportToastStore
    }
    /** Take the notice down. */
    dismissToast: () => void
  }>

/**
 * Render the current export notice: a success banner naming the session
 * count, a warning carrying the failure reason, or nothing.
 * @param props - the notice hook, its dismissal, and the locale seat.
 * @returns the banner on display, or null.
 */
export function ExportToast({ useToast, dismissToast, t }: ExportToastProps) {
  const toast = useToast(current => current)
  if (toast === null) return null
  return toast.kind === 'exported'
    ? <Toast key={`session-sync-export-${String(toast.seq)}`} text={t('toast.exported', { count: toast.count })} tone="success" onDone={dismissToast} />
    : <Toast
      key={`session-sync-export-${String(toast.seq)}`}
      text={t('toast.exportFailed', { reason: toast.reason ?? '' })}
      icon={<IconWarningOutlineRegular />}
      onDone={dismissToast}
    />
}
