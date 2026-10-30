import { describe, it, expect } from 'vitest'
import {
  FORWARDED_EVENTS, READ_COMMANDS, cleanArgs, isReadCommand, redactSettings, type ReadCommand,
} from './policy'

describe('list of read commands', () => {
  it('contains only the nine reads of the protocol', () => {
    expect([...READ_COMMANDS].sort()).toEqual([
      'get_project', 'get_settings', 'list_projects', 'list_scheduled_sessions', 'list_sessions',
      'list_todos', 'load_session', 'pragma.snapshot', 'search_sessions',
    ])
  })

  it.each([
    'run_pragma', 'send_control', 'kill_session', 'review_fix', 'delete_session', 'delete_project',
    'save_settings_cmd', 'run_live_command', 'run_project_pipeline', 'run_e2e_suite', 'trust_directory',
    'open_url', 'pick_directory', 'create_todo', 'pragma.review_accept', '', 'inventato',
  ])('%s non è una lettura', (cmd) => {
    expect(isReadCommand(cmd)).toBe(false)
  })

  it('a value that is not a string is not a read', () => {
    expect(isReadCommand(undefined)).toBe(false)
    expect(isReadCommand(42)).toBe(false)
    expect(isReadCommand({ toString: () => 'list_projects' })).toBe(false)
  })
})

describe('cleaned arguments', () => {
  it('only the expected keys pass, the others are thrown away', () => {
    expect(cleanArgs('list_sessions', { projectId: 'p1', workingDir: 'C:\\x', binary: 'evil.exe' }))
      .toEqual({ projectId: 'p1' })
    expect(cleanArgs('search_sessions', { projectId: 'p1', query: 'auth', extra: 1 }))
      .toEqual({ projectId: 'p1', query: 'auth' })
  })

  it('commands without arguments ignore everything that arrives', () => {
    expect(cleanArgs('list_projects', { binary: 'evil.exe' })).toEqual({})
    expect(cleanArgs('get_settings', null)).toEqual({})
    expect(cleanArgs('list_projects', undefined)).toEqual({})
  })

  it.each<[ReadCommand, unknown]>([
    ['load_session', {}],
    ['load_session', { sessionId: 12 }],
    ['load_session', { sessionId: '' }],
    ['load_session', { sessionId: 'x'.repeat(513) }],
    ['load_session', null],
    ['load_session', ['s1']],
    ['search_sessions', { projectId: 'p1' }],
    ['get_project', { id: null }],
  ])('%s con %j → argomenti non validi', (cmd, args) => {
    expect(cleanArgs(cmd, args)).toBeNull()
  })
})

describe('forwarded events', () => {
  it('there are 22 and they do not include debug or the desktop-only functions', () => {
    expect(FORWARDED_EVENTS).toHaveLength(22)
    for (const banned of ['session:debug', 'pragma:e2e', 'pragma:live-output', 'pragma:pipeline-output']) {
      expect(FORWARDED_EVENTS).not.toContain(banned)
    }
  })

  it('include the four scheduler ones', () => {
    for (const ev of ['scheduler:fired', 'scheduler:queued', 'scheduler:missed', 'scheduler:failed']) {
      expect(FORWARDED_EVENTS).toContain(ev)
    }
  })
})

describe('redacted settings', () => {
  const full = {
    profiles: [{ label: 'Work', binary: 'C:\\Users\\me\\.local\\bin\\claude.exe', configDir: 'C:\\Users\\me\\.claude', language: 'Italiano' }],
    dbPath: 'C:\\Users\\me\\.pragma\\pragma.db',
    notificationsEnabled: true,
    soundEnabled: false,
    defaultProfileIndex: 0,
    exportDir: 'C:\\Users\\me\\Downloads',
    diffAlwaysOpen: true,
    lastWorkingDir: 'C:\\Work\\Secret',
    models: { opus: 'o', fable: 'f', sonnet: 's' },
    sessionBranchEnabled: false,
    e2eEnabled: true,
    remote: { enabled: true, hubUrl: 'https://noema.tools/hubs/pragma-live', hostSecret: 'HOST-SECRET-VALUE' },
    aCampoAggiuntoDomani: 'TOP-SECRET-FUTURO',
  }

  it('lets out no paths, key or unknown fields', () => {
    const json = JSON.stringify(redactSettings(full))
    for (const leaked of ['claude.exe', '.claude', 'pragma.db', 'Downloads', 'C:\\Work', 'HOST-SECRET', 'noema.tools', 'TOP-SECRET']) {
      expect(json).not.toContain(leaked)
    }
  })

  it('keeps the interface preferences and the profile labels', () => {
    const out = redactSettings(full) as any
    expect(out.notificationsEnabled).toBe(true)
    expect(out.soundEnabled).toBe(false)
    expect(out.diffAlwaysOpen).toBe(true)
    expect(out.defaultProfileIndex).toBe(0)
    expect(out.models).toEqual({ opus: 'o', fable: 'f', sonnet: 's' })
    expect(out.profiles).toEqual([{ label: 'Work', binary: '', configDir: null, language: 'Italiano' }])
  })

  it('copes with empty or malformed input', () => {
    expect((redactSettings(null) as any).profiles).toEqual([])
    expect((redactSettings({ profiles: [null] }) as any).profiles).toEqual([
      { label: '', binary: '', configDir: null, language: null },
    ])
  })
})
