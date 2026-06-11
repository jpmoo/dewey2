/** Shared route helpers so links/redirects stay consistent across the app. */

/** NextAuth's sign-out page; returns the user to the entry dispatcher. */
export function signOutPath(callbackUrl = "/"): string {
  return `/api/auth/signout?callbackUrl=${encodeURIComponent(callbackUrl)}`;
}
