<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSessionStore, type PragmaReview } from '../stores/session'
import { canCommand } from '../webCaps'

interface Profile {
  label: string
  binary: string
  configDir?: string | null
}

const props = defineProps<{
  data: PragmaReview
  profile: Profile | null
  projectId: string
  workingDir?: string
  collapsed: boolean
}>()
defineEmits<{ toggle: [] }>()

const store = useSessionStore()
const openDetail = ref<number | null>(null)
const deepReviewDismissed = ref(false)

const statusText = computed(() => {
  switch (props.data.verdict) {
    case 'pass':     return '✓ review passed'
    case 'findings': return `✗ ${props.data.findings.length} finding(s)`
    case 'skipped':  return '– review skipped'
    default:         return '⚠ review undetermined'
  }
})

// Never automatic: Pragma cannot launch `/code-review ultra`
// by itself (a Claude Code command, billed, it must be started by the user). Only an
// informational banner, same pattern as the model suggestion on PLAN.
const showDeepReviewBanner = computed(() =>
  !props.collapsed && !deepReviewDismissed.value && props.data.deepReviewSuggested
)

// Actions only make sense while a decision is actually pending: findings present,
// not yet accepted, and no turn currently running.
const decisionPending = computed(() =>
  props.data.verdict === 'findings' && !store.reviewAccepted && !store.running
)

function onFix() {
  if (!props.profile) return
  store.fixReviewFindings(
    props.profile.binary,
    props.projectId,
    props.profile.configDir ?? undefined,
    props.workingDir,
  )
}
</script>

<template>
  <div class="pragma-card review-card" data-testid="review-card">
    <div class="card-header" @click.self="$emit('toggle')">
      <button class="chevron-btn" :class="{ open: !collapsed }" @click="$emit('toggle')">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="card-label" @click="$emit('toggle')">REVIEW</span>
      <span
        v-if="data.securityPass"
        class="security-pill"
        data-testid="review-security-pill"
        title="This diff touches sensitive surfaces — the review included a security pass"
      >SEC</span>
      <span v-if="data.round > 0" class="round-pill" title="Fix→Review round">r{{ data.round + 1 }}</span>
      <span class="review-status" data-testid="review-status" :class="data.verdict" @click="$emit('toggle')">{{ statusText }}</span>
    </div>

    <div class="card-collapse" :class="{ 'is-collapsed': collapsed }">
      <div class="card-inner">
        <div v-if="showDeepReviewBanner" class="deep-review-banner" data-testid="deep-review-banner">
          <span class="deep-review-text">
            ⚡ Large diff ({{ data.filesChanged }} file(s), {{ data.linesChanged }} line(s)) —
            consider a deeper, multi-agent pass
          </span>
          <div class="deep-review-note">
            Run <code>/code-review ultra</code> yourself in Claude Code — it's billed separately
            and Pragma can't launch it for you.
          </div>
          <div class="deep-review-actions">
            <button class="model-btn-dismiss" @click="deepReviewDismissed = true">Dismiss</button>
          </div>
        </div>
        <div class="review-body">
          <div v-if="data.note" class="review-note">{{ data.note }}</div>
          <div v-if="data.diffTruncated" class="review-warn">
            Diff truncated before review — a large diff is a candidate for a deep review.
          </div>
          <div v-if="data.verdict === 'pass' && !data.usedInvariants" class="review-hint" data-testid="review-hint-generic">
            No project invariants configured — this was a generic review.
          </div>

          <!-- The security hand-off travels inside the same review.
               Here we only declare that it was included and on which files, because "I
               also looked at security" without saying where is not verifiable. -->
          <div v-if="data.securityPass" class="security-note" data-testid="review-security-note">
            <div class="security-note-head">
              🔒 Security pass included — {{ data.sensitiveFiles.length }} sensitive file(s) in this diff
            </div>
            <ul class="security-file-list">
              <li v-for="f in data.sensitiveFiles" :key="f">{{ f }}</li>
            </ul>
            <div v-if="data.sensitiveFromDefaults" class="review-hint" data-testid="review-security-defaults-hint">
              Matched by Pragma's default patterns — set the project's sensitive paths for a
              sharper pass.
            </div>
            <div class="review-hint">
              For a dedicated deep pass, run <code>/security-review</code> yourself in Claude Code.
            </div>
          </div>

          <ul v-if="data.findings.length" class="finding-list" data-testid="review-findings">
            <li
              v-for="(f, i) in data.findings"
              :key="i"
              class="finding"
              :class="f.severity"
            >
              <div class="finding-head" @click="openDetail = openDetail === i ? null : i">
                <span class="finding-sev">{{ f.severity }}</span>
                <span class="finding-summary">{{ f.summary }}</span>
              </div>
              <div v-if="f.file" class="finding-loc">{{ f.file }}<template v-if="f.line">:{{ f.line }}</template></div>
              <div v-if="openDetail === i && f.detail" class="finding-detail">{{ f.detail }}</div>
            </li>
          </ul>

          <div v-if="store.reviewAccepted" class="review-accepted" data-testid="review-accepted-note">
            Findings accepted — recorded in this session.
          </div>

          <div v-if="decisionPending && canCommand" class="review-actions">
            <button
              v-if="store.canFixReview && !store.reviewFixSent"
              class="rv-btn rv-fix"
              data-testid="review-fix"
              :disabled="!profile || !workingDir"
              :title="!workingDir ? 'Requires a working directory' : 'Send findings back for a fix turn'"
              @click="onFix"
            >Fix</button>
            <button class="rv-btn rv-accept" data-testid="review-accept" @click="store.acceptReviewFindings()">Accept</button>
            <span v-if="!store.canFixReview" class="rv-limit">
              Fix limit reached — your call.
            </span>
            <span v-else-if="store.reviewFixSent" class="rv-limit" data-testid="review-fix-sent-note">
              Fix already sent, no new review came back — accept or leave as is.
            </span>
          </div>
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

.card-label {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #a07de0;
  opacity: 0.9;
}

.round-pill {
  font-size: 0.6rem;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(160, 125, 224, 0.18);
  color: #a07de0;
}

.security-pill {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(201, 138, 48, 0.18);
  color: #c98a30;
  cursor: help;
}

.review-status {
  flex: 1;
  text-align: right;
  font-size: 0.7rem;
  font-weight: 600;
}
.review-status.pass     { color: #4caf50; }
.review-status.findings { color: #e05252; }
.review-status.skipped  { color: var(--text-secondary); }
.review-status.error    { color: #c98a30; }

.card-collapse {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.24s ease;
  overflow: hidden;
}
.card-collapse.is-collapsed { grid-template-rows: 0fr; }
.card-collapse > .card-inner {
  overflow: hidden;
  min-height: 0;
}

.review-body {
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.deep-review-banner {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(160, 125, 224, 0.07);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.deep-review-text {
  font-size: 0.78rem;
  color: #a07de0;
  line-height: 1.4;
}

.deep-review-note {
  font-size: 0.72rem;
  color: var(--text-secondary);
  line-height: 1.4;
  font-style: italic;
}
.deep-review-note code {
  font-family: monospace;
  background: rgba(160, 125, 224, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
}

.deep-review-actions {
  display: flex;
  gap: 6px;
}

.security-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px;
  border-left: 2px solid rgba(201, 138, 48, 0.5);
  background: rgba(201, 138, 48, 0.06);
  border-radius: 3px;
}

.security-note-head {
  font-size: 0.74rem;
  font-weight: 600;
  color: #c98a30;
}

.security-file-list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.security-file-list li {
  font-family: monospace;
  font-size: 0.68rem;
  color: var(--color-atom-config);
  word-break: break-all;
}

.security-note code {
  font-family: monospace;
  background: rgba(201, 138, 48, 0.15);
  padding: 1px 4px;
  border-radius: 3px;
}

.model-btn-dismiss {
  padding: 3px 10px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  transition: color 0.12s;
}
.model-btn-dismiss:hover { color: var(--text-primary); }

.review-note,
.review-hint {
  font-size: 0.72rem;
  color: var(--text-secondary);
  font-style: italic;
}
.review-warn {
  font-size: 0.72rem;
  color: #c98a30;
}

.finding-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.finding {
  border-left: 2px solid rgba(150, 150, 190, 0.35);
  padding-left: 8px;
}
.finding.high   { border-left-color: #e05252; }
.finding.medium { border-left-color: #c98a30; }
.finding.low    { border-left-color: rgba(150, 150, 190, 0.5); }

.finding-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  cursor: pointer;
}

.finding-sev {
  flex-shrink: 0;
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-secondary);
}

.finding-summary {
  font-size: 0.78rem;
  color: var(--text-primary);
  line-height: 1.35;
}

.finding-loc {
  font-family: monospace;
  font-size: 0.68rem;
  color: var(--color-atom-config);
  margin-top: 2px;
  word-break: break-all;
}

.finding-detail {
  margin-top: 4px;
  font-size: 0.72rem;
  color: var(--text-secondary);
  line-height: 1.45;
  white-space: pre-wrap;
}

.review-accepted {
  font-size: 0.72rem;
  color: #4caf50;
}

.review-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--border-color);
}

.rv-btn {
  padding: 4px 12px;
  border-radius: 5px;
  border: none;
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
}
.rv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rv-fix    { background: #a07de0; color: #fff; }
.rv-fix:hover:not(:disabled) { opacity: 0.85; }
.rv-accept {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}
.rv-accept:hover { color: var(--text-primary); }

.rv-limit {
  font-size: 0.68rem;
  color: var(--text-secondary);
  font-style: italic;
}
</style>
