import { describe, expect, it } from "vitest";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

import { buildContextPortPrompt } from "./threadContextTransfer";
import type { Thread } from "./types";

function createThread(overrides?: Partial<Thread>): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Fix session restart bug",
    modelSelection: {
      provider: "codex",
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-06T12:00:00.000Z",
    updatedAt: "2026-04-06T12:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

describe("buildContextPortPrompt", () => {
  it("includes the transcript and latest active plan", () => {
    const prompt = buildContextPortPrompt({
      thread: createThread({
        messages: [
          {
            id: MessageId.makeUnsafe("msg-1"),
            role: "user",
            text: "Please investigate the websocket reconnect bug.",
            createdAt: "2026-04-06T12:00:00.000Z",
            streaming: false,
            completedAt: "2026-04-06T12:00:00.000Z",
          },
          {
            id: MessageId.makeUnsafe("msg-2"),
            role: "assistant",
            text: "I traced it to stale session state after reconnect.",
            createdAt: "2026-04-06T12:01:00.000Z",
            streaming: false,
            completedAt: "2026-04-06T12:01:00.000Z",
            attachments: [
              {
                type: "image",
                id: "img-1",
                name: "error.png",
                mimeType: "image/png",
                sizeBytes: 4096,
              },
            ],
          },
        ],
        proposedPlans: [
          {
            id: "plan-1",
            turnId: null,
            planMarkdown: "1. Reproduce\n2. Fix reconnect resume\n3. Add tests",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-04-06T12:00:00.000Z",
            updatedAt: "2026-04-06T12:02:00.000Z",
          },
        ],
      }),
      targetModelName: "Claude Sonnet 4.6",
    });

    expect(prompt).toContain("Previous thread title: Fix session restart bug");
    expect(prompt).toContain("Latest active plan:");
    expect(prompt).toContain("User:");
    expect(prompt).toContain("Assistant:");
    expect(prompt).toContain("error.png (image/png, 4 KB)");
    expect(prompt).toContain("New model: Claude Sonnet 4.6");
  });

  it("drops oldest messages first when the transcript exceeds the cap", () => {
    const messages = Array.from({ length: 12 }, (_, index) => {
      const role: "user" | "assistant" = index % 2 === 0 ? "user" : "assistant";
      const timestamp = `2026-04-06T12:${String(index).padStart(2, "0")}:00.000Z`;
      return {
        id: MessageId.makeUnsafe(`msg-${index}`),
        role,
        text: `message-${index}-${"x".repeat(12_000)}`,
        createdAt: timestamp,
        streaming: false,
        completedAt: timestamp,
      };
    });

    const prompt = buildContextPortPrompt({
      thread: createThread({ messages }),
      targetModelName: "GPT-5.3 Codex",
    });

    expect(prompt).toContain("Earlier context omitted to fit the new session:");
    expect(prompt).not.toContain("message-0-");
    expect(prompt).toContain("message-11-");
  });
});
