# Third-party components and distribution scope

The original RangeMind / PokerLab application code is released under GNU AGPL v3 (`LICENSE`). Existing upstream copyright and license notices retain precedence for their own files.

## Included source

- **TexasSolver console**, upstream commit `6dfb65b4d7ed081da509e8d8c3d82138c4708267`: https://github.com/bupticybee/TexasSolver/tree/console . AGPL v3. `third_party/hu-postflop/` contains the complete modified corresponding source and build configuration from the private installation. The source includes upstream dependency licenses for fmt, googletest and pybind11. `engines/HUPostflop/README.md` records changes, including public-chance denominator corrections, and the hash of the previously validated Windows executable. That executable is **not included**.
- **nlohmann/json 3.7.3**: MIT, full license preserved at the top of `engines/RiverLab/json.hpp` and applicable upstream files.
- RiverLab, TurnLab, independent policy evaluation and CUDA equity/CFR kernels are original project implementations. The optional TexasSolver adapter does not make those components proprietary.

## Not distributed in this repository

- **TexasSolverGPU**: proprietary release, excluded completely, including bundled range database and preset resources. The legacy `/api/presets` endpoint returns an empty list in this release.
- **Qwen3.6-27B** weights and **llama.cpp** executables/libraries: not included. The private reference setup used Qwen's Apache-2.0 model and MIT llama.cpp b11223. Obtain separately from https://huggingface.co/Qwen/Qwen3.6-27B and https://github.com/ggml-org/llama.cpp , inspect their licenses and verify downloads.
- NVIDIA CUDA compiler/runtime/cuBLAS DLLs, Python/Node runtimes, native executables and PTX build products: not included. Users install these under their respective licenses.
- TexasSolver's evaluator lookup datasets, installed precomputed strategies, private hand histories, local training records, model caches, backups and logs: not included.

The source archive retains upstream dependency documentation assets (including its own font/image assets) with upstream sources. These are not installed runtime binaries or project branding assets.

The app currently defaults to loopback access. If modifying and serving covered code to remote users, review the network-source requirements in section 13 of `LICENSE`; the source tree here is the starting corresponding source for this release, not a substitute for publishing later modifications.
