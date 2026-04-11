/**
 * Post-effects (global, apply to all primitives)
 *
 * Owns the params + modulation metadata for the renderer's post-processing
 * passes that aren't the stock bloom. Modeled on the primitive contract
 * so the same `resolve()` + UI helpers work, but lives at the top level
 * since the effects are global rather than primitive-specific.
 *
 * Currently just the radial trails feedback pass (persistence + radial
 * push). Add more here as we grow the post-fx chain.
 */

export const params = {
  // 0 = off (pass-through). Practical range tops out around 0.97 —
  // higher than that the trails never fully decay.
  trailPersistence: 0.0,

  // Per-frame outward UV drift of the feedback sample. Small values
  // (0.002–0.01) produce a gentle "streaming toward viewer" drift;
  // larger values (0.03+) warp the trails outward aggressively into
  // tunnel / hyperspace territory.
  trailRadialPush: 0.004,
};

export const modulation = {
  trailPersistence: { source: '—', amount: 0.30, min: 0.00, max: 0.97, step: 0.005 },
  trailRadialPush:  { source: '—', amount: 0.02, min: 0.00, max: 0.10, step: 0.0005 },
};
