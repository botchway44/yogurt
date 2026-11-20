import { DatabaseSync } from 'node:sqlite'
import { selectNoteVersion } from './noteVersion'
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stage = process.env.YOGURT_INTERFACE_STAGE
const after = stage === 'after'
const output = process.env.YOGURT_INTERFACE_IMAGES
const noon = Date.parse((process.env.YOGURT_INTERFACE_DAY ?? '2026-11-19') + 'T12:00:00Z')
type Theme = 'light' | 'dark'
type Session = { app: ElectronApplication; page: Page; profile: string; theme: Theme }
type Options = { env?: Record<string, string>; settings?: Record<string, unknown>; offlineFeed?: boolean }

test.skip(!process.env.CI || !output || (stage !== 'before' && !after), 'Only the desktop screenshot workflow captures these states.')

async function capture(app: ElectronApplication, page: Page, id: string, theme: Theme, verifyPixels?: (png: string) => Promise<void>) {
  await page.evaluate(async () => {
    await document.fonts.ready
    // Let short menu exits and view entrances finish without waiting on the countdown or loading loops.
    const transitions = document.getAnimations().filter(a => a.playState === 'running' &&
      Number(a.effect?.getComputedTiming().endTime) <= 1000)
    await Promise.allSettled(transitions.map(a => a.finished))
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  })
  const window = await app.browserWindow(page)
  try {
    const viewport = await page.evaluate(() => [innerWidth, innerHeight])
    const take = async () => {
      const { png, size, zoom } = await window.evaluate(async win => {
        win.webContents.invalidate()
        const frame = await win.webContents.capturePage()
        return { png: frame.toPNG({ scaleFactor: 1 }).toString('base64'), size: frame.getSize(), zoom: win.webContents.getZoomFactor() }
      })
      for (const [actual, expected] of [[size.width, viewport[0] * zoom], [size.height, viewport[1] * zoom]]) {
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.ceil(zoom))
      }
      await verifyPixels?.(png)
      mkdirSync(output!, { recursive: true })
      writeFileSync(join(output!, `${id}-${stage}-${theme}.png`), Buffer.from(png, 'base64'))
    }
    if (verifyPixels) await expect(take).toPass({ timeout: 8000, intervals: [100, 250] })
    else await take()
  } finally { await window.dispose() }
}

function scene(id: string, name: string, drive: (session: Session) => Promise<void | (() => Promise<void>)>, options: Options = {}) {
  for (const theme of ['light', 'dark'] as const) test(`${id} ${name} in ${theme}`, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'yogurt-interface-'))
    const settings: Record<string, unknown> = { theme, myName: 'Sam Rivera', ...options.settings }
    const server = options.offlineFeed ? createServer((_req, res) => { res.writeHead(503); res.end() }) : null
    let app: ElectronApplication | undefined
    try {
      if (server) {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Calendar fixture did not start')
        const url = `http://127.0.0.1:${address.port}/team.ics`
        settings.calendarLinks = [{ id: 'team', name: 'Team calendar', host: '127.0.0.1', url: 'b:' + Buffer.from(url).toString('base64') }]
      }
      writeFileSync(join(profile, 'settings.json'), JSON.stringify(settings))
      app = await electron.launch({ args: [join(import.meta.dirname, '../out/main/index.js')], env: {
        ...process.env, YOGURT_FAKE: '1', YOGURT_USER_DATA: profile, YOGURT_SYSTEM_LANGUAGES: 'en-US', ...options.env,
      } })
      const page = await app.firstWindow()
      // Keep the normal main-window frame, including when testing the app's Zoom In behavior.
      const window = await app.browserWindow(page)
      try { expect(await window.evaluate(win => win.getSize())).toEqual([1100, 760]) }
      finally { await window.dispose() }
      await page.emulateMedia({ colorScheme: null })
      await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(theme === 'dark')
      await page.clock.setFixedTime(noon)
      const verifyLayout = await drive({ app, page, profile, theme })
      if (id !== '12' && id !== '01') await capture(app, page, id, theme)
      await verifyLayout?.()
    } finally {
      try { await app?.close() } finally {
        if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
        rmSync(profile, { recursive: true, force: true })
      }
    }
  })
}

async function seed({ app, page }: Session) {
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate((_e, at) => {
    const f = (globalThis as unknown as { __fake__: { manyMeetings(opts: { n: number; clean: boolean }): void } }).__fake__
    const realNow = Date.now
    try { Date.now = () => at; f.manyMeetings({ n: 4, clean: true }) } finally { Date.now = realNow }
  }, noon)
  await page.reload()
  await expect(page.getByTestId('past-note')).toHaveCount(4)
}

async function note(s: Session) {
  await seed(s)
  await s.page.getByTestId('past-note').filter({ hasText: 'Budget review' }).locator('.native-meeting-link').click()
  await expect(s.page.getByTestId('note-enhanced-editor')).toBeVisible()
}

async function zoom(s: Session, factor: number) {
  const window = await s.app.browserWindow(s.page)
  try { await window.evaluate((win, value) => win.webContents.setZoomFactor(value), factor) }
  finally { await window.dispose() }
  await expect.poll(() => s.page.evaluate(() => innerWidth)).toBeLessThanOrEqual(Math.ceil(1100 / factor) + 1)
}

// Measure the actual text ink boxes. Equal flex child heights alone can hide a wrapped or offset label.
async function aligned(row: Locator) {
  await expect(row).toBeInViewport()
  await expect.poll(() => row.evaluate(el => {
    const bounds = el.getBoundingClientRect()
    const labels = el.querySelectorAll<HTMLElement>(':scope > span, :scope > a, :scope > .workspace-button')
    const controls = el.querySelectorAll<HTMLElement>(':scope > svg, :scope > [data-testid="recording-menu"]')
    const errors: string[] = []
    let center: number | undefined
    for (const part of [...labels, ...controls]) {
      const label = part.textContent?.trim() || part.tagName
      let rect = part.getBoundingClientRect()
      if (part.matches('span, a, .workspace-button')) {
        const range = document.createRange()
        range.selectNodeContents(part)
        const lines = [...range.getClientRects()].filter(r => r.width && r.height)
        if (lines.length !== 1 || part.scrollWidth > part.clientWidth + 1)
          errors.push(`${label}: ${lines.length} text rectangles, ${part.scrollWidth}px of text in ${part.clientWidth}px`)
        if (lines.length) rect = lines[0]
      }
      const mid = rect.y + rect.height / 2
      if (center === undefined) center = mid
      if (Math.abs(mid - center) > 2) errors.push(`${label}: center offset ${mid - center}px`)
      if (rect.left < bounds.left || rect.right > bounds.right + 1) errors.push(`${label}: extends past the row`)
    }
    if (!el.querySelector(':scope > span') || !el.querySelector(':scope > button.workspace-button')) errors.push('Missing message or action')
    return errors
  })).toEqual([])
}

async function rejectRead(app: ElectronApplication, channel: string) {
  await app.evaluate(({ ipcMain }, channel) => {
    const state = globalThis as typeof globalThis & { screenshotRead?: boolean }
    state.screenshotRead = false
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, () => { state.screenshotRead = true; throw new Error('Read failed') })
  }, channel)
  return () => expect.poll(() => app.evaluate(() => (globalThis as typeof globalThis & { screenshotRead?: boolean }).screenshotRead)).toBe(true)
}

async function secondaryButton(area: Locator, name = 'Try again') {
  const button = area.getByRole('button', { name, exact: true })
  await expect(button).toHaveClass(/\bworkspace-button\b/)
  await expect(button).toHaveCSS('text-decoration-line', 'none')
  await expect(button).toBeInViewport()
  return button
}

async function actionToast(area: Locator, message: string) {
  await expect(area).toHaveClass(/\bapp-toast\b/)
  await expect(area.locator('.app-toast-title')).toHaveText(message)
  await secondaryButton(area)
  await expect(area.getByRole('button', { name: 'Close' })).toBeInViewport()
}

async function emptyBlock(area: Locator) {
  const button = await secondaryButton(area)
  const heading = area.getByRole('heading')
  await expect(heading).toBeVisible()
  const box = (await heading.boundingBox())!
  expect((await button.boundingBox())!.y).toBeGreaterThanOrEqual(box.y + box.height)
  await expect(area.locator('svg').first()).toBeInViewport()
}

scene('01', 'AI access after a rejected save', async ({ app, page, profile, theme }) => {
  await page.getByTestId('settings-open').click()
  const toggle = page.getByTestId('ai-apps-toggle')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.evaluate(el => el.scrollIntoView({ block: 'center' }))
  mkdirSync(join(profile, 'settings.json.tmp'))
  // Main optimistically flips the switch and leaves the rejected write unhandled.
  const rejected = after ? undefined : page.waitForEvent('pageerror', { predicate: error => /mcp:set/i.test(error.message) && /EISDIR|directory/i.test(error.message) })
  await toggle.click()
  await rejected
  await expect(toggle).toHaveAttribute('aria-checked', after ? 'true' : 'false')
  expect((await page.evaluate(() => window.yogurt.mcp.status())).enabled).toBe(true)
  const warning = page.getByTestId('ai-apps-retry-error')
  if (after) {
    await actionToast(warning, "Couldn't save your changes")
    await expect(page.locator('.settings-group [role="alert"]')).toHaveCount(0)
  } else await expect(warning).toHaveCount(0)
  const box = (await toggle.boundingBox())!
  // DOM state can be a frame ahead of the compositor. Inspect the actual bytes we will publish.
  await capture(app, page, '01', theme, async png => {
    const title = after ? await warning.locator('.app-toast-title').evaluate(el => {
      const { x, y, width, height } = el.getBoundingClientRect()
      return { x, y, width, height, ink: getComputedStyle(el).color.match(/\d+/g)!.slice(0, 3).map(Number) }
    }) : null
    const paint = await app.evaluate(({ nativeImage }, { png, box, title, on }) => {
      const image = nativeImage.createFromBuffer(Buffer.from(png, 'base64'))
      const pixels = image.toBitmap(), { width } = image.getSize()
      const sample = (fraction: number) => {
        const i = (Math.floor(box.y + box.height / 2) * width + Math.floor(box.x + fraction * box.width)) * 4
        return [pixels[i + 2], pixels[i + 1], pixels[i]]
      }
      const thumb = sample(on ? 0.72 : 0.28)
      const track = sample(on ? 0.28 : 0.72)
      const [r, g, b] = track
      let warningPainted = false
      if (title) {
        for (let y = Math.ceil(title.y); y < title.y + title.height; y++) {
          for (let x = Math.ceil(title.x); x < title.x + title.width; x++) {
            const i = (y * width + x) * 4
            if (title.ink.every((component, c) => Math.abs(component - pixels[i + 2 - c]) < 24)) warningPainted = true
          }
        }
      }
      return { whiteThumb: Math.min(...thumb) > 235,
        settledTrack: on ? b > g + 50 && b > r + 20 : Math.max(...track) - Math.min(...track) < 20,
        warningPainted }
    }, { png, box, title, on: after })
    expect(paint).toEqual({ whiteThumb: true, settledTrack: true, warningPainted: after })
  })
}, { settings: { aiApps: true } })

for (const [id, control, channel, toast] of [
  ['01-general', 'recording-reminder-toggle', 'settings:recording-reminder', 'settings-save-retry-error'],
  ['01-updates', 'updates-toggle', 'updates:set', 'updates-save-retry-error'],
] as const) {
  scene(id, 'rejected save for ' + control, async s => {
    await s.page.getByTestId('settings-open').click()
    const toggle = s.page.getByTestId(control)
    await expect(toggle).toBeEnabled()
    await toggle.evaluate(el => el.scrollIntoView({ block: 'center' }))
    const saved = await toggle.getAttribute('aria-checked')
    const rejected = await rejectRead(s.app, channel)
    await toggle.click()
    await rejected()
    if (after) {
      await expect(toggle).toHaveAttribute('aria-checked', saved!)
      await actionToast(s.page.getByTestId(toast), "Couldn't save your changes")
    }
  })
}

scene('02', 'an unavailable linked calendar', async ({ app, page }) => {
  await app.evaluate(() => (globalThis as unknown as { __fake__: { calendarEvents(e: unknown[]): void } }).__fake__.calendarEvents([]))
  await page.reload()
  const agenda = page.getByRole('complementary', { name: 'Agenda' })
  if (after) {
    await expect(agenda.getByRole('alert')).toContainText("Can't read Team calendar")
    await emptyBlock(agenda.getByRole('alert'))
  } else await expect(agenda.getByText('No meetings', { exact: true })).toBeVisible()
}, { offlineFeed: true })

scene('02-partial', 'a working calendar beside an offline feed', async ({ app, page }) => {
  await app.evaluate((_e, at) => {
    const f = (globalThis as unknown as { __fake__: { calendarEvents(events: unknown[]): void } }).__fake__
    f.calendarEvents([{ id: 'healthy', title: 'Design review', attendees: [], start: new Date(at).toISOString(), end: new Date(at + 3600000).toISOString() }])
  }, noon)
  await page.reload()
  const agenda = page.getByRole('complementary', { name: 'Agenda' })
  await expect(agenda.getByText('Design review')).toBeInViewport()
  if (after) {
    const row = agenda.getByTestId('calendar-error')
    await expect(row).toHaveClass(/inline-error/)
    await secondaryButton(row)
  } else await expect(agenda.getByRole('alert')).toHaveCount(0)
}, { offlineFeed: true })

scene('03', 'selected meeting', async s => {
  await seed(s)
  const row = s.page.getByTestId('past-note').filter({ hasText: 'Weekly sync' })
  await row.locator('.native-meeting-link').click({ modifiers: ['Meta'] })
  await expect(row.locator('.native-meeting-link')).toHaveAttribute('aria-pressed', 'true')
  await expect(row.getByTestId('meeting-selected')).toHaveCount(after ? 1 : 0)
  await s.page.mouse.move(4, 4)
})

for (const [id, view] of [['04', 'meetings'], ['04-folder', 'folder'], ['04-trash', 'trash']] as const) {
  scene(id, 'empty library after a failed ' + view + ' read', async ({ app, page }) => {
    await expect(page.getByTestId('home')).toBeVisible()
    if (view === 'folder') {
      await page.evaluate(async () => {
        const folder = await window.yogurt.folders.create('Planning')
        window.yogurt.nav.go('/folder/' + folder!.id)
      })
    } else if (view === 'trash') await page.evaluate(() => window.yogurt.nav.go('/trash'))
    const emptyId = { meetings: 'past-empty', folder: 'folder-empty', trash: 'trash-none' }[view]
    const empty = page.getByTestId(emptyId)
    // Measure the healthy empty surface in the same window before rejecting the next read.
    await expect(empty).toBeInViewport()
    const center = await empty.evaluate(el => { const r = el.getBoundingClientRect(); return r.y + r.height / 2 })
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => { throw new Error('Library read failed') })
    }, view === 'trash' ? 'meetings:trashed' : 'meetings:cards')
    await page.reload()
    if (after) {
      const area = page.getByTestId('meetings-read-error')
      await emptyBlock(area)
      const rect = (await area.boundingBox())!
      expect(Math.abs(rect.y + rect.height / 2 - center)).toBeLessThanOrEqual(3)
    } else await expect(page.locator('.library-load')).toHaveAttribute('data-loading-phase', 'skeleton')
  })
}

scene('04-retained', 'library refresh with earlier results', async s => {
  await seed(s)
  const read = await rejectRead(s.app, 'meetings:cards')
  await s.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(win => !win.webContents.getURL().includes('#'))!.webContents.send('meetings:changed'))
  await read()
  await expect(s.page.getByTestId('past-note')).toHaveCount(4)
  if (after) await secondaryButton(s.page.getByTestId('meetings-read-error'))
})

scene('04-search', 'the command palette after a failed search', async s => {
  await expect(s.page.getByTestId('home')).toBeVisible()
  const read = await rejectRead(s.app, 'search:query')
  await s.page.keyboard.press('Meta+k')
  await s.page.getByTestId('search-input').fill('Planning')
  await read()
  if (after) {
    const row = s.page.getByTestId('search-read-error')
    await secondaryButton(row)
    await secondaryButton(row, 'Ask')
  } else await expect(s.page.getByTestId('search-input')).toHaveValue('Planning')
})

scene('06', 'keyboard focus in the note menu', async s => {
  await note(s)
  await s.page.getByTestId('note-menu-button').press('Enter')
  const item = s.page.getByTestId('note-rename')
  await expect(item).toBeFocused()
  // Finding 06 was withdrawn. Record the existing focus treatment on each revision for direct comparison.
  const focus = await item.evaluate(el => {
    const css = getComputedStyle(el)
    return { focusVisible: el.matches(':focus-visible'), width: css.outlineWidth, style: css.outlineStyle,
      color: css.outlineColor, offset: css.outlineOffset, fill: css.backgroundColor }
  })
  mkdirSync(output!, { recursive: true })
  writeFileSync(join(output!, `06-focus-${stage}-${s.theme}.json`), JSON.stringify(focus, null, 2))
})

scene('07', 'scroll a compact agenda', async s => {
  await seed(s)
  await s.app.evaluate(async (_e, at) => {
    const f = (globalThis as unknown as { __fake__: { calendarEvents(events: unknown[]): void; advance(ms: number): Promise<void> } }).__fake__
    f.calendarEvents(['Design review', 'Research sync', 'Friday planning'].map((title, i) => ({
      id: 'meeting-' + i, title, start: new Date(at + (i + 1) * 3600000).toISOString(),
      end: new Date(at + (i + 1.5) * 3600000).toISOString(), attendees: [],
    })))
    await f.advance(at - Date.now())
  }, noon)
  await s.page.reload()
  const agenda = s.page.getByRole('complementary', { name: 'Agenda' })
  await expect(agenda.getByTestId('event')).toHaveCount(3)
  await zoom(s, 2)
  await expect(agenda).toHaveCSS('overflow-y', after ? 'auto' : 'hidden')
  const list = agenda.getByTestId('agenda-scroll')
  const header = agenda.locator('.agenda-header')
  const first = agenda.getByTestId('event').first()
  await header.hover()
  await agenda.evaluate(el => { el.scrollTop = 0 })
  await list.evaluate(el => { el.scrollTop = 0 })
  await expect(header).toBeInViewport()
  await expect(first).not.toBeInViewport()
  const geometry = async () => {
    const rect = (await agenda.boundingBox())!
    return [rect.x, rect.y, rect.width, rect.height].map(Math.round)
  }
  const frame = await geometry()
  mkdirSync(output!, { recursive: true })
  const top = Math.round((await header.boundingBox())!.y)
  writeFileSync(join(output!, `07-frame-${stage}-${s.theme}.json`), JSON.stringify({ frame, top }))
  // The main photograph on both builds is the identical starting view. Then show the same gesture separately.
  return async () => {
    await s.page.mouse.wheel(0, 160)
    await expect(agenda.locator('.agenda-day')).toBeInViewport()
    if (after) {
      await expect(first).toBeInViewport({ ratio: 0.75 })
      await expect.poll(() => agenda.evaluate(el => el.scrollTop)).toBeGreaterThan(0)
    } else {
      await expect(first).not.toBeInViewport()
      expect(await agenda.evaluate(el => el.scrollTop)).toBe(0)
    }
    expect(await geometry()).toEqual(frame)
    await capture(s.app, s.page, '07-reach', s.theme)
    if (after) {
      await s.page.mouse.wheel(0, 600)
      await expect(agenda.getByTestId('event').last()).toBeInViewport()
    }
  }
})

scene('08', 'first-run permission choices at high zoom', async s => {
  await s.page.getByTestId('intro-next').click()
  await expect(s.page.getByTestId('onboarding-step')).toHaveAttribute('data-step', 'record')
  await zoom(s, 2)
  await s.page.getByTestId('step-later').evaluate(el => el.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  await expect(s.page.locator('.ob-stage')).toHaveCSS('display', after ? 'none' : 'grid')
  if (after) {
    await expect(s.page.getByTestId('step-allow')).toBeInViewport()
    await expect(s.page.getByTestId('step-later')).toBeInViewport()
  }
}, { env: { YOGURT_FAKE_PERMISSIONS: 'unknown', YOGURT_FAKE_CALENDAR: 'notDetermined' } })

scene('09', 'German warning before replacing edits', async s => {
  await note(s)
  await s.page.getByTestId('note-enhanced-editor').fill('Wir besprechen den Zeitplan am Freitag.')
  await expect(s.page.getByTestId('note-save-status')).toHaveAttribute('data-state', 'saved')
  await s.page.getByTestId('note-menu-button').click()
  await s.page.getByTestId('note-write-again').click()
  const warning = s.page.getByTestId('note-confirm')
  await expect(warning).toContainText('ersetzt')
  await zoom(s, 3.4)
  await expect(warning).toBeInViewport()
  await expect(warning).toHaveCSS('white-space', after ? 'normal' : 'nowrap')
  await expect.poll(() => warning.evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    return range.getClientRects().length > 1 && el.scrollWidth <= el.clientWidth + 1
  })).toBe(after)
}, { settings: { language: 'de' } })

scene('10', 'opening Ask when its conversation cannot load', async ({ app, page }) => {
  await expect(page.getByTestId('home')).toBeVisible()
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('conversations:current')
    ipcMain.handle('conversations:current', () => { throw new Error('Conversation read failed') })
  })
  await page.evaluate(() => window.yogurt.nav.go('/chat'))
  if (after) {
    await aligned(page.getByTestId('chat-page-load-error'))
    await secondaryButton(page.getByTestId('chat-page-load-error'))
  }
  else await expect(page.getByRole('alert').filter({ hasText: "Couldn't save your changes" })).toBeVisible()
})

scene('10-panel', 'opening Ask inside a note when its lookup fails', async s => {
  await note(s)
  const read = await rejectRead(s.app, 'conversations:current')
  await s.page.getByTestId('chat-open').click()
  await read()
  if (after) await secondaryButton(s.page.getByTestId('chat-open-error'))
  else await expect(s.page.getByTestId('chat-panel').getByText("Yogurt couldn't answer that.")).toBeVisible()
})

scene('10-history', 'opening Recent when conversation history fails', async s => {
  await expect(s.page.getByTestId('home')).toBeVisible()
  const read = await rejectRead(s.app, 'conversations:list')
  await s.page.evaluate(() => window.yogurt.nav.go('/chat'))
  await read()
  await s.page.getByTestId('chat-recent').click()
  await expect(s.page.getByTestId('chat-recent-list')).toBeVisible()
  if (after) await secondaryButton(s.page.getByTestId('chat-history-error'))
})

scene('10-thread', 'reading an existing conversation', async s => {
  await expect(s.page.getByTestId('home')).toBeVisible()
  const id = await s.page.evaluate(() => window.yogurt.conversations.current([]))
  const read = await rejectRead(s.app, 'conversations:get')
  await s.page.evaluate(id => window.yogurt.nav.go('/chat/' + id), id)
  await read()
  await expect(s.page.getByTestId('chat-page')).toBeVisible()
  if (after) await secondaryButton(s.page.getByTestId('conversation-read-error'))
})

scene('calendar-event', 'a linked event is no longer available', async s => {
  await note(s)
  const id = (await s.page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
  const db = new DatabaseSync(join(s.profile, 'yogurt.db'))
  try { db.prepare('UPDATE meetings SET event_id=? WHERE id=?').run('unavailable-event', id) }
  finally { db.close() }
  await s.page.reload()
  await s.page.getByTestId('note-date').click()
  const card = s.page.getByTestId('note-date-card')
  await expect(card.getByText('Calendar event unavailable')).toBeVisible()
  if (after) await secondaryButton(card)
  else await expect(card.getByRole('button', { name: 'Try again' })).toHaveClass(/text-action/)
})

scene('10-answer', 'retrying a failed answer', async s => {
  await expect(s.page.getByTestId('home')).toBeVisible()
  const chat = await s.page.evaluate(async () => window.yogurt.conversations.get(await window.yogurt.conversations.current([])))
  if (!chat) throw new Error('Missing conversation fixture')
  await s.app.evaluate(({ ipcMain }, chat) => {
    ipcMain.removeHandler('conversations:get')
    ipcMain.handle('conversations:get', () => ({ ...chat, turns: [{ id: 1, question: 'What did we decide?', answer: '', status: 'failed', sources: [] }] }))
  }, chat)
  await s.page.evaluate(id => window.yogurt.nav.go('/chat/' + id), chat.id)
  const turn = s.page.getByTestId('chat-page-turn')
  await expect(turn).toHaveAttribute('data-status', 'failed')
  if (after) await secondaryButton(turn)
  else await expect(turn.getByRole('button', { name: 'Try again' })).toHaveClass(/ghost-btn/)
})

scene('12', 'Reduce Motion in Ask and the call prompt', async ({ app, page, theme }) => {
  await expect(page.getByTestId('home')).toBeVisible()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.evaluate(() => window.yogurt.nav.go('/chat'))
  await page.getByTestId('chat-page-input').fill('What did we decide?')
  const send = page.getByTestId('chat-page-send')
  await send.hover()
  const material = send.locator('.orb-material')
  await expect.poll(() => material.evaluate(el => getComputedStyle(el, '::before').animationName)).toBe(after ? 'none' : 'orb-turn')
  await capture(app, page, '12-ask', theme)
  await app.evaluate(() => (globalThis as unknown as { __fake__: { signals(r: unknown): Promise<void> } }).__fake__
    .signals({ micApps: [{ bundleId: 'us.zoom.xos', name: 'zoom.us' }], events: [] }))
  await expect.poll(() => app.windows().some(p => p.url().includes('#prompt'))).toBe(true)
  const prompt = app.windows().find(p => p.url().includes('#prompt'))!
  await prompt.emulateMedia({ colorScheme: null, reducedMotion: 'reduce' })
  await expect(prompt.getByTestId('prompt')).toBeVisible()
  await prompt.getByTestId('prompt').hover()
  const bar = prompt.getByTestId('prompt-countdown')
  if (after) await expect(bar).toBeHidden()
  else {
    await expect(bar).toBeVisible()
    await bar.evaluate(el => { const animation = el.getAnimations()[0]; animation.pause(); animation.currentTime = 6000 })
  }
  await capture(app, prompt, '12', theme)
})

scene('13', 'unreadable recording in its transcript', async s => {
  await seed(s)
  const id = await s.page.evaluate(async () => (await window.yogurt.meetings.cards({ limit: 1 }))[0].id)
  const dir = join(s.profile, 'meetings', id)
  mkdirSync(dir, { recursive: true })
  for (const track of ['me','them']) writeFileSync(join(dir, track + '.wav'), Buffer.alloc(4000, 7))
  await s.page.evaluate(id => window.yogurt.nav.go('/note/' + id), id)
  await s.page.getByTestId('note-transcript-toggle').click()
  await expect(s.page.getByTestId('player-note')).toHaveText("This recording can't be played.")
  if (after) {
    const row = s.page.getByTestId('player-error')
    await aligned(row)
    await expect(row.getByTestId('recording-menu')).toBeVisible()
    await expect(row.getByRole('link', { name: 'Open in transcript' })).toBeVisible()
    await secondaryButton(row)
    const left = (await s.page.getByTestId('player').boundingBox())!.x
    expect((await row.locator('svg').first().boundingBox())!.x - left).toBeGreaterThanOrEqual(16)
  }
})

for (const mode of ['partial', 'absent'] as const) {
  scene('13-' + mode, 'playback with ' + mode + ' audio', async s => {
    await seed(s)
    const id = await s.page.evaluate(async () => (await window.yogurt.meetings.cards({ limit: 1 }))[0].id)
    if (mode === 'partial') {
      const dir = join(s.profile, 'meetings', id)
      mkdirSync(dir, { recursive: true })
      copyFileSync(join(import.meta.dirname, 'fixtures/meeting-me.wav'), join(dir, 'me.wav'))
      writeFileSync(join(dir, 'them.wav'), Buffer.alloc(4000, 7))
    }
    const tracks = await s.page.evaluate(id => window.yogurt.audio.tracks(id), id)
    expect(tracks.length).toBe(mode === 'partial' ? 2 : 0)
    await s.page.evaluate(id => window.yogurt.nav.go('/note/' + id), id)
    await s.page.getByTestId('note-transcript-toggle').click()
    await expect(s.page.getByTestId('transcript')).toHaveAttribute('data-loaded', 'true')
    if (mode === 'absent') await expect(s.page.getByTestId('player')).toHaveCount(0)
    else {
      await expect(s.page.getByTestId('player-note')).toHaveText("Part of this recording can't be played.")
      await expect(s.page.getByTestId('player-toggle')).toBeVisible()
      if (after) await secondaryButton(s.page.getByTestId('player-error'))
    }
  })
}

scene('15', 'failed note export', async s => {
  await note(s)
  await s.app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('share:save')
    ipcMain.handle('share:save', () => 'failed')
  })
  await s.page.getByTestId('share-button').click()
  await s.page.getByTestId('share-export').click()
  await expect(s.page.getByTestId('share-menu')).toBeHidden()
  if (after) {
    await actionToast(s.page.getByTestId('share-export-error'), "Couldn't save the file")
    await expect(s.page.getByTestId('share-said')).toBeEmpty()
  } else await expect(s.page.getByTestId('share-said')).toHaveText("Couldn't save the file")
})

scene('17', 'incomplete recording start time', async ({ app, page, profile, theme }) => {
  const file = join(profile, 'Friday planning.wav')
  copyFileSync(join(import.meta.dirname, 'fixtures/meeting-me.wav'), file)
  utimesSync(file, new Date(noon), new Date(noon))
  await app.evaluate(({ dialog }, file) => { Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [file] }) }) }, file)
  await page.getByTestId('recording-choices').click()
  await page.getByTestId('recording-upload').click()
  const field = page.getByLabel('Start time', { exact: true })
  const original = await field.inputValue()
  await field.fill('')
  await field.press('Tab')
  await expect(field).toHaveValue(after ? '' : original)
  if (after) {
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(page.locator('label[for="upload-start-time"]')).toHaveText('Start time')
    const day = page.getByTestId('audio-upload-date').locator('span')
    expect(await day.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const error = page.locator('#upload-time-error')
    await expect(error).toBeVisible()
    const row = (await page.locator('.audio-upload-date-row').boundingBox())!
    const input = (await field.boundingBox())!, message = (await error.boundingBox())!
    expect(input.y).toBeGreaterThanOrEqual(row.y)
    expect(input.y + input.height).toBeLessThanOrEqual(row.y + row.height + 1)
    expect(message.y).toBeGreaterThanOrEqual(row.y + row.height)
    expect(Math.abs(message.x - row.x) + Math.abs(message.width - row.width)).toBeLessThan(2)
  }
  return async () => {
    await field.fill('14:30')
    await field.press('Tab')
    if (after) {
      await expect(field).toHaveAttribute('type', 'time')
      await expect(field).toHaveValue('14:30')
      await expect(field).not.toHaveAttribute('aria-invalid', 'true')
    }
    await capture(app, page, '17-valid', theme)
  }
})

for (const [id, rowId] of [
  ['note-save', 'note-save-status'], ['summary', 'note-enhanced-failed'],
  ['regenerate', 'note-enhanced-rewrite-failed'], ['upload-read', 'upload-preparation-failed'],
] as const) {
  scene(id, 'existing recovery action for ' + id, async s => {
    await note(s)
    const noteId = (await s.page.evaluate(() => window.yogurt.nav.current())).slice('/note/'.length)
    const db = new DatabaseSync(join(s.profile, 'yogurt.db'))
    try {
      if (id === 'upload-read') {
        db.prepare("UPDATE meetings SET source='audio-file', transcription_state='error', transcription_pending=0 WHERE id=?").run(noteId)
        await s.page.reload()
        await s.page.getByTestId('note-transcript-toggle').click()
      } else {
        if (id === 'summary') {
          db.prepare('UPDATE notes SET enhanced=NULL, edited=0, mine=? WHERE meeting_id=?').run('Review the revised schedule.', noteId)
          await s.page.reload()
        }
        db.exec("CREATE TRIGGER fail_note_write BEFORE INSERT ON notes BEGIN SELECT RAISE(FAIL, 'Note write failed'); END")
        if (id === 'note-save') {
          await selectNoteVersion(s.page, 'mine')
          await s.page.getByTestId('note-mine').fill('Review the revised schedule.')
        } else await s.page.evaluate(id => window.yogurt.notes.writeAgain(id), noteId)
      }
      const row = s.page.getByTestId(rowId)
      const name = id === 'upload-read' ? 'Upload a file' : 'Try again'
      await expect(row).toHaveAttribute('role', 'alert')
      if (after) await secondaryButton(row, name)
      else await expect(row.getByRole('button', { name })).toHaveClass(/text-action/)
    } finally { db.close() }
  }, { env: { YOGURT_FAKE_LLM_MS: '2' } })
}

scene('18', 'suggested folder hit areas', async s => {
  await seed(s)
  await s.page.evaluate(() => window.yogurt.folders.create('Acme'))
  const chip = s.page.getByTestId('past-note').filter({ hasText: 'Customer call with Acme' }).getByTestId('folder-suggestion')
  await expect(chip).toBeVisible()
  for (const action of ['cancel', 'confirm']) {
    const target = chip.getByTestId('folder-suggestion-' + action)
    await expect(target).toHaveCSS('width', after ? '24px' : '20px')
    await expect(target).toHaveCSS('height', after ? '24px' : '20px')
  }
  await chip.getByTestId('folder-suggestion-confirm').hover()
})

scene('19', 'section and subsection in a note', async s => {
  await seed(s)
  const id = await s.page.evaluate(async () => {
    const id = (await window.yogurt.meetings.cards({ limit: 1 }))[0].id
    await window.yogurt.notes.setEnhanced(id, '## Project plan\nThe team will review the drawings on Friday.\n### Next steps\nSam will confirm the dates.', 1)
    return id
  })
  await s.page.evaluate(id => window.yogurt.nav.go('/note/' + id), id)
  const editor = s.page.getByTestId('note-enhanced-editor')
  await expect(editor.locator('h2')).toHaveCSS('font-size', after ? '16px' : '15px')
  await expect(editor.locator('h3')).toHaveCSS('font-size', after ? '15px' : '15.5px')
})
