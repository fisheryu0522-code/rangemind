> Source release note: this historical engine document describes the validated private Windows installation. This repository contains source only; no executable, model, PTX, evaluator data or benchmark data directory is included. Follow [the source build guide](../../docs/BUILD.md). Measurements refer to RTX 4090 / i9-14900KF, not DGX Spark.

# GPU 河牌策略实验

这是 PokerLab 原创的 CUDA 策略迭代实现，和权益蒙特卡洛、语言模型是三个独立模块。它让 RTX 4090 直接计算 CFR 遗憾值与平均策略；每一轮使用输入范围中全部合法联合底牌，没有用抽样代替完整机会枚举。

目前支持：两人或三人、五张公共牌、给定下注/加注树、不等筹码与当前街边池、节点锁定。抽水仅支持无抽水，或初始毛底池已经达到所填封顶且尚未扣除费用的固定封顶模型；未封顶、随之后金额变化的抽水明确拒绝。支持 simultaneous CFR+、alternating CFR+、DCFR。公共树、合法行动及联合发牌复用经过独立测试的 RiverLab 输入准备器。

## 数学与核验

策略、价值、遗憾与机会权重都使用 FP64。GPU 线程按联合底牌逆序计算后续收益；每个公开节点与自己底牌组成的信息集对应一个线程块，归约其他玩家到达概率与机会权重加权的反事实遗憾。平均策略按自己此前行动的到达概率加权。不同对手底牌共享同一信息集策略，不能偷看对手牌来选择动作。

alternating 模式依次更新每位玩家；每次更新使用其他玩家当时的策略，完成整轮后才累积平均策略。simultaneous 模式则在整轮固定同一策略后一起更新。DCFR 使用与本地 CPU 对照实现相同的折扣和平方平均权重。

GPU 结果发布之前，把它的最终平均策略导入独立 CPU 评估器。CPU 不再训练，直接计算不受导入锁定限制的信息集最佳响应，并重新生成每手牌行动 EV、到达权重和 NashConv。这里绝不使用“所有策略已锁定”必然导致的零受约束残差来宣称准确。GPU 与独立 CPU 的整体策略 EV 不一致时拒绝返回结果。

浮点数归约顺序不同会使长期迭代轨迹有所差别，特别是接近零到达的节点。平台核验的是 GPU 实际输出策略的收益和最佳响应，不借用 CPU 对照策略的精度。多人 CFR 仍没有一般纳什收敛保证。

## 当前资源与限制

- 完整工作区主要需要 `公开节点数 × 合法联合发牌数 × 玩家数 × 8` 字节。默认预算 4 GB，可明确设置到 16 GB，另保留至少约 30% 当前可用显存。实际分配前再次检查显存。
- GPU 默认节点访问预算为一万亿次，已在三人各 100 组合、285 节点、1000 轮模型中实测。CPU 默认仍为两千亿次；显存、联合发牌、公开树与时间预算不因这项 GPU 限额改变。
- 当前版本超预算会明确拒绝，不会自动减少范围或随机采样。尚未实现分块精确累加。
- 原生 CPU 独立评估器还具有自身内存预算；GPU 装得下并不保证 CPU 校验树也装得下。
- 目前按迭代次数或时间停止；末尾残差经过独立核验，但尚未用来进行 GPU 自适应早停。
- 短任务可能在 CPU 更快。GPU 的初始化、范围准备、JSON 传输和独立校验都必须计入端到端时间，不能只比较 kernel 时间。
- 本地大语言模型和大范围 GPU 求解应由应用调度显存。此模块不会擅自结束其他进程。

## 接口

`lib/gpu-river-cfr.mjs`：

- `prepareGPURiverGame(raw)`：严格准备完整模型并预估工作区。
- `solveGPURiverGame(raw, {onProgress, signal, outputFile, workDir, python, enginePath, verify=true})`：返回兼容研究界面的完整结果；可通过 AbortSignal 取消 Python 或 CPU 校验子进程。
- `verifyGPUPolicy(prepared, gpu, options)`：用独立 CPU 信息集最佳响应核验给定 GPU 平均策略。

`verify=false` 只供实验基准，返回未核验的原始策略，不应作为正式研究或训练答案。默认始终执行校验。

编译源：`lib/gpu-river-cfr.cu`；CUDA Driver/NVRTC 适配：`lib/gpu-river-cfr.py`；已编译本地目标：`lib/gpu-river-cfr.ptx`（compute_89）。NVIDIA 编译器仍保存在开发目录，不复制进产品。运行只使用已安装 NVIDIA 驱动、Python 和 NumPy。

## 回归测试

`tests/gpu-river-cfr.test.mjs` 的 GPU 测试通过 `POKERLAB_TEST_GPU_CFR=1` 显式启用。覆盖双人、三人、相互阻断与权重、不等筹码、锁定策略，以及三种算法的多个迭代检查点。小树逐组合频率与 CPU 在 `1e-8` 内一致，行动 EV 与最佳响应在 `1e-7 BB` 内一致。大树以独立策略 EV/最佳响应和到达权重解释浮点差异，不承诺所有频率逐项相同。
