<script setup lang="ts">
import { ref } from 'vue'
import type { Atom } from '../stores/session'
import { useSessionStore } from '../stores/session'
import { useSettingsStore } from '../stores/settings'
import DiffViewer from './DiffViewer.vue'
import ToolUseBody from './ToolUseBody.vue'

const props = defineProps<{ atom: Atom; focusMode?: boolean }>()
const store = useSessionStore()
const settings = useSettingsStore()

// Local expansion state for raw mode (independent from atom.collapsed)
const rawNoteOpen = ref(true)

function fileTypeColor(ft: Atom['fileType']): string {
  switch (ft) {
    case 'Code':    return 'var(--color-atom-code)'
    case 'Config':  return 'var(--color-atom-config)'
    case 'Markup':  return 'var(--color-atom-markup)'
    case 'Style':   return 'var(--color-atom-style)'
    case 'Build':   return 'var(--color-atom-build)'
    case 'Data':    return 'var(--color-atom-data)'
    default:        return 'var(--color-atom-neutral)'
  }
}

function actionColor(a: Atom['action']): string {
  switch (a) {
    case 'Create': return 'var(--color-action-create)'
    case 'Modify': return 'var(--color-action-modify)'
    case 'Delete': return 'var(--color-action-delete)'
    default:       return 'var(--color-atom-neutral)'
  }
}

function actionLabel(a: Atom['action']): string {
  switch (a) {
    case 'Create': return '+'
    case 'Modify': return '~'
    case 'Delete': return '−'
    default:       return '?'
  }
}

function toggle() {
  store.toggleCollapse(props.atom.id)
}

function toggleRawNote() {
  rawNoteOpen.value = !rawNoteOpen.value
}

function toolName(content: string): string {
  return content.split('\n')[0].trim()
}

function toolTitle(content: string): string {
  const lines = content.split('\n')
  const jsonPart = lines.slice(1).join('\n').trim()
  try {
    const obj = JSON.parse(jsonPart)
    const keys = ['description', 'command', 'path', 'file_path', 'pattern', 'query']
    for (const k of keys) {
      if (typeof obj[k] === 'string' && obj[k].trim()) return `${k}: ${obj[k].trim()}`
    }
  } catch {}
  return ''
}

const CONTROL_PREFIXES = ['✓', '→', '✗']

function replyBadge(content: string): string {
  const first = content[0]
  return CONTROL_PREFIXES.includes(first) ? content.split(' ')[0] : '→'
}

function replyBody(content: string): string {
  const first = content[0]
  if (CONTROL_PREFIXES.includes(first)) {
    const sp = content.indexOf(' ')
    return sp >= 0 ? content.slice(sp + 1) : ''
  }
  return content
}

</script>

<template>
  <div
    class="atom-card"
    :class="{
      'is-error': atom.atomType === 'Error',
      'is-user-reply': atom.atomType === 'UserReply',
      'is-pragma-event': atom.atomType === 'PragmaEvent',
    }"
    :style="{ '--ft-color': fileTypeColor(atom.fileType) }"
  >
    <!-- FileTouch -->
    <template v-if="atom.atomType === 'FileTouch'">
      <div class="atom-row file-touch">
        <span class="action-glyph" :style="{ color: actionColor(atom.action) }">
          {{ actionLabel(atom.action) }}
        </span>
        <span class="file-path" :style="{ color: fileTypeColor(atom.fileType) }">
          {{ atom.filePath }}
        </span>
        <span class="tag">{{ atom.fileType?.toLowerCase() }}</span>
        <span class="tag action-tag" :style="{ color: actionColor(atom.action) }">
          {{ atom.action?.toLowerCase() }}
        </span>
      </div>
    </template>

    <!-- Diff -->
    <template v-else-if="atom.atomType === 'Diff'">
      <div class="atom-row clickable" @click="toggle">
        <span class="type-badge diff-badge">diff</span>
        <span class="file-path diff-path">{{ atom.filePath }}</span>
        <span class="chevron">{{ atom.collapsed && !settings.settings.diffAlwaysOpen ? '▶' : '▼' }}</span>
      </div>
      <DiffViewer v-if="!atom.collapsed || settings.settings.diffAlwaysOpen" :content="atom.content" />
    </template>

    <!-- ToolUse -->
    <template v-else-if="atom.atomType === 'ToolUse'">
      <div class="atom-row clickable" @click="toggle">
        <span class="type-badge tool" :class="{ agent: toolName(atom.content) === 'Agent' }">{{ toolName(atom.content) }}</span>
        <span v-if="toolTitle(atom.content)" class="tool-title">{{ toolTitle(atom.content) }}</span>
        <span class="chevron">{{ atom.collapsed ? '▶' : '▼' }}</span>
      </div>
      <ToolUseBody v-if="!atom.collapsed" :content="atom.content" />
    </template>

    <!-- Error -->
    <template v-else-if="atom.atomType === 'Error'">
      <div
        class="atom-row error-row"
        :class="{ clickable: atom.content && atom.content !== 'error' }"
        @click="atom.content && atom.content !== 'error' ? toggle() : undefined"
      >
        <span class="type-badge error">error</span>
        <span v-if="atom.content && atom.content !== 'error'" class="error-summary">{{ atom.content.split('\n')[0] }}</span>
        <span v-if="atom.content && atom.content !== 'error'" class="chevron">{{ atom.collapsed ? '▶' : '▼' }}</span>
      </div>
      <pre v-if="!atom.collapsed && atom.content && atom.content !== 'error'" class="error-detail">{{ atom.content }}</pre>
    </template>

    <!-- PragmaEvent (analysis / questions / plan / step / report) -->
    <template v-else-if="atom.atomType === 'PragmaEvent'">
      <div class="pragma-event">
        <span class="pragma-event-label">{{ atom.content.split('\n')[0] }}</span>
        <pre class="pragma-event-body">{{ atom.content.split('\n').slice(1).join('\n') }}</pre>
      </div>
    </template>

    <!-- UserReply -->
    <template v-else-if="atom.atomType === 'UserReply'">
      <span class="reply-badge">{{ replyBadge(atom.content) }}</span>
      <span v-if="atom.source === 'Remote'" class="remote-badge" data-testid="atom-remote" title="Sent from the web page (W9)">from web</span>
      <pre class="reply-body">{{ replyBody(atom.content) }}</pre>
    </template>

    <!-- AgentNote: raw = direct text; focus = collapsible -->
    <template v-else>
      <template v-if="!focusMode">
        <div class="atom-row clickable" @click="toggleRawNote">
          <span class="type-badge note">note</span>
          <span class="chevron">{{ rawNoteOpen ? '▼' : '▶' }}</span>
        </div>
        <div v-if="rawNoteOpen" class="atom-body agent-note">{{ atom.content }}</div>
      </template>
      <template v-else>
        <div class="atom-row clickable" @click="toggle">
          <span class="type-badge note">note</span>
          <span class="preview">{{ atom.content.split('\n')[0].trim() }}</span>
          <span class="chevron">{{ atom.collapsed ? '▶' : '▼' }}</span>
        </div>
        <div v-if="!atom.collapsed" class="atom-body agent-note">{{ atom.content }}</div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.atom-card {
  border-left: 3px solid var(--ft-color, var(--color-atom-neutral));
  background: var(--bg-card);
  border-radius: 4px;
  overflow: hidden;
  font-size: 0.82rem;
  flex-shrink: 0;
}

.atom-card.is-error {
  border-left-color: var(--color-error);
}

.atom-card.is-pragma-event {
  border-left-color: #56b6c2;
  background: rgba(86, 182, 194, 0.05);
}

.pragma-event-label {
  display: block;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #56b6c2;
  opacity: 0.85;
  padding: 5px 10px 2px;
}

.pragma-event-body {
  font-family: inherit;
  font-size: 0.78rem;
  color: var(--text-primary);
  opacity: 0.9;
  padding: 0 10px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
  line-height: 1.5;
}

.atom-card.is-user-reply {
  border-left-color: #a07de0;
  background: rgba(160, 125, 224, 0.06);
}

.remote-badge {
  margin-left: 6px;
  font-size: 0.66rem;
  color: #c98a30;
  border: 1px solid rgba(201, 138, 48, 0.5);
  border-radius: 4px;
  padding: 0 4px;
}
.reply-badge {
  display: block;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #a07de0;
  opacity: 0.75;
  padding: 5px 10px 2px;
}

.reply-body {
  font-family: inherit;
  font-size: 0.78rem;
  font-style: italic;
  color: #a07de0;
  opacity: 0.9;
  padding: 0 10px 8px;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.atom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  min-height: 28px;
}

.atom-row.clickable {
  cursor: pointer;
  user-select: none;
}
.atom-row.clickable:hover {
  background: rgba(255, 255, 255, 0.04);
}

.action-glyph {
  font-weight: 700;
  font-size: 1rem;
  width: 14px;
  text-align: center;
  flex-shrink: 0;
}

.file-path {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag {
  font-size: 0.68rem;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.action-tag {
  background: transparent;
  font-weight: 600;
}

.type-badge {
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.type-badge.tool  { color: var(--color-atom-config); }
.type-badge.agent { color: #4169e1; background: rgba(65, 105, 225, 0.12); }

.tool-title {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-style: italic;
  color: var(--text-secondary);
  opacity: 0.85;
}
.type-badge.error { color: var(--color-error); background: rgba(255, 59, 48, 0.15); }
.type-badge.note  { color: var(--text-secondary); opacity: 0.7; }
.type-badge.diff-badge { color: var(--text-secondary); opacity: 0.45; }
.file-path.diff-path   { color: var(--text-secondary); opacity: 0.45; }

.chevron {
  color: var(--text-secondary);
  font-size: 0.6rem;
  flex-shrink: 0;
}

.preview {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.atom-body {
  padding: 6px 10px;
  font-family: inherit;
  font-size: 0.78rem;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-color);
  max-height: 400px;
  overflow-y: auto;
}

.atom-body.agent-note {
  border-top: none;
  color: var(--text-primary);
  opacity: 0.85;
  padding: 5px 10px;
}

.error-row {
  padding: 6px 10px;
}
.error-summary {
  color: var(--color-error);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.error-detail {
  margin: 0;
  padding: 6px 10px 8px;
  font-family: monospace;
  font-size: 0.78rem;
  color: var(--color-error);
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}

</style>
