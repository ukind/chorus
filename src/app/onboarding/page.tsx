"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Sparkles,
  Plug,
  KeyRound,
  Sliders,
  FileCode2,
  PartyPopper,
  Plus,
  Trash2,
  Loader2,
  FolderOpen,
  GitBranch,
  Box,
  Folder,
  CheckCircle2,
  Monitor,
  Cloud,
  Server,
  Info,
  Shield,
  AlertTriangle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type StepId =
  | "welcome"
  | "deployment"
  | "project"
  | "connect"
  | "auth"
  | "templates"
  | "permissions"
  | "done";

interface Step {
  id: StepId;
  title: string;
  subtitle: string;
}

const STEPS: Step[] = [
  { id: "welcome", title: "Welcome", subtitle: "What you'll set up" },
  {
    id: "deployment",
    title: "Where",
    subtitle: "Where Chorus runs",
  },
  { id: "project", title: "Project", subtitle: "Name it, point at the code" },
  { id: "connect", title: "Connect CLIs", subtitle: "Plug in your fleet" },
  { id: "auth", title: "Sign in", subtitle: "Authenticate each CLI" },
  { id: "templates", title: "Pick templates", subtitle: "Starter packs" },
  { id: "permissions", title: "Permissions", subtitle: "Trust boundary" },
  { id: "done", title: "Ready", subtitle: "Start your first run" },
];

type SourceKind = "local" | "git" | "sandbox";
type DeploymentMode = "desktop" | "cloud" | "self-hosted";

interface CliKind {
  id: string;
  name: string;
  lineage: string;
  description: string;
  detected: boolean;
}

const CLI_OPTIONS: CliKind[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    lineage: "claude",
    description: "Anthropic's CLI · subscription or Bedrock",
    detected: true,
  },
  {
    id: "codex-cli",
    name: "Codex CLI",
    lineage: "codex",
    description: "OpenAI's CLI · ChatGPT plan or API key",
    detected: true,
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    lineage: "gemini",
    description: "Google · Gemini AI Pro plan or API key",
    detected: true,
  },
  {
    id: "opencode",
    name: "OpenCode",
    lineage: "opencode",
    description: "Multi-model gateway · Kimi / DeepSeek / GLM / Qwen",
    detected: false,
  },
];

interface CliAccount {
  id: string;
  cliId: string;
  label: string;
  status: "needs-auth" | "authed" | "auth-running";
}

const LINEAGE_DOT: Record<string, string> = {
  codex: "bg-orange-400",
  gemini: "bg-blue-400",
  opencode: "bg-emerald-400",
  claude: "bg-violet-400",
};

export default function OnboardingPage() {
  const [stepIdx, setStepIdx] = useState(0);

  // Deployment mode — drives every subsequent step's UX
  const [deploymentMode, setDeploymentMode] = useState<DeploymentMode | null>(
    null,
  );

  // Project state
  const [projectName, setProjectName] = useState("");
  const [sourceKind, setSourceKind] = useState<SourceKind>("local");
  const [localFolder, setLocalFolder] = useState("");
  const [gitUrl, setGitUrl] = useState("");
  const [cloneTo, setCloneTo] = useState("");
  const [gitBranch, setGitBranch] = useState("main");

  const [selectedCliIds, setSelectedCliIds] = useState<string[]>([
    "claude-code",
    "codex-cli",
    "gemini-cli",
  ]);
  const [accounts, setAccounts] = useState<CliAccount[]>([
    {
      id: "a-1",
      cliId: "claude-code",
      label: "victor@99x.agency",
      status: "needs-auth",
    },
    {
      id: "a-2",
      cliId: "codex-cli",
      label: "victor@99x.agency",
      status: "needs-auth",
    },
    {
      id: "a-3",
      cliId: "gemini-cli",
      label: "primary",
      status: "needs-auth",
    },
  ]);
  const [selectedTemplates, setSelectedTemplates] = useState<string[]>([
    "t-architect-review",
    "t-bug-diagnose",
    "t-migration-plan",
  ]);
  // Auto-derive the project's working dir for the permissions step
  const projectPath =
    sourceKind === "local"
      ? localFolder
      : sourceKind === "git"
        ? cloneTo
        : "~/.chorus/sandbox/" + (slug(projectName) || "untitled");

  const currentStep = STEPS[stepIdx];

  function toggleCli(id: string) {
    setSelectedCliIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function addAccount(cliId: string) {
    const next: CliAccount = {
      id: `a-${Date.now()}`,
      cliId,
      label: "secondary",
      status: "needs-auth",
    };
    setAccounts((prev) => [...prev, next]);
  }

  function removeAccount(accountId: string) {
    setAccounts((prev) => prev.filter((a) => a.id !== accountId));
  }

  function authenticate(accountId: string) {
    setAccounts((prev) =>
      prev.map((a) =>
        a.id === accountId ? { ...a, status: "auth-running" } : a,
      ),
    );
    setTimeout(() => {
      setAccounts((prev) =>
        prev.map((a) => (a.id === accountId ? { ...a, status: "authed" } : a)),
      );
    }, 1800);
  }

  function toggleTemplate(id: string) {
    setSelectedTemplates((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function next() {
    if (stepIdx < STEPS.length - 1) setStepIdx(stepIdx + 1);
  }

  function prev() {
    if (stepIdx > 0) setStepIdx(stepIdx - 1);
  }

  const canProceed =
    currentStep.id === "welcome"
      ? true
      : currentStep.id === "deployment"
        ? deploymentMode !== null
        : currentStep.id === "project"
          ? projectName.trim().length > 0 &&
            (sourceKind === "sandbox" ||
              (sourceKind === "local" && localFolder.trim().length > 1) ||
              (sourceKind === "git" &&
                gitUrl.trim().length > 0 &&
                cloneTo.trim().length > 1))
          : currentStep.id === "connect"
            ? selectedCliIds.length > 0
            : currentStep.id === "auth"
              ? accounts.every((a) => a.status === "authed")
              : true; // templates & permissions: skippable

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-card/30">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8 py-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-7 w-7 place-items-center rounded-md bg-primary/15 text-primary">
              <Sparkles className="h-4 w-4" />
            </span>
            <span className="text-sm font-semibold tracking-tight">Chorus</span>
            <Badge
              variant="outline"
              className="ml-1 border-border font-mono text-[10px]"
            >
              setup
            </Badge>
          </div>
          <Link
            href="/"
            className="text-xs text-muted-foreground transition hover:text-foreground"
          >
            Skip for now →
          </Link>
        </div>
      </header>

      <div className="border-b border-border bg-card/15 px-8 py-4">
        <div className="mx-auto flex max-w-5xl items-center gap-0 overflow-x-auto">
          {STEPS.map((s, i) => {
            const state =
              i < stepIdx ? "done" : i === stepIdx ? "active" : "pending";
            return (
              <div key={s.id} className="flex items-center">
                <div
                  className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
                    state === "active"
                      ? "border-primary/40 bg-primary/5"
                      : state === "done"
                        ? "border-emerald-500/30 bg-emerald-500/5"
                        : "border-border bg-card/30"
                  }`}
                >
                  <span
                    className={`grid h-5 w-5 place-items-center rounded-md text-[10px] font-mono ${
                      state === "done"
                        ? "bg-emerald-500/20 text-emerald-300"
                        : state === "active"
                          ? "bg-primary/20 text-primary"
                          : "bg-muted-foreground/10 text-muted-foreground"
                    }`}
                  >
                    {state === "done" ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      state === "pending"
                        ? "text-muted-foreground"
                        : "text-foreground"
                    }`}
                  >
                    {s.title}
                  </span>
                </div>
                {i < STEPS.length - 1 && (
                  <span
                    className={`mx-1.5 h-px w-6 ${
                      i < stepIdx ? "bg-emerald-500/40" : "bg-border"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10 md:px-8 md:py-12">
        <div className="mb-6">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">
            Step {stepIdx + 1} of {STEPS.length}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {currentStep.subtitle}
          </h1>
        </div>

        {currentStep.id === "welcome" && <WelcomeStep />}
        {currentStep.id === "deployment" && (
          <DeploymentStep
            mode={deploymentMode}
            onSelect={setDeploymentMode}
          />
        )}
        {currentStep.id === "project" && (
          <ProjectStep
            deploymentMode={deploymentMode}
            projectName={projectName}
            setProjectName={setProjectName}
            sourceKind={sourceKind}
            setSourceKind={setSourceKind}
            localFolder={localFolder}
            setLocalFolder={setLocalFolder}
            gitUrl={gitUrl}
            setGitUrl={setGitUrl}
            cloneTo={cloneTo}
            setCloneTo={setCloneTo}
            gitBranch={gitBranch}
            setGitBranch={setGitBranch}
          />
        )}
        {currentStep.id === "connect" && (
          <ConnectStep
            deploymentMode={deploymentMode}
            options={CLI_OPTIONS}
            selected={selectedCliIds}
            onToggle={toggleCli}
          />
        )}
        {currentStep.id === "auth" && (
          <AuthStep
            deploymentMode={deploymentMode}
            accounts={accounts}
            setAccounts={setAccounts}
            cliOptions={CLI_OPTIONS}
            onAuthenticate={authenticate}
            onAddAccount={addAccount}
            onRemoveAccount={removeAccount}
          />
        )}
        {currentStep.id === "templates" && (
          <TemplatesStep
            selected={selectedTemplates}
            onToggle={toggleTemplate}
          />
        )}
        {currentStep.id === "permissions" && (
          <PermissionsStep deploymentMode={deploymentMode} />
        )}
        {currentStep.id === "done" && (
          <DoneStep
            projectName={projectName}
            projectPath={projectPath}
            sourceKind={sourceKind}
          />
        )}

        <div className="mt-8 flex items-center justify-between border-t border-border pt-6">
          <button
            type="button"
            disabled={stepIdx === 0}
            onClick={prev}
            className="rounded-md border border-border bg-card px-4 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Back
          </button>
          {stepIdx < STEPS.length - 1 ? (
            <button
              type="button"
              disabled={!canProceed}
              onClick={next}
              className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Continue
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          ) : (
            <Link
              href="/"
              className="flex items-center gap-1.5 rounded-md bg-emerald-500/20 px-4 py-2 text-xs font-medium text-emerald-100 transition hover:bg-emerald-500/30"
            >
              Go to dashboard
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  const items = [
    {
      icon: Monitor,
      title: "Pick how Chorus runs",
      desc: "Desktop app, cloud-hosted, or self-hosted on your own server. Each has different trade-offs.",
    },
    {
      icon: FolderOpen,
      title: "Point at your codebase",
      desc: "A local folder or a git URL. Reviewers read it, the driver writes into it, the PR opens from it.",
    },
    {
      icon: Plug,
      title: "Connect your CLIs",
      desc: "Chorus orchestrates Claude / Codex / Gemini / OpenCode. Bring your own subscriptions.",
    },
    {
      icon: KeyRound,
      title: "Sign each one in",
      desc: "Multi-account supported — handy when one quota runs out or you split work across orgs.",
    },
    {
      icon: Sliders,
      title: "Set the trust boundary",
      desc: "What can drivers auto-approve? Reviewers? Per-tool, per-directory.",
    },
  ];
  return (
    <div className="space-y-3">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <Card key={item.title} className="flex items-start gap-3 bg-card p-4">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
              <Icon className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-medium text-foreground">
                {item.title}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {item.desc}
              </p>
            </div>
          </Card>
        );
      })}
      <p className="mt-4 text-xs text-muted-foreground">
        Takes ~2 minutes. You can edit any of this later from{" "}
        <span className="font-mono text-foreground">/settings</span> or via the
        MCP tools — your main Claude can reconfigure Chorus for you.
      </p>
    </div>
  );
}

function DeploymentStep({
  mode,
  onSelect,
}: {
  mode: DeploymentMode | null;
  onSelect: (m: DeploymentMode) => void;
}) {
  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">
        How will Chorus run? This decides where your code lives, where the
        daemon runs, and how each CLI authenticates. You can change later but
        it&apos;s a meaningful re-setup.
      </p>
      <div className="grid grid-cols-1 gap-3">
        <DeploymentCard
          kind="desktop"
          current={mode}
          onSelect={() => onSelect("desktop")}
          icon={<Monitor className="h-5 w-5" />}
          title="Desktop app"
          subtitle="Recommended for solo devs"
          features={[
            "Daemon runs on your machine — code never leaves your laptop",
            "Native folder picker & git CLI just work",
            "CLI auth opens your default browser",
            "macOS / Windows / Linux",
          ]}
          tradeoff="Won't follow you across machines unless you sync."
        />
        <DeploymentCard
          kind="cloud"
          current={mode}
          onSelect={() => onSelect("cloud")}
          icon={<Cloud className="h-5 w-5" />}
          title="Cloud-hosted"
          subtitle="Chorus runs the daemon for you"
          features={[
            "Access from any browser, any machine",
            "We provision an isolated workspace per project",
            "Bring your own API keys or use Chorus credits",
            "Privacy: keys + transcripts encrypted at rest",
          ]}
          tradeoff="Your code is cloned into our cloud workspace. Read the privacy doc."
        />
        <DeploymentCard
          kind="self-hosted"
          current={mode}
          onSelect={() => onSelect("self-hosted")}
          icon={<Server className="h-5 w-5" />}
          title="Self-hosted server"
          subtitle="Daemon on your own VM / Docker"
          features={[
            "Best for teams behind a corporate firewall",
            "All data stays on your infra",
            "Connect via web UI to the server URL",
            "Docker Compose or single binary",
          ]}
          tradeoff="No native folder picker — you'll paste paths. CLI auth uses device-code flow."
        />
      </div>
    </div>
  );
}

function DeploymentCard({
  kind,
  current,
  onSelect,
  icon,
  title,
  subtitle,
  features,
  tradeoff,
}: {
  kind: DeploymentMode;
  current: DeploymentMode | null;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  features: string[];
  tradeoff: string;
}) {
  const isSelected = kind === current;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex items-start gap-4 rounded-xl border p-4 text-left transition ${
        isSelected
          ? "border-primary/40 bg-primary/5 ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
          : "border-border bg-card/40 hover:border-foreground/30"
      }`}
    >
      <span
        className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-md ${
          isSelected
            ? "bg-primary/20 text-primary"
            : "bg-card text-muted-foreground"
        }`}
      >
        {icon}
      </span>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">
            {title}
          </span>
          <Badge
            variant="outline"
            className="border-border font-mono text-[10px]"
          >
            {subtitle}
          </Badge>
        </div>
        <ul className="mt-2 space-y-1 text-[11px] text-muted-foreground">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-1.5">
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400/70" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2.5 flex items-start gap-1.5 rounded-md border border-amber-500/20 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-200/90">
          <Info className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
          <span>
            <span className="font-medium text-amber-300">Trade-off:</span>{" "}
            {tradeoff}
          </span>
        </div>
      </div>
      {isSelected && (
        <Check className="mt-1 h-4 w-4 shrink-0 text-primary" />
      )}
    </button>
  );
}

function ConnectStep({
  deploymentMode,
  options,
  selected,
  onToggle,
}: {
  deploymentMode: DeploymentMode | null;
  options: CliKind[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  // Cloud + self-hosted can't $PATH-scan the user's machine. We have to ask.
  const intro =
    deploymentMode === "desktop"
      ? "We've scanned your $PATH for installed CLIs. Tap any to include — at least one is required."
      : deploymentMode === "self-hosted"
        ? "We've scanned the Chorus server's $PATH. Tap any to include — install missing ones via your usual deploy."
        : "Chorus cloud doesn't run CLIs locally — we proxy each provider's API. Pick which providers to enable; you'll add API keys / OAuth in the next step.";

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">{intro}</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {options.map((cli) => {
          const isSelected = selected.includes(cli.id);
          return (
            <button
              key={cli.id}
              type="button"
              onClick={() => onToggle(cli.id)}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition ${
                isSelected
                  ? "border-primary/40 bg-primary/5 ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
                  : "border-border bg-card/40 hover:border-foreground/30"
              }`}
            >
              <span
                className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${LINEAGE_DOT[cli.lineage]}`}
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-foreground">
                    {cli.name}
                  </span>
                  {cli.detected ? (
                    <Badge
                      variant="outline"
                      className="border-emerald-500/30 bg-emerald-500/10 font-mono text-[10px] text-emerald-300"
                    >
                      detected
                    </Badge>
                  ) : (
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 font-mono text-[10px] text-amber-300"
                    >
                      not installed
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {cli.description}
                </p>
              </div>
              {isSelected && (
                <Check className="h-4 w-4 shrink-0 text-primary" />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-4 rounded-md border border-dashed border-border bg-card/30 p-3 text-[11px] text-muted-foreground">
        Want one we don&apos;t auto-detect? You can add API keys later — pick
        what you have today.
      </div>
    </div>
  );
}

function AuthStep({
  deploymentMode,
  accounts,
  setAccounts,
  cliOptions,
  onAuthenticate,
  onAddAccount,
  onRemoveAccount,
}: {
  deploymentMode: DeploymentMode | null;
  accounts: CliAccount[];
  setAccounts: (fn: (a: CliAccount[]) => CliAccount[]) => void;
  cliOptions: CliKind[];
  onAuthenticate: (id: string) => void;
  onAddAccount: (cliId: string) => void;
  onRemoveAccount: (id: string) => void;
}) {
  const intro =
    deploymentMode === "desktop"
      ? "Sign each account in. We'll open your default browser. Tokens stay on this machine; Chorus never reads them."
      : deploymentMode === "self-hosted"
        ? "Server has no browser — we use device-code flow. Each Sign-in shows a code; visit the URL on any device with a browser, paste the code, done."
        : "We'll redirect through OAuth in this tab. Tokens are encrypted at rest in the cloud workspace; we never log raw values.";

  function renameAccount(id: string, label: string) {
    setAccounts((prev) =>
      prev.map((a) => (a.id === id ? { ...a, label } : a)),
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-muted-foreground">{intro}</p>
      <div className="space-y-4">
        {cliOptions
          .filter((cli) => accounts.some((a) => a.cliId === cli.id))
          .map((cli) => {
            const cliAccounts = accounts.filter((a) => a.cliId === cli.id);
            return (
              <Card key={cli.id} className="bg-card p-0">
                <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                  <span
                    className={`h-2 w-2 rounded-full ${LINEAGE_DOT[cli.lineage]}`}
                  />
                  <span className="text-sm font-medium text-foreground">
                    {cli.name}
                  </span>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {cliAccounts.length} account
                    {cliAccounts.length === 1 ? "" : "s"}
                  </span>
                  <button
                    type="button"
                    onClick={() => onAddAccount(cli.id)}
                    className="ml-auto flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
                  >
                    <Plus className="h-3 w-3" />
                    Add account
                  </button>
                </div>
                <div className="divide-y divide-border">
                  {cliAccounts.map((acc) => (
                    <div
                      key={acc.id}
                      className="flex items-center gap-3 px-4 py-2.5"
                    >
                      <input
                        type="text"
                        value={acc.label}
                        onChange={(e) =>
                          renameAccount(acc.id, e.target.value)
                        }
                        placeholder="work / personal / fallback…"
                        className="flex-1 max-w-[240px] rounded-md border border-transparent bg-transparent px-2 py-1 font-mono text-xs text-foreground transition hover:border-border focus:border-foreground/30 focus:bg-background focus:outline-none"
                      />
                      <span className="ml-auto flex items-center gap-2">
                        {acc.status === "authed" ? (
                          <Badge className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300">
                            <Check className="mr-1 h-3 w-3" />
                            Signed in
                          </Badge>
                        ) : acc.status === "auth-running" ? (
                          <Badge className="border-amber-500/30 bg-amber-500/10 text-[10px] text-amber-300">
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            {deploymentMode === "self-hosted"
                              ? "Code: ABCD-1234…"
                              : deploymentMode === "cloud"
                                ? "OAuth redirect…"
                                : "Browser open…"}
                          </Badge>
                        ) : (
                          <button
                            type="button"
                            onClick={() => onAuthenticate(acc.id)}
                            className="rounded-md bg-primary/20 px-3 py-1 text-[11px] font-medium text-primary transition hover:bg-primary/30"
                          >
                            {deploymentMode === "self-hosted"
                              ? "Get code"
                              : "Sign in"}
                          </button>
                        )}
                        {cliAccounts.length > 1 && (
                          <button
                            type="button"
                            onClick={() => onRemoveAccount(acc.id)}
                            className="text-muted-foreground/60 transition hover:text-rose-400"
                            aria-label="Remove account"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
      </div>
    </div>
  );
}

function TemplatesStep({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const templates = [
    {
      id: "t-architect-review",
      name: "Architect review",
      desc: "Independent architecture critique from 3 model families.",
      category: "review",
      pop: 95,
    },
    {
      id: "t-bug-diagnose",
      name: "Bug diagnose",
      desc: "Three independent root-cause analyses for a failing test.",
      category: "debug",
      pop: 82,
    },
    {
      id: "t-migration-plan",
      name: "Migration plan",
      desc: "Plan → Implement → Open PR → 3-LLM review of the diff.",
      category: "plan",
      pop: 71,
    },
    {
      id: "t-code-review",
      name: "Code review",
      desc: "PR-style review — paste diff, get severity-tagged findings.",
      category: "review",
      pop: 99,
    },
    {
      id: "t-decision-help",
      name: "Decision help",
      desc: "Reviewers argue both sides of a technical decision.",
      category: "decide",
      pop: 89,
    },
  ];

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Pick what you want pre-installed. Or skip — you can fork, edit, or
          add more from the marketplace anytime.
        </p>
        <button
          type="button"
          onClick={() => selected.forEach((id) => onToggle(id))}
          className="shrink-0 rounded-md border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          Clear all
        </button>
      </div>
      <div className="space-y-2">
        {templates.map((t) => {
          const isSelected = selected.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onToggle(t.id)}
              className={`flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition ${
                isSelected
                  ? "border-primary/40 bg-primary/5 ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
                  : "border-border bg-card/40 hover:border-foreground/30"
              }`}
            >
              <span
                className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border ${
                  isSelected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card"
                }`}
              >
                {isSelected && <Check className="h-3 w-3" />}
              </span>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {t.name}
                  </span>
                  <Badge
                    variant="outline"
                    className="border-border font-mono text-[10px] uppercase"
                  >
                    {t.category}
                  </Badge>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    pop {t.pop}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {t.desc}
                </p>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PermissionsStep({
  deploymentMode,
}: {
  deploymentMode: DeploymentMode | null;
}) {
  // We build a static read-only summary here — full editing lives in /settings.
  // Onboarding shows the smart defaults so users understand what they're agreeing to.
  type AutoApprove = "auto" | "ask" | "block";
  const POLICY_STYLES: Record<AutoApprove, string> = {
    auto: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    ask: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    block: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  };
  const TOOL_ROWS: {
    name: string;
    desc: string;
    driver: AutoApprove;
    reviewer: AutoApprove;
  }[] = [
    {
      name: "Read files",
      desc: "cat, less, head",
      driver: "auto",
      reviewer: "auto",
    },
    {
      name: "List & search",
      desc: "ls, grep, find",
      driver: "auto",
      reviewer: "auto",
    },
    {
      name: "Write files",
      desc: "Edit, Write inside allowed dirs",
      driver: "ask",
      reviewer: "block",
    },
    {
      name: "Run commands",
      desc: "Bash, npm, python",
      driver: "ask",
      reviewer: "ask",
    },
    {
      name: "Network access",
      desc: "curl, fetch, install",
      driver: "ask",
      reviewer: "ask",
    },
    {
      name: "Writes outside cwd",
      desc: "Anywhere outside the project path",
      driver: "block",
      reviewer: "block",
    },
  ];

  const networkNote =
    deploymentMode === "cloud"
      ? "On cloud, network goes via Chorus's egress proxy — no exfil to surprise destinations."
      : deploymentMode === "self-hosted"
        ? "On self-hosted, network is whatever your server's firewall allows."
        : "On desktop, network goes via your machine's default gateway.";

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        The trust boundary, split by role: <span className="text-amber-300">drivers</span> write code,{" "}
        <span className="text-blue-300">reviewers</span> don&apos;t. These are the safe
        defaults — full edit in <span className="font-mono">/settings</span>.
      </p>

      <Card className="bg-card p-4">
        {/* Header */}
        <div className="grid grid-cols-[1fr_110px_110px] gap-3 border-b border-border pb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          <span>Tool</span>
          <span className="flex items-center justify-end gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            Driver
          </span>
          <span className="flex items-center justify-end gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
            Reviewer
          </span>
        </div>
        <div className="mt-1 divide-y divide-border">
          {TOOL_ROWS.map((row) => (
            <div
              key={row.name}
              className="grid grid-cols-[1fr_110px_110px] items-center gap-3 py-2.5"
            >
              <div className="flex flex-col">
                <span className="text-sm text-foreground">{row.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {row.desc}
                </span>
              </div>
              <span
                className={`justify-self-end rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${POLICY_STYLES[row.driver]}`}
              >
                {row.driver}
              </span>
              <span
                className={`justify-self-end rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${POLICY_STYLES[row.reviewer]}`}
              >
                {row.reviewer}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
          <span>{networkNote}</span>
        </p>
      </Card>

      <Card className="bg-card p-4">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          <Shield className="h-3 w-3" />
          What &quot;ask&quot; looks like
        </p>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          When an agent hits an{" "}
          <span className="font-mono text-amber-300">ask</span> tool, a card
          shows up at the top of that chat. You click Approve / Deny — the
          agent never silently stalls in a tmux corner waiting for input.
        </p>
      </Card>
    </div>
  );
}

function DoneStep({
  projectName,
  projectPath,
  sourceKind,
}: {
  projectName: string;
  projectPath: string;
  sourceKind: SourceKind;
}) {
  const sourceLabel =
    sourceKind === "git"
      ? "cloned from git"
      : sourceKind === "local"
        ? "local folder"
        : "sandbox";
  return (
    <div className="space-y-4">
      <Card className="overflow-hidden border-emerald-500/40 bg-gradient-to-br from-emerald-500/10 via-card to-card p-5">
        <div className="flex items-start gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-emerald-500/20 text-emerald-300">
            <PartyPopper className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-emerald-200">
              Setup complete · ready to run
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Project{" "}
              <span className="font-mono text-foreground/90">
                {projectName || "(unnamed)"}
              </span>{" "}
              registered ({sourceLabel}{" "}
              <code className="font-mono text-foreground/80">
                {projectPath}
              </code>
              ). Fleet connected, templates installed, permissions set. MCP
              server is up on{" "}
              <code className="font-mono text-foreground/80">
                http://127.0.0.1:7710/mcp
              </code>
              .
            </p>
          </div>
        </div>
      </Card>

      <Card className="bg-card p-5">
        <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Where to next
        </h4>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Link
            href={`/new?project=${slug(projectName)}`}
            className="rounded-md border border-primary/40 bg-primary/10 px-3 py-2.5 text-center text-xs font-semibold text-primary transition hover:bg-primary/20"
          >
            Start first run →
          </Link>
          <Link
            href="/templates"
            className="rounded-md border border-border bg-card px-3 py-2.5 text-center text-xs text-muted-foreground transition hover:text-foreground"
          >
            Browse templates
          </Link>
          <Link
            href="/settings"
            className="rounded-md border border-border bg-card px-3 py-2.5 text-center text-xs text-muted-foreground transition hover:text-foreground"
          >
            Settings
          </Link>
        </div>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Or just tell your main Claude:{" "}
        <span className="italic text-foreground/80">
          &quot;Create a chat in {projectName || "my project"} using the
          migration-plan template.&quot;
        </span>{" "}
        — MCP handles the rest.
      </p>
    </div>
  );
}

// ─── Project step ─────────────────────────────────────────────────────

function ProjectStep({
  deploymentMode,
  projectName,
  setProjectName,
  sourceKind,
  setSourceKind,
  localFolder,
  setLocalFolder,
  gitUrl,
  setGitUrl,
  cloneTo,
  setCloneTo,
  gitBranch,
  setGitBranch,
}: {
  deploymentMode: DeploymentMode | null;
  projectName: string;
  setProjectName: (v: string) => void;
  sourceKind: SourceKind;
  setSourceKind: (k: SourceKind) => void;
  localFolder: string;
  setLocalFolder: (v: string) => void;
  gitUrl: string;
  setGitUrl: (v: string) => void;
  cloneTo: string;
  setCloneTo: (v: string) => void;
  gitBranch: string;
  setGitBranch: (v: string) => void;
}) {
  // Path-shaped strings (start with /, ~/, or ./) plausibly point at something real.
  const looksLikePath = (s: string) =>
    /^(\/|~\/|\.\/)[\w./_-]{2,}/.test(s.trim());
  const isValidGitUrl = (s: string) =>
    /^(https?:\/\/|git@)[\w./@:_-]+(\.git)?$/.test(s.trim());

  // Deployment-aware copy & UX.
  const browseSupported = deploymentMode === "desktop";
  const pathPlaceholder =
    deploymentMode === "self-hosted"
      ? "/srv/code/aurora    (path on the Chorus server)"
      : deploymentMode === "cloud"
        ? "/workspace/aurora    (path inside Chorus's cloud workspace)"
        : "~/dev/aurora";
  const pathHelpText =
    deploymentMode === "self-hosted"
      ? "Paste an absolute path on the Chorus server. Browse picker disabled — server has no UI."
      : deploymentMode === "cloud"
        ? "Cloud workspaces start at /workspace/. We'll clone or mount your code there."
        : "Native folder picker uses your OS. You can also paste a path.";

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Chorus runs against a real codebase. Name your first project and tell
        us where the code lives — reviewers read from here, the driver writes
        into here, the PR opens from here.
      </p>

      {/* Name */}
      <Card className="bg-card p-5">
        <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Project name
        </label>
        <input
          type="text"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder="Aurora dashboard"
          className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
          autoFocus
        />
        {projectName && (
          <p className="mt-2 font-mono text-[10px] text-muted-foreground">
            slug: {slug(projectName)}
          </p>
        )}
      </Card>

      {/* Source */}
      <div>
        <p className="mb-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Where&apos;s the code?
        </p>
        <div className="grid grid-cols-3 gap-2">
          <SourcePicker
            kind="local"
            current={sourceKind}
            onSelect={() => setSourceKind("local")}
            icon={<Folder className="h-4 w-4" />}
            title={deploymentMode === "cloud" ? "Mount path" : "Local folder"}
            subtitle={
              deploymentMode === "cloud"
                ? "Use a path inside the cloud workspace."
                : deploymentMode === "self-hosted"
                  ? "A directory on the Chorus server."
                  : "Use a directory that already exists on this machine."
            }
          />
          <SourcePicker
            kind="git"
            current={sourceKind}
            onSelect={() => setSourceKind("git")}
            icon={<GitBranch className="h-4 w-4" />}
            title="Clone from git"
            subtitle={
              deploymentMode === "cloud"
                ? "We clone into your cloud workspace."
                : deploymentMode === "self-hosted"
                  ? "Server clones using its git credentials."
                  : "Paste a repo URL — we clone it locally."
            }
          />
          <SourcePicker
            kind="sandbox"
            current={sourceKind}
            onSelect={() => setSourceKind("sandbox")}
            icon={<Box className="h-4 w-4" />}
            title="Sandbox"
            subtitle="Try Chorus with an empty scratch dir."
          />
        </div>
      </div>

      {/* Source-specific fields */}
      {sourceKind === "local" && (
        <Card className="bg-card p-5">
          <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Folder path
          </label>
          <div className="mt-2 flex gap-2">
            <input
              type="text"
              value={localFolder}
              onChange={(e) => setLocalFolder(e.target.value)}
              placeholder={pathPlaceholder}
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
            />
            {browseSupported ? (
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground transition hover:text-foreground"
                title="Opens your OS folder picker"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Browse
              </button>
            ) : (
              <span
                className="flex items-center gap-1.5 rounded-md border border-border bg-card/40 px-3 py-2 text-xs text-muted-foreground/60"
                title="Browse disabled — paste a path"
              >
                <FolderOpen className="h-3.5 w-3.5" />
                Browse n/a
              </span>
            )}
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
            <span>{pathHelpText}</span>
          </p>
          {looksLikePath(localFolder) ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200">
              <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
              <span>
                Path looks valid. We&apos;ll probe for a{" "}
                <code className="font-mono">.git</code> directory when you
                continue — if missing, we&apos;ll initialise one.
              </span>
            </div>
          ) : localFolder.trim().length > 0 ? (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
              <span>
                Doesn&apos;t look like an absolute path. Use{" "}
                <code className="font-mono">/abs/path</code> or{" "}
                <code className="font-mono">~/relative-to-home</code>.
              </span>
            </div>
          ) : null}
        </Card>
      )}

      {sourceKind === "git" && (
        <Card className="bg-card p-5 space-y-3">
          <div>
            <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Repository URL
            </label>
            <input
              type="text"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              placeholder="https://github.com/99xAgency/aurora"
              className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
            />
            {gitUrl.trim().length > 0 && !isValidGitUrl(gitUrl) && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-amber-300">
                <AlertTriangle className="h-3 w-3" />
                Use https://… or git@host:user/repo
              </p>
            )}
          </div>
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Clone to
              </label>
              <input
                type="text"
                value={cloneTo}
                onChange={(e) => setCloneTo(e.target.value)}
                placeholder={pathPlaceholder}
                className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Branch
              </label>
              <input
                type="text"
                value={gitBranch}
                onChange={(e) => setGitBranch(e.target.value)}
                placeholder="main"
                className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
              />
            </div>
          </div>
          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
            <span>
              {deploymentMode === "cloud"
                ? "Chorus cloud uses your stored deploy keys (added later in /settings → Connect)."
                : deploymentMode === "self-hosted"
                  ? "Server uses its own git credentials (SSH key on the Chorus user)."
                  : "Uses your machine's SSH/git credentials. Private repos work if `git clone` works in your terminal."}
            </span>
          </p>
        </Card>
      )}

      {sourceKind === "sandbox" && (
        <Card className="bg-card p-5">
          <p className="text-xs text-muted-foreground">
            We&apos;ll create an empty scratch dir at{" "}
            <code className="font-mono text-foreground/80">
              {deploymentMode === "cloud"
                ? "/workspace/sandbox/" + (slug(projectName) || "untitled")
                : "~/.chorus/sandbox/" + (slug(projectName) || "untitled")}
            </code>
            . Useful for design exercises, paste-in-a-snippet review, or
            kicking the tyres before connecting a real repo.
          </p>
        </Card>
      )}
    </div>
  );
}

function SourcePicker({
  kind,
  current,
  onSelect,
  icon,
  title,
  subtitle,
}: {
  kind: SourceKind;
  current: SourceKind;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  const isSelected = kind === current;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex flex-col items-start gap-2 rounded-xl border p-3.5 text-left transition ${
        isSelected
          ? "border-primary/40 bg-primary/5 ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
          : "border-border bg-card/40 hover:border-foreground/30"
      }`}
    >
      <span
        className={`grid h-7 w-7 place-items-center rounded-md ${
          isSelected ? "bg-primary/20 text-primary" : "bg-card text-muted-foreground"
        }`}
      >
        {icon}
      </span>
      <span className="text-sm font-semibold text-foreground">{title}</span>
      <span className="text-[11px] text-muted-foreground">{subtitle}</span>
    </button>
  );
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
