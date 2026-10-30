<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { webLink, providePin } from '../platform'
import { isValidPin, PIN_MIN_DIGITS } from '../remote/pin'

// Web build only: says how you stand with the Pragma on the PC. A full panel when the
// link leads nowhere; a thin strip when the connection is alive but with a
// limit (network coming back, PC offline, read-only).

const blocking = computed(() => {
  switch (webLink.status) {
    case 'connecting':
      return { title: 'Connecting to Pragma…', text: '', spinner: true }
    case 'no_token':
      return {
        title: 'Open the link from Pragma',
        text: 'This page shows a Pragma that someone is sharing. Open the link from the share button in Pragma on the PC.',
      }
    case 'not_found':
      return {
        title: 'This link is no longer active',
        text: 'Pragma is not being shared right now, or it was restarted. Press share again on the PC and open the new link.',
      }
    case 'closed':
      return webLink.closedReason === 'host_gone'
        ? { title: 'The PC went offline', text: 'It did not come back in time. Press share again on the PC and open the new link.' }
        : { title: 'Sharing stopped', text: 'Sharing was stopped on the PC. Press share again there to get a new link.' }
    case 'room_full':
      return { title: 'Too many viewers', text: 'Too many people are watching this Pragma. Try again in a moment.' }
    case 'error':
      return { title: 'Could not connect', text: webLink.error ?? 'Something went wrong.' }
    default:
      return null
  }
})

const banner = computed(() => {
  switch (webLink.status) {
    case 'reconnecting':
      return { kind: 'wait', text: 'Connection lost — reconnecting…' }
    case 'host_offline':
      return { kind: 'wait', text: 'The PC is offline — waiting for it to come back…' }
    case 'live':
      return webLink.commandsEnabled
        ? null
        : { kind: 'info', text: 'View only — commands from the web are switched off on the PC.' }
    default:
      return null
  }
})

// — Command PIN: asked at the first command, then the phone remembers it while the tab is open —
const pinDraft = ref('')
const pinInput = ref<HTMLInputElement | null>(null)
watch(() => webLink.pinPrompt, async (open) => {
  pinDraft.value = ''
  if (open) { await nextTick(); pinInput.value?.focus() }
})
function submitPin() { if (isValidPin(pinDraft.value)) providePin(pinDraft.value) }
function cancelPin() { providePin(null) }
</script>

<template>
  <div v-if="blocking" class="gate" data-testid="web-gate" :data-status="webLink.status">
    <div class="gate-card">
      <div v-if="blocking.spinner" class="gate-dots"><span /><span /><span /></div>
      <div class="gate-title">{{ blocking.title }}</div>
      <div v-if="blocking.text" class="gate-text">{{ blocking.text }}</div>
    </div>
  </div>
  <div v-else-if="banner" class="gate-banner" :class="banner.kind" data-testid="web-banner" :data-status="webLink.status">
    {{ banner.text }}
  </div>
  <div v-if="webLink.pinPrompt" class="pin-overlay" data-testid="pin-prompt" @click.self="cancelPin">
    <form class="pin-card" @submit.prevent="submitPin">
      <div class="gate-title">Enter your PIN</div>
      <div class="gate-text">The PIN set in Pragma on the PC. It is asked once while this page stays open.</div>
      <input
        ref="pinInput"
        v-model="pinDraft"
        class="pin-input"
        data-testid="pin-input"
        type="password"
        inputmode="numeric"
        autocomplete="off"
        :maxlength="12"
        :placeholder="`${PIN_MIN_DIGITS}+ digits`"
      />
      <div class="pin-actions">
        <button type="button" class="pin-btn" data-testid="pin-cancel" @click="cancelPin">Cancel</button>
        <button type="submit" class="pin-btn pin-ok" data-testid="pin-ok" :disabled="!isValidPin(pinDraft)">OK</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
/* Above the initial splash (z-index 9999): if the link is not valid, the message must show right away. */
.gate {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-primary);
}
.gate-card {
  max-width: 420px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}
.gate-title { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); }
.gate-text { font-size: 0.88rem; line-height: 1.5; color: var(--text-secondary); }

.gate-dots { display: flex; gap: 8px; }
.gate-dots span {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--color-atom-code);
  animation: gate-pulse 1.2s ease-in-out infinite;
}
.gate-dots span:nth-child(2) { animation-delay: 0.2s; }
.gate-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes gate-pulse { 0%, 80%, 100% { opacity: 0.25; } 40% { opacity: 1; } }

/* In the flow, at the top of the page: pinned at the bottom it covered the tab bar on the phone. */
.gate-banner {
  flex-shrink: 0;
  padding: 5px 16px;
  font-size: 0.75rem;
  text-align: center;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.pin-overlay {
  position: fixed;
  inset: 0;
  z-index: 9800;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: rgba(0, 0, 0, 0.55);
}
.pin-card {
  width: min(340px, 100%);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 22px 20px 18px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  text-align: center;
}
.pin-input {
  padding: 10px 12px;
  font-size: 1.3rem;
  letter-spacing: 0.4em;
  text-align: center;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  outline: none;
}
.pin-input:focus { border-color: var(--color-atom-code); }
.pin-actions { display: flex; gap: 10px; justify-content: center; }
.pin-btn {
  min-width: 96px;
  padding: 9px 16px;
  background: none;
  border: 1px solid var(--border-color);
  border-radius: 7px;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}
.pin-ok { background: var(--color-atom-code); border-color: var(--color-atom-code); color: #fff; font-weight: 600; }
.pin-ok:disabled { opacity: 0.4; cursor: not-allowed; }

.gate-banner.wait { color: #c98a30; border-bottom-color: #c98a30; background: rgba(201, 138, 48, 0.12); }
</style>
