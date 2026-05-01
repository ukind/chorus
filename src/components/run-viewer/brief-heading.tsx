"use client";

import { useState } from "react";
import { chatDisplayTitle } from "@/lib/chat-title";

/**
 * Renders the chat brief at the top of the run page.
 *
 * Long briefs (persona system_prompt + user request + inlined files) used
 * to render as a wall of text dominating the viewport. We collapse to a
 * one-line summary by default with a "Show full brief" expander, mirroring
 * how Linear / GitHub handle long PR titles. Expanded view is a scrollable
 * <pre> block so very long briefs don't break page height.
 */
const BRIEF_COLLAPSED_CHARS = 200;

export function BriefHeading({ work }: { work: string }) {
  const [expanded, setExpanded] = useState(false);
  const displayTitle = chatDisplayTitle(work);
  const isLong = displayTitle.length > BRIEF_COLLAPSED_CHARS || work !== displayTitle;
  const summary =
    displayTitle.length > BRIEF_COLLAPSED_CHARS
      ? `${displayTitle.slice(0, BRIEF_COLLAPSED_CHARS).replace(/\s+\S*$/, "")}…`
      : displayTitle;

  if (!isLong) {
    return (
      <h1 className="truncate text-sm font-medium tracking-tight">
        {displayTitle}
      </h1>
    );
  }

  return (
    <div className="min-w-0">
      {expanded ? (
        <>
          <h1 className="truncate text-sm font-medium tracking-tight">
            {summary}
          </h1>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background px-5 py-4 font-mono text-[12px] leading-relaxed text-foreground/90">
            {work}
          </pre>
        </>
      ) : (
        <h1 className="truncate text-sm font-medium tracking-tight">
          {summary}
        </h1>
      )}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="mt-1 text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        {expanded ? "Show less" : "Show full brief"}
      </button>
    </div>
  );
}
