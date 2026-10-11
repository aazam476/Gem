import { draftFromRules, emptyMetric, rulesFromDraft } from '../logic/rulesForm';
import { protocol } from '../testing/fixtures';

describe('rules form', () => {
  it('round-trips the blood pressure preset', () => {
    const draft = draftFromRules(protocol.validation_rules);
    expect(draft.systolicAboveDiastolic).toBe(true);
    const result = rulesFromDraft(draft);
    expect(result).toEqual({ ok: true, rules: protocol.validation_rules });
  });

  it('rejects bad ordering, names and blanks', () => {
    const bad = { ...emptyMetric(), name: 'Systolic', min: '100', max: '90', hard_min: '50', hard_max: '200' };
    const blank = { ...emptyMetric(), name: 'pulse' };
    const result = rulesFromDraft({ metrics: [bad, blank], systolicAboveDiastolic: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toMatch(/lowercase/);
      expect(result.errors.join('\n')).toMatch(/hard min ≤ min ≤ max ≤ hard max/);
      expect(result.errors.join('\n')).toMatch(/must be numbers/);
      expect(result.errors.join('\n')).toMatch(/systolic and diastolic/);
    }
  });

  it('rejects duplicate names and an empty list', () => {
    const m = { ...emptyMetric(), name: 'x', min: '1', max: '2', hard_min: '0', hard_max: '3' };
    expect(rulesFromDraft({ metrics: [m, m], systolicAboveDiastolic: false }).ok).toBe(false);
    expect(rulesFromDraft({ metrics: [], systolicAboveDiastolic: false }).ok).toBe(false);
  });
});
