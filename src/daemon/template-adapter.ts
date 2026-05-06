/**
 * Template adapter — rewrites a builtin template's YAML to use the
 * voices the user actually has installed and enabled.
 *
 * Why: shipped templates (Tri-Review, Red/Green, etc.) hardcode model
 * names like `claude-opus-4-7`, `gpt-5.5`, `kimi-k2.6`. If a user
 * doesn't have those CLIs (or has them under different model
 * versions), the template can't run as-is. The adapter:
 *   - For each slot whose lineage has matching enabled voices,
 *     replaces `models` with the user's actual model_ids for that
 *     lineage. The first model in the user's voices list becomes
 *     the primary; the rest become fallbacks (per chorus-083).
 *   - For each slot whose lineage has NO matching voices, substitutes
 *     a different lineage that the user does have, preferring a
 *     lineage not yet used in the same phase (diversity preservation).
 *   - If no substitute is available (user has no voices anywhere),
 *     leaves models empty and marks the template as `incomplete`.
 *     The cockpit gates "Use template" until the user fills the YAML.
 *
 * Ranking note: voices are picked in their natural order from the
 * voices table. The seed orders curated CLI catalogues with the
 * most-capable model first (e.g., Claude Opus before Sonnet before
 * Haiku), so first-match approximates "top model" without an
 * explicit priority column. Future improvement: vendor_family
 * priority list keyed by lineage.
 *
 * Vendor-family fallback: an opencode voice with vendor_family
 * matching the template's slot lineage (e.g., template wants
 * lineage=moonshot, user has `opencode-go/kimi-k2.5` with
 * vendor_family=moonshot) is preferred over a cross-lineage swap.
 * Same model family, different transport — the template's intent is
 * preserved.
 */

import yaml from 'yaml';

interface Voice {
  id: string;
  provider: string;
  model_id: string;
  lineage: string;
  vendor_family: string | null;
  enabled: boolean;
}

interface SlotSpec {
  lineage?: string;
  models?: string[];
  // Reviewer slots may carry a personaId; the adapter passes through
  // unchanged.
  candidatePersonas?: unknown;
}

interface PhaseSpec {
  doer?: SlotSpec | null;
  reviewer?: {
    candidates?: SlotSpec[];
    require?: number;
    crossLineage?: boolean;
  };
}

interface TemplateRoot {
  phases?: PhaseSpec[];
}

export interface AdaptResult {
  yaml: string;
  isComplete: boolean;
  changed: boolean;
}

/**
 * Pure function. Takes the canonical YAML and the user's voices,
 * returns adapted YAML + completeness flag. Same input → same output.
 */
export function adaptTemplate(
  canonicalYaml: string,
  voices: Voice[],
): AdaptResult {
  const enabled = voices.filter((v) => v.enabled);
  // Group enabled voices by lineage and by vendor_family for the
  // two-step fallback (lineage match → vendor_family match → swap).
  const byLineage = new Map<string, Voice[]>();
  const byFamily = new Map<string, Voice[]>();
  for (const v of enabled) {
    const ll = byLineage.get(v.lineage) ?? [];
    ll.push(v);
    byLineage.set(v.lineage, ll);
    if (v.vendor_family) {
      const fl = byFamily.get(v.vendor_family) ?? [];
      fl.push(v);
      byFamily.set(v.vendor_family, fl);
    }
  }

  // Parse with the YAML library that round-trips comments/formatting
  // reasonably; we re-serialise at the end. The parsed shape is loose
  // because templates evolve — we only touch fields we know about.
  let parsed: TemplateRoot;
  try {
    parsed = yaml.parse(canonicalYaml) as TemplateRoot;
  } catch {
    // Malformed canonical YAML — caller's bug. Return as-is and let
    // the validation layer surface it.
    return { yaml: canonicalYaml, isComplete: false, changed: false };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.phases)) {
    return { yaml: canonicalYaml, isComplete: false, changed: false };
  }

  let isComplete = true;
  let changed = false;

  for (const phase of parsed.phases) {
    if (!phase) continue;
    // Track lineages already filled in this phase so we can prefer a
    // different lineage when substituting (diversity preservation).
    const usedLineages = new Set<string>();

    if (phase.doer) {
      const result = pickForSlot(
        phase.doer.lineage,
        byLineage,
        byFamily,
        usedLineages,
      );
      if (result) {
        if (
          phase.doer.lineage !== result.lineage ||
          !sameModels(phase.doer.models, result.models)
        ) {
          changed = true;
        }
        phase.doer.lineage = result.lineage;
        phase.doer.models = result.models;
        usedLineages.add(result.lineage);
      } else {
        if ((phase.doer.models?.length ?? 0) > 0) changed = true;
        phase.doer.models = [];
        isComplete = false;
      }
    }

    if (phase.reviewer?.candidates) {
      for (const slot of phase.reviewer.candidates) {
        const result = pickForSlot(
          slot.lineage,
          byLineage,
          byFamily,
          usedLineages,
        );
        if (result) {
          if (
            slot.lineage !== result.lineage ||
            !sameModels(slot.models, result.models)
          ) {
            changed = true;
          }
          slot.lineage = result.lineage;
          slot.models = result.models;
          usedLineages.add(result.lineage);
        } else {
          if ((slot.models?.length ?? 0) > 0) changed = true;
          slot.models = [];
          isComplete = false;
        }
      }
    }
  }

  // Re-serialise. yaml lib preserves keys/order and quoting style well
  // enough for builtin templates that are themselves machine-authored.
  // Hand-edited templates aren't passed to this function (caller gates
  // on source='builtin').
  const output = yaml.stringify(parsed, { lineWidth: 0 });
  return { yaml: output, isComplete, changed };
}

interface PickResult {
  lineage: string;
  models: string[];
}

function pickForSlot(
  preferredLineage: string | undefined,
  byLineage: Map<string, Voice[]>,
  byFamily: Map<string, Voice[]>,
  usedInPhase: Set<string>,
): PickResult | null {
  if (!preferredLineage) {
    // Slot doesn't specify a lineage. Don't touch — caller's intent.
    return null;
  }

  // 1. Exact lineage match: best case. Use the user's actual voices
  //    for that lineage; primary first, rest as fallbacks.
  const direct = byLineage.get(preferredLineage);
  if (direct && direct.length > 0) {
    return {
      lineage: preferredLineage,
      models: voicesToModelKeys(direct),
    };
  }

  // 2. Vendor-family match: e.g., template wants lineage=moonshot,
  //    user has `opencode-go/kimi-k2.5` (lineage=opencode,
  //    vendor_family=moonshot). The model family is preserved; only
  //    the transport changes.
  const familyMatch = byFamily.get(preferredLineage);
  if (familyMatch && familyMatch.length > 0) {
    return {
      lineage: familyMatch[0].lineage,
      models: voicesToModelKeys(familyMatch),
    };
  }

  // 3. Diversity-preserving substitute: prefer a lineage not yet used
  //    in this phase. Iteration order of Map preserves insertion order
  //    (deterministic for a stable voices list).
  for (const [lineage, voices] of byLineage) {
    if (!usedInPhase.has(lineage)) {
      return {
        lineage,
        models: voicesToModelKeys(voices),
      };
    }
  }

  // 4. Last-ditch: any lineage at all, even if already used. Better a
  //    repeated reviewer than an empty slot.
  for (const [lineage, voices] of byLineage) {
    return {
      lineage,
      models: voicesToModelKeys(voices),
    };
  }

  // 5. User has no enabled voices anywhere. Slot stays empty.
  return null;
}

/**
 * Voices reference one of two id forms in the wire/template space:
 *   - openrouter voices use the prefixed `id` (`openrouter:<model>`)
 *     because the runner's pickShimForVoice detects the prefix to
 *     dispatch via the HTTP shim (see chorus-086).
 *   - All other voices (CLI-backed) use the bare `model_id` because
 *     the CLI shim is keyed by lineage + model_id.
 */
function voicesToModelKeys(voices: Voice[]): string[] {
  const out: string[] = [];
  for (const v of voices) {
    out.push(v.provider === 'openrouter' ? v.id : v.model_id);
  }
  // Dedup defensive — two voices for the same model from different
  // sources would otherwise both appear in the fallback chain.
  return Array.from(new Set(out));
}

function sameModels(a: string[] | undefined, b: string[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
