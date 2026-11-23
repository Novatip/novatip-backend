import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

export const MAX_CREATOR_SPLITS = 50;

export const CreatorSplitsSchema = z
  .array(
    z.object({
      to: z
        .string()
        .refine((address) => StrKey.isValidEd25519PublicKey(address), {
          message: "Must be a valid Stellar account address.",
        }),
      bps: z.number().int().min(1).max(10_000),
    }),
  )
  .max(MAX_CREATOR_SPLITS, {
    message: `A creator may not configure more than ${MAX_CREATOR_SPLITS} splits.`,
  })
  .superRefine((splits, context) => {
    const recipients = new Set<string>();
    let totalBps = 0;

    splits.forEach((split, index) => {
      if (recipients.has(split.to)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Each recipient may appear only once.",
          path: [index, "to"],
        });
      }
      recipients.add(split.to);
      totalBps += split.bps;
    });

    if (totalBps > 10_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "The total basis points must not exceed 10000.",
        path: [],
      });
    }
  });
