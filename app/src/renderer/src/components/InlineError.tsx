import { t } from '../../../shared/i18n'
import type { ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'

/** Keep recovery beside the affected content, without hiding the content that was kept. */
export function InlineError({ testId, warningTestId, className = '', children, retry }: {
  testId: string; warningTestId?: string; className?: string; children?: ReactNode; retry?: () => void
}) {
  return <div data-testid={testId} data-state="failed" role="alert" className={`inline-error ${className}`}>
    <TriangleAlert data-testid={warningTestId} size={15} strokeWidth={1.75} aria-hidden="true" />
    {children ?? <span>{t("Couldn't load this content.")}</span>}
    {retry && <button type="button" className="workspace-button" onClick={retry}>{t('Try again')}</button>}
  </div>
}
