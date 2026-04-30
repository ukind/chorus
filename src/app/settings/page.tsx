"use client";

import { useEffect, useMemo, useState } from "react";
import { getTransport, updateTransport, type Transport } from "@/lib/api/settings";
import {
  Activity,
  AlertTriangle,
  Check,
  Code2,
  FolderLock,
  Plus,
  Sliders,
  Webhook,
  Workflow,
  X,
  Eye,
  Wrench,
  Shield,
  Cloud,
  Monitor,
  Server,
  Send,
  Loader2,
  Info,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type AutoApprove = "auto" | "ask" | "block";
type Role = "driver" | "reviewer";

interface ToolDef {
  id: string;
  name: string;
  description: string;
}

const TOOLS: ToolDef[] = [
  { id: "read", name: "Read files", description: "cat, less, head, file open" },
  { id: "list", name: "List & search", description: "ls, grep, find, ripgrep" },
  {
    id: "write",
    name: "Write files",
    description: "Edit, Write inside allowed dirs",
  },
  {
    id: "exec",
    name: "Run commands",
    description: "Bash, npm, pnpm, python, go",
  },
  {
    id: "net",
    name: "Network access",
    description: "curl, fetch, package install",
  },
  {
    id: "outside-cwd",
    name: "Writes outside working dir",
    description: "Anything outside the allowed paths below",
  },
];

// Sensible defaults per role.
const DEFAULT_DRIVER: Record<string, AutoApprove> = {
  read: "auto",
  list: "auto",
  write: "ask",
  exec: "ask",
  net: "ask",
  "outside-cwd": "block",
};

const DEFAULT_REVIEWER: Record<string, AutoApprove> = {
  read: "auto",
  list: "auto",
  write: "block", // reviewers should never write code
  exec: "ask",
  net: "ask",
  "outside-cwd": "block",
};

const POLICY_STYLES: Record<AutoApprove, string> = {
  auto: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  ask: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  block: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

function cycle(p: AutoApprove): AutoApprove {
  return p === "auto" ? "ask" : p === "ask" ? "block" : "auto";
}

export default function SettingsPage() {
  const [view, setView] = useState<"form" | "yaml">("form");

  // Form-level state
  const [maxConcurrent, setMaxConcurrent] = useState(3);
  const [driverPolicies, setDriverPolicies] =
    useState<Record<string, AutoApprove>>(DEFAULT_DRIVER);
  const [reviewerPolicies, setReviewerPolicies] =
    useState<Record<string, AutoApprove>>(DEFAULT_REVIEWER);
  const [allowedDirs, setAllowedDirs] = useState<string[]>([
    "~/dev",
    "~/work",
    "/tmp/chorus-sandbox",
  ]);
  const [newDir, setNewDir] = useState("");
  const [defaultDriver, setDefaultDriver] = useState("claude-code");
  const [defaultCostCap, setDefaultCostCap] = useState("2.00");
  const [defaultThreshold, setDefaultThreshold] = useState("unanimous");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [privacyTier, setPrivacyTier] = useState<"local" | "proxied" | "cloud">(
    "local",
  );
  const [webhookTestState, setWebhookTestState] = useState<
    "idle" | "running" | "ok" | "fail"
  >("idle");

  function testWebhook() {
    if (webhookTestState === "running") return;
    setWebhookTestState("running");
    setTimeout(() => {
      setWebhookTestState(webhookUrl.startsWith("https://") ? "ok" : "fail");
      setTimeout(() => setWebhookTestState("idle"), 2200);
    }, 1100);
  }

  function cyclePolicy(role: Role, toolId: string) {
    if (role === "driver") {
      setDriverPolicies((prev) => ({ ...prev, [toolId]: cycle(prev[toolId]) }));
    } else {
      setReviewerPolicies((prev) => ({
        ...prev,
        [toolId]: cycle(prev[toolId]),
      }));
    }
  }

  function addDir() {
    const d = newDir.trim();
    if (!d || allowedDirs.includes(d)) return;
    setAllowedDirs((prev) => [...prev, d]);
    setNewDir("");
  }

  // Live-derived YAML
  const yaml = useMemo(
    () =>
      buildYaml({
        maxConcurrent,
        driverPolicies,
        reviewerPolicies,
        allowedDirs,
        defaultDriver,
        defaultCostCap,
        defaultThreshold,
        mcpEnabled,
        webhookUrl,
      }),
    [
      maxConcurrent,
      driverPolicies,
      reviewerPolicies,
      allowedDirs,
      defaultDriver,
      defaultCostCap,
      defaultThreshold,
      mcpEnabled,
      webhookUrl,
    ],
  );

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8 md:px-8 md:py-10">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              Settings
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Workspace
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Defaults applied to every chat. Templates can override these
              per-run. The MCP server can read & patch this config — your main
              Claude can configure Chorus for you.
            </p>
          </div>
          {/* Form / YAML toggle */}
          <div className="flex shrink-0 rounded-md border border-border bg-card p-0.5">
            <button
              type="button"
              onClick={() => setView("form")}
              className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition ${
                view === "form"
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Wrench className="h-3.5 w-3.5" />
              Form
            </button>
            <button
              type="button"
              onClick={() => setView("yaml")}
              className={`flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition ${
                view === "yaml"
                  ? "bg-primary/15 text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              YAML
            </button>
          </div>
        </div>

        {view === "yaml" ? (
          <YamlEditor yaml={yaml} />
        ) : (
          <FormView
            maxConcurrent={maxConcurrent}
            setMaxConcurrent={setMaxConcurrent}
            driverPolicies={driverPolicies}
            reviewerPolicies={reviewerPolicies}
            cyclePolicy={cyclePolicy}
            allowedDirs={allowedDirs}
            setAllowedDirs={setAllowedDirs}
            newDir={newDir}
            setNewDir={setNewDir}
            addDir={addDir}
            defaultDriver={defaultDriver}
            setDefaultDriver={setDefaultDriver}
            defaultCostCap={defaultCostCap}
            setDefaultCostCap={setDefaultCostCap}
            defaultThreshold={defaultThreshold}
            setDefaultThreshold={setDefaultThreshold}
            webhookUrl={webhookUrl}
            setWebhookUrl={setWebhookUrl}
            mcpEnabled={mcpEnabled}
            setMcpEnabled={setMcpEnabled}
            privacyTier={privacyTier}
            setPrivacyTier={setPrivacyTier}
            webhookTestState={webhookTestState}
            testWebhook={testWebhook}
          />
        )}

        {/* Save */}
        <div className="mt-8 flex items-center justify-between rounded-md border border-border bg-card px-5 py-3">
          <Badge
            variant="outline"
            className="border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-300"
          >
            <Check className="mr-1 h-3 w-3" />
            All changes saved
          </Badge>
          <button
            type="button"
            className="rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            Apply &amp; restart daemon
          </button>
        </div>
      </div>
    </AppShell>
  );
}

interface FormViewProps {
  maxConcurrent: number;
  setMaxConcurrent: (n: number) => void;
  driverPolicies: Record<string, AutoApprove>;
  reviewerPolicies: Record<string, AutoApprove>;
  cyclePolicy: (role: Role, toolId: string) => void;
  allowedDirs: string[];
  setAllowedDirs: (v: string[]) => void;
  newDir: string;
  setNewDir: (v: string) => void;
  addDir: () => void;
  defaultDriver: string;
  setDefaultDriver: (v: string) => void;
  defaultCostCap: string;
  setDefaultCostCap: (v: string) => void;
  defaultThreshold: string;
  setDefaultThreshold: (v: string) => void;
  webhookUrl: string;
  setWebhookUrl: (v: string) => void;
  mcpEnabled: boolean;
  setMcpEnabled: (v: boolean) => void;
  privacyTier: "local" | "proxied" | "cloud";
  setPrivacyTier: (v: "local" | "proxied" | "cloud") => void;
  webhookTestState: "idle" | "running" | "ok" | "fail";
  testWebhook: () => void;
}

function FormView(p: FormViewProps) {
  return (
    <>
      {/* Concurrency */}
      <Section
        icon={<Activity className="h-4 w-4" />}
        title="Concurrency"
        subtitle="How many chats Chorus runs in parallel. Overflow waits in a queue."
      >
        <div className="flex items-center gap-6">
          <div className="flex-1">
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={p.maxConcurrent}
              onChange={(e) => p.setMaxConcurrent(parseInt(e.target.value, 10))}
              className="w-full accent-primary"
            />
            <div className="mt-1.5 flex justify-between text-[10px] font-mono text-muted-foreground">
              <span>1</span>
              <span>5</span>
              <span>10</span>
            </div>
          </div>
          <div className="rounded-md border border-border bg-card px-4 py-2 font-mono text-sm">
            {p.maxConcurrent} concurrent
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Each chat reserves one tmux session + {p.maxConcurrent * 3} reviewer
          panes. Above this limit new chats land in a FIFO queue.
        </p>
      </Section>

      {/* Sandbox profile — links to dedicated /settings/permissions page */}
      <Section
        icon={<Shield className="h-4 w-4" />}
        title="Sandbox & first-call permissions"
        subtitle="What can chorus-spawned reviewers do on this machine? Pick a profile, toggle prompt auto-approval, choose whether to allow outbound network."
      >
        <a
          href="/settings/permissions"
          className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-sm font-medium text-primary transition hover:bg-primary/10"
        >
          Open Permissions page
          <span aria-hidden>→</span>
        </a>
      </Section>

      {/* Transport: headless vs tmux */}
      <TransportSection />

      {/* Permissions — split by role */}
      <Section
        icon={<FolderLock className="h-4 w-4" />}
        title="Per-tool auto-approve"
        subtitle="Drivers write code; reviewers don't. Defaults reflect that. Click any chip to cycle auto / ask / block."
      >
        {/* Header row */}
        <div className="grid grid-cols-[1fr_120px_120px] gap-3 border-b border-border pb-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
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
          {TOOLS.map((tool) => (
            <div
              key={tool.id}
              className="grid grid-cols-[1fr_120px_120px] items-center gap-3 py-2.5"
            >
              <div className="flex flex-col">
                <span className="text-sm text-foreground">{tool.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {tool.description}
                </span>
              </div>
              <PolicyChip
                policy={p.driverPolicies[tool.id]}
                onCycle={() => p.cyclePolicy("driver", tool.id)}
                role="driver"
              />
              <PolicyChip
                policy={p.reviewerPolicies[tool.id]}
                onCycle={() => p.cyclePolicy("reviewer", tool.id)}
                role="reviewer"
              />
            </div>
          ))}
        </div>

        <p className="mt-3 flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
          <span>
            <span className="font-mono text-amber-300">ask</span> prompts
            appear as cards in the chat — you click Approve / Deny instead of
            the agent stalling.
          </span>
        </p>
      </Section>

      {/* Working directories */}
      <Section
        icon={<FolderLock className="h-4 w-4" />}
        title="Working directories"
        subtitle="Each tmux session is started inside one of these paths. Writes outside are blocked."
      >
        <div className="flex flex-wrap gap-2">
          {p.allowedDirs.map((d) => (
            <span
              key={d}
              className="group inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 font-mono text-[11px] text-foreground"
            >
              {d}
              <button
                type="button"
                onClick={() =>
                  p.setAllowedDirs(p.allowedDirs.filter((x) => x !== d))
                }
                className="text-muted-foreground/50 transition hover:text-rose-400"
                aria-label={`Remove ${d}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={p.newDir}
            onChange={(e) => p.setNewDir(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && p.addDir()}
            placeholder="~/code/another-project"
            className="flex-1 rounded-md border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
          />
          <button
            type="button"
            onClick={p.addDir}
            className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Add path
          </button>
        </div>
      </Section>

      {/* Defaults */}
      <Section
        icon={<Sliders className="h-4 w-4" />}
        title="Template defaults"
        subtitle="Applied to new templates and one-off chats. Per-template values override these."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Default driver">
            <select
              value={p.defaultDriver}
              onChange={(e) => p.setDefaultDriver(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-foreground/30 focus:outline-none"
            >
              <option value="claude-code">claude-code</option>
              <option value="cursor">cursor</option>
              <option value="codex-cli">codex-cli</option>
              <option value="windsurf">windsurf</option>
              <option value="external">external (ask each run)</option>
            </select>
          </Field>
          <Field label="Default agreement threshold">
            <select
              value={p.defaultThreshold}
              onChange={(e) => p.setDefaultThreshold(e.target.value)}
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-foreground/30 focus:outline-none"
            >
              <option value="unanimous">unanimous</option>
              <option value="majority">majority</option>
              <option value="any">any</option>
            </select>
          </Field>
          <Field label="Default cost cap (USD per chat)">
            <div className="flex items-center gap-2">
              <span className="font-mono text-sm text-muted-foreground">$</span>
              <input
                type="number"
                step="0.10"
                min={0}
                value={p.defaultCostCap}
                onChange={(e) => p.setDefaultCostCap(e.target.value)}
                className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground focus:border-foreground/30 focus:outline-none"
              />
            </div>
          </Field>
          <Field label="On model error">
            <select
              defaultValue="fallback"
              className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground focus:border-foreground/30 focus:outline-none"
            >
              <option value="fallback">try next fallback model</option>
              <option value="fail">mark chat failed</option>
              <option value="ask-user">surface to me</option>
            </select>
          </Field>
        </div>
      </Section>

      {/* Privacy tier */}
      <Section
        icon={<Shield className="h-4 w-4" />}
        title="Privacy & data path"
        subtitle="How prompts and code reach each LLM. Affects what leaves your machine."
      >
        <div className="space-y-2">
          <PrivacyTierOption
            current={p.privacyTier}
            kind="local"
            onSelect={() => p.setPrivacyTier("local")}
            icon={<Monitor className="h-4 w-4" />}
            title="Local-only (BYO CLIs)"
            tagline="Strictest"
            features={[
              "Daemon runs on your machine; CLIs run on your machine.",
              "Prompts go directly from your machine to each provider.",
              "Chorus sees nothing — not even chat IDs.",
            ]}
            tradeoff="No cloud dashboard, no team sharing, no fallback when a CLI is down."
          />
          <PrivacyTierOption
            current={p.privacyTier}
            kind="proxied"
            onSelect={() => p.setPrivacyTier("proxied")}
            icon={<Server className="h-4 w-4" />}
            title="Proxied credits"
            tagline="Recommended for credits"
            features={[
              "Stateless edge proxy: prompts transit, never persist.",
              "Stripe-pattern: same payload-handling discipline.",
              "Used only when you spend credits to try a model you don't have.",
            ]}
            tradeoff="One extra hop between you and the provider."
          />
          <PrivacyTierOption
            current={p.privacyTier}
            kind="cloud"
            onSelect={() => p.setPrivacyTier("cloud")}
            icon={<Cloud className="h-4 w-4" />}
            title="Cloud workspace"
            tagline="Team / multi-machine"
            features={[
              "Code is cloned into Chorus's cloud workspace.",
              "Transcripts + verdicts kept for audit & retro.",
              "Encrypted at rest; SOC 2 in progress.",
            ]}
            tradeoff="Your code lives on our infra. Read the privacy whitepaper before flipping this on."
          />
        </div>
      </Section>

      {/* Notifications */}
      <Section
        icon={<Webhook className="h-4 w-4" />}
        title="Notifications & MCP"
        subtitle="How outer orchestrators (your main Claude / Cursor session) get pinged when a chat finishes or blocks."
      >
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => p.setMcpEnabled(!p.mcpEnabled)}
            className="flex w-full items-center justify-between rounded-md border border-border bg-card/50 px-3 py-3 text-left transition hover:border-foreground/20"
          >
            <div className="flex items-start gap-3">
              <Workflow className="mt-0.5 h-4 w-4 text-primary" />
              <div className="flex flex-col">
                <span className="text-sm text-foreground">
                  Chorus MCP server
                </span>
                <span className="text-[11px] text-muted-foreground">
                  Exposes <span className="font-mono">mm.create_chat</span>,{" "}
                  <span className="font-mono">mm.update_settings</span>,{" "}
                  <span className="font-mono">mm.create_template</span> and 9
                  other tools. Outer Claude / Cursor / Codex can configure
                  Chorus for you.
                </span>
              </div>
            </div>
            <span
              className={`flex h-5 w-9 items-center rounded-full border p-0.5 transition ${
                p.mcpEnabled
                  ? "border-emerald-500/40 bg-emerald-500/20"
                  : "border-border bg-card"
              }`}
            >
              <span
                className={`h-3.5 w-3.5 rounded-full transition-transform ${
                  p.mcpEnabled
                    ? "translate-x-4 bg-emerald-400"
                    : "bg-muted-foreground/50"
                }`}
              />
            </span>
          </button>

          <Field label="Webhook URL (optional)">
            <div className="flex gap-2">
              <input
                type="url"
                value={p.webhookUrl}
                onChange={(e) => p.setWebhookUrl(e.target.value)}
                placeholder="https://hooks.example.com/chorus"
                className="flex-1 rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:outline-none"
              />
              <button
                type="button"
                onClick={p.testWebhook}
                disabled={!p.webhookUrl || p.webhookTestState === "running"}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-2 text-xs font-medium transition ${
                  p.webhookTestState === "ok"
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : p.webhookTestState === "fail"
                      ? "border-rose-500/30 bg-rose-500/10 text-rose-300"
                      : "border-border bg-card text-muted-foreground hover:text-foreground"
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {p.webhookTestState === "running" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : p.webhookTestState === "ok" ? (
                  <Check className="h-3.5 w-3.5" />
                ) : p.webhookTestState === "fail" ? (
                  <AlertTriangle className="h-3.5 w-3.5" />
                ) : (
                  <Send className="h-3.5 w-3.5" />
                )}
                {p.webhookTestState === "ok"
                  ? "204 OK"
                  : p.webhookTestState === "fail"
                    ? "Failed"
                    : p.webhookTestState === "running"
                      ? "Posting…"
                      : "Test"}
              </button>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Posted on chat finished / blocked / errored. Payload includes
              chat_id, status, synthesis.
            </p>
          </Field>
        </div>
      </Section>
    </>
  );
}

function PolicyChip({
  policy,
  onCycle,
  role,
}: {
  policy: AutoApprove;
  onCycle: () => void;
  role: Role;
}) {
  return (
    <button
      type="button"
      onClick={onCycle}
      className={`justify-self-end rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition hover:scale-105 ${POLICY_STYLES[policy]}`}
      title={`${role}: cycle policy`}
    >
      {policy}
    </button>
  );
}

function YamlEditor({ yaml }: { yaml: string }) {
  return (
    <Card className="overflow-hidden bg-card p-0">
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Code2 className="h-3.5 w-3.5 text-primary" />
          <span className="text-[11px] font-medium uppercase tracking-wider text-foreground">
            settings.yaml
          </span>
          <Badge
            variant="outline"
            className="border-border font-mono text-[10px]"
          >
            ~/.chorus/settings.yaml
          </Badge>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Eye className="h-3 w-3" />
          live-rendered from form state
        </div>
      </div>
      <textarea
        value={yaml}
        readOnly
        spellCheck={false}
        className="block min-h-[520px] w-full resize-none border-0 bg-background px-5 py-4 font-mono text-[12px] leading-relaxed text-foreground/90 focus:outline-none"
      />
      <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
        <span>
          Same shape that{" "}
          <span className="font-mono text-foreground/80">
            mm.update_settings
          </span>{" "}
          accepts as a patch.
        </span>
        <button
          type="button"
          className="rounded-md border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground transition hover:text-foreground"
        >
          Copy
        </button>
      </div>
    </Card>
  );
}

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="mt-6 bg-card p-5">
      <div className="mb-4 flex items-start gap-3">
        <span className="rounded-md border border-border bg-card/60 p-1.5 text-foreground/70">
          {icon}
        </span>
        <div className="flex-1">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children}
    </Card>
  );
}

function PrivacyTierOption({
  kind,
  current,
  onSelect,
  icon,
  title,
  tagline,
  features,
  tradeoff,
}: {
  kind: "local" | "proxied" | "cloud";
  current: "local" | "proxied" | "cloud";
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  tagline: string;
  features: string[];
  tradeoff: string;
}) {
  const isSelected = kind === current;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition ${
        isSelected
          ? "border-primary/40 bg-primary/5 ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
          : "border-border bg-card/40 hover:border-foreground/30"
      }`}
    >
      <span
        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md ${
          isSelected ? "bg-primary/20 text-primary" : "bg-card text-muted-foreground"
        }`}
      >
        {icon}
      </span>
      <div className="flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{title}</span>
          <Badge
            variant="outline"
            className="border-border font-mono text-[10px]"
          >
            {tagline}
          </Badge>
        </div>
        <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
          {features.map((f) => (
            <li key={f} className="flex items-start gap-1.5">
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400/60" />
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-start gap-1.5 text-[10px] text-muted-foreground">
          <Info className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/60" />
          <span>
            <span className="font-medium text-foreground/80">Trade-off:</span>{" "}
            {tradeoff}
          </span>
        </div>
      </div>
      {isSelected && <Check className="mt-1 h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

// Build YAML from current form state.
interface YamlInputs {
  maxConcurrent: number;
  driverPolicies: Record<string, AutoApprove>;
  reviewerPolicies: Record<string, AutoApprove>;
  allowedDirs: string[];
  defaultDriver: string;
  defaultCostCap: string;
  defaultThreshold: string;
  mcpEnabled: boolean;
  webhookUrl: string;
}

function buildYaml(s: YamlInputs): string {
  const dirs = s.allowedDirs.map((d) => `  - ${d}`).join("\n");
  const driverP = TOOLS.map(
    (t) => `    ${t.id.replace("-", "_")}: ${s.driverPolicies[t.id]}`,
  ).join("\n");
  const reviewerP = TOOLS.map(
    (t) => `    ${t.id.replace("-", "_")}: ${s.reviewerPolicies[t.id]}`,
  ).join("\n");

  return `# Chorus workspace settings
# Edit here, or via the Form tab, or via mm.update_settings from any MCP client.

concurrency:
  max_concurrent_chats: ${s.maxConcurrent}

permissions:
  driver:
${driverP}
  reviewer:
${reviewerP}

allowed_directories:
${dirs}

defaults:
  driver: ${s.defaultDriver}
  agreement_threshold: ${s.defaultThreshold}
  cost_cap_usd: ${s.defaultCostCap}
  on_error: fallback

notifications:
  mcp_enabled: ${s.mcpEnabled}
  webhook_url: ${s.webhookUrl ? `"${s.webhookUrl}"` : '""'}
`;
}

/**
 * Transport toggle — chooses how chorus invokes the underlying CLIs.
 *
 * Headless (default): subprocess + stream-json. Lower RAM, faster cold start,
 * fewer permission prompts.
 *
 * Tmux: persistent TUI sessions you can attach to with `tmux attach -t <name>`
 * for visual debugging. Higher RAM, but lets you see exactly what each agent
 * is doing step-by-step. First-class option, no deprecation timeline.
 */
function TransportSection() {
  const [current, setCurrent] = useState<Transport | null>(null);
  const [descriptions, setDescriptions] = useState<
    Record<Transport, { label: string; description: string }> | undefined
  >(undefined);
  const [pending, setPending] = useState<Transport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTransport()
      .then((res) => {
        if (cancelled) return;
        setCurrent(res.transport);
        setDescriptions(res.descriptions);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load transport setting.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onPick = (t: Transport): void => {
    if (current === t || pending) return;
    setPending(t);
    setError(null);
    updateTransport({ transport: t })
      .then((res) => {
        setCurrent(res.transport);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "Save failed.");
      })
      .finally(() => setPending(null));
  };

  return (
    <Section
      icon={<Server className="h-4 w-4" />}
      title="Transport"
      subtitle="How chorus runs each CLI. Default is headless (faster, lower RAM). Switch to tmux if you want to attach and watch agents work step-by-step."
    >
      {error && (
        <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {(["headless", "tmux"] as const).map((t) => {
          const active = current === t;
          const isPending = pending === t;
          const meta = descriptions?.[t];
          return (
            <button
              key={t}
              type="button"
              onClick={() => onPick(t)}
              disabled={pending !== null || current === null}
              className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition ${
                active
                  ? "border-primary/50 bg-primary/10"
                  : "border-border bg-card hover:border-muted-foreground/30"
              } ${pending !== null ? "opacity-60" : ""}`}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {meta?.label ?? (t === "headless" ? "Headless" : "Tmux")}
                </span>
                {active && (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                    {isPending ? "saving…" : "active"}
                  </span>
                )}
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {meta?.description ??
                  (t === "headless"
                    ? "Subprocess per call. Lower RAM, faster cold start, no permission dialogs."
                    : "Persistent terminal sessions you can attach to for visual debug.")}
              </p>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">
        Tip: set <code className="rounded bg-muted px-1">CHORUS_TRANSPORT=tmux</code> in
        your environment to override per-shell without changing this setting.
      </p>
    </Section>
  );
}
