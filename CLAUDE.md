# Instructions for Claude Code

1. **Read `PLAN.md` and `HANDOFF.md` first.** `PLAN.md` is the single source of truth.
2. **Work on one stage only** (the one named in `HANDOFF.md` under "Next step"). Do not start later stages.
3. **Never contradict `PLAN.md`.** If it must change, propose the change to the owner and wait. Do not silently deviate.
4. **Update `HANDOFF.md` at the end**: what is done, what is not, known issues, measured numbers, exact next step, tunables to test.
5. Before finishing: `npm test` and `npm run build` must both pass. Commit locally with a clear message. Never push.

The owner is Alisher, an 18-year-old student who speaks Uzbek. Talk to him in simple Uzbek, plain words, one small step at a time.

Other rules: never open or print `.env` files, keys or passwords (this project needs none); no new dependencies beyond the PLAN.md stack without asking; free tools only; all code stays client-side.
