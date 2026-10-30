<script setup lang="ts">
import { computed } from 'vue'
import { useSessionStore } from '../stores/session'
import type { Profile } from '../stores/settings'

const props = defineProps<{
  prompt: string
  profiles: Profile[]
}>()

const emit = defineEmits<{
  open: []
  run: []
  stop: []
}>()

const profileIdx = defineModel<number>('profileIdx', { default: 0 })

const session = useSessionStore()

const noProfiles = computed(() => props.profiles.length === 0)

// While awaiting answers the bar stays alive: it is the only way the user has to
// answer a protocol question while the session is still running.
const locked = computed(() =>
  (session.running && session.pragmaPhase !== 'awaiting_answers') || noProfiles.value,
)

const triggerLabel = computed(() => {
  if (props.prompt) return props.prompt
  if (noProfiles.value) return 'configure a profile in Settings…'
  return session.pragmaPhase === 'awaiting_answers' ? 'write your answer…' : 'prompt…'
})

// The run button opens the composer when there is nothing to send yet:
// pressing it empty would be a silent no-op.
function onRun() {
  if (props.prompt.trim()) emit('run')
  else emit('open')
}
</script>

<template>
  <div class="prompt-row">
    <select v-if="profiles.length > 1" v-model="profileIdx" class="binary-select" :disabled="session.running">
      <option v-for="(p, i) in profiles" :key="i" :value="i">{{ p.label }}</option>
    </select>
    <span v-else-if="profiles.length === 1" class="profile-label">{{ profiles[0].label }}</span>
    <button
      class="prompt-trigger"
      data-testid="prompt-trigger"
      :class="{ 'has-text': prompt.length > 0, 'is-waiting': session.pragmaPhase === 'awaiting_answers' }"
      :disabled="locked"
      @click="emit('open')"
    >{{ triggerLabel }}</button>
    <button
      class="run-btn"
      data-testid="btn-run"
      :disabled="locked"
      @click="onRun"
    >{{ session.pragmaPhase === 'awaiting_answers' ? 'awaiting input…' : session.running ? 'running…' : 'run' }}</button>
    <button v-if="session.running && session.pragmaPhase !== 'awaiting_answers'" class="stop-btn" title="Stop session" @click="emit('stop')">stop</button>
  </div>
</template>

<style scoped>
.prompt-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 16px;
}

.binary-select {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.82rem;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
}
.binary-select:disabled { opacity: 0.4; }

.profile-label {
  font-size: 0.82rem;
  color: var(--text-secondary);
  flex-shrink: 0;
}

.prompt-trigger {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 6px 12px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.88rem;
  text-align: left;
  cursor: pointer;
  height: 32px;
  line-height: 20px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  transition: border-color 0.15s, color 0.15s;
}
.prompt-trigger.has-text { color: var(--text-primary); }
.prompt-trigger.is-waiting { border-color: #a07de0; color: #a07de0; }
.prompt-trigger:hover:not(:disabled) { border-color: var(--color-atom-code); }
.prompt-trigger:disabled { opacity: 0.5; cursor: not-allowed; }

.run-btn {
  padding: 6px 18px;
  background: var(--color-atom-code);
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  transition: background 0.15s;
  flex-shrink: 0;
}
.run-btn:hover:not(:disabled) { background: #5aa0e8; }
.run-btn:disabled { opacity: 0.4; cursor: not-allowed; }

.stop-btn {
  padding: 6px 14px;
  background: #c0392b;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  flex-shrink: 0;
  transition: background 0.15s;
}
.stop-btn:hover { background: #e74c3c; }
</style>
