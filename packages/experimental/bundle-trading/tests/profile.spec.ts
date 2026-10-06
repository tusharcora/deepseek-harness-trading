/** The trading profile layer and the trader preset: parseable, explicit, and closed to every non-trading tool. */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const shippedPresets = fileURLToPath(new URL('../../../bundle/web-app/presets', import.meta.url))

interface Row {
  readonly id?: string
  readonly name?: string
  readonly disabled?: boolean
  /** A plugin's options, or the child rows of a `cordis:group`. */
  readonly config?: Record<string, unknown> | readonly Row[]
  readonly insert?: readonly Row[]
}

function rows(path: string): Row[] {
  const parsed = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${path} is not a list`)
  return parsed as Row[]
}

describe('trading profile bundle', () => {
  it('is a public bundle carrying its patch and the packages its rows name', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      private?: boolean
      publishConfig?: { access?: string }
      files?: string[]
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.private).toBeUndefined()
    expect(manifest.publishConfig?.access).toBe('public')
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toEqual(['lib/index.js', 'cordis.patch.yml', 'lib/types/**/*.d.ts'])
    expect(manifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-agent-preset': 'workspace:*',
      '@deepseek-ai/dsh-experimental-tool-trading': 'workspace:*',
      '@deepseek-ai/dsh-experimental-trading-alpaca': 'workspace:*',
    })
  })

  it('closes every non-trading path, keeps the Terminal tab, and selects only the trader preset', () => {
    const patch = rows(join(root, 'cordis.patch.yml'))
    for (const id of ['mcp-resources', 'cordis-host-runner', 'cordis-client-runner', 'cordis-inspect-providers', 'ui-cordis']) {
      expect(patch.find(row => row.id === id), id).toEqual({ id, disabled: true })
    }
    expect(patch.some(row => row.id === 'terminal-controller' || row.id === 'ui-sidebar-terminal')).toBe(false)
    for (const id of ['preset-standard', 'preset-ptc', 'preset-minimal', 'preset-cordis']) {
      expect(patch.find(row => row.id === id), id).toEqual({ id, disabled: true })
    }
    expect(patch.find(row => row.id === 'agent-preset-registry')).toEqual({ id: 'agent-preset-registry', config: { default: 'trader' } })
    const inserted = patch.flatMap(row => row.insert ?? [])
    expect(inserted.map(row => [row.id, row.name])).toEqual([
      ['preset-trader', '@deepseek-ai/dsh-agent-preset'],
      ['trading-alpaca', '@deepseek-ai/dsh-experimental-trading-alpaca'],
      ['trading-executor', '@deepseek-ai/dsh-experimental-tool-trading'],
    ])
    expect(inserted[1]?.config).toEqual({ mode: 'paper' })
    expect(inserted[2]?.config).toEqual({
      maxOrderNotional: 1000, maxPositionPct: 0.2, dailyLossPct: 0.03, maxOrdersPerDay: 20, allowShort: false, allowMargin: false,
      allowlist: [], denylist: [], staleQuoteMs: 30000, driftTolerance: 0.01, barsDefault: 100, barsCap: 500,
    })
  })

  it('composes the trader agent from its persona, the trading tools and command, compaction, and web search and fetch', () => {
    const declaration = rows(join(root, 'cordis.patch.yml')).flatMap(row => row.insert ?? []).find(row => row.id === 'preset-trader')
    const { plugins, ...metadata } = declaration?.config as { plugins: Row[] }
    expect(metadata).toEqual({
      id: 'trader', name: 'Trader', description: 'Analyzes US stocks and crypto and proposes orders that you approve one at a time.', order: 1,
    })
    const preset = plugins
    expect(preset.map(row => [row.id, row.name])).toEqual([
      ['persona', '@deepseek-ai/dsh-persona'],
      ['tool-trading', '@deepseek-ai/dsh-experimental-tool-trading/tools'],
      ['command-trading', '@deepseek-ai/dsh-experimental-tool-trading/command'],
      ['compaction', 'cordis:group'],
      ['tool-web', '@deepseek-ai/dsh-tool-web'],
    ])
    expect(preset[0]?.config).toEqual({ prefix: expect.stringMatching(/^You are a trading assistant/) as string })
    expect(preset[4]?.config).toEqual({ fetch: true, searchTimeoutMs: 60000 })
    // The compaction rows are the shipped standard preset's group verbatim; they add the /compact command, no tools.
    const compaction = preset[3]?.config as readonly Row[]
    expect(compaction.map(row => [row.id, row.name])).toEqual([
      ['compaction-basic', '@deepseek-ai/dsh-compaction-basic'],
      ['command-compact', '@deepseek-ai/dsh-command-compact'],
      ['tool-result-pruner', '@deepseek-ai/dsh-compaction-tool-result-pruner'],
    ])
    expect(compaction[2]?.config).toEqual({ thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  })

  it('disables every shipped preset declaration, none of which carries the trading tools', () => {
    const shipped = readdirSync(shippedPresets).flatMap(file => rows(join(shippedPresets, file)).flatMap(row => row.insert ?? []))
    const disabled = rows(join(root, 'cordis.patch.yml')).filter(row => row.disabled === true).map(row => row.id)
    expect(shipped.map(row => row.id).sort()).toEqual(disabled.filter(id => id?.startsWith('preset-')).sort())
    for (const preset of readdirSync(shippedPresets)) {
      expect(readFileSync(join(shippedPresets, preset), 'utf8'), preset).not.toContain('tool-trading')
    }
  })
})
