import { selectExperience } from '../../App';

describe('selectExperience', () => {
  it('native is always the patient app', () => {
    expect(selectExperience('ios', undefined)).toBe('patient');
    expect(selectExperience('android', '?portal')).toBe('patient');
  });
  it('web is the portal unless ?patient is set', () => {
    expect(selectExperience('web', '')).toBe('portal');
    expect(selectExperience('web', '?patient')).toBe('patient');
    expect(selectExperience('web', '?x=1&patient')).toBe('patient');
    expect(selectExperience('web', '?patients=1')).toBe('portal');
  });
});
