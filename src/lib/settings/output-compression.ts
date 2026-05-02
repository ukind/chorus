/**
 * Tool-result compression settings (substrate only — no compressor yet).
 *
 * 9router's RTK Saver compresses `tool_result` blocks mid-stream — base64
 * images become thumbnails, repeated JSON shapes become deltas, large logs
 * are truncated with a marker. They report 20–40% token savings on long
 * peer-review chains. For Chorus this matters when reviewers exchange large
 * file dumps or screenshot attachments across rounds.
 *
 * This module ships the *opt-in switch* and the persisted threshold values.
 * The actual compressor is deferred — when implemented, it will read these
 * settings from the runner before forwarding tool_result blocks between
 * agents. Default OFF so v0.7 dogfood doesn't change behavior unexpectedly;
 * we'll flip the default once the compressor is battle-tested in v0.8+.
 *
 * Stored in the `settings` SQLite table:
 *   - tool_result_compression.enabled: boolean (default false)
 *   - tool_result_compression.image_thumbnail_max_kb: number (default 64)
 *   - tool_result_compression.text_truncate_kb: number (default 32)
 */

import { settings } from '../db';
import { z } from 'zod';

export interface OutputCompressionSettings {
  /** Master switch. When false, tool_result blocks pass through unmodified. */
  enabled: boolean;
  /** Base64 image payloads larger than this get downsampled to a thumbnail. */
  imageThumbnailMaxKb: number;
  /** Plain-text tool results larger than this get head/tail-truncated. */
  textTruncateKb: number;
}

export const DEFAULT_OUTPUT_COMPRESSION: OutputCompressionSettings = {
  enabled: false,
  imageThumbnailMaxKb: 64,
  textTruncateKb: 32,
};

const ENABLED_KEY = 'tool_result_compression.enabled';
const IMAGE_KEY = 'tool_result_compression.image_thumbnail_max_kb';
const TEXT_KEY = 'tool_result_compression.text_truncate_kb';

const PositiveIntSchema = z.number().int().positive();

export async function getOutputCompression(): Promise<OutputCompressionSettings> {
  const [enabledRaw, imageRaw, textRaw] = await Promise.all([
    settings.get(ENABLED_KEY),
    settings.get(IMAGE_KEY),
    settings.get(TEXT_KEY),
  ]);

  const imageParsed = PositiveIntSchema.safeParse(imageRaw);
  const textParsed = PositiveIntSchema.safeParse(textRaw);

  return {
    enabled:
      typeof enabledRaw === 'boolean' ? enabledRaw : DEFAULT_OUTPUT_COMPRESSION.enabled,
    imageThumbnailMaxKb: imageParsed.success
      ? imageParsed.data
      : DEFAULT_OUTPUT_COMPRESSION.imageThumbnailMaxKb,
    textTruncateKb: textParsed.success
      ? textParsed.data
      : DEFAULT_OUTPUT_COMPRESSION.textTruncateKb,
  };
}

export async function setOutputCompression(
  input: Partial<OutputCompressionSettings>,
): Promise<OutputCompressionSettings> {
  if (input.enabled !== undefined) {
    await settings.set(ENABLED_KEY, input.enabled);
  }
  if (input.imageThumbnailMaxKb !== undefined) {
    PositiveIntSchema.parse(input.imageThumbnailMaxKb);
    await settings.set(IMAGE_KEY, input.imageThumbnailMaxKb);
  }
  if (input.textTruncateKb !== undefined) {
    PositiveIntSchema.parse(input.textTruncateKb);
    await settings.set(TEXT_KEY, input.textTruncateKb);
  }
  return getOutputCompression();
}
