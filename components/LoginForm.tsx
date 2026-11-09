"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import { rootPath } from "@/lib/base-path";

/** Why a Google sign-in was refused, by the error code it came back with. */
const GOOGLE_REFUSALS: Record<string, string> = {
  GoogleArchived:
    "The Dewey account for this Google email has been archived. Ask your admin to restore it, or to remove this email from it so you can sign up again.",
  GoogleDuplicate:
    "More than one Dewey account uses this Google email, so Dewey can't tell which one to sign in to. Ask your admin to remove the email from the extra account.",
  GoogleDomain:
    "Dewey isn't set up for your email's domain yet. Sign in with your school or district email, or ask your admin to add your district.",
  GoogleUnverified:
    "Google hasn't verified this account's email address, so Dewey can't use it to sign in. Verify it with Google, or use another account.",
  AccessDenied: "That Google account can't sign in to Dewey. Ask your admin for help.",
};

/**
 * NextAuth's own error codes for a Google sign-in that failed partway, rather
 * than one Dewey refused. These usually mean the server couldn't reach Google or
 * hit an error of its own, so trying again (or the password form) can work.
 */
const GOOGLE_FAILURES: Record<string, string> = {
  OAuthSignin: "Dewey couldn't start signing you in with Google. This is usually a brief network problem, so please try again in a moment.",
  OAuthCallback: "Google signed you in, but Dewey couldn't reach Google to finish. This is usually a brief network problem, so please try again in a moment.",
  Callback: "Google signed you in, but Dewey hit a problem loading your account. Please try again; if it keeps happening, tell your admin.",
  Configuration: "Google sign-in isn't set up correctly on the server. Tell your admin, and use your username and password for now.",
};

export function LoginForm({ googleEnabled = false }: { googleEnabled?: boolean }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // With Google available, username/password stays collapsed until asked for.
  const [showPassword, setShowPassword] = useState(!googleEnabled);

  // Surface an OAuth failure redirected back as ?error=. The Google* codes come
  // from the signIn callback in lib/auth.ts.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("error");
    if (!code) return;
    if (code in GOOGLE_REFUSALS) {
      setError(GOOGLE_REFUSALS[code]);
    } else {
      // Include the code so an admin can match it to the server log.
      setError(
        GOOGLE_FAILURES[code] ??
          `Couldn't sign in with Google (${code}). Please try again or use your username and password.`
      );
      setShowPassword(true);
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const result = await signIn("dewey", {
        username: username.trim(),
        password,
        redirect: false,
      });
      if (result?.ok) {
        // Let the dispatcher route by role.
        window.location.href = rootPath;
        return;
      }
      setError("Incorrect username or password.");
    } catch {
      setError("Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-dewey-border bg-dewey-surface/60 p-6 text-left space-y-4">
      {error && <p className="text-sm text-red-600">{error}</p>}

      {googleEnabled && (
        <>
          <button
            type="button"
            onClick={() => signIn("google", { callbackUrl: rootPath })}
            className="flex w-full items-center justify-center gap-2 rounded-full border border-dewey-border bg-white px-4 py-3 text-base font-medium text-[#3c4043] shadow-sm hover:bg-gray-50"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
              <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
              <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
              <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
              <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
            </svg>
            Sign in with Google
          </button>
          <button
            type="button"
            onClick={() => setShowPassword((open) => !open)}
            aria-expanded={showPassword}
            aria-controls="password-sign-in"
            className="w-full text-center text-sm text-dewey-mute underline-offset-2 hover:underline"
          >
            {showPassword ? "Hide username and password" : "Use username and password instead"}
          </button>
        </>
      )}

      {showPassword && (
        <form id="password-sign-in" onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="dewey-label">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoComplete="username"
              className="dewey-input"
            />
          </div>
          <div>
            <label htmlFor="password" className="dewey-label">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="dewey-input"
            />
          </div>
          <button type="submit" disabled={loading} className="dewey-btn-primary">
            <span aria-hidden>🔑</span> {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      )}
    </div>
  );
}
