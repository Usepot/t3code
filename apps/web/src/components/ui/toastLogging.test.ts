import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import { buildToastLogInput } from "./toastLogging";

describe("buildToastLogInput", () => {
  it("serializes top-toast fields and preserves the full stack trace", () => {
    const logEntry = buildToastLogInput({
      position: "top-right",
      type: "error",
      title: "Provider failed",
      description: "Missing token",
      threadId: ThreadId.makeUnsafe("thread-1"),
      stackTrace: "Error: Toast created\n    at one\n    at two",
    });

    assert.equal(logEntry.position, "top-right");
    assert.equal(logEntry.type, "error");
    assert.equal(logEntry.title, "Provider failed");
    assert.equal(logEntry.description, "Missing token");
    assert.equal(logEntry.threadId, "thread-1");
    assert.equal(logEntry.stackTrace, "Error: Toast created\n    at one\n    at two");
  });

  it("falls back for non-string toast content", () => {
    const logEntry = buildToastLogInput({
      position: "top-right",
      title: { rich: true },
      description: undefined,
      stackTrace: "",
    });

    assert.equal(logEntry.title, "[non-text:object]");
    assert.equal(logEntry.stackTrace, "Stack trace unavailable.");
  });
});
