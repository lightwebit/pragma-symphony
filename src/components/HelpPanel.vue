<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'

const emit = defineEmits<{ close: [] }>()

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => window.addEventListener('keydown', onKeyDown))
onUnmounted(() => window.removeEventListener('keydown', onKeyDown))
</script>

<template>
  <div class="help-overlay" @click.self="emit('close')">
    <div class="help-modal" data-testid="help-panel">
      <div class="help-header">
        <span class="help-title">guide</span>
        <button class="help-close" data-testid="help-close" @click="$emit('close')">×</button>
      </div>

      <div class="help-body">

        <!-- FLOWS -->
        <section class="help-section">
          <h2 class="help-section-title">Flows</h2>

          <div class="flow-block">
            <div class="flow-name">Standard</div>
            <div class="flow-steps">
              <span class="fs">Analysis</span>
              <span class="fa">→</span>
              <span class="fs">Plan</span>
              <span class="fa">→</span>
              <span class="fs highlight">Approve</span>
              <span class="fa">→</span>
              <span class="fs">Steps</span>
              <span class="fa">→</span>
              <span class="fs">Report</span>
              <span class="fa">→</span>
              <span class="fs">Close</span>
            </div>
            <p class="flow-desc">
              pragma analyzes the request, proposes a numbered plan, and waits for your approval before executing anything. After each step it reports progress, then produces a final report and a verification checklist.
            </p>
          </div>

          <div class="flow-block">
            <div class="flow-name">Questions</div>
            <div class="flow-steps">
              <span class="fs">Analysis</span>
              <span class="fa">→</span>
              <span class="fs highlight">Questions</span>
              <span class="fa">→</span>
              <span class="fs">Your answers</span>
              <span class="fa">→</span>
              <span class="fs">Plan…</span>
            </div>
            <p class="flow-desc">
              When the task is ambiguous, pragma asks clarifying questions before planning. Answer them in the composer — the session resumes automatically.
            </p>
          </div>

          <div class="flow-block">
            <div class="flow-name">Step-by-step</div>
            <div class="flow-steps">
              <span class="fs">Step 1</span>
              <span class="fa">→</span>
              <span class="fs highlight">Confirm</span>
              <span class="fa">→</span>
              <span class="fs">Step 2</span>
              <span class="fa">→</span>
              <span class="fs highlight">Confirm</span>
              <span class="fa">→</span>
              <span class="fs">…</span>
            </div>
            <p class="flow-desc">
              Uncheck <em>Auto-approve steps</em> in the composer to confirm each step manually before it executes. Useful for long or sensitive tasks.
            </p>
          </div>

          <div class="flow-block">
            <div class="flow-name">Continue</div>
            <div class="flow-steps">
              <span class="fs">Session done</span>
              <span class="fa">→</span>
              <span class="fs highlight">Continue</span>
              <span class="fa">→</span>
              <span class="fs">New prompt, same context</span>
            </div>
            <p class="flow-desc">
              After a session closes, <em>Continue</em> reopens the composer on the same session. Claude retains context from the previous exchange. Use <em>New session</em> to start fresh.
            </p>
          </div>
        </section>

        <!-- SHORTCUTS -->
        <section class="help-section">
          <h2 class="help-section-title">Shortcuts</h2>
          <div class="shortcuts-grid">
            <kbd>Ctrl+K</kbd><span>Open composer</span>
            <kbd>Ctrl+Enter</kbd><span>Send / Run</span>
            <kbd>Esc</kbd><span>Close composer</span>
            <kbd>Ctrl+,</kbd><span>Open settings</span>
            <kbd>Ctrl+S</kbd><span>Save settings (when open)</span>
          </div>
        </section>

        <!-- PANELS -->
        <section class="help-section">
          <h2 class="help-section-title">Interface</h2>
          <div class="iface-grid">
            <span class="iface-label">Left panel</span>
            <span>Session history — click to load, search with the input at the top</span>
            <span class="iface-label">Center stream</span>
            <span>Live atom feed — file changes, tool calls, agent notes, diffs</span>
            <span class="iface-label">Right panel</span>
            <span>Structured pragma output — analysis, plan, report, tests</span>
            <span class="iface-label">Focus mode</span>
            <span>Hides low-signal atoms (tool calls, file touches) — shows only decisions and errors</span>
            <span class="iface-label">Working dir</span>
            <span>Root directory Claude can read and modify. Leave empty for no file access</span>
          </div>
        </section>

      </div>
    </div>
  </div>
</template>

<style scoped>
.help-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.help-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  width: min(680px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.help-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.help-title {
  font-size: 0.85rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--color-atom-code);
}

.help-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 1.2rem;
  line-height: 1;
  padding: 0 2px;
  opacity: 0.6;
}
.help-close:hover { opacity: 1; }

.help-body {
  overflow-y: auto;
  padding: 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 28px;
}

.help-section-title {
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-secondary);
  opacity: 0.6;
  margin: 0 0 14px;
}

/* Flows */
.flow-block {
  margin-bottom: 18px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border-color);
}
.flow-block:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.flow-name {
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-secondary);
  margin-bottom: 8px;
  letter-spacing: 0.05em;
}

.flow-steps {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-bottom: 8px;
}

.fs {
  font-family: monospace;
  font-size: 0.72rem;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  white-space: nowrap;
}
.fs.highlight {
  border-color: var(--color-atom-code);
  color: var(--color-atom-code);
}

.fa {
  font-size: 0.65rem;
  color: var(--text-secondary);
  opacity: 0.4;
}

.flow-desc {
  font-size: 0.76rem;
  color: var(--text-secondary);
  line-height: 1.55;
  margin: 0;
  opacity: 0.8;
}
.flow-desc em {
  font-style: normal;
  color: var(--text-primary);
}

/* Shortcuts */
.shortcuts-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  align-items: center;
}

kbd {
  font-family: monospace;
  font-size: 0.72rem;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 2px 8px;
  color: var(--text-primary);
  white-space: nowrap;
}

.shortcuts-grid span {
  font-size: 0.76rem;
  color: var(--text-secondary);
}

/* Interface */
.iface-grid {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  align-items: baseline;
}

.iface-label {
  font-family: monospace;
  font-size: 0.7rem;
  color: var(--color-atom-code);
  white-space: nowrap;
}

.iface-grid span:not(.iface-label) {
  font-size: 0.76rem;
  color: var(--text-secondary);
  line-height: 1.45;
}
</style>
