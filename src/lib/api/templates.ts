// Template API endpoints
import { Template } from "@/lib/types";
import { fetchFromDaemon } from "./client";

export async function listTemplates(): Promise<Template[]> {
  return fetchFromDaemon<Template[]>("/templates");
}

export async function getTemplate(id: string): Promise<Template> {
  return fetchFromDaemon<Template>(`/templates/${id}`);
}

export async function saveTemplate(template: {
  id: string;
  yaml: string;
}): Promise<Template> {
  return fetchFromDaemon<Template>("/templates", {
    method: "POST",
    body: JSON.stringify(template),
  });
}
