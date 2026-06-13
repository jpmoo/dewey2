"use client";

import { useEffect, useRef } from "react";

/**
 * A short canvas fireworks burst that overlays its (relative) parent, then
 * removes itself via onDone. `big` makes it longer and denser — used when a
 * whole plan is finished. Purely decorative (pointer-events: none).
 */
export function Fireworks({ big = false, onDone }: { big?: boolean; onDone: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = 0;
    let h = 0;
    const resize = () => {
      w = parent.clientWidth;
      h = parent.clientHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const colors = ["#ff5252", "#ffb142", "#ffe066", "#2ed573", "#1e90ff", "#a55eea", "#ff6b9d"];
    type P = {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      max: number;
      color: string;
      size: number;
    };
    const particles: P[] = [];

    const burst = (cx: number, cy: number, count: number, power: number) => {
      const base = colors[Math.floor(Math.random() * colors.length)];
      for (let i = 0; i < count; i++) {
        const a = (Math.PI * 2 * i) / count + Math.random() * 0.4;
        const sp = power * (0.35 + Math.random() * 0.85);
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp,
          life: 0,
          max: 45 + Math.random() * 35,
          color: Math.random() < 0.25 ? colors[Math.floor(Math.random() * colors.length)] : base,
          size: 1.5 + Math.random() * 2,
        });
      }
    };

    const duration = big ? 3600 : 1700;
    const interval = big ? 230 : 320;
    const start = performance.now();
    let lastBurst = 0;
    let raf = 0;

    const fireRound = (now: number) => {
      const cx = w * (0.2 + Math.random() * 0.6);
      const cy = h * (0.18 + Math.random() * 0.45);
      const count = big ? 50 + Math.floor(Math.random() * 30) : 34 + Math.floor(Math.random() * 16);
      const power = big ? 6.5 : 5;
      burst(cx, cy, count, power);
      if (big && Math.random() < 0.6) {
        burst(w * (0.2 + Math.random() * 0.6), h * (0.18 + Math.random() * 0.45), count, power);
      }
      lastBurst = now;
    };

    // Kick off immediately so the celebration reads instantly.
    fireRound(start);

    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed < duration && now - lastBurst >= interval) fireRound(now);

      ctx.clearRect(0, 0, w, h);
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life += 1;
        p.vy += 0.045; // gravity
        p.vx *= 0.99;
        p.vy *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        const alpha = Math.max(0, 1 - p.life / p.max);
        if (alpha <= 0) {
          particles.splice(i, 1);
          continue;
        }
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      if (elapsed < duration || particles.length > 0) {
        raf = requestAnimationFrame(tick);
      } else {
        doneRef.current();
      }
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [big]);

  return (
    <canvas
      ref={ref}
      className="pointer-events-none absolute inset-0 z-30 h-full w-full"
      aria-hidden
    />
  );
}
