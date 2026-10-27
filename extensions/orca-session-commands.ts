// @orca-managed-pi-extension
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type ExtensionContext = {
  cwd: string
  sessionManager: {
    getSessionFile(): string | undefined
    getSessionDir(): string
    getSessionId(): string
    getLeafId(): string | null
    getBranch(): Array<JsonRecord>
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
    setStatus(key: string, text: string | undefined): void
  }
  waitForIdle(): Promise<void>
}

type ForkSource = {
  path: string
  isExactBranchClone: boolean
}

type OrcaProject = {
  id: string
  displayName: string
  path: string
}

type JsonRecord = Record<string, unknown>

const STATUS_KEY = "orca-session-commands"
let operationInFlight = false

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null ? (value as JsonRecord) : undefined
}

function parseJson(output: string): unknown {
  const trimmed = output.trim()
  if (!trimmed) return undefined

  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean)
    const lastLine = lines.at(-1)
    if (!lastLine) return undefined
    try {
      return JSON.parse(lastLine)
    } catch {
      return undefined
    }
  }
}

function getOrcaError(output: string): string | undefined {
  const payload = asRecord(parseJson(output))
  if (!payload) return undefined

  const result = asRecord(payload.result)
  const errorValue = payload.error ?? result?.error
  if (typeof errorValue === "string") return errorValue

  const error = asRecord(errorValue)
  const message = error?.message ?? (payload.ok === false ? payload.message : undefined)
  return typeof message === "string" ? message : undefined
}

async function runOrca(pi: { exec: Function }, cwd: string, args: string[]): Promise<unknown> {
  const command = process.env.ORCA_CLI_COMMAND || "orca"
  const result = await pi.exec(command, args, { cwd })

  if (result.code !== 0 || result.killed) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit code ${result.code}`
    throw new Error(`orca command failed: ${detail}`)
  }

  const output = result.stdout?.trim() || ""
  const orcaError = getOrcaError(output)
  if (orcaError) throw new Error(`orca command failed: ${orcaError}`)
  return parseJson(output)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function buildPiCommand(source: ForkSource, sessionName: string): string {
  const piCommand = process.env.PI_CLI_COMMAND || "pi"
  const mode = source.isExactBranchClone ? "--session" : "--fork"
  return [piCommand, mode, source.path, "--name", sessionName].map(shellQuote).join(" ")
}

function getProjects(payload: unknown): OrcaProject[] {
  const root = asRecord(payload)
  const result = asRecord(root?.result) ?? root
  const projects = result?.repos
  if (!Array.isArray(projects)) {
    throw new Error("orca did not return the project list")
  }

  return projects.flatMap((value) => {
    const project = asRecord(value)
    if (
      !project ||
      typeof project.id !== "string" ||
      typeof project.displayName !== "string" ||
      typeof project.path !== "string"
    ) {
      return []
    }
    return [{ id: project.id, displayName: project.displayName, path: project.path }]
  })
}

function resolveProject(projects: OrcaProject[], query: string): OrcaProject {
  const pathMatch = projects.find((project) => project.path === query)
  if (pathMatch) return pathMatch

  const nameMatches = projects.filter((project) => project.displayName === query)
  if (nameMatches.length === 1) return nameMatches[0]

  if (nameMatches.length > 1) {
    throw new Error(`project name "${query}" is ambiguous; use its full path`)
  }

  const availableProjects = projects.map((project) => `${project.displayName} (${project.path})`).join(", ")
  throw new Error(
    availableProjects
      ? `project "${query}" was not found. available projects: ${availableProjects}`
      : `project "${query}" was not found; no Orca projects are available`,
  )
}

function getWorktree(payload: unknown): JsonRecord {
  const root = asRecord(payload)
  const result = asRecord(root?.result) ?? root
  const worktree = asRecord(result?.worktree)
  if (!worktree || typeof worktree.id !== "string") {
    throw new Error("orca did not return the created worktree id")
  }
  return worktree
}

function getPersistedLeafId(sessionFile: string): string | null {
  const content = readFileSync(sessionFile, "utf8").trim()
  if (!content) return null

  const lines = content.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const entry = asRecord(JSON.parse(lines[index]))
    if (entry?.type !== "session" && typeof entry?.id === "string") return entry.id
  }
  return null
}

function createExactBranchClone(ctx: ExtensionContext, sessionFile: string, leafId: string): string {
  const branch = ctx.sessionManager.getBranch()
  if (branch.length === 0 || branch.at(-1)?.id !== leafId) {
    throw new Error("could not resolve the current session branch")
  }

  const id = randomUUID()
  const timestamp = new Date().toISOString()
  const path = join(ctx.sessionManager.getSessionDir(), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`)
  const header = {
    type: "session",
    version: 3,
    id,
    timestamp,
    cwd: ctx.cwd,
    parentSession: sessionFile,
  }
  const entries = branch.map((entry, index) => ({
    ...entry,
    parentId: index === 0 ? null : branch[index - 1].id,
  }))

  mkdirSync(ctx.sessionManager.getSessionDir(), { recursive: true })
  writeFileSync(path, [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" })
  return path
}

async function getForkSource(ctx: ExtensionContext): Promise<ForkSource> {
  await ctx.waitForIdle()

  const sessionFile = ctx.sessionManager.getSessionFile()
  const leafId = ctx.sessionManager.getLeafId()
  if (!sessionFile || !existsSync(sessionFile) || !leafId) {
    throw new Error("the current Pi session has not been saved yet")
  }

  if (getPersistedLeafId(sessionFile) === leafId) {
    return { path: sessionFile, isExactBranchClone: false }
  }

  return {
    path: createExactBranchClone(ctx, sessionFile, leafId),
    isExactBranchClone: true,
  }
}

async function createTerminal(
  pi: { exec: Function },
  cwd: string,
  worktree: string,
  title: string,
  source: ForkSource,
  sessionName: string,
): Promise<void> {
  await runOrca(pi, cwd, [
    "terminal",
    "create",
    "--worktree",
    worktree,
    "--title",
    title,
    "--command",
    buildPiCommand(source, sessionName),
    "--focus",
    "--json",
  ])
}

async function runCommand(
  ctx: ExtensionContext,
  description: string,
  action: () => Promise<void>,
): Promise<void> {
  if (operationInFlight) {
    ctx.ui.notify("another Orca session operation is already running", "warning")
    return
  }

  operationInFlight = true
  ctx.ui.setStatus(STATUS_KEY, description)
  try {
    await action()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(message, "error")
  } finally {
    operationInFlight = false
    ctx.ui.setStatus(STATUS_KEY, undefined)
  }
}

export default function (pi: { exec: Function; registerCommand: Function }) {
  pi.registerCommand("spawn", {
    description: "Clone this session into a new Orca tab",
    handler: async (_args: string, ctx: ExtensionContext) => {
      await runCommand(ctx, "spawning Pi session", async () => {
        const source = await getForkSource(ctx)
        const sessionName = `spawn-${ctx.sessionManager.getSessionId().slice(0, 8)}`
        await createTerminal(pi, ctx.cwd, "active", "pi: spawn", source, sessionName)
        ctx.ui.notify("spawned a cloned Pi session in a new Orca tab", "info")
      })
    },
  })

  pi.registerCommand("breach", {
    description: "Clone this session into an Orca project",
    handler: async (args: string, ctx: ExtensionContext) => {
      await runCommand(ctx, "handing off Pi session", async () => {
        const projectQuery = args.trim()
        if (!projectQuery) {
          throw new Error("usage: /breach <project-name-or-path>")
        }

        const payload = await runOrca(pi, ctx.cwd, ["repo", "list", "--json"])
        const project = resolveProject(getProjects(payload), projectQuery)
        const source = await getForkSource(ctx)
        const sessionName = `breach-${ctx.sessionManager.getSessionId().slice(0, 8)}`
        const worktree = `id:${project.id}::${project.path}`

        await createTerminal(
          pi,
          ctx.cwd,
          worktree,
          `pi: breach ${project.displayName}`,
          { ...source, isExactBranchClone: false },
          sessionName,
        )
        ctx.ui.notify(`handed off Pi session to ${project.displayName}`, "info")
      })
    },
  })

  pi.registerCommand("migrate", {
    description: "Clone this session into a new default-based Orca worktree (optional name)",
    handler: async (args: string, ctx: ExtensionContext) => {
      await runCommand(ctx, "creating migrated worktree", async () => {
        const source = await getForkSource(ctx)
        const requestedName = args.trim()
        const worktreeName = requestedName || `migrate-${ctx.sessionManager.getSessionId().slice(0, 8)}`
        const payload = await runOrca(pi, ctx.cwd, [
          "worktree",
          "create",
          "--name",
          worktreeName,
          "--parent-worktree",
          "active",
          "--json",
        ])
        const worktree = getWorktree(payload)

        try {
          await createTerminal(
            pi,
            ctx.cwd,
            `id:${String(worktree.id)}`,
            `pi: ${worktreeName}`,
            { ...source, isExactBranchClone: false },
            worktreeName,
          )
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          throw new Error(`created worktree ${String(worktree.id)}, but could not open Pi: ${message}`)
        }

        ctx.ui.notify(`migrated Pi session to ${worktreeName}`, "info")
      })
    },
  })
}
