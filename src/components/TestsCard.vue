<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PragmaE2e, PragmaTests, PragmaVerify } from '../stores/session'

// `data` is optional: an E2E run is launched from the project button even without a
// session, so the card must be able to exist with no TESTS marker.
const props = defineProps<{
  data?: PragmaTests | null
  verify?: PragmaVerify | null
  e2e?: PragmaE2e | null
  collapsed: boolean
}>()
defineEmits<{ toggle: [] }>()

const items = computed(() => props.data?.items ?? [])

// TESTS is the model's account of the tests it ran, not a list to tick off
// (in real databases: outcomes, prose on what is covered, a few headings,
// no action for the user). It is shown as text, line by line. A line ending
// with ":" introduces the following ones and is set apart as a subheading; only the final ":",
// because a real line may contain one in the middle.
function isLeadIn(line: string): boolean {
  return /:$/.test(line.trim().replace(/[*_`]+$/, '').trimEnd())
}

const rows = computed(() =>
  items.value.map((text, i) => ({ text, i, leadIn: isLeadIn(text) })),
)
const rawOutputOpen = ref(false)
const lintOutputOpen = ref(false)
const e2eOutputOpen = ref(false)

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`
}

const copied = ref(false)
async function copyAll() {
  await navigator.clipboard.writeText(items.value.join('\n'))
  copied.value = true
  setTimeout(() => { copied.value = false }, 1200)
}
</script>

<template>
  <div class="pragma-card tests-card">
    <div class="card-header" @click.self="$emit('toggle')">
      <button class="chevron-btn" :class="{ open: !collapsed }" @click="$emit('toggle')">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="card-label" @click="$emit('toggle')">TESTS</span>
      <button v-if="items.length" class="copy-btn" :class="{ copied }" :title="copied ? 'copied' : 'copy'" @click="copyAll">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.4"/>
          <path d="M3 11V3a1 1 0 0 1 1-1h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
        </svg>
      </button>
    </div>

    <div class="card-collapse" :class="{ 'is-collapsed': collapsed }">
      <div class="card-inner">
        <div v-if="verify" class="verify-body" data-testid="verify-body" :class="{ passed: verify.passed && !verify.undetermined, failed: !verify.passed && !verify.undetermined, undetermined: verify.undetermined }">
          <div class="verify-status" data-testid="verify-status">
            <template v-if="verify.undetermined">⚠ automated check: undetermined</template>
            <template v-else-if="verify.passed">✓ automated check passed{{ verify.preexisting.length ? ` — ${verify.preexisting.length} pre-existing failure(s) unchanged` : '' }}</template>
            <template v-else>✗ {{ verify.newFailures.length }} new failure(s)</template>
          </div>
          <ul v-if="verify.newFailures.length" class="verify-failures">
            <li v-for="t in verify.newFailures" :key="t">{{ t }}</li>
          </ul>
          <button v-if="verify.rawTestOutput" class="verify-toggle" @click="rawOutputOpen = !rawOutputOpen">
            {{ rawOutputOpen ? 'hide raw output' : 'show raw output' }}
          </button>
          <pre v-if="rawOutputOpen && verify.rawTestOutput" class="verify-raw">{{ verify.rawTestOutput }}</pre>
          <template v-if="verify.lintOutput">
            <button class="verify-toggle" @click="lintOutputOpen = !lintOutputOpen">
              {{ lintOutputOpen ? 'hide lint output' : 'show lint output (informational)' }}
            </button>
            <pre v-if="lintOutputOpen" class="verify-raw">{{ verify.lintOutput }}</pre>
          </template>
        </div>
        <!-- E2E outcomes: a separate, declared level, never a gate. A red
             here blocks nothing, which is why it does not use VERIFY's solid red. -->
        <div
          v-if="e2e"
          class="e2e-body"
          :class="{ passed: e2e.passed && !e2e.undetermined, failed: !e2e.passed && !e2e.undetermined, undetermined: e2e.undetermined }"
        >
          <div class="e2e-status">
            <span class="e2e-badge">E2E</span>
            <template v-if="e2e.timedOut">⚠ timed out after {{ formatDuration(e2e.durationMs) }}</template>
            <template v-else-if="e2e.undetermined">⚠ undetermined</template>
            <template v-else-if="e2e.passed">✓ passed — {{ formatDuration(e2e.durationMs) }}</template>
            <template v-else>✗ {{ e2e.failedScenarios.length || '' }} failing scenario(s) — {{ formatDuration(e2e.durationMs) }}</template>
            <span class="e2e-informational">informational — never blocks</span>
          </div>
          <ul v-if="e2e.failedScenarios.length" class="verify-failures">
            <li v-for="s in e2e.failedScenarios" :key="s">{{ s }}</li>
          </ul>
          <button v-if="e2e.rawOutput" class="verify-toggle" @click="e2eOutputOpen = !e2eOutputOpen">
            {{ e2eOutputOpen ? 'hide E2E output' : 'show E2E output' }}
          </button>
          <pre v-if="e2eOutputOpen && e2e.rawOutput" class="verify-raw">{{ e2e.rawOutput }}</pre>
        </div>

        <div v-if="items.length" class="tests-body" data-testid="tests-body">
          <div
            v-for="r in rows"
            :key="r.i"
            :class="r.leadIn ? 'test-leadin' : 'test-line'"
          >{{ r.text }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pragma-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-left: 3px solid #c98a30;
  border-radius: 6px;
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: rgba(201, 138, 48, 0.08);
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.card-header:hover { background: rgba(201, 138, 48, 0.14); }

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

.card-label {
  flex: 1;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #c98a30;
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

.tests-body {
  padding: 6px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.verify-body {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.verify-status {
  font-size: 0.78rem;
  font-weight: 600;
}
.verify-body.passed .verify-status { color: #4caf50; }
.verify-body.failed .verify-status { color: #e05252; }
.verify-body.undetermined .verify-status { color: #c98a30; }

.e2e-body {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.e2e-status {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
  font-size: 0.78rem;
  font-weight: 600;
}
.e2e-body.passed .e2e-status { color: #4caf50; }
.e2e-body.failed .e2e-status { color: #d08770; }
.e2e-body.undetermined .e2e-status { color: #c98a30; }

.e2e-badge {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid currentColor;
  opacity: 0.8;
}

.e2e-informational {
  font-size: 0.63rem;
  font-weight: 400;
  color: var(--text-secondary);
  opacity: 0.75;
}

.verify-failures {
  margin: 0;
  padding-left: 18px;
  font-size: 0.76rem;
  color: var(--text-primary);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.verify-toggle {
  align-self: flex-start;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 0.7rem;
  cursor: pointer;
  padding: 0;
  text-decoration: underline;
}
.verify-toggle:hover { color: var(--text-primary); }

.verify-raw {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-size: 0.7rem;
  line-height: 1.4;
  background: rgba(0, 0, 0, 0.18);
  border-radius: 4px;
  padding: 6px 8px;
  white-space: pre-wrap;
  word-break: break-word;
}

.test-leadin {
  padding: 5px 2px 1px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
  line-height: 1.4;
}
.test-leadin:first-child { padding-top: 1px; }

.test-line {
  padding: 1px 2px;
  font-size: 0.8rem;
  color: var(--text-primary);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
