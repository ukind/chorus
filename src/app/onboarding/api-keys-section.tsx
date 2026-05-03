"use client";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { API_KEYS } from "./helpers.js";

interface ApiKeysSectionProps {
  apiKeys: Record<string, string>;
  updateApiKey: (provider: string, value: string) => void;
}

export function ApiKeysSection({ apiKeys, updateApiKey }: ApiKeysSectionProps) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex flex-wrap items-baseline gap-x-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>API keys</span>
        <span className="font-normal normal-case text-muted-foreground/70">
          optional — paste only the ones you want to use
        </span>
      </h2>
      <Card className="divide-y divide-border bg-card p-0">
        {API_KEYS.map((row) => (
          <div
            key={row.provider}
            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center"
          >
            <label
              htmlFor={`apikey-${row.provider}`}
              className="w-full text-sm font-medium sm:w-32"
            >
              {row.label}
            </label>
            <Input
              id={`apikey-${row.provider}`}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={row.placeholder}
              value={apiKeys[row.provider] ?? ""}
              onChange={(e) => updateApiKey(row.provider, e.target.value)}
              className="flex-1 font-mono text-xs"
            />
          </div>
        ))}
      </Card>
      <p className="mt-2 text-xs text-muted-foreground">
        Stored locally in <code>~/.chorus/chorus.db</code>. Never sent
        anywhere except the model provider you call.
      </p>
    </section>
  );
}
