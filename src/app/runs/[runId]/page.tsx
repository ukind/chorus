import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { LiveRunView } from "@/components/live-run-view";
import { getChat, getTemplate, DaemonError } from "@/lib/api";
import type { TaskRun } from "@/lib/mock-data";

interface RunPageProps {
  params: Promise<{ runId: string }>;
}

async function getRunData(runId: string) {
  try {
    const chat = await getChat(runId);
    const template = await getTemplate(chat.templateId);
    return { chat, template };
  } catch (err) {
    throw err instanceof DaemonError ? err : new Error("Failed to load run data");
  }
}

export default async function RunPage({ params }: RunPageProps) {
  const { runId } = await params;
  const { chat, template } = await getRunData(runId);

  if (!chat) {
    notFound();
  }

  // Adapt Chat to TaskRun for the LiveRunView component
  const run: TaskRun = {
    id: chat.id,
    projectId: "unknown",
    title: chat.work,
    templateId: chat.templateId,
    status: chat.status === "drafting" ? "running" : chat.status === "reviewing" ? "needs-review" : "done",
    createdAt: new Date(chat.createdAt).toISOString(),
    reviewers: [],
    prompt: chat.work,
  };

  return (
    <AppShell>
      <div className="flex h-full flex-col">
        <LiveRunView run={run} project={undefined} template={template} />
      </div>
    </AppShell>
  );
}
