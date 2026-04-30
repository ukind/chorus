// Template API endpoints
import yaml from "yaml";
import { Template } from "@/lib/types";
import { fetchFromDaemon } from "./client";

interface RawTemplateRow {
  id: string;
  source: "builtin" | "user";
  yaml: string;
  created_at: number;
  updated_at: number;
}

interface ParsedTemplateYaml {
  id?: string;
  name?: string;
  description?: string;
  category?: Template["category"];
  author?: string;
  agreementThreshold?: number | Template["agreementThreshold"];
  onThresholdMet?: Template["onThresholdMet"] | string;
  maxRounds?: number;
  yoloDefault?: boolean;
}

/**
 * Daemon stores templates as raw YAML rows. The UI needs structured
 * Template objects, so we parse the YAML field client-side.
 * Falls back to safe defaults for fields the UI doesn't need yet (phases etc).
 */
function parseRow(row: RawTemplateRow): Template {
  let parsed: ParsedTemplateYaml = {};
  try {
    parsed = (yaml.parse(row.yaml) as ParsedTemplateYaml) ?? {};
  } catch {
    // Bad YAML → leave parsed empty; the card will show id only.
  }

  // agreementThreshold: numbers (0..1) ↔ enum strings
  let threshold: Template["agreementThreshold"] = "majority";
  if (typeof parsed.agreementThreshold === "number") {
    if (parsed.agreementThreshold >= 0.99) threshold = "unanimous";
    else if (parsed.agreementThreshold >= 0.5) threshold = "majority";
    else threshold = "any";
  } else if (typeof parsed.agreementThreshold === "string") {
    threshold = parsed.agreementThreshold as Template["agreementThreshold"];
  }

  return {
    id: row.id,
    name: parsed.name ?? row.id,
    description: parsed.description ?? "",
    category: parsed.category ?? "review",
    phases: [],
    agreementThreshold: threshold,
    onThresholdMet:
      parsed.onThresholdMet === "auto-finalize"
        ? "auto-finalize"
        : "ask-user",
    maxRounds: parsed.maxRounds ?? 3,
    driver: "external",
    driverHandoff: false,
    verificationGate: "auto",
    costCapUsd: 0,
    yoloDefault: parsed.yoloDefault ?? false,
    onError: "ask-user",
    notify: "dashboard-only",
    yaml: row.yaml,
    authorHandle: parsed.author ?? "chorus",
    forks: 0,
    popularity: 0,
  };
}

export async function listTemplates(): Promise<Template[]> {
  const rows = await fetchFromDaemon<RawTemplateRow[]>("/templates");
  return rows.map(parseRow);
}

export async function getTemplate(id: string): Promise<Template> {
  const row = await fetchFromDaemon<RawTemplateRow>(`/templates/${id}`);
  return parseRow(row);
}

export async function saveTemplate(template: {
  id: string;
  yaml: string;
}): Promise<Template> {
  const row = await fetchFromDaemon<RawTemplateRow>("/templates", {
    method: "POST",
    body: JSON.stringify(template),
  });
  return parseRow(row);
}
