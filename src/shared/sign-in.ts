export const SIGN_IN_PROVIDERS = ["github", "oidc"] as const;

/** A way this deployment signs people in, as GET /api/auth/methods lists it. */
export type SignInMethod = { id: (typeof SIGN_IN_PROVIDERS)[number]; name: string };
