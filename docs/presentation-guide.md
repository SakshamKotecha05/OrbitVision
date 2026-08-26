# Presentation guide: OrbitVision for Smart India Hackathon 2026 (PS-04)

This is the working document for the team building the slide deck and the demo video.
You do not need to have built OrbitVision, or know orbital mechanics, to use this.
Every number and claim in this guide is checked against the actual code and a real run of the pipeline in this repository, not copied from a pitch.
Where that matters, the source is named so you can regenerate or defend the figure yourself.

The live prototype is at [sakshamkotecha05.github.io/OrbitVision](https://sakshamkotecha05.github.io/OrbitVision/).
It is what you will demo from.

If you want more background before building slides, [`docs/overview.md`](overview.md) explains the whole project in plain language, and [`docs/architecture.md`](architecture.md) is the full technical reference this guide draws its numbers from.

---

## 1. The story arc for the deck

A suggested skeleton, one slide's worth of purpose per line.
Adjust slide count to your time limit, but keep the order: each slide sets up the next.

1. **Title.**
   Project name, team, problem statement PS-04, one line stating the domain: satellite collision risk in low Earth orbit (LEO).

2. **The problem.**
   Tens of thousands of tracked objects in LEO, all moving at 7-8 km/s.
   At that speed a graze destroys both objects and creates a debris cloud that threatens everything nearby.
   Operators can dodge an oncoming object, but only if they know it is coming, and only by spending fuel, which cannot be refilled in orbit.
   The real question is which of the many daily close passes are actually worth spending that fuel on.

3. **Why existing approaches fall short.**
   The obvious shortcut, ranking close passes purely by distance, breaks down because nobody knows an object's exact position.
   Tracking data has error that grows with its age, so two objects that pass close together are not equally dangerous if one pair's position data is fresh and the other's is stale.
   A distance-only ranking cannot tell those two situations apart, and a busy catalogue produces far too many close passes to review one at a time.

4. **What OrbitVision does.**
   One sentence per stage, worded for a non-technical audience: reads a public catalogue of tracked objects, predicts where each one will be over the next three days, finds the pairs that come dangerously close, and scores how dangerous each one actually is by probability of collision rather than distance.
   Close with the outcome: a ranked list, worst first, on a 3D globe you can scrub through time.

5. **How it works, in five steps.**
   Ingest the catalogue → propagate every object's orbit forward → screen for close approaches through a cascading filter (cheap and rough first, slow and exact last) → score each survivor's true collision probability → render the ranked result.
   This is also a good slide to show the funnel numbers from [section 4](#4-the-numbers-to-quote): millions of possible pairs narrowed down to a short list.

6. **The India-specific screen.**
   India Watch is not the general list filtered down to Indian satellites.
   Every Indian-operated LEO satellite is checked against the *entire* catalogue, exhaustively, with no distance shortcuts applied, specifically so nothing involving an Indian asset is missed for speed.
   State the current count: 44 Indian objects screened this way (see [section 4](#4-the-numbers-to-quote)).

7. **What makes the approach defensible.**
   This is the technical credibility slide.
   Cover the three talking points in [section 2](#2-the-talking-points-that-matter): ranking by probability instead of distance, screening out formation-flying pairs, and being upfront that uncertainty is modelled rather than measured.
   Judges probing technical depth will ask about one of these three; having the answer ready here means it lands as a strength, not a gap found under questioning.

8. **Limitations.**
   State them before a judge finds them.
   See [section 5](#5-what-not-to-claim) for the exact wording to use.
   A team that already knows its own boundary reads as more rigorous, so this slide works in your favor.

9. **What comes next.**
   Natural extensions that follow from the limitations: operator-grade tracking data (real covariance instead of the age-based model), coverage above LEO (GEO, where India's communication satellites sit), and integration with an actual alerting or advisory workflow.
   Keep this list to steps that actually follow from the limitations above, not a rewrite of what already exists.

10. **Closing / demo cue.**
    Hand off to the live demo (see [section 3](#3-the-demo-script-for-the-video)) or, if the deck stands alone, close on the one-line pitch: a decision-support prototype that tells an operator which close passes are actually worth their fuel, and shows its work.

---

## 2. The talking points that matter

These are the three decisions a judge with a technical background is most likely to probe.
Each one is a deliberate design choice with a concrete reason, not an oversight, present them that way.

### Why rank by collision probability, not miss distance

Nobody knows an object's exact position.
Tracking data (a GP/TLE element set) carries a margin of error that grows the older it gets, so an object's true position is really a fuzzy cloud of "probably somewhere in here," not a point.
OrbitVision converts each encounter's miss distance, combined with both objects' position uncertainty and physical size, into a single number: the probability that the two objects actually collide (Pc, short for probability of collision).
Encounters are ranked by that probability, in the sense used here, the maximum plausible Pc, never by raw distance.

Here is the concrete consequence to quote: two objects with old, uncertain tracking data passing at 400 metres can be a bigger risk than two objects with fresh, precise tracking data passing at 300 metres, because the first pair's wide uncertainty cloud makes a collision a real possibility, while the second pair's tight, precise clouds barely overlap at all.
A system that sorted by distance alone would rank the second, actually more dangerous pair as the safer one.
This is also why the engine's risk bands are computed from max Pc alone, and deliberately never from miss distance: in this engine's regime, the combined position uncertainty on an encounter runs from single digits to tens of kilometres, which dwarfs any fixed distance line worth drawing.

### Why formation-flying pairs are screened out

Some satellites are meant to fly close together on purpose: a cluster of satellites in the same constellation, or two spacecraft flying in coordinated formation, pass within a few hundred metres of each other every single orbit, by design.
An encounter like that has almost no *relative* motion between the two objects, even though both are moving at orbital speed.
If every one of those repeats were counted as a near-miss, the ranked list would fill up with the same handful of harmless, intentional formations appearing dozens of times a day, burying the rare actual dangers underneath them.

OrbitVision screens these out at the physics level, not with a name-matching hack: an encounter whose relative velocity at closest approach falls below a floor (0.1 km/s) is excluded before scoring, because the collision-probability method this project uses needs real relative motion to define the encounter geometry in the first place, below that floor the method is undefined, not merely imprecise.
Separately, pairs that are known to be flown together, objects in the same mega-constellation, or components of the same docked assembly sharing one element set, are excluded even earlier, on the grounds that the operator manages both objects internally and no external screening can act on that event anyway.
If asked for a number: the current run excludes 1,058 encounters on the relative-velocity floor, out of 292,147 candidate close approaches surviving the coarse screen.

### Why position uncertainty is modelled, not measured, and why that is an honest limitation

Real space agencies track their own satellites with radar and laser ranging precise enough to produce a measured uncertainty (a covariance) for every position estimate.
The public catalogue this project reads, CelesTrak's GP/TLE element sets, carries no such thing: it gives you an orbit, not an error bar on that orbit.

So OrbitVision estimates that uncertainty instead, from how old the tracking data is, using published rates of SGP4 (the standard orbit-propagation model) error growth: about 1 km of position uncertainty at the moment the element set was issued, growing by roughly 2 km per day after that, a rate published in the literature as falling between 1 and 3 km per day.
This is a standard, defensible stand-in used elsewhere in the field precisely because no better public data exists, but it is a stand-in, not a measurement.
Say this plainly rather than let a judge find it: every Pc figure this system produces is only as good as that age-based estimate, not a true tracked-covariance number.
The tool discloses this in its own output rather than hiding it, look for the "modelled, not measured" notice in the interface itself.
That disclosure is a design decision, not an afterthought, and it is the honest way to present a prototype built on public data.

---

## 3. The demo script for the video

An ordered, click-by-click sequence for a screen recording, with rough timings for a roughly 2-minute demo.
Adjust pacing to your actual time budget, but keep the order: it goes from the whole system, to one encounter in detail, to the India-specific capability, and closes on trust and honesty rather than a feature list.

**Before you hit record:** open the live site, let it sit for 3-5 seconds so the globe's Earth imagery fully paints in, and only then start recording.
Loading it mid-recording will show a flat or partially-textured globe for a beat, which reads as a bug on camera even though it is just a normal first load.

| Time | Action | What to say |
|---|---|---|
| 0:00-0:15 | Land on the default **Global Screen** view. Let the globe sit for a couple of seconds. | "This is OrbitVision, showing every tracked object in low Earth orbit right now, and a ranked list of the riskiest close approaches over the next 72 hours." |
| 0:15-0:30 | Point at the header stats ("Window", "Screened") and the ranked list on the right. Scroll the list slightly to show several cards. | "Each card is one encounter between two objects. The list is ranked worst-first, not by how close they pass, but by their actual probability of collision." |
| 0:30-0:55 | Click the **top card** in the list (the highest-ranked CRITICAL encounter). Let the globe fly to it and draw both orbital paths. Let the detail panel open. | "Clicking an encounter flies the camera there, draws both objects' orbits, and opens the full numbers behind the score: miss distance, relative velocity, collision probability, and how old the tracking data is." |
| 0:55-1:10 | In the detail panel, point at the collision-probability figure and the data-age figure together. | "This is the number that matters: not how close they pass, but the probability they actually collide, once you account for how much we don't know about exactly where they are." |
| 1:10-1:25 | Click **← Back to risk list**, then drag the **time scrub** at the bottom toward the highlighted encounter's mark (the tallest tick near it). Press play briefly if time allows. | "The time scrub moves every object on the globe to its position at that moment, so you can watch the encounter approach and pass." |
| 1:25-1:45 | Click the **India Watch** tab. Let the list and globe filter. Point at the screened-object count in the header. | "India Watch isn't the same list filtered down. Every Indian satellite here is checked against the entire catalogue, exhaustively, with no shortcuts, so nothing involving an Indian asset gets missed for speed." |
| 1:45-2:00 | Click one India Watch encounter to show it works the same way. Optionally point at the legend in the bottom-left corner. | "Same detail, same honesty about uncertainty, for India's own assets specifically. And this legend shows the exact probability thresholds behind every risk band, nothing is hidden behind a color." |

Here is a concrete encounter to use for the walkthrough, from an actual pipeline run committed in this repository (`data/output.json`, generated 2026-08-24): the current top-ranked general-list encounter is a CRITICAL conjunction between STARLINK-34325 and GEOSCAN 4 at a 27-metre miss distance, and the current top India Watch encounter is a HIGH conjunction between the Indian satellite AFR-1 and STARLINK-30990 at a 268-metre miss distance.
Exact ranks shift on every regenerated run, so open the live list yourself right before recording and use whatever sits at the top; do not hard-code these names into narration in case the deployed data has since refreshed.

---

## 4. The numbers to quote

All figures below come from a real `--offline` pipeline run in this repository against the committed CelesTrak snapshot (15,587-object catalogue, 72-hour window, run recorded in `data/output.json` at `generated_at_utc: 2026-08-24T19:48:43.152Z`).
Regenerate them yourself at any time with:

```
PYTHONPATH=src python -m orbitvision --offline --out data/output.json
```

The counts will shift slightly between runs as the underlying catalogue changes, but the shape of the funnel will not.

| Figure | Value | Where it comes from |
|---|---|---|
| Objects screened (LEO catalogue) | 15,587 | `data/output.json` → `screening.objects_screened` |
| Total possible object pairs | 121,469,491 | `screening.pairs_total` (n(n-1)/2 over the screened catalogue) |
| Pairs surviving the first analytic filter | 105,276,019 | `screening.pairs_after_perigee_apogee_filter` |
| Pairs surviving the coarse temporal sweep | 292,147 | `screening.pairs_after_coarse_sweep` |
| True conjunctions found within the 5 km reporting threshold | 37,094 | `screening.conjunctions_found` |
| Distinct object pairs after collapsing repeat passes | 28,665 | `screening.distinct_pairs_found` |
| Formation-flying encounters excluded before scoring | 1,058 | `screening.formation_flying_screen.encounters_excluded` |
| Final general-list size (capped) | 300 | `screening.general_list_cap`, `pipeline.py`'s `GENERAL_LIST_CAP` |
| Total conjunctions shown in the app (general cap + all India-related) | 540 | `len(data["conjunctions"])` in `data/output.json` |
| Indian LEO objects screened exhaustively | 44 | `data/output.json` → `india.objects_screened` |
| India-related conjunctions found | 242 | `len(data["india"]["conjunctions"])` |
| Prediction window | 72 hours | `data/output.json` → `screening.window_hours`; `pipeline.py`'s `WINDOW_HOURS` |
| Reporting threshold (true miss distance) | 5 km | `pipeline.py`'s `REPORTING_THRESHOLD_KM` |
| Coarse screening gate / sample interval | 500 km / 60 seconds | `screening.py`'s `COARSE_GATE_KM`, `COARSE_STEP_SECONDS` |
| Fine-refinement sample interval | 1 second | `screening.py`'s `REFINE_STEP_SECONDS` |
| Relative-velocity floor for formation-flying exclusion | 0.1 km/s | `risk.py`'s `MIN_RELATIVE_VELOCITY_KM_S` |
| Risk band thresholds (on max Pc) | CRITICAL ≥ 1e-4, HIGH ≥ 1e-5, MODERATE ≥ 1e-6, LOW < 1e-6 | `risk.py`'s `RISK_BAND_RULES`; see provenance note below |
| Position uncertainty model | 1 km at element-set epoch, growing 2 km/day | `data/output.json` → `uncertainty_model`; `risk.py`'s `synthesized_sigma_km()` |
| Full offline pipeline run time (this catalogue) | about 5 minutes (287.8 seconds recorded) | `screening.runtime_seconds` in `data/output.json`; `docs/architecture.md` |
| Risk model | Chan (1997) closed-form probability of collision, on the Foster (1992) formulation | `risk.py`; validated to ~1e-10 relative error against `scipy.stats.ncx2` |

Risk band threshold provenance, worth a slide footnote if asked: CRITICAL matches NASA/CARA's manoeuvre threshold for crewed assets such as the ISS.
HIGH matches the standard CARA manoeuvre threshold for robotic spacecraft.
MODERATE matches the general "conjunction of interest" watch threshold used in NASA / 18th Space Defense Squadron practice.
These are not invented cutoffs, they are the same thresholds real conjunction-assessment operations use.

---

## 5. What not to claim

Say these plainly if asked, and better yet, put the first two on the limitations slide before anyone has to ask.

- **This is not an operational collision-warning service.**
  It is a decision-support prototype built on public catalogue data, for a hackathon.
  Do not present it as something a satellite operator could plug in and rely on today.
- **It does not measure any satellite's true position uncertainty.**
  It estimates uncertainty from tracking-data age using a published growth rate, which is a standard and defensible stand-in given what public data actually contains, but it is not the operator-grade measured covariance a real space agency uses for its own satellites.
  Do not say the system "knows" how uncertain a position is; say it estimates it.
- **It does not send alerts, and does not talk to any satellite operator's systems.**
  There is no notification pipeline, no API integration with an operator, and no automated or recommended avoidance manoeuvre.
  It produces a ranked list on a screen, nothing more, and nothing less.
- **It only covers low Earth orbit.**
  Objects above roughly 2,000 km altitude, including the geostationary belt where many of India's communication satellites sit, are entirely outside this system's scope, not merely deprioritised.
  If asked about a specific GEO satellite, say plainly that it falls outside what this prototype screens.
- **The public catalogue itself has limits the team does not control.**
  CelesTrak's data is not the same fidelity as an operator's own tracking, and it rate-limits how often it can be refreshed.
  This is a property of the data source, not a shortcoming of the engine, but it is worth naming so the team doesn't overclaim currency or precision the underlying data doesn't actually offer.
