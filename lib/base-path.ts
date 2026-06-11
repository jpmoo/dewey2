/**
 * Base path when the app is served under a sub-path (e.g. /dewey behind a
 * reverse proxy). Set NEXT_PUBLIC_BASE_PATH to match. Used for raw fetch URLs,
 * browser navigations, and sign-out links — anywhere Next.js doesn't already
 * prepend the base path automatically (it does so for <Link> and redirect()).
 */
const BASE =
  (typeof process !== "undefined" && process.env.NEXT_PUBLIC_BASE_PATH) || "";

export const basePath = BASE.replace(/\/$/, "");

/** Prepend the base path to an absolute app path (e.g. "/api/foo" -> "/dewey/api/foo"). */
export function pathWithBase(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return basePath ? `${basePath}${p}` : p;
}

/** Root path for browser navigations and callback URLs (e.g. "/dewey/" or "/"). */
export const rootPath = basePath ? `${basePath}/` : "/";
