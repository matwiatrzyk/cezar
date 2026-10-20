import { BotIcon } from 'lucide-react'
import { useState } from 'react'
import type { ReactNode } from 'react'

import {
  useAgentProfiles,
  useAgentFallbackPolicy,
  useSaveAgentFallbackPolicy,
  useConfig,
  useProjects,
  useProviderStatus,
  useRepo,
  useRunnerModelCatalogs,
  useSelectAgentProfile,
} from '@/api/queries'
import { useProjectScope } from '@/api/project-scope-context'
import type { AgentFallbackCandidate, ConfigResponse, Runner } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { toast } from '@/components/ui/toaster'
import { providerStatusFor } from '@/lib/provider-status'
import {
  DefaultAgentPicker,
  agentPickerRows,
  hasAgentAccounts,
} from '@/components/default-agent-picker'
import { modelCatalogStatus, modelsForRunner, RUNNERS } from '@/routes/new-task-form'
import { ProviderSettings } from './provider-settings'
import { useConfigSave } from './use-config-save'

/**
 * Settings → Agents (R6 Step 1.5, spec §"Settings"): which agent runs THIS repo's tasks —
 * providers, the default runner (and account), and per-runner model presets. What the user
 * writes FOR a model lives in Settings → Instructions, and how a task behaves (base branch,
 * review gate, live titles) in Settings → Tasks; a textarea beside the runner picker kept
 * reading as "configure the agent".
 *
 * Copy stays coding-agent-agnostic by rule: the section describes capabilities (`runner`,
 * `model`), never vendor config formats.
 *
 * Persistence: every control PUTs a partial patch through `useConfigSave`; the server merges it
 * into the raw config.json so user keys survive.
 */

export function AgentsSection() {
  const config = useConfig()
  // One row per runner here, so every runner's own host catalog is needed at once (#794) —
  // unlike the composer, which only ever renders the runner the user picked.
  const catalogs = useRunnerModelCatalogs()
  const providerStatus = useProviderStatus()

  if (config.isPending) {
    return (
      <p data-slot="agents-loading" className="p-4 text-[13px] text-soft-foreground md:p-6">
        Loading agent settings…
      </p>
    )
  }
  if (config.isError) {
    return (
      <CenteredState
        icon={<BotIcon />}
        tone="danger"
        title="Agent settings did not load"
        subtitle={config.error.message}
        heading="h2"
      />
    )
  }
  return <AgentsForm config={config.data} catalogs={catalogs} providerStatus={providerStatus} />
}

function AgentsForm({
  config,
  catalogs,
  providerStatus,
}: {
  config: ConfigResponse
  catalogs: ReturnType<typeof useRunnerModelCatalogs>
  providerStatus: ReturnType<typeof useProviderStatus>
}) {
  const save = useConfigSave()
  const scope = useProjectScope()
  const fallbackProjectId = scope.projectId ?? 'default'
  const fallback = useAgentFallbackPolicy(fallbackProjectId)
  const saveFallback = useSaveAgentFallbackPolicy(fallbackProjectId)
  const profiles = useAgentProfiles()

  return (
    <div
      data-slot="agents-section"
      className="mx-auto flex w-full max-w-2xl flex-col gap-7 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
    >
      <ProviderSettings />

      <DefaultAgentField
        defaultRunner={config.defaultRunner}
        providerStatus={providerStatus}
        saving={save.isPending}
        onPick={(runner) => save.mutate({ defaultRunner: runner })}
      />

      <FallbackField policy={fallback.data} profiles={profiles.data?.profiles ?? []} loading={fallback.isPending} saving={saveFallback.isPending} onSave={(enabled, candidates) => {
        const current = fallback.data ?? { revision: 0, incarnation: null, candidates: [], enabled: false }
        saveFallback.mutate(
          { expectedRevision: current.revision, expectedIncarnation: current.incarnation, enabled, candidates: candidates ?? current.candidates },
          { onError: (error) => toast.error(error instanceof Error ? error.message : 'Could not save fallback policy') },
        )
      }} />

      <Field
        title="Default models"
        hint={
          config.modelsLocked
            ? 'Models are locked to the defaults configured in the native coding-agent settings.'
            : 'The model preselected in the composer for each runner. Auto lets the runner decide per task.'
        }
      >
        <div className="flex max-w-md flex-col gap-2">
          {RUNNERS.map((runner) => {
            const provider = providerStatusFor(providerStatus.data, runner.id)
            const providerConnected =
              !providerStatus.isPending &&
              !providerStatus.isError &&
              provider?.enabled === true &&
              provider.status === 'connected'
            const providerReason = providerStatus.isPending
              ? 'Checking provider authentication…'
              : providerStatus.isError
                ? 'Provider authentication could not be verified.'
                : provider?.enabled === false
                  ? 'This provider is disabled. Enable it above or choose another provider.'
                : providerConnected
                  ? undefined
                  : 'Connect this provider before selecting it.'
            const catalog = catalogs[runner.id]
            const catalogStatus = modelCatalogStatus(runner.id, catalog.data, catalog.isError)
            const modelOptions = modelsForRunner(runner.id, catalog.data, [
              config.defaultModels[runner.id],
            ])
            const configuredModel = config.defaultModels[runner.id] ?? ''
            const configuredModelLabel =
              modelOptions.find((model) => model.id === configuredModel)?.label ??
              configuredModel ??
              'auto (default)'
            return (
              <label key={runner.id} className="flex items-center gap-3">
                <span className="w-24 shrink-0 font-mono text-xs text-muted-foreground">{runner.label}</span>
                {config.modelsLocked ? (
                  <output
                    aria-label={`Default model for ${runner.label}`}
                    data-slot="agents-model"
                    data-runner={runner.id}
                    title="Model selection is locked to native coding-agent settings."
                    className="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs"
                  >
                    {configuredModelLabel}
                  </output>
                ) : (
                  <select
                    aria-label={`Default model for ${runner.label}`}
                    data-slot="agents-model"
                    data-runner={runner.id}
                    value={configuredModel}
                    title={providerReason ?? runner.desc}
                    disabled={save.isPending || !providerConnected}
                    onChange={(event) =>
                      // Picking auto is a CHOICE, not the absence of one (#906): clearing the
                      // preset alone let the coding agent's own settings file show through again,
                      // so the select snapped straight back to the model it names. The additive
                      // override says "ignore that default"; picking a real model clears it.
                      save.mutate({
                        defaultModels: { [runner.id]: event.target.value || null } as Partial<
                          Record<Runner, string | null>
                        >,
                        defaultModelsAuto: { [runner.id]: event.target.value === '' } as Partial<
                          Record<Runner, boolean>
                        >,
                      })
                    }
                    className="block w-full rounded-md border border-input bg-card px-3 py-1.5 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
                  >
                    {modelOptions.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.id === '' ? 'auto (default)' : model.label}
                      </option>
                    ))}
                    {catalogStatus ? <option disabled>{catalogStatus}</option> : null}
                  </select>
                )}
              </label>
            )
          })}
        </div>
      </Field>
    </div>
  )
}

function FallbackField({ policy, profiles, loading, saving, onSave }: { policy?: import('@open-mercato/cezar-api-client').AgentFallbackPolicy; profiles: Array<{ id: string; provider: string; label: string; isDefault?: boolean }>; loading: boolean; saving: boolean; onSave: (enabled: boolean, candidates?: AgentFallbackCandidate[]) => void }) {
  const [selected, setSelected] = useState('codex:default')
  const disabled = loading || saving || !policy
  const options = profiles.length > 0
    ? profiles.map((profile) => ({
        key: `${profile.provider}:${profile.id}`,
        provider: profile.provider as AgentFallbackCandidate['provider'],
        profileId: profile.id,
        label: `${RUNNERS.find((runner) => runner.id === profile.provider)?.label ?? profile.provider} · ${profile.label || profile.id}`,
      }))
    : RUNNERS.map((runner) => ({ key: `${runner.id}:default`, provider: runner.id as AgentFallbackCandidate['provider'], profileId: 'default', label: `${runner.label} · Default` }))
  const add = () => {
    const option = options.find((item) => item.key === selected)
    if (!policy || !option || policy.candidates.some((candidate) => `${candidate.provider}:${candidate.profileId}` === option.key)) return
    onSave(policy.enabled, [...policy.candidates, { provider: option.provider, profileId: option.profileId }])
  }
  const remove = (provider: string, profileId: string) => {
    if (!policy) return
    const candidates = policy.candidates.filter((candidate) => candidate.provider !== provider || candidate.profileId !== profileId)
    onSave(policy.enabled && candidates.length > 0, candidates)
  }
  const move = (index: number, delta: -1 | 1) => {
    if (!policy) return
    const next = [...policy.candidates]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onSave(policy.enabled, next)
  }
  return <Field title="Automatic fallback" hint="Continue a task with the next configured agent after a verified usage limit. Add agents to the fallback order before enabling it.">
    <div className="flex max-w-md items-center gap-2">
      <select aria-label="Fallback agent" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={disabled} className="rounded-md border border-input bg-card px-2 py-1 text-sm">
        {options.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
      <button type="button" className="rounded-md border px-2 py-1 text-sm" disabled={disabled} onClick={add}>Add</button>
    </div>
    <ol className="mt-2 max-w-md space-y-1 text-sm">
      {policy?.candidates.map((candidate, index) => <li key={`${candidate.provider}-${candidate.profileId}`} className="flex items-center justify-between rounded border px-2 py-1"><span>{index + 1}. {options.find((option) => option.key === `${candidate.provider}:${candidate.profileId}`)?.label ?? `${candidate.provider} · ${candidate.profileId}`}</span><span className="flex gap-1"><button type="button" aria-label={`Move ${candidate.provider} ${candidate.profileId} fallback up`} onClick={() => move(index, -1)} disabled={disabled || index === 0}>↑</button><button type="button" aria-label={`Move ${candidate.provider} ${candidate.profileId} fallback down`} onClick={() => move(index, 1)} disabled={disabled || index === policy.candidates.length - 1}>↓</button><button type="button" className="text-muted-foreground" onClick={() => remove(candidate.provider, candidate.profileId)} disabled={disabled}>Remove</button></span></li>)}
    </ol>
    <label className="flex max-w-md items-center gap-3">
      <input type="checkbox" checked={policy?.enabled ?? false} disabled={disabled || policy.candidates.length === 0} onChange={(e) => onSave(e.target.checked)} />
      <span>{policy?.enabled ? 'Enabled' : 'Disabled'}</span>
    </label>
    {policy && policy.candidates.length === 0 ? <p className="mt-2 text-sm text-muted-foreground">No fallback agents configured yet.</p> : null}
  </Field>
}

/**
 * The repo's default AGENT — and, when that agent has more than one login, which account (spec
 * 2026-07-29-agent-profiles).
 *
 * One flat list, the same shape the composer's runner pill uses:
 *
 *     claude · Default
 *     claude · Klaudiusz
 *     codex
 *
 * Not a runner control with an account control beside it. Both answers are the same decision —
 * "what does this repo run by default" — and splitting them meant reading two fields to learn one
 * fact. An agent with a single login stays a single row, so a machine with no extra accounts sees
 * exactly the control it always saw.
 *
 * The two halves land in DIFFERENT stores, and that is deliberate rather than incidental: the runner
 * is a team decision and goes in the repo's committable config, while the account is personal and
 * per-machine (`~/.cezar/agent-accounts.json`) — committing it would publish which login someone
 * works under. Hence two writes for one click, and the copy says so.
 */
function DefaultAgentField({
  defaultRunner,
  providerStatus,
  saving,
  onPick,
}: {
  defaultRunner: Runner
  providerStatus: ReturnType<typeof useProviderStatus>
  saving: boolean
  onPick: (runner: Runner) => void
}) {
  const profiles = useAgentProfiles()
  const projects = useProjects()
  const scope = useProjectScope()
  const repo = useRepo()
  const select = useSelectAgentProfile()

  // `projectId: null` is the boot project, which every route addresses by the reserved `default`
  // alias. The repo ROOT is the key the account store uses, and `useRepo` is project-scoped so it
  // already answers for the ACTIVE project.
  const projectId = scope.projectId ?? 'default'
  const repoRoot = repo.data?.info?.root
  // Repo first, then the machine-wide default — the same order the server resolves in, so the
  // checked row is the account a task would really run under rather than a guess.
  const selection = repoRoot ? profiles.data?.selections[repoRoot] : undefined
  const machine = profiles.data?.defaults
  const rows = agentPickerRows(profiles.data?.profiles ?? [])
  const hasAccounts = hasAgentAccounts(rows)

  return (
    <Field
      title={hasAccounts ? 'Default agent' : 'Default runner'}
      hint={
        hasAccounts
          ? 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another agent or account. The account is stored on this machine only — it is never committed, so a teammate keeps their own.'
          : 'Preselected for new tasks in THIS repo, and used by the chain planner. Each task can still pick another runner.'
      }
    >
      <DefaultAgentPicker
        rows={rows}
        runner={defaultRunner}
        accountFor={(id) => selection?.[id] ?? machine?.[id] ?? null}
        providerStatus={providerStatus}
        disabled={saving}
        // The account half needs a project to write against; the runner half does not, so only an
        // account row waits on the registry.
        accountDisabled={select.isPending || projects.data === undefined}
        onPick={(runner, account, hasAccountChoice) => {
          if (runner !== defaultRunner) onPick(runner)
          // Only when this agent HAS a choice of accounts: a single-login agent must not write a
          // selection, or the store would fill up with rows that say nothing.
          if (hasAccountChoice) {
            select.mutate(
              { projectId, provider: runner, profileId: account },
              { onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
            )
          }
        }}
      />
      {!providerStatus.isPending &&
      !providerStatus.isError &&
      providerStatusFor(providerStatus.data, defaultRunner)?.enabled === false ? (
        <p className="text-[13px] text-muted-foreground">
          This provider is disabled. Enable it above or choose another provider.
        </p>
      ) : null}
      {hasAccounts ? (
        <p className="max-w-md text-[13px] text-muted-foreground">
          Tasks already started under another account can’t be resumed here — their sessions live in
          that account’s folder.
        </p>
      ) : null}
    </Field>
  )
}

/** The Appearance section's field chassis — same rhythm, so Settings reads as one surface. */
function Field({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className="text-[13px] text-muted-foreground">{hint}</p>
      </div>
      {children}
    </section>
  )
}
