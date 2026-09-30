/** Sync-package format library: portable cwd, tree manifests, event and attachment objects. @module @deepseek-ai/dsh-session-sync-format */

export { SYNC_FORMAT_VERSION, SyncFormatError } from './types.ts'
export type {
  PortableCwd,
  SyncAttachmentEntry,
  SyncEventObject,
  SyncSessionEntry,
  SyncSessionHeader,
  SyncTreeFile,
  SyncTreeManifest,
} from './types.ts'
export { isPortableComponent, hostPlatform, resolvePortableCwd, canonicalHome, encodePortableCwd, isUnderHome, decodePortableCwd, isAddressablePortableCwd, validatePortableCwd, type PortableComponentPlatform } from './portable-cwd.ts'
export { requireAttachmentDigest, requireDigestPath, sha256Hex, sha256HexText } from './digest.ts'
export {
  decodeTreeManifest,
  encodeCanonicalJson,
  encodeTreeManifest,
  requireTreeRevision,
  treeBucketSegment,
  treeFileOf,
} from './manifest.ts'
export { decodeEventObject, encodeEventObject } from './events.ts'
export {
  attachmentEntries,
  attachmentObjectDigest,
  collectAttachments,
  collectEventAttachmentRefs,
} from './attachments.ts'
