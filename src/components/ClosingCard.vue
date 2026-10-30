<script setup lang="ts">
import type { PragmaClosing } from '../stores/session'
import { canCommand } from '../webCaps'

defineProps<{ data: PragmaClosing; collapsed: boolean }>()
defineEmits<{ toggle: []; continue: []; newSession: [] }>()
</script>

<template>
  <div class="pragma-card closing-card">
    <div class="card-header" @click.self="$emit('toggle')">
      <button class="chevron-btn" :class="{ open: !collapsed }" @click="$emit('toggle')">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 2L7 5L3 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span class="card-label" @click="$emit('toggle')">SESSION COMPLETE</span>
    </div>

    <div class="card-collapse" :class="{ 'is-collapsed': collapsed }">
      <div class="card-inner">
        <p class="closing-text">{{ data.text }}</p>
        <div v-if="canCommand" class="closing-actions">
          <button class="btn btn-continue" @click="$emit('continue')">Continue</button>
          <button class="btn btn-new" @click="$emit('newSession')">New session</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pragma-card {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-left: 3px solid #4caf50;
  border-radius: 6px;
  overflow: hidden;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  background: rgba(76, 175, 80, 0.08);
  border-bottom: 1px solid var(--border-color);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s;
}
.card-header:hover { background: rgba(76, 175, 80, 0.14); }

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
  color: #4caf50;
  opacity: 0.9;
}

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

.closing-text {
  font-size: 0.82rem;
  color: var(--text-primary);
  line-height: 1.5;
  padding: 10px 10px 6px;
  margin: 0;
}

.closing-actions {
  display: flex;
  gap: 6px;
  padding: 6px 10px 10px;
}

.btn {
  padding: 5px 14px;
  border-radius: 5px;
  border: none;
  font-family: inherit;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
}

.btn-continue {
  background: rgba(76, 175, 80, 0.18);
  color: #4caf50;
  border: 1px solid rgba(76, 175, 80, 0.35);
}
.btn-continue:hover { opacity: 0.8; }

.btn-new {
  background: var(--bg-secondary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
}
.btn-new:hover { color: var(--text-primary); }
</style>
