<script setup lang="ts">
defineProps<{
  workingDir: string
  attachments: string[]
  // False = the file no longer exists on disk: the chip turns red instead of disappearing,
  // so the user understands something is missing instead of finding one attachment fewer.
  attachmentExists: Record<string, boolean>
  disabled: boolean
}>()

const emit = defineEmits<{
  pickDir: []
  clearDir: []
  attach: []
  remove: [name: string]
}>()
</script>

<template>
  <div class="header-workdir">
    <div class="workdir-group" :class="{ 'workdir-group--set': !!workingDir, 'workdir-group--disabled': disabled }" @click="!disabled && emit('pickDir')">
      <span class="group-label">dir</span>
      <span class="workdir-icon">⌂</span>
      <span class="workdir-path" :class="{ empty: !workingDir }" :title="workingDir || ''">{{ workingDir || 'none' }}</span>
      <button v-if="workingDir" class="workdir-clear" :disabled="disabled" title="Remove directory" @click.stop="emit('clearDir')">×</button>
    </div>
    <div
      class="attach-group"
      :class="{ 'attach-group--active': attachments.length > 0, 'attach-group--disabled': disabled }"
      :title="workingDir ? 'Attach file' : 'Choose working directory and attach file'"
      @click="!disabled && emit('attach')"
    >
      <span class="group-label">files</span>
      <span class="attach-icon">📎</span>
      <span
        v-for="name in attachments"
        :key="name"
        class="attach-chip"
        :class="{ 'attach-chip--missing': attachmentExists[name] === false }"
        :title="attachmentExists[name] === false ? `File not found: ${name}` : name"
      >
        <span class="chip-name">{{ name }}</span>
        <button class="chip-remove" @click.stop="emit('remove', name)">×</button>
      </span>
      <span v-if="!attachments.length" class="attach-empty">no files</span>
    </div>
  </div>
</template>

<style scoped>
.header-workdir {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px 8px;
}

.workdir-group,
.attach-group {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.workdir-group--disabled,
.attach-group--disabled { cursor: not-allowed; opacity: 0.5; }

.group-label {
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.45;
  flex-shrink: 0;
  user-select: none;
}

.workdir-group {
  border-color: rgba(180, 130, 50, 0.25);
  background: rgba(180, 130, 50, 0.06);
}
.workdir-group:hover:not(.workdir-group--disabled) {
  border-color: rgba(180, 130, 50, 0.5);
  background: rgba(180, 130, 50, 0.12);
}
.workdir-group .group-label { color: #c8973a; opacity: 0.7; }
.workdir-group--set { border-color: rgba(180, 130, 50, 0.45); background: rgba(180, 130, 50, 0.1); }
.workdir-group--set .group-label { opacity: 1; }

.attach-group {
  border-color: rgba(80, 170, 160, 0.2);
  background: rgba(80, 170, 160, 0.05);
  flex-wrap: wrap;
  max-width: 600px;
}
.attach-group:hover:not(.attach-group--disabled) {
  border-color: rgba(80, 170, 160, 0.45);
  background: rgba(80, 170, 160, 0.1);
}
.attach-group .group-label { color: #50aaa0; opacity: 0.7; }
.attach-group--active { border-color: rgba(80, 170, 160, 0.45); background: rgba(80, 170, 160, 0.1); }
.attach-group--active .group-label { opacity: 1; }

.attach-empty { font-size: 0.72rem; font-style: italic; opacity: 0.35; }

.workdir-icon { color: #c8973a; font-size: 0.9rem; flex-shrink: 0; opacity: 0.8; pointer-events: none; }

.workdir-path {
  font-size: 0.75rem;
  font-family: monospace;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
  max-width: 420px;
  cursor: pointer;
  transition: color 0.15s;
}
.workdir-path:hover:not(.empty) { color: var(--text-primary); }
.workdir-path.empty { opacity: 0.4; cursor: default; font-family: inherit; font-style: italic; }

.workdir-clear {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.8rem;
  padding: 0 2px;
  flex-shrink: 0;
  line-height: 1;
}
.workdir-clear:hover { color: #e06c75; }

.attach-icon { flex-shrink: 0; pointer-events: none; font-size: 0.85rem; color: #50aaa0; opacity: 0.8; }

.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: rgba(80, 170, 160, 0.12);
  border: 1px solid rgba(80, 170, 160, 0.35);
  border-radius: 12px;
  padding: 2px 8px 2px 10px;
  font-size: 0.72rem;
  font-family: monospace;
  color: #50aaa0;
  max-width: 200px;
}
.attach-chip--missing { background: rgba(200, 60, 60, 0.10); border-color: rgba(200, 60, 60, 0.40); color: #c44; }

.chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

.chip-remove {
  background: none;
  border: none;
  color: #50aaa0;
  cursor: pointer;
  font-size: 0.75rem;
  padding: 0;
  line-height: 1;
  flex-shrink: 0;
  opacity: 0.7;
}
.chip-remove:hover { color: #e06c75; opacity: 1; }
</style>
