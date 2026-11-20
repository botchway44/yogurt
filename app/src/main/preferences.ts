import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { loadSettings, localeOf, recordingReminderOn, spokenSetting, stopsWhenCallEnds, updateSettings, visibilityOf, summaryLanguageSetting } from './settings'
import { systemLocale } from './locale'
import { PERMISSION_KINDS, type PermissionKind, type Permissions } from './permissions'
import { firstRunPlan, missing, nudge } from '../shared/onboarding'
import type { NotesModelOption, OnboardingPlan } from '../shared/types'
import { cleanJargon } from '../shared/jargon'
import { isLocale, setLanguage } from '../shared/i18n'
import { SPOKEN, type Spoken } from '../shared/spoken'

const isKind = (k: unknown): k is PermissionKind => PERMISSION_KINDS.includes(k as PermissionKind)

/**
 * Settings, the first run (intro and permissions) and home's Finish setup: permissions (read, asked, or their System Settings pane), open at login, theme.
 * ask: whether this run may show the first run at all (fake mode only when a test sets the permissions).
 */
/** the first-run screens are on screen now (intro or permission steps, not yet finished): no call is offered meanwhile */
let firstRunShowing = false
export const onboardingShowing = (): boolean => firstRunShowing

export function hookPreferences(d: { file: string; permissions: Permissions; ask: boolean; setLogin(on: boolean): void; setTrayVisible(on: boolean): void; setDockVisible(on: boolean): void; loginOn(saved: boolean | undefined): boolean; /** the Mac's full name */ macName(): string
  /** quit and open again, for a permission the Mac applies only then; false when it can't now (recording) */
  relaunch(): boolean
  /** the notes models in this build and whether this computer can run each (setup.ts) */
  notesModels?: () => Promise<NotesModelOption[]>
  /** notes models on disk that nothing uses, and deleting them (setup.ts works both out itself, never from the window) */
  unusedNotesModels?: () => { files: string[]; bytes: number }
  deleteUnusedNotesModels?: () => number
  /** a notes model was picked ('' is Automatic) and saved: get it and switch to it (setup.ts) */
  notesModelChosen?: (id: string) => void
  /** fake mode: a slow start, so tests see the launch screen */
  slowStartMs?: number
  /** the spoken language changed: the meeting being recorded follows it where it can */
  onSpoken?: (v: Spoken) => void
  /** the permissions this computer has (supportedKinds in platform.ts); a Mac has them all */
  kinds?: readonly PermissionKind[]; os?: string
  /** Windows and Linux: whether a calendar link is connected (the first run asks for one while none is) */
  calendarLinked?: () => boolean }) {
  const kinds = d.kinds ?? PERMISSION_KINDS
  const os = d.os ?? process.platform
  let plan: Promise<OnboardingPlan> | undefined
  // asked once per launch, so the list doesn't shrink under the person as they answer
  ipcMain.handle('onboarding:plan', () => (plan ??= (async () => {
    if (d.slowStartMs) await new Promise((r) => setTimeout(r, d.slowStartMs))
    const s = loadSettings(d.file)
    if (!d.ask || s.welcomed) return { intro: false, steps: [] }
    const p = await firstRunPlan({ ask: d.ask, welcomed: !!s.welcomed, introSeen: !!s.introSeen, status: await d.permissions.status(), kinds, ...(d.calendarLinked ? { calendarLink: { linked: d.calendarLinked() } } : {}) })
    firstRunShowing = p.intro || p.steps.length > 0
    return p
  })()))
  ipcMain.handle('onboarding:intro-seen', () => { updateSettings(d.file, { introSeen: true }) })
  ipcMain.handle('onboarding:done', () => { firstRunShowing = false; updateSettings(d.file, { welcomed: true }) })
  // home's Finish setup: what wasn't put away (fake mode, like the first run, only when a test sets the permissions)
  ipcMain.handle('onboarding:nudge', async () => (d.ask ? nudge(await d.permissions.status(), loadSettings(d.file).setupDismissed ?? [], kinds) : []))
  ipcMain.handle('onboarding:dismiss-nudge', async () => {
    updateSettings(d.file, { setupDismissed: missing(await d.permissions.status(), kinds).map((m) => m.kind) })
  })
  ipcMain.handle('onboarding:restore-nudge', () => { updateSettings(d.file, { setupDismissed: [] }) })
  ipcMain.handle('permissions:relaunch', () => d.relaunch())
  ipcMain.handle('permissions:status', () => d.permissions.status())
  ipcMain.handle('permissions:request', (_e, k: unknown) => (isKind(k) ? d.permissions.request(k) : 'unknown'))
  ipcMain.handle('permissions:open', (_e, k: unknown) => { if (isKind(k)) return d.permissions.openSettings(k) })
  ipcMain.handle('settings:get', () => {
    const s = loadSettings(d.file)
    const visible = visibilityOf(s)
    // what the Mac says, so a change in System Settings shows here
    // locale: every window (main, card, widget) shows the interface language
    // language: the one picked ('' is the Mac's); locale: the one in use; systemLocale: the Mac's, for the picker
    return { theme: s.theme ?? 'system', openAtLogin: d.loginOn(s.openAtLogin), showInMenuBar: s.showInMenuBar !== false, appVisibility: !visible.showInMenuBar ? 'dock' : visible.showInDock ? 'both' : 'menu-bar', language: isLocale(s.language) ? s.language : '', locale: localeOf(s, systemLocale()), systemLocale: systemLocale(), myName: s.myName?.trim() || d.macName(), macName: d.macName(), stopWhenCallEnds: stopsWhenCallEnds(s), recordingReminder: recordingReminderOn(s), keepRecordings: s.keepRecordings !== false, jargon: cleanJargon(s.jargon), spoken: spokenSetting(s), summaryLanguage: summaryLanguageSetting(s), notesModelId: s.notesModelId ?? '' }
  })
  ipcMain.handle('settings:notes-models', async () => (d.notesModels ? d.notesModels() : []))
  ipcMain.handle('settings:unused-models', () => { const u = d.unusedNotesModels?.() ?? { files: [], bytes: 0 }; return { count: new Set(u.files.map((f) => f.replace(/\.(ok|part)$/, ''))).size, bytes: u.bytes } })
  ipcMain.handle('settings:delete-unused-models', () => d.deleteUnusedNotesModels?.() ?? 0)
  // '' lets Yogurt choose; anything else must be a model in this build (an unknown id is ignored, never stored)
  ipcMain.handle('settings:notes-model', async (_e, v: unknown) => {
    if (typeof v !== 'string') return
    if (v !== '' && !(await (d.notesModels?.() ?? Promise.resolve([]))).some((m) => m.id === v)) return
    updateSettings(d.file, { notesModelId: v || undefined })
    // the pick takes effect now: it downloads (progress in Settings) and the notes switch to it when it is in
    d.notesModelChosen?.(v)
  })
  // what the person is called in meetings (who "You" is when naming voices); blank: the Mac's full name again
  ipcMain.handle('settings:name', (_e, v: unknown) => {
    if (typeof v !== 'string') return
    const name = v.replace(/\s+/g, ' ').trim().slice(0, 80)
    updateSettings(d.file, { myName: name && name !== d.macName() ? name : undefined })
  })
  // the interface language, applied at once: main's menus and notices, and every open window ('' is the Mac's)
  ipcMain.handle('settings:language', (_e, v: unknown) => {
    if (v !== '' && !isLocale(v)) return
    const locale = localeOf(updateSettings(d.file, { language: v || undefined }), systemLocale())
    setLanguage(locale)
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('settings:language', locale)
    return locale
  })
  ipcMain.handle('settings:summary-language', (_e, v: unknown) => {
    if (v !== '' && !isLocale(v)) return
    updateSettings(d.file, { summaryLanguage: v || undefined })
  })
  ipcMain.handle('settings:theme', (_e, v: unknown) => {
    if (v !== 'light' && v !== 'dark' && v !== 'system') return
    nativeTheme.themeSource = v
    updateSettings(d.file, { theme: v === 'system' ? undefined : v })
  })
  // on is the default, so only off is written down
  ipcMain.handle('settings:auto-stop', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return
    updateSettings(d.file, { stopWhenCallEnds: on ? undefined : false })
  })
  ipcMain.handle('settings:recording-reminder', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return
    updateSettings(d.file, { recordingReminder: on ? undefined : false })
  })
  ipcMain.handle('settings:keep-recordings', (_e, on: unknown) => {
    if (typeof on !== 'boolean') return
    const s = loadSettings(d.file)
    updateSettings(d.file, { keepRecordings: on ? undefined : false,
      recordingsOffAt: on ? undefined : s.keepRecordings === false && s.recordingsOffAt != null ? s.recordingsOffAt : Date.now() })
  })
  // the whole list each time, cleaned the same way the page cleans it; what was kept comes back
  ipcMain.handle('settings:jargon', (_e, v: unknown) => {
    const jargon = cleanJargon(v)
    updateSettings(d.file, { jargon: jargon.length ? jargon : undefined })
    return jargon
  })
  // English only is the default, so only Multi-language is written down
  ipcMain.handle('settings:spoken', (_e, v: unknown) => {
    if (!SPOKEN.includes(v as Spoken)) return
    updateSettings(d.file, { spoken: v === 'multi' ? 'multi' : undefined })
    d.onSpoken?.(v as Spoken)
  })
  ipcMain.handle('settings:menu-bar', (_e, on: unknown) => {
    if (os === 'darwin' || typeof on !== 'boolean') return
    updateSettings(d.file, { showInMenuBar: on ? undefined : false })
    d.setTrayVisible(on)
  })
  ipcMain.handle('settings:visibility', (_e, choice: unknown) => {
    if (os !== 'darwin' || (choice !== 'both' && choice !== 'menu-bar' && choice !== 'dock')) return
    const menuBar = choice !== 'dock', dock = choice !== 'menu-bar'
    // Show the kept entry points before saving or hiding either one.
    if (menuBar) d.setTrayVisible(true)
    if (dock) d.setDockVisible(true)
    updateSettings(d.file, { showInMenuBar: menuBar ? undefined : false, showInDock: dock ? undefined : false })
    if (!menuBar) d.setTrayVisible(false)
    if (!dock) d.setDockVisible(false)
  })
  ipcMain.handle('settings:login', (_e, on: unknown) => {
    const yes = on === true
    updateSettings(d.file, { openAtLogin: yes })
    d.setLogin(yes)
  })
}

