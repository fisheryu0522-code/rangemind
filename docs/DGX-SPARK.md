# DGX Spark adaptation status

**Not yet executed on DGX Spark.** The current measured environment is Windows x64 with RTX 4090. Hardware branding does not replace a port or benchmark.

Planned work:

1. Build RiverLab, TurnLab and the modified HU engine on the target Linux/ARM64 environment; remove Windows-specific executable suffix and build flags through explicit platform configuration.
2. Replace Windows-only `ctypes.WinDLL` CUDA/NVRTC loading with tested Linux library discovery; compile CUDA kernels for the actual device and installed CUDA version rather than retaining `compute_89` as an assumed target.
3. Build and validate llama.cpp for the target stack, then measure model memory, prompt latency and concurrent compute scheduling rather than infer them from unified memory size.
4. Re-run money-conservation, legal-action, chance-probability, information-set best-response, CPU/GPU agreement and model-bound explanation tests.
5. Benchmark identical stored input specifications with reported tree sizes, joint deals, iteration work, wall time, memory and final residuals. Report time-limit/budget failures as failures, not precision successes.

DGX Spark benchmark results will only be added after those runs actually occur. This file is an adaptation plan, not a completed hardware qualification report.
