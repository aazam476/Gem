# Pitch Material (not needed for coding)

**Gem — "FaceTiming Gemini": a dynamic, voice-driven camera guide for decentralized clinical trials.**

## Problem
Decentralized trials lose patients and data quality at home: paper manuals, manual
transcription of device readings, and no one to ask. Older, non-technical patients are hit
hardest.

## What it does
A researcher types a protocol step and its validation limits in a web portal and hits
Deploy. The patient opens the app, points the phone at their device and taps one big
button. Gemini finds the display (green box) and reads it; an ElevenLabs voice says "I read
142 over 90. Is that right?"; the patient taps Yes. Before anything is stored, a
deterministic gateway checks the numbers in microseconds and refuses anything the AI may
have hallucinated.

## Track mapping
- **Regeneron:** no manual data entry; protocol adherence guided step by step; readings
  confirmed by the patient; abnormal-but-real values are flagged for the study team, not
  discarded.
- **Gemini:** Prompt-as-a-Service: the system prompt and the JSON schema are generated per
  protocol at request time; vision returns a bounding box (0–1000 grid), per-metric readings
  and a patient-friendly line in one structured call.
- **ElevenLabs:** Flash v2.5 streamed through the backend for a "FaceTime" feel; fixed lines
  can be pre-generated so the app still speaks when the network fails.
- **Lucera:** the LLM is an untrusted order source; a pure, deterministic pre-trade-style
  risk check (plausibility limits, cross-field rules, idempotency) gates every write, with
  µs-level latency measured and reported (see PERFORMANCE.md).

## 2-minute demo script
- **0:00–0:15** Problem: trial dropout and bad at-home data.
- **0:15–0:45** Portal: "Use blood pressure template", show reject vs. flag limits, Deploy.
- **0:45–1:15** Phone: point at the monitor, tap. Green box, voice read-back, tap Yes. Portal
  shows the reading appear.
- **1:15–1:45** Terminal: `pytest tests/test_gateway.py` (46 passing), then
  `python load_test.py --workers 50 --events 1000` (µs validation, exactly-once ✔, 900s blocked).
  Optional: restart with `GEM_MOCK_READINGS='{"systolic": 900, "diastolic": 82}'` and show the
  phone saying "That reading looks unusual" while the portal lists it under "Blocked".
- **1:45–2:00** Recap the four tracks.

Backup plan if venue Wi-Fi fails: `GEM_MOCK_AI=1` + phone hotspot; everything runs locally
with on-device voice.

## Devpost README checklist
- Lucera section: copy `docs/PERFORMANCE.md` (Environment limits, Workload, Metric,
  Procedure, Interpretation) — rerun the load test on the demo laptop first.
- Gemini/ElevenLabs: describe the per-protocol prompt + schema generation and streamed voice.
- Judge reproduction: `cd backend && pytest tests/test_gateway.py` and
  `python load_test.py --workers 50 --events 1000`.

## To-dos for the team (not for the repo)
- Apply to the Regeneron JEDI program via their link, then mention it in the Devpost write-up.
- Paste each sponsor's exact requirements (especially Lucera's performance template) into
  `docs/SPEC.md` / `docs/PERFORMANCE.md` so agents can check against them.
