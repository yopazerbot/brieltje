/**
 * A dart board's face, drawn once into a square canvas (furnishing.ts: the 'dartboard' extra, on a disc
 * 45 cm across). The standard board: twenty segments in black and cream, the doubles and trebles in red
 * and green, the green outer bull and the red bull, thin silver wire, and the numbers 1 to 20 on the
 * black ring outside the doubles. Sizes in millimetres, as on a real board; no maker's mark.
 */
const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]; // clockwise from the top
const R = 225.5; // the board's radius, the canvas's half width
const BULL = 6.35;
const OUTER_BULL = 15.9;
const TREBLE = [99, 107];
const DOUBLE = [162, 170];

export function drawDartboard(g: CanvasRenderingContext2D): void {
  const size = g.canvas.width;
  const c = size / 2;
  const k = c / R; // pixels per millimetre
  const sector = Math.PI / 10;
  g.fillStyle = '#151515';
  g.fillRect(0, 0, size, size);
  // A faint grain on the black ring (seeded, the same every time).
  let s = 20261116;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 900; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.25)';
    g.fillRect(rnd() * size, rnd() * size, 2, 2);
  }
  const ring = (r0: number, r1: number, a0: number, a1: number, color: string) => {
    g.beginPath();
    g.arc(c, c, r1 * k, a0, a1);
    g.arc(c, c, r0 * k, a1, a0, true);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  };
  ORDER.forEach((_, i) => {
    const a0 = -Math.PI / 2 + (i - 0.5) * sector;
    const a1 = a0 + sector;
    const single = i % 2 ? '#ecdfbf' : '#1c1c1c';
    const score = i % 2 ? '#1d8a4a' : '#c42a2c';
    ring(DOUBLE[0], DOUBLE[1], a0, a1, score);
    ring(TREBLE[1], DOUBLE[0], a0, a1, single);
    ring(TREBLE[0], TREBLE[1], a0, a1, score);
    ring(OUTER_BULL, TREBLE[0], a0, a1, single);
  });
  ring(BULL, OUTER_BULL, 0, Math.PI * 2, '#1d8a4a');
  ring(0, BULL, 0, Math.PI * 2, '#c42a2c');
  // The wire: a circle round every ring, a spoke between the segments.
  g.strokeStyle = '#c9ccd1';
  g.lineWidth = Math.max(1, size / 340);
  for (const r of [BULL, OUTER_BULL, TREBLE[0], TREBLE[1], DOUBLE[0], DOUBLE[1]]) {
    g.beginPath();
    g.arc(c, c, r * k, 0, Math.PI * 2);
    g.stroke();
  }
  for (let i = 0; i < 20; i++) {
    const a = -Math.PI / 2 + (i - 0.5) * sector;
    g.beginPath();
    g.moveTo(c + Math.cos(a) * OUTER_BULL * k, c + Math.sin(a) * OUTER_BULL * k);
    g.lineTo(c + Math.cos(a) * DOUBLE[1] * k, c + Math.sin(a) * DOUBLE[1] * k);
    g.stroke();
  }
  // The numbers, upright, in the middle of the black ring.
  g.fillStyle = '#eef0f2';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold ${Math.round(26 * k)}px Arial, Helvetica, sans-serif`;
  const mid = (DOUBLE[1] + R) / 2;
  ORDER.forEach((n, i) => {
    const a = -Math.PI / 2 + i * sector;
    g.fillText(String(n), c + Math.cos(a) * mid * k, c + Math.sin(a) * mid * k + 1);
  });
}
