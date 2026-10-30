<script setup lang="ts">
import { ref, watch, nextTick, computed } from 'vue'
import { useSessionStore } from '../stores/session'
import { canCommand } from '../webCaps'
import AtomCard from './AtomCard.vue'
import { filterAtoms } from '../atomFilter'

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  })
}

const props = defineProps<{ focusMode: boolean; workingDir?: string; attachments?: string[] }>()
const emit = defineEmits<{ openComposer: [] }>()

const store = useSessionStore()

const modelLabel = computed(() => (store.sessionModel === 'fable' ? 'Fable' : 'Opus'))

const contextSession = computed(() => {
  if (!store.sessionId || store.running || store.atoms.length === 0) return null
  return store.savedSessions.find(s => s.id === store.sessionId) ?? null
})

const visibleAtoms = computed(() => filterAtoms(store.atoms, props.focusMode))
const containerRef = ref<HTMLElement | null>(null)

// Auto-scroll to bottom whenever new atoms arrive.
// In raw mode always follow; in focus mode only when scroll is locked.
watch(
  () => visibleAtoms.value.length,
  async () => {
    if (!props.focusMode || store.scrollLocked) {
      await nextTick()
      scrollToEnd()
    }
  }
)

function scrollToEnd() {
  const el = containerRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function onScroll() {
  const el = containerRef.value
  if (!el) return
  // In raw mode never unlock — always stay at bottom
  if (!props.focusMode) return
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
  if (!atBottom && store.scrollLocked) {
    store.setScrollLocked(false)
  }
}

function jumpToBottom() {
  store.setScrollLocked(true)
  nextTick(scrollToEnd)
}
</script>

<template>
  <div class="stream-wrapper">
    <div
      ref="containerRef"
      class="stream-container"
      @scroll="onScroll"
    >
      <!-- Session context card: shown at top when a loaded session is idle -->
      <div v-if="contextSession" class="session-ctx-bar">
        <div class="ctx-info">
          <span class="ctx-date">{{ fmtDate(contextSession.startedAt) }}</span>
          <template v-if="store.sessionWorkingDir">
            <span class="ctx-sep">·</span>
            <span class="ctx-dir" :title="store.sessionWorkingDir">{{ store.sessionWorkingDir }}</span>
          </template>
          <template v-if="store.sessionGitBranch">
            <span class="ctx-sep">·</span>
            <span class="ctx-branch" data-testid="session-git-branch" :title="store.sessionGitBranch">⎇ {{ store.sessionGitBranch }}</span>
          </template>
          <span class="ctx-sep">·</span>
          <span class="ctx-count">{{ store.atoms.length }} events</span>
          <template v-if="store.sessionUsage?.totalCostUsd">
            <span class="ctx-sep">·</span>
            <span class="ctx-cost">${{ store.sessionUsage.totalCostUsd.toFixed(4) }}</span>
          </template>
          <template v-if="store.sessionModel !== 'sonnet'">
            <span class="ctx-sep">·</span>
            <span class="ctx-opus">{{ modelLabel }}</span>
          </template>
        </div>
        <button v-if="canCommand" class="ctx-continue" @click="emit('openComposer')">Continue ↩</button>
      </div>

      <div v-if="store.atoms.length === 0 && !store.running" class="empty-state">
        <div v-if="!canCommand" class="empty-pick" data-testid="empty-pick">Pick a session to follow it here.</div>
        <button v-else class="empty-cta" @click="emit('openComposer')">
          <svg class="empty-cta-glyph" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon
              points="92,50 71,13.6 29,13.6 8,50 29,86.4 71,86.4"
              transform="rotate(90 50 50)"
              stroke="currentColor"
              stroke-width="2.75"
              stroke-linejoin="round"
            />
            <polyline
              points="30,37 46,50 30,63"
              stroke="currentColor"
              stroke-width="6.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <circle cx="74" cy="35" r="2.25" fill="currentColor" />
            <line x1="55" y1="62" x2="74" y2="62" stroke="currentColor" stroke-width="6" stroke-linecap="round" />
          </svg>
          <span class="empty-cta-label">new session</span>
          <kbd class="empty-cta-kbd">Ctrl+K</kbd>
        </button>
        <div v-if="props.workingDir || (props.attachments && props.attachments.length > 0)" class="empty-ctx">
          <span v-if="props.workingDir" class="empty-ctx-row empty-ctx-row--dir">
            <span class="empty-ctx-icon">⌂</span>
            <span class="empty-ctx-value">{{ props.workingDir }}</span>
          </span>
          <span v-if="props.attachments && props.attachments.length > 0" class="empty-ctx-row empty-ctx-row--attach">
            <span class="empty-ctx-icon">⊕</span>
            <span class="empty-ctx-value">{{ props.attachments.join(', ') }}</span>
          </span>
        </div>
      </div>

      <template v-for="atom in visibleAtoms" :key="atom.id">
        <div v-if="atom.content === '\x00separator'" class="session-separator">
          <span class="sep-line" />
        </div>
        <AtomCard v-else :atom="atom" :focus-mode="focusMode" />
      </template>

      <!-- Error banner from invoke failure -->
      <div v-if="store.lastError" class="error-banner">
        {{ store.lastError }}
      </div>
    </div>

    <!-- Loading overlay — shown while session is running -->
    <Transition name="loading">
      <div v-if="store.running" class="loading-overlay" />
    </Transition>

    <!-- "N nuovi" badge shown when scroll is unlocked and new atoms arrived -->
    <Transition name="badge">
      <button
        v-if="!store.scrollLocked && store.newCount > 0"
        class="new-badge"
        @click="jumpToBottom"
      >
        {{ store.newCount }} new ↓
      </button>
    </Transition>

    <!-- Model badge — visible while running on a non-default model -->
    <Transition name="token-chip">
      <div v-if="store.sessionModel !== 'sonnet' && store.running" class="opus-chip">{{ modelLabel }}</div>
    </Transition>

    <!-- Token counter chip -->
    <Transition name="token-chip">
      <div v-if="store.sessionUsage" class="token-chip">
        <span class="token-total">
          {{ fmtK(store.sessionUsage.inputTokens + store.sessionUsage.outputTokens) }} tok
        </span>
        <template v-if="store.stepTokenStart">
          <span class="token-sep">·</span>
          <span class="token-delta">
            +{{ fmtK(
              (store.sessionUsage.inputTokens + store.sessionUsage.outputTokens)
              - (store.stepTokenStart.inputTokens + store.stepTokenStart.outputTokens)
            ) }} step
          </span>
        </template>
        <template v-if="store.sessionUsage.cacheReadTokens > 0">
          <span class="token-sep">·</span>
          <span class="token-cache">{{ fmtK(store.sessionUsage.cacheReadTokens) }} cached</span>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.stream-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}


.stream-container {
  height: 100%;
  overflow-y: auto;
  padding: 8px 8px 40px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  /* Avoid smooth scroll so programmatic scroll is instant */
  scroll-behavior: auto;
}

.empty-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
}

/* On the web without commands there is nothing to start: it says what to do instead of the button. */
.empty-pick { font-size: 0.85rem; color: var(--text-secondary); padding: 24px; text-align: center; }

.empty-cta {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 36px 64px;
  border: 1.5px dashed color-mix(in srgb, var(--color-atom-code) 30%, transparent);
  border-radius: 22px;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease;
  outline: none;
}

.empty-cta:hover {
  border-color: var(--color-atom-code);
  background: color-mix(in srgb, var(--color-atom-code) 5%, transparent);
  box-shadow: 0 0 32px color-mix(in srgb, var(--color-atom-code) 8%, transparent);
}

.empty-cta:focus-visible {
  border-color: var(--color-atom-code);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-atom-code) 30%, transparent);
}

.empty-cta-glyph {
  width: 100px;
  height: 100px;
  color: var(--color-atom-code);
  opacity: 0.35;
  line-height: 1;
  transition: opacity 0.2s ease, transform 0.2s ease;
  display: block;
}

.empty-cta:hover .empty-cta-glyph {
  opacity: 0.85;
  transform: scale(1.08);
}

.empty-cta-label {
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-secondary);
  opacity: 0.55;
  transition: opacity 0.2s ease, color 0.2s ease;
}

.empty-cta:hover .empty-cta-label {
  color: var(--text-primary);
  opacity: 1;
}

.empty-cta-kbd {
  font-family: inherit;
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 2px 8px;
  letter-spacing: 0.04em;
  opacity: 0.4;
  transition: opacity 0.2s ease;
}

.empty-cta:hover .empty-cta-kbd {
  opacity: 0.75;
}

.empty-ctx {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.empty-ctx-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  opacity: 0.75;
  font-family: monospace;
}
.empty-ctx-row--dir  { color: #c8973a; }
.empty-ctx-row--attach { color: #50aaa0; }
.empty-ctx-icon {
  opacity: 0.7;
  flex-shrink: 0;
}
.empty-ctx-value {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 320px;
}

.error-banner {
  padding: 8px 12px;
  background: rgba(255, 59, 48, 0.12);
  border: 1px solid rgba(255, 59, 48, 0.3);
  border-radius: 4px;
  color: var(--color-error);
  font-size: 0.82rem;
}

.new-badge {
  position: absolute;
  bottom: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--color-atom-code);
  color: #fff;
  border: none;
  border-radius: 20px;
  padding: 6px 18px;
  font-family: inherit;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 2px 14px rgba(0, 0, 0, 0.5);
  z-index: 10;
  white-space: nowrap;
}

.new-badge:hover {
  background: #5aa0e8;
}

/* Transition for the badge */
.badge-enter-active,
.badge-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.badge-enter-from,
.badge-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}

/* Loading overlay */
.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--color-atom-code, #6ab0f5), transparent);
  background-size: 200% 100%;
  animation: loading-bar 1.4s ease-in-out infinite;
  z-index: 20;
  pointer-events: none;
}

@keyframes loading-bar {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}


.loading-enter-active,
.loading-leave-active {
  transition: opacity 0.2s ease;
}
.loading-enter-from,
.loading-leave-to {
  opacity: 0;
}

.token-chip {
  position: absolute;
  bottom: 10px;
  right: 10px;
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 3px 10px;
  font-size: 0.7rem;
  pointer-events: none;
  z-index: 9;
  opacity: 0.75;
}

.token-total { color: var(--text-primary); font-weight: 600; }
.token-sep   { color: var(--text-secondary); opacity: 0.5; }
.token-delta { color: #e5c07b; }
.token-cache { color: #56b6c2; }

.token-chip-enter-active,
.token-chip-leave-active { transition: opacity 0.2s ease; }
.token-chip-enter-from,
.token-chip-leave-to { opacity: 0; }

.opus-chip {
  position: absolute;
  top: 8px;
  right: 10px;
  padding: 2px 8px;
  border-radius: 8px;
  background: rgba(160, 125, 224, 0.15);
  border: 1px solid rgba(160, 125, 224, 0.4);
  color: #a07de0;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  pointer-events: none;
  z-index: 5;
}

.session-separator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 4px;
}
.sep-line {
  flex: 1;
  height: 1px;
  background: var(--border-color);
  opacity: 0.5;
}

.session-ctx-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  margin-bottom: 4px;
  border-radius: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  flex-shrink: 0;
  gap: 12px;
}

.ctx-info {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.72rem;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
}

.ctx-date  { color: var(--text-primary); font-weight: 500; white-space: nowrap; }
.ctx-sep   { opacity: 0.35; flex-shrink: 0; }
.ctx-dir   {
  color: var(--color-atom-config);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}
.ctx-branch {
  color: var(--color-atom-config);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
  opacity: 0.8;
}
.ctx-count { white-space: nowrap; }
.ctx-cost  { white-space: nowrap; }
.ctx-opus  { color: #a07de0; font-weight: 600; font-size: 0.75rem; white-space: nowrap; letter-spacing: 0.04em; }

.ctx-continue {
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 5px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.76rem;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
  white-space: nowrap;
}

.ctx-continue:hover {
  color: var(--color-atom-code);
  border-color: var(--color-atom-code);
}
</style>
