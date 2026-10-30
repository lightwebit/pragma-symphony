<script setup lang="ts">
import { ref, watch } from 'vue'
import { invoke } from '../platform'
import type { Profile } from '../stores/settings'
import {
  USAGE_TICK_INTERVAL_MS, USAGE_HARD_TIMEOUT_MS,
  USAGE_SHOW_ELAPSED_AFTER_S, USAGE_SHOW_CANCEL_AFTER_S,
  USAGE_BAR_DANGER_PCT, USAGE_BAR_WARN_PCT,
} from '../PRAGMA_CONSTANTS'

const props = defineProps<{ open: boolean; profile: Profile | null }>()
const emit = defineEmits<{ close: [] }>()

const usageStats = ref<any>(null)
const usageLoading = ref(false)
const usageElapsed = ref(0)
let _usageTick: ReturnType<typeof setInterval> | null = null
let _usageHard: ReturnType<typeof setTimeout> | null = null
let _usageCancelled = false

function _clearTimers() {
  if (_usageTick) { clearInterval(_usageTick); _usageTick = null }
  if (_usageHard) { clearTimeout(_usageHard); _usageHard = null }
}

function cancelUsage() {
  _usageCancelled = true
  _clearTimers()
  usageLoading.value = false
  usageStats.value = { error: 'Cancelled.' }
}

async function fetchUsage() {
  usageLoading.value = true
  usageStats.value = null
  usageElapsed.value = 0
  _usageCancelled = false

  _usageTick = setInterval(() => { usageElapsed.value++ }, USAGE_TICK_INTERVAL_MS)
  _usageHard = setTimeout(() => {
    if (!_usageCancelled) {
      cancelUsage()
      usageStats.value = { error: 'Request timed out (60s).' }
    }
  }, USAGE_HARD_TIMEOUT_MS)

  try {
    const result = await invoke('get_claude_usage', {
      binary: props.profile?.binary ?? null,
      configDir: props.profile?.configDir ?? null,
    })
    if (!_usageCancelled) usageStats.value = result
  } catch (e: any) {
    if (!_usageCancelled) usageStats.value = { error: String(e) }
  } finally {
    if (!_usageCancelled) { _clearTimers(); usageLoading.value = false }
  }
}

watch(() => props.open, (open) => {
  if (open) fetchUsage()
  else if (usageLoading.value) cancelUsage()
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="overlay" @click.self="emit('close')">
      <div class="usage-modal">
        <div class="usage-header">
          <span class="usage-title">usage</span>
          <button class="usage-close" @click="emit('close')">×</button>
        </div>
        <div v-if="usageLoading" class="usage-loading">
          fetching usage <span class="usage-dots"></span>
          <span v-if="usageElapsed >= USAGE_SHOW_ELAPSED_AFTER_S" class="usage-elapsed">{{ usageElapsed }}s</span>
          <button v-if="usageElapsed >= USAGE_SHOW_CANCEL_AFTER_S" class="usage-cancel-btn" @click="cancelUsage">cancel</button>
        </div>
        <div v-else class="usage-body">
          <div v-if="usageStats?.error" class="usage-error">{{ usageStats.error }}</div>
          <template v-else-if="usageStats?.sections?.length">
            <div v-for="s in usageStats.sections" :key="s.title" class="usage-section">
              <div class="usage-section-title">{{ s.title }}</div>
              <div v-if="s.percent != null" class="usage-bar-row">
                <div class="usage-bar-track">
                  <div class="usage-bar-fill"
                    :style="{ width: s.percent + '%' }"
                    :class="s.percent >= USAGE_BAR_DANGER_PCT ? 'bar-danger' : s.percent >= USAGE_BAR_WARN_PCT ? 'bar-warn' : 'bar-ok'"
                  />
                </div>
                <span class="usage-pct">{{ s.percent }}%</span>
              </div>
              <div v-if="s.spent" class="usage-spent">{{ s.spent }}</div>
              <div v-if="s.resets" class="usage-resets">Resets {{ s.resets }}</div>
            </div>
          </template>
          <div v-else class="usage-no-session">no data available</div>
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

.usage-modal {
  width: min(420px, 92vw);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0,0,0,0.5);
}

.usage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-card);
}

.usage-title {
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--color-atom-code);
}

.usage-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1.1rem;
  padding: 0 4px;
  line-height: 1;
}
.usage-close:hover { color: var(--text-primary); }

.usage-loading {
  padding: 24px;
  text-align: center;
  font-size: 0.82rem;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.usage-elapsed {
  font-family: monospace;
  color: var(--text-secondary);
  opacity: 0.7;
}

.usage-cancel-btn {
  margin-left: 4px;
  padding: 2px 8px;
  font-size: 0.78rem;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}
.usage-cancel-btn:hover { color: var(--text-primary); border-color: var(--text-secondary); }

.usage-dots {
  display: inline-block;
  width: 1.6em;
  text-align: left;
  font-family: monospace;
}
.usage-dots::after {
  content: '';
  animation: usage-dot-cycle 1.2s steps(4, end) infinite;
}
@keyframes usage-dot-cycle {
  0%   { content: ''; }
  25%  { content: '.'; }
  50%  { content: '..'; }
  75%  { content: '...'; }
}

.usage-body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 70vh;
  overflow-y: auto;
}

.usage-section {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.usage-section:last-child { border-bottom: none; }

.usage-section-title {
  font-size: 0.62rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-secondary);
  opacity: 0.6;
  margin-top: 4px;
}

.usage-bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.usage-bar-track {
  flex: 1;
  height: 6px;
  background: var(--border-color);
  border-radius: 3px;
  overflow: hidden;
}

.usage-bar-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}
.bar-ok     { background: #4caf50; }
.bar-warn   { background: #e5a338; }
.bar-danger { background: #e06c75; }

.usage-pct {
  font-size: 0.82rem;
  font-weight: 700;
  font-family: monospace;
  color: var(--text-primary);
  min-width: 36px;
  text-align: right;
}

.usage-spent {
  font-size: 0.8rem;
  color: var(--text-primary);
  font-family: monospace;
}

.usage-resets {
  font-size: 0.72rem;
  color: var(--text-secondary);
}

.usage-no-session {
  font-size: 0.78rem;
  color: var(--text-secondary);
  font-style: italic;
}

.usage-error {
  font-size: 0.78rem;
  color: #e06c75;
  padding: 4px 0;
}
</style>
