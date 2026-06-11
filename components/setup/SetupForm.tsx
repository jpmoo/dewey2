"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";

export function SetupForm() {
  const [username, setUsername] = useState("");
  const [fullName, setFullName] = useState("");
  const [nickname, setNickname] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords don’t match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          full_name: fullName.trim(),
          nickname: nickname.trim(),
          email: email.trim(),
          password,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Setup failed.");
        return;
      }
      const result = await signIn("dewey", {
        username: username.trim(),
        password,
        redirect: false,
      });
      if (result?.ok) {
        window.location.href = "/admin";
        return;
      }
      setError("Account created. Please sign in.");
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
        <label htmlFor="full_name" className="dewey-label">Full name</label>
        <input
          id="full_name"
          type="text"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          required
          className="dewey-input"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="nickname" className="dewey-label">
            Nickname <span className="text-dewey-mute font-normal">(optional)</span>
          </label>
          <input
            id="nickname"
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            className="dewey-input"
          />
        </div>
        <div>
          <label htmlFor="email" className="dewey-label">
            Email <span className="text-dewey-mute font-normal">(optional)</span>
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            className="dewey-input"
          />
        </div>
      </div>
      <div>
        <label htmlFor="password" className="dewey-label">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="dewey-input"
        />
      </div>
      <div>
        <label htmlFor="confirm" className="dewey-label">Confirm password</label>
        <input
          id="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          className="dewey-input"
        />
      </div>
      <button type="submit" disabled={loading} className="dewey-btn-primary">
        {loading ? "Creating…" : "Create admin account"}
      </button>
    </form>
  );
}
