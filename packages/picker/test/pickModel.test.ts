import { describe, expect, it } from 'vitest'
import { pick, pickModel } from '../src/pick'
import { machines, models } from './fixtures'

describe('pickModel', () => {
  it('gives the model the person chose, even when the automatic pick would be a different one', () => {
    const auto = pick(machines.m4max128, models).recommended!
    const other = models.find((m) => m.id !== auto.model.id && pickModel(machines.m4max128, models, m.id))!
    expect(pickModel(machines.m4max128, models, other.id)?.model.id).toBe(other.id)
    expect(auto.model.id).not.toBe(other.id)
  })
  it('is null for a model that does not fit this computer (M1 Max 32GB: 120B needs more memory)', () => {
    expect(pickModel(machines.m1max32, models, 'gpt-oss-120b')).toBeNull()
  })
  it('is null for an id that is not in the catalog', () => {
    expect(pickModel(machines.m4max128, models, 'no-such-model')).toBeNull()
  })
  it('does not filter on speed: a slow model that fits is still given (unlike pick, which hides it)', () => {
    const dense = { ...models[4], id: 'dense-32b', builds: [{ ...models[4].builds[0], sizeGB: 12, paramsB: 32, activeParamsB: 32 }] }
    expect(pick(machines.cpu32, [...models, dense]).unavailable.find((u) => u.model.id === 'dense-32b')?.reason).toBe('slow')
    expect(pickModel(machines.cpu32, [...models, dense], 'dense-32b')?.model.id).toBe('dense-32b')
  })
})
