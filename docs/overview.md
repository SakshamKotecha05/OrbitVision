# OrbitVision, explained simply

This page explains OrbitVision in plain language.
No orbital mechanics background needed, no software background needed.
Read this and you should be able to explain the project to a judge.

## The problem

There are tens of thousands of tracked objects in orbit around Earth: working satellites, dead satellites, spent rocket stages, and fragments of debris from old collisions and explosions.
All of them are moving at roughly 7-8 kilometres per second.
At that speed, two objects do not need to touch head-on to destroy each other.
A graze is enough.
And a collision does not just destroy the two objects involved: it creates a cloud of new debris fragments, each one a new object that can go on to hit something else.

Satellite operators can move a satellite out of the way of an oncoming object, but only if they know the danger is coming, and only by spending fuel, which is a limited and non-renewable resource on any given satellite.
So the real decision an operator faces is: out of everything in orbit, which encounters are actually worth spending fuel on?
Answering that well, in advance, for a busy region of orbit, is a hard problem, because there are far too many objects to watch by eye and most close approaches are not actually dangerous.

## What OrbitVision does

OrbitVision is a prototype that helps answer that question.
It works in five steps, in this order:

**1. It reads a public catalogue of what is up there.**
The catalogue comes from CelesTrak, a public tracking data provider, and lists every tracked object with its current orbit.

**2. It works out where every object will be over the next few days.**
Each object's orbit is used to predict its position, second by second, for a 72-hour window into the future.

**3. It finds pairs of objects that come dangerously close to each other.**
Out of roughly 15,000 tracked objects, that is around 120 million possible pairs.
OrbitVision narrows that down in stages, from cheap and rough checks to slow and exact ones, until it is left with the genuine close approaches: the moments where two specific objects pass within a few kilometres of each other.

**4. It scores how dangerous each close approach is.**
A "close approach" is not automatically a "real risk."
OrbitVision turns each one into a single risk score: a probability of collision.
More on what that means below.

**5. It shows the results on a globe you can scrub through time.**
The scored close approaches are ranked worst-first and shown as a list next to a 3D globe.
Dragging a time control lets you watch the satellites move and the encounters happen, hour by hour across the 72-hour window.

## What the operator sees and does

The screen has three main parts: a 3D globe of the Earth in the middle, a ranked list of risky encounters on the right, and a scrubbable time control along the bottom.

**The globe** shows every tracked object as a small dot, moving in real time (well, in scrubbed time) along its orbit.

**The ranked list** shows every close approach the system found, worst risk first, as a card.
Each card shows which two objects are involved, how close they pass, and how risky the encounter is rated.

**Clicking a card** in the list does three things at once: the globe flies the camera to that encounter and draws both objects' orbital paths so you can see the geometry, a detail panel opens with the full numbers behind the score, and the time control jumps to shortly before the moment of closest approach so you can watch it happen.

**The time scrub** at the bottom is a slider across the whole 72-hour window.
Dragging it, or pressing play, moves every object on the globe to its position at that moment.
Small marks along the scrub bar show when each encounter in the list actually occurs, with taller marks for the more dangerous ones, so you can see at a glance where the risky moments are clustered in time.

**India Watch** is a second mode, switched to from a tab at the top.
Where the default view (Global Screen) shows the worst encounters across the whole catalogue, India Watch narrows the list to only the encounters that involve an Indian-operated satellite, and screens those satellites against every other tracked object with no shortcuts taken, so nothing involving an Indian asset is missed for the sake of speed.

*A picture worth drawing here: the three-panel layout described above, globe on the left, ranked cards on the right, time scrub along the bottom, with one card mid-hover and its matching mark highlighted on the time scrub to show how the pieces connect.*

## What the risk score means

Two objects passing close to each other is not, by itself, a meaningful measure of danger.
Here is why.

Nobody knows an object's exact position.
Tracking data has a margin of error, and that margin grows the older the tracking data gets.
So instead of a single point in space, each object is really more like a small fuzzy cloud of "probably somewhere in here."
OrbitVision represents that fuzziness explicitly, and combines the two objects' fuzziness with their actual physical sizes, to work out: given everything we don't know for certain, what fraction of the possible outcomes actually end in a collision?
That fraction is the **probability of collision**, or Pc for short.
It is a single number between 0 (no realistic chance) and 1 (certain).

This is the central engineering decision in the whole project: **encounters are ranked by that probability, not by how close the two objects pass.**
That sounds like a small choice, but it is not, and here is a concrete way to see why.
Two objects with fresh, precise tracking data that pass within 300 metres of each other can be a smaller danger than two objects with old, fuzzy tracking data that pass within 400 metres of each other, because the second pair's uncertainty cloud is wide enough that the collision is a real possibility, while the first pair's tight, precise clouds barely overlap at all.
A system that just sorted by distance would rank the second, genuinely more dangerous pair as the safer one.
Ranking by probability instead of distance is what makes the list trustworthy.

## Why some near-passes are deliberately left out

Some satellites are meant to fly close together.
A cluster of satellites launched as part of the same constellation, or two spacecraft that are docked or flying in tight formation, pass within a few hundred metres of each other on purpose, over and over, every single orbit.
If OrbitVision counted every one of those as a near-miss, its ranked list would be wall-to-wall with the same handful of harmless, intentional formations repeating dozens of times a day, and the rare genuine dangers would be buried underneath them.
So OrbitVision recognises this pattern and leaves those pairs out of the list entirely, on the grounds that an encounter with essentially no relative motion between the two objects is not a chance encounter at all: it is two objects holding station together by design.

## What this system is not

OrbitVision is a decision-support prototype, built on public catalogue data, for a hackathon.
It is a demonstration of how a ranked, probability-based risk list could work, not a fielded operational system.
In particular:

- It uses publicly available tracking data, not the operator-grade tracking data a real space agency uses for its own satellites.
- Nobody's uncertainty about their own position is measured directly here; it is estimated from how old the tracking data is, which is a reasonable stand-in but not the real thing.
- It does not send alerts, does not talk to any satellite operator's systems, and does not recommend or execute an avoidance manoeuvre.
- It only screens low Earth orbit, not the higher orbits where communications and weather satellites often sit.

Nobody should present this to a judge, or to anyone else, as an operational collision-warning service.
It is a prototype that shows the right idea done carefully.
