# Build and run

## 1. Start the web workbench

Node.js 22+; no npm dependencies are needed. Run `npm start`, then open http://127.0.0.1:8731/ . Optional environment variables: `POKERLAB_PORT` (default 8731), `POKERLAB_PYTHON` (Python executable, default `python`), `POKERLAB_COACH_PORT` (default 8740).

All application records are created beneath `data/`, excluded from Git. Never publish that directory to supply demo data. The built-in `lib/study-library.mjs` contains synthetic research scenarios and explicit range assumptions; it does not depend on personal records or a commercial solution library.

## 2. Build original CPU engines

The reference supported native runtime is Windows x64. Install a C++17 compiler with OpenMP support (for example a MinGW-w64 GCC toolchain), then run from the repository root:

```sh
g++ -std=c++17 -O3 -DNDEBUG -fopenmp -static -static-libgcc -static-libstdc++ engines/RiverLab/river-engine.cpp -o engines/RiverLab/river-engine.exe
g++ -std=c++17 -O3 -DNDEBUG -fopenmp -static -static-libgcc -static-libstdc++ engines/TurnLab/turn-engine.cpp -o engines/TurnLab/turn-engine.exe
```

See each engine's README for input semantics and mathematical limits. No native executables are shipped. The old installation's performance results depend on that installation's compiler/build and hardware; rebuilding does not automatically reproduce its binary hash.

## 3. Optional single-opponent full postflop engine

The complete modified AGPL source and build configuration are in `third_party/hu-postflop/`. With CMake 3.20+ and MinGW GCC:

```sh
cmake -S third_party/hu-postflop/solver-build-config -B build/hu -G "MinGW Makefiles"
cmake --build build/hu --parallel
```

Copy the resulting `console_solver.exe` to `engines/HUPostflop/console_solver.exe`. The legacy view also expects a copy under `engines/TexasSolverCPU/` if used. This source-only repository deliberately omits the large standard card evaluator table. Obtain the upstream standard hold'em `resources/compairer/card5_dic_sorted.txt` resource from the [TexasSolver console project](https://github.com/bupticybee/TexasSolver/tree/console), inspect its applicable terms, and put it at `engines/TexasSolverCPU/resources/compairer/card5_dic_sorted.txt` before using the HU adapter.

The adapter labels rebuilt binaries as unconfirmed by the historical binary hash and independently validates complete exported policies; do not erase this provenance distinction. For native integration tests, use the rebuilt binary and complete resource tree.

## 4. Optional CUDA equity and river training

Install Python 3.10+, NumPy (`python -m pip install -r requirements.txt`), an NVIDIA driver and compatible CUDA NVRTC dependencies. The validated private environment used CUDA 12.9 NVRTC and `compute_89` for RTX 4090.

```sh
python lib/gpu.py compile "<CUDA NVRTC directory>/nvrtc64_120_0.dll"
python lib/multi_gpu.py compile "<CUDA NVRTC directory>/nvrtc64_120_0.dll"
python lib/gpu-river-cfr.py compile "<CUDA NVRTC directory>/nvrtc64_120_0.dll"
```

Pass the actual installed NVRTC filename. These current build helpers use Windows `ctypes.WinDLL`, expect `nvrtc-builtins64_129.dll`, and target `compute_89`; they are **not portable DGX Spark installers**. The generated `.ptx` files stay in `lib/` and are Git-ignored. The GPU river path also requires RiverLab for independent CPU best-response verification.

## 5. Optional local language model

The deterministic structured explanation path is available without model weights. To reproduce the optional local paragraph-selection path, install the verified Qwen3.6-27B Q4_K_M GGUF under `engines/local-coach/models/Qwen3.6-27B-Q4_K_M.gguf` and a compatible llama.cpp Windows server under `engines/local-coach/llama-server.exe`, with its runtime dependencies. The adapter currently validates the expected reference weight size and uses llama.cpp b11223-style options. This repository neither downloads nor redistributes these artifacts automatically.

## 6. Test levels

`npm run test:core` needs only Node. `npm test` additionally exercises native solvers and is expected to require their compiled executables and resources. GPU tests are opt-in in the relevant test modules. Keep source-only smoke results separate from earlier fully installed Windows results.

The repository intentionally retains the existing `PokerLab` internal API/data identifiers for compatibility. The public project name is 观局 · RangeMind.
