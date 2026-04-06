import type { ChatMessage, ProposedPlan, Thread } from "./types";

const CONTEXT_PORT_PROMPT_MAX_CHARS = 90_000;
const CONTEXT_PORT_HEADER = [
  "You are continuing an existing coding conversation in a new session.",
  "Treat the transcript below as the authoritative prior context and continue from it.",
  "Preserve the user's goals, constraints, and any unresolved work.",
  "If earlier context was omitted for space, prioritize the most recent messages that remain below.",
].join("\n");

function formatAttachmentSummary(message: Pick<ChatMessage, "attachments">): string | null {
  const attachments = message.attachments ?? [];
  if (attachments.length === 0) {
    return null;
  }
  return attachments
    .map(
      (attachment) =>
        `- ${attachment.name} (${attachment.mimeType}, ${Math.max(1, Math.round(attachment.sizeBytes / 1024))} KB)`,
    )
    .join("\n");
}

function formatTranscriptMessage(message: ChatMessage): string {
  const role =
    message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
  const attachmentSummary = formatAttachmentSummary(message);
  return [
    `${role}:`,
    message.text.trim().length > 0 ? message.text.trim() : "[No text content]",
    attachmentSummary ? `Attachments:\n${attachmentSummary}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("\n");
}

function formatLatestPlan(proposedPlan: ProposedPlan | null): string | null {
  if (!proposedPlan) {
    return null;
  }
  return ["Latest active plan:", proposedPlan.planMarkdown.trim()].join("\n");
}

export function buildContextPortPrompt(input: {
  thread: Pick<Thread, "title" | "modelSelection" | "messages" | "proposedPlans">;
  targetModelName: string;
}): string {
  const latestPlan =
    [...input.thread.proposedPlans]
      .filter((plan) => plan.implementedAt === null)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1) ?? null;

  const sections = [
    CONTEXT_PORT_HEADER,
    `Previous thread title: ${input.thread.title}`,
    `Previous model: ${input.thread.modelSelection.provider} / ${input.thread.modelSelection.model}`,
    `New model: ${input.targetModelName}`,
    formatLatestPlan(latestPlan),
  ].filter((part): part is string => part !== null);

  const transcriptBlocks = input.thread.messages.map(formatTranscriptMessage);
  let includedBlocks = transcriptBlocks;
  let omittedMessageCount = 0;
  let prompt = "";

  for (let startIndex = 0; startIndex < transcriptBlocks.length; startIndex += 1) {
    const candidateBlocks = transcriptBlocks.slice(startIndex);
    const candidateSections = [
      ...sections,
      startIndex > 0
        ? `Earlier context omitted to fit the new session: ${startIndex} message${startIndex === 1 ? "" : "s"}.`
        : null,
      "Conversation transcript:",
      candidateBlocks.join("\n\n"),
    ].filter((part): part is string => part !== null);
    const candidatePrompt = candidateSections.join("\n\n");
    if (
      candidatePrompt.length <= CONTEXT_PORT_PROMPT_MAX_CHARS ||
      startIndex === transcriptBlocks.length - 1
    ) {
      includedBlocks = candidateBlocks;
      omittedMessageCount = startIndex;
      prompt = candidatePrompt;
      break;
    }
  }

  if (prompt.length > 0) {
    return prompt;
  }

  return [
    ...sections,
    omittedMessageCount > 0
      ? `Earlier context omitted to fit the new session: ${omittedMessageCount} message${omittedMessageCount === 1 ? "" : "s"}.`
      : null,
    "Conversation transcript:",
    includedBlocks.join("\n\n"),
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}
