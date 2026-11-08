import * as THREE from 'three';

/**
 * The one material of every hit box (a zombie's, a player's, a clown's, a cat's) and of the walk-in shower's pane
 * stand-ins: never drawn, but a shot's ray must still find them (world/rayShown.ts drawn, and its test).
 */
export const hitBoxMaterial = new THREE.MeshBasicMaterial({ visible: false });
hitBoxMaterial.name = 'hitBox';
hitBoxMaterial.userData.hitBox = true;
