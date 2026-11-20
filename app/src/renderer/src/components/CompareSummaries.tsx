import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { SummaryCompare } from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { Editor } from './Editor'
import { Modal, ModalClose } from './Modal'

/** The model's file name, or a plain word when nothing recorded it (summaries from before this existed) */
const modelName = (model: string) => model || t('Unknown model')

/**
 * The current summary beside an earlier one it replaced, to see what a different notes model made of the same meeting.
 * Read-only: nothing here changes the note. Earlier versions are kept when a summary is regenerated.
 */
export function CompareSummaries({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const [data, setData] = useState<SummaryCompare>()
  const [pick, setPick] = useState<number>()
  useEffect(() => {
    let live = true
    void window.yogurt.notes.compare(meetingId).then((d) => { if (live) { setData(d); setPick(d.earlier[0]?.id) } })
    return () => { live = false }
  }, [meetingId])
  const earlier = data?.earlier.find((v) => v.id === pick)
  const stamp = (at: number) => new Date(at).toLocaleString()
  return (
    <Modal testId="compare-summaries" title={t('Compare summaries')} onCancel={onClose}>
      <div style={{ width: 'min(1000px, 86vw)' }} className="flex flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <section data-testid="compare-earlier" aria-labelledby="compare-earlier-title" className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <h3 id="compare-earlier-title" className="text-sm font-medium">{t('Earlier version')}</h3>
              {data && data.earlier.length > 1 && (
                <span className="settings-select-wrap">
                  <select data-testid="compare-earlier-pick" aria-label={t('Earlier version')} value={pick ?? ''} onChange={(e) => setPick(Number(e.target.value))} className="settings-select">
                    {data.earlier.map((v) => <option key={v.id} value={v.id}>{`${modelName(v.model)} · ${stamp(v.at)}`}</option>)}
                  </select>
                  <ChevronDown size={14} aria-hidden="true" />
                </span>
              )}
            </div>
            <p data-testid="compare-earlier-model" className="text-muted text-xs">{earlier ? `${modelName(earlier.model)} · ${stamp(earlier.at)}` : ''}</p>
            <div className="max-h-[60vh] overflow-auto">
              {earlier && <Editor key={earlier.id} testId="compare-earlier-text" label={t('Earlier version')} markdown={earlier.text} editable={false} />}
            </div>
          </section>
          <section data-testid="compare-current" aria-labelledby="compare-current-title" className="flex min-w-0 flex-col gap-2">
            <h3 id="compare-current-title" className="text-sm font-medium">{t('Current')}</h3>
            <p data-testid="compare-current-model" className="text-muted text-xs">{data ? modelName(data.current.model) : ''}</p>
            <div className="max-h-[60vh] overflow-auto">
              {data && <Editor testId="compare-current-text" label={t('Current')} markdown={data.current.text} editable={false} />}
            </div>
          </section>
        </div>
        <div className="modal-actions">
          <ModalClose data-testid="compare-close" data-dialog-cancel className="workspace-button">{t('Close')}</ModalClose>
        </div>
      </div>
    </Modal>
  )
}
