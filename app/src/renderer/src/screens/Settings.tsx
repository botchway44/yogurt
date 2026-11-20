import { LoadingContent } from '../components/LoadingContent'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Copy, Cpu, Download, ExternalLink, Globe, Lock, Upload, FileText } from 'lucide-react'
import type { Access, AppVisibility, McpStatus, NotesModelOption, PermissionKind, PermissionStatus, SetupState, Theme, UnusedModels, UpdateStatus } from '../../../shared/types'
import { notesDownloadText, notesPercent, notesUpgradeSize } from '../notesSetup'
import { permissionCopy } from '../permissionCopy'
import { LOCALES, t } from '../../../shared/i18n'
import { onMac, osWords } from '../keys'
import { applyLanguage } from '../i18n'
import { flushOpenNotes } from '../noteAutosave'
import { Jargon } from '../components/Jargon'
import { SpokenSetting } from '../components/SpokenSetting'
import { useScrollMemory } from '../useScrollMemory'
import { appShortcuts } from '../components/Shortcuts'
import { CalendarSettings } from '../components/CalendarSettings'
import { supportedKinds, settingsPage } from '../../../shared/platform'
import { Swap, SwapText } from '../components/Swap'

const THEMES = () => [['system', osWords({ mac: t('Match my Mac'), windows: t('Match Windows'), linux: t('Match my system') })], ['light', t('Light')], ['dark', t('Dark')]] as const
// each computer's own words for starting at login and its icon's place: the menu bar, the notification area, the tray
const loginLabel = () => osWords({ mac: t('Open Yogurt when your Mac starts'), windows: t('Open Yogurt when Windows starts'), linux: t('Open Yogurt when you log in') })
const trayLabel = () => window.yogurt.os === 'win32' ? t('Show Yogurt in the notification area') : t('Show Yogurt in the tray')

/** Settings, kept small: what Yogurt may use, your name, open at login, stop when the call ends, light or dark, a backup and updates. Nothing technical. */
/** focus: the setting a toast's Settings button opens, recordings or notes-model */
export function Settings({ revision = 0, focus }: { revision?: number; focus?: string }) {
  const [perms, setPerms] = useState<PermissionStatus>()
  const [prefs, setPrefs] = useState<{ theme: Theme; openAtLogin: boolean; showInMenuBar: boolean; appVisibility: AppVisibility; myName: string; macName: string; stopWhenCallEnds: boolean; recordingReminder: boolean; keepRecordings: boolean }>()
  const [name, setName] = useState('')
  const [generalReady, setGeneralReady] = useState(false)
  const scroll = useScrollMemory<HTMLDivElement>('settings', !!prefs && !!perms)
  useEffect(() => { void window.yogurt.settings.get().then(setPrefs) }, [revision])
  const reload = useCallback(() => { void window.yogurt.permissions.status().then(setPerms) }, [])
  useEffect(() => {
    reload()
    void window.yogurt.settings.get().then((p) => { setPrefs(p); setName(p.myName) })
    // back from System Settings: show what changed there
    window.addEventListener('focus', reload)
    return () => window.removeEventListener('focus', reload)
  }, [reload])
  const theme = (v: Theme) => { setPrefs((p) => p && { ...p, theme: v }); void window.yogurt.settings.setTheme(v) }
  /** saved when they leave the field or press Return; blank goes back to the Mac's name */
  const saveName = () => {
    if (!prefs) return
    const clean = name.replace(/\s+/g, ' ').trim()
    const next = clean || prefs.macName
    setName(next); setPrefs({ ...prefs, myName: next })
    void window.yogurt.settings.setName(clean)
  }
  const login = () => {
    if (!prefs) return
    const on = !prefs.openAtLogin
    setPrefs({ ...prefs, openAtLogin: on }); void window.yogurt.settings.setOpenAtLogin(on)
  }
  const autoStop = () => {
    if (!prefs) return
    const on = !prefs.stopWhenCallEnds
    setPrefs({ ...prefs, stopWhenCallEnds: on }); void window.yogurt.settings.setStopWhenCallEnds(on)
  }
  const menuBar = async () => {
    if (!prefs) return
    await window.yogurt.settings.setShowInMenuBar(!prefs.showInMenuBar)
    setPrefs(await window.yogurt.settings.get())
  }
  const visibility = async (choice: AppVisibility) => {
    await window.yogurt.settings.setAppVisibility(choice)
    setPrefs(await window.yogurt.settings.get())
  }

  return (
    <div data-testid="settings" className="settings-screen">
      <div className="settings-titlebar-space" />
      <div className="settings-scroll" ref={scroll}>
        <div className="settings-content">
          <h1 data-testid="settings-heading" className="settings-heading">{t('Settings')}</h1>

          <h2 className="settings-section-heading">{t('General')}</h2>
          <div className="settings-group"><LoadingContent pending={!prefs} testId="settings-loading" onReady={() => setGeneralReady(true)}>
            <div className="settings-row">
              <label htmlFor="settings-theme" className="settings-label settings-row-copy">{t('Appearance')}</label>
              <span className="settings-select-wrap">
                <select id="settings-theme" data-testid="settings-theme" value={prefs?.theme ?? 'system'} disabled={!prefs}
                  onChange={(e) => theme(e.target.value as Theme)} className="settings-select">
                  {THEMES().map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </span>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <label htmlFor="settings-name" className="settings-label">{t('Your name')}</label>
                <p className="settings-description">{t('Yogurt uses your name to identify you in calls.')}</p>
              </div>
              <input id="settings-name" data-testid="settings-name" value={name} maxLength={80} autoComplete="name" spellCheck={false}
                onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                className="settings-name-field" />
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-label">{loginLabel()}</p>
                <p className="settings-description">{t('It runs in the background, ready for your first call.')}</p>
              </div>
              <button data-testid="login-toggle" role="switch" aria-checked={!!prefs?.openAtLogin} aria-label={loginLabel()} onClick={login}
                className="settings-toggle">
                <span className="settings-toggle-knob" />
              </button>
            </div>
            {onMac() ? <div className="settings-row">
              <label htmlFor="settings-visibility" className="settings-label settings-row-copy truncate">{t('Show Yogurt in')}</label>
              <span className="settings-select-wrap">
                <select id="settings-visibility" data-testid="settings-visibility" value={prefs?.appVisibility ?? 'both'} disabled={!prefs}
                  onChange={(e) => void visibility(e.target.value as AppVisibility)} className="settings-select">
                  <option value="both">{t('Menu bar and Dock')}</option>
                  <option value="menu-bar">{t('Menu bar only')}</option>
                  <option value="dock">{t('Dock only')}</option>
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </span>
            </div> : <div className="settings-row">
              <p className="settings-label settings-row-copy truncate">{trayLabel()}</p>
              <button data-testid="menu-bar-toggle" role="switch" aria-checked={!!prefs?.showInMenuBar} aria-label={trayLabel()} onClick={menuBar}
                className="settings-toggle"><span className="settings-toggle-knob" /></button>
            </div>}
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-label">{t('Finish recording when the call ends')}</p>
                <p className="settings-description">{t('Automatically end the recording a few seconds after you hang up.')}</p>
              </div>
              <button data-testid="autostop-toggle" role="switch" aria-checked={!!prefs?.stopWhenCallEnds} aria-label={t('Finish recording when the call ends')} onClick={autoStop}
                className="settings-toggle">
                <span className="settings-toggle-knob" />
              </button>
            </div>
            <div className="settings-row">
              <div className="settings-row-copy">
                <p className="settings-label">{t('Recording reminder')}</p>
                <p className="settings-description">{t('Show a brief reminder when recording starts.')}</p>
              </div>
              <button data-testid="recording-reminder-toggle" role="switch" aria-checked={!!prefs?.recordingReminder} aria-label={t('Recording reminder')}
                onClick={() => { if (!prefs) return; const on = !prefs.recordingReminder; setPrefs({ ...prefs, recordingReminder: on }); void window.yogurt.settings.setRecordingReminder(on) }}
                className="settings-toggle"><span className="settings-toggle-knob" /></button>
            </div>
            <RecordingSetting reveal={focus === 'recordings' && generalReady && !!perms} on={prefs?.keepRecordings ?? true} disabled={!prefs} onChange={async on => {
              await window.yogurt.settings.setKeepRecordings(on)
              setPrefs(p => p && { ...p, keepRecordings: on })
            }} />
            <NotesModel reveal={focus === 'notes-model'} />
          </LoadingContent></div>

          <h2 className="settings-section-heading">{t('What Yogurt can use')}</h2>
          <LoadingContent pending={!perms}><ul className="settings-group">
            {supportedKinds(window.yogurt.capabilities).map((k) => <PermissionRow key={k} kind={k} status={perms?.[k]} onAsk={() => void window.yogurt.permissions.request(k).then(reload)} />)}
          </ul></LoadingContent>

          {window.yogurt.capabilities.calendar && <CalendarSettings />}

          <h2 className="settings-section-heading">{t('Language')}</h2>
          <div data-testid="settings-language" className="settings-group">
            <AppLanguage />
            <SummaryLanguage />
            <NotesModelPicker />
            <SpokenSetting />
            <Jargon />
          </div>

          <Backup />

          <AiApps />

          <Updates />

          <h2 className="settings-section-heading">{t('Keyboard shortcuts')}</h2>
          <dl data-testid="settings-shortcuts" className="settings-group settings-shortcuts">
            {appShortcuts().map(([label, keys]) =>
              <div className="settings-row" key={keys}><dt>{label}</dt><dd><kbd>{keys}</kbd></dd></div>)}
          </dl>

          <p className="settings-privacy"><Lock size={12} aria-hidden="true" />{t('Yogurt stores your meetings, notes and audio on this computer.')}</p>
        </div>
      </div>
    </div>
  )
}

function NotesModel({ reveal = false }: { reveal?: boolean }) {
  const [setup, setSetup] = useState<SetupState>()
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => { if (reveal && setup?.notesUpgradeBytes) row.current?.scrollIntoView({ block: 'center', behavior: 'instant' }) }, [reveal, setup?.notesUpgradeBytes])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let current = false, active = true
    const off = window.yogurt.setup.onState(state => { current = true; setSetup(state) })
    void window.yogurt.setup.state().then(state => { if (active && !current) setSetup(state) })
    return () => { active = false; off() }
  }, [])
  if (!setup?.notesUpgradeBytes) return null
  const downloading = setup.notesUpgradePending || setup.notesUpgradeDownloading
  const act = async () => {
    setBusy(true); setFailed(false)
    try {
      if (setup.notesUpgradeInstalled) await window.yogurt.setup.removeUpgrade()
      else if (downloading) await window.yogurt.setup.skipUpgrade()
      else await window.yogurt.setup.downloadUpgrade()
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <div ref={row} className={`settings-row${reveal ? ' settings-reveal' : ''}`} data-testid="settings-notes-model">
    <div className="settings-row-copy">
      <p className="settings-label">{t('Better notes model')}</p>
      <p className="settings-description">{setup.notesRestoreFraction !== undefined
        ? t('Getting the smaller model · {progress}', { progress: notesDownloadText(setup).detail })
        : downloading ? notesDownloadText(setup).detail : setup.notesUpgradeInstalled
        ? t('Removing this model restores the smaller one.')
        : t("More detailed, accurate notes. Replaces the current model, so you don't keep both.")}</p>
      {setup.notesRestoreFraction !== undefined && <p className="settings-description">{t('The larger model keeps running summaries and Ask until then, and is removed after.')}</p>}
      {setup.notesUpgradeError && <p className="settings-description">{setup.notesUpgradeError}</p>}
      {failed && <p role="alert" className="settings-description">{t("Yogurt couldn't change the notes model.")}</p>}
    </div>
    <button data-testid="settings-notes-model-action" className="workspace-button settings-action" aria-busy={busy || setup.notesUpgradeChanging} disabled={busy || setup.notesUpgradeChanging} onClick={() => void act()}>
      {setup.notesUpgradeInstalled ? (busy || setup.notesUpgradeChanging ? t('Removing…') : t('Remove')) : downloading ? t('Skip') : t('Download ({size} GB)', { size: notesUpgradeSize(setup.notesUpgradeBytes) })}
    </button>
  </div>
}

/** Settings → Language: the interface's language, the Mac's unless one is picked. It changes at once, in every window */
function AppLanguage() {
  const [s, setS] = useState<{ language: string; systemLocale: string }>()
  useEffect(() => { void window.yogurt.settings.get().then(setS) }, [])
  const pick = (language: string) => {
    setS((p) => p && { ...p, language })
    void window.yogurt.settings.setLanguage(language).then(applyLanguage)
  }
  const system = LOCALES.find((l) => l.id === s?.systemLocale)?.name ?? 'English'
  return (
    <LoadingContent pending={!s} testId="language-loading"><div className="settings-row">
      <span className="settings-permission-icon"><Globe size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-app-language" className="settings-label">{t('App language')}</label>
        <p className="settings-description">{t("This changes the language of Yogurt's menus and buttons.")}</p>
      </div>
      <span className="settings-select-wrap">
      <select id="settings-app-language" data-testid="settings-app-language" value={s?.language ?? ''} disabled={!s} onChange={(e) => pick(e.target.value)} className="settings-select">
        <option value="">{t('System language ({name})', { name: system })}</option>
        {/* each in its own name, so anyone can find theirs */}
        {LOCALES.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.name}</option>)}
      </select>
      <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div></LoadingContent>
  )
}

function SummaryLanguage() {
  const [language, setLanguage] = useState<string>()
  useEffect(() => { void window.yogurt.settings.get().then((s) => setLanguage(s.summaryLanguage)) }, [])
  const pick = (value: string) => {
    setLanguage(value)
    void window.yogurt.settings.setSummaryLanguage(value)
  }
  return (
    <LoadingContent pending={language === undefined}><div className="settings-row">
      <span className="settings-permission-icon"><FileText size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-summary-language" className="settings-label">{t('Summary language')}</label>
        <p id="settings-summary-language-description" className="settings-description">{t('Used for new summaries and when you write them again.')}</p>
      </div>
      <span className="settings-select-wrap">
        <select id="settings-summary-language" data-testid="settings-summary-language" aria-describedby="settings-summary-language-description" value={language ?? ''} disabled={language === undefined} onChange={(e) => pick(e.target.value)} className="settings-select">
          <option value="">{t('Same as the meeting')}</option>
          {LOCALES.map((l) => <option key={l.id} value={l.id} lang={l.id}>{l.name}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div></LoadingContent>
  )
}

/**
 * Which notes model writes the summaries: Yogurt's pick for this computer, or one the person chose. A pick downloads right
 * away, with its progress here, and the notes switch to it by themselves when it is in (no restart).
 */
function NotesModelPicker() {
  const [id, setId] = useState<string>()
  const [models, setModels] = useState<NotesModelOption[]>([])
  const [setup, setSetup] = useState<SetupState>()
  // models downloaded earlier that nothing uses now: offered for deleting, with a confirm
  const [unused, setUnused] = useState<UnusedModels>({ count: 0, bytes: 0 })
  const [confirming, setConfirming] = useState(false)
  const [freed, setFreed] = useState<number>()
  const refreshUnused = () => void window.yogurt.settings.unusedNotesModels().then(setUnused)
  useEffect(() => {
    void window.yogurt.settings.get().then((s) => setId(s.notesModelId))
    void window.yogurt.settings.notesModels().then(setModels)
    let current = false, active = true
    const off = window.yogurt.setup.onState((state) => { current = true; setSetup(state) })
    void window.yogurt.setup.state().then((state) => { if (active && !current) setSetup(state) })
    return () => { active = false; off() }
  }, [])
  const pick = (value: string) => {
    setId(value)
    void window.yogurt.settings.setNotesModel(value)
  }
  const sw = setup?.notesSwitch
  // a download starts or ends: what is unused changes (nothing is offered while one is going)
  useEffect(() => { setConfirming(false); refreshUnused() }, [!!sw])
  const removeUnused = async () => {
    setConfirming(false)
    setFreed(await window.yogurt.settings.deleteUnusedNotesModels())
    refreshUnused()
  }
  const minutes = sw && !sw.error && sw.etaSec !== undefined && Number.isFinite(sw.etaSec) && sw.etaSec > 0 ? Math.max(1, Math.round(sw.etaSec / 60)) : undefined
  const percent = sw && sw.totalBytes > 0 ? Math.floor(Math.max(0, Math.min(1, sw.fraction)) * 100) : undefined
  return (
    <LoadingContent pending={id === undefined}><div className="settings-row" data-testid="settings-notes-model-picker">
      <span className="settings-permission-icon"><Cpu size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <label htmlFor="settings-notes-model" className="settings-label">{t('Notes model')}</label>
        <p id="settings-notes-model-description" className="settings-description">{t('Downloads when you pick it, then switches by itself. Notes keep using the current model until it is ready.')}</p>
        {sw && (sw.error
          ? <div data-testid="notes-switch" data-failed="true">
              <p role="status" className="settings-description">{sw.error}</p>
              <button type="button" data-testid="notes-switch-retry" className="workspace-button" onClick={() => pick(id ?? '')}>{t('Try again')}</button>
            </div>
          : <div data-testid="notes-switch" data-model={sw.id}>
              <div className="notes-download-readout">
                <strong>{t('Downloading {name}', { name: sw.name })}</strong>
                <span>{minutes ? t('about {minutes} min left', { minutes }) : percent !== undefined ? notesPercent(sw.fraction) : ''}</span>
              </div>
              <div className="notes-download-progress" role="progressbar" aria-label={t('Downloading {name}', { name: sw.name })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <span style={{ width: `${percent ?? 0}%` }} />
              </div>
              <p className="settings-description">{t('{done} of {total} GB', { done: notesUpgradeSize(sw.totalBytes * sw.fraction), total: notesUpgradeSize(sw.totalBytes) })}</p>
            </div>)}
        {!sw && unused.bytes > 0 && <div data-testid="unused-models">
          <p className="settings-description">{t('{size} GB used by models you are not using', { size: notesUpgradeSize(unused.bytes) })}</p>
          {confirming
            ? <div className="mt-2 flex gap-2">
                <button type="button" data-testid="unused-delete-yes" className="workspace-button" onClick={() => void removeUnused()}>{t('Delete {size} GB', { size: notesUpgradeSize(unused.bytes) })}</button>
                <button type="button" data-testid="unused-delete-cancel" className="workspace-button" onClick={() => setConfirming(false)}>{t('Cancel')}</button>
              </div>
            : <button type="button" data-testid="unused-delete" className="workspace-button" onClick={() => { setFreed(undefined); setConfirming(true) }}>{t('Delete unused models')}</button>}
        </div>}
        {!sw && unused.bytes === 0 && freed !== undefined && freed > 0 && <p role="status" data-testid="unused-freed" className="settings-description">{t('Freed {size} GB', { size: notesUpgradeSize(freed) })}</p>}
      </div>
      <span className="settings-select-wrap">
        <select id="settings-notes-model" data-testid="settings-notes-model" aria-describedby="settings-notes-model-description" value={id ?? ''} disabled={id === undefined} onChange={(e) => pick(e.target.value)} className="settings-select">
          <option value="">{t('Automatic, the best for this computer')}</option>
          {models.map((m) => <option key={m.id} value={m.id} disabled={!m.fits}>{`${m.name} · ${m.sizeGB.toFixed(1)} GB${m.fits ? '' : ` · ${t('needs more memory')}`}`}</option>)}
        </select>
        <ChevronDown size={14} aria-hidden="true" />
      </span>
    </div></LoadingContent>
  )
}

export function PermissionRow({ kind, status, onAsk }: { kind: PermissionKind; status?: Access; onAsk(): void }) {
  const c = permissionCopy(kind)
  const Icon = c.icon
  const ask = status === 'unknown' && kind !== 'accessibility'
  const turnOn = ask || status === 'denied' && kind !== 'accessibility' && kind !== 'notifications'
  const granted = status === 'granted'
  return (
    <li data-testid="permission-row" data-kind={kind} data-status={status ?? ''} className="settings-row">
      <span className="settings-permission-icon"><Icon size={17} strokeWidth={1.75} aria-hidden="true" /></span>
      <div className="settings-row-copy">
        <p className="settings-permission-label">
          {c.name}
          {status && !(status === 'unknown' && turnOn) && <span data-testid="permission-status" className="settings-permission-status">
            {status === 'granted' ? t('On') : status === 'denied' ? t('Off') : status === 'unknown' ? t('Not set up')
              : status === 'asked' ? t('Check in Settings') : t('Managed by your organization')}
          </span>}
        </p>
        <p className="settings-description">{c.reason}</p>
      </div>
      {status !== 'restricted' && (ask || settingsPage(globalThis.window?.yogurt?.os ?? 'darwin', kind)) ? (
        <button data-testid={ask ? 'permission-ask' : 'permission-open'} onClick={ask ? onAsk : () => void window.yogurt.permissions.open(kind)}
          className={`workspace-button settings-action${granted ? '' : ' primary'}`}>
          <span>{!status || granted ? t('Manage') : turnOn ? t('Turn on') : osWords({ mac: t('Open System Settings'), other: t('Open Settings') })}</span>
          {!ask && <ExternalLink size={13} aria-hidden="true" className="shrink-0 rtl:-scale-x-100" />}
        </button>
      ) : null}
    </li>
  )
}

type Said = { kind: 'exported'; count: number } | { kind: 'imported'; added: number; skipped: number } | { kind: 'error'; text: string; meetingId?: string }

/** every meeting to one file, and back: for a new Mac or after reinstalling */
function Backup() {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState<'export' | 'import' | null>(null)
  const [said, setSaid] = useState<Said | null>(null)
  useEffect(() => {
    const check = () => void window.yogurt.backup.status().then((s) => setRecording(s.recording))
    check()
    return window.yogurt.meetings.onChange(check)
  }, [])
  const exportAll = async () => {
    setBusy('export'); setSaid(null)
    // A failed navigation handoff may still be retained by the renderer rather than main.
    if (!await flushOpenNotes().catch(() => false)) {
      setBusy(null); setSaid({ kind: 'error', text: t("Couldn't save your latest changes. Return to your note and try again.") }); return
    }
    const r = await window.yogurt.backup.export().catch(() => ({ ok: false, error: 'failed' } as const)).finally(() => setBusy(null))
    if (r.ok) setSaid({ kind: 'exported', count: r.meetings })
    else if (r.error === 'failed') setSaid({ kind: 'error', text: t("Couldn't save the backup. Try again, or pick another place.") })
    else if (r.error === 'unsaved') setSaid({ kind: 'error', text: t("Save your latest note changes before exporting a backup."), meetingId: r.meetingId })
  }
  const importAll = async () => {
    setBusy('import'); setSaid(null)
    const r = await window.yogurt.backup.import().catch(() => ({ ok: false, error: 'failed' } as const)).finally(() => setBusy(null))
    if (r.ok) { setSaid({ kind: 'imported', added: r.added, skipped: r.skipped }); return }
    const text = {
      cancelled: '', recording: t('You can import once the recording stops.'),
      newer: t('This backup is from a newer Yogurt. Update Yogurt, then try again.'),
      invalid: t("That file isn't a Yogurt backup."),
      failed: t("Couldn't import that backup. Try again."),
    }[r.error]
    if (text) setSaid({ kind: 'error', text })
  }
  const pill = 'workspace-button'
  return (
    <>
      <h2 className="settings-section-heading">{t('Backup')}</h2>
      <div data-testid="backup" className="settings-group settings-backup">
        <p className="settings-description">{t('You can back up meetings, notes, transcripts and saved audio in one file.')}</p>
        <div className="settings-backup-actions">
          <button data-testid="backup-export" disabled={!!busy} onClick={() => void exportAll()} className={pill}>
            <Download size={14} aria-hidden="true" className="text-muted" />{busy === 'export' ? t('Exporting…') : t('Export backup')}
          </button>
          <button data-testid="backup-import" disabled={!!busy || recording} onClick={() => void importAll()} className={pill}>
            <Upload size={14} aria-hidden="true" className="text-muted" />{busy === 'import' ? t('Importing…') : t('Import notes')}
          </button>
          {recording && <span data-testid="backup-wait" className="settings-description">{t('You can import once the recording stops.')}</span>}
        </div>
        <div aria-live="polite">
          {said && (
            <p data-testid="backup-said" data-kind={said.kind} className={`settings-backup-status ${said.kind === 'error' ? 'text-danger' : 'text-ink'}`}>
              {said.kind === 'exported' && <>
                <span className="flex items-center gap-1.5"><Check size={14} aria-hidden="true" className="text-muted" />{t('Exported {count} meetings', { count: said.count })}</span>
                <button data-testid="backup-show" onClick={() => window.yogurt.backup.show()} className="ghost-btn">{osWords({ mac: t('Show in Finder'), windows: t('Show in File Explorer'), linux: t('Show in Files') })}</button>
              </>}
              {said.kind === 'imported' && <span className="flex items-center gap-1.5"><Check size={14} aria-hidden="true" className="text-muted" />
                {said.added ? t('Added {count} meetings.', { count: said.added }) : t('Nothing new in this backup.')}
                {said.skipped > 0 && ' ' + t('{count} were already here.', { count: said.skipped })}</span>}
              {said.kind === 'error' && <>{said.text}{said.meetingId && <button data-testid="backup-open-note" className="ghost-btn" onClick={() => window.yogurt.nav.go(`/note/${said.meetingId}`)}>{t('Open note')}</button>}</>}
            </p>
          )}
        </div>
      </div>
    </>
  )
}

/** AI apps on this Mac reading meetings through MCP: off until turned on, with what that means */
function AiApps() {
  const [status, setStatus] = useState<McpStatus>()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void window.yogurt.mcp.status().then(setStatus)
    return window.yogurt.mcp.onClients((clients) => setStatus((s) => s && { ...s, clients }))
  }, [])
  const toggle = () => { if (status) { setStatus({ ...status, enabled: !status.enabled }); void window.yogurt.mcp.set(!status.enabled).then(setStatus) } }
  const copy = () => { if (status) void navigator.clipboard.writeText(status.command).then(() => setCopied(true)) }
  const on = !!status?.enabled
  return (
    <>
      <h2 className="settings-section-heading">{t('AI apps')}</h2>
      <LoadingContent pending={!status} testId="ai-apps-loading"><div data-testid="ai-apps" className="settings-group">
        <div className="settings-row">
          <div className="settings-row-copy">
            <p className="settings-label">{t('Let AI apps read your meetings')}</p>
            <p className="settings-description">{osWords({ mac: t('Apps on this Mac can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.'), other: t('Apps on this computer can read your meetings, notes, transcripts and recordings. If an app uses an online AI, what it reads goes to that AI.') })}</p>
          </div>
          <button data-testid="ai-apps-toggle" role="switch" aria-checked={on} aria-label={t('Let AI apps read your meetings')} onClick={toggle} className="settings-toggle">
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {on && status &&
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-description">{t('Copy this command and add it as a local MCP server in your AI app.')}</p>
              <div className="mt-3 flex min-w-0 items-center gap-2 rounded-md border border-line bg-bg p-1.5">
                <input data-testid="ai-apps-command" aria-label={t('MCP command')} dir="ltr" readOnly value={status.command} className="min-w-0 flex-1 bg-transparent px-2 font-mono text-[12px] text-muted" />
                <button data-testid="ai-apps-copy" onClick={copy} className="workspace-button shrink-0">
                  <Swap show={copied ? 'done' : 'copy'} options={{ copy: <Copy size={14} className="text-muted" />, done: <Check size={14} className="text-muted" /> }} /><SwapText text={copied ? t('Copied') : t('Copy')} widest={t('Copied')} />
                </button>
              </div>
              {status.clients.length > 0 && <p data-testid="ai-apps-clients" aria-live="polite" className="mt-3 text-[12px] leading-[18px] text-muted">
                {t('Connected apps · {apps}', { apps: [...new Set(status.clients)].join(', ') })}
              </p>}
            </div>
          </div>
        }
      </div></LoadingContent>
    </>
  )
}

/** the version, and in a build that updates itself: the switch, what it's doing, Check now, and Restart Yogurt once a new version is ready */
function Updates() {
  const [status, setStatus] = useState<UpdateStatus>()
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    void window.yogurt.updates.status().then(setStatus)
    return window.yogurt.updates.onStatus(setStatus)
  }, [])
  const toggle = () => { if (status) { setStatus({ ...status, on: !status.on }); void window.yogurt.updates.set(!status.on).then(setStatus) } }
  const restart = () => void window.yogurt.updates.restart().then((ok) => setBlocked(!ok))
  const said = status?.available ? {
    idle: '', latest: t('Up to date'), checking: t('Checking for updates…'), error: t("Couldn't check for updates."),
    downloading: t('Downloading version {version}…', { version: status.next ?? '' }), ready: t('Yogurt {version} is ready', { version: status.next ?? '' }),
  }[status.state] : ''
  return (
    <>
      <h2 className="settings-section-heading">{t('Updates')}</h2>
      <LoadingContent pending={!status} testId="updates-loading"><div data-testid="updates" className="settings-group">
        {status?.available &&
          <div className="settings-row">
            <div className="settings-row-copy">
              <p className="settings-label">{t('Update Yogurt automatically')}</p>
              <p className="settings-description">{t('New versions download in the background and install when you quit.')}</p>
            </div>
            <button data-testid="updates-toggle" role="switch" aria-checked={status.on} aria-label={t('Update Yogurt automatically')} onClick={toggle} className="settings-toggle">
              <span className="settings-toggle-knob" />
            </button>
          </div>}
        <div className="settings-row">
          <div className="settings-row-copy" aria-live="polite">
            <p data-testid="updates-version" className="settings-label">{t('Version {version}', { version: status?.version ?? '' })}</p>
            {said && <p data-testid="updates-state" data-state={status?.state} className="settings-description">{said}</p>}
            {blocked && <p className="settings-description">{t('You can restart once the recording stops.')}</p>}
          </div>
          {status?.state === 'ready' &&
            <button data-testid="updates-restart" onClick={restart} className="workspace-button settings-action primary">{t('Restart Yogurt')}</button>}
          {status?.available && status.on && (status.state === 'idle' || status.state === 'latest' || status.state === 'error') &&
            <button data-testid="updates-check" onClick={() => void window.yogurt.updates.check()} className="workspace-button settings-action">{status.state === 'error' ? t('Try again') : t('Check now')}</button>}
        </div>
      </div></LoadingContent>
    </>
  )
}

/** The recording preference uses the same switch row as the other meeting settings. */
export function RecordingSetting({ on, disabled, onChange, reveal = false }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => Promise<void>; reveal?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const row = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!reveal || disabled) return
    row.current?.scrollIntoView({ block: 'center', behavior: 'instant' })
    row.current?.querySelector<HTMLButtonElement>('[role="switch"]')?.focus({ preventScroll: true })
  }, [reveal, disabled])
  return <div ref={row} data-testid="recording-setting" className={`settings-row${reveal && !disabled ? ' settings-reveal' : ''}`}>
    <div className="settings-row-copy">
      <p className="settings-label">{t('Keep audio recordings after meetings')}</p>
      <p className="settings-description">{t("When off, new meetings' audio is deleted once the summary is saved.")}</p>
      {failed && <p role="alert" className="text-danger text-xs">{t("Couldn't save your changes")}</p>}
    </div>
    <button data-testid="keep-recordings-toggle" role="switch" aria-checked={on} aria-label={t('Keep audio recordings after meetings')}
      disabled={disabled || busy} onClick={async () => {
        setBusy(true); setFailed(false)
        try { await onChange(!on) } catch { setFailed(true) } finally { setBusy(false) }
      }} className="settings-toggle"><span className="settings-toggle-knob" /></button>
  </div>
}
