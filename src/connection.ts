import { z } from "zod";
import {
  acceptedSchema,
  orderSchema,
  readTokenSchema,
  unshieldRequestSchema,
  unshieldResultSchema,
} from "./schema";

// Only these operations can cross the partner/ShieldTX window boundary.

export const operationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("connect") }).strict(),
  z.object({ operation: z.literal("balance"), accountId: z.uuid() }).strict(),
  z.object({ operation: z.literal("open"), accountId: z.uuid(), order: orderSchema }).strict(),
  unshieldRequestSchema.extend({ operation: z.literal("unshield"), accountId: z.uuid() }).strict(),
  z.object({ operation: z.literal("withdrawals"), accountId: z.uuid() }).strict(),
]);

export type Operation = z.infer<typeof operationSchema>;

export const requestSchema = z
  .object({ type: z.literal("shieldtx:init"), requestId: z.uuid(), request: operationSchema })
  .strict();

export const controlSchema = z
  .object({ type: z.enum(["shieldtx:ready", "shieldtx:token-request"]), requestId: z.uuid() })
  .strict();

export const tokenSchema = z
  .object({
    type: z.literal("shieldtx:authorize"),
    requestId: z.uuid(),
    token: z.string().min(1).max(8192),
  })
  .strict();

export const completeSchema = z
  .object({ type: z.literal("shieldtx:complete"), requestId: z.uuid(), result: z.unknown() })
  .strict();

export const failureSchema = z
  .object({
    type: z.literal("shieldtx:error"),
    requestId: z.uuid(),
    message: z.string().min(1).max(300),
  })
  .strict();

/** Open from a user action; only the expected window and origin may complete the request. */
export function openShieldTxWindow(options: {
  origin: string;
  request: Operation;
  getAccessToken: () => Promise<string | null>;
  isCurrent: () => boolean;
  signal: AbortSignal;
}): Promise<unknown> {
  const origin = new URL(options.origin).origin;
  if (origin !== options.origin) throw new Error("Configure an exact ShieldTX origin");
  if (options.signal.aborted || !options.isCurrent())
    throw new Error("Sign in again before connecting");
  const requestId = crypto.randomUUID();
  const url = new URL(origin);
  url.searchParams.set("requestId", requestId);
  const popup = window.open(url.toString(), "shieldtx-" + requestId, "popup,width=520,height=740");
  if (!popup) throw new Error("Allow the ShieldTX popup and try again");
  return new Promise((resolve, reject) => {
    let initialized = false,
      finished = false,
      handingOff = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true;
      window.removeEventListener("message", receive);
      options.signal.removeEventListener("abort", abort);
      clearInterval(closed);
      clearTimeout(timeout);
      popup.close();
      if (error) reject(error);
      else resolve(value);
    };
    const abort = () => finish(new Error("Account changed or connection cancelled"));

    // Check origin, window identity and the request ID before accepting any message.
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== origin || event.source !== popup || !options.isCurrent()) return;
      const control = controlSchema.safeParse(event.data);
      if (control.success && control.data.requestId === requestId) {
        if (control.data.type === "shieldtx:ready") {
          if (!initialized) {
            initialized = true;
            popup.postMessage(
              { type: "shieldtx:init", requestId, request: options.request },
              origin,
            );
          }
        } else if (initialized && options.request.operation === "connect" && !handingOff) {
          handingOff = true;
          // The ShieldTX page requests this only after the user approves the connection.
          void options
            .getAccessToken()
            .then((token) => {
              if (finished) return;
              if (!token || !options.isCurrent() || options.signal.aborted)
                throw new Error("Sign in again before connecting");
              popup.postMessage({ type: "shieldtx:authorize", requestId, token }, origin);
            })
            .catch(() => finish(new Error("Could not authorize the current Stratium session")))
            .finally(() => {
              handingOff = false;
            });
        }
        return;
      }
      const failure = failureSchema.safeParse(event.data);
      if (failure.success && failure.data.requestId === requestId) {
        finish(new Error(failure.data.message));
        return;
      }
      const complete = completeSchema.safeParse(event.data);
      if (!initialized || !complete.success || complete.data.requestId !== requestId) return;
      const value = complete.data.result;
      const operation = options.request.operation;
      const result =
        operation === "connect"
          ? z.null().safeParse(value)
          : operation === "balance"
            ? z
                .string()
                .regex(/^\d+(?:\.\d+)?$/)
                .safeParse(value)
            : operation === "open"
              ? acceptedSchema.safeParse(value)
              : operation === "unshield"
                ? unshieldResultSchema.safeParse(value)
                : readTokenSchema.safeParse(value);
      if (!result.success) {
        finish(new Error("Invalid ShieldTX response"));
        return;
      }
      finish(undefined, result.data);
    };

    // Clean up on completion, account change, timeout or a manually closed popup.
    const closed = setInterval(() => {
      if (popup.closed) finish(new Error("ShieldTX popup closed before completion"));
    }, 500);
    const timeout = setTimeout(
      () => finish(new Error("ShieldTX approval timed out; try again")),
      10 * 60 * 1000,
    );
    options.signal.addEventListener("abort", abort, { once: true });
    window.addEventListener("message", receive);
  });
}
