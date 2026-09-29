> Source release note: this historical engine document describes the validated private Windows installation. This repository contains source only; no executable, model, PTX, evaluator data or benchmark data directory is included. Follow [the source build guide](../../docs/BUILD.md). Measurements refer to RTX 4090 / i9-14900KF, not DGX Spark.

# TurnLab 1.3 — 完整转牌至河牌的本地策略求解

TurnLab 解决指定转牌公共牌、各人加权范围与筹码、两街有限下注树中的不完全信息博弈。它真正优化未来河牌决策，既不把摊牌权益当作策略，也不让转牌决策预知河牌。默认采用交替 CFR+，报告的信息集最佳应对使用完整合法发牌枚举。

## 输入与范围

```js
import {prepareTurnGame,solveTurnGame} from './lib/turn-engine.mjs';

const result = await solveTurnGame({
  board:'Ks7h2h9c', pot:20,
  players:[
    {id:'bb', position:'BB', range:'AcKd,AhQh', stack:30},
    {id:'hj', position:'HJ', range:'KcQd,QhJh', stack:30},
    {id:'btn',position:'BTN',range:'9h9s,JhTh', stack:20}
  ],
  toAct:0, riverToAct:0,
  sizes:[50], raiseSizes:[50], maxRaises:0,
  riverSizes:[50], riverRaiseSizes:[50], riverMaxRaises:0,
  allIn:false, minBet:1,
  algorithm:'alternating-cfr-plus',
  iterations:2000, averagingDelay:50, checkEvery:100,
  accuracy:0.5, threads:12, maxSeconds:600,
  chanceMode:'exact', rake:0
});
```

支持 2–4 位仍在底池中的玩家，转牌起点的剩余筹码和共同初始底池。四人支持针对受控范围研究，已验证每人六个明确组合的完整两街模型；不意味着任意宽范围或任意深树均能运行。`riverToAct` 是河牌应最先行动的座位；该人已弃牌或全下时自动顺延。每街可分别选最多两个下注尺寸、两个加注尺寸、0–2 次加注上限。`allIn` 决定是否额外包含全下尺寸，合法跟注全下仍会保留。输入范围可带频率权重。资源预算不足明确拒绝，不自动抽样、缩树或切换权益计算。

`pot` 为起始毛底池，各玩家均有资格争夺；此前已产生的独立边池不能合并输入。`stack` 为转牌起点剩余筹码，本街及河牌新增投入会分别记录并一同结算真实边池。短全下、最小加注和未跟注退款与 RiverLab 共用相同规则口径。

默认无抽水，也支持 `rake>0, rakeCap>0` 且 `pot*rake/100 >= rakeCap` 的起点已封顶模型：pot 中尚未扣除这笔费用，最终仅从共同起始奖池扣一次 cap。下注尺寸仍使用毛底池。未封顶、额外附加收费、平台特殊规则不在当前模型内；不会猜测平台费率。

## 未来机会与信息集

根机会分布完整枚举所有无碰撞私牌，以及每组私牌下全部尚未出现的河牌。实现中可预先记录未来牌，但转牌节点只以「自己的私牌＋公开行动历史」索引策略。河牌出现后才将这张牌加入公开历史。以后弃牌的玩家已经拿到的私牌仍然阻断河牌，这是完整发牌分布的一部分。

跨街公开节点为 `actor:-2,chance:true`。其 `actions` 为可能河牌，包含 `type:'deal',card,label,frequency,childId`。`frequency` 是给定到达该公开历史的范围、所有人的历史策略及牌张阻断后的条件概率，不应强行显示为均匀。机会节点不提供玩家动作 EV；无法到达的频率为 null。

行动节点的 `board` 为可读字符串，`street` 为 turn 或 river，`contributions` 累积两街投入，`streetContributions` 仅本街投入。河牌所有人过牌或下注完成后进入终局；若转牌已全下且再无策略决策，终局的 EV 直接精确积分全部未来河牌。

## 策略与证据

结果协议与 [RiverLab](../RiverLab/README.md) 相同：各节点各组合动作概率、条件动作 EV、真实到达权重、信息集一致 BR、每人单方偏离收益、NashConv，以及受锁定约束和解除锁定两种残差。当前节点动作 EV 包含未来河牌完整策略价值，并扣除从当前节点起新增的投入；之前投入是沉没成本，所以 fold=0。

根边际在 `chance.marginals`，当前公开节点后验为 `combo.reach/node.reach`。不能用未处理牌张互斥的原始范围权重代替根先验。NashConv 百分比分母为毛初始 pot；所有玩家根 EV 总和为 `diagnostics.constantSum = pot−fixedRake`。

默认交替 CFR+，每轮对每人分别完整更新；`stats.playerUpdatePasses` 为 N×iterations。可显式设同时 CFR+ 或 DCFR(1.5,0,2)。多人 CFR 没有一般的 Nash 收敛保证，残差可能不单调；低残差只证明当前范围和有限动作树的低单方改进空间，不能证明真实实战收益。

## 无损性能优化与预算

河牌公开后，每个子树只保留与该河牌相容的发牌组；无争夺终局只缓存一份收益。这样省去原先「每个河牌节点 × 所有其他河牌」的冗余矩阵，没有抽象或合并任何真实私牌、公共牌、信息集。旧密集实现与新分组实现的逐组合概率、动作 EV、到达率和 BR 的最大数值差为 0，详见 `data/turn-grouping-validation.json`。

严格零反事实到达剪枝也与未剪枝版本对照一致；不使用小概率阈值剪枝。当前 CPU、float64，默认 12 线程。不能将其标记为 RTX4090 求解。

默认最多 1,000,000 个联合私牌＋河牌事件，可显式提高至 3,000,000；公开节点默认 20,000，可显式提高至 50,000，报告最多 300,000 个信息集。终局缓存按实际玩家数 N 保存 N 个 float64 收益，预算最多 48 亿字节；除此以外还有输入、策略、诊断临时数组和 JSON 报告内存。迭代访问预算默认 2000 亿，可提高到 1 万亿；交替算法按 N 次玩家更新计费。可指定 1–1,000,000 轮，但始终还须满足访问预算，未提高默认轮数。终止时间为迭代软上限，完整 BR 与结果报告还需时间；外层设有额外硬超时和取消进程支持。

## 本机测量与验证

运行 `node --test tests/turn-engine.test.mjs tests/turn-four.test.mjs`。16 项测试包含完整机会概率、全过牌与直接摊牌对照、两街投入/边池、两街加注、未来牌隐藏反例、独立逐发牌策略 EV、双街穷举纯信息集策略 BR、不可达组合、预算、交替更新和一次封顶抽水。新增四人测试覆盖 40 张无碰撞河牌、完整树逐路径 EV、每个座位的条件动作 EV、多层不等筹码边池/退款，以及各人信息集纯策略穷举 BR。测试清单与源码/二进制 SHA256 见 `data/turn-validation.json`。扩展前后的两人、三人全部节点策略、EV 与 BR 数值差为零，见 `data/turn-four-compatibility-validation.json`。

i9-14900KF、12 线程、3 人、每街 50% pot 单尺寸、两街均无再加注、无额外全下尺寸、7,417 个公开节点、20 BB 初始底池；这些基准使用合成范围，不能据此保证任意实战范围的相同收敛时间：

| 每人组合 | 完整发牌事件 | 终局缓存 | 交替 CFR+ | 精确 NashConv |
|---|---:|---:|---:|---:|
| 20 | 314,160 | 437 MB | 300 轮，27.89 秒 | 0.07244 BB / 0.36219% pot |
| 40 | 2,260,188 | 3,146 MB | 100 轮，74.44 秒 | 0.06033 BB / 0.30167% pot |

数据见 `data/turn-alternating-benchmark.json`，含完整输入、根策略、所有 BR 指标及耗时。这里耗时为原生完整计算与报告，不包括 JS 组装与文件交接。同一 20 组合模型的同时 CFR+ 2000 轮后残差仍为 0.55444%；算法选择有实际影响，但没有单一算法对所有多人场景保证更优。

四人预设 `live-turn-fourway` 使用每人六个明确组合、20 BB 初始底池、不等筹码 12/18/25/30 BB；转牌 50% pot 下注及加注一次，河牌 50% pot 下注，均不额外加入全下尺寸（合法跟注全下仍保留）。398 组兼容私牌各对应 40 张河牌，共 15,920 个精确机会事件、47,748 个公开节点、135,678 个信息集；终局缓存 272 MB。预设最大 2000 轮、原始目标 0.1% pot，交替 CFR+ 在第 250 轮达到 0.0726636684% pot，完整原生计算及报告 8.02 秒。`data/turn-four-preset-result.json` 保存全树，`data/turn-four-preset-benchmark.json` 保存输入与诊断。这只是该受控模型的实测残差，不能外推为任意四人范围的精度或运行时间，也不提供多人 Nash 收敛保证。

## 编译

```
g++ -std=c++17 -O3 -DNDEBUG -fopenmp -static -static-libgcc -static-libstdc++ turn-engine.cpp -o turn-engine.exe
```

JSON 解析器引用 `../RiverLab/json.hpp`，nlohmann/json 3.7.3，MIT。TurnLab 的双街树、机会分组、CFR、BR、EV 和测试是本项目原创；没有复制 TexasSolver 算法。方法论文与下注规则来源见 RiverLab 文档。


独立外部策略评估入口：`evaluationOnly:true` 时必须通过 locks 提供全部信息集的完整策略，跳过训练及受约束 BR，仅运行精确原策略 EV、解除锁定的最佳应对和完整节点报告。缺任一策略行即拒绝。结果 `stats.iterations=0`，`stopReason=policy_evaluated`，engine 明确为独立策略评估器；不会冒充新的 CFR 训练。
