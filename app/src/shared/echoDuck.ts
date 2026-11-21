/**
 * Playback only: without headphones the mic hears the other side from the speakers, so on a recording their voice is on
 * both tracks (theirs clean, and again on the mic's a moment later). Played together they sound like one person talking
 * twice. The recording is never changed; the player turns the mic's volume down while the mic holds nothing but that leak.
 *
 * Fed the loudness of both tracks every FRAME_MS, it finds how late the leak runs (the delay at which the mic's loudness
 * follows theirs best), how loud the leak is next to their voice, and answers with the mic's volume: down while the mic is
 * no louder than that leak, full when it is clearly louder (you, speaking over them). With no leak found (headphones,
 * or a call that never leaked) it never turns anything down.
 */
export const FRAME_MS = 20
/** how much loudness history the delay is found from */
const HISTORY = 400
/** the longest delay looked for: a speaker to a mic plus an app's own delay is well under this */
const MAX_LAG_MS = 800
/** the delay is found again this often */
const REFIT_EVERY = 50
/** a mic that follows theirs less than this (0 to 1) has no leak worth removing */
const MIN_FOLLOW = 0.35
/** frames with their voice quieter than this carry no leak to compare */
const QUIET = 0.004
/** a leak quieter than this next to their voice (Zoom's was about a third) isn't heard as a second voice: left alone */
const AUDIBLE = 0.5
/** the mic is "you on top" when louder than the leak would be by this much */
const ON_TOP = 1.6
/** how far the mic is turned down while it is only the leak (not silence: it is a gentle dip, never a gate) */
export const DUCKED = 0.1
/** at least this many frames of history before a delay is trusted */
const MIN_HISTORY = 150

const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0 }

export class EchoDucker {
  private me: number[] = []
  private them: number[] = []
  private n = 0
  /** the leak's delay and size, once found */
  private lag: number | null = null
  private size = 0
  /** the delay in media time, so it survives a change of speed and a seek */
  private lagMs: number | null = null
  /** the delay the last check found: acted on only when the next check finds the same (a chance match comes once) */
  private candidate: number | null = null

  /** the leak's delay in ms of recording time, once found */
  delayMs(): number | null { return this.lagMs }

  /** a seek: what was heard before no longer leads into what is heard next */
  seeked(): void { this.me = []; this.them = []; this.n = 0; this.candidate = null }

  /** a new playback speed: the delay stays the same in the recording, so it is more or fewer frames */
  speed(rate: number): void {
    this.seeked()
    this.lag = this.lagMs === null ? null : Math.round(this.lagMs / (FRAME_MS * rate))
  }

  /** loudness (RMS, 0 to 1) of both tracks now; the volume the mic should have (DUCKED to 1) */
  push(them: number, me: number, rate = 1): number {
    this.me.push(me); this.them.push(them)
    if (this.me.length > HISTORY) { this.me.shift(); this.them.shift() }
    if (++this.n % REFIT_EVERY === 0 && this.me.length >= MIN_HISTORY) this.fit(rate)
    if (this.lag === null) return 1
    const at = this.them.length - 1 - this.lag
    const theirs = at >= 0 ? this.them[at]! : 0
    if (theirs < QUIET || this.size < AUDIBLE) return 1
    return me <= this.size * theirs * ON_TOP + QUIET ? DUCKED : 1
  }

  /** the delay with the mic's loudness following theirs best, and the leak's size there */
  private fit(rate: number): void {
    const n = this.me.length, max = Math.round(MAX_LAG_MS / (FRAME_MS * rate))
    const mean = (v: number[], from: number, to: number) => { let s = 0; for (let i = from; i < to; i++) s += v[i]!; return s / (to - from) }
    let best = -1, bestLag = 0
    for (let lag = 0; lag <= max; lag++) {
      const from = lag, to = n
      if (to - from < 50) break
      const mm = mean(this.me, from, to), mt = mean(this.them, from - lag, to - lag)
      let c = 0, vm = 0, vt = 0
      for (let i = from; i < to; i++) { const a = this.me[i]! - mm, b = this.them[i - lag]! - mt; c += a * b; vm += a * a; vt += b * b }
      const r = vm > 0 && vt > 0 ? c / Math.sqrt(vm * vt) : 0
      if (r > best) { best = r; bestLag = lag }
    }
    if (best < MIN_FOLLOW) { this.lag = null; this.lagMs = null; this.candidate = null; return }
    // the leak's size: the median ratio of the mic to their voice at that delay, which a few frames of you speaking don't move
    const ratios: number[] = []
    for (let i = bestLag; i < n; i++) { const t = this.them[i - bestLag]!; if (t >= QUIET) ratios.push(this.me[i]! / t) }
    if (ratios.length < 20) { this.lag = null; this.lagMs = null; this.candidate = null; return }
    const same = this.candidate !== null && Math.abs(this.candidate - bestLag) <= 1
    this.candidate = bestLag
    if (!same) return
    this.lag = bestLag; this.lagMs = bestLag * FRAME_MS * rate; this.size = median(ratios)
  }
}
