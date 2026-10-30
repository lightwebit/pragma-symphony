<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useTodoStore } from '../stores/todos'
import { useProjectStore } from '../stores/projects'
import { canCommand } from '../webCaps'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const todos = useTodoStore()
const projects = useProjectStore()

const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const error = ref<string | null>(null)
const busy = ref(false)

// Inline editing: non-null `editingId` = that row is an open input.
const editingId = ref<string | null>(null)
const editDraft = ref('')

const projectTitle = computed(() => projects.currentProject?.title ?? '')

watch(() => props.open, async (open) => {
  if (!open) {
    editingId.value = null
    error.value = null
    return
  }
  await todos.refresh(projects.currentProjectId ?? null)
  // The field takes focus on opening: the gesture is "open and type", not
  // "open, look for the field, click, type".
  await nextTick()
  inputRef.value?.focus()
})

async function run(fn: () => Promise<unknown>) {
  busy.value = true
  error.value = null
  try {
    await fn()
  } catch (e: any) {
    error.value = String(e)
  } finally {
    busy.value = false
  }
}

async function addTodo() {
  const text = draft.value.trim()
  const projectId = projects.currentProjectId
  if (!text || !projectId) return
  // Cleared right away: someone typing in bursts must not wait for the DB round trip
  // before the next item. On error the text goes back into the field.
  draft.value = ''
  await run(async () => {
    try {
      await todos.add(projectId, text)
    } catch (e) {
      draft.value = text
      throw e
    }
  })
  await nextTick()
  inputRef.value?.focus()
}

function startEdit(id: string, text: string) {
  editingId.value = id
  editDraft.value = text
}

async function commitEdit() {
  const id = editingId.value
  if (!id) return
  const text = editDraft.value
  editingId.value = null
  await run(() => todos.edit(id, text))
}

async function clearDone() {
  const projectId = projects.currentProjectId
  if (!projectId) return
  await run(() => todos.clearDone(projectId))
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" data-testid="todo-overlay" @click.self="emit('close')">
      <div class="todo-modal" tabindex="-1" @keydown.esc="emit('close')">
        <div class="todo-header">
          <span class="todo-title">to-do</span>
          <span v-if="projectTitle" class="todo-project">{{ projectTitle }}</span>
          <button class="todo-close" data-testid="todo-close" @click="emit('close')">×</button>
        </div>

        <div v-if="canCommand" class="todo-add">
          <input
            ref="inputRef"
            v-model="draft"
            class="todo-input"
            data-testid="todo-input"
            placeholder="what's left to do…"
            maxlength="500"
            @keydown.enter.prevent="addTodo"
          />
          <button class="todo-add-btn" data-testid="todo-add" :disabled="!draft.trim() || busy" @click="addTodo">add</button>
        </div>

        <div v-if="error" class="todo-error" data-testid="todo-error">{{ error }}</div>

        <div class="todo-list" data-testid="todo-list">
          <div v-if="!todos.items.length" class="todo-empty">
            Nothing here yet. This list belongs to the project, so it survives every session.
          </div>
          <div
            v-for="t in todos.items"
            :key="t.id"
            class="todo-row"
            :class="{ 'todo-row-done': t.done }"
            data-testid="todo-row"
          >
            <button
              class="todo-check"
              :class="{ 'todo-check-on': t.done }"
              :title="t.done ? 'Mark as not done' : 'Mark as done'"
              data-testid="todo-toggle"
              :disabled="!canCommand"
              @click="run(() => todos.toggle(t.id))"
            >{{ t.done ? '✓' : '' }}</button>

            <input
              v-if="editingId === t.id"
              v-model="editDraft"
              class="todo-edit-input"
              data-testid="todo-edit-input"
              maxlength="500"
              autofocus
              @keydown.enter.prevent="commitEdit"
              @keydown.esc.stop="editingId = null"
              @blur="commitEdit"
            />
            <span
              v-else
              class="todo-text"
              :title="canCommand ? 'Click to edit' : undefined"
              @click="canCommand && startEdit(t.id, t.text)"
            >{{ t.text }}</span>

            <button v-if="canCommand" class="todo-del" title="Delete" data-testid="todo-delete" @click="run(() => todos.remove(t.id))">×</button>
          </div>
        </div>

        <div class="todo-footer">
          <span class="todo-count" data-testid="todo-count">
            {{ todos.openCount }} open<template v-if="todos.doneCount"> · {{ todos.doneCount }} done</template>
          </span>
          <button
            v-if="todos.doneCount && canCommand"
            class="todo-clear"
            data-testid="todo-clear-done"
            :disabled="busy"
            @click="clearDone"
          >clear done</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 800;
  background: rgba(20, 22, 28, 0.72);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
}

.todo-modal {
  width: min(480px, 92vw);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0,0,0,0.5);
  display: flex;
  flex-direction: column;
  max-height: 80vh;
}

.todo-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-card);
}

.todo-title {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-atom-code);
}

.todo-project {
  flex: 1;
  font-size: 0.74rem;
  color: var(--text-secondary);
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1.1rem;
  padding: 0 4px;
  line-height: 1;
  margin-left: auto;
}
.todo-close:hover { color: var(--text-primary); }

.todo-add {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.todo-input {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 6px 10px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.85rem;
  outline: none;
}
.todo-input:focus { border-color: var(--color-atom-code); }
.todo-input::placeholder { color: var(--text-secondary); opacity: 0.5; }

.todo-add-btn {
  padding: 4px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.78rem;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.todo-add-btn:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-secondary); }
.todo-add-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.todo-error {
  padding: 8px 16px;
  font-size: 0.78rem;
  color: #e06c75;
}

.todo-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  min-height: 60px;
}

.todo-empty {
  padding: 22px 16px;
  font-size: 0.8rem;
  color: var(--text-secondary);
  font-style: italic;
  text-align: center;
  line-height: 1.5;
}

.todo-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 6px;
}
.todo-row:hover { background: var(--bg-card); }

.todo-check {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: transparent;
  font-size: 0.7rem;
  line-height: 1;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background 0.15s;
}
.todo-check:hover { border-color: var(--text-secondary); }
.todo-check:disabled { cursor: default; }
.todo-check-on {
  background: var(--color-atom-code);
  border-color: var(--color-atom-code);
  color: #fff;
}

.todo-text {
  flex: 1;
  font-size: 0.85rem;
  color: var(--text-primary);
  line-height: 1.4;
  word-break: break-word;
  cursor: text;
}

.todo-row-done .todo-text {
  text-decoration: line-through;
  color: var(--text-secondary);
  opacity: 0.55;
}

.todo-edit-input {
  flex: 1;
  background: var(--bg-secondary);
  border: 1px solid var(--color-atom-code);
  border-radius: 4px;
  padding: 2px 6px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.85rem;
  outline: none;
}

.todo-del {
  flex-shrink: 0;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1rem;
  line-height: 1;
  padding: 0 2px;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}
.todo-row:hover .todo-del { opacity: 0.5; }
.todo-del:hover { opacity: 1 !important; color: #e06c75; }

.todo-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-card);
}

.todo-count {
  font-size: 0.74rem;
  color: var(--text-secondary);
  font-family: monospace;
}

.todo-clear {
  padding: 3px 10px;
  background: transparent;
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.74rem;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.todo-clear:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-secondary); }
.todo-clear:disabled { opacity: 0.3; cursor: not-allowed; }
</style>
