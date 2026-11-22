// A small symmetric pixel character per lead, stable for its seed.
// Recognisable at 18px without a label, like the leads in the sidebar.

const PALETTES = [
  ["#F6E7D8", "#C2653A", "#3A2418"],
  ["#E3ECF7", "#3F6FB5", "#1B2A44"],
  ["#E6F2E4", "#3E8E5A", "#1D3324"],
  ["#F4E4EE", "#B24C86", "#3B1830"],
  ["#F3EED9", "#B58A1E", "#3A2E0C"],
  ["#E8E6F7", "#6553C4", "#221C47"],
  ["#E2F1F1", "#2E8C8C", "#123434"],
  ["#F6E2DF", "#C24A3E", "#3F1712"],
];

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<number, { cells: [number, number, number][]; bg: string }>();

function sprite(seed: number) {
  const hit = cache.get(seed);
  if (hit) return hit;
  const r = rng(seed);
  const [bg, fg, dark] = PALETTES[Math.floor(r() * PALETTES.length)];
  const cells: [number, number, number][] = [];
  // Head rows 1-6, columns 1-3 mirrored onto 4-6; eyes always on row 3.
  for (let y = 1; y < 7; y++) {
    for (let x = 1; x < 4; x++) {
      const edge = x === 1 && (y === 1 || y === 6);
      const on = y === 3 && x === 2 ? 2 : !edge && (x > 1 || r() > 0.35) && (y < 6 || r() > 0.4) ? 1 : 0;
      if (on) {
        cells.push([x, y, on], [7 - x, y, on]);
      }
    }
  }
  // Something on top: hair, antenna or a hat.
  const top = Math.floor(r() * 3);
  if (top === 0) cells.push([3, 0, 2], [4, 0, 2]);
  if (top === 1) cells.push([2, 0, 1], [5, 0, 1]);
  const out = { cells: cells.map(([x, y, k]) => [x, y, k] as [number, number, number]), bg: bg + "|" + fg + "|" + dark };
  cache.set(seed, out);
  return out;
}

export function PixelAvatar({ seed, size = 18 }: { seed: number; size?: number }) {
  const { cells, bg } = sprite(seed);
  const [back, fg, dark] = bg.split("|");
  return (
    <svg className="pixel-avatar" width={size} height={size} viewBox="0 0 8 8" shapeRendering="crispEdges" aria-hidden>
      <rect width="8" height="8" fill={back} />
      {cells.map(([x, y, k], i) => (
        <rect key={i} x={x} y={y} width="1" height="1" fill={k === 2 ? dark : fg} />
      ))}
    </svg>
  );
}
