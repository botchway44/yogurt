import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Catalog, Hardware } from '@yogurt/picker'
import bundled from '../../catalog/catalog.json'
import { SetupController, type SetupDeps } from '../src/main/setup'
import { fakeDownloadDeps } from '../src/main/fake'
import { fileNameFor, type DownloadDeps } from '../src/main/downloader'
import type { SetupState } from '../src/shared/types'

const catalog = bundled as unknown as Catalog
const m1max: Hardware = { os: 'darwin', arch: 'arm64', cpuModel: 'Apple M1 Max', totalRamGB: 32, freeDiskGB: 500, gpu: { kind: 'unified', name: 'Apple M1 Max', vramGB: 24 } }

const model = (id: string) => catalog.models.find((m) => m.id === id)!
const urlOf = (id: string) => model(id).builds[0].url
const OTHER = 'gpt-oss-20b' // fits a 32 GB Mac, and is not what Automatic picks there (gemma-4-26b-a4b)
const OTHER2 = 'gemma-4-e2b'

/** a download that records what was asked for, can hold chosen files until released, and can fail chosen ones */
function recorder(o: { hold?: (url: string) => boolean; fail?: (url: string) => boolean } = {}) {
  const asked: string[] = []
  const released: (() => void)[] = []
  const inner = fakeDownloadDeps({ stepMs: 0 })
  const failing = { on: true }
  const download: DownloadDeps['download'] = async (url, dir, file, onProgress, signal) => {
    asked.push(url)
    // held until released, but a real download stops when it is aborted, so this does too
    if (o.hold?.(url)) await new Promise<void>((res, rej) => { released.push(res); signal?.addEventListener('abort', () => rej(signal.reason), { once: true }) })
    signal?.throwIfAborted()
    if (o.fail?.(url) && failing.on) throw new Error('network down')
    return inner.download(url, dir, file, onProgress, signal)
  }
  return { asked, failing, release: () => released.splice(0).forEach((r) => r()), deps: { ...inner, download } as DownloadDeps }
}

function setup(rec: ReturnType<typeof recorder>, over: Partial<SetupDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yogurt-switch-'))
  const c = new SetupController({ getHardware: async () => m1max, getCatalog: async () => catalog, modelsDir: root, download: rec.deps, sha256Override: 'FAKE', retryDelaysMs: [0, 0], ...over })
  const states: SetupState[] = []
  c.onState((s) => states.push(s))
  return { c, states, root }
}
const pathOf = (root: string, id: string) => join(root, 'llm', fileNameFor(urlOf(id)))

describe('switching the notes model from Settings, with no restart', () => {
  it('downloads the pick with progress, keeps the current model until it is in, then notesPath is the new one', async () => {
    const rec = recorder({ hold: (u) => u === urlOf(OTHER) })
    const { c, states, root } = setup(rec)
    await c.start(); await c.idle()
    const before = c.notesPath()
    expect(before).toBeTruthy()

    const switching = c.switchNotesModel(OTHER)
    await expect.poll(() => c.state.notesSwitch).toMatchObject({ id: OTHER, name: model(OTHER).name, fraction: 0 })
    expect(c.state.notesSwitch?.totalBytes).toBeGreaterThan(1e9)
    // still writing notes with the model it had
    expect(c.notesPath()).toBe(before)

    rec.release(); await switching
    expect(c.notesPath()).toBe(pathOf(root, OTHER))
    expect(c.state.notesSwitch).toBeUndefined()
    // the bigger-model flow is over: no "Better notes model" row left to act on
    expect(c.state.notesUpgradeBytes).toBeUndefined()
    // progress was reported while it came in
    expect(states.some((s) => s.notesSwitch && s.notesSwitch.fraction > 0)).toBe(true)
  })

  it('picking another model while one downloads drops the first and ends on the second', async () => {
    const rec = recorder({ hold: (u) => u === urlOf(OTHER) || u === urlOf(OTHER2) })
    const { c, root } = setup(rec)
    await c.start(); await c.idle()
    const first = c.switchNotesModel(OTHER)
    await expect.poll(() => c.state.notesSwitch?.id).toBe(OTHER)
    const second = c.switchNotesModel(OTHER2)
    await expect.poll(() => rec.asked.includes(urlOf(OTHER2)) || c.state.notesSwitch?.id === OTHER2).toBe(true)
    rec.release()
    await Promise.all([first, second])
    expect(c.notesPath()).toBe(pathOf(root, OTHER2))
    expect(c.state.notesSwitch).toBeUndefined()
  })

  it('a failed download says so, keeps the current model, and works when tried again', async () => {
    const rec = recorder({ fail: (u) => u === urlOf(OTHER) })
    const { c, root } = setup(rec)
    await c.start(); await c.idle()
    const before = c.notesPath()
    await c.switchNotesModel(OTHER)
    expect(c.state.notesSwitch).toMatchObject({ id: OTHER, name: model(OTHER).name, error: expect.any(String) })
    expect(c.notesPath()).toBe(before)
    rec.failing.on = false
    await c.switchNotesModel(OTHER)
    expect(c.state.notesSwitch).toBeUndefined()
    expect(c.notesPath()).toBe(pathOf(root, OTHER))
  })

  it('Automatic goes back to the model Yogurt picks for this computer', async () => {
    const rec = recorder()
    const { c, root } = setup(rec)
    await c.start(); await c.idle()
    await c.switchNotesModel(OTHER)
    expect(c.notesPath()).toBe(pathOf(root, OTHER))
    await c.switchNotesModel('')
    expect(c.notesPath()).toBe(pathOf(root, 'gemma-4-26b-a4b'))
  })

  it('picking the model already in use downloads nothing', async () => {
    const rec = recorder()
    const { c } = setup(rec)
    await c.start(); await c.idle()
    await c.switchNotesModel('gemma-4-26b-a4b')
    const askedAfterStart = rec.asked.length
    await c.switchNotesModel('gemma-4-26b-a4b')
    expect(rec.asked.length).toBe(askedAfterStart)
    expect(c.state.notesSwitch).toBeUndefined()
  })

  it('a model that does not fit this computer is ignored (Settings disables it, but main checks too)', async () => {
    const rec = recorder()
    const { c } = setup(rec)
    await c.start(); await c.idle()
    const before = c.notesPath(), asked = rec.asked.length
    await c.switchNotesModel('gpt-oss-120b')
    expect(rec.asked.length).toBe(asked)
    expect(c.notesPath()).toBe(before)
    expect(c.state.notesSwitch).toBeUndefined()
  })

  it('before setup has run there is nothing to switch: nothing downloads', async () => {
    const rec = recorder()
    const { c } = setup(rec)
    await c.switchNotesModel(OTHER)
    expect(rec.asked).toEqual([])
    expect(c.notesPath()).toBeUndefined()
  })
})

describe('a model picked earlier is used when Yogurt starts', () => {
  it('downloads the pick as the first notes model, with no starter and no bigger one after it', async () => {
    const rec = recorder()
    const { c, root } = setup(rec, { notesModelPreference: { load: () => OTHER } })
    await c.start(); await c.idle()
    expect(c.notesPath()).toBe(pathOf(root, OTHER))
    expect(rec.asked).toContain(urlOf(OTHER))
    expect(rec.asked).not.toContain(urlOf('gemma-4-e4b'))
    expect(rec.asked).not.toContain(urlOf('gemma-4-26b-a4b'))
  })

  it('falls back to the automatic pick when the saved model is not in this build', async () => {
    const rec = recorder()
    const { c, root } = setup(rec, { notesModelPreference: { load: () => 'no-such-model' } })
    await c.start(); await c.idle()
    expect(c.notesPath()).toBe(pathOf(root, 'gemma-4-26b-a4b'))
  })
})

describe('deleting the notes models nothing uses', () => {
  const file = (root: string, id: string) => pathOf(root, id)

  it('lists and deletes the models left behind by switching, never the one in use', async () => {
    const rec = recorder()
    const { c, root } = setup(rec)
    await c.start(); await c.idle()
    await c.switchNotesModel(OTHER)
    // the starter and the bigger model it had are both left behind now
    const left = [file(root, 'gemma-4-e4b'), file(root, 'gemma-4-26b-a4b')]
    for (const f of left) expect(existsSync(f)).toBe(true)
    const unused = c.unusedNotesModels()
    expect(unused.files.filter((f) => f.endsWith('.gguf')).sort()).toEqual(left.sort())
    expect(unused.bytes).toBeGreaterThan(0)

    const freed = c.deleteUnusedNotesModels()
    expect(freed).toBe(unused.bytes)
    for (const f of left) expect(existsSync(f)).toBe(false)
    // the one in use is still there and still the active one
    expect(existsSync(file(root, OTHER))).toBe(true)
    expect(c.notesPath()).toBe(file(root, OTHER))
    // nothing more to delete
    expect(c.unusedNotesModels()).toEqual({ files: [], bytes: 0 })
    expect(c.deleteUnusedNotesModels()).toBe(0)
  })

  it('offers nothing, and deletes nothing, while a download is going', async () => {
    const rec = recorder({ hold: (u) => u === urlOf(OTHER) })
    const { c, root } = setup(rec)
    await c.start(); await c.idle()
    const switching = c.switchNotesModel(OTHER)
    await expect.poll(() => c.state.notesSwitch?.id).toBe(OTHER)
    expect(c.unusedNotesModels()).toEqual({ files: [], bytes: 0 })
    expect(c.deleteUnusedNotesModels()).toBe(0)
    expect(existsSync(file(root, 'gemma-4-26b-a4b'))).toBe(true)
    rec.release(); await switching
  })

  it('offers nothing before setup has run', () => {
    const { c } = setup(recorder())
    expect(c.unusedNotesModels()).toEqual({ files: [], bytes: 0 })
  })

  it('also clears what a cancelled download left, but only inside the notes-model folder and only model files', async () => {
    const rec = recorder()
    const { c, root } = setup(rec)
    await c.start(); await c.idle()
    const dir = join(root, 'llm')
    writeFileSync(join(dir, 'cancelled-model.gguf.part'), 'half a model')
    // things that are not unused notes models: a note in the same folder, and the other kinds of model
    writeFileSync(join(dir, 'readme.txt'), 'keep me')
    mkdirSync(join(root, 'asr'), { recursive: true }); writeFileSync(join(root, 'asr', 'speech.gguf'), 'speech')
    mkdirSync(join(root, 'embed'), { recursive: true }); writeFileSync(join(root, 'embed', 'search.gguf'), 'search')

    expect(c.unusedNotesModels().files).toContain(join(dir, 'cancelled-model.gguf.part'))
    c.deleteUnusedNotesModels()
    expect(existsSync(join(dir, 'cancelled-model.gguf.part'))).toBe(false)
    expect(existsSync(join(dir, 'readme.txt'))).toBe(true)
    expect(existsSync(join(root, 'asr', 'speech.gguf'))).toBe(true)
    expect(existsSync(join(root, 'embed', 'search.gguf'))).toBe(true)
    expect(existsSync(c.notesPath()!)).toBe(true)
  })
})

describe('which notes models are already downloaded', () => {
  const downloaded = async (c: SetupController) => (await c.notesModelOptions()).filter((m) => m.downloaded).map((m) => m.id).sort()

  it('marks the models whose file is on this computer, and nothing else', async () => {
    const { c } = setup(recorder())
    await c.start(); await c.idle()
    // Automatic fetched the starter first, then the bigger one
    expect(await downloaded(c)).toEqual(['gemma-4-26b-a4b', 'gemma-4-e4b'])
    await c.switchNotesModel(OTHER)
    expect(await downloaded(c)).toEqual(['gemma-4-26b-a4b', 'gemma-4-e4b', OTHER].sort())
  })

  it('stops marking a model once its file is deleted', async () => {
    const { c } = setup(recorder())
    await c.start(); await c.idle()
    await c.switchNotesModel(OTHER)
    c.deleteUnusedNotesModels()
    expect(await downloaded(c)).toEqual([OTHER])
  })

  it('marks nothing before anything has been downloaded', async () => {
    const { c } = setup(recorder())
    expect(await downloaded(c)).toEqual([])
  })
})
