import * as THREE from 'three';
import type { Avatars } from '../net/avatars';
import type { WatchMode } from '../watch';
import { t } from '../i18n';

/**
 * A view of the admin's watch page (src/watch.ts): the camera follows one player, behind them (over their shoulder, a
 * few metres back, further when they drive) or through their eyes (their figure not drawn), eased so it glides instead
 * of jerking with every step. Their name and score in the corner, in their colour. With nobody chosen (or the one
 * chosen gone) it follows the first player there is. Everything shown is put in with textContent.
 */
export class WatchView {
  target = '';
  mode: WatchMode = 'behind';
  private following = '';
  private pos = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private placed = false;
  private tag = document.createElement('div');
  private tagName = document.createElement('b');
  private tagSub = document.createElement('small');
  private wish = new THREE.Vector3();

  constructor(parent: HTMLElement = document.body) {
    this.tag.id = 'watch-tag';
    this.tag.append(this.tagName, this.tagSub);
    parent.append(this.tag);
  }

  /** Who is followed now ('' for nobody: nobody plays yet). */
  get who(): string {
    return this.following;
  }

  /**
   * Each frame, after the others are posed (avatars.tick): the camera on the player followed. `colour` and `score`: their
   * colour and kills from the scores (the tag). Returns where they stand, for the place name, the map and what is loaded.
   */
  update(dt: number, camera: THREE.PerspectiveCamera, avatars: Avatars, colour: (name: string) => string, score: (name: string) => string,
    clearance?: (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => number): THREE.Vector3 | null {
    const names = avatars.names();
    // The one chosen while they are here; else whoever was followed, else the first player there is.
    if (this.target && names.includes(this.target)) this.following = this.target;
    else if (!names.includes(this.following)) this.following = names[0] ?? '';
    const v = this.following ? avatars.view(this.following) : null;
    this.tag.classList.toggle('hidden', !v);
    if (!v) {
      avatars.hidden = null;
      this.tagName.textContent = t('watch.nobody');
      this.tag.classList.remove('hidden');
      this.tagSub.textContent = '';
      return null;
    }
    this.tagName.textContent = this.following;
    this.tagName.style.color = colour(this.following);
    this.tagSub.textContent = v.alive ? score(this.following) : t('watch.down');
    // Where the camera wants to be: their eyes, or behind and above them along where they look.
    const eye = v.car ? 1.3 : v.crouch ? 1.15 : 1.62;
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    let pitch = v.pitch;
    // Their figure not drawn through their eyes, nor when a wall behind them brings the camera up to their head.
    let hide = this.mode === 'eyes';
    if (this.mode === 'eyes') this.wish.set(v.at.x, v.at.y + eye, v.at.z);
    else {
      const back = v.car ? 6.5 : 3.2;
      const up = v.car ? 2.2 : 0.75;
      this.wish.set(v.at.x - fx * back, v.at.y + eye + up, v.at.z - fz * back);
      // Not into a wall behind them: as far back as is clear (as the car's camera, world/car.ts).
      if (clearance) {
        const head = { x: v.at.x, y: v.at.y + eye + 0.2, z: v.at.z };
        const dist = Math.hypot(this.wish.x - head.x, this.wish.y - head.y, this.wish.z - head.z);
        const k = Math.max(0.12, clearance(head, this.wish) - 0.3 / dist);
        this.wish.set(head.x + (this.wish.x - head.x) * k, head.y + (this.wish.y - head.y) * k, head.z + (this.wish.z - head.z) * k);
        if (k * dist < 1.3) {
          hide = true;
          this.wish.set(v.at.x, v.at.y + eye, v.at.z);
          pitch = v.pitch;
        }
      }
      pitch = Math.max(-0.9, Math.min(0.5, v.pitch * 0.6 - (v.car ? 0.2 : 0.14)));
    }
    // A jump (respawn, portal, a new player followed): there at once; else eased.
    if (!this.placed || this.pos.distanceTo(this.wish) > 25) {
      this.pos.copy(this.wish);
      this.yaw = v.yaw;
      this.pitch = pitch;
      this.placed = true;
    } else {
      const k = 1 - Math.exp(-dt * (this.mode === 'eyes' ? 18 : 7));
      this.pos.lerp(this.wish, k);
      let dy = v.yaw - this.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      this.yaw += dy * Math.min(1, k * 1.4);
      this.pitch += (pitch - this.pitch) * k;
    }
    avatars.hidden = hide ? this.following : null;
    camera.position.copy(this.pos);
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    return v.at;
  }

  /** A new player chosen, or the way of watching: the camera goes there at once. */
  set(target: string, mode: WatchMode): void {
    if (target !== this.target || mode !== this.mode) this.placed = false;
    this.target = target;
    this.mode = mode;
  }
}
