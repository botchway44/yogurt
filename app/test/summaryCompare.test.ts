import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore, type Store } from '../src/main/store'
import { hookNotes } from '../src/main/notes'
import { createQueue } from '../src/main/notes/queue'
import type { Llm } from '../src/main/notes/enhance'

const dirs: string[] = []
const stores: Store[] = []
afterEach(() => {
  stores.splice(0).forEach((s) => s.close())
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})
const until = (check: () => void) => vi.waitFor(check, { timeout: 5000, interval: 10 })

function open() {
  const d = mkdtempSync(join(tmpdir(), 'yogurt-compare-'))
  dirs.push(d)
  const store = openStore(join(d, 'yogurt.db'))
  stores.push(store)
  const m = store.createMeeting({ source: undefined, title: 'Sync', startedAt: 1, endedAt: 2, eventId: null, app: null, attendees: [], state: 'stopped' })
  store.addSegments([{ meetingId: m.id, track: 'them', startMs: 0, endMs: 1000, text: 'We ship Tuesday.', speaker: 'Priya Nair' }])
  store.setNotes(m.id, { mine: '- ship tuesday' })
  return { store, m }
}

describe('summary versions (store)', () => {
  it('keeps replaced summaries newest first, with the model that wrote each', () => {
    const { store, m } = open()
    store.archiveSummary(m.id, 'first', 'model-a', 100)
    store.archiveSummary(m.id, 'second', 'model-b', 200)
    expect(store.summaryVersions(m.id).map((v) => [v.text, v.model, v.at])).toEqual([['second', 'model-b', 200], ['first', 'model-a', 100]])
  })
  it('does not keep blank text or a repeat of the newest version', () => {
    const { store, m } = open()
    store.archiveSummary(m.id, '   ', 'model-a')
    store.archiveSummary(m.id, 'same', 'model-a')
    store.archiveSummary(m.id, 'same', 'model-a')
    expect(store.summaryVersions(m.id)).toHaveLength(1)
  })
  it('remembers which model wrote the current summary, and says "" when nothing recorded it', () => {
    const { store, m } = open()
    expect(store.writtenModel(m.id)).toBe('')
    store.setNotes(m.id, { enhanced: 'x' })
    store.setWrittenModel(m.id, 'model-a')
    expect(store.writtenModel(m.id)).toBe('model-a')
  })
  it('is removed with its meeting', () => {
    const { store, m } = open()
    store.archiveSummary(m.id, 'old', 'model-a')
    store.deleteMeeting(m.id)
    expect(store.summaryVersions(m.id)).toEqual([])
  })
})

describe('regenerating keeps the replaced summary for comparing', () => {
  function run() {
    const { store, m } = open()
    let label = 'model-a', reply = '## Plan\n- We ship Tuesday'
    const llm: Llm = { contextSize: 32_000, count: async (xs) => xs.map((x) => x.length), chat: async (_p, onToken) => { onToken?.(reply); return reply } }
    const notes = hookNotes({
      store, queue: createQueue({ recording: () => false, smallMac: false }), model: { llm: async () => llm }, modelLabel: () => label,
      transcribed: async () => {}, language: () => 'english', onStop: () => {}, send: () => {}, changed: () => {}, peopleRewriteMs: 30, me: () => '',
    })
    const write = async (nextLabel: string, nextReply: string) => {
      label = nextLabel; reply = nextReply
      const before = store.writtenModel(m.id)
      await notes.writeAgain(m.id)
      await until(() => { expect(notes.view(m.id).status).toBe('done'); expect(store.writtenModel(m.id)).toBe(nextLabel); expect(store.writtenModel(m.id) !== before || nextLabel === before).toBe(true) })
    }
    return { store, m, notes, write }
  }

  it('the first summary has nothing earlier; a second model keeps the first beside it', async () => {
    const s = run()
    await s.write('model-a', '## Plan\n- First draft')
    expect(s.notes.compare(s.m.id)).toMatchObject({ current: { model: 'model-a' }, earlier: [] })
    await s.write('model-b', '## Plan\n- Second draft')
    const c = s.notes.compare(s.m.id)
    expect(c.current).toMatchObject({ model: 'model-b' })
    expect(c.current.text).toContain('Second draft')
    expect(c.earlier).toHaveLength(1)
    expect(c.earlier[0]).toMatchObject({ model: 'model-a' })
    expect(c.earlier[0].text).toContain('First draft')
  })

  it('a regeneration that comes out identical adds no earlier version', async () => {
    const s = run()
    await s.write('model-a', '## Plan\n- Same')
    await s.write('model-b', '## Plan\n- Same')
    expect(s.notes.compare(s.m.id).earlier).toEqual([])
  })

  it('the person\'s own edit of a summary is kept too when it is replaced', async () => {
    const s = run()
    await s.write('model-a', '## Plan\n- Original')
    s.store.setNotes(s.m.id, { enhanced: '## Plan\n- Edited by hand', edited: true })
    await s.write('model-b', '## Plan\n- Redone')
    expect(s.notes.compare(s.m.id).earlier[0].text).toContain('Edited by hand')
  })
})
