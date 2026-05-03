"use client";

/**
 * PersonaDialog — single dialog for both NEW and EDIT.
 *
 * Personas are flat (no YAML/Form duality like templates), so this is a
 * single form panel. The system prompt is the bulk of the content — it's
 * a Markdown body that gets prepended to the doer/reviewer's ask at run
 * time, so the textarea stretches to fill the dialog.
 *
 * Built-in source semantics mirror templates:
 *   - Save on a builtin row → server demotes it to user-owned so the
 *     boot-time seed leaves it alone.
 *   - Delete is hidden for builtins because the seed would recreate them.
 *     Users can clone-and-rename instead via the "Fork" trigger.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Plus,
  X,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { savePersona, deletePersona, DaemonError } from "@/lib/api";
import type { Persona } from "@/lib/api/personas";
import { LINEAGE_LABEL, type DaemonLineage } from "@/lib/lineage-maps";

const PERSONA_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

const LINEAGE_OPTIONS: Array<{ value: DaemonLineage | ""; label: string }> = [
  { value: "", label: "No preference" },
  { value: "anthropic", label: LINEAGE_LABEL.anthropic },
  { value: "openai", label: LINEAGE_LABEL.openai },
  { value: "google", label: LINEAGE_LABEL.google },
  { value: "opencode", label: LINEAGE_LABEL.opencode },
  { value: "moonshot", label: LINEAGE_LABEL.moonshot },
];

interface FormState {
  id: string;
  label: string;
  one_liner: string;
  recommended_lineage: string;
  system_prompt: string;
}

const DEFAULT_FORM: FormState = {
  id: "",
  label: "",
  one_liner: "",
  recommended_lineage: "",
  system_prompt:
    "# Worldview\n\nDescribe the lens this persona uses to read code and findings.\n\n# What you look for\n\n- ...\n- ...\n\n# Tone\n\nHow the persona writes — terse, exhaustive, contrarian, etc.\n",
};

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

interface ValidationIssue {
  field: keyof FormState;
  message: string;
}

function validate(form: FormState, isEdit: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const id = isEdit ? form.id : form.id || slugify(form.label);
  if (!id) issues.push({ field: "id", message: "id is required" });
  else if (!PERSONA_ID_RE.test(id))
    issues.push({
      field: "id",
      message: "id must be lowercase letters, numbers, dashes (2–64 chars)",
    });
  if (!form.label.trim()) issues.push({ field: "label", message: "label is required" });
  if (!form.one_liner.trim())
    issues.push({ field: "one_liner", message: "one-liner is required" });
  if (!form.system_prompt.trim())
    issues.push({ field: "system_prompt", message: "system prompt is required" });
  return issues;
}

export interface PersonaDialogProps {
  /** When set, dialog opens in EDIT mode populated from this persona.
   *  Built-ins are edited in place — the server demotes them to user-owned
   *  on save and the boot seed skips user rows. The Duplicate per-row
   *  affordance covers the "I want a renamed copy" case separately. */
  editing?: Persona;
  /** Renders the trigger. New mode wraps with a "+ New persona" button by default. */
  trigger?: React.ReactNode;
  /** Called after a successful save. Parent should refresh its list. */
  onSaved?: (savedId: string) => void;
  /** Called after a successful delete. Parent should refresh its list. */
  onDeleted?: (deletedId: string) => void;
  /** When provided, opens the dialog automatically on mount. Used by the
   *  page after a Duplicate so the user lands directly in the new row's
   *  edit form. The parent should clear this once consumed (typically via
   *  remounting the dialog with a different React key). */
  defaultOpen?: boolean;
}

export function PersonaDialog({
  editing,
  trigger,
  onSaved,
  onDeleted,
  defaultOpen,
}: PersonaDialogProps) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const isEdit = Boolean(editing);
  const isBuiltin = Boolean(editing?.builtin);

  // Initial form derived from the editing prop. Depend on the *content*
  // (id + updated_at) rather than the object reference so a parent
  // re-render with a fresh Persona object pointing at the same row doesn't
  // wipe in-flight edits.
  const initial = useMemo<FormState>(() => {
    if (!editing) return DEFAULT_FORM;
    return {
      id: editing.id,
      label: editing.label,
      one_liner: editing.one_liner,
      recommended_lineage: editing.recommended_lineage ?? "",
      system_prompt: editing.system_prompt ?? "",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id, editing?.updated_at]);

  const [form, setForm] = useState<FormState>(initial);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Tracks whether the user manually edited the id field; once they do,
  // typing in the label stops auto-syncing the slug.
  const [idDirty, setIdDirty] = useState(isEdit);

  useEffect(() => {
    setForm(initial);
    setSaveError(null);
    setConfirmingDelete(false);
    setIdDirty(isEdit);
  }, [initial, isEdit]);

  const initialRef = useRef(initial);
  initialRef.current = initial;

  const issues = useMemo(() => validate(form, isEdit), [form, isEdit]);
  const valid = issues.length === 0;

  function setField<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((prev) => {
      const next = { ...prev, [k]: v };
      if (k === "label" && !idDirty && !isEdit) {
        next.id = slugify(String(v));
      }
      return next;
    });
  }

  function reset() {
    setForm(initialRef.current);
    setSaving(false);
    setDeleting(false);
    setSaveError(null);
    setConfirmingDelete(false);
    setIdDirty(isEdit);
  }

  function handleClose(o: boolean) {
    setOpen(o);
    if (!o) setTimeout(reset, 200);
  }

  async function handleSave() {
    if (!valid || saving) return;
    const idToSave = isEdit ? editing!.id : form.id || slugify(form.label);
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await savePersona({
        id: idToSave,
        label: form.label.trim(),
        one_liner: form.one_liner.trim(),
        system_prompt: form.system_prompt,
        recommended_lineage: form.recommended_lineage || null,
      });
      onSaved?.(saved.id);
      handleClose(false);
    } catch (err) {
      setSaveError(
        err instanceof DaemonError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Save failed (unknown error)",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!editing || isBuiltin || deleting) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      // Auto-disarm after 8s so an abandoned arming doesn't fire on a much
      // later stray click. 4s was too tight in real-user testing — anyone
      // double-checking the row label blew the window. Matches the per-row
      // Trash icon's behavior on the personas page; same window in both
      // places.
      setTimeout(() => setConfirmingDelete((cur) => (cur ? false : cur)), 8000);
      return;
    }
    setDeleting(true);
    setSaveError(null);
    try {
      await deletePersona(editing.id);
      onDeleted?.(editing.id);
      handleClose(false);
    } catch (err) {
      setSaveError(
        err instanceof DaemonError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Delete failed (unknown error)",
      );
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  }

  const canSave = valid && !saving && !deleting;

  const triggerEl =
    trigger ??
    (isEdit ? (
      <button
        type="button"
        aria-label={`Edit persona ${editing!.label}`}
        className="grid h-7 w-7 place-items-center rounded-md border border-border bg-card text-muted-foreground transition hover:border-muted-foreground/40 hover:bg-accent/60 hover:text-foreground"
      >
        <Pencil className="h-3.5 w-3.5" />
      </button>
    ) : (
      <button
        type="button"
        aria-label="New persona"
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
      >
        <Plus className="h-4 w-4" />
        <span className="hidden sm:inline">New persona</span>
      </button>
    ));

  const titleText = isEdit
    ? `Edit persona — ${editing!.label}`
    : "New persona";
  const descText = isEdit
    ? isBuiltin
      ? "Saving promotes this built-in to a user-owned row at the same id so your edits survive daemon restarts."
      : "Edit the worldview, recommended lineage, and system prompt."
    : "Personas are reusable worldviews that prepend to a doer or reviewer's prompt.";

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogTrigger asChild>{triggerEl}</DialogTrigger>

      <DialogContent
        showCloseButton={false}
        className="flex max-h-[85vh] w-[min(96vw,720px)] flex-col gap-0 overflow-hidden border-border bg-card p-0 shadow-2xl sm:max-w-none"
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border px-6 py-4">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-primary/15 text-primary ring-1 ring-primary/20">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="flex-1 min-w-0">
            <DialogTitle className="text-[15px] font-semibold leading-tight tracking-tight">
              {titleText}
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
              {descText}
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => handleClose(false)}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {isEdit && isBuiltin && (
            <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div>
                  Built-in persona. Saving demotes it to a user copy so the
                  boot-time seed leaves it alone — you&apos;ll no longer
                  receive upstream updates for this id.
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Label"
              hint="Human-friendly name shown in the picker"
              issue={issues.find((i) => i.field === "label")}
            >
              <input
                type="text"
                value={form.label}
                onChange={(e) => setField("label", e.target.value)}
                placeholder="Security Skeptic"
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition focus:border-primary/60"
              />
            </Field>

            <Field
              label="ID"
              hint={
                isEdit
                  ? "Locked once created"
                  : "Lowercase, dashes — auto-derived from label"
              }
              issue={issues.find((i) => i.field === "id")}
            >
              <input
                type="text"
                value={form.id}
                disabled={isEdit}
                onChange={(e) => {
                  setIdDirty(true);
                  setField("id", e.target.value);
                }}
                placeholder="security-skeptic"
                className={cn(
                  "h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm outline-none transition focus:border-primary/60",
                  isEdit && "cursor-not-allowed opacity-60",
                )}
              />
            </Field>

            <Field
              label="One-liner"
              hint="Shown under the label in the persona list"
              issue={issues.find((i) => i.field === "one_liner")}
              span2
            >
              <input
                type="text"
                value={form.one_liner}
                onChange={(e) => setField("one_liner", e.target.value)}
                placeholder="Reads every diff like an attacker."
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition focus:border-primary/60"
              />
            </Field>

            <Field
              label="Recommended lineage"
              hint="Optional — pickers can default to this CLI"
              span2
            >
              <select
                value={form.recommended_lineage}
                onChange={(e) => setField("recommended_lineage", e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none transition focus:border-primary/60"
              >
                {LINEAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="mt-5">
            <Field
              label="System prompt"
              hint="Prepended to the doer / reviewer ask at run time. Markdown."
              issue={issues.find((i) => i.field === "system_prompt")}
            >
              <textarea
                value={form.system_prompt}
                onChange={(e) => setField("system_prompt", e.target.value)}
                spellCheck={false}
                className="min-h-[280px] w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[12px] leading-relaxed outline-none transition focus:border-primary/60"
              />
            </Field>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 border-t border-border bg-card/40 px-6 py-3">
          {saveError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <div className="flex-1 leading-snug">{saveError}</div>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {valid ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                  <span>Ready to save</span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3 text-destructive/80" />
                  <span>
                    {issues.length}{" "}
                    {issues.length === 1 ? "issue" : "issues"} to resolve
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              {isEdit && !isBuiltin && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting || saving}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition",
                    confirmingDelete
                      ? "border-destructive bg-destructive/15 text-destructive hover:bg-destructive/25"
                      : "border-border bg-card text-muted-foreground hover:border-destructive/50 hover:text-destructive",
                  )}
                >
                  {deleting ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                  {deleting
                    ? "Deleting…"
                    : confirmingDelete
                      ? "Click again to confirm"
                      : "Delete"}
                </button>
              )}
              <button
                type="button"
                onClick={() => handleClose(false)}
                className="h-9 rounded-md border border-border bg-card px-4 text-sm font-medium text-muted-foreground transition hover:border-muted-foreground/30 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={handleSave}
                className={cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-sm font-medium shadow-sm transition",
                  canSave
                    ? "bg-primary text-primary-foreground hover:bg-primary/90"
                    : "cursor-not-allowed bg-muted text-muted-foreground/60 shadow-none",
                )}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {saving
                  ? "Saving…"
                  : isEdit
                    ? "Save changes"
                    : "Save persona"}
              </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  issue,
  span2,
  children,
}: {
  label: string;
  hint?: string;
  issue?: ValidationIssue;
  span2?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("flex flex-col gap-1", span2 && "sm:col-span-2")}>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        {hint && (
          <span className="text-[10px] text-muted-foreground/70">{hint}</span>
        )}
      </span>
      {children}
      {issue && (
        <span className="text-[10px] text-destructive">{issue.message}</span>
      )}
    </label>
  );
}
