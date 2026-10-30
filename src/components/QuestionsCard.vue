<script setup lang="ts">
import { ref } from 'vue'
import { useSessionStore } from '../stores/session'
import { canCommand } from '../webCaps'
import type { PragmaQuestions, PragmaPhase } from '../stores/session'
import { formatQuestions } from '../questions'

interface Profile {
  label: string
  binary: string
  configDir?: string | null
}

const props = defineProps<{
  data: PragmaQuestions
  phase: PragmaPhase | null
  profile: Profile | null
  collapsed: boolean
}>()
defineEmits<{ toggle: [] }>()

const store = useSessionStore()

// The questions already arrive grouped with their options and without the model's
// numbering (protocol.rs `group_questions`): the card adds the numbering.
const copied = ref(false)
async function copyAll() {
  await navigator.clipboard.writeText(formatQuestions(props.data.items))
  copied.value = true
  setTimeout(() => { copied.value = false }, 1200)
}
</script>

<template>
  <div class="pragma-card questions-card">
    <div class="card-header" @click.self="$emit('toggle')">
      <button class="chevron-btn" :class="{ open: !collapsed }" @click="$emit('toggle')">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="card-label" @click="$emit('toggle')">QUESTIONS</span>
      <button class="copy-btn" :class="{ copied }" :title="copied ? 'copied' : 'copy'" @click="copyAll">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M3 11V3a1 1 0 0 1 1-1h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div class="card-collapse" :class="{ 'is-collapsed': collapsed }">
      <div class="card-inner">
        <div class="questions-body">
          <div v-for="(q, i) in data.items" :key="i" class="question-item" data-testid="question-item">
            <div class="q-text"><span class="q-num">{{ i + 1 }}.</span> {{ q.text }}</div>
            <ul v-if="q.options.length" class="q-options">
              <li v-for="(o, j) in q.options" :key="j">{{ o }}</li>
            </ul>
          </div>
        </div>
        <div v-if="phase === 'awaiting_answers' && canCommand" class="answer-controls">
          <button class="ctrl-btn ctrl-skip" :disabled="store.running" @click="store.sendControl('SKIP_QUESTIONS', profile!.binary, profile?.configDir ?? undefined)">Skip</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pragma-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-left: 3px solid #a07de0;
  border-radius: 6px;
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: rgba(160, 125, 224, 0.08);
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.card-header:hover { background: rgba(160, 125, 224, 0.14); }

.chevron-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
  line-height: 0;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  transition: color 0.12s, transform 0.2s ease;
  transform: rotate(0deg);
}
.chevron-btn.open { transform: rotate(90deg); }
.chevron-btn:hover { color: var(--text-primary); }

.card-label { flex: 1; }

.card-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #a07de0;
  opacity: 0.9;
}

.copy-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 2px;
  line-height: 0;
  border-radius: 3px;
  transition: color 0.12s;
  display: flex;
  align-items: center;
}
.copy-btn:hover { color: var(--text-primary); }
.copy-btn.copied { color: #4caf50; }

.card-collapse {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s ease;
  overflow: hidden;
}
.card-collapse.is-collapsed {
  grid-template-rows: 0fr;
}
.card-collapse > .card-inner {
  overflow: hidden;
  min-height: 0;
}

.questions-body {
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.question-item {
  display: flex;
  flex-direction: column;
}

.q-text {
  font-size: 0.8rem;
  color: var(--text-primary);
  line-height: 1.4;
  white-space: pre-wrap;
}
.q-num { color: var(--text-secondary); font-weight: 600; }
.q-options {
  margin: 3px 0 0;
  padding-left: 22px;
  font-size: 0.77rem;
  color: var(--text-secondary);
  line-height: 1.4;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.answer-controls {
  display: flex;
  gap: 6px;
  padding: 8px 10px;
  border-top: 1px solid var(--border-color);
}

.ctrl-btn {
  padding: 4px 12px;
  border-radius: 5px;
  border: none;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
}
.ctrl-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.ctrl-skip { background: var(--bg-secondary); color: var(--text-secondary); border: 1px solid var(--border-color); }
.ctrl-skip:hover { color: var(--text-primary); }
</style>
