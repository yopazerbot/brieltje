/**
 * Every key and button the game answers to, in one table, per way of playing: keyboard and mouse,
 * the controller, or touch. The menu's Controls tab is built from it, and the hints in the game
 * read their key names from it too (the HUD's menu key, the prompts, the portals' list, the map's
 * help, the furniture planner's line, the Resume button), so the two can't drift apart.
 *
 * A key read by its place on the keyboard (e.code: walking, E, Q ...) is named as the player's
 * keyboard prints it (src/keys.ts: Z Q S D on AZERTY). M and Shift+M are read by their letter, so
 * they stay M. Where the keys are read: src/controls/input.ts (playing), src/main.ts (M, P, N),
 * src/start.ts (Shift+M), src/ui/chat.ts (T, Enter) and src/ui/menu.ts (the arrow keys on the tab
 * rail); each asks keys.ts typing() first, so nothing acts while you type in a field.
 */
import { PORTALS } from '../shared/portals.mjs';
import { t, type PlainKey } from './i18n';
import { keyName, moveKeys } from './keys';

export type Control = 'kbm' | 'pad' | 'touch';

/** A label, given whether you play in Action mode (a click shoots there instead of opening doors). */
type Label = (action: boolean) => string;
type Entry = Partial<Record<Control, Label>>;

/** A key read by its place, named as the keyboard prints it. */
const place = (code: string): Label => () => keyName(code);
/** A key or button by its own name. */
const named = (name: string): Label => () => name;
/** A text in the player's language. */
const say = (key: PlainKey): Label => () => t(key);

const TABLE = {
  move: { kbm: () => moveKeys(), pad: say('key.leftStick'), touch: say('tctl.move') },
  look: { kbm: say('key.mouse'), pad: say('key.rightStick'), touch: say('tctl.look') },
  /** Sprint on foot, gallop on a horse. */
  sprint: { kbm: named('Shift'), pad: named('L3'), touch: say('touch.run') },
  /** Jump, fly up (held), the handbrake in a car. */
  jump: { kbm: say('key.space'), pad: named('✕'), touch: say('touch.jump') },
  /** Crouch (held) in Action mode, fly down. */
  down: { kbm: say('key.ctrlC'), pad: named('○'), touch: say('touch.down') },
  shoot: { kbm: say('key.leftClick'), pad: named('R2'), touch: say('touch.fire') },
  aim: { kbm: say('key.rightClick'), pad: named('L2'), touch: say('touch.aim') },
  reload: { kbm: place('KeyR'), pad: named('□'), touch: say('touch.reload') },
  weapons: { kbm: () => t('key.weaponKeys', { q: keyName('KeyQ') }), pad: say('key.weaponPad'), touch: named('⇄') },
  grenade: { kbm: place('KeyG'), pad: named('R1'), touch: say('touch.nade') },
  /** Doors, cars, horses, a portal's choice; tagging in a party game. */
  use: { kbm: place('KeyE'), pad: named('△'), touch: say('touch.use') },
  /** Doors in Explore mode also open with a click (R2), which shoots in Action mode. */
  click: { kbm: say('key.click'), pad: named('R2'), touch: say('touch.use') },
  /** Remove a piece in the furniture planner. */
  remove: { kbm: place('KeyX'), pad: named('○'), touch: say('touch.remove') },
  planner: { kbm: place('KeyP'), pad: say('key.menuPlay'), touch: say('tctl.startHow') },
  plannerKeys: {
    kbm: (): string => t('plan.keys', { turn: key('reload', 'kbm'), remove: key('remove', 'kbm'), stop: key('planner', 'kbm') }),
    pad: (): string => t('plan.keysPad', { turn: key('reload', 'pad'), remove: key('remove', 'pad') }),
  },
  /** Faster and slower (a car, a horse). */
  drive: { kbm: () => `${keyName('KeyW')} / ${keyName('KeyS')}`, pad: named('R2 / L2'), touch: say('tctl.thumbUpDown') },
  steer: { kbm: () => `${keyName('KeyA')} / ${keyName('KeyD')}`, pad: say('key.leftStick'), touch: say('tctl.thumbLeftRight') },
  handbrake: { kbm: say('key.space'), pad: named('✕'), touch: say('touch.brake') },
  /** A place in a portal's list (digits pick only places while it shows: src/ui/travel.ts). */
  portal: {
    kbm: (): string => t('travel.pickKbm', { n: PORTALS.length, use: key('use', 'kbm') }),
    pad: (): string => t('travel.pickPad', { use: key('use', 'pad') }),
    touch: say('travel.pickTouch'),
  },
  /** The menu on its Map tab, and back to the game from there. */
  map: { kbm: named('M'), pad: say('key.bigMapPad'), touch: say('tctl.bigMapHow') },
  /** The menu, open and close. */
  menu: { kbm: named('Esc'), pad: named('Options'), touch: named('☰') },
  /** The menu's tabs (the arrow keys while the tab rail has the keyboard). */
  tabs: { kbm: named('↑ / ↓'), pad: named('L1 / R1') },
  fps: { kbm: place('KeyF'), pad: named('Create') },
  minimap: { kbm: place('KeyN') },
  speed: { kbm: say('key.menuPlay'), pad: say('key.speedPad') },
  graphics: { kbm: say('key.menuSettings'), pad: say('key.squareInMenu') },
  chat: { kbm: () => t('key.or', { a: keyName('KeyT'), b: 'Enter' }) },
  scores: { kbm: () => t('key.hold', { key: 'Tab' }), pad: say('key.holdTouchpad') },
  sound: { kbm: named('Shift+M') },
} satisfies Record<string, Entry>;

export type Action = keyof typeof TABLE;

/** The key or button for `action` when playing with `control` ('' where there is none). */
export function key(action: Action, control: Control, actionMode = false): string {
  return (TABLE[action] as Entry)[control]?.(actionMode) ?? '';
}

export type Group = { title: string; rows: [string, string][] };

/** The few controls shown when you start playing (ui/controlsCard.ts): moving, the use key, the map and the menu; shooting in Action. */
export function essentials(control: Control, action: boolean): [string, string][] {
  const k = (a: Action) => key(a, control, action);
  const touch = control === 'touch';
  const rows: [string, string][] = [
    [t('ctl.move'), touch ? t('cc.tMove') : k('move')], // short: the Controls tab says it in full
    [t('ctl.look'), touch ? t('cc.tLook') : k('look')],
    [t('ctl.sprint'), control === 'kbm' ? t('key.hold', { key: k('sprint') }) : k('sprint')],
    [t('cc.jumpFly'), control === 'touch' ? k('jump') : t('cc.jumpFlyHow', { key: k('jump') })],
    [t('cc.use'), action || control === 'touch' ? k('use') : t('key.or', { a: k('click'), b: k('use') })],
  ];
  if (action) rows.push([t('cc.shoot'), k('shoot')]);
  rows.push([t('cc.map'), k('map')], [t('ctl.menu'), k('menu')]);
  return rows;
}

/** The Controls tab: the table grouped by what you do, for this way of playing and mode. */
export function controlGroups(control: Control, action: boolean): Group[] {
  return control === 'touch' ? touchGroups(action) : padOrKeyGroups(control, action);
}

function padOrKeyGroups(control: 'kbm' | 'pad', action: boolean): Group[] {
  const kbm = control === 'kbm';
  const k = (a: Action) => key(a, control, action);
  const hold = (a: Action) => t('key.hold', { key: k(a) });
  const moving: [string, string][] = [
    [t('ctl.move'), k('move')],
    [t('ctl.look'), k('look')],
    [t('ctl.sprint'), kbm ? hold('sprint') : t('key.l3', { key: k('sprint') })], // L3 switches sprint on until the stick is let go
    [t('ctl.jump'), k('jump')],
  ];
  if (action) moving.push([t('ctl.crouch'), hold('down')]);
  moving.push([t('ctl.flyUp'), hold('jump')], [t('ctl.flyDown'), k('down')], [t('ctl.stopFlying'), t('key.double', { key: k('jump') })]);
  const groups: Group[] = [{ title: t('ctl.moving'), rows: moving }];
  if (action) {
    groups.push({
      title: t('ctl.weapons'),
      rows: [
        [t('ctl.shoot'), k('shoot')], [t('ctl.aim'), hold('aim')], [t('ctl.reload'), k('reload')],
        [t('ctl.switchWeapon'), k('weapons')], [t('ctl.grenade'), k('grenade')], [t('ctl.pickUp'), t('ctl.pickUpHow')],
      ],
    });
  }
  groups.push(
    {
      title: t('ctl.house'),
      rows: [
        [t('ctl.door'), action ? k('use') : t('key.or', { a: k('click'), b: k('use') })],
        [t('ctl.planner'), k('planner')],
        [t('ctl.inPlanner'), k('plannerKeys')],
      ],
    },
    { title: t('ctl.cars'), rows: [[t('ctl.getIn'), k('use')], [t('ctl.drive'), k('drive')], [t('ctl.steer'), k('steer')], [t('ctl.handbrake'), k('handbrake')]] },
    {
      title: t('ctl.portals'),
      rows: [
        [t('ctl.pickPlace'), k('portal')], [t('ctl.withCar'), t('ctl.withCarHow')],
        ...(kbm ? [[t('ctl.fromChat'), t('ctl.fromChatHow')] as [string, string]] : []),
        [t('ctl.fromMenu'), kbm ? t('ctl.fromMenuHow') : t('ctl.fromMenuPad', { use: k('use') })],
      ],
    },
    {
      title: t('ctl.horses'),
      rows: [
        [t('ctl.getOn'), k('use')], [t('ctl.faster'), k('drive')], [t('ctl.steer'), k('steer')],
        [t('ctl.gallop'), kbm ? hold('sprint') : k('sprint')], [t('ctl.jump'), k('jump')],
      ],
    },
    {
      title: t('ctl.other'),
      rows: [
        [t('ctl.menu'), k('menu')],
        [t('ctl.menuTabs'), k('tabs')],
        [t('ctl.bigMap'), kbm ? t('key.bigMapKbm', { key: k('map') }) : k('map')],
        [t('ctl.walkSpeed'), k('speed')],
        [t('ctl.graphics'), k('graphics')],
        [t('ctl.fps'), t('key.orSetting', { key: k('fps') })],
        [t('ctl.minimap'), kbm ? t('key.orSetting', { key: k('minimap') }) : t('key.menuSettings')],
        [t('ctl.chat'), kbm ? k('chat') : t('key.keyboardOnly')],
        [t('ctl.scoreboard'), k('scores')],
        [t('ctl.sound'), kbm ? t('key.soundKbm', { key: k('sound') }) : t('key.soundPad')],
      ],
    },
  );
  return groups;
}

/** The touch controls: the same groups in a few lines. */
function touchGroups(action: boolean): Group[] {
  const k = (a: Action) => key(a, 'touch', action);
  const groups: Group[] = [{
    title: t('ctl.moving'),
    rows: [[t('ctl.move'), k('move')], [t('ctl.look'), k('look')], [t('tctl.run'), t('tctl.runHow')], [t('tctl.jump'), k('jump')], [t('tctl.crouch'), k('down')]],
  }];
  if (action) {
    groups.push({
      title: t('ctl.weapons'),
      rows: [[t('tctl.shoot'), k('shoot')], [t('ctl.aim'), t('tctl.aimHow')], [t('ctl.reload'), k('reload')], [t('tctl.grenade'), k('grenade')], [t('tctl.nextWeapon'), k('weapons')]],
    });
  }
  groups.push(
    { title: t('ctl.house'), rows: [[t('ctl.door'), k('use')]] },
    {
      title: t('ctl.planner'),
      rows: [[t('tctl.start'), k('planner')], [t('tctl.place'), t('tctl.placeHow')], [t('tctl.movePiece'), t('tctl.movePieceHow')], [t('tctl.stop'), t('tctl.stopHow')]],
    },
    { title: t('ctl.cars'), rows: [[t('ctl.getIn'), k('use')], [t('ctl.drive'), k('drive')], [t('ctl.steer'), k('steer')], [t('ctl.handbrake'), k('handbrake')]] },
    {
      title: t('ctl.horses'),
      rows: [[t('ctl.getOn'), k('use')], [t('ctl.faster'), k('drive')], [t('ctl.steer'), k('steer')], [t('ctl.gallop'), k('sprint')], [t('ctl.jump'), k('jump')]],
    },
    {
      title: t('ctl.portals'),
      rows: [[t('tctl.goElsewhere'), t('tctl.goElsewhereHow')], [t('ctl.withCar'), t('tctl.withCarHow')], [t('ctl.fromMenu'), t('tctl.fromMenuHow')]],
    },
    {
      title: t('ctl.other'),
      rows: [[t('ctl.menu'), k('menu')], [t('tctl.bigMap'), k('map')], [t('tctl.soundFull'), t('tctl.soundFullHow')], [t('tctl.best'), t('tctl.bestHow')]],
    },
  );
  return groups;
}
