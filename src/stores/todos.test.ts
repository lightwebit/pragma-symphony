import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => undefined)
vi.mock('../platform', () => ({ invoke: (...a: unknown[]) => invoke(...(a as [string, unknown])) }))

import { useTodoStore, type Todo } from './todos'

function todo(init: Partial<Todo> = {}): Todo {
  return {
    id: 't1', projectId: 'p1', text: 'do the thing', done: false,
    position: 0, createdAt: '2026-08-16T10:00:00Z', doneAt: null,
    ...init,
  }
}

/** A promise resolvable by hand, to make two refreshes come back out of order. */
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

describe('todo store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    invoke.mockReset()
    invoke.mockImplementation(async () => undefined)
  })

  it('counts open and done separately', async () => {
    invoke.mockImplementation(async () => [
      todo({ id: 'a', done: false }),
      todo({ id: 'b', done: true }),
      todo({ id: 'c', done: false }),
    ])
    const s = useTodoStore()
    await s.refresh('p1')

    expect(s.openCount).toBe(2)
    expect(s.doneCount).toBe(1)
  })

  it('clears the list when no project is selected', async () => {
    invoke.mockImplementation(async () => [todo()])
    const s = useTodoStore()
    await s.refresh('p1')
    expect(s.items).toHaveLength(1)

    await s.refresh(null)

    expect(s.items).toHaveLength(0)
    // No backend query for "no project": the answer is known.
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale refresh that lands after a newer one', async () => {
    // Two project switches in quick succession: the first one's answer arrives last and
    // without the guard would overwrite the list of the project now selected.
    const slow = deferred<Todo[]>()
    const fast = deferred<Todo[]>()
    invoke.mockImplementationOnce(async () => slow.promise)
    invoke.mockImplementationOnce(async () => fast.promise)

    const s = useTodoStore()
    const first = s.refresh('p1')
    const second = s.refresh('p2')

    fast.resolve([todo({ id: 'new', projectId: 'p2', text: 'p2 item' })])
    await second
    slow.resolve([todo({ id: 'old', projectId: 'p1', text: 'p1 item' })])
    await first

    expect(s.items).toHaveLength(1)
    expect(s.items[0].text).toBe('p2 item')
  })

  it('appends a new todo to the end of the list', async () => {
    invoke.mockImplementationOnce(async () => [todo({ id: 'a', text: 'first' })])
    const s = useTodoStore()
    await s.refresh('p1')

    invoke.mockImplementationOnce(async () => todo({ id: 'b', text: 'second', position: 1 }))
    await s.add('p1', 'second')

    expect(s.items.map(t => t.text)).toEqual(['first', 'second'])
  })

  it('does not append a todo created for a different project', async () => {
    invoke.mockImplementationOnce(async () => [todo({ id: 'a' })])
    const s = useTodoStore()
    await s.refresh('p1')

    invoke.mockImplementationOnce(async () => todo({ id: 'z', projectId: 'p2' }))
    await s.add('p2', 'altrove')

    expect(s.items).toHaveLength(1)
  })

  it('toggles optimistically and rolls back when the backend refuses', async () => {
    invoke.mockImplementationOnce(async () => [todo({ id: 'a', done: false })])
    const s = useTodoStore()
    await s.refresh('p1')

    invoke.mockImplementationOnce(async () => { throw new Error('db locked') })
    await expect(s.toggle('a')).rejects.toThrow('db locked')

    expect(s.items[0].done).toBe(false)
    expect(s.items[0].doneAt).toBeNull()
    expect(s.openCount).toBe(1)
  })

  it('stamps and clears doneAt as the row is checked and unchecked', async () => {
    invoke.mockImplementationOnce(async () => [todo({ id: 'a', done: false })])
    const s = useTodoStore()
    await s.refresh('p1')

    await s.toggle('a')
    expect(s.items[0].done).toBe(true)
    expect(s.items[0].doneAt).not.toBeNull()

    await s.toggle('a')
    expect(s.items[0].done).toBe(false)
    expect(s.items[0].doneAt).toBeNull()
  })

  it('skips the round-trip when an edit changes nothing', async () => {
    invoke.mockImplementationOnce(async () => [todo({ id: 'a', text: 'same' })])
    const s = useTodoStore()
    await s.refresh('p1')
    invoke.mockClear()

    await s.edit('a', '  same  ')
    await s.edit('a', '   ')

    expect(invoke).not.toHaveBeenCalled()
    expect(s.items[0].text).toBe('same')
  })

  it('restores the previous text when an edit fails', async () => {
    invoke.mockImplementationOnce(async () => [todo({ id: 'a', text: 'before' })])
    const s = useTodoStore()
    await s.refresh('p1')

    invoke.mockImplementationOnce(async () => { throw new Error('too long') })
    await expect(s.edit('a', 'after')).rejects.toThrow('too long')

    expect(s.items[0].text).toBe('before')
  })

  it('clearDone keeps only the open rows', async () => {
    invoke.mockImplementationOnce(async () => [
      todo({ id: 'a', done: true }),
      todo({ id: 'b', done: false }),
      todo({ id: 'c', done: true }),
    ])
    const s = useTodoStore()
    await s.refresh('p1')

    invoke.mockImplementationOnce(async () => 2)
    await s.clearDone('p1')

    expect(s.items.map(t => t.id)).toEqual(['b'])
    expect(s.doneCount).toBe(0)
  })
})
