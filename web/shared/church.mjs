// Shared placement of the church's maintenance stair and roof walk. The generated solids are
// the same ones exported by tools/church.py; heights include the church's own ground once only.
export function makeChurch(data, ground) {
  const [ox, oz] = data.origin;
  const c = Math.cos(data.yaw), s = Math.sin(data.yaw);
  const point = ([x, north, y = 0]) => ({ x: ox+c*x-s*north, z: oz-s*x-c*north, y: ground+y });
  const prisms = [...data.body, ...data.visible].map((p) => ({ ...p,
    y0: p.y0+ground, y1: p.y1+ground,
    p: p.p.map((r) => r.map((q) => { const p = point(q); return [p.x, p.z]; })),
  }));
  const [x0, z0, x1, z1] = data.area;
  const corners = [[x0,z0],[x0,z1],[x1,z0],[x1,z1]].map(point);
  const area = { minX: Math.min(...corners.map((p) => p.x)), maxX: Math.max(...corners.map((p) => p.x)),
    minZ: Math.min(...corners.map((p) => p.z)), maxZ: Math.max(...corners.map((p) => p.z)) };
  return { prisms, area, point, anchors: { entry: point(data.anchors.entry), roof: point(data.anchors.roof),
    stairs: data.anchors.stairs.map(point) } };
}

/** The solid open-data church is replaced as a whole, for walking, shots and zombie navigation. */
export function churchPrisms(prisms, church) {
  return [...prisms.filter((p) => p.lm !== 'church'), ...church.prisms];
}
