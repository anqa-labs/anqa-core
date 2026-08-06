"use client";

import { useEffect } from "react";

export function LandingMotion() {
  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const revealItems = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));

    if (reducedMotion) {
      revealItems.forEach((item) => item.classList.add("is-visible"));
      return;
    }

    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
    );

    revealItems.forEach((item) => revealObserver.observe(item));

    const progress = document.querySelector<HTMLElement>("[data-scroll-progress]");
    const parallaxItems = Array.from(document.querySelectorAll<HTMLElement>("[data-parallax]"));
    let animationFrame = 0;

    const updateScrollMotion = () => {
      animationFrame = 0;
      const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
      const scrollProgress = maxScroll > 0 ? window.scrollY / maxScroll : 0;
      progress?.style.setProperty("--scroll-progress", String(scrollProgress));

      parallaxItems.forEach((item) => {
        const speed = Number(item.dataset.parallax ?? 0.04);
        const rect = item.getBoundingClientRect();
        const distanceFromCenter = rect.top + rect.height / 2 - window.innerHeight / 2;
        const offset = Math.max(-34, Math.min(34, distanceFromCenter * -speed));
        item.style.setProperty("--parallax-y", `${offset}px`);
      });
    };

    const requestScrollUpdate = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(updateScrollMotion);
    };

    window.addEventListener("scroll", requestScrollUpdate, { passive: true });
    window.addEventListener("resize", requestScrollUpdate);
    updateScrollMotion();

    const cleanupTilt: Array<() => void> = [];
    document.querySelectorAll<HTMLElement>("[data-tilt]").forEach((item) => {
      const onPointerMove = (event: PointerEvent) => {
        const rect = item.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        item.style.setProperty("--tilt-x", `${(0.5 - y) * 5}deg`);
        item.style.setProperty("--tilt-y", `${(x - 0.5) * 6}deg`);
        item.style.setProperty("--shine-x", `${x * 100}%`);
        item.style.setProperty("--shine-y", `${y * 100}%`);
        item.classList.add("is-tilting");
      };
      const onPointerLeave = () => {
        item.style.setProperty("--tilt-x", "0deg");
        item.style.setProperty("--tilt-y", "0deg");
        item.classList.remove("is-tilting");
      };

      item.addEventListener("pointermove", onPointerMove);
      item.addEventListener("pointerleave", onPointerLeave);
      cleanupTilt.push(() => {
        item.removeEventListener("pointermove", onPointerMove);
        item.removeEventListener("pointerleave", onPointerLeave);
      });
    });

    const hero = document.querySelector<HTMLElement>("[data-hero]");
    const pointerGlow = document.querySelector<HTMLElement>("[data-pointer-glow]");
    const onHeroPointerMove = (event: PointerEvent) => {
      if (!hero || !pointerGlow) return;
      const rect = hero.getBoundingClientRect();
      pointerGlow.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
      pointerGlow.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
      pointerGlow.classList.add("is-active");
    };
    const onHeroPointerLeave = () => pointerGlow?.classList.remove("is-active");

    hero?.addEventListener("pointermove", onHeroPointerMove);
    hero?.addEventListener("pointerleave", onHeroPointerLeave);

    return () => {
      revealObserver.disconnect();
      window.removeEventListener("scroll", requestScrollUpdate);
      window.removeEventListener("resize", requestScrollUpdate);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      cleanupTilt.forEach((cleanup) => cleanup());
      hero?.removeEventListener("pointermove", onHeroPointerMove);
      hero?.removeEventListener("pointerleave", onHeroPointerLeave);
    };
  }, []);

  return <div className="landing-scroll-progress" data-scroll-progress aria-hidden="true" />;
}
