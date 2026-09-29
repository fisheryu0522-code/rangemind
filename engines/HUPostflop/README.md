> Source release note: this historical engine document describes the validated private Windows installation. This repository contains source only; no executable, model, PTX, evaluator data or benchmark data directory is included. Follow [the source build guide](../../docs/BUILD.md). Measurements refer to RTX 4090 / i9-14900KF, not DGX Spark.

# HUPostflop native engine

This is a PokerLab build of the TexasSolver console branch, upstream commit `6dfb65b4d7ed081da509e8d8c3d82138c4708267`, licensed under AGPL-3.0. Upstream: https://github.com/bupticybee/TexasSolver/tree/console . The legacy `../TexasSolverCPU/console_solver.exe` has also been updated to this same verified binary, so the older interface does not keep using the known public-chance defect. Its original executable was backed up before replacement. Existing saved results are not recomputed or rewritten by this installation.

Current adapter/native revision: `1.1.0-joint-chance`. Native SHA-256: `5f09449d2b2768d1b21c11867b6858485509c4c8a77525d27ec35404fd9fee8d`.

`corresponding-source.zip` contains the complete modified C++ source used by this executable, dependency sources and licenses, and local build configuration. Extract to a build directory; `solver-build-config` and `texas-solver-source` must be siblings. Build with CMake, GNU C++17 and OpenMP, e.g. `cmake -S solver-build-config -B build -G "MinGW Makefiles"`, then `cmake --build build --parallel`. The distributed binary was built with GCC 16.2, `-O3`, static linking and OpenMP.

The app passes the existing `../TexasSolverCPU/resources` directory with `-r`; the standard hold'em five-card lookup table is shared. For standalone execution, pass the absolute directory containing that `compairer/card5_dic_sorted.txt` table. This build includes no GPU solver; GPU equity and language coaching use separate local components.

Local modifications:

- Preserve every positive range weight (inherited PokerLab patch), and disable suit isomorphism for exact-combo ranges.
- Filter exported hole cards against the current public runout (inherited PokerLab patch).
- Add explicit `set_raise_limit` (includes the opening bet) and `set_min_bet` commands.
- Distinguish preflop blind special cases from postflop amounts; retain decimal chip amounts, rounded to minimum-bet / 100 units.
- Track the most recent full raise, reset it each street, enforce legal minimum bets/raises, retain legal short all-ins, and cap payments at the effective stack.
- With `allin_threshold=1`, avoid silently replacing near-stack bets with all-ins.
- Export terminal/showdown node types explicitly; remove duplicate public cards from chance branches.
- Mark truncated export boundaries `out_of_scope=true`, while future streets remain part of the solved game.
- Produce a final native exploitability report for the actual exported average strategy, rather than recycling an earlier checkpoint.
- Correct both CFR and best-response public-chance denominators to remove all four private cards from a fixed joint deal. The previous denominator removed only two, discounting pure-check turn payoffs by `44/46` and flop payoffs by `(45/47)*(44/46)`. Seven independent full-tree cross-checks now cover flop/turn/river, weighted ranges, early folds, raises and multiple all-in times; native BR differed by at most `2.28e-6 BB` from the independent evaluator in that audit. Pre-fix future-street results must retain their old provenance rather than being silently treated as this revision.

The JavaScript adapter independently checks money accounting, public-card uniqueness, probability normalization, legal raises, required strategy rows, and complete branches. Its tests include native river, full flop-to-river and current-street export solves. Native exploitability is labeled separately from independently verified NashConv. This native build does not itself export action EV. For a complete exported tree, the separate `lib/hu-policy-evaluation.mjs` evaluator can reconstruct each hand's action EV and exact information-set best response from the exported average policy, legal joint private deals and public runouts. The app enables those values and EV-loss study questions only after that independent evaluation succeeds. It must not infer action EV from action frequencies. A current-street-only export lacks the future policy needed for this reconstruction and therefore keeps action EV unavailable.

`outputScope=full` exports all future streets within the report budget. `current-street` solves the complete future game but exports only the initial street and marked chance boundaries. `auto` chooses between those based on export size. A separate native strategy-cell budget is enforced because exporting less does not make an oversized solving tree fit in memory.
