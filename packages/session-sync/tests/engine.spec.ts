/** End-to-end export/import round trip over one cloud-replicated directory. */

import { readdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  IMAGE_REF,
  appendRootEvent,
  harness,
  homeProject,
  seedChild,
  seedRoot,
  tempRoot,
} from './support/composition.ts'

describe('session synchronization engine', () => {
  it('exports a tree with a fork child and attachments, imports it on a fresh device, and repeats idempotently', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    // A portable cwd must live under the current user's home on the exporting device.
    const project = await homeProject('roundtrip')

    const deviceA = await harness({ sessionsRoot: join(root, 'a', 'sessions'), syncRoot })
    await seedRoot(deviceA, project)
    await seedChild(deviceA, project)

    await deviceA.service.exportTree('session-root').done
    expect(deviceA.service.operations().at(-1)?.status).toBe('complete')
    const exported = deviceA.service.operations().at(-1)?.result?.trees.at(0)
    expect(exported?.status).toBe('exported')
    expect(exported?.sessions.map(session => [session.sessionId, session.status])).toEqual([
      ['session-root', 'exported'],
      ['session-child', 'exported'],
    ])
    // The package carries no absolute device path: the manifest names the root
    // session bucket and the objects, never the exporting machine's cwd.
    const bucket = join(syncRoot, 'dsh-session-sync', 'trees', 'session-root')
    const manifests = await readdir(bucket)
    expect(manifests).toHaveLength(1)
    const manifestText = await readFile(join(bucket, manifests[0] as string), 'utf8')
    expect(manifestText.includes(homedir())).toBe(false)

    // The target device starts without the project directory: import creates it.
    await rm(project, { recursive: true, force: true })
    const deviceB = await harness({ sessionsRoot: join(root, 'b', 'sessions'), syncRoot })
    await deviceB.service.importAll().done
    expect(deviceB.service.operations().at(-1)?.status).toBe('complete')
    const imported = deviceB.service.operations().at(-1)?.result?.trees.at(0)
    expect(imported?.status).toBe('imported')
    expect(imported?.sessions.map(session => [session.sessionId, session.status])).toEqual([
      ['session-root', 'created'],
      ['session-child', 'created'],
    ])
    expect(imported?.createdDirectories?.map(directory => [directory.path, directory.empty])).toEqual([[project, true]])
    expect(imported?.sessions.every(session => session.binding?.attached === true)).toBe(true)

    const rootSnapshot = await deviceB.ctx.sessionQuery.readSession(SessionId('session-root'))
    expect(rootSnapshot.events.map(event => event.type)).toEqual([
      'turn/start', 'user/message', 'step/start', 'step/end', 'turn/end', 'user/message',
    ])
    expect((await deviceB.ctx.sessionPersistence.stat(SessionId('session-root')))?.header.cwd).toBe(project)
    const trace = await deviceB.ctx.sessionQuery.traceSession(SessionId('session-root'))
    expect(trace.descendants.length).toBe(1)
    const childId = String(trace.descendants[0]?.session.header.id)
    expect(childId).toBe('session-child')
    const childSnapshot = await deviceB.ctx.sessionQuery.readSession(SessionId(childId))
    expect(childSnapshot.inheritedEventCount).toBe(1)
    // Attachment bytes arrived and resolve through the recorded reference.
    const storedImage = await deviceB.ctx.attachments.readImage(IMAGE_REF)
    expect(new TextDecoder().decode(storedImage.data)).toBe('normalized image raster')

    // A repeated import skips every session instead of repeating events.
    await deviceB.service.importAll().done
    const repeated = deviceB.service.operations().at(-1)?.result?.trees ?? []
    expect(repeated.length).toBeGreaterThan(0)
    expect(repeated.every(tree => tree.sessions.every(session => session.status === 'skipped'))).toBe(true)
    const afterRepeat = await deviceB.ctx.sessionQuery.readSession(SessionId('session-root'))
    expect(afterRepeat.events.length).toBe(rootSnapshot.events.length)

    // The exporting device advances; the importing device appends only the suffix.
    await appendRootEvent(deviceA)
    await deviceA.service.exportTree('session-root').done
    await deviceB.service.importAll().done
    // Every visible revision is importable; the richest one is applied last, so
    // the final report is the newest outcome rather than a filename's.
    const appendedTrees = deviceB.service.operations().at(-1)?.result?.trees ?? []
    const newest = appendedTrees.at(-1)
    expect(newest?.sessions.map(session => [session.sessionId, session.status])).toEqual([
      ['session-root', 'appended'],
      ['session-child', 'skipped'],
    ])
    const advanced = await deviceB.ctx.sessionQuery.readSession(SessionId('session-root'))
    expect(advanced.events.length).toBe(rootSnapshot.events.length + 1)

    // A local history that already leads is never rolled back.
    await appendRootEvent(deviceB)
    await deviceB.service.importAll().done
    const leading = deviceB.service.operations().at(-1)?.result?.trees.at(-1)
    expect(leading?.sessions.at(0)?.status).toBe('skipped')
    const kept = await deviceB.ctx.sessionQuery.readSession(SessionId('session-root'))
    expect(kept.events.length).toBe(advanced.events.length + 1)
  })

  it('exports the whole tree when the requested id names a child session', async () => {
    const root = await tempRoot()
    const syncRoot = join(root, 'cloud')
    const project = await homeProject('mid-tree')

    const deviceA = await harness({ sessionsRoot: join(root, 'a', 'sessions'), syncRoot })
    await seedRoot(deviceA, project)
    await seedChild(deviceA, project)

    // A mid-tree selection resolves to the lineage root: the child never
    // becomes a partial tree of its own.
    await deviceA.service.exportTree('session-child').done
    const exported = deviceA.service.operations().at(-1)?.result?.trees.at(0)
    expect(exported?.rootSessionId).toBe('session-root')
    expect(exported?.status).toBe('exported')
    expect(exported?.sessions.map(session => [session.sessionId, session.status])).toEqual([
      ['session-root', 'exported'],
      ['session-child', 'exported'],
    ])
    // The package is published under the resolved root's bucket.
    const bucket = join(syncRoot, 'dsh-session-sync', 'trees', 'session-root')
    expect((await readdir(bucket)).length).toBe(1)

    const deviceB = await harness({ sessionsRoot: join(root, 'b', 'sessions'), syncRoot })
    await deviceB.service.importAll().done
    const imported = deviceB.service.operations().at(-1)?.result?.trees.at(0)
    expect(imported?.status).toBe('imported')
    expect(imported?.sessions.map(session => session.sessionId)).toEqual(['session-root', 'session-child'])
  })
})
