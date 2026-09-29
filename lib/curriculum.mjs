import {cards, cardText, range, rankHand} from './poker.mjs';

export const CURRICULUM_VERSION = '2026.09.28.2';
const clone=x=>JSON.parse(JSON.stringify(x));
const fmt=(n,d=3)=>Number(n.toFixed(d));
const finite=Number.isFinite;
const percent=n=>`${fmt(n*100,2)}%`;

/** Exact conditional river EV, measured at the decision (prior sunk costs excluded).
 * It is a response-model experiment, not a Nash-equilibrium solver. */
export function raiseExperiment({pot=40,bet=30,raiseTo=90,worseCall=1,board='Ks 7h 2h 9c 3s',hero='Ac Kd'}={}) {
  if(![pot,bet,raiseTo,worseCall].every(finite)||pot<=0||bet<=0||raiseTo<2*bet||worseCall<0||worseCall>1)throw Error('需要正底池、正下注，至少最小加注到，并且跟注频率为 0–1。');
  const b=cards(board,[5]),h=cards(hero,[2]);if(new Set([...b,...h]).size!==7)throw Error('手牌与公共牌重复。');
  const groups=[{id:'value',name:'比 Hero 强的暗三条',text:'99,77,22'},{id:'worse',name:'比 Hero 弱的 Kx',text:'KQ,KJ'},{id:'bluff',name:'指定错失听牌',text:'AhQh,AhJh,AhTh,QhJh,JhTh,Th8h,8h6h'}];
  const hr=rankHand([...b,...h]),rows=[],summary=[];
  let total=0,equityMass=0,callEV=0,raiseEV=0;
  for(const group of groups) {
    let r;try{r=range(group.text,[...b,...h]);}catch{r={live:[]};}
    let mass=0,callSum=0,raiseSum=0,winSum=0;
    for(const c of r.live) {
      const cr=rankHand([...b,...c.cards]),equity=hr>cr?1:hr===cr?.5:0;
      const callProbability=group.id==='value'?1:group.id==='worse'?worseCall:0;
      const call=equity*(pot+2*bet)-bet;
      const foldBranch=pot+bet;
      const calledBranch=equity*(pot+2*raiseTo)-raiseTo;
      const raise=(1-callProbability)*foldBranch+callProbability*calledBranch;
      rows.push({combo:c.label,group:group.id,weight:c.weight,equity,opponentCall:callProbability,opponentFold:1-callProbability,callEV:call,raiseEV:raise,foldBranchEV:foldBranch,calledBranchEV:calledBranch});
      total+=c.weight;mass+=c.weight;equityMass+=equity*c.weight;callEV+=call*c.weight;raiseEV+=raise*c.weight;callSum+=call*c.weight;raiseSum+=raise*c.weight;winSum+=equity*c.weight;
    }
    summary.push({id:group.id,name:group.name,combos:mass,weighted:mass,equity:mass?winSum/mass:null,opponentCall:group.id==='value'?1:group.id==='worse'?worseCall:0,callContribution:callSum,raiseContribution:raiseSum});
  }
  if(!total)throw Error('没有合法对手组合。');
  summary.forEach(s=>{s.callContribution/=total;s.raiseContribution/=total;});
  return {kind:'conditional-river-ev',exact:true,pot,bet,raiseTo,worseCall,board,hero,total,equity:equityMass/total,callEV:callEV/total,raiseEV:raiseEV/total,foldEV:0,best:raiseEV>callEV?'raise':'call',rows,groups:summary,assumptions:['河牌、无抽水、单挑，Hero 与对手均有足够筹码。','对手暗三条始终跟加注，指定错失听牌始终弃牌，较弱 Kx 的跟注频率由滑块指定。','对手在此实验中不再加注；改变响应模型需要重新计算。','所有范围权重为 1；结果是固定响应下的条件 EV，不是 GTO 建议。'],formula:{call:'equity × (pot + 2 × bet) − bet',raise:'Σ weight × [foldProbability × (pot + bet) + callProbability × (showdownShare × (pot + 2 × raiseTo) − raiseTo)] / totalWeight'}};
}

export function riverResponseExperiment({pot,bet,raiseTo,board,hero,groups,reraiseTo=0,heroVsReraise='fold'}) {
  if(![pot,bet,raiseTo].every(finite)||pot<=0||bet<=0||raiseTo<2*bet)throw Error('河牌响应实验的底池/下注/加注金额无效。');
  const b=cards(board,[5]),h=cards(hero,[2]);if(new Set([...b,...h]).size!==7)throw Error('已知牌重复。');
  if(!Array.isArray(groups)||!groups.length)throw Error('请提供互不重叠的响应范围。');
  if(!['call','fold'].includes(heroVsReraise))throw Error('面对再加注需指定跟注或弃牌计划。');
  const hr=rankHand([...b,...h]),seen=new Set(),rows=[],summary=[];let mass=0,eq=0,cev=0,rev=0;
  for(const g of groups){
    const call=Number(g.call??0),raise=Number(g.raise??0),fold=1-call-raise;
    if(![call,raise,fold].every(x=>finite(x)&&x>=0&&x<=1))throw Error('响应概率无效或合计超过 100%。');
    if(raise>0&&(!finite(reraiseTo)||reraiseTo<2*raiseTo-bet))throw Error('再加注到金额未达到最小完整加注。');
    let r;try{r=range(g.range,[...b,...h]);}catch(e){if(/所有组合/.test(e.message))r={live:[]};else throw e;}
    let groupMass=0,groupEquity=0,groupRaise=0;
    for(const c of r.live){
      if(seen.has(c.label))throw Error(`响应组范围重叠：${c.label}`);seen.add(c.label);
      const cr=rankHand([...b,...c.cards]),share=hr>cr?1:hr===cr?.5:0,callEV=share*(pot+2*bet)-bet;
      const called=share*(pot+2*raiseTo)-raiseTo,reraised=heroVsReraise==='fold'?-raiseTo:share*(pot+2*reraiseTo)-reraiseTo;
      const raiseEV=fold*(pot+bet)+call*called+raise*reraised;
      rows.push({combo:c.label,group:g.id,weight:c.weight,share,fold,call,raise,callEV,raiseEV,branches:{fold:pot+bet,call:called,raise:reraised}});mass+=c.weight;eq+=share*c.weight;cev+=callEV*c.weight;rev+=raiseEV*c.weight;groupMass+=c.weight;groupEquity+=share*c.weight;groupRaise+=raiseEV*c.weight;
    }
    summary.push({id:g.id,label:g.label||g.id,weighted:groupMass,equity:groupMass?groupEquity/groupMass:null,fold,call,raise,raiseContribution:groupRaise});
  }
  if(!mass)throw Error('没有合法响应组合。');for(const g of summary)g.raiseContribution/=mass;
  return {exact:true,kind:'conditional-river-response',pot,bet,raiseTo,reraiseTo,heroVsReraise,board,hero,total:mass,equity:eq/mass,callEV:cev/mass,raiseEV:rev/mass,foldEV:0,rows,groups:summary,best:Object.entries({fold:0,call:cev/mass,raise:rev/mass}).sort((a,b)=>b[1]-a[1])[0][0]};
}

export function posteriorRangeExperiment({board,hero='',groups}) {
  const b=cards(board,[3,4,5]),h=cards(hero,[0,2]);if(new Set([...b,...h]).size!==b.length+h.length)throw Error('已知牌重复。');
  const seen=new Set(),rows=[];let total=0,prior=0;
  for(const g of groups){if(!finite(g.frequency)||g.frequency<0||g.frequency>1)throw Error('到达频率必须为 0–1。');let r;try{r=range(g.range,[...b,...h]);}catch(e){if(/所有组合/.test(e.message))r={live:[],weighted:0,total:range(g.range).total};else throw e;}for(const c of r.live){if(seen.has(c.label))throw Error('范围组不能重叠。');seen.add(c.label);}const weighted=r.live.reduce((sum,c)=>sum+c.weight,0),mass=weighted*g.frequency;prior+=weighted;total+=mass;rows.push({...g,count:r.live.length,weighted,removed:r.total-r.live.length,mass});}
  if(!total)throw Error('该行动没有可达组合。');return {prior,total,rows:rows.map(r=>({...r,posterior:r.mass/total}))};
}

export function sidePotLayers(contributions,folded=[]) {
  if(!Array.isArray(contributions)||contributions.length<2||contributions.length>9||contributions.some(x=>!finite(x)||x<0))throw Error('投入数组需要 2–9 个非负数。');
  if(folded.length&&folded.length!==contributions.length)throw Error('弃牌标记数量不匹配。');
  const levels=[...new Set(contributions.filter(x=>x>0))].sort((a,b)=>a-b),pots=[],refunds=[];let previous=0;
  for(const level of levels){const contributors=contributions.map((v,i)=>v>=level?i:-1).filter(i=>i>=0),amount=(level-previous)*contributors.length;previous=level;if(contributors.length===1){refunds.push({player:contributors[0],amount});continue;}const eligible=contributors.filter(i=>!folded[i]);if(!eligible.length)throw Error('底池层没有未弃牌玩家；请检查输入是否合法。');pots.push({cap:level,amount,contributors,eligible});}
  const contributed=contributions.reduce((a,b)=>a+b,0),returned=refunds.reduce((a,b)=>a+b.amount,0),total=pots.reduce((a,b)=>a+b.amount,0);
  return {pots,refunds,contributed,total,returned,conserved:Math.abs(total+returned-contributed)<1e-8};
}

const choice=(id,label)=>({id,label});
const evidence=(id,label,value,unit,calculation)=>({id,label,value,unit,calculation});
const baseScenario={title:'河牌价值加注实验',format:'study',unit:'BB',board:'Ks 7h 2h 9c 3s',hero:'Ac Kd',heroSeat:1,pot:40,toAct:0,players:[{id:'v',name:'对手',position:'BB',stack:160,range:'99,77,22,KQ,KJ,AhQh,AhJh,AhTh,QhJh,JhTh,Th8h,8h6h'},{id:'h',name:'Hero',position:'BTN',stack:160,range:'AcKd'}]};
const CHOICES_FCR=[choice('fold','弃牌'),choice('call','跟注 30 BB'),choice('raise','加注到 90 BB')];
const RAISE_REASONS=[choice('worse-continues','较差成牌继续付钱的频率决定薄价值加注收益'),choice('more-folds','对手弃牌越多，加注一定越赚钱'),choice('equity-only','Hero 权益高，所以必然应该加注'),choice('response-model','需要核对对手跟注和再加注的响应假设')];

function raiseLesson(id,worseCall,variantOf=null) {
  const r=raiseExperiment({worseCall});
  return {id,title:worseCall===1?'高权益为什么仍不足以决定加注？':worseCall===0?'对手弃牌更多，加注可能更差':worseCall===.25?'迁移：较差 Kx 只跟四分之一': '迁移：较差 Kx 跟四分之三',theme:'价值来源',skill:'raise-response',family:'river-value-raise',variantOf,difficulty:'进阶',minutes:4,scenario:baseScenario,prompt:`河牌底池原为 40 BB，对手下注 30 BB。你的 Ac Kd 对其下注范围权益为 ${percent(r.equity)}。对手 9 个暗三条始终跟加注，7 个指定错失听牌始终弃牌；16 个较差 Kx 以 ${percent(worseCall)} 的频率跟加注。没有再加注、无抽水。你在这个响应模型下选什么？`,choices:CHOICES_FCR,reasonChoices:RAISE_REASONS,answer:r.best,acceptedAnswers:[r.best],correctReasons:['worse-continues','response-model'],misconceptions:{'more-folds':'弃掉的是你本来就领先的牌时，更多弃牌可能减少价值。','equity-only':'权益描述摊牌结果；行动 EV 还取决于对手怎样响应。'},actionEV:{fold:0,call:r.callEV,raise:r.raiseEV},evTolerance:1e-6,explanation:`跟注 EV 为 ${fmt(r.callEV)} BB，加注到 90 BB 的 EV 为 ${fmt(r.raiseEV)} BB。Hero 的摊牌权益不变，但较差 Kx 是否付出额外 60 BB 改变了加注收益。加注赶走指定诈唬得到当前 70 BB 底池；被暗三条跟注时净输 90 BB；被较差 Kx 跟注时净赢 130 BB。`,takeaway:'先识别加注在向哪些牌收钱，再检查它们实际会怎样响应。',assumptions:r.assumptions,evidence:[evidence('weighted-combos','对手合法组合',r.total,'组合','9 暗三条 + 16 较差 Kx + 7 指定错失听牌'),evidence('equity','Hero 摊牌权益',r.equity,'比例','23 / 32'),evidence('call-ev','跟注 EV',r.callEV,'BB','23/32 × 100 − 30'),evidence('raise-ev','加注 EV',r.raiseEV,'BB',`[7×70 + 16×(${1-worseCall}×70 + ${worseCall}×130) − 9×90] / 32`)],nextExperiment:'保持范围不变，只改变较差 Kx 的跟加注频率，先预测 EV 何时交叉。',fieldTask:'复盘下一次薄价值加注时，写下至少一类会继续付钱的较差牌。'};
}

const LESSONS = [
  raiseLesson('raise-value-100',1),
  raiseLesson('raise-value-0',0,'raise-value-100'),
  raiseLesson('raise-value-25',.25,'raise-value-100'),
  raiseLesson('raise-value-75',.75,'raise-value-100'),
  {
    id:'raise-crossover',title:'把结论变成可观察的临界条件',theme:'对手假设',skill:'raise-response',family:'river-value-raise',variantOf:'raise-value-100',difficulty:'进阶',minutes:4,scenario:baseScenario,
    prompt:'沿用价值加注实验：跟注 EV = 41.875 BB，加注 EV = 25 + 30q BB；q 是较差 Kx 面对加注的跟注率。在这个模型中，加注开始优于跟注的临界 q 是多少？',choices:[choice('25','25%'),choice('50','50%'),choice('56.25','56.25%'),choice('71.875','71.875%')],reasonChoices:[choice('compare-ev','比较两个行动的收益差，并解出对手响应阈值'),choice('equity','用 Hero 权益直接作跟注率阈值')],answer:'56.25',correctReasons:['compare-ev'],explanation:'令 25 + 30q = 41.875，可得 q = 0.5625。这个数是你需要验证的对手行为条件；它没有说明真实对手一定达到该频率。',takeaway:'优质结论应包含“什么条件变化会让我改动作”。',evidence:[evidence('crossover','响应临界点',.5625,'比例','(41.875 − 25) / 30')],assumptions:['仍采用既定无再加注、无抽水的河牌响应模型。'],nextExperiment:'给对手跟注率一个合理区间；如果区间跨过 56.25%，保存两个策略假设。',fieldTask:'记录结果会反转的条件，避免只保存一个动作。'
  },
  {
    id:'weighted-bluffs',title:'七个诈唬候选，不等于七个诈唬组合',theme:'范围重建',skill:'range-weighting',family:'weighted-range',difficulty:'进阶',minutes:3,
    scenario:{...baseScenario,title:'诈唬到达频率',players:[{...baseScenario.players[0],range:'99,77,22,AhQh:0.5,AhJh:0.5,AhTh:0.5,QhJh:0.5,JhTh:0.5,Th8h:0.5,8h6h:0.5'},baseScenario.players[1]]},
    prompt:'河牌原底池 40 BB，对手下注 30 BB。Ac Kd 输给 9 个价值组合，赢过 7 个诈唬候选。价值组合以 100% 到达此节点，诈唬候选各以 50% 到达。忽略加注、无抽水，跟注 EV 是多少？',choices:[choice('-2','−2 BB'),choice('13.75','+13.75 BB'),choice('5','+5 BB')],reasonChoices:[choice('weighted','用到达频率加权，再归一化组合'),choice('raw','所有列出的候选都按一个完整组合计算')],answer:'-2',correctReasons:['weighted'],explanation:'加权诈唬量是 3.5，价值量是 9；Hero 权益 = 3.5/12.5 = 28%。跟注 EV = 28% × 100 − 30 = −2 BB。把“可能拥有”误当作“总会这样打”，会把结果错算成 +13.75 BB。',takeaway:'范围要表达“有什么”，也要表达“以多大频率走到这里”。',evidence:[evidence('bluff-mass','加权诈唬量',3.5,'组合','7 × 50%'),evidence('equity','Hero 权益',.28,'比例','3.5 / (9 + 3.5)'),evidence('call-ev','跟注 EV',-2,'BB','0.28 × (40 + 30 + 30) − 30')],assumptions:['Hero 击败所有指定诈唬，输给所有指定价值。','仅比较立即摊牌的 call/fold；不含加注策略。'],nextExperiment:'把诈唬到达频率从 50% 改为 60%，先预测跟注 EV 是否反转。',fieldTask:'复盘时为不确定的诈唬候选写一个频率区间。'
  },
  {
    id:'blocker-combos',title:'自己的牌怎样改变对手组合？',theme:'组合数',skill:'card-removal',family:'card-removal',difficulty:'进阶',minutes:3,scenario:baseScenario,
    prompt:'公共牌 Ks 7h 2h 9c 3s，你持有 Ac Kd。对手范围中的 AK（含同花、非同花）还剩多少合法组合？这是对手的 AK，不是你自己这手 AK 的出现频率。',choices:[choice('16','16'),choice('12','12'),choice('8','8'),choice('6','6')],reasonChoices:[choice('remaining','剩余 3 张 A × 2 张 K'),choice('board-only','只移除公共牌上的 Ks'),choice('subtract','原始 16 随意减去三张已知牌')],answer:'6',correctReasons:['remaining'],explanation:'Ks 在公共牌上，Kd 在你手上，对手只剩 Kc、Kh；Ac 在你手上，剩余 A 为 Ad、Ah、As，因此 3 × 2 = 6。范围对范围求解时不能把你的聚焦手牌当成整个 Hero 范围都固定持有；这六个组合只用于条件于该手牌的观察。',takeaway:'区分公共牌移除、聚焦手牌移除和范围之间的联合互斥。',evidence:[evidence('remaining-aces','剩余 A',3,'张','Ad, Ah, As'),evidence('remaining-kings','剩余 K',2,'张','Kc, Kh'),evidence('combos','合法 AK',6,'组合','3 × 2')],assumptions:['标准 52 张牌；Hero 底牌已知。'],nextExperiment:'把 Hero 的 Kd 改成 Qd，重新计算对手 AK。',fieldTask:'对 blocker 的第一步解释要能列出具体被移除组合。'
  },
  {
    id:'blocker-bluffcatch',title:'“有 A blocker”为什么可能降低跟注价值？',theme:'阻断与响应',skill:'card-removal',family:'card-removal',variantOf:'blocker-combos',difficulty:'高级',minutes:5,
    scenario:{...baseScenario,title:'阻断错失听牌',board:'Qs 9h 2h 3c 7d',hero:'Ah Qd',players:[{...baseScenario.players[0],range:'99,77,22,AhKh,AhJh,AhTh,KhJh,KcJc'},{...baseScenario.players[1],range:'AhQd,AcQd'}]},
    prompt:'河牌 Qs 9h 2h 3c 7d，原底池 40，对手下注 30。对手价值范围 99/77/22，诈唬候选 AhKh/AhJh/AhTh/KhJh/KcJc，全部权重 1。比较 AhQd 与 AcQd，在这个明确范围下哪手牌的跟注 EV 更高？',choices:[choice('club','Ac Qd'),choice('heart','Ah Qd'),choice('equal','两手一样，都是顶对 A 踢脚')],reasonChoices:[choice('remove-bluffs','Ah 移除三个 Hero 本来能击败的诈唬组合'),choice('rank','两手牌的摊牌牌型相同，所以对范围的权益也相同'),choice('always-blocker','持有 A blocker 总有利于防守')],answer:'club',correctReasons:['remove-bluffs'],explanation:'9 个价值组合都保留。AcQd 面对 5 个诈唬，权益为 5/14，跟注 EV ≈ +5.714 BB；AhQd 移除 3 个诈唬，只剩 2/11 权益，跟注 EV ≈ −11.818 BB。阻断效果必须相对于具体行动范围评价。',takeaway:'作为诈唬捕手，别只问阻断了什么强牌，也问自己移除了多少诈唬。',evidence:[evidence('club-call-ev','AcQd 跟注 EV',5/14*100-30,'BB','5/14 × 100 − 30'),evidence('heart-call-ev','AhQd 跟注 EV',2/11*100-30,'BB','2/11 × 100 − 30'),evidence('removed-bluffs','Ah 移除诈唬',3,'组合','AhKh, AhJh, AhTh')],assumptions:['对手每个指定合法组合等权下注；并非宣称真实对手会如此构造范围。','仅比较 call/fold，未研究加注。'],nextExperiment:'增加被 Ah 阻断的价值牌，再检查效果是否反转。',fieldTask:'每次写“blocker 好”，同时记录它移除了哪些价值和哪些诈唬。'
  },
  {
    id:'bayes-action-range',title:'看到下注后，必须重新归一化范围',theme:'范围重建',skill:'range-weighting',family:'weighted-range',variantOf:'weighted-bluffs',difficulty:'进阶',minutes:4,
    prompt:'条件于当前已知牌的街起点加权范围共 100：强牌 20、听牌 30、边缘牌 50。它们分别以 80%、60%、10% 下注。观察到下注后，强牌在下注范围中的占比是多少？',choices:[choice('20','20%'),choice('41.026','约 41.03%'),choice('80','80%'),choice('16','16%')],reasonChoices:[choice('bayes','先计算每类到达下注节点的质量，再除以总下注质量'),choice('copy','继续使用街起点范围比例')],answer:'41.026',correctReasons:['bayes'],explanation:'进入下注节点的质量分别是 16、18、5，总计 39。强牌占比为 16/39 ≈ 41.03%。80% 是强牌的下注概率，不能倒过来当作“下注后有强牌”的概率。',takeaway:'P(行动 | 牌) 与 P(牌 | 行动) 是两件事。',evidence:[evidence('bet-mass','下注加权质量',39,'组合','20×0.8 + 30×0.6 + 50×0.1'),evidence('strong-posterior','下注后强牌占比',16/39,'比例','16 / 39')],assumptions:['三类互斥且覆盖范围；已知牌移除已在起点质量中处理。'],nextExperiment:'只提高边缘牌下注率，再预测下注范围权益的方向。',fieldTask:'记录某次行动后，哪些组合权重明显改变。'
  },
  {
    id:'range-balance-check',title:'把所有强牌拿去下注后，检查什么？',theme:'动态平衡',skill:'whole-range-policy',family:'range-policy',difficulty:'高级',minutes:4,
    prompt:'你把某节点的全部 10 个最强组合从过牌范围移到下注范围，其他 90 个组合仍过牌。以下哪条结论是现有信息能够支持的？',choices:[choice('resolve','过牌分支不再包含这 10 个强组合；需要检查对手响应及整套策略损失'),choice('always-bad','这个调整必然很差，任何范围都必须保留坚果'),choice('always-good','下注价值增加了，所以整体 EV 必然上升')],reasonChoices:[choice('policy','一个分支的变化会改变其他分支的到达范围和对手最佳响应'),choice('heuristic','牢记每条线都必须放相同数量的坚果即可')],answer:'resolve',correctReasons:['policy'],explanation:'可以确定的是过牌范围组成改变了。整体好坏还取决于牌面、筹码、对手能否施压、其响应以及你其余组合的策略。需要重新求解或评估完整策略；不能从“过牌没有坚果”单独证明损失。',takeaway:'动态平衡要检查整段策略的后果，不能把一句范围口号当作结论。',evidence:[evidence('removed-nuts','过牌范围移出的强组合',10,'组合','给定策略修改'),evidence('remaining-check','剩余过牌组合',90,'组合','100 − 10')],assumptions:['只有范围分配信息，没有各组合 EV 或对手响应。'],nextExperiment:'在研究树中锁定这个分配，对比重算前后各分支收益与可被利用程度。',fieldTask:'保存一个“单手看似合理，但其余范围被削弱”的真实案例。'
  },
  {
    id:'multiway-behind',title:'身后玩家改变了跟注的收益树',theme:'多人底池',skill:'multiway-response',family:'multiway-branches',difficulty:'高级',minutes:5,
    prompt:'河牌原底池 90，前位下注 30，你考虑跟注 30，身后还有一人。给定联合响应模型：50% 身后弃牌，此分支 Hero 权益 40%；30% 身后跟注，此分支 Hero 权益 20%；20% 身后加注，Hero 总是弃牌。无抽水，前位在前两分支不再投入。跟注的条件 EV 是多少？',choices:[choice('10.8','+10.8 BB'),choice('30','+30 BB'),choice('6','+6 BB'),choice('-10.8','−10.8 BB')],reasonChoices:[choice('branches','按身后弃牌、跟注、加注的互斥分支加权'),choice('heads-up','只用对前位的单挑权益和底池赔率'),choice('independent','把每位玩家的个人弃牌率相乘，无需检查相关性')],answer:'10.8',correctReasons:['branches'],explanation:'身后弃牌：0.4×150−30=30；身后跟注：0.2×180−30=6；身后加注后你弃牌：−30。总 EV = 0.5×30 + 0.3×6 + 0.2×(−30) = 10.8 BB。这里的分支概率和条件权益是题目给定的联合模型，不是用独立性假设推出来的。',takeaway:'跟注不是自动买到摊牌；身后行动必须进入收益树。',evidence:[evidence('fold-branch','身后弃牌分支 EV',30,'BB','0.4 × (90+30+30) − 30'),evidence('call-branch','身后跟注分支 EV',6,'BB','0.2 × (90+30+30+30) − 30'),evidence('raise-branch','身后加注分支 EV',-30,'BB','Hero 投入 30 后弃牌'),evidence('total-ev','条件跟注 EV',10.8,'BB','0.5×30 + 0.3×6 + 0.2×(−30)')],assumptions:['分支概率条件于 Hero 已选择跟注；并非真实牌局求解输出。','给定所有后续响应与权益，无抽水，无边池。'],nextExperiment:'把身后加注概率从 20% 改为 60%，其余分支各 20%，重新判断。',fieldTask:'复盘多人池时标明行动是否关闭，以及身后玩家的剩余筹码。'
  },
  {
    id:'multiway-behind-variant',title:'迁移：身后高压时，原本盈利的跟注会怎样？',theme:'多人底池',skill:'multiway-response',family:'multiway-branches',variantOf:'multiway-behind',difficulty:'高级',minutes:3,
    prompt:'沿用三人河牌条件模型。三个分支的 Hero EV 仍为：身后弃牌 +30、跟注 +6、加注后你弃牌 −30。现在概率分别为 20%、20%、60%。忽略你主动加注的选项，应跟注还是弃牌？',choices:[choice('call','跟注，顶对通常需要防守'),choice('fold','弃牌，跟注条件 EV 为 −10.8 BB')],reasonChoices:[choice('branches','按新的联合响应频率重新加权每个后续分支'),choice('same','Hero 底牌没变，动作就不应改变')],answer:'fold',correctReasons:['branches'],actionEV:{call:-10.8,fold:0},explanation:'0.2×30 + 0.2×6 + 0.6×(−30) = −10.8 BB。同一手牌、同一个直接跟注额，因身后行动改变而发生决策反转。这里只说明 call/fold 的比较；主动加注仍需单独建模。',takeaway:'在多人池中，相对位置可以通过后续行动直接改变当前动作价值。',evidence:[evidence('call-ev','条件跟注 EV',-10.8,'BB','0.2×30 + 0.2×6 + 0.6×(−30)')],assumptions:['沿用前题的条件分支权益。','本题不提供主动加注的响应模型。'],nextExperiment:'加入 Hero 加注及两名对手的联动响应，比较完整行动集。',fieldTask:'区分“不愿意跟注”和“应当弃牌”；如果有可盈利加注，二者并不等价。'
  },
  {
    id:'multiway-joint-fold',title:'两个人都弃牌，不能只看单人频率',theme:'多人底池',skill:'joint-distribution',family:'multiway-joint',difficulty:'高级',minutes:5,
    prompt:'三人河牌，你向 100 BB 底池用零摊牌胜率牌诈唬 50 BB；任意对手继续都让你损失 50。两名对手的边际弃牌率各是 60%，但不知道其条件相关性。能否据此确定诈唬盈利？',choices:[choice('unknown','不能；需要两人同时弃牌的概率'),choice('profit','能，60% 超过 33.33% 就盈利'),choice('36','能，两人同时弃牌必定是 36%')],reasonChoices:[choice('joint','两人的联合弃牌事件决定收益；边际频率不足以确定它'),choice('independence','玩家是不同的人，行动天然独立')],answer:'unknown',correctReasons:['joint'],explanation:'两人同时弃牌概率可能在 max(0,0.6+0.6−1)=20% 与 min(0.6,0.6)=60% 之间。EV=150×P(全部弃牌)−50，因而可从 −20 到 +40 BB。36% 只在对应条件下的独立假设成立时可用；共享牌张和行动信息通常需要联合建模。',takeaway:'多人池不能给每个人机械套一份单挑 MDF。',evidence:[evidence('joint-lower','全部弃牌概率下界',.2,'比例','max(0, 0.6+0.6−1)'),evidence('joint-upper','全部弃牌概率上界',.6,'比例','min(0.6,0.6)'),evidence('ev-lower','EV 下界',-20,'BB','150×0.2−50'),evidence('ev-upper','EV 上界',40,'BB','150×0.6−50')],assumptions:['边际频率条件于相同 Hero 下注节点。','所有继续分支最终净输 50，无抽水。'],nextExperiment:'设定一个可验证的联合范围和行动策略，直接枚举兼容发牌。',fieldTask:'多人 exploit 前，记录是否把两个边际统计误当成联合概率。'
  },
  {
    id:'mixed-strategy-grading',title:'选了低频动作，就算打错了吗？',theme:'策略执行',skill:'mixed-policy',family:'range-policy',variantOf:'range-balance-check',difficulty:'高级',minutes:3,
    prompt:'某求解节点中，call 频率 90%、估计 EV 4.00 BB；raise 频率 10%、估计 EV 4.01 BB；数值不确定度约 0.04 BB。你在一次训练中选了 raise。合理的反馈是什么？',choices:[choice('acceptable','本次两动作在误差内近似等价；另行检查长期范围分配'),choice('wrong','错误，因为 raise 只有 10% 频率'),choice('always','以后始终 raise，因为显示 EV 高 0.01 BB')],reasonChoices:[choice('uncertainty','比较损失与数值误差，不把一个混合频率当作单题正确率'),choice('mode','每次选最高频动作即可复现整套策略')],answer:'acceptable',correctReasons:['uncertainty'],explanation:'0.01 BB 的显示差小于给定不确定度，不能据此断言始终 raise 更优；也不能因为 raise 低频就惩罚这次选择。整段策略是否被对手针对，需要评估一批决策的分配或重新计算最佳响应。',takeaway:'行动损失、混合频率和整套策略的可利用程度是不同指标。',evidence:[evidence('displayed-gap','显示 EV 差',.01,'BB','4.01 − 4.00'),evidence('uncertainty','给定数值不确定度',.04,'BB','题设')],assumptions:['这是数值反馈解释练习，频率与 EV 为构造数据。'],nextExperiment:'把所有组合都改成永远 raise，再评估整体策略，而不是只看单次 EV。',fieldTask:'实战简化策略前，先保留那些真正影响范围防守的组合分配。'
  },
  {
    id:'opponent-small-sample',title:'四次机会，怎样约束你的 exploit 信心？',theme:'对手假设',skill:'uncertainty',family:'opponent-model',difficulty:'高级',minutes:4,
    prompt:'一个明确定义的河牌机会中，对手 4 次有机会采取目标行动，观察到 1 次。采用练习指定的 Beta(2,8) 先验，Beta-Bernoulli 更新后的均值是多少？这只是行为估计，不是最优策略。',choices:[choice('21.43','约 21.43%，并继续保留较大不确定性'),choice('25','25%，现在已足够精确'),choice('10','10%，因为先验不能被数据改变')],reasonChoices:[choice('posterior','将成功与失败次数加到先验参数上，承认小样本仍不确定'),choice('certainty','看到一次亮牌即可确定其整个范围')],answer:'21.43',correctReasons:['posterior'],explanation:'后验为 Beta(2+1,8+3)=Beta(3,11)，均值 3/14≈21.43%。先验只是题目指定的模型；实际使用前要确认样本机会定义、选择偏差、对手行为是否稳定。不能据此把隐藏手牌范围当成已知。',takeaway:'调整幅度应随着证据强弱变化，观察频率不是策略真值。',evidence:[evidence('posterior-alpha','后验 alpha',3,'参数','2 + 1'),evidence('posterior-beta','后验 beta',11,'参数','8 + 3'),evidence('posterior-mean','后验均值',3/14,'比例','3 / (3+11)')],assumptions:['同一条件下的四次独立、同分布机会；Beta 先验是练习设定。'],nextExperiment:'对先验和样本筛选作敏感性分析；比较结论是否稳健。',fieldTask:'保存对手结论时，同时保存样本机会数和可撤销条件。'
  },
  {
    id:'future-street-equity',title:'转牌直接权益，为什么还不是跟注 EV？',theme:'多街规划',skill:'future-streets',family:'future-policy',difficulty:'进阶',minutes:3,
    prompt:'转牌底池 40，对手下注 30，你对其当前范围的直接发完牌权益为 35%。双方仍有大量筹码。你能否只用 0.35×100−30=+5 BB，证明跟注盈利？',choices:[choice('no','不能；这是假设跟注后无额外下注、直接摊牌的基准'),choice('yes','能，因为权益超过 30% 的底池赔率')],reasonChoices:[choice('future','后续下注、弃牌、额外投入和条件范围会改变权益实现'),choice('static','当前范围权益已包含所有未来策略')],answer:'no',correctReasons:['future'],explanation:'公式给出了一个有用的直接摊牌基准，但未来街策略尚未计入。你的部分权益可能因河牌弃牌无法实现，也可能从后续价值下注或诈唬获得额外收益。需要后续行动树或明确的未来策略模型。',takeaway:'先给数值一个准确的含义，再决定它能支持什么结论。',evidence:[evidence('showdown-baseline','直接摊牌基准 EV',5,'BB','0.35×(40+30+30)−30')],assumptions:['35% 为给定范围权益；后续策略未知。'],nextExperiment:'按河牌类别写出可执行计划，再检验计划的损失。',fieldTask:'转牌跟注前，用一句话说明哪些河牌继续、哪些河牌重新评估。'
  },
  {
    id:'side-pot-equity',title:'多人全下：同一个权益百分比不够分配边池',theme:'多人底池',skill:'side-pots',family:'multiway-pots',difficulty:'高级',minutes:4,
    prompt:'三名玩家分别总投入 30、100、100 BB，没有原底池和抽水。短码最多能争夺多少底池？剩余底池由谁争夺？',choices:[choice('90-140','短码争夺 90 BB 主池；两名深码争夺 140 BB 边池'),choice('230','三人都争夺全部 230 BB'),choice('30-200','短码只争夺自己的 30 BB；深码争夺 200 BB')],reasonChoices:[choice('caps','每一层底池只由达到该投入层的未弃牌玩家争夺'),choice('one-equity','只需计算三人的一个权益百分比再乘总池')],answer:'90-140',correctReasons:['caps'],explanation:'主池 = 3×30=90 BB，三人可争夺。边池 = 2×(100−30)=140 BB，只允许两名深码争夺。某深码即使主池输给短码，也仍可能赢得边池；需要对每个合法底牌组合分别计算各池归属。',takeaway:'多人求解必须同时保存各自筹码、投入层和每池资格。',evidence:[evidence('main-pot','主池',90,'BB','3 × 30'),evidence('side-pot','边池',140,'BB','2 × (100−30)'),evidence('total-pot','总底池',230,'BB','30 + 100 + 100')],assumptions:['无人弃牌，无抽水，无原底池，筹码全部已投入。'],nextExperiment:'让一名深码弃牌，检查其投入仍在池中但不再有争夺资格。',fieldTask:'复盘深浅码混合底池时，避免用一个“有效筹码”代表所有人。'
  }
];

function rotatedChoices(rows,seed){const offset=[...seed].reduce((a,c)=>a+c.charCodeAt(0),0)%rows.length;return [...rows.slice(offset),...rows.slice(0,offset)];}
function numericChoices(value,seed,{unit='',decimals=2,alternatives=[]}={}){const key=fmt(value,decimals),vals=[key,...alternatives.map(n=>fmt(n,decimals)),fmt(value*.75,decimals),fmt(value*1.25,decimals),fmt(value+1,decimals),fmt(value-1,decimals)].filter(finite);const unique=[...new Set(vals)].slice(0,4);return {answer:String(key),choices:rotatedChoices(unique.map(n=>choice(String(n),`${n}${unit}`)),seed)};}

function buildTransferLessons(){
  const result=[];
  const bluff='AhQh,AhJh,AhTh,QhJh,JhTh,Th8h,8h6h';
  const responseVariants=[
    {id:'raise-transfer-blocker-heart',title:'持有红桃 A 后，再看价值加注',hero:'Ah Kd',worse:'KQ,KJ',q:.65,b:30,r:90,bluffRaise:0,heroVs:'fold'},
    {id:'raise-transfer-narrow-value',title:'较差跟注范围只剩 KQ',hero:'Ac Kd',worse:'KQ',q:1,b:30,r:90,bluffRaise:0,heroVs:'fold'},
    {id:'raise-transfer-reraise-fold',title:'错失听牌也会再加注时',hero:'Ac Kd',worse:'KQ,KJ',q:.9,b:30,r:90,bluffRaise:.6,heroVs:'fold'},
    {id:'raise-transfer-reraise-call',title:'加注后跟再加注，也需要完整计划',hero:'Ac Kd',worse:'KQ,KJ',q:.9,b:30,r:90,bluffRaise:.6,heroVs:'call'},
    {id:'raise-transfer-small-sizing',title:'小加注让较差牌更愿意付钱',hero:'Ac Kd',worse:'KQ,KJ',q:.8,b:20,r:50,bluffRaise:.1,heroVs:'fold'},
    {id:'raise-transfer-large-sizing',title:'大尺寸与较弱继续范围相互作用',hero:'Ac Kd',worse:'KQ,KJ',q:.2,b:30,r:120,bluffRaise:0,heroVs:'fold'},
  ];
  for(const v of responseVariants){const withReraise=v.bluffRaise>0,reraiseTo=withReraise?Math.max(180,2*v.r-v.b):0,groups=[{id:'strong',label:'暗三条',range:'99,77,22',call:withReraise?0:1,raise:withReraise?1:0},{id:'worse',label:'较差 Kx',range:v.worse,call:v.q,raise:0},{id:'bluff',label:'指定诈唬',range:bluff,call:0,raise:v.bluffRaise}],model=riverResponseExperiment({pot:40,bet:v.b,raiseTo:v.r,board:baseScenario.board,hero:v.hero,groups,reraiseTo,heroVsReraise:v.heroVs});
    const snapshot={...clone(baseScenario),title:v.title,hero:v.hero,players:[{...baseScenario.players[0],stack:220,range:`99,77,22,${v.worse},${bluff}`},{...baseScenario.players[1],stack:220,range:v.hero.replace(/ /g,'')}]};
    const response=groups.map(g=>`${g.label} [${g.range}]：跟加注 ${percent(g.call)}，再加注 ${percent(g.raise)}，其余弃牌`).join('；');
    result.push({id:v.id,title:v.title,theme:'价值来源',skill:'raise-response',family:'river-value-raise',variantOf:'raise-value-100',trainingRole:'transfer',difficulty:'高级',minutes:5,scenario:snapshot,prompt:`河牌 ${baseScenario.board}，Hero ${v.hero}，原底池 40 BB，对手下注 ${v.b} BB。所有原始组合等权；公共牌与手牌阻断后再归一化。给定响应：${response}。${withReraise?`对手再加注到 ${reraiseTo} BB 时，Hero 预先决定${v.heroVs==='call'?'跟注':'弃牌'}。`:''}比较弃牌、跟注与加注到 ${v.r} BB 的计划。无抽水。`,choices:rotatedChoices([choice('fold','弃牌'),choice('call',`跟注 ${v.b} BB`),choice('raise',`加注到 ${v.r} BB${withReraise?`，遇再加注则${v.heroVs==='call'?'跟注':'弃牌'}`:''}`)],v.id),reasonChoices:rotatedChoices([choice('response','按具体合法组合与所有响应分支计算净收益'),choice('equity-only','只比较 Hero 的权益是否高于 50%'),choice('fold-rate','对手弃牌更多时，加注一定更好')],v.id),answer:model.best,correctReasons:['response'],actionEV:{fold:0,call:model.callEV,raise:model.raiseEV},explanation:`阻断后共 ${model.total} 个组合，Hero 权益 ${percent(model.equity)}。跟注 EV ${fmt(model.callEV)} BB；加注计划 EV ${fmt(model.raiseEV)} BB。${model.groups.map(g=>`${g.label} ${g.weighted} 个，贡献加注 EV ${fmt(g.raiseContribution)} BB`).join('；')}。${withReraise?'注意 Hero 面对再加注的计划改变了完整动作的价值；只比较首次加注金额会遗漏这部分。':''}`,takeaway:withReraise?'评估一个 raise 时，必须把对手再加注以及自己的响应也写进计划。':'范围与响应变化后重新计算；不要把先前的权益或加注结论原封不动搬过来。',evidence:[evidence('model-combos','合法加权组合',model.total,'组合','逐组合移除公共牌及 Hero 底牌'),evidence('call-ev','跟注 EV',model.callEV,'BB','Σ w × [share × (pot+2bet) − bet] / Σw'),evidence('raise-ev','完整加注计划 EV',model.raiseEV,'BB','Σ w × [fold×当前池 + call×摊牌净收益 + reraise×既定响应收益] / Σw')],assumptions:['对手响应是练习指定模型，不是求解器发现的均衡。','所有筹码足以完成给定下注；河牌，无抽水。'],nextExperiment:'只改变一个响应组的再加注频率或 Hero 的后续计划，再预测行动排序。',fieldTask:'记录真实加注时，补上一句“面对再加注我准备如何处理”。'});
  }
  const comboVariants=[
    {board:'Ks 7h 2h',hero:'Ac Kd',text:'KQs',target:'同花 KQ'},
    {board:'As Qs 2d',hero:'Ah Qd',text:'AQo',target:'非同花 AQ'},
    {board:'9c 9h 2s',hero:'9d Ac',text:'99',target:'口袋 99'},
    {board:'Ah Kh 2c',hero:'As Kd',text:'AKs',target:'同花 AK'},
    {board:'Qs 9h 2h 3c 7d',hero:'Ah Qd',text:'AhKh,AhJh,AhTh,KhJh,KcJc',target:'指定诈唬候选'},
    {board:'Ac Ad 8h',hero:'Kh Kd',text:'AA,KK',target:'AA 与 KK 合集'},
    {board:'Js 8d 3c',hero:'Jh Th',text:'JJ,88,33',target:'三组暗三条'},
    {board:'Ts 9s 2d 3h',hero:'As Ks',text:'AQs,AJs,KQs,KJs',target:'四类同花高牌'},
  ];
  comboVariants.forEach((v,i)=>{const id=`combos-transfer-${i+1}`,dead=[...cards(v.board),...cards(v.hero)],original=range(v.text),live=original.all.filter(c=>!c.cards.some(card=>dead.includes(card))),count=live.length,numeric=numericChoices(count,id,{unit:' 个',decimals:0,alternatives:[original.count,Math.max(0,count-2),count+2,count+4]});result.push({id,title:`组合检验：${v.target}`,theme:'组合数',skill:'card-removal',family:'card-removal',variantOf:'blocker-combos',trainingRole:'transfer',difficulty:'进阶',minutes:3,scenario:null,prompt:`公共牌 ${v.board}，Hero ${v.hero}。对手范围为 ${v.text}，每个指定组合权重 1。移除公共牌和 Hero 的底牌后，还剩多少个合法组合？`,choices:numeric.choices,reasonChoices:rotatedChoices([choice('enumerate','按花色展开，移除所有与已知牌冲突的组合'),choice('class-count','范围写了几个手牌类别就有几个组合'),choice('board-only','只移除公共牌，不考虑 Hero 底牌')],id),answer:numeric.answer,correctReasons:['enumerate'],explanation:`原始 ${original.count} 个组合，移除 ${original.count-count} 个，剩余 ${count} 个。${count?'合法清单：'+live.map(c=>c.label).join('、')+'。':'已知牌使所有候选都不可能；这是应当显式报错的空范围，不应以随机范围替代。'}`,takeaway:'组合数必须能落到具体两张牌；同花、非同花和对子受阻断的方式不同。',evidence:[evidence('before','原始组合',original.count,'组合','按标准 52 张牌展开'),evidence('after','合法组合',count,'组合',live.map(c=>c.label).join(', ')||'无'),evidence('removed','被阻断组合',original.count-count,'组合','原始 − 合法')],assumptions:['标准 52 张无限注德州扑克；不考虑尚未公开的弃牌玩家底牌。'],nextExperiment:'把 Hero 的一张牌换成同点数其他花色，先预测哪些具体组合改变。',fieldTask:'为一条 blocker 结论附上一份可复查的组合清单。'});});
  const posteriorVariants=[
    {board:'Ks 7h 2h',hero:'Ac Kd',strong:'77,22',other:'KQ,KJ',bluff:'AhQh,AhJh,AhTh,QhJh,JhTh',f:[1,.4,.8]},
    {board:'Ks 7h 2h',hero:'Ah Kd',strong:'77,22',other:'KQ,KJ',bluff:'AhQh,AhJh,AhTh,QhJh,JhTh',f:[1,.4,.8]},
    {board:'Js 8d 3c',hero:'Ac Jh',strong:'JJ,88,33',other:'AJ,KJ,QJ',bluff:'QT,T9',f:[.75,.3,.65]},
    {board:'As 8h 3h',hero:'Kd Kc',strong:'AA,88,33',other:'AQ,AJ',bluff:'KhQh,KhJh,QhJh,JhTh',f:[.6,.25,.9]},
    {board:'Qh 9h 2c',hero:'As Qd',strong:'QQ,99,22',other:'KQ,QJ',bluff:'AhKh,AhJh,KhJh,JhTh',f:[1,.1,.5]},
    {board:'Ts 9s 2d 3h',hero:'As Kc',strong:'TT,99,22',other:'AT,KT',bluff:'QsJs,Qs8s,Js8s,7s6s',f:[.9,.15,.7]},
    {board:'8s 8h 3d',hero:'Ah Ad',strong:'88,33',other:'QQ,JJ,TT',bluff:'AK,AQ',f:[.8,.2,.35]},
    {board:'Ks 7h 2h 9c 3s',hero:'Ac Kd',strong:'99,77,22',other:'KQ,KJ',bluff:'AhQh,AhJh,AhTh,QhJh,JhTh',f:[1,.1,.2]},
  ];
  posteriorVariants.forEach((v,i)=>{const id=`range-transfer-${i+1}`,groups=[{id:'strong',label:'指定强牌',range:v.strong,frequency:v.f[0]},{id:'other',label:'指定成牌',range:v.other,frequency:v.f[1]},{id:'bluff',label:'指定半诈唬/诈唬候选',range:v.bluff,frequency:v.f[2]}],model=posteriorRangeExperiment({...v,groups}),target=model.rows[0],numeric=numericChoices(target.posterior*100,id,{unit:'%',alternatives:[v.f[0]*100,target.weighted/model.prior*100,target.mass]});result.push({id,title:`行动后范围：${v.board}`,theme:'范围重建',skill:'range-weighting',family:'weighted-range',variantOf:'bayes-action-range',trainingRole:'transfer',difficulty:'高级',minutes:5,prompt:`公共牌 ${v.board}，Hero ${v.hero}。对手三个互斥组：${groups.map(g=>`${g.label} [${g.range}] 以 ${percent(g.frequency)} 下注`).join('；')}。每个原始组合等权，先移除已知牌。观察到下注后，“指定强牌”占下注范围多少？`,choices:numeric.choices,reasonChoices:rotatedChoices([choice('joint-update','先移除已知牌，再乘行动频率，并按全部下注质量归一化'),choice('prior-only','沿用行动前的组合占比'),choice('reverse','把强牌下注概率当成下注后持有强牌的概率')],id),answer:numeric.answer,correctReasons:['joint-update'],explanation:`${model.rows.map(g=>`${g.label}：合法 ${g.weighted} 个 × ${percent(g.frequency)} = ${fmt(g.mass)} 加权组合`).join('；')}。总下注质量 ${fmt(model.total)}，指定强牌占 ${fmt(target.mass)}/${fmt(model.total)}=${percent(target.posterior)}。`,takeaway:'同一个行动模型，在不同 Hero 花色或牌面下，也会产生不同的后验范围。',evidence:model.rows.map(g=>evidence(`mass-${g.id}`,g.label+'下注质量',g.mass,'加权组合',`${g.weighted} × ${g.frequency}`)).concat(evidence('posterior','强牌后验占比',target.posterior,'比例',`${target.mass} / ${model.total}`)),assumptions:['到达频率由题目指定；没有用对手摊牌倒推隐藏范围。','各组互斥，范围统计条件于全部已知牌。'],nextExperiment:'只改变 Hero 花色，保持所有行为频率不变；比较后验比例。',fieldTask:'在行动树每个重要节点重新归一化范围。'});});
  const multiVariants=[
    {pot:60,bet:30,p:[.5,.3,.2],e:[.45,.15],title:'小底池中，身后跟注并不总是好消息'},
    {pot:80,bet:20,p:[.25,.5,.25],e:[.5,.18],title:'漂亮直接赔率与重新加注风险'},
    {pot:100,bet:50,p:[.6,.1,.3],e:[.4,.1],title:'面对较大下注的联合响应'},
    {pot:90,bet:30,p:[.1,.6,.3],e:[.45,.3],title:'身后经常跟入时的条件权益'},
    {pot:80,bet:20,p:[.3,.3,.2,.2],e:[.45,.3,.18],title:'四人底池：两个身后玩家的联合分支'},
    {pot:60,bet:30,p:[.2,.2,.2,.4],e:[.5,.22,.12],title:'四人底池：身后行动重开压力'},
    {pot:120,bet:40,p:[.4,.15,.15,.3],e:[.35,.18,.09],title:'四人底池：弱权益与多人继续'},
  ];
  multiVariants.forEach((v,i)=>{const id=`multiway-transfer-${i+1}`,branches=v.e.map((e,j)=>({probability:v.p[j],callers:j,share:e,pot:v.pot+(2+j)*v.bet,ev:e*(v.pot+(2+j)*v.bet)-v.bet})),raiseP=v.p.at(-1),ev=branches.reduce((s,b)=>s+b.probability*b.ev,0)-raiseP*v.bet,best=ev>0?'call':'fold';result.push({id,title:v.title,theme:'多人底池',skill:'multiway-response',family:'multiway-branches',variantOf:'multiway-behind',trainingRole:'transfer',difficulty:'高级',minutes:5,prompt:`${v.e.length+1} 人河牌，原底池 ${v.pot}，前位下注 ${v.bet}，你考虑跟注 ${v.bet}。身后联合分支：${branches.map(b=>`${percent(b.probability)} 概率有 ${b.callers} 人跟入，其余弃牌；此分支 Hero 权益 ${percent(b.share)}`).join('；')}；另有 ${percent(raiseP)} 概率有人加注，你总是弃牌。无其他下注、无抽水。只比较当前跟注和弃牌，哪一个更好？`,choices:rotatedChoices([choice('call','跟注'),choice('fold','弃牌')],id),reasonChoices:rotatedChoices([choice('conditional','不同响应分支使用其各自的条件权益和最终底池'),choice('single','把对前位的单挑权益套到每个分支'),choice('bonus','身后跟进更多钱，必然提高跟注 EV')],id),answer:best,correctReasons:['conditional'],actionEV:{fold:0,call:ev},explanation:`${branches.map(b=>`${b.callers} 人跟入：EV ${percent(b.share)}×${b.pot}−${v.bet}=${fmt(b.ev)} BB，再乘分支概率 ${percent(b.probability)}`).join('；')}。遇加注弃牌分支损失 ${v.bet} BB，概率 ${percent(raiseP)}。总 EV = ${fmt(ev)} BB。`,takeaway:'额外底池金额、条件胜率和无法关闭行动的风险，需要一起计入。',evidence:branches.map((b,j)=>evidence(`branch-${j}`,`${j} 人跟入的条件 EV`,b.ev,'BB',`${b.share}×${b.pot}−${v.bet}`)).concat(evidence('raise-loss','遇加注弃牌损失',-v.bet,'BB','已投入跟注额'),evidence('call-ev','总条件跟注 EV',ev,'BB','Σ 分支概率 × 该分支净收益')),assumptions:['联合分支概率和条件权益是构造输入，不是假设两个身后玩家相互独立。','本题没有给 Hero 主动加注模型，结论仅限 call/fold。'],nextExperiment:'加入 Hero 加注后所有对手的响应；检查跟注差是否意味着必须弃牌。',fieldTask:'多人池计划至少覆盖“身后弃牌、跟入、重开行动”三类情况。'});});
  const potVariants=[
    {c:[20,60,100,100],f:[],target:0},
    {c:[40,40,120],f:[],target:2},
    {c:[30,80,80],f:[false,true,false],target:0},
    {c:[25,70,70,70],f:[false,false,true,false],target:1},
    {c:[15,45,90,90],f:[false,false,false,false],target:1},
    {c:[50,100,160],f:[],target:2},
    {c:[20,40,80,80,80],f:[false,false,true,false,false],target:0},
    {c:[10,30,60,60],f:[false,true,false,false],target:2},
  ];
  potVariants.forEach((v,i)=>{const id=`sidepot-transfer-${i+1}`,model=sidePotLayers(v.c,v.f),eligible=model.pots.filter(p=>p.eligible.includes(v.target)).reduce((s,p)=>s+p.amount,0),refunded=model.refunds.filter(r=>r.player===v.target).reduce((s,r)=>s+r.amount,0),numeric=numericChoices(eligible,id,{unit:' BB',decimals:0,alternatives:[model.contributed,model.total,v.c[v.target],eligible+refunded]});result.push({id,title:`边池资格：${v.c.length} 人、${model.pots.length} 层底池`,theme:'多人底池',skill:'side-pots',family:'multiway-pots',variantOf:'side-pot-equity',trainingRole:'transfer',difficulty:'高级',minutes:4,prompt:`河牌结束时，玩家 A/B/C${v.c.length>=4?'/D':''}${v.c.length>=5?'/E':''} 分别总投入 ${v.c.join('/')} BB。${v.f.some(Boolean)?`其中 ${v.f.map((f,j)=>f?String.fromCharCode(65+j):'').filter(Boolean).join('、')} 已弃牌，其投入仍在池中。`:'所有玩家均未弃牌。'}无原底池、无抽水。${String.fromCharCode(65+v.target)} 有资格争夺的底池合计多少？未被跟注而退回的金额不算可争夺底池。`,choices:numeric.choices,reasonChoices:rotatedChoices([choice('layers','按投入层分池；弃牌不拿回投入，但失去争夺资格'),choice('total','所有未弃牌玩家都可按总底池权益分配'),choice('own','玩家只可能赢回与自己总投入相等的钱')],id),answer:numeric.answer,correctReasons:['layers'],explanation:`${model.pots.map((p,j)=>`${j===0?'主池':`边池 ${j}`} ${p.amount} BB，资格玩家 ${p.eligible.map(i=>String.fromCharCode(65+i)).join('/')}`).join('；')}。${model.refunds.length?`未跟注退回：${model.refunds.map(r=>String.fromCharCode(65+r.player)+' '+r.amount+' BB').join('；')}。`:''}${String.fromCharCode(65+v.target)} 能争夺的合计为 ${eligible} BB。`,takeaway:'每个边池都有单独的参赛资格；投入总额、可争夺金额和净盈利不是同一个数。',evidence:model.pots.map((p,j)=>evidence(`pot-${j}`,j?'边池 '+j:'主池',p.amount,'BB',`贡献玩家 ${p.contributors.map(i=>String.fromCharCode(65+i)).join('/')}；资格 ${p.eligible.map(i=>String.fromCharCode(65+i)).join('/')}`)).concat(evidence('eligible','目标玩家可争夺总额',eligible,'BB','累加包含该玩家资格的底池层')),assumptions:['金额为从本手开始的总投入，不是某一街投入；无人再行动。','未跟注单人投入层退回；抽水为零。'],nextExperiment:'保持投入相同，只让一名深码弃牌，再检查资格与底池金额分别如何变化。',fieldTask:'在复盘中把“钱在哪里”和“谁有资格赢”分开记录。'});});
  return result;
}

LESSONS.push(...buildTransferLessons());

const GUIDED_ROUTES=[
  {id:'value-to-plan',title:'从权益到完整加注计划',goal:'独立区分摊牌权益、价值来源与再加注后的计划。',pretest:'raise-value-100',mechanism:'raise-value-0',counterexample:'raise-transfer-reraise-fold',transfer:['raise-transfer-narrow-value','raise-transfer-reraise-call','raise-transfer-blocker-heart'],fieldTask:'下一次薄价值加注，记录较差牌继续条件与面对再加注的计划。'},
  {id:'range-updating',title:'从候选牌到条件范围',goal:'能把已知牌移除、到达频率与行动后的重新归一化串起来。',pretest:'weighted-bluffs',mechanism:'bayes-action-range',counterexample:'range-transfer-2',transfer:['range-transfer-3','range-transfer-6','range-transfer-8'],fieldTask:'为一手真实牌画出逐行动范围质量变化。'},
  {id:'blockers-with-purpose',title:'每个 blocker 都有对象',goal:'能列出移除组合，解释其对具体动作的方向，而非泛称阻断好。',pretest:'blocker-combos',mechanism:'blocker-bluffcatch',counterexample:'combos-transfer-3',transfer:['combos-transfer-2','combos-transfer-4','combos-transfer-8'],fieldTask:'同时列出你的牌移除的价值与诈唬。'},
  {id:'multiway-tree',title:'把身后玩家放进收益树',goal:'不把单挑权益或边际弃牌率直接移植到多人局面。',pretest:'multiway-behind',mechanism:'multiway-behind-variant',counterexample:'multiway-joint-fold',transfer:['multiway-transfer-2','multiway-transfer-5','multiway-transfer-7'],fieldTask:'为一次三人底池决策写出身后响应分支。'},
  {id:'pots-and-stacks',title:'谁能赢哪一层底池',goal:'面对深浅码与弃牌筹码，正确重建底池层和参赛资格。',pretest:'side-pot-equity',mechanism:'sidepot-transfer-1',counterexample:'sidepot-transfer-3',transfer:['sidepot-transfer-5','sidepot-transfer-6','sidepot-transfer-8'],fieldTask:'核对一手多人全下的主池、边池、未跟注退回与各自净收益。'},
];

export function listGuidedLessons(){return GUIDED_ROUTES.map(({id,title,goal})=>({id,title,goal,minutes:20,version:CURRICULUM_VERSION}));}
export function getGuidedLesson(id){const r=GUIDED_ROUTES.find(r=>r.id===id);if(!r)throw Error('引导课程不存在。');return {...clone(r),steps:[{type:'pretest',title:'先预测，不看答案',lessonId:r.pretest},{type:'mechanism',title:'核验机制与证据',lessonId:r.mechanism},{type:'counterexample',title:'找到结论的失效条件',lessonId:r.counterexample},...r.transfer.map(lessonId=>({type:'transfer',title:'无提示迁移',lessonId})),{type:'field',title:'带回实战',task:r.fieldTask}],instruction:'每道题先提交行动、理由和信心，再显示答案；完成后按复习计划延迟提取。未做过的变体只能说明题目未见过，不能自动证明实战迁移。',version:CURRICULUM_VERSION};}

export function listLessons() {
  return LESSONS.map(({id,title,theme,skill,family,variantOf,difficulty,minutes,trainingRole})=>({id,title,theme,skill,family,variantOf:variantOf||null,difficulty,minutes,trainingRole:trainingRole||'learning',version:CURRICULUM_VERSION}));
}
export function getLesson(id,{reveal=false}={}) {
  const lesson=LESSONS.find(x=>x.id===id);if(!lesson)throw Error('训练题不存在。');
  if(reveal)return {...clone(lesson),version:CURRICULUM_VERSION};
  const {answer,acceptedAnswers,correctReasons,misconceptions,actionEV,evTolerance,explanation,takeaway,evidence,nextExperiment,fieldTask,...safe}=lesson;
  return {...clone(safe),version:CURRICULUM_VERSION};
}

/** Scheduling is an explicit initial product rule, not a scientifically optimal
 * interval for poker. The root persists attempts; this module is deterministic. */
export function scheduleReview({correct,score,confidence=50,loss=null},previous={},now=Date.now()) {
  previous=previous?.review?{...previous.review,previousCorrect:previous.correct,previousScore:previous.score}:previous||{};
  const timestamp=now instanceof Date?now.getTime():typeof now==='number'?now:Date.parse(now);if(!finite(timestamp))throw Error('复习时间无效。');
  const day=86400000,oldInterval=finite(previous.intervalDays)?previous.intervalDays:0,oldStreak=Number.isInteger(previous.streak)?previous.streak:0;
  const previousTime=Date.parse(previous.lastReviewedAt||''),previousDue=Date.parse(previous.dueAt||''),knownPrevious=finite(previousTime)&&previousTime<=timestamp;
  const delayed=knownPrevious&&timestamp-previousTime>=day;
  let intervalDays,streak,dueAt,priority,pendingRepair;
  if(!correct||score<60){intervalDays=confidence>=80?.25:1;streak=0;pendingRepair=true;priority=confidence>=80?'high':'normal';}
  else if(score<85){intervalDays=1;streak=0;pendingRepair=true;priority='normal';}
  else {
    const wasRepair=previous.pendingRepair===true||previous.previousCorrect===false||(finite(previous.previousScore)&&previous.previousScore<85)||(oldInterval>0&&oldStreak===0);
    if(knownPrevious&&!delayed&&wasRepair&&finite(previousDue)&&timestamp<previousDue){intervalDays=oldInterval;streak=oldStreak;dueAt=previousDue;pendingRepair=true;priority=previous.priority||'normal';}
    else if(knownPrevious&&delayed&&(!finite(previousDue)||timestamp>=previousDue)){streak=oldStreak+1;intervalDays=oldInterval<1?1:Math.min(60,Math.max(3,Math.round(oldInterval*(score>=95?2.5:1.8))));pendingRepair=false;priority='maintenance';}
    else if(knownPrevious&&!wasRepair){intervalDays=oldInterval||1;streak=oldStreak;dueAt=Math.max(finite(previousDue)?previousDue:0,timestamp+day);pendingRepair=false;priority=previous.priority||'maintenance';}
    else {intervalDays=1;streak=knownPrevious?0:1;pendingRepair=false;priority='maintenance';}
  }
  dueAt??=timestamp+intervalDays*day;
  return {intervalDays,streak,dueAt:new Date(dueAt).toISOString(),lastReviewedAt:new Date(timestamp).toISOString(),priority,pendingRepair,evidenceType:!knownPrevious?'first-exposure':delayed?'delayed-retrieval':'short-gap-practice',minDelayedHours:24,rule:'conditional-spaced-retrieval-v2',note:'至少距同题上次作答 24 小时才统计延迟提取；成功且到期的延迟复核才增长间隔。同日重刷不增长间隔阶梯。间隔是产品启发规则。'};
}

export function gradeAttempt(attempt,previous={},now=Date.now()) {
  const lesson=getLesson(attempt.lessonId,{reveal:true});
  const answer=String(attempt.answer??'');if(!lesson.choices.some(c=>c.id===answer))throw Error('请从当前题目的选项中选择答案。');
  const confidence=Number(attempt.confidence);if(!finite(confidence)||confidence<0||confidence>100)throw Error('信心必须为 0–100。');
  const reasonIds=Array.isArray(attempt.reasonIds)?[...new Set(attempt.reasonIds.map(String))]:attempt.reason?[String(attempt.reason)]:[];
  if(reasonIds.some(id=>!lesson.reasonChoices.some(r=>r.id===id)))throw Error('理由选项不属于当前题目。');
  if(!reasonIds.length)throw Error('请至少选择一个主要理由；训练需要检验推理。');
  const expected=lesson.correctReasons||[],hits=reasonIds.filter(r=>expected.includes(r)).length,falsePositive=reasonIds.filter(r=>!expected.includes(r)).length;
  const reasoningScore=expected.length?Math.max(0,(hits-falsePositive)/expected.length):1;
  let correct=(lesson.acceptedAnswers||[lesson.answer]).includes(answer),loss=null,referenceEV=null,selectedEV=null;
  if(lesson.actionEV){referenceEV=Math.max(...Object.values(lesson.actionEV));selectedEV=lesson.actionEV[answer];loss=Math.max(0,referenceEV-selectedEV);correct=loss<=(lesson.evTolerance??1e-6);}
  const score=Math.round((correct?70:0)+30*reasoningScore),p=confidence/100,brier=(p-(correct?1:0))**2;
  const result={lessonId:lesson.id,version:CURRICULUM_VERSION,answer,reasonIds,confidence,elapsedMs:finite(Number(attempt.elapsedMs))?Math.max(0,Number(attempt.elapsedMs)):null,correct,score,reasoningScore:Math.round(reasoningScore*100),loss,lossUnit:loss===null?null:'BB',selectedEV,referenceEV,referenceKind:lesson.actionEV?'指定响应模型下的行动 EV':'概念与可复算模型',calibration:{brier,highConfidenceError:!correct&&confidence>=80,note:'单题分数仅记录信心与结果；稳定校准需要累计多个独立题目。'},answerLabel:lesson.choices.find(c=>c.id===lesson.answer)?.label,acceptedAnswers:lesson.acceptedAnswers||[lesson.answer],correctReasons:lesson.correctReasons,reasonFeedback:reasonIds.filter(r=>!expected.includes(r)).map(r=>lesson.misconceptions?.[r]||'这个理由未能解释题目给定模型中的关键机制；请对照证据与成立条件。'),explanation:lesson.explanation,takeaway:lesson.takeaway,evidence:lesson.evidence,assumptions:lesson.assumptions||[],nextExperiment:lesson.nextExperiment,fieldTask:lesson.fieldTask,variants:listLessons().filter(x=>x.family===lesson.family&&x.id!==lesson.id).map(x=>x.id),review:scheduleReview({correct,score,confidence,loss},previous,now)};
  return result;
}

export function buildTrainingSummary(attempts=[],now=Date.now()) {
  const time=a=>Date.parse(a.createdAt||a.review?.lastReviewedAt||a.lastReviewedAt||'');
  const timestamp=now instanceof Date?now.getTime():typeof now==='number'?now:Date.parse(now);if(!finite(timestamp))throw Error('训练汇总时间无效。');if(!Array.isArray(attempts))throw Error('训练记录必须为数组。');
  const known=new Map(LESSONS.map(l=>[l.id,l])),ignored={unknownLesson:0,invalid:0,future:0,duplicate:0},seenIds=new Set(),valid=[];
  for(const a of attempts.filter(a=>a&&typeof a==='object').slice().sort((a,b)=>(time(a)||0)-(time(b)||0)||String(a.id||'').localeCompare(String(b.id||'')))){
    if(!known.has(a.lessonId)){ignored.unknownLesson++;continue;}
    if(typeof a.correct!=='boolean'||!finite(time(a))||(a.confidence!=null&&(!finite(a.confidence)||a.confidence<0||a.confidence>100))){ignored.invalid++;continue;}
    if(time(a)>timestamp){ignored.future++;continue;}
    if(a.id&&seenIds.has(a.id)){ignored.duplicate++;continue;}if(a.id)seenIds.add(a.id);valid.push(a);
  }
  const summarize=items=>{const confident=items.filter(a=>finite(a.confidence)),reasoned=items.filter(a=>finite(a.reasoningScore)),losses=items.filter(a=>finite(a.loss));return {attempts:items.length,correct:items.filter(a=>a.correct).length,accuracy:items.length?items.filter(a=>a.correct).length/items.length:null,reasoningAverage:reasoned.length?reasoned.reduce((n,a)=>n+a.reasoningScore,0)/reasoned.length:null,confidenceSamples:confident.length,confidenceMean:confident.length?confident.reduce((n,a)=>n+a.confidence,0)/confident.length:null,brier:confident.length?confident.reduce((n,a)=>n+(a.confidence/100-Number(a.correct))**2,0)/confident.length:null,highConfidenceErrors:confident.filter(a=>!a.correct&&a.confidence>=80).length,modelLossSamples:losses.length,meanModelLossBB:losses.length?losses.reduce((n,a)=>n+a.loss,0)/losses.length:null};};
  const latest=new Map(),skills={},firstExposure=[],firstTransfer=[],delayed=[],shortGap=[];
  for(const a of valid){const lesson=known.get(a.lessonId),prior=latest.get(a.lessonId),role=!prior?'firstExposure':time(a)-time(prior)>=24*3600000?'delayedRetrieval':'shortGapPractice';latest.set(a.lessonId,a);if(role==='firstExposure'){firstExposure.push(a);if(lesson.trainingRole==='transfer')firstTransfer.push(a);}else if(role==='delayedRetrieval')delayed.push(a);else shortGap.push(a);
    const s=skills[lesson.skill]??={skill:lesson.skill,theme:lesson.theme,rows:[],firstExposure:[],delayedRetrieval:[],shortGapPractice:[],lessons:new Set(),variants:new Set()};s.rows.push(a);s[role].push(a);s.lessons.add(a.lessonId);if(lesson.variantOf)s.variants.add(a.lessonId);
  }
  const due=[],fresh=[],upcoming=[];
  for(const lesson of listLessons()){const a=latest.get(lesson.id);if(!a){fresh.push({...lesson,lessonId:lesson.id});continue;}const dueAt=a.review?.dueAt||a.dueAt;if(dueAt&&Date.parse(dueAt)<=timestamp)due.push({...lesson,lessonId:lesson.id,dueAt,priority:a.review?.priority||'normal'});else if(dueAt)upcoming.push({...lesson,lessonId:lesson.id,dueAt});}
  due.sort((a,b)=>(a.priority==='high'?-1:0)-(b.priority==='high'?-1:0)||Date.parse(a.dueAt)-Date.parse(b.dueAt));
  const all=summarize(valid);
  return {version:CURRICULUM_VERSION,attempts:valid.length,totalAttempts:valid.length,accuracy:all.accuracy,highConfidenceErrors:all.highConfidenceErrors,reasoningAverage:all.reasoningAverage,recent:valid.slice(-20).reverse(),transferAttempts:valid.filter(a=>known.get(a.lessonId).trainingRole==='transfer').length,learningEvidence:{firstExposure:summarize(firstExposure),firstExposureTransfer:summarize(firstTransfer),delayedRetrieval:summarize(delayed),shortGapPractice:summarize(shortGap),delayedRule:'距同题前一次有效回答至少 24 小时；短间隔刷题单独统计，不计作独立迁移或延迟提取。'},completedLessons:latest.size,totalLessons:LESSONS.length,due,fresh,upcoming:upcoming.sort((a,b)=>Date.parse(a.dueAt)-Date.parse(b.dueAt)),skills:Object.values(skills).map(s=>{const total=summarize(s.rows);return {skill:s.skill,theme:s.theme,attempts:total.attempts,correct:total.correct,accuracy:total.accuracy,reasoning:total.reasoningAverage,brier:total.brier,confidenceErrors:total.highConfidenceErrors,averageModelLoss:total.meanModelLossBB,lessons:[...s.lessons],variants:[...s.variants],learningEvidence:{firstExposure:summarize(s.firstExposure),delayedRetrieval:summarize(s.delayedRetrieval),shortGapPractice:summarize(s.shortGapPractice)},aggregateMeaning:'旧汇总包含所有练习，仅用于兼容；能力与信心证据应分别看首见、延迟与短间隔统计。'};}),recommended:[...due,...fresh].slice(0,6),ignored,interpretation:'完成数表示做过；首次作答、未见变体、延迟复测与短间隔练习分别报告。同题重复不制造独立证据；没有信心数值的旧记录不按零信心计分。训练表现不能直接换算成新增 bb/100。'};
}

export function validateCurriculum() {
  const issues=[];
  for(const lesson of LESSONS){if(!lesson.choices.some(c=>c.id===lesson.answer))issues.push(`${lesson.id}: answer absent`);if(!lesson.correctReasons.every(r=>lesson.reasonChoices.some(c=>c.id===r)))issues.push(`${lesson.id}: reason absent`);if(!lesson.evidence?.length)issues.push(`${lesson.id}: no evidence`);if(lesson.variantOf&&!LESSONS.some(l=>l.id===lesson.variantOf))issues.push(`${lesson.id}: missing parent`);}
  return {ok:issues.length===0,count:LESSONS.length,issues};
}
