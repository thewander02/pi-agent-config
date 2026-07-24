import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const HANDOFF_TRANSCRIPT_MAX_BYTES = 96 * 1024;
export const OLDER_CONTEXT_MARKER = "[older handoff context omitted]";

function textBlocks(content: unknown, includeImages: boolean) {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [text] : [];
  }
  if (!Array.isArray(content)) return [];

  return content.flatMap((block) => {
    if (typeof block !== "object" || block === null || !("type" in block)) {
      return [];
    }
    if (
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
    ) {
      const text = block.text.trim();
      return text ? [text] : [];
    }
    if (includeImages && block.type === "image") return ["[image omitted]"];
    return [];
  });
}

function activeContextEntries(entries: readonly SessionEntry[]) {
  let compactionIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]?.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex === -1) return [...entries];

  const compaction = entries[compactionIndex];
  if (compaction?.type !== "compaction") return [...entries];

  const firstKeptIndex = entries.findIndex(
    (entry) => entry.id === compaction.firstKeptEntryId,
  );
  return [
    compaction,
    ...(firstKeptIndex >= 0
      ? entries.slice(firstKeptIndex, compactionIndex)
      : []),
    ...entries.slice(compactionIndex + 1),
  ];
}

function serializeEntry(entry: SessionEntry) {
  if (entry.type === "compaction") {
    const summary = entry.summary.trim();
    return summary ? `COMPACTION SUMMARY\n${summary}` : "";
  }
  if (entry.type !== "message") return "";

  if (entry.message.role === "user") {
    const content = textBlocks(entry.message.content, true).join("\n");
    return content ? `USER\n${content}` : "";
  }
  if (entry.message.role === "assistant") {
    const content = textBlocks(entry.message.content, false).join("\n");
    return content ? `ASSISTANT\n${content}` : "";
  }
  return "";
}

function utf8Suffix(text: string, maxBytes: number) {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2);
    if (Buffer.byteLength(text.slice(midpoint), "utf8") <= maxBytes) {
      high = midpoint;
    } else {
      low = midpoint + 1;
    }
  }

  let start = low;
  const first = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (
    first >= 0xdc00 &&
    first <= 0xdfff &&
    previous >= 0xd800 &&
    previous <= 0xdbff
  ) {
    start += 1;
  }
  return text.slice(start);
}

export function serializeHandoffTranscript(
  entries: readonly SessionEntry[],
  maxBytes = HANDOFF_TRANSCRIPT_MAX_BYTES,
) {
  const transcript = activeContextEntries(entries)
    .map(serializeEntry)
    .filter(Boolean)
    .join("\n\n---\n\n");
  if (!transcript) return "";

  const byteLimit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(transcript, "utf8") <= byteLimit) return transcript;

  const marker = `${OLDER_CONTEXT_MARKER}\n\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (byteLimit <= markerBytes)
    return utf8Suffix(OLDER_CONTEXT_MARKER, byteLimit);

  return `${marker}${utf8Suffix(transcript, byteLimit - markerBytes)}`;
}
