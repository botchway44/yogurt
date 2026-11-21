import { describe, expect, it } from 'vitest'
import { DUCKED, EchoDucker } from '../src/shared/echoDuck'

/** a made-up talk: bursts of speech with pauses, as a loudness per 20 ms frame (speech 0.1 to 0.3, pauses 0) */
function theirs(frames: number, seed = 1): number[] {
  let x = seed
  const rnd = () => { x = (x * 1664525 + 1013904223) % 4294967296; return x / 4294967296 }
  const out: number[] = []
  while (out.length < frames) {
    const burst = 20 + Math.floor(rnd() * 60), pause = 15 + Math.floor(rnd() * 40)
    for (let i = 0; i < burst; i++) out.push(0.1 + rnd() * 0.2)
    for (let i = 0; i < pause; i++) out.push(0)
  }
  return out.slice(0, frames)
}
/** the mic: their voice from the speakers `lag` frames late at `size` of its loudness, plus your own voice (per frame) */
const mic = (them: number[], lag: number, size: number, you: number[]) => them.map((_, i) => (i >= lag ? them[i - lag]! * size : 0) + (you[i] ?? 0))

/** plays frames through the ducker; the volume it gave each */
const run = (them: number[], me: number[]) => { const d = new EchoDucker(); return them.map((t, i) => d.push(t, me[i]!)) }

describe('echo dip: the mic dips only while it holds nothing but the other side leaking in', () => {
  const N = 3000, them = theirs(N)

  it('dips the mic where it is only their voice, a moment late and as loud (the Teams recording)', () => {
    const g = run(them, mic(them, 16, 1, []))
    const late = g.slice(1000)
    const heard = late.filter((_, i) => them[1000 + i - 16]! > 0.004)
    expect(heard.length).toBeGreaterThan(200)
    expect(heard.filter((v) => v === DUCKED).length / heard.length).toBeGreaterThan(0.95)
  })

  it('keeps your voice where they are silent', () => {
    // you speak only in pauses of theirs that are long past their last word's echo
    const you = them.map((t, i) => (t === 0 && them.slice(Math.max(0, i - 30), i).every((v) => v === 0) ? 0.2 : 0))
    const g = run(them, mic(them, 16, 1, you))
    const spoken = g.map((v, i) => [v, you[i]!] as const).filter(([, y], i) => y > 0 && i > 1000)
    expect(spoken.length).toBeGreaterThan(100)
    expect(spoken.every(([v]) => v === 1)).toBe(true)
  })

  it('keeps your voice when you talk over them: the mic is clearly louder than the leak', () => {
    const you = them.map((_, i) => (i % 200 < 100 ? 0.5 : 0))
    const g = run(them, mic(them, 16, 1, you))
    const over = g.filter((_, i) => i > 1000 && them[i - 16]! > 0.004 && you[i]! > 0)
    expect(over.length).toBeGreaterThan(100)
    expect(over.filter((v) => v === 1).length / over.length).toBeGreaterThan(0.9)
  })

  it('does nothing when the leak is faint (the Zoom recording: about a third of their voice)', () => {
    expect(run(them, mic(them, 3, 0.33, [])).every((v) => v === 1)).toBe(true)
  })

  it('does nothing with no leak at all (headphones)', () => {
    const you = them.map((_, i) => (i % 300 < 120 ? 0.3 : 0))
    expect(run(them, you).every((v) => v === 1)).toBe(true)
  })

  it('finds the delay of the leak', () => {
    const d = new EchoDucker()
    const m = mic(them, 16, 1, [])
    them.forEach((t, i) => d.push(t, m[i]!))
    expect(d.delayMs()).toBe(16 * 20)
  })

  it('keeps the delay across a change of speed, and starts fresh after a seek', () => {
    const d = new EchoDucker()
    const m = mic(them, 16, 1, [])
    them.forEach((t, i) => d.push(t, m[i]!))
    d.speed(2)
    expect(d.delayMs()).toBe(320)
    // at twice the speed the same delay is half the frames: it still dips from the first frame
    const t2 = theirs(400, 7), m2 = mic(t2, 8, 1, [])
    const g = t2.map((t, i) => d.push(t, m2[i]!, 2))
    expect(g.slice(100).some((v) => v === DUCKED)).toBe(true)
    d.seeked()
    expect(d.push(0.2, 0.2)).toBe(1)
  })
})
