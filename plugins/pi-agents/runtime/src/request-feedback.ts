import { z } from "zod";

export const WorkerExplanationSchema = z.string().min(1).refine(
  value => Buffer.byteLength(value, "utf8") <= 4096, "worker_explanation exceeds 4096 UTF-8 bytes")
  .describe("Optional worker-visible context for an exact permission denial only; at most 4096 UTF-8 bytes. Does not grant permission or change the assignment.");

export function validateWorkerExplanation(reply: unknown, explanation?: string): void {
  if (explanation === undefined) return;
  WorkerExplanationSchema.parse(explanation);
  if (reply !== "deny") throw new Error("worker_explanation is only valid for permission denial");
}
