/**
 * The picture through a scope (the sniper rifle's, or one found in Zombies): the black tube round a
 * round lens, a fine reticle with range marks, and a dark edge that creeps in from one side when you
 * turn or fire, as when your eye is off a real scope's line for a moment. The whole picture drifts
 * with your breath (weapon.ts moves the shot with it), and a small bar shows the breath you hold.
 *
 * Built once from plain elements; each frame only moves them (transforms), so nothing is repainted.
 * The styles are in style.css (#scope).
 */

const NS = 'http://www.w3.org/2000/svg';

export interface ScopePicture {
  /** Where the reticle is, in half view heights (right and up positive) */
  x: number;
  y: number;
  /** How far the dark edge has crept in, in half view heights */
  shadeX: number;
  shadeY: number;
  /** The breath left, 0..1, and being out of it */
  breath: number;
  winded: boolean;
}

/** The reticle, in a square from -100 to 100 (the lens's edge): thick posts outside, fine lines with marks inside. */
function reticle(): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '-100 -100 200 200');
  svg.setAttribute('class', 'reticle');
  const line = (x1: number, y1: number, x2: number, y2: number, width: number) => {
    const l = document.createElementNS(NS, 'line');
    l.setAttribute('x1', `${x1}`);
    l.setAttribute('y1', `${y1}`);
    l.setAttribute('x2', `${x2}`);
    l.setAttribute('y2', `${y2}`);
    l.setAttribute('stroke-width', `${width}`);
    svg.appendChild(l);
  };
  const FINE = 0.32;
  const POST = 1.5;
  const IN = 38; // where the posts end and the fine lines begin
  const GAP = 1.4; // open round the middle, so the target stays in sight
  // Left, right and below: a post, then a fine line. Above: a fine line only, the view stays open.
  line(-100, 0, -IN, 0, POST);
  line(IN, 0, 100, 0, POST);
  line(0, IN, 0, 100, POST);
  line(-IN, 0, -GAP, 0, FINE);
  line(GAP, 0, IN, 0, FINE);
  line(0, GAP, 0, IN, FINE);
  line(0, -100, 0, -GAP, FINE);
  // Marks along the fine lines, every second one longer.
  for (let k = 1; k <= 5; k++) {
    const d = k * 6;
    const half = k % 2 ? 1 : 1.9;
    line(-d, -half, -d, half, FINE);
    line(d, -half, d, half, FINE);
    line(-half, d, half, d, FINE);
    line(-half, -d, half, -d, FINE);
  }
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('r', '0.38');
  svg.appendChild(dot);
  return svg;
}

export class ScopeView {
  private root = document.getElementById('scope')!;
  private sight = document.createElement('div');
  private shade = document.createElement('div');
  private bar = document.createElement('div');
  private fill = document.createElement('i');
  private on = false;

  constructor() {
    this.sight.className = 'sight';
    const tube = document.createElement('div');
    tube.className = 'tube';
    this.sight.append(tube, reticle());
    this.shade.className = 'shade';
    this.bar.className = 'breath';
    this.bar.appendChild(this.fill);
    this.root.append(this.shade, this.sight, this.bar);
  }

  set(on: boolean, v?: ScopePicture): void {
    if (on !== this.on) {
      this.on = on;
      this.root.classList.toggle('show', on);
    }
    if (!on || !v) return;
    const half = window.innerHeight / 2;
    const x = v.x * half;
    const y = -v.y * half;
    this.sight.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    // The dark edge: never so far in that it covers the middle.
    const clamp = (n: number) => Math.max(-0.16, Math.min(0.16, n));
    this.shade.style.transform = `translate(${(x + clamp(v.shadeX) * half).toFixed(1)}px, ${(y + clamp(v.shadeY) * half).toFixed(1)}px)`;
    this.bar.classList.toggle('on', v.breath < 0.995);
    this.bar.classList.toggle('winded', v.winded);
    this.fill.style.transform = `scaleX(${v.breath.toFixed(3)})`;
  }
}
