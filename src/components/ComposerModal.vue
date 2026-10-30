<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useSessionStore } from '../stores/session'
import type { SessionModel } from '../stores/session'
import { type ExpiredCache, formatTokens, formatIdle } from '../cacheExpiry'

const props = defineProps<{
  open: boolean
  workingDir: string
  /** Expired cache of the session being continued: null if there is nothing to say. */
  cacheWarning?: ExpiredCache | null
}>()

const emit = defineEmits<{
  close: []
  /** `runAt` = ISO UTC when "Run later" is on, otherwise null (immediate start). */
  submit: [model: SessionModel, autoConfirm: boolean, runAt: string | null]
  /** Instead of continuing, start over from a new session with the summary. */
  startFresh: []
}>()

const prompt = defineModel<string>('prompt', { default: '' })
const selectedModel = defineModel<SessionModel>('selectedModel', { default: 'sonnet' })
const autoConfirm = defineModel<boolean>('autoConfirm', { default: true })

const session = useSessionStore()
// No session open: the composer is about to start a new one, not continue one.
const isNewSession = computed(() => !session.sessionId)

// — Answers to the questions —
// With several questions there is one field for each and the main field becomes an
// optional note; with only one the main field stays. The options fill in the answer.
const answers = defineModel<string[]>('answers', { default: () => [] })
const questions = computed(() =>
  session.pragmaPhase === 'awaiting_answers' ? session.pragmaQuestions?.items ?? [] : [],
)
const perQuestion = computed(() => questions.value.length > 1)

function setAnswer(i: number, value: string) {
  const next = [...answers.value]
  next[i] = value
  answers.value = next
}

function pickOption(i: number, option: string) {
  if (perQuestion.value) setAnswer(i, option)
  else prompt.value = option
}

const canSubmit = computed(() =>
  !!prompt.value.trim() || (perQuestion.value && answers.value.some(a => a?.trim())),
)
const advancedOpen = ref(false)
const textareaRef = ref<HTMLTextAreaElement | null>(null)

// — Schedule: datetime-local is local time without a timezone — `new
// Date(value)` reads it as local and `toISOString()` turns it into UTC, as
// `run_at` on the Rust side expects. No manual conversion.
const scheduleEnabled = ref(false)
const scheduleAt = ref('')

const scheduleError = computed(() => {
  if (!scheduleEnabled.value || !scheduleAt.value) return ''
  const t = new Date(scheduleAt.value).getTime()
  if (Number.isNaN(t)) return 'Invalid date.'
  if (t <= Date.now()) return 'Pick a time in the future.'
  return ''
})

const scheduleReady = computed(() =>
  !scheduleEnabled.value || (!!scheduleAt.value && !scheduleError.value),
)

watch(() => props.open, async (open) => {
  if (open) {
    await nextTick()
    textareaRef.value?.focus()
  } else {
    advancedOpen.value = false
    scheduleEnabled.value = false
    scheduleAt.value = ''
  }
})


function submit() {
  if (!scheduleReady.value) return
  const runAt = scheduleEnabled.value && scheduleAt.value
    ? new Date(scheduleAt.value).toISOString()
    : null
  emit('submit', selectedModel.value, autoConfirm.value, runAt)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="composer-fade">
      <div v-if="open" class="composer-backdrop" @click.self="emit('close')">
        <div class="composer-modal" data-testid="composer-modal">
          <div v-if="session.pragmaPhase === 'awaiting_answers' || session.sessionTitle"
               class="composer-banner"
               :class="session.pragmaPhase === 'awaiting_answers' ? 'banner-answering' : 'banner-continue'">
            <span class="banner-icon">{{ session.pragmaPhase === 'awaiting_answers' ? '?' : '↩' }}</span>
            <div class="banner-body">
              <span class="banner-title">{{ session.pragmaPhase === 'awaiting_answers' ? 'Waiting for your answers' : session.sessionTitle }}</span>
              <span v-if="session.pragmaPhase === 'awaiting_answers'" class="banner-sub">Respond below to continue the session</span>
              <span v-else-if="workingDir" class="banner-sub">{{ workingDir }}</span>
            </div>
          </div>
          <div v-if="!isNewSession && cacheWarning" class="composer-cache" data-testid="composer-cache-warning">
            <span class="cache-text">
              ⚠ Cache expired ({{ formatIdle(cacheWarning.idleMinutes) }} idle): sending rewrites
              ~{{ formatTokens(cacheWarning.contextTokens) }} tokens of context,
              ~{{ cacheWarning.rewriteVsRead }}× the cost of reading them from cache.
            </span>
            <button class="cache-fresh" data-testid="composer-start-fresh" @click="emit('startFresh')">
              New session with summary
            </button>
          </div>
          <div v-if="questions.length" class="composer-context">
            <div class="context-label">Questions:</div>
            <div v-for="(q, i) in questions" :key="i" class="ctx-question">
              <div class="ctx-q-text"><span class="ctx-q-num">{{ i + 1 }}.</span> {{ q.text }}</div>
              <div v-if="q.options.length" class="ctx-options">
                <button
                  v-for="(o, j) in q.options"
                  :key="j"
                  class="opt-chip"
                  :class="{ picked: (perQuestion ? answers[i] : prompt) === o }"
                  :data-testid="`composer-option-${i}-${j}`"
                  @click="pickOption(i, o)"
                >{{ o }}</button>
              </div>
              <textarea
                v-if="perQuestion"
                class="answer-input"
                rows="2"
                placeholder="Answer…"
                :data-testid="`composer-answer-${i}`"
                :value="answers[i] ?? ''"
                @input="setAnswer(i, ($event.target as HTMLTextAreaElement).value)"
                @keydown.enter.ctrl.prevent="submit"
              />
            </div>
          </div>
          <textarea
            ref="textareaRef"
            v-model="prompt"
            class="composer-textarea"
            data-testid="composer-textarea"
            :placeholder="perQuestion ? 'Anything else? (optional)' : session.pragmaPhase === 'awaiting_answers' ? 'Answer the questions…' : 'prompt…'"
            @keydown.enter.ctrl.prevent="submit"
            @keydown.enter.meta.prevent="submit"
            @keydown.escape.prevent="emit('close')"
          />
          <div v-if="session.pragmaPhase !== 'awaiting_answers'" class="composer-advanced">
            <button class="advanced-toggle" data-testid="composer-advanced-toggle" @click="advancedOpen = !advancedOpen">
              Advanced settings {{ advancedOpen ? '▴' : '▾' }}
            </button>
            <div v-if="advancedOpen" class="advanced-body">
              <div class="adv-group">
                <span class="adv-label">Model</span>
                <label class="adv-radio">
                  <input type="radio" v-model="selectedModel" value="sonnet" />
                  Sonnet <span class="adv-hint">(default)</span>
                </label>
                <label class="adv-radio">
                  <input type="radio" v-model="selectedModel" value="opus" />
                  Opus <span class="adv-hint">— complex tasks: architecture, refactoring</span>
                </label>
                <label class="adv-radio">
                  <input type="radio" v-model="selectedModel" value="fable" />
                  Fable <span class="adv-hint">— hardest tasks; slower and ~2× the cost of Opus</span>
                </label>
              </div>
              <div class="adv-group">
                <label class="adv-radio">
                  <input type="checkbox" data-testid="composer-auto-confirm" v-model="autoConfirm" />
                  Auto-approve steps <span class="adv-hint">— uncheck to confirm each step manually</span>
                </label>
              </div>
              <div class="adv-group">
                <label class="adv-radio">
                  <input type="checkbox" data-testid="composer-schedule-toggle" v-model="scheduleEnabled" />
                  Run later <span class="adv-hint">— hold this session until the chosen time</span>
                </label>
                <input
                  v-if="scheduleEnabled"
                  v-model="scheduleAt"
                  type="datetime-local"
                  class="schedule-input"
                  data-testid="composer-schedule-at"
                />
                <div v-if="scheduleEnabled && scheduleError" class="schedule-error">{{ scheduleError }}</div>
              </div>
            </div>
          </div>
          <div class="composer-footer">
            <span class="composer-hint">
              <kbd>Ctrl+Enter</kbd> send · <kbd>Esc</kbd> close
              <span class="hint-sep">|</span>
              <span class="hint-global"><kbd>Ctrl+K</kbd> open · <kbd>Ctrl+S</kbd> settings</span>
            </span>
            <div class="composer-footer-right">
              <!-- Phone only: at full screen there is no backdrop to tap and no Esc key. -->
              <button class="composer-close-mobile" data-testid="composer-close" @click="emit('close')">Cancel</button>
              <span v-if="selectedModel !== 'sonnet'" class="model-badge">{{ selectedModel }}</span>
              <span v-if="autoConfirm" class="model-badge auto-badge">auto-continue</span>
              <span v-if="scheduleEnabled && scheduleAt && !scheduleError" class="model-badge schedule-badge">
                ⏱ {{ new Date(scheduleAt).toLocaleString() }}
              </span>
              <button
                class="run-btn"
                data-testid="composer-submit"
                :disabled="!canSubmit || !scheduleReady"
                @click="submit"
              >
                {{ scheduleEnabled ? 'Schedule' : (session.pragmaPhase === 'awaiting_answers' ? 'Send answer' : 'Run') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.composer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 500;
  background: rgba(20, 22, 28, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
}

.composer-modal {
  width: min(680px, 92vw);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 16px 40px rgba(0,0,0,0.5);
}

/* Web on a narrow screen: full screen. `dvh` follows the keyboard as it opens, so
   the send button stays above it instead of ending up underneath. */
@media (max-width: 899px) {
  html.web .composer-backdrop { align-items: stretch; }
  html.web .composer-modal { width: 100vw; height: 100dvh; max-height: none; border-radius: 0; border: none; }
  html.web .composer-textarea { max-height: none; }
  html.web .composer-hint { display: none; }
  html.web .composer-close-mobile { display: inline-block; }
}

.composer-close-mobile {
  display: none;
  padding: 6px 14px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.85rem;
  cursor: pointer;
}

.composer-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border-color);
}

.composer-cache {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 16px;
  background: rgba(212, 168, 67, 0.1);
  border-bottom: 1px solid var(--border-color);
}
.composer-cache .cache-text {
  flex: 1;
  font-size: 0.74rem;
  color: var(--color-atom-data, #d4a843);
}
.cache-fresh {
  background: rgba(212, 168, 67, 0.18);
  border: 1px solid rgba(212, 168, 67, 0.45);
  border-radius: 4px;
  color: var(--color-atom-data, #d4a843);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.72rem;
  padding: 3px 9px;
  flex-shrink: 0;
}
.cache-fresh:hover { background: rgba(212, 168, 67, 0.32); }

.banner-answering { background: rgba(212, 168, 67, 0.08); }
.banner-continue  { background: rgba(160, 125, 224, 0.06); }

.banner-icon {
  font-size: 0.95rem;
  line-height: 1;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}

.banner-answering .banner-icon { color: var(--color-atom-data); }
.banner-continue .banner-icon  { color: var(--color-atom-style); }

.banner-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.banner-title {
  font-size: 0.80rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.banner-answering .banner-title { color: var(--color-atom-data); }
.banner-continue .banner-title  { color: var(--text-primary); }

.banner-sub {
  font-size: 0.68rem;
  color: var(--text-secondary);
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer-context {
  padding: 12px 16px 8px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(160, 125, 224, 0.06);
}

.context-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #a07de0;
  margin-bottom: 6px;
  text-transform: uppercase;
}

.composer-context {
  max-height: 45vh;
  overflow-y: auto;
}

.ctx-question + .ctx-question { margin-top: 10px; }

.ctx-q-text {
  font-size: 0.82rem;
  color: var(--text-primary);
  line-height: 1.45;
  white-space: pre-wrap;
}
.ctx-q-num { color: #a07de0; font-weight: 600; }

.ctx-options {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  margin: 5px 0 0 16px;
}

.opt-chip {
  background: rgba(160, 125, 224, 0.1);
  border: 1px solid rgba(160, 125, 224, 0.35);
  border-radius: 5px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.76rem;
  line-height: 1.35;
  padding: 3px 8px;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.opt-chip:hover { background: rgba(160, 125, 224, 0.2); }
.opt-chip.picked { background: rgba(160, 125, 224, 0.32); border-color: #a07de0; }

.answer-input {
  display: block;
  width: calc(100% - 16px);
  box-sizing: border-box;
  margin: 6px 0 0 16px;
  background: var(--bg-primary, var(--bg-secondary));
  border: 1px solid var(--border-color);
  border-radius: 5px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.8rem;
  line-height: 1.4;
  padding: 5px 8px;
  resize: vertical;
  outline: none;
}
.answer-input:focus { border-color: #a07de0; }

.composer-textarea {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  resize: none;
  padding: 16px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.92rem;
  line-height: 1.55;
  min-height: 180px;
  max-height: 60vh;
}

.composer-advanced {
  border-top: 1px solid var(--border-color);
}

.advanced-toggle {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.72rem;
  padding: 6px 16px;
  width: 100%;
  text-align: left;
  transition: color 0.12s;
}
.advanced-toggle:hover { color: var(--text-primary); }

.advanced-body {
  padding: 8px 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-card);
}

.adv-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.adv-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-secondary);
  text-transform: uppercase;
  margin-bottom: 2px;
}

.adv-radio {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 0.82rem;
  color: var(--text-primary);
  cursor: pointer;
}

.adv-hint {
  font-size: 0.74rem;
  color: var(--text-secondary);
  opacity: 0.75;
}

.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-card);
}

.composer-hint {
  font-size: 0.72rem;
  color: var(--text-secondary);
  opacity: 0.6;
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
}

.composer-hint kbd {
  font-family: inherit;
  font-size: 0.70rem;
  font-weight: 700;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 3px;
  padding: 0px 4px;
}

.hint-sep { opacity: 0.4; margin: 0 2px; }

.hint-global { opacity: 0.75; }
.hint-global kbd {
  font-weight: 400;
  color: var(--text-secondary);
  background: transparent;
  border-color: var(--border-color);
  opacity: 0.8;
}

.composer-footer-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.model-badge {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 1px 7px;
  border-radius: 8px;
  background: rgba(160, 125, 224, 0.18);
  color: #a07de0;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.auto-badge {
  background: rgba(100, 200, 120, 0.15);
  color: #5dba6e;
}

.schedule-badge {
  text-transform: none;
  letter-spacing: normal;
  background: rgba(212, 168, 67, 0.15);
  color: #d4a843;
}

.schedule-input {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 5px;
  padding: 4px 8px;
  color: var(--text-primary);
  font-family: inherit;
  font-size: 0.8rem;
  outline: none;
  width: fit-content;
}
.schedule-input:focus { border-color: var(--color-atom-code); }

.schedule-error {
  font-size: 0.72rem;
  color: #e05555;
}

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

.composer-fade-enter-active,
.composer-fade-leave-active { transition: opacity 0.15s; }
.composer-fade-enter-from,
.composer-fade-leave-to { opacity: 0; }
</style>
