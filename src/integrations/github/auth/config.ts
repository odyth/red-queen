import { z } from "zod";

export const GitHubAuthConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("pat"),
    token: z.string().min(1),
  }),
  z.object({
    type: z.literal("byo-app"),
    appId: z.union([z.string().min(1), z.number()]).transform((v) => String(v)),
    installationId: z.union([z.string().min(1), z.number()]).transform((v) => String(v)),
    privateKeyPath: z.string().min(1),
  }),
]);

export type GitHubAuthConfig = z.infer<typeof GitHubAuthConfigSchema>;
