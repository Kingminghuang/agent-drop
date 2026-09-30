/** Refusal, pending, conflict, and busy-session paths of the import pipeline. */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SYNC_FORMAT_VERSION,
  encodeEventObject,
  encodeTreeManifest,
  sha256Hex,
} from '@deepseek-ai/dsh-session-sync-format'
import type { SyncTreeManifest } from '@deepseek-ai/dsh-session-sync-format'
import {
  appendRootEvent,
  harness,
  homeProject,
  readPublishedManifest,
  seedChild,
  seedRoot,
  tempRoot,
  textEvent,
} from './support/composition.ts'

/** One published package laid out exactly as the medium defines it. */
interface PublishedPackage {
  /** The configured sync root. */
  readonly syncRoot: string
  /** The package tree beneath it. */
  readonly packageRoot: string
  /** The published manifest path. */
  readonly manifestPath: string
  /** Object digest -> path, for deletion or corruption in a test. */
  readonly objects: ReadonlyMap<string, string>
}

/**
 * Publish one package straight into the sync directory, byte for byte as the
 * exporter would, so a test can then withhold or corrupt individual files the
 * way a cloud client does.
 * @param syncRoot - the configured sync root.
 * @param manifest - the manifest to publish.
 * @param eventObjects - digest -> exact event-object bytes.
 * @param attachmentObjects - digest -> exact attachment bytes.
 * @returns the published layout.
 */
async function publishPackage(
  syncRoot: string,
  manifest: SyncTreeManifest,
  eventObjects: ReadonlyMap<string, Uint8Array>,
  attachmentObjects: ReadonlyMap<string, Uint8Array>,
): Promise<PublishedPackage> {
  const packageRoot = join(syncRoot, 'dsh-session-sync')
  const eventsDir = join(packageRoot, 'objects', 'events')
  const attachmentsDir = join(packageRoot, 'objects', 'attachments')
  const bucket = join(packageRoot, 'trees', manifest.rootSessionId)
  await mkdir(eventsDir, { recursive: true })
  await mkdir(attachmentsDir, { recursive: true })
  await mkdir(bucket, { recursive: true })
  const objects = new Map<string, string>()
  for (const [digest, bytes] of eventObjects) {
    const path = join(eventsDir, digest)
    await writeFile(path, bytes)
    objects.set(digest, path)
  }
  for (const [digest, bytes] of attachmentObjects) {
    const path = join(attachmentsDir, digest)
    await writeFile(path, bytes)
    objects.set(digest, path)
  }
  const { bytes, revisionHash } = encodeTreeManifest(manifest)
  const manifestPath = join(bucket, `${revisionHash}.json`)
  await writeFile(manifestPath, bytes)
  return { syncRoot, packageRoot, manifestPath, objects }
}

/** Build one single-session manifest whose cwd is the given portable encoding. */
function manifestFor(
  cwd: SyncTreeManifest['sessions'][number]['header']['cwd'],
  events: readonly ReturnType<typeof textEvent>[],
): { manifest: SyncTreeManifest, eventBytes: Uint8Array } {
  const encoded = encodeEventObject(events)
  return {
    eventBytes: encoded.bytes,
    manifest: {
      type: 'dsh-session-tree',
      formatVersion: SYNC_FORMAT_VERSION,
      rootSessionId: 'session-remote',
      sessions: [{
        sessionId: 'session-remote',
        header: { createdAt: 5000, isSeeded: false, ...(cwd === undefined ? {} : { cwd }) },
        inheritedEventCount: 0,
        events: { count: events.length, object: encoded.object },
      }],
    },
  }
}

describe('import refusals and outcomes', () => {
  it('reports pending while objects are missing, then imports once they arrive', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const device = await harness({ sessionsRoot: join(root, 'device', 'sessions'), syncRoot })
    const { manifest, eventBytes } = manifestFor({ kind: 'home-relative', components: [] }, [textEvent(0, 10, 'remote')])
    const published = await publishPackage(syncRoot, manifest, new Map([[sha256Hex(eventBytes), eventBytes]]), new Map())

    // The cloud client has not delivered the event object yet.
    const eventPath = published.objects.get(sha256Hex(eventBytes)) as string
    const withheld = await readFile(eventPath)
    await rm(eventPath)
    await device.service.importAll().done
    const pendingTree = device.service.operations().at(-1)?.result?.trees.at(0)
    expect(pendingTree?.status).toBe('pending')
    expect(pendingTree?.sessions.map(session => session.status)).toEqual(['pending'])
    await expect(device.ctx.sessionQuery.readSession(SessionId('session-remote'))).rejects.toThrow(/not found/u)

    // The object arrives; the retry completes the import without a duplicate.
    await writeFile(eventPath, withheld)
    await device.service.importAll().done
    const importedTree = device.service.operations().at(-1)?.result?.trees.at(0)
    expect(importedTree?.sessions.map(session => session.status)).toEqual(['created'])
    const snapshot = await device.ctx.sessionQuery.readSession(SessionId('session-remote'))
    expect(snapshot.events).toHaveLength(1)
    await device.service.importAll().done
    expect(device.service.operations().at(-1)?.result?.trees.at(0)?.sessions.at(0)?.status).toBe('skipped')
  })

  it('fails the whole tree when a present object fails its digest, writing nothing', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const device = await harness({ sessionsRoot: join(root, 'device', 'sessions'), syncRoot })
    const { manifest, eventBytes } = manifestFor({ kind: 'home-relative', components: [] }, [textEvent(0, 10, 'remote')])
    const digest = sha256Hex(eventBytes)
    const published = await publishPackage(syncRoot, manifest, new Map([[digest, eventBytes]]), new Map())
    // A cloud client rewrote the object with different bytes at the same name.
    await writeFile(published.objects.get(digest) as string, new TextEncoder().encode('different bytes'))

    await device.service.importAll().done
    const tree = device.service.operations().at(-1)?.result?.trees.at(0)
    expect(tree?.status).toBe('failed')
    expect(tree?.reason).toMatch(/digest/u)
    expect(tree?.sessions).toEqual([])
    await expect(device.ctx.sessionQuery.readSession(SessionId('session-remote'))).rejects.toThrow(/not found/u)
  })

  it('skips the whole tree before any local write when a portable cwd escapes home', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const device = await harness({ sessionsRoot: join(root, 'device', 'sessions'), syncRoot })
    const { manifest, eventBytes } = manifestFor({ kind: 'home-relative', components: ['..', 'elsewhere'] }, [textEvent(0, 10, 'remote')])
    const digest = sha256Hex(eventBytes)
    await publishPackage(syncRoot, manifest, new Map([[digest, eventBytes]]), new Map())

    await device.service.importAll().done
    const tree = device.service.operations().at(-1)?.result?.trees.at(0)
    expect(tree?.status).toBe('skipped')
    expect(tree?.reason).toMatch(/cannot address/u)
    expect(tree?.sessions.map(session => session.status)).toEqual(['skipped'])
    expect(tree?.createdDirectories ?? []).toEqual([])
    await expect(device.ctx.sessionQuery.readSession(SessionId('session-remote'))).rejects.toThrow(/not found/u)
  })

  it('refuses a manifest whose format version this Host does not support', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const device = await harness({ sessionsRoot: join(root, 'device', 'sessions'), syncRoot })
    const { manifest, eventBytes } = manifestFor({ kind: 'home-relative', components: [] }, [textEvent(0, 10, 'remote')])
    const digest = sha256Hex(eventBytes)
    const foreign = { ...manifest, formatVersion: 99 } as unknown as SyncTreeManifest
    await publishPackage(syncRoot, foreign, new Map([[digest, eventBytes]]), new Map())

    await device.service.importAll().done
    const tree = device.service.operations().at(-1)?.result?.trees.at(0)
    expect(tree?.status).toBe('failed')
    expect(tree?.reason).toMatch(/manifest was refused/u)
  })

  it('reports a conflict and keeps both versions when local history diverges', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const project = await homeProject('conflict')
    const device = await harness({ sessionsRoot: join(root, 'device', 'sessions'), syncRoot })
    await seedRoot(device, project)
    await device.service.exportTree('session-root').done

    // The same root session diverges locally: different bytes at the same seq.
    const handle = await device.ctx.sessionPersistence.open(SessionId('session-root'), 'write')
    await handle.close()
    await rm(join(device.sessionsRoot), { recursive: true, force: true })
    await mkdir(device.sessionsRoot, { recursive: true })
    await seedRoot(device, project)
    await appendRootEvent(device, 'local divergence')
    const before = await device.ctx.sessionQuery.readSession(SessionId('session-root'))

    await device.service.importAll().done
    const tree = device.service.operations().at(-1)?.result?.trees.at(0)
    expect(tree?.status).toBe('conflict')
    expect(tree?.sessions.map(session => [session.sessionId, session.status])).toEqual([['session-root', 'conflict']])
    // Nothing was written: the local version survives untouched.
    const after = await device.ctx.sessionQuery.readSession(SessionId('session-root'))
    expect(after.events).toHaveLength(before.events.length)
    expect(JSON.stringify(after.events)).toBe(JSON.stringify(before.events))
  })

  it('reports failed for a live session instead of forcing its write handle', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const device = await harness({ sessionsRoot: join(root, 'device', 'sessions'), syncRoot })
    const { manifest, eventBytes } = manifestFor({ kind: 'home-relative', components: [] }, [textEvent(0, 10, 'remote')])
    const digest = sha256Hex(eventBytes)
    await publishPackage(syncRoot, manifest, new Map([[digest, eventBytes]]), new Map())

    // Enter a live session with the same identity as the incoming one.
    device.ctx.sessions.create(SessionId('session-remote'), { meta: { createdAt: 5000, isSeeded: false } })
    await device.service.importAll().done
    const tree = device.service.operations().at(-1)?.result?.trees.at(0)
    expect(tree?.status).toBe('failed')
    expect(tree?.sessions.map(session => [session.sessionId, session.status])).toEqual([['session-remote', 'failed']])
    expect(tree?.sessions.at(0)?.reason).toMatch(/live|busy|held|ownership/u)
  })

  it('fails an accepted operation with the submitter abort reason instead of running it to completion', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const device = await harness({ sessionsRoot: join(root, 'device', 'sessions'), syncRoot })
    const controller = new AbortController()
    const reference = device.service.importAll({ signal: controller.signal })
    controller.abort(new Error('the operator cancelled the import'))
    await expect(reference.done).rejects.toThrow(/cancelled/u)
    const record = device.service.operations().at(-1)
    expect(record?.status).toBe('failed')
    expect(record?.error).toMatch(/cancelled/u)
    // The mutex is released: the next submission is accepted, not refused as busy.
    await device.service.scan().done
    expect(device.service.operations().at(-1)?.status).toBe('complete')
  })

  it('writes nothing while a tree is refused, and a later scan reports readiness', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const project = await homeProject('scan')
    const deviceA = await harness({ sessionsRoot: join(root, 'a', 'sessions'), syncRoot })
    await seedRoot(deviceA, project)
    await seedChild(deviceA, project)
    await deviceA.service.exportTree('session-root').done

    const deviceB = await harness({ sessionsRoot: join(root, 'b', 'sessions'), syncRoot })
    await deviceB.service.scan().done
    const scan = deviceB.service.operations().at(-1)
    expect(scan?.status).toBe('complete')
    expect(scan?.result?.trees.map(tree => tree.status)).toEqual(['ready'])
    // Scanning never writes: the importing device still has no such session.
    await expect(deviceB.ctx.sessionQuery.readSession(SessionId('session-root'))).rejects.toThrow(/not found/u)

    // Withholding one object turns the same scan into a not-ready report.
    const { path } = await readPublishedManifest(syncRoot, 'session-root')
    const manifestText = await readFile(path, 'utf8')
    const childDigest = /"session-child".*?"object":"([0-9a-f]{64})"/u.exec(manifestText)?.[1] as string
    await rm(join(syncRoot, 'dsh-session-sync', 'objects', 'events', childDigest))
    await deviceB.service.scan().done
    expect(deviceB.service.operations().at(-1)?.result?.trees.map(tree => tree.status)).toEqual(['pending'])
  })
})
