import { mapBoxToView } from '../logic/boxMapping';

describe('mapBoxToView', () => {
  it('maps directly when aspect ratios match', () => {
    const r = mapBoxToView([250, 100, 750, 900], { width: 1000, height: 1000 }, { width: 400, height: 400 });
    expect(r).toEqual({ left: 40, top: 100, width: 320, height: 200 });
  });

  it('accounts for the horizontal crop of a wide image in a tall view', () => {
    // 4:3 landscape image in a square view: scaled to height, 1/8 cropped each side.
    const r = mapBoxToView([0, 500, 1000, 1000], { width: 400, height: 300 }, { width: 300, height: 300 })!;
    expect(r.left).toBeCloseTo(150);
    expect(r.width).toBeCloseTo(150); // right half visible up to the crop edge
    expect(r.top).toBe(0);
    expect(r.height).toBe(300);
  });

  it('accounts for the vertical crop of a tall image in a wide view', () => {
    const r = mapBoxToView([500, 0, 600, 1000], { width: 300, height: 400 }, { width: 300, height: 300 })!;
    // shown height 400 => offsetY -50; y = -50 + 0.5*400 = 150
    expect(r.top).toBeCloseTo(150);
    expect(r.height).toBeCloseTo(40);
  });

  it('returns null for boxes outside the grid or inverted', () => {
    const img = { width: 100, height: 100 };
    const view = { width: 100, height: 100 };
    expect(mapBoxToView([0, 0, 1200, 10], img, view)).toBeNull();
    expect(mapBoxToView([500, 0, 400, 10], img, view)).toBeNull();
    expect(mapBoxToView(null, img, view)).toBeNull();
  });

  it('returns null when the box is entirely cropped away', () => {
    expect(mapBoxToView([0, 0, 1000, 50], { width: 400, height: 100 }, { width: 100, height: 100 })).toBeNull();
  });

  it('returns null before layout is known', () => {
    expect(mapBoxToView([0, 0, 10, 10], { width: 100, height: 100 }, { width: 0, height: 0 })).toBeNull();
  });
});
