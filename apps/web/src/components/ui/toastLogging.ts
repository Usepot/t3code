import { type NativeApi, type ServerLogToastInput, type ThreadId } from "@t3tools/contracts";

type ToastLogShape = {
  readonly position: string;
  readonly type?: string;
  readonly title: unknown;
  readonly description?: unknown;
  readonly threadId?: ThreadId | null;
  readonly stackTrace?: string;
};

function toLogString(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return `[non-text:${typeof value}]`;
}

export function captureToastStackTrace(): string {
  return new Error("Toast created").stack ?? "Stack trace unavailable.";
}

export function buildToastLogInput(input: ToastLogShape): ServerLogToastInput {
  return {
    createdAt: new Date().toISOString(),
    position: input.position,
    title: toLogString(input.title),
    ...(input.description !== undefined ? { description: toLogString(input.description) } : {}),
    ...(input.type ? { type: input.type } : {}),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    stackTrace: input.stackTrace?.trim() ? input.stackTrace : "Stack trace unavailable.",
  };
}

export async function logToastToServer(
  api: NativeApi | undefined,
  input: ToastLogShape,
): Promise<void> {
  if (!api) {
    return;
  }
  await api.server.logToast(buildToastLogInput(input));
}
