import {cards,range} from './poker.mjs';
import {fixedCappedRake} from './river-rake.mjs';
const near=(a,b)=>a!=null&&b!=null&&Number.isFinite(Number(a))&&Number.isFinite(Number(b))&&Math.abs(Number(a)-Number(b))<1e-7;
const round=x=>Math.round(Number(x)*1e6)/1e6;
function distribution(text,board){const rows=range(text,board).live,max=Math.max(...rows.map(c=>c.weight));return new Map(rows.map(c=>[c.label,c.weight/max]));}
function sameRange(a,b,board){const x=distribution(a,board),y=distribution(b,board);return x.size===y.size&&[...x].every(([c,w])=>y.has(c)&&Math.abs(w-y.get(c))<=1e-12*Math.max(w,y.get(c)));}
const hasCards=x=>Array.isArray(x)?x.length>0:typeof x==='string'&&x.trim();
function assertRootAssumptions(s){
 if(s.unit&&s.unit!=='BB')throw Error('求解模型金额单位必须为 BB，不能借用其它单位的旧解。');
 if(s.preexistingSidePot===true||s.sidePots?.length)throw Error('街起点已有边池，不能作为所有玩家均可赢的公共底池模型。');
 if(s.requiresStreetRoot===true||Number(s.currentBet)>1e-7||Number(s.toCall)>1e-7||s.streetContributions?.some(x=>Number(x)>1e-7)||s.players?.some(p=>Number(p.streetBet)>1e-7))throw Error('输入不是无本街投入的街起点，不能借用街起点模型。');
 if(s.hasFoldedRootPlayer===true||s.players?.some(p=>p.folded===true))throw Error('求解起点玩家包含已弃牌者，模型不一致。');
 if(s.hasUnsupportedDeadCards===true||hasCards(s.deadCards)||hasCards(s.foldedCards))throw Error('当前求解模型不支持额外死牌或弃牌底牌，不能忽略这些牌。');
}
const selectedFamily=s=>s.engine==='gpu-river'?'river':cards(s.board).length===3||s.engine==='hu-postflop'?'hu':cards(s.board).length===4?'turn':'river';
const resultFamily=result=>/HUPostflop/.test(result.engine??'')?'hu':/TurnLab/.test(result.engine??'')?'turn':/RiverLab|GPU.*[Rr]iver|[Rr]iver.*GPU/.test(result.engine??'')?'river':selectedFamily(result.input);
const list=(value,fallback)=>{
 const values=value===undefined?fallback:typeof value==='string'?value.split(/[,，\s]+/).filter(Boolean):value;
 if(!Array.isArray(values)||values.some(v=>!Number.isFinite(Number(v))))throw Error('求解模型的下注/加注尺寸无效。');
 return [...new Set(values.map(Number))].sort((a,b)=>a-b);
};
// The native solver applies locks in order. Sorting this array loses the
// last-matching-lock-wins meaning when locks overlap or repeat.
const lockKey=locks=>JSON.stringify((locks??[]).map(l=>({nodeId:l.nodeId,combo:l.combo==null?null:cards(l.combo,[2]).sort((a,b)=>a-b).join(','),probabilities:l.probabilities??null,actions:l.actions?Object.fromEntries(Object.entries(l.actions).sort(([a],[b])=>a.localeCompare(b))):null})));
const MODEL_SETTING_KEYS=['engine','sizes','raiseSizes','maxRaises','minBet','allIn','locks','chanceMode','chanceSamples','evaluationSamples','seed','flopSizes','flopRaiseSizes','turnSizes','turnRaiseSizes','turnMaxRaises','riverSizes','riverRaiseSizes','riverMaxRaises','riverToAct'];
function modelSettings(s,family){
 const sizes=list(s.sizes,family==='river'?[50,100]:[50]),raises=list(s.raiseSizes,[50]),maxRaises=Number(s.maxRaises??(family==='turn'?0:1));
 const model={family,minBet:Number(s.minBet??1),allIn:s.allIn!==false,maxRaises,locks:lockKey(s.locks),chanceMode:s.chanceMode??'exact'};
 if(family==='hu'){
  model.streets={};for(const [n,street] of [[3,'flop'],[4,'turn'],[5,'river']])if(n>=cards(s.board).length)model.streets[street]={sizes:list(s[`${street}Sizes`],sizes),raises:list(s[`${street}RaiseSizes`],raises)};
  // These aliases are constraints in the HU adapter, not independent rules.
  for(const key of ['turnMaxRaises','riverMaxRaises'])if(s[key]!==undefined&&Number(s[key])!==maxRaises)throw Error('HU 模型要求后续街采用相同加注规则。');
  if(s.riverToAct!==undefined&&Number(s.riverToAct)!==Number(s.toAct??0))throw Error('HU 模型要求后续街由同一位玩家首先行动。');
 }else{
  model.sizes=sizes;model.raises=raises;
  if(family==='turn')Object.assign(model,{riverSizes:list(s.riverSizes,[50]),riverRaiseSizes:list(s.riverRaiseSizes,[50]),riverMaxRaises:Number(s.riverMaxRaises??0),riverToAct:Number(s.riverToAct??s.toAct??0)});
 }
 if(model.chanceMode==='sampled')Object.assign(model,{seed:Number(s.seed??20260928),chanceSamples:Number(s.chanceSamples??50000),evaluationSamples:Number(s.evaluationSamples??Math.min(Number(s.chanceSamples??50000),50000)),sampleRangeOrder:s.players.map(p=>range(p.range,cards(s.board)).live.map(c=>c.label))});
 return model;
}
function assertMetadata(result,family){
 const input=result.input,root=result.nodes?.[0],rake=fixedCappedRake(input,Number(input.pot));
 if(root?.pot!==undefined&&!near(root.pot,round(input.pot)))throw Error('结果根节点底池与已保存的街起点不一致。');
 if(root?.board!==undefined&&cards(root.board).join(',')!==cards(input.board).join(','))throw Error('结果根节点公共牌与已保存的街起点不一致。');
 if(root?.contrib?.some(x=>Number(x)!==0)||root?.folded?.some(Boolean)||Number(root?.toCall)>1e-7)throw Error('结果根节点含本街投入或弃牌，街起点模型不一致。');
 for(const key of ['fixedRake','grossStartingPot','netStartingPot'])if(result.rakeModel?.[key]!==undefined&&!near(result.rakeModel[key],rake[key]))throw Error('结果抽水金额与原始模型不一致。');
 const mode=input.chanceMode??'exact';if(result.chance?.mode!==undefined&&result.chance.mode!==mode||result.chance?.exact!==undefined&&result.chance.exact!==(mode==='exact'))throw Error('结果机会枚举方式与原始模型不一致。');
 if(family==='hu'&&result.outputScope!==undefined){
  if(input.outputScope!==undefined&&input.outputScope!=='auto'&&result.outputScope!==input.outputScope||result.capabilities?.fullTree!==undefined&&result.capabilities.fullTree!==(result.outputScope==='full'))throw Error('HU 结果的完整树/当前街导出范围与保存模型不一致。');
 }
 if(mode==='sampled'){
  const expected=modelSettings(input,family),training=result.chance?.training,holdout=result.chance?.holdout;
  if(training?.seed!==undefined&&!near(training.seed,expected.seed)||training?.samples!==undefined&&!near(training.samples,expected.chanceSamples)||holdout?.samples!==undefined&&!near(holdout.samples,expected.evaluationSamples))throw Error('结果抽样机会元数据与原始模型不一致。');
 }
}
/** A saved policy can be explained only under its saved mathematical input.
 * Names, title and focus selection are presentation; ranges, stacks and order
 * are not. Uniform rescaling of an entire range leaves its prior unchanged.
 * With settings supplied, bind the action/chance model using that engine's
 * actual defaults. Iterations, accuracy and resource limits do not alter it. */
export function assertSolutionScenario(scenario,result,{settings}={}){
 const input=result?.input;if(!input?.players||input.board===undefined)throw Error('求解结果缺少原始模型输入，无法核验局面是否一致。');
 assertRootAssumptions(scenario);assertRootAssumptions(input);const family=resultFamily(result);
 const board=cards(scenario.board);if(board.join(',')!==cards(input.board).join(','))throw Error('公共牌与已求解局面不一致，请重新求解。');
 if(!near(scenario.pot,input.pot))throw Error('街起点底池与已求解局面不一致，请重新求解。');
 if(scenario.players.length!==input.players.length)throw Error('玩家人数与已求解局面不一致，请重新求解。');
 scenario.players.forEach((p,i)=>{const q=input.players[i];if((p.id!=null&&String(p.id)!==String(q.id))||String(p.position??'')!==String(q.position??''))throw Error('玩家顺序或位置与已求解局面不一致，请重新求解。');if(p.stack==null||!near(family==='hu'?p.stack:round(p.stack),q.stack))throw Error('剩余筹码与已求解局面不一致，请重新求解。');if(!sameRange(p.range,q.range,board))throw Error('玩家范围与已求解局面不一致，请重新求解。');});
 const order=['OOP','SB','BB','EP','UTG','UTG+1','UTG+2','MP','LJ','HJ','CO','BTN','IP'],positions=scenario.players.map(p=>order.indexOf(p.position));
 if(positions.every(p=>p>=0)&&new Set(positions).size===positions.length&&positions.filter((p,i)=>p>positions[(i+1)%positions.length]).length>1)throw Error('旧解的玩家循环顺序与翻后位置不一致，请按位置重新建立局面并求解。');
 if(Number(scenario.toAct??0)!==Number(input.toAct??0))throw Error('起始行动顺序与已求解局面不一致，请重新求解。');
 if(!near(scenario.rake??0,input.rake??0)||!near(scenario.rakeCap??scenario.cap??0,input.rakeCap??input.cap??0))throw Error('抽水模型与已求解局面不一致，请重新求解。');
 assertMetadata(result,family);
 if(settings!==undefined){
  // Legacy records may keep full solver input in settings. It must not silently
  // override scenario ranges, order, stacks or root amounts when re-used.
  const candidate={...scenario,...settings};assertSolutionScenario(candidate,result);
  if(selectedFamily(candidate)!==family)throw Error('求解引擎的行动模型与已保存结果不一致，请重新求解。');
  if(JSON.stringify(modelSettings(candidate,family))!==JSON.stringify(modelSettings(input,family)))throw Error('下注尺寸、加注规则、节点锁定或机会抽样与已求解模型不一致，请重新求解。');
  if(family==='hu'&&board.length<5&&candidate.outputScope&&candidate.outputScope!=='auto'&&input.outputScope&&candidate.outputScope!==input.outputScope)throw Error('HU 完整树/当前街导出范围与已保存模型不一致，请重新求解。');
 }else if(MODEL_SETTING_KEYS.some(key=>Object.hasOwn(scenario,key))){
  const candidate={...input,...scenario};if(scenario.engine!==undefined&&selectedFamily(candidate)!==family||JSON.stringify(modelSettings(candidate,family))!==JSON.stringify(modelSettings(input,family)))throw Error('局面内的求解设置与已保存模型不一致，请重新求解。');
 }else if((input.chanceMode??'exact')==='sampled'&&JSON.stringify(modelSettings({...input,...scenario},family))!==JSON.stringify(modelSettings(input,family))){
  throw Error('抽样模型的组合顺序改变了同一种子对应的机会分布，请重新求解。');
 }
}
export function assertRiverSensitivitySettings(settings,input){
 // Older saved variants store the full native input as settings. Verify those
 // fields, then remove them so their old ranges cannot overwrite each variant.
 assertSolutionScenario({...input,...settings},{input});
 if(selectedFamily(input)!=='river'||selectedFamily({...input,...settings})!=='river')throw Error('范围实验目前要求 RiverLab 河牌模型；不能切换 HU 引擎的下注取整和行动树。');
 for(const [key,fallback] of [['sizes',[50,100]],['raiseSizes',[50]]])if(JSON.stringify(list(settings[key],fallback))!==JSON.stringify(list(input[key],fallback)))throw Error('范围实验的下注/加注尺寸与基线模型不一致。');
 for(const [key,fallback] of [['maxRaises',1],['minBet',1]])if(!near(settings[key]??fallback,input[key]??fallback))throw Error('范围实验的加注规则与基线模型不一致。');
 if((settings.allIn!==false)!==(input.allIn!==false))throw Error('范围实验的全下选项与基线模型不一致。');
 if(lockKey(settings.locks)!==lockKey(input.locks))throw Error('范围实验的节点锁定与基线模型不一致，不能把锁定/未锁定策略当作仅修改范围的实验。');
 if(settings.chanceMode&&settings.chanceMode!=='exact')throw Error('范围实验必须使用同一完整机会枚举模型。');
 const result={...settings};for(const key of ['players','board','pot','hero','heroSeat','toAct','rake','rakeCap','cap','title','version','unit','format','assumptions','notes'])delete result[key];return result;
}
