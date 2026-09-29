> Source release note: this historical engine document describes the validated private Windows installation. This repository contains source only; no executable, model, PTX, evaluator data or benchmark data directory is included. Follow [the source build guide](../../docs/BUILD.md). Measurements refer to RTX 4090 / i9-14900KF, not DGX Spark.

# RiverLab 1.2.1 — 可审计的本地多人河牌引擎

本引擎解决的是 **指定范围、指定五张河牌公共牌、指定下注树中的不完全信息策略博弈**。不是权益模拟器，也不会读取对手的隐藏手牌来替自己的信息集选择动作。

## 已实现

- 2–6 位仍在底池中的玩家，各自范围与剩余筹码；默认完整枚举合法联合发牌。
- fold / check / call / bet / raise / re-raise / all-in。三种下注尺寸、三种加注尺寸的上限；每街最多三次加注是可配置的树抽象限制。
- 最小下注、合法最小加注、短全下、累计短全下重开、全下后的行动终止。
- 本街产生的边池、未获跟注的超额返还、平分；BB 连续数值，不处理赌场奇数筹码归属。
- 按公开历史＋自己的两张手牌建立信息集。默认交替 CFR+，一轮逐个更新每位玩家，轮末累积线性加权平均；另支持同时 CFR+ 与 DCFR(1.5,0,2)。
- 每个组合的平均策略、条件动作 EV、真实联合到达权重、反事实到达权重。零反事实到达时 EV 为 `null`。
- 每个玩家的信息集一致最佳应对、单方偏离收益与 NashConv；在小型二人及三人游戏上对照遍历全部纯策略的独立实现。
- 全节点或指定组合的策略锁定；同时给出解除锁定和遵守锁定两种 BR 残差。
- 明确选择的近似发牌模式，以及使用相同策略、独立发牌样本的验证。
- 12 CPU 线程默认、可配 1–24；进程取消、墙钟上限、发牌/树/矩阵/报告预算。

## 输入接口

```js
import {prepareRiverGame, solveRiverGame, riverNode} from './lib/river-engine.mjs';

const result = await solveRiverGame({
  board: 'Ks7h2h9c3s',
  pot: 20,                 // 河牌第一位行动前，已经存在的底池
  players: [
    {id:'bb', name:'BB', position:'BB', range:'AcKd,AhQh', stack:30},
    {id:'hj', name:'HJ', position:'HJ', range:'KcQd,QhJh', stack:30},
    {id:'btn',name:'BTN',position:'BTN',range:'9h9s,JhTh', stack:20}
  ],
  toAct: 0,                // players 数组按行动顺序排列；从此座位开始
  sizes: [50],             // 初次下注 = 当前底池 × 百分比
  raiseSizes: [50],        // 加注到 = 当前最高总下注 + 跟注后底池 × 百分比
  allIn: true,
  maxRaises: 1,            // 不包括第一次 bet；1 = 允许一次 raise
  minBet: 1,
  iterations: 2000,
  averagingDelay: 100,
  accuracy: 0.5,           // 总 NashConv / 初始底池的百分比；非单人 exploitability
  checkEvery: 100,
  maxSeconds: 1200,
  threads: 12,
  algorithm: 'alternating-cfr-plus', // 默认；也支持 cfr-plus、dcfr
  rake: 0,
  chanceMode: 'exact'      // 默认；不会偷偷改成抽样
}, {onProgress: console.log, signal: abortController.signal});

const node = riverNode(result, 'n0');
```

`stack` 是本街开始时剩余筹码。输入不接受本街中途已下注金额；应从本街起点建立树并沿行动节点浏览。数组只包含还在底池的玩家。所有玩家均有权争夺输入 `pot`；**不支持把此前街已经形成的多个边池合并为一个起始 pot**。

抽水仅支持起点已封顶的安全子集：`rake` 为百分比，`rakeCap` 为 BB，要求 `pot * rake / 100 >= rakeCap > 0`。此时 **pot 必须是这笔抽水尚未扣除的毛底池**。例如 pot=20、rake=5、rakeCap=1，所有终局都从起始共同奖池扣除一次 1 BB；下注尺寸仍以桌面毛底池计算，后续投入和未跟注退款不会再次收费。未达到封顶、无封顶、累进或其他收费结构明确拒绝。零抽水请显式设 `rake:0`；本程序不推断具体赌场或平台费率。

锁定示例：`locks:[{nodeId:'n0', actions:{check:1}}]`；或 `{nodeId:'n0',combo:'AcKd', probabilities:[0.8,0.2,0]}`。动作键、数组长度和总频率必须与该节点吻合。换尺寸/筹码后公开树会变化，旧节点 ID 不应直接复用。

大范围探索必须显式选择：

```js
{
  chanceMode: 'sampled',
  chanceSamples: 100000,
  evaluationSamples: 100000,
  seed: 20260928
}
```

抽样从各自加权范围独立抽牌，然后整组拒绝碰撞。没有使用会改变联合分布的“抽完第一人后重新归一第二人的范围”。重复样本聚合为经验概率；独立验证使用另一随机种子。

## 输出与数学口径

- `result.nodes`：根节点 `n0`，动作指向 `childId`。`actor` 为玩家数组序号。
- `combo.probabilities[a]` 与 `combo.actionEV[a]` 对应 `node.actions[a]`。
- 组合动作 EV：在自己的手牌和当前公开历史条件下，选择该动作并按平均策略继续的未来净收益；当前节点以前的投入已沉没，所以 fold EV 为 0。
- `action.ev`：让当前到达的整段行动范围全部选择该动作的平均 EV。
- `action.selectedEV`：条件于平均策略实际上选择该动作的手牌范围的 EV。不同动作筛选了不同范围，不能据其高低判断哪一动作更好。
- `node.profileEV`：实际平均策略的当前节点 EV，等于各动作频率 × `selectedEV` 之和。逐手牌动作比较应使用 `combo.actionEV`。
- `reach`：从场景根开始，在合法联合牌张分布和所有人的策略下到达该组合/节点的联合概率。
- `counterfactualReach`：排除行动玩家此前自己行动概率、保留牌张和其他玩家行动概率。自己的历史选择概率为零时仍可能有定义，适合研究反事实；对手到达概率为零则 EV 没有定义。
- `diagnostics.profileEV`：从场景根计算，各玩家数值总和等于 `diagnostics.constantSum = 初始 pot − rakeModel.fixedRake`（初始投入已沉没）。NashConv 百分比分母始终为输入毛底池。
- `bestResponseEV`：每次只让一人改变整套策略，且其同一信息集所有隐藏发牌必须共同选择动作。其他玩家仍用报告中的平均策略。
- `gain[p] = bestResponseEV[p] - profileEV[p]`，`nashConv = sum(gain)`。二人常和博弈常用 exploitability 为 NashConv/2；多人结果不应擅自除二或除以人数。
- 有锁定时，`nashConv` 允许偏离锁定，可能无法消除。`constrainedNashConv` 保留锁定信息集的概率分布，只优化剩余自由决策；`optimizationResidualPctPot` 指向实际停止标准。
- 近似模式的训练 NashConv 仅对经验训练博弈精确。`validation.holdout` 是相同策略在独立经验发牌分布的 EV、BR 诊断；BR 在该验证样本上优化，因此不是完整范围可利用性的误差上界。EV 区间只表示独立机会抽样误差。
- `chance.marginals[p].combos[].probability`：牌张互斥条件下的根边际。当前节点后验应使用 `combo.reach / node.reach`，原始 `weight` 不能直接充当可比较的先验。

三种优化算法都输出真实信息集最佳应对残差。交替的一轮包含 N 次玩家更新，`stats.playerUpdatePasses` 明确记录工作量；DCFR 使用正遗憾折扣 α=1.5、负遗憾 β=0、平均权重 γ=2。`zeroReachPruning:true` 只剪掉严格零反事实到达分支，没有概率阈值近似；与关闭剪枝的策略/动作 EV/BR 对照一致。多人优化的残差可能非单调，不能把迭代数当作准确度。

## 必须保留的边界

多人 CFR 不具备一般性的 Nash 收敛保证；每次结果由真实残差衡量。即使残差很小，它也只约束当前有限尺寸树，不能保证未纳入的其他合法尺寸不获利。条件独立范围是输入假设，不代表真实人群的联合范围分布。此前已弃牌玩家的牌张相关性（bunching）尚未建模。

范围权重、树抽象误差、多人优化残差、机会抽样误差是不同问题，不能合成一个“准确率 99%”。

## 测试及本机性能

运行 `node --test tests/river-engine.test.mjs`。22 项测试包含 Kuhn poker 已知均衡值、二人/三人枚举纯策略最佳应对、专门识别“透视隐藏牌”的反例、边池/返还/平分、短全下重开、串并行一致、六人资金守恒、锁定双口径、样本分布与独立验证、不可达组合、三种算法、精确剪枝，以及封顶抽水的独立计账和 BR。

i9-14900KF，12 线程，3 人，131 个公开节点，20 BB 初始底池。下表是最初同时 CFR+ 的性能基线，不能与交替算法的轮数直接等同：

| 范围规模 | 实际合法发牌 | 测试 | 实测结果 |
|---|---:|---|---|
| 每人 50 组合 | 99,117 | 精确，目标 0.5% | 1,500 迭代，约 31 秒；NashConv 0.08903 BB / 0.4451% pot |
| 每人 100 组合 | 691,826 | 精确，100 次性能跑 | 约 21 秒；残差约 6.1% pot，不能据此宣称完成高精度求解 |
| 每人 200 组合 | 超过 2,000,000 | 精确 | 明确拒绝超过预算 |
| 每人 200 组合 | 100k 训练＋100k 验证 | 近似，两个种子 | 约 12 秒/次；训练残差 0.35–0.37%，独立经验验证 4.67–4.90% |

最后一行正说明为什么必须同时展示验证残差，不能用训练残差宣称完整范围精度。性能记录见 `data/river-benchmark.json`、`data/river-quality-benchmark-result.json`、`data/river-sampled-benchmark.json`。这些是限定模型的本机测量，不是普遍运行时间或实战收益保证。

本引擎目前使用 CPU。4090 由 PokerLab 的并行权益与其他计算模块使用；不要把 CPU 求解标成 GPU 求解。

新算法对照见 `data/river-algorithm-v2-comparison.json`。同一二人加注教学场景 10,000 轮，交替 CFR+ 的精确 NashConv 为 0.000454% pot，同时 CFR+ 为 0.091389%；三人场景为 0.005296% 对 0.029360%。另一个五人场景 DCFR 优于交替 CFR+，因此保留算法选择，不宣称某一算法对所有多人局面占优。

## 编译与依赖

Windows x64 / C++17 / OpenMP，已附静态可执行文件。编译示例：

```
g++ -std=c++17 -O3 -DNDEBUG -fopenmp -static -static-libgcc -static-libstdc++ river-engine.cpp -o river-engine.exe
```

`json.hpp` 为 nlohmann/json 3.7.3，MIT，完整许可位于文件头。RiverLab 的博弈构建、CFR、最佳应对、EV 报告与测试为本项目新实现；没有复制 TexasSolver 的求解算法。

## 方法和规则依据

- [Tammelin, Solving Large Imperfect Information Games Using CFR+](https://arxiv.org/abs/1407.5042)：遗憾匹配正部、交替更新与加权平均的算法背景。不宣称完全复现论文所有工程选择。
- [Brown & Sandholm, Solving Imperfect-Information Games via Discounted Regret Minimization](https://arxiv.org/abs/1809.04040)：DCFR 的算法背景。
- [Brown & Sandholm, Superhuman AI for multiplayer poker](https://doi.org/10.1126/science.aay2400)：多人不具有二人零和的一般 Nash 收敛保证。
- [Poker TDA 官方规则](https://www.pokertda.com/view-poker-tda-rules/)：最小加注和累计短全下重开规则；本产品采用所述完整加注门槛。不同现金场所的特殊规则需另行建模。


独立外部策略评估入口：`evaluationOnly:true` 时必须通过 locks 提供全部信息集的完整策略，跳过训练及受约束 BR，仅运行精确原策略 EV、解除锁定的最佳应对和完整节点报告。缺任一策略行即拒绝。结果 `stats.iterations=0`，`stopReason=policy_evaluated`，engine 明确为独立策略评估器；不会冒充新的 CFR 训练。

终局缓存按实际人数存储 float64 收益，二人每格16字节、三人24字节、六人48字节，仍保持约3.6GB终局字节预算。`stats.terminalCacheBytes` 和 `terminalValuesPerDeal` 可审计实际占用。与旧固定六列缓存的二/三/六人及独立抽样验证比较，逐节点策略、动作EV、到达与BR完全一致；见 `data/river-compact-cache-validation.json`。
