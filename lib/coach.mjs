import {cards, range} from './poker.mjs';

const finite=Number.isFinite;
const fmt=(n,d=2)=>finite(n)?Number(n.toFixed(d)).toLocaleString('zh-CN'):'未提供';
const pct=n=>finite(n)?`${fmt(n*100)}%`:'未提供';
const unique=a=>[...new Set(a.filter(Boolean))];

/** Explanations are constrained to explicit input or returned engine evidence.
 * No strategic frequency, EV or causal claim is inferred from prose alone. */
export function buildCoachReport(scenario,result,{kind,nodeId='n0',focusCombo}={}) {
  const evidence=[],sections=[],limitations=[],questions=[],nextExperiments=[];
  const add=(label,value,unit,source,details)=>{const id=`E${String(evidence.length+1).padStart(3,'0')}`;evidence.push({id,label,value,unit,source,...(details?{details}:{})});return id;};
  const section=(title,body,evidenceIds=[])=>sections.push({title,body,evidenceIds});
  const streetName=board=>{try{return ({3:'翻牌',4:'转牌',5:'河牌'})[cards(board).length]||'当前街';}catch{return '当前街';}};
  const selectedNode=(result?.nodes||[]).find(n=>n.id===nodeId),activeBoard=selectedNode?.board||scenario.board,street=streetName(activeBoard),rootStreet=streetName(scenario.board);
  const context={root:{board:scenario.board,pot:Number(scenario.pot),hero:scenario.hero||'',heroSeat:scenario.heroSeat??null,toAct:scenario.toAct??null,players:(scenario.players||[]).map(p=>({id:p.id,name:p.name,position:p.position,stack:p.stack}))},current:{focusCombo:focusCombo??null,kind:selectedNode?'strategy':'equity',nodeId:selectedNode?.id||null,board:activeBoard,street:selectedNode?.street||({翻牌:'flop',转牌:'turn',河牌:'river'})[street]||null,pot:finite(selectedNode?.pot)?selectedNode.pot:Number(scenario.pot),toCall:finite(selectedNode?.toCall)?selectedNode.toCall:null,actorSeat:Number.isInteger(selectedNode?.actor)&&selectedNode.actor>=0?selectedNode.actor:null,actorId:selectedNode?.actorId||null,actorName:selectedNode?.actor>=0?scenario.players?.[selectedNode.actor]?.name||selectedNode.actorId:null,chance:selectedNode?.chance===true||selectedNode?.actor===-2,terminal:selectedNode?.terminal===true||selectedNode?.actor===-1,contributions:Array.isArray(selectedNode?.contributions)?selectedNode.contributions:null,streetContributions:Array.isArray(selectedNode?.streetContributions)?selectedNode.streetContributions:null,hero:scenario.hero||'',heroSeat:scenario.heroSeat??null},meaning:'root 是原研究起点；current 是当前观察节点。当前 actor 不一定是 Hero；行动 EV 从 current 往后计，先前投入是沉没成本。'};
  const playerCount=scenario.players?.length||0;
  const potId=add('街起点底池',Number(scenario.pot),'BB','scenario.pot');
  const countId=add('底池中玩家数',playerCount,'人','scenario.players');
  section('先确认研究问题',`研究从${rootStreet}开始，${playerCount} 人底池，起始节点底池 ${fmt(Number(scenario.pot))} BB。输入范围描述你认为各玩家如何到达这个起点；它不是牌谱能够直接告诉我们的事实。`,[potId,countId]);
  const mode=kind||(Array.isArray(result?.nodes)?'strategy':'equity');
  if(mode==='equity') {
    const players=result?.players||[];
    for(let i=0;i<players.length;i++) {
      const p=players[i],name=p.name||scenario.players?.[i]?.name||`玩家 ${i+1}`,ids=[];
      const comboCount=p.range?.count,weighted=p.range?.weighted,removed=p.range?.removed;
      if(finite(comboCount))ids.push(add(`${name} 公共牌移除后组合`,comboCount,'组合',`result.players[${i}].range.count`));
      if(finite(weighted))ids.push(add(`${name} 加权组合`,weighted,'组合',`result.players[${i}].range.weighted`));
      if(finite(removed))ids.push(add(`${name} 被公共牌移除`,removed,'组合',`result.players[${i}].range.removed`));
      if(ids.length)section(`${name} 的范围账本`,`${finite(comboCount)?`${fmt(comboCount)} 个合法组合`:''}${finite(weighted)?`，加权质量 ${fmt(weighted)}`:''}${finite(removed)?`，公共牌移除 ${fmt(removed)} 个`:''}。这些是单个范围对公共牌的计数；多人共享牌张的冲突必须在联合发牌时继续排除。`,ids);
      if(finite(p.equity)) {
        const eqId=add(`${name} 范围摊牌权益`,p.equity,'比例',`result.players[${i}].equity`),evIds=[eqId];
        if(finite(p.ci))evIds.push(add(`${name} 权益置信半宽`,p.ci,'比例',`result.players[${i}].ci`));
        section(`${name} 的摊牌份额`,`${name} 的范围直接摊牌权益为 ${pct(p.equity)}${!result.exact&&finite(p.ci)?`，95% 逐项采样误差界为 ${fmt(p.ci*100)} 个百分点`:''}。它衡量直接发完剩余公共牌后分到的底池份额；没有计入未来弃牌、下注、加注和筹码层级中的边池收益。`,evIds);
      }
    }
    if(finite(result?.hero?.equity)) {
      const h=result.hero,ids=[add('聚焦手牌摊牌权益',h.equity,'比例','result.hero.equity')];
      if(finite(h.ci))ids.push(add('聚焦手牌置信半宽',h.ci,'比例','result.hero.ci'));
      section('你的这手牌与整段范围要分开看',`${h.hand||scenario.hero} 的条件摊牌权益为 ${pct(h.equity)}。这里的对手联合牌张分布条件于你的具体两张牌；不能把这个数字当成 Hero 所有组合共有的权益。`,ids);
    }
    if(!players.some(p=>finite(p.equity))&&!finite(result?.hero?.equity))limitations.push('本次结果没有可引用的权益数值，不能生成数值结论。');
    limitations.push('范围权益不是行动 EV；权益领先不能单独证明下注或加注盈利。');
    if(!result?.exact&&result?.ciCoverage==='pointwise')limitations.push('95% 误差界逐个指标成立，不是全部组合同时被覆盖的保证；它只讨论采样误差，不包含范围假设和策略误差。');
    if(street!=='河牌')limitations.push('尚有未来公共牌与行动；当前结果是直接摊牌基准，未证明权益能全部实现。');
    if(playerCount>2)limitations.push('多人权益不能直接套用单挑最低防守频率；身后玩家的响应和各自筹码必须进入策略树。');
    questions.push('哪几类组合是你的结论最敏感的输入假设？','如果你加注，哪些较差牌继续、哪些较好牌弃牌、哪些牌再加注？');
    nextExperiments.push({title:'改变一个范围假设',body:'只降低一类可疑诈唬或边缘跟注的到达频率，保持其他输入不变，保存权益变化。',type:'range-sensitivity'});
    nextExperiments.push({title:'加入完整行动树',body:'用当前街起点创建策略树，再比较 check、bet、call、raise 及后续响应；将权益与行动 EV 分开展示。',type:'solve'});
  } else {
    const node=(result?.nodes||[]).find(n=>n.id===nodeId);
    if(!node) {limitations.push('没有找到请求的策略节点。');return {headline:'缺少当前节点证据，暂不能给出策略解释。',context,sections,evidence,limitations,questions,nextExperiments};}
    if(node.outOfScope){section('未来街参与求解，但本次只导出当前街','这个节点不是终局。后续发牌和行动已参与原引擎求解，但没有在这份可浏览结果中导出。可另建后续街研究；不能把缺少分支解释成没有下注或已摊牌。');return {headline:'已到达本次导出的边界。',context,sections,evidence,limitations:unique(result.limits||[]),questions:[],nextExperiments:[]};}
    if(node.chance===true||node.actor===-2){const choices=(node.actions||[]).filter(a=>a.type==='deal'),id=add('公开发牌分支数',choices.length,'张','node.actions(type=deal)');section('这里等待发牌，没有玩家决策',`当前公共牌 ${activeBoard}。沿下方发牌分支进入对应下一街后，再研究行动。每张公共牌的条件概率取决于合法联合底牌与当前到达分布，不能仅按可见分支数假定等概率。`,[id]);return {headline:'这是公开发牌节点；请选择下一张公共牌继续研究。',context,sections,evidence,limitations:unique(result.limits||[]),questions:[],nextExperiments:[{title:'对照不同后续牌',body:'选择两张会改变成牌与阻断关系的后续公共牌，比较同一组合的后续行动。',type:'runout-comparison'}],provenance:{method:'deterministic-evidence-coach-v1',numericalSource:'scenario and engine result'}};}
    if(node.terminal===true||node.actor<0){section('行动已经结束',`当前公共牌 ${activeBoard}。这个节点用于结算收益，没有可选择的后续动作。请回到父节点比较导致此结果的行动及其他响应分支。`);return {headline:'这是终局节点，回到上一步才能比较决策。',context,sections,evidence,limitations:unique(result.limits||[]),questions:[],nextExperiments:[]};}
    const actor=scenario.players?.[node.actor],name=actor?.name||node.actorId||`玩家 ${Number(node.actor)+1}`;
    const ids=[];
    if(finite(node.pot))ids.push(add('节点当前底池',node.pot,'BB',`node(${nodeId}).pot`));
    if(finite(node.toCall))ids.push(add('当前需跟注额',node.toCall,'BB',`node(${nodeId}).toCall`));
    if(finite(node.reach))ids.push(add('节点到达质量',node.reach,'权重',`node(${nodeId}).reach`));
    section('当前决策的含义',`${street}公共牌 ${activeBoard}，轮到 ${name} 行动${finite(node.pot)?`，当前底池 ${fmt(node.pot)} BB`:''}${finite(node.toCall)?`，需跟注 ${fmt(node.toCall)} BB`:''}。下列行动 EV 从此节点往后计净收益；之前投入视为沉没成本。比较的行动只限于这棵树所提供的尺寸和响应。`,ids);
    const usable=(node.actions||[]).filter(a=>finite(a.frequency));
    if(usable.length) {
      const actionIds=usable.map((a,i)=>add(`${a.label||a.id} 范围频率`,a.frequency,'比例',`node(${nodeId}).actions.${a.id}.frequency`));
      section('范围怎样分配到行动',usable.map(a=>`${a.label||a.id} ${pct(a.frequency)}`).join('；')+'。这是兼容发牌及到达权重下的整段范围分配；它不要求你持有任意一手牌时都按相同频率行动。',actionIds);
    }
    const evActions=(node.actions||[]).filter(a=>finite(a.ev));
    if(evActions.length) {
      const actionIds=evActions.map(a=>add(`${a.label||a.id} 聚合行动 EV`,a.ev,'BB',`node(${nodeId}).actions.${a.id}.ev`));
      section('整段范围强制执行某动作的收益',evActions.map(a=>`${a.label||a.id}：${fmt(a.ev,4)} BB`).join('；')+'。这里使用相同的当前到达范围，分别强制执行每个动作；它不同于“实际选择该动作的那些组合”的平均收益。具体手牌应查看组合级行动 EV，整段最优分配也不等于把所有组合放进聚合值最高的单一动作。',actionIds);
    }
    const selectedActions=(node.actions||[]).filter(a=>finite(a.selectedEV));
    if(selectedActions.length){const ids=selectedActions.map(a=>add(`${a.label||a.id} 实际选择组合的 EV`,a.selectedEV,'BB',`node(${nodeId}).actions.${a.id}.selectedEV`));section('这些动作实际由哪些牌执行',selectedActions.map(a=>`${a.label||a.id}：${fmt(a.selectedEV,4)} BB`).join('；')+'。这组值分别条件于实际进入各动作的不同组合，不能跨动作直接比较来决定某一手牌该怎样打。',ids);}
    let focus=null;
    if(focusCombo||(scenario.hero&&node.actor===scenario.heroSeat)){
      let key;try{key=cards(focusCombo||scenario.hero,[2]).sort((a,b)=>a-b).join(',');}catch{}
      focus=(node.combos||[]).find(c=>{try{return cards(c.combo||c.label,[2]).sort((a,b)=>a-b).join(',')===key;}catch{return false;}});
      context.current.focusEvidence={requested:focusCombo||scenario.hero,actorSeat:node.actor,status:focus?'available':'unavailable',actionEVAvailable:!!focus&&Array.isArray(focus.actionEV)&&focus.actionEV.length===node.actions.length&&focus.actionEV.every(finite),reach:finite(focus?.reach)?focus.reach:null};
    }
    if(focus) {
      const actionRows=(node.actions||[]).map((a,i)=>({label:a.label||a.id,frequency:focus.probabilities?.[i],ev:focus.actionEV?.[i]})),ids=[];
      for(const row of actionRows){if(finite(row.frequency))ids.push(add(`${focus.combo} ${row.label} 频率`,row.frequency,'比例',`node(${nodeId}).combo(${focus.combo}).probabilities`));if(finite(row.ev))ids.push(add(`${focus.combo} ${row.label} EV`,row.ev,'BB',`node(${nodeId}).combo(${focus.combo}).actionEV`));}
      section('聚焦这手牌',actionRows.map(row=>`${row.label}${finite(row.frequency)?` ${pct(row.frequency)}`:''}${finite(row.ev)?`，EV ${fmt(row.ev,4)} BB`:''}`).join('；')+'。接近等 EV 的动作不应因单次选择了低频动作就判错；显示差值还要结合求解残差、抽象与采样误差解释。',ids);
    } else if(focusCombo||(scenario.hero&&node.actor===scenario.heroSeat))limitations.push('当前节点未返回聚焦手牌的可达策略；不能用整段范围频率替代这手牌的答案。');
    const raises=(node.actions||[]).filter(a=>a.type==='raise'||a.type==='raiseTo'||/raise|加注/i.test(a.label||a.id||''));
    if(raises.length)section('加注研究要继续到对手响应','这棵树包含加注选项。请沿每个加注分支核对对手弃牌、跟注、再加注如何分配，再比较自己的 call/check 范围是否被削弱。仅凭本节点加注频率，不能声称已经知道其因果来源。');
    if(result?.diagnostics){const d=result.diagnostics,ids=[];if(finite(d.nashConv))ids.push(add('树内单边偏离收益之和',d.nashConv,'BB','result.diagnostics.nashConv'));if(finite(d.nashConvPctPot))ids.push(add('偏离收益占起点底池',d.nashConvPctPot,'百分数','result.diagnostics.nashConvPctPot'));if(ids.length)section('求解证据够不够稳定',`当前树内报告的单边偏离收益之和为 ${fmt(d.nashConv,5)} BB${finite(d.nashConvPctPot)?`，相当于起点底池 ${fmt(d.nashConvPctPot,4)}%`:''}。它允许检验包括被锁定行为在内的单边改变，描述所建树内的参考策略缺口，不是现实所有下注尺寸与未知范围下的损失上界。`,ids);if(finite(d.constrainedNashConv)){const cid=add('尊重节点锁定的偏离收益之和',d.constrainedNashConv,'BB','result.diagnostics.constrainedNashConv');section('锁定条件下是否充分优化',`尊重既定锁定约束的偏离收益之和为 ${fmt(d.constrainedNashConv,5)} BB。它衡量在这些锁定条件之内还能改进多少；若不受限残差较高，可能说明锁定行为本身可被利用，不能简单归因为求解未完成。`,[cid]);}}
    limitations.push('策略结论条件于输入范围、筹码、行动树和抽水规则；改变任何一项都可能改变答案。');
    if(playerCount>2)limitations.push('多人自博弈没有一般的纳什收敛保证；应同时检查树内最佳响应残差、独立重复与模型敏感性。');
    if(finite(node.reach)&&node.reach<=0)limitations.push('该节点在当前策略下不可达，条件策略或 EV 可能没有稳定解释。');
    questions.push('哪个对手响应让加注比跟注更有价值？证据在哪个子节点？','如果把更多强牌移入这个动作，其余分支会留下什么范围？');
    nextExperiments.push({title:'比较条件 EV 与重算后的策略',body:'先记录现有对手响应下的行动收益，再锁定一个明确的人群偏差并重新求解，区分一次偏离和整套策略调整。',type:'node-lock'});
    nextExperiments.push({title:'做一个条件反转题',body:'只改变一类范围权重或一个尺寸，预测动作怎样变，再查看求解结果。',type:'counterfactual'});
  }
  limitations.push(...(result?.limits||[]).map(x=>typeof x==='string'?x:x.message),...(result?.warnings||[]).map(x=>typeof x==='string'?x:x.message));
  return {headline:mode==='equity'?'先看清范围与摊牌份额，再研究下注和加注的收益来源。':'从整段范围到具体组合，再沿响应分支检查策略为什么成立。',context,sections,evidence,limitations:unique(limitations),questions,nextExperiments,provenance:{method:'deterministic-evidence-coach-v1',numericalSource:'scenario and engine result',languageModelRequired:false}};
}

/** A study-derived question is useful only when its evidence remains attached.
 * The stored full card belongs on the server; publicQuestion omits the answer. */
export function createStudyQuestion(scenario,result,{nodeId='n0',combo,evTolerance=0.02}={}) {
  if(!finite(evTolerance)||evTolerance<0)throw Error('EV 允许误差必须为非负数。');
  const node=(result.nodes||[]).find(n=>n.id===nodeId);if(!node)throw Error('没有该策略节点。');
  if(node.chance===true||node.actor===-2)throw Error('发牌节点没有玩家可选择的动作；请先选择具体公共牌分支。');
  if(node.terminal===true||node.actor<0)throw Error('终局节点没有玩家决策，不能生成行动训练。');
  const target=combo||scenario.hero;if(!target)throw Error('请选择一手具体组合。');
  const key=cards(target,[2]).sort((a,b)=>a-b).join(',');
  const focus=(node.combos||[]).find(c=>cards(c.combo||c.label,[2]).sort((a,b)=>a-b).join(',')===key);
  if(!focus||!Array.isArray(focus.actionEV)||!focus.actionEV.some(finite))throw Error('此节点没有这手牌的有效行动 EV。');
  const explicitlyLocked=(result.input?.locks||[]).some(lock=>{if(lock.nodeId!==nodeId&&lock.node!==Number(nodeId.replace(/^n/,'')))return false;if(lock.combo===undefined||lock.combo===null||lock.combo===-1)return true;try{return cards(lock.combo,[2]).sort((a,b)=>a-b).join(',')===key;}catch{return false;}});
  if(focus.locked===true||explicitlyLocked)throw Error('当前组合在此节点被锁定；固定行为不是可自由选择的训练答案。请选择未锁定的响应节点生成训练。');
  if(finite(focus.reach)&&focus.reach<=0)throw Error('该组合在这个节点不可达，不能生成有依据的行动训练。');
  const actions=node.actions.map((a,i)=>({id:a.id,label:a.label||a.id,ev:focus.actionEV[i],frequency:focus.probabilities?.[i]})).filter(a=>finite(a.ev));
  const best=Math.max(...actions.map(a=>a.ev)),accepted=actions.filter(a=>best-a.ev<=evTolerance).map(a=>a.id);
  const byId=new Map(result.nodes.map(n=>[n.id,n])),history=[],seen=new Set();let current=node;
  while(current?.parentId&&!seen.has(current.id)){seen.add(current.id);const parent=byId.get(current.parentId);if(!parent)break;const action=parent.actions?.find(a=>a.childId===current.id);if(action){const isDeal=action.type==='deal'||parent.chance===true||parent.actor===-2;history.unshift({nodeId:parent.id,actorSeat:isDeal?null:parent.actor,actorId:isDeal?null:parent.actorId||scenario.players?.[parent.actor]?.id,actorName:isDeal?'发牌':scenario.players?.[parent.actor]?.name||parent.actorId,label:isDeal?`发牌 ${action.label||action.id}`:action.label||action.id,type:action.type,board:parent.board||null,amount:action.amount??null,to:action.to??null});}current=parent;}
  const nodeContext={actorSeat:node.actor,actorId:node.actorId||scenario.players?.[node.actor]?.id||null,actorName:scenario.players?.[node.actor]?.name||node.actorId||null,board:node.board||scenario.board,street:node.street||({3:'flop',4:'turn',5:'river'})[cards(node.board||scenario.board||'').length]||null,pot:finite(node.pot)?node.pot:null,toCall:finite(node.toCall)?node.toCall:null,contributions:Array.isArray(node.contributions)?[...node.contributions]:null,streetContributions:Array.isArray(node.streetContributions)?[...node.streetContributions]:null,folded:Array.isArray(node.folded)?[...node.folded]:null,history,evOrigin:'当前节点之后的净收益；此节点之前已投入的筹码是沉没成本，fold = 0。'};
  const mode=result.chance?.exact===false||result.chance?.mode==='sampled'||result.stats?.chanceSampling===true?'sampled':result.chance?.exact===true||result.chance?.mode==='exact'?'exact':'unknown';
  const residual=finite(result.diagnostics?.optimizationResidualPctPot)?result.diagnostics.optimizationResidualPctPot:finite(result.diagnostics?.nashConvPctPot)?result.diagnostics.nashConvPctPot:null;
  const accuracyTarget=finite(result.input?.accuracy)?result.input.accuracy:null,targetReached=result.stopReason==='target_residual_reached'?true:residual!==null&&accuracyTarget!==null?residual<=accuracyTarget:null;
  const quality={mode,residual,residualUnit:'起点底池百分数',target:accuracyTarget,targetReached,provisional:mode!=='exact'||targetReached!==true,countsTowardMastery:false,note:[mode==='sampled'?'使用抽样发牌求得的经验游戏策略；答案不是完整原范围游戏的精确解。':mode==='exact'?'联合发牌精确枚举，策略仍受迭代残差与行动树限制。':'本题缺少联合发牌精度来源，需要人工核对参考。',targetReached===false?'尚未达到设定残差目标，行动排序仅供模型内研究。':targetReached===null?'未提供或无法核验求解精度目标。':'已达到本次设定的树内残差目标。','全局残差不是每个节点/组合的 EV 误差上界，不能把它机械当作单题容差。','本题 EV 损失仅相对本次参考后续策略；不据此直接宣称技能掌握。'].join(' ')};
  const contextText=`${nodeContext.board?`公共牌 ${nodeContext.board}。`:''}${nodeContext.actorName?`现在轮到 ${nodeContext.actorName}，`:''}${finite(nodeContext.pot)?`当前底池 ${fmt(nodeContext.pot)} BB，`:''}${finite(nodeContext.toCall)?`需跟注 ${fmt(nodeContext.toCall)} BB。`:''}`;
  const full={schemaVersion:1,id:`study-${result.id||'local'}-${nodeId}-${key.replace(',','-')}`,kind:'study-action',title:`${scenario.title||'我的研究'} · ${target}`,skill:'personal-study',source:{solveId:result.id||null,nodeId,engine:result.engine||null,diagnostics:result.diagnostics||null,chance:result.chance||null,holdout:result.validation?.holdout||null},scenario:JSON.parse(JSON.stringify(scenario)),nodeContext,quality,combo:target,prompt:`${contextText}你持有 ${target}，在此节点怎样行动？之前投入是沉没成本，比较从此处向后的净 EV；允许 ${evTolerance} BB 的显示 EV 容差。${quality.provisional?'此题参考尚有明确不确定性，答案仅作模型内反馈。':''}请先选择，再对照各响应分支检验理由。`,choices:actions.map(({id,label})=>({id,label})),evTolerance,actionEV:Object.fromEntries(actions.map(a=>[a.id,a.ev])),frequencies:Object.fromEntries(actions.map(a=>[a.id,a.frequency])),acceptedAnswers:accepted,referenceEV:best,assumptions:result.assumptions||[],limits:result.limits||[],createdFrom:'engine-result'};
  const {actionEV,frequencies,acceptedAnswers,referenceEV,...publicQuestion}=full;
  return {full,publicQuestion};
}

export function gradeStudyQuestion(question,{answer,confidence,reason='',elapsedMs=0}) {
  if(question.kind!=='study-action'||!finite(question.actionEV?.[answer]))throw Error('答案不属于这道研究题。');
  if(!finite(confidence)||confidence<0||confidence>100)throw Error('信心必须为 0–100。');
  const selectedEV=question.actionEV[answer],loss=Math.max(0,question.referenceEV-selectedEV),correct=loss<=question.evTolerance;
  return {questionId:question.id,correct,loss,lossUnit:'BB',selectedEV,referenceEV:question.referenceEV,acceptedAnswers:question.acceptedAnswers,actionEV:question.actionEV,frequencies:question.frequencies,quality:question.quality||null,confidence,reason:String(reason).slice(0,5000),reasonScore:null,reasonNote:'自由文本理由仅保存供对照复盘；没有用关键字或语言流畅度假装给推理打分。',elapsedMs:Math.max(0,Number(elapsedMs)||0),explanation:correct?'你的动作在当前参考策略及容差内。接下来核对收益来自哪个对手响应分支。':'对照各行动 EV，再沿分支找出损失来源；结果只适用于本次输入与参考后续策略。',limits:question.limits,source:question.source};
}
