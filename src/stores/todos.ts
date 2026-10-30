import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '../platform'

export interface Todo {
  id: string
  projectId: string
  text: string
  done: boolean
  position: number
  createdAt: string
  doneAt: string | null
}

/** Checklist written by hand by the user, per project. It has nothing to do
 *  with the pragma protocol phases (PLAN/STEP_COMPLETE), which tell what the model is
 *  doing inside a session: only the user writes here, and the list
 *  survives all the project's sessions. */
export const useTodoStore = defineStore('todos', () => {
  const items = ref<Todo[]>([])
  /** Project whose content `items` is. */
  const loadedProjectId = ref<string | null>(null)
  /** Counter of refreshes in flight: two project switches in quick succession can make
   *  answers come back out of order, and without this guard the previous
   *  project's list would overwrite the right one. */
  let requestSeq = 0

  const openCount = computed(() => items.value.filter(t => !t.done).length)
  const doneCount = computed(() => items.value.filter(t => t.done).length)

  async function refresh(projectId: string | null) {
    const seq = ++requestSeq
    if (!projectId) {
      items.value = []
      loadedProjectId.value = null
      return
    }
    const rows = await invoke<Todo[]>('list_todos', { projectId })
    if (seq !== requestSeq) return
    items.value = rows
    loadedProjectId.value = projectId
  }

  async function add(projectId: string, text: string) {
    const row = await invoke<Todo>('create_todo', { projectId, text })
    if (loadedProjectId.value === projectId) items.value = [...items.value, row]
    return row
  }

  /** Optimistic: the check must respond under the finger. If the DB refuses it is
   *  put back as it was instead of leaving the UI to lie. */
  async function toggle(id: string) {
    const t = items.value.find(x => x.id === id)
    if (!t) return
    const next = !t.done
    t.done = next
    t.doneAt = next ? new Date().toISOString() : null
    try {
      await invoke('set_todo_done', { id, done: next })
    } catch (e) {
      t.done = !next
      t.doneAt = !next ? new Date().toISOString() : null
      throw e
    }
  }

  async function edit(id: string, text: string) {
    const trimmed = text.trim()
    const t = items.value.find(x => x.id === id)
    if (!t || !trimmed || trimmed === t.text) return
    const previous = t.text
    t.text = trimmed
    try {
      await invoke('update_todo_text', { id, text: trimmed })
    } catch (e) {
      t.text = previous
      throw e
    }
  }

  async function remove(id: string) {
    await invoke('delete_todo', { id })
    items.value = items.value.filter(t => t.id !== id)
  }

  async function clearDone(projectId: string) {
    await invoke<number>('clear_done_todos', { projectId })
    items.value = items.value.filter(t => !t.done)
  }

  return { items, openCount, doneCount, refresh, add, toggle, edit, remove, clearDone }
})
