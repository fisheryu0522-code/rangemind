# 完整导出策略的独立价值与最佳应对审计

`lib/hu-policy-evaluation.mjs` 不读取原生求解器内部 EV。它从导出的全部策略概率、真实行动树、范围权重、下注账本和公共牌，重新计算每个节点每个组合的动作 EV，以及信息集一致的最佳应对。策略质量只按这个导出策略的真实残差评价，不按动作频率猜测最优动作。

```js
import {evaluateHUPolicy} from './lib/hu-policy-evaluation.mjs';

const enriched = evaluateHUPolicy(result, {
  maxNodes:100000,
  maxHoleDeals:10000,
  maxNodeDealVisits:50000000,
  maxSeconds:120,
  computeBestResponse:true,
  mutate:false,
  onProgress:progress => {},
  signal
});
```

这是同步 CPU 计算，应放在工作线程中，父进程可终止线程取消。默认返回深拷贝；`mutate:true` 会在原对象上更新，失败时调用方应丢弃部分结果。完整图与发牌访问预算预检失败即拒绝，不给缺失信息集补“合理策略”。`capabilities.fullTree` 必须为 true，不能包含 `outOfScope`，不能缺任何合法公共牌分支。每个具有反事实可达性的私牌必须有动作概率，包括其自身既往策略令真实到达概率为零的组合。

## 精确条件概率

先枚举两人的联合私牌，并按独立范围权重乘积、牌张互斥条件归一。对每一组具体私牌，下一张公共牌的概率严格为 `1/(52−当前公共牌数−4)`；被公共牌或任何一人的私牌阻断的牌概率为零。不会拿全范围聚合的公开发牌概率来替代给定私牌的机会概率。

逐组合条件动作 EV 聚合只使用对手的先验权重和对手此前行动概率，自身范围先验在归一前去除，自身此前行动概率也排除。为了保持 RiverLab/TurnLab 的报告口径，`counterfactualReach` 字段仍包含根机会分布中的自身牌张先验；这只影响权重单位，不影响条件 EV。真实 `reach` 包含双方此前行动概率与机会概率。改变一个人自己的手牌先验，会改变其到达权重，不会改变其同一手牌在固定对手策略下的条件动作 EV。

所有终局从起始共同奖池、双方后续投入、退款和获奖资格独立结算；动作 EV 从当前节点开始计净收益，之前投入已沉没，fold=0。若双方全下后提前以终局表示，未发的河牌或转牌＋河牌仍完整枚举；双张未发公共牌的摊牌价值可以用无序组合求期望，与显式有序机会树相同。早弃牌终局不发多余公共牌。只有指定的起点已封顶固定抽水可被本评估器接受，HU 求解器当前仍只训练无抽水模型。

最佳应对在每个公开历史＋自己手牌的信息集上统一选择动作，不允许按对手私牌或尚未发出的公共牌分别挑选。它允许偏离原策略和原节点锁；这里只评价固定策略，不重新训练或伪造受约束收敛值。

## 输出

- 原 `nodes` 的组合 `probabilities` 保留给定策略；独立更新 `actionEV`、`ev`、`reach`、`counterfactualReach`。
- 节点动作 `ev` 是让已到达的整段范围强制选择此动作；`selectedEV` 是实际选择该动作的范围。两者不能混淆。
- `diagnostics.profileEV`、`bestResponseEV`、`gain`、`nashConv`、`nashConvPctPot` 都是独立值。HU 常用 exploitability 为 NashConv/2，另存 `exploitability` 和 `exploitabilityPctPot`。
- 原生 `reportedExploitabilityPctPot` 原样保留。`nativeReportDifferencePctPot` 比较相同 exploitability 口径，`nativeReportConsistent` 指差距小于 0.0001 个百分点。旧求解器错误报告不会被悄悄覆盖成“正确”。
- `policyEvaluation` 记录实际联合私牌数、访问数、终局发牌枚举数、耗时、精度与算法假设。
- 成功后 `capabilities.actionEV`、`studyCards` 为 true；是否将结果用于训练，仍应由产品依据独立残差和范围假设决定。它不自动声明支持节点锁定或逐项 EV 拆解。

## 发现并验证的原生机会概率错误

初始接入的原生 CFR 和 BR 都把机会分母写成 `deck−board−2`，随后又同时排除双方私牌。这让进入未来街的路径丢失概率质量，而早弃牌路径没有相同折扣，因而不仅是显示单位差异。

无下注、双方各一手已知牌的独立反例中：

| 牌面 | 正确零和 EV | 原生旧 EV | 旧/正确比例 |
|---|---:|---:|---:|
| Ks7h2d | 3.7272727 BB | 3.4135065 BB | `(45/47)*(44/46)` |
| Ks7h2d9c | 4.3181818 BB | 4.1304360 BB | `44/46` |
| Ks7h2d9c3s | 5 BB | 5 BB | 1 |

修正版 `1.1.0-joint-chance` 将两处改为 `deck−board−4`，已通过 7 个完整模型的原生 BR 与独立 BR 比较：三街纯过牌、加权范围河牌加注、转牌早弃牌/加注/全下、31,124 节点浅筹码翻牌，以及 116,580 节点跨街多时点下注全下。最大每人 BR 差为 2.28×10⁻⁶ BB，原生单精度与日志舍入可解释此量级差异。旧版未来街求解的原生精度声明无效，应重新求解；旧导出策略本身仍可被本模块诚实评价，但低原生报告值不能当作该策略精度。

证据：`data/hu-native-chance-audit.json`、`data/hu-corrected-policy-benchmark.json`。正确二进制 SHA256 和源码包见该引擎 provenance。

## 交叉验证

运行 `node --test tests/hu-policy-evaluation.test.mjs`。9 项测试将相同策略与 RiverLab/TurnLab 对照，所有组合动作 EV、真实/反事实到达、范围平均 EV、每人 BR 均在 10⁻⁸ BB 容差内一致；测试还覆盖篡改公开聚合频率、自身先验权重变化、封顶抽水、零自身到达、缺策略/缺机会分支、跨街全下提前结算及旧原生报告差异。

在本机 31,124 节点、4 个合法联合私牌的完整翻牌导出上，独立评估和 BR 约 0.32 秒，实际 104,976 次节点－私牌访问。该速度不代表大范围完整三街的普遍运行时间；预算超限必须保留策略并明确说明未做独立 EV/BR 评估。
