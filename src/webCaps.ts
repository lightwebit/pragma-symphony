import { computed } from 'vue'
import { IS_WEB, webLink } from './platform'

// What the web version shows. Two rules, one per kind of button:
// - «desktop only» (files and folders, settings, export, usage, E2E/Live/CI, share): they are never
//   there on the web — the relay would not forward them anyway (policy.ts, `desktop_only`);
// - «command» (start, Approve, answers, todo…): they are there only if the web-commands
//   switch is on on the PC. While it is off, showing them would mean offering a button that always says no.
// On the desktop both are true: for anyone not using the web nothing changes.

/** false only in the web build. */
export const showDesktopOnly: boolean = !IS_WEB

/** Can commands be given from here? On the desktop always; on the web only if the PC accepts them. */
export const canCommand = computed(() => !IS_WEB || webLink.commandsEnabled)
