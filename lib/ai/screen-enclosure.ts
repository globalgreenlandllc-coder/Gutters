/**
 * Screened pool-enclosure (lanai / pool cage) detection.
 *
 * Florida problem: Google's ML building mask AND its Solar roof-plane
 * list both model screened pool cages as "roof" — the engine then wraps
 * priced gutter runs and downspouts around aluminum screen framing
 * (observed: 7207 39th Ln E, Sarasota — 3 of 3 houses on the tile have
 * their cages inside the building mask).
 *
 * The physically decisive cue: POOL WATER VISIBLE THROUGH THE SURFACE.
 * A real roof is opaque; an elevated surface (DSM reads the cage top,
 * ~3-5 m above grade) whose orthophoto pixels are saturated aquatic
 * blue is a screen you can see through. Measured on the Sarasota cage:
 * 47% of over-pool pixels are blue-dominant at 5 m above ground vs 0%
 * on the tile roof; 3×3 luminance spread runs ~2× roof levels (bright
 * frame grid over dark water). Height and DSM smoothness do NOT
 * separate cage from roof (cage tops read as smooth mid-height
 * surfaces), so everything grows from the water seed.
 *
 * Deliberately conservative — every gate errs toward "keep the roof":
 *   • no pool seed → no-op (shingle-country scans are untouched)
 *   • seed component must be FLAT (tarp on a pitched roof shows the
 *     roof's slope in the DSM and is refused)
 *   • growth never climbs above the cage top height band, never onto
 *     pixels matching the house's roof color, never into vegetation
 *   • the final region must carry see-through evidence (blue fraction
 *     or frame-grid luminance speckle) — a uniform opaque surface is
 *     refused even if blue
 *   • global brakes: veto ≤ 55% of the mask and ≥ 45 m² of mask left,
 *     else the whole veto is dropped
 */

export type EnclosureDetection = {
  /** Full-grid, 1 = screened-enclosure pixel to remove from the roof. */
  veto: Uint8Array;
  vetoPx: number;
  /** Vetoed area that was inside the building mask, m². */
  vetoMaskM2: number;
  /** Elevated pool-water seed area, m² (0 → detector was a no-op). */
  poolSeedM2: number;
};

export function detectScreenEnclosures(args: {
  mask: Uint8Array;
  dsm: Float32Array;
  dsmNoData: number;
  rgb: Uint8Array;
  width: number;
  height: number;
  metersPerPixel: number;
  groundHeightM: number;
}): EnclosureDetection {
  const { mask, dsm, dsmNoData, rgb, width, height, metersPerPixel, groundHeightM } =
    args;
  const m2PerPx = metersPerPixel * metersPerPixel;
  const empty = (): EnclosureDetection => ({
    veto: new Uint8Array(width * height),
    vetoPx: 0,
    vetoMaskM2: 0,
    poolSeedM2: 0,
  });

  const validH = (v: number) =>
    Number.isFinite(v) && Math.abs(v - dsmNoData) > 0.001 && v > -450 && v < 9000;
  const isGreen = (i: number) => {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    return g > r + 6 && g > b + 6;
  };
  // Aquatic teal: water absorbs RED, so both green and blue sit well
  // above red. This is the separator that matters — shadowed gray
  // shingle also reads "blue" (sky-scatter lifts b) but its green stays
  // pinned to red (measured on Lake Stevens false seeds: g−r ≈ 3-13 vs
  // g−r ≈ 19-25 for pool water seen through the Sarasota cage mesh).
  // A plain b−r threshold cannot separate the two; red-depletion can.
  const isPoolBlue = (i: number) => {
    const r = rgb[i * 3];
    const g = rgb[i * 3 + 1];
    const b = rgb[i * 3 + 2];
    return g > r + 14 && b > r + 14 && b > 50;
  };

  // Local 3×3 DSM range — the codebase's canonical tree-crown test.
  // A cage top over still water is glassy-smooth (measured p50 0.07 m
  // on the Sarasota cage); canopy crowns jump ≥0.5 m pixel to pixel.
  const roughAt = (i: number): number => {
    const x = i % width;
    const y = (i - x) / width;
    if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return Infinity;
    let lo = Infinity;
    let hi = -Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const v = dsm[(y + dy) * width + (x + dx)];
        if (!validH(v)) return Infinity;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    return hi - lo;
  };

  // ---- 1. Elevated pool-water seeds (inside the mask) ----------------
  // Height ceiling: a lanai top sits 2.5-4.5 m above grade; dark-teal
  // conifer canopy the mask annexed sits at main-roof height (the Lake
  // Stevens false fire: teal shadowed crowns at 6-8 m). Roughness kills
  // the crowns the ceiling doesn't.
  const seed = new Uint8Array(width * height);
  let seedCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0 || !isPoolBlue(i)) continue;
    const h = dsm[i];
    if (!validH(h)) continue;
    const above = h - groundHeightM;
    if (above < 1.5 || above > 6.5) continue;
    if (roughAt(i) > 0.35) continue;
    seed[i] = 1;
    seedCount++;
  }
  if (seedCount * m2PerPx < 1.5) return empty();

  // ---- 2. Component the seeds; keep flat components ≥ 6 m² -----------
  // The size floor is load-bearing: a pool seen through mesh is ONE
  // large contiguous teal blob; the false-positive fields (shadowed
  // conifer crowns, a neighbor's shade canopy, teal shade cloth) arrive
  // as scattered ≤ 3 m² patches (observed on Lake Stevens: 16 m² of
  // seeds spread across the whole tile, no component ≥ 6 m²).
  // Flatness kills the blue-tarp-on-a-pitched-roof case: a tarp drapes
  // the roof slope, so its DSM heights spread ≥ 1 m; a cage top is a
  // near-level surface (measured IQR 0.6 m across a 7 m pool).
  const comp = new Int32Array(width * height).fill(-1);
  const keptSeedIdx: number[] = [];
  const seedHeights: number[] = [];
  let nComp = 0;
  for (let s = 0; s < seed.length; s++) {
    if (seed[s] === 0 || comp[s] !== -1) continue;
    const queue = [s];
    comp[s] = nComp;
    let head = 0;
    const members: number[] = [];
    while (head < queue.length) {
      const idx = queue[head++];
      members.push(idx);
      const x = idx % width;
      const y = (idx - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          if (seed[ni] === 1 && comp[ni] === -1) {
            comp[ni] = nComp;
            queue.push(ni);
          }
        }
      }
    }
    nComp++;
    if (process.env.SOLAR_CAGE_DEBUG && members.length * m2PerPx >= 0.5) {
      // eslint-disable-next-line no-console
      console.error(
        `[cage-seed-comp] ${(members.length * m2PerPx).toFixed(1)} m² @(${members[0] % width},${Math.floor(members[0] / width)})`,
      );
    }
    if (members.length * m2PerPx < 6) continue;
    const hs = members.map((i) => dsm[i]).filter(validH).sort((a, b) => a - b);
    if (hs.length < 4) continue;
    const iqr = hs[Math.floor(hs.length * 0.75)] - hs[Math.floor(hs.length * 0.25)];
    if (iqr > 0.9) continue;
    keptSeedIdx.push(...members);
    seedHeights.push(...hs);
  }
  if (keptSeedIdx.length * m2PerPx < 1.5) return empty();
  seedHeights.sort((a, b) => a - b);
  const poolSeedM2 = Math.round(keptSeedIdx.length * m2PerPx);
  // Cage-top ceiling: growth may not climb meaningfully above the
  // surface the water is seen through.
  const capAbs = seedHeights[Math.floor(seedHeights.length * 0.9)] + 0.8;

  // ---- 3. House-roof color palette (median RGB above the cage top) ---
  // Real roof high above the cage tells us what "roof-colored" means
  // here; growth refuses pixels matching it, so the veto stops at the
  // house wall even where a low roof section sits at cage height.
  let palette: [number, number, number] | null = null;
  {
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) continue;
      const h = dsm[i];
      if (!validH(h) || h < capAbs + 0.7) continue;
      rs.push(rgb[i * 3]);
      gs.push(rgb[i * 3 + 1]);
      bs.push(rgb[i * 3 + 2]);
    }
    if (rs.length >= 400) {
      const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
      palette = [med(rs), med(gs), med(bs)];
    }
  }
  const roofColored = (i: number) => {
    if (!palette) return false;
    return (
      Math.abs(rgb[i * 3] - palette[0]) +
        Math.abs(rgb[i * 3 + 1] - palette[1]) +
        Math.abs(rgb[i * 3 + 2] - palette[2]) <
      60
    );
  };

  // Growth stays near the building: padded mask bbox.
  let bx0 = width;
  let by0 = height;
  let bx1 = 0;
  let by1 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] > 0) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  const padPx = Math.round(2 / metersPerPixel);
  bx0 = Math.max(1, bx0 - padPx);
  by0 = Math.max(1, by0 - padPx);
  bx1 = Math.min(width - 2, bx1 + padPx);
  by1 = Math.min(height - 2, by1 + padPx);

  // ---- 4. Grow the enclosure out from the water seeds ----------------
  const veto = new Uint8Array(width * height);
  for (const i of keptSeedIdx) veto[i] = 1;
  let frontier = keptSeedIdx.slice();
  const maxSteps = Math.round(20 / metersPerPixel);
  const growCapPx = Math.round(250 / m2PerPx);
  let grown = 0;
  for (let step = 0; step < maxSteps && frontier.length > 0; step++) {
    const next: number[] = [];
    for (const idx of frontier) {
      const x = idx % width;
      const y = (idx - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < bx0 || ny < by0 || nx > bx1 || ny > by1) continue;
          const ni = ny * width + nx;
          if (veto[ni] === 1 || isGreen(ni)) continue;
          const h = dsm[ni];
          if (!validH(h)) continue;
          if (h > capAbs || h - groundHeightM < 1.2) continue;
          if (roofColored(ni)) continue;
          // Cage surfaces stay smooth right up to the frame steps;
          // canopy is rough everywhere. Slightly looser than the seed
          // gate so growth crosses the frame beams.
          if (roughAt(ni) > 0.6) continue;
          veto[ni] = 1;
          grown++;
          next.push(ni);
        }
      }
    }
    if (grown > growCapPx) break;
    frontier = next;
  }

  // ---- 5. See-through evidence over the whole region -----------------
  // A cage shows aquatic blue where the pool is (10-50% of the region —
  // the rest is deck/frame seen through mesh) plus high-contrast frame
  // speckle (bright grid over the dark interior; measured 36% on the
  // Sarasota cage). Requiring speckle AND a bounded blue fraction
  // protects opaque-but-blue real roofs (blue standing-seam metal):
  // uniform color → near-total blue, no frame grid → refused. A tarp
  // fails the same way. Worst case on blurry imagery the detector
  // no-ops and the cage stays priced — the status quo, never a lost
  // real roof.
  {
    let n = 0;
    let blue = 0;
    let speckle = 0;
    for (let y = Math.max(1, by0); y <= Math.min(height - 2, by1); y++) {
      for (let x = Math.max(1, bx0); x <= Math.min(width - 2, bx1); x++) {
        const i = y * width + x;
        if (veto[i] === 0) continue;
        n++;
        if (isPoolBlue(i)) blue++;
        let lLo = 255;
        let lHi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const j = (y + dy) * width + (x + dx);
            const lum = (rgb[j * 3] + rgb[j * 3 + 1] + rgb[j * 3 + 2]) / 3;
            if (lum < lLo) lLo = lum;
            if (lum > lHi) lHi = lum;
          }
        }
        if (lHi - lLo >= 45) speckle++;
      }
    }
    if (process.env.SOLAR_CAGE_DEBUG) {
      let sx0 = width;
      let sy0 = height;
      let sx1 = 0;
      let sy1 = 0;
      for (const i of keptSeedIdx) {
        const x = i % width;
        const y = (i - x) / width;
        if (x < sx0) sx0 = x;
        if (x > sx1) sx1 = x;
        if (y < sy0) sy0 = y;
        if (y > sy1) sy1 = y;
      }
      // eslint-disable-next-line no-console
      console.error(
        `[cage] seeds=${poolSeedM2} m² @(${sx0},${sy0})-(${sx1},${sy1}) region=${Math.round(n * m2PerPx)} m² blue=${((100 * blue) / Math.max(1, n)).toFixed(0)}% speckle=${((100 * speckle) / Math.max(1, n)).toFixed(0)}% capAbs=${capAbs.toFixed(1)} palette=${palette ? palette.join(",") : "none"}`,
      );
    }
    if (
      n === 0 ||
      blue / n < 0.06 ||
      blue / n > 0.8 ||
      speckle / n < 0.15
    ) {
      return empty();
    }
  }

  // ---- 6. Global safety brakes ---------------------------------------
  let maskPx = 0;
  let vetoInMask = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] > 0) {
      maskPx++;
      if (veto[i] === 1) vetoInMask++;
    }
  }
  if (
    vetoInMask > maskPx * 0.55 ||
    (maskPx - vetoInMask) * m2PerPx < 45
  ) {
    return empty();
  }

  let vetoPx = 0;
  for (let i = 0; i < veto.length; i++) vetoPx += veto[i];
  return {
    veto,
    vetoPx,
    vetoMaskM2: Math.round(vetoInMask * m2PerPx),
    poolSeedM2,
  };
}
