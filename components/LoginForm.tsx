"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { rootPath } from "@/lib/base-path";

export function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

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
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-dewey-border bg-white/60 p-6 text-left space-y-4"
    >
      {error && <p className="text-sm text-red-600">{error}</p>}
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
        {loading ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
