import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {cards,cardText,range} from './poker.mjs';
import {normalizeScenario} from './scenario.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const HU_POSTFLOP_VERSION='1.1.0-joint-chance';
export const HU_NATIVE_SHA256='5f09449d2b2768d1b21c11867b6858485509c4c8a77525d27ec35404fd9fee8d';
const EPS=1e-5,round=x=>Math.round(x*1e6)/1e6;
const numeric=(v,name,min,max,integer=false)=>{if(!Number.isFinite(Number(v))||Number(v)<min||Number(v)>max||integer&&!Number.isInteger(Number(v)))throw Error(`${name} 必须为 ${min}–${max}${integer?' 的整数':''}。`);return Number(v);};
const sizeList=(v,defaultValue,name)=>{if(v===undefined)v=defaultValue;if(typeof v==='string')v=v.split(/[,，\s]+/).filter(Boolean);if(!Array.isArray(v)||v.length>2)throw Error(`${name} 最多两个尺寸。`);return [...new Set(v.map(x=>numeric(x,name,.1,500)))].sort((a,b)=>a-b);};
const canon=x=>cards(x,[2]).sort((a,b)=>a-b).map(cardText).join('');
const streetName=n=>({3:'flop',4:'turn',5:'river'})[n];

/** Native frequencies are real DCFR output. This adapter deliberately does not
 * invent action EV or relabel the native exploitability report as exact BR. */
export function prepareHUPostflop(raw){
  const scenario=normalizeScenario(raw),board=cards(scenario.board,[3,4,5]);
  if(scenario.players.length!==2)throw Error('HU 三街引擎只支持两名玩家；多人请使用多人河牌/两街引擎。');
  if(scenario.rake!==0)throw Error('HU 三街引擎目前只验证无抽水模型。');
  if(raw.locks?.length)throw Error('HU 三街引擎暂不支持节点锁定，不能忽略锁定后继续求解。');
  if(raw.chanceMode&&raw.chanceMode!=='exact')throw Error('HU 三街引擎使用完整公共牌枚举，不支持抽样 chance 模式。');
  if(raw.algorithm&&raw.algorithm!=='dcfr')throw Error('HU 三街引擎使用 DCFR；当前不支持所选算法。');
  const effectiveStack=Math.min(...scenario.players.map(p=>p.stack));if(effectiveStack<=0)throw Error('新街起点双方都需要有剩余有效筹码。');
  const oop=scenario.toAct,ip=1-oop,minBet=numeric(raw.minBet??1,'最小下注',.01,1000);
  const maxRaises=numeric(raw.maxRaises??1,'每街加注次数上限',0,4,true);
  for(const key of ['turnMaxRaises','riverMaxRaises'])if(raw[key]!==undefined&&Number(raw[key])!==maxRaises)throw Error('HU 引擎目前要求三条街使用相同加注次数上限。');
  if(raw.riverToAct!==undefined&&Number(raw.riverToAct)!==oop)throw Error('HU 翻后位置固定，后续街仍由同一位 OOP 首先行动。');
  const bets=sizeList(raw.sizes,[50],'当前街下注尺寸'),raises=sizeList(raw.raiseSizes,[50],'当前街加注尺寸');
  const streets={};for(const n of [3,4,5]){const name=streetName(n);streets[name]={bets:sizeList(raw[`${name}Sizes`],bets,`${name} 下注尺寸`),raises:sizeList(raw[`${name}RaiseSizes`],raises,`${name} 加注尺寸`)};}
  const allIn=raw.allIn!==false,iterations=numeric(raw.iterations??500,'迭代次数',1,100000,true),threads=numeric(raw.threads??Math.min(12,os.availableParallelism()),'CPU 线程',1,24,true),accuracy=numeric(raw.accuracy??.5,'原引擎目标 exploitability 百分比',.000001,100),maxSeconds=numeric(raw.maxSeconds??1800,'运行秒数上限',1,14400),maxNodes=numeric(raw.maxNodes??200000,'完整导出节点预算',10,1000000,true),maxBytes=numeric(raw.maxBytes??300000000,'导出字节预算',10000,1000000000,true);
  const ranges=scenario.players.map(p=>{const live=range(p.range,board).live,max=Math.max(...live.map(c=>c.weight));return live.map(c=>({...c,prior:c.weight/max}));});
  if(ranges.some(r=>r.some(c=>c.prior<1e-30)))throw Error('相对组合权重小于 1e-30，超出原引擎单精度可靠范围；请明确修订该范围。');
  let legalDeals=0;for(const a of ranges[0])for(const b of ranges[1])if(!a.cards.some(c=>b.cards.includes(c)))legalDeals++;
  const requestedScope=raw.outputScope??'auto';if(!['auto','full','current-street'].includes(requestedScope))throw Error('outputScope 只能是 auto、full 或 current-street。');
  const maxStrategyCells=numeric(raw.maxStrategyCells??200000000,'全街策略内存单元预算',1000,500000000,true);
  const settings={effectiveStack,oop,ip,minBet,maxRaises,allIn,streets,iterations,threads,accuracy,maxSeconds,maxNodes,maxBytes,maxStrategyCells,dumpRounds:6-board.length,algorithm:'dcfr',chipUnit:minBet/100};
  const estimate=estimateTree(scenario,settings,ranges.map(r=>r.length));
  const exceedsExport=estimate.publicNodes>maxNodes||estimate.strategyCells>12000000;
  if(requestedScope==='full'&&exceedsExport)throw Error(`完整三街公开树需要 ${estimate.publicNodes.toLocaleString()} 节点，超过导出预算；不会静默截断未来街。可选 auto 或 current-street，后续街仍参与求解。`);
  settings.outputScope=requestedScope==='auto'?(exceedsExport?'current-street':'full'):requestedScope;
  if(board.length===5)settings.outputScope='full';
  settings.dumpRounds=settings.outputScope==='full'?6-board.length:1;
  settings.scopeReason=requestedScope==='auto'&&exceedsExport?'完整导出超过公开树预算；后续街仍参与求解，仅导出当前街。':settings.outputScope==='current-street'?'按请求仅导出当前街；后续街仍参与求解。':'导出全部后续街。';
  const input={...raw,...scenario,minBet,maxRaises,allIn,iterations,threads,accuracy,algorithm:'dcfr',chanceMode:'exact',sizes:bets,raiseSizes:raises,outputScope:settings.outputScope};
  return {scenario,input,board,ranges,settings,estimate,legalDeals};
}

// Count a public tree before running the native process. Chance runouts expand
// all physical public cards; card-removal effects affect reaches, not the cap.
function estimateTree(scenario,s,rangeCounts){
  let nodes=0,informationSets=0,strategyCells=0;const start=cards(scenario.board).length;
  const add=(count,actor,actions)=>{nodes+=count;if(actor>=0){informationSets+=count*rangeCounts[actor];strategyCells+=count*rangeCounts[actor]*actions;}if(strategyCells>s.maxStrategyCells)throw Error(`完整未来街策略超过 ${s.maxStrategyCells.toLocaleString()} 单元的内存预算；仅减少导出也无法降低求解内存，请减少尺寸/加注上限或范围。`);};
  const visit=(n,contrib,street,actor,checks,raises,lastRaise,mult=1)=>{
    const matched=Math.abs(contrib[0]-contrib[1])<EPS,allin=matched&&contrib[0]>=s.effectiveStack-EPS;
    if(actor===-1){if(n===5){add(mult,-1,0);return;}add(mult,-1,0);visit(n+1,contrib,[0,0],allin?-1:s.oop,0,0,s.minBet,mult*(52-n));return;}
    const call=Math.max(...street)-street[actor],remain=s.effectiveStack-contrib[actor],pot=scenario.pot+contrib[0]+contrib[1],targets=[];
    if((call<EPS||raises<s.maxRaises)&&remain>call+EPS){for(const pct of(call>EPS?s.streets[streetName(n)].raises:s.streets[streetName(n)].bets)){const raw=(call>EPS?call:0)+(call>EPS?pot+call:pot)*pct/100;const amount=Math.min(remain,Math.max(call+(call>EPS?lastRaise:s.minBet),Math.round(raw/s.chipUnit)*s.chipUnit));if(amount>call+EPS)targets.push(round(amount));}if(s.allIn)targets.push(round(remain));}
    const amounts=[...new Set(targets)];add(mult,actor,amounts.length+(call>EPS?2:1));
    if(call>EPS){add(mult,-1,0);const c=[...contrib];c[actor]+=call;visit(n,c,[...street],-1,0,0,s.minBet,mult);}
    else if(checks)visit(n,contrib,street,-1,0,0,s.minBet,mult);else visit(n,contrib,street,1-actor,1,raises,lastRaise,mult);
    for(const amount of amounts){const c=[...contrib],st=[...street];c[actor]+=amount;st[actor]+=amount;visit(n,c,st,1-actor,0,call>EPS?raises+1:raises,Math.max(lastRaise,amount-call),mult);}
  };
  visit(start,[0,0],[0,0],s.oop,0,0,s.minBet);
  return {publicNodes:nodes,informationSets,strategyCells,estimatedStrategyBytes:strategyCells*32};
}

export function huCommandFile(prepared,output='native-result.json'){
  if(/\s/.test(output))throw Error('原引擎输出路径不能包含空格，请使用独立工作目录内相对文件名。');
  const {scenario,board,ranges,settings:s}=prepared;
  const lines=[`set_pot ${scenario.pot}`,`set_effective_stack ${s.effectiveStack}`,`set_board ${board.map(cardText).join(',')}`,`set_min_bet ${s.minBet}`,`set_raise_limit ${s.maxRaises+1}`];
  for(const [seat,index] of [['oop',s.oop],['ip',s.ip]]){
    lines.push(`set_range_${seat} ${ranges[index].map(c=>`${c.label}:${c.prior}`).join(',')}`);
    for(const [street,v] of Object.entries(s.streets)){for(const [kind,sizes] of [['bet',v.bets],['donk',v.bets],['raise',v.raises]])lines.push(`set_bet_sizes ${seat},${street},${kind}${sizes.length?','+sizes.join(','):''}`);if(s.allIn)lines.push(`set_bet_sizes ${seat},${street},allin`);}
  }
  lines.push('set_allin_threshold 1','build_tree',`set_thread_num ${s.threads}`,`set_accuracy ${s.accuracy}`,`set_max_iteration ${s.iterations}`,'set_print_interval 10','set_use_isomorphism 0','start_solve',`set_dump_rounds ${s.dumpRounds}`,`dump_result ${output}`);
  return lines.join('\n')+'\n';
}

function massIndex(rangeRows,weights,board){
  const blocked=new Set(board),byCard=new Float64Array(52),byCombo=new Map();let total=0;
  rangeRows.forEach((c,i)=>{const w=c.cards.some(k=>blocked.has(k))?0:weights[i];total+=w;for(const k of c.cards)byCard[k]+=w;byCombo.set(c.label,w);});
  return {total,compatible:c=>Math.max(0,total-byCard[c.cards[0]]-byCard[c.cards[1]]+(byCombo.get(c.label)||0))};
}

/** O(N+M) compatible reach aggregation; multiplying the whole range by a
 * positive constant cannot change any frequency or conditional chance. */
export function normalizeHUTree(native,prepared,metadata={}){
  const {scenario,ranges,settings:s}=prepared,nodes=[];
  const initialWeights=ranges.map(r=>r.map(c=>c.prior)),rootIndex=massIndex(ranges[1],initialWeights[1],prepared.board);
  const rootMass=ranges[0].reduce((sum,c,i)=>sum+initialWeights[0][i]*rootIndex.compatible(c),0);if(!(rootMass>0))throw Error('没有兼容的联合底牌。');
  const walk=(raw,st,parentId=null)=>{
    if(!raw?.node_type)throw Error('原引擎导出缺少节点类型；不能把不完整分支当作终局。');
    if(nodes.length>=s.maxNodes)throw Error('实际公开节点数超过预检预算。');
    const id=`n${nodes.length}`,chance=raw.node_type==='chance_node',terminal=['terminal_node','showdown_node'].includes(raw.node_type),actor=chance?-2:terminal?-1:raw.player===1?s.oop:raw.player===0?s.ip:null;
    if(actor===null)throw Error('原引擎包含未知行动玩家。');
    const index=[massIndex(ranges[0],st.weights[0],st.board),massIndex(ranges[1],st.weights[1],st.board)],legalWeight=ranges[0].reduce((sum,c,i)=>sum+(st.board.some(b=>c.cards.includes(b))?0:st.weights[0][i]*index[1].compatible(c)),0),reach=legalWeight*st.chanceFactor/rootMass;
    const node={id,parentId,actor,actorId:actor>=0?scenario.players[actor].id:null,board:st.board.map(cardText).join(''),street:streetName(st.board.length),pot:round(scenario.pot+st.contrib[0]+st.contrib[1]),toCall:actor>=0?round(Math.max(...st.street)-st.street[actor]):0,contributions:[...st.contrib],streetContributions:[...st.street],folded:[...st.folded],terminal,chance,reach,actions:[],combos:[],profileEV:null};nodes.push(node);
    if(terminal){node.terminalKind=raw.node_type==='showdown_node'?'showdown':'fold';return node;}
    if(chance){if(st.board.length>=5)throw Error('河牌之后不能再发公共牌。');if(raw.out_of_scope===true){if(s.outputScope!=='current-street')throw Error('完整输出包含未导出的未来街。');node.outOfScope=true;node.limits=['未来街参与了本次求解，但本次输出仅包含当前街。此处是导出边界，不是牌局终点。'];return node;}const keys=Object.keys(raw.dealcards||{});if(keys.length!==52-st.board.length)throw Error(`公共牌分支不完整：需要 ${52-st.board.length} 张，实际 ${keys.length} 张。`);
      for(const text of keys){const [card]=cards(text,[1]);if(st.board.includes(card))throw Error('公共牌分支与现有牌面重复。');const child=walk(raw.dealcards[text],{...st,board:[...st.board,card],street:[0,0],lastRaise:s.minBet,chanceFactor:st.chanceFactor/(52-st.board.length-4)},id);node.actions.push({id:`deal_${text}`,label:text,type:'deal',card,amount:0,to:0,childId:child.id,frequency:reach>0?child.reach/reach:null,ev:null,selectedEV:null});}return node;
    }
    const labels=raw.actions;if(!Array.isArray(labels)||!labels.length)throw Error('行动节点没有动作。');
    const strategy=raw.strategy?.strategy||{},rawRows=new Map(Object.entries(strategy).map(([h,p])=>[canon(h),p]));
    const probabilities=ranges[actor].map(c=>{
      if(st.board.some(b=>c.cards.includes(b)))return null;
      const p=rawRows.get(c.label);if(!p){if(st.weights[actor][ranges[actor].indexOf(c)]*index[1-actor].compatible(c)>1e-12)throw Error(`可达组合 ${c.label} 缺少原始策略。`);return null;}
      if(!Array.isArray(p)||p.length!==labels.length||p.some(v=>!Number.isFinite(v)||v<-1e-7))throw Error('原始组合行动概率不合法。');const sum=p.reduce((a,b)=>a+b,0);if(Math.abs(sum-1)>1e-4)throw Error('原始组合行动概率未归一化。');return p.map(v=>Math.max(0,v)/sum);
    });
    ranges[actor].forEach((c,i)=>{if(!probabilities[i])return;node.combos.push({combo:c.label,weight:c.weight,reach:st.weights[actor][i]*index[1-actor].compatible(c)*st.chanceFactor/rootMass,probabilities:probabilities[i],actionEV:labels.map(()=>null),ev:null});});
    for(let i=0;i<labels.length;i++){
      const label=labels[i],m=label.match(/^(CHECK|CALL|FOLD|BET|RAISE)(?:\s+([\d.eE+-]+))?$/);if(!m)throw Error(`未知原始动作 ${label}`);const type=m[1].toLowerCase(),amount=type==='call'?node.toCall:['bet','raise'].includes(type)?Number(m[2]):0,to=round(st.street[actor]+amount),remaining=s.effectiveStack-st.contrib[actor];
      if(!Number.isFinite(amount)||amount<-EPS||amount>remaining+EPS)throw Error('原始动作金额超过有效筹码。');
      const currentBet=Math.max(...st.street);if(type==='bet'||type==='raise'){const minimum=type==='bet'?s.minBet:currentBet+st.lastRaise;if(to<minimum-EPS&&amount<remaining-EPS)throw Error('原始树中存在不足最小完整加注的非全下动作。');}
      const weights=st.weights.map(r=>[...r]);weights[actor]=weights[actor].map((w,j)=>w*(probabilities[j]?.[i]??0));
      const contrib=[...st.contrib],street=[...st.street],folded=[...st.folded];contrib[actor]=round(contrib[actor]+amount);street[actor]=to;if(type==='fold')folded[actor]=true;
      const childRaw=raw.childrens?.[label];if(!childRaw)throw Error('原始树缺少行动子节点，不能静默省略未来街。');
      const lastRaise=['bet','raise'].includes(type)?Math.max(st.lastRaise,to-currentBet):st.lastRaise;
      const child=walk(childRaw,{...st,weights,contrib,street,folded,lastRaise},id);
      const frequency=reach>0?node.combos.reduce((sum,c)=>sum+c.reach*c.probabilities[i],0)/reach:null;
      const allIn=amount>=remaining-EPS&&amount>0,display=type==='check'?'过牌':type==='call'?`跟注 ${round(amount)} BB`:type==='fold'?'弃牌':`${allIn?'全下':type==='bet'?'下注':'加注到'} ${to} BB`;
      node.actions.push({id:['bet','raise'].includes(type)?`${type}_${to}`:type,label:display,type,amount:round(amount),to,allIn,childId:child.id,frequency,ev:null,selectedEV:null,nativeAction:label});
    }
    return node;
  };
  walk(native,{board:prepared.board,weights:initialWeights,contrib:[0,0],street:[0,0],folded:[false,false],chanceFactor:1,lastRaise:s.minBet});
  const reported=Number.isFinite(metadata.reportedExploitabilityPctPot)?metadata.reportedExploitabilityPctPot:null;
  return {schemaVersion:1,outputScope:s.outputScope,scope:{solvedStreets:[3,4,5].filter(n=>n>=prepared.board.length).map(streetName),exportedStreets:s.outputScope==='full'?[3,4,5].filter(n=>n>=prepared.board.length).map(streetName):[streetName(prepared.board.length)],reason:s.scopeReason},capabilities:{actionEV:false,nodeLock:false,studyCards:false,evBreakdown:false,fullTree:s.outputScope==='full'},engine:'HUPostflop · TexasSolver DCFR',status:'complete',input:prepared.input,stats:{iterations:metadata.iterations??null,seconds:metadata.seconds??null,publicNodes:nodes.length,terminalNodes:nodes.filter(n=>n.terminal).length,infoSets:nodes.reduce((sum,n)=>sum+n.combos.length,0),legalDeals:prepared.legalDeals,algorithm:'discounted CFR (native TexasSolver)',threads:s.threads},chance:{mode:'exact',exact:true,meaning:'完整枚举公共牌；后续牌在到达相应 chance 节点前对玩家隐藏。组合按互相阻断后的联合到达概率聚合。'},diagnostics:{reportedExploitabilityPctPot:reported,source:'TexasSolver native best-response report',verifiedBy:null,independentlyVerified:false,meaning:'原引擎报告值；未标成 RiverLab/TurnLab 独立校验的 NashConv，也不是逐组合 EV 误差上界。'},stopReason:reported!==null&&reported<=s.accuracy?'native_target_reported':'native_iteration_limit',nodes,assumptions:[`HU 翻后位置固定，${scenario.players[s.oop].name} 每条街首先行动。`,`双方有效筹码 ${s.effectiveStack} BB；较深一方无法被覆盖的筹码不参与本底池。`,`每街最多 ${s.maxRaises} 次加注，最小下注 ${s.minBet} BB，下注金额按 ${s.chipUnit} BB 单位四舍五入。`,'下注及 donk 使用相同尺寸；加注百分比以跟注后的底池为基数，低于合法最小值时提升至最小值，超过有效筹码时封顶。','输入范围是研究假设，抽水为 0；未来牌完整枚举，牌力/策略训练使用原引擎单精度数值。'],limits:[s.scopeReason,'当前接入仅导出策略频率，不导出可信行动 EV；不能据频率排序伪造最优动作或 EV 损失。','完整导出含所有物理公共牌；某些分支因双方范围阻断而到达概率为 0。','DCFR 有限迭代及给定尺寸树的参考策略；原引擎残差未经本平台独立最佳响应复算。'],settings:s,estimate:prepared.estimate,source:{license:'AGPL-3.0',project:'https://github.com/bupticybee/TexasSolver',adapter:'PokerLab HUPostflop v1'}};
}

export async function solveHUPostflop(input,{onProgress=()=>{},signal,outputFile,enginePath,resourceDir,workDir}={}){
  const prepared=prepareHUPostflop(input);onProgress({phase:'prepared',...prepared.estimate,legalDeals:prepared.legalDeals});
  const dir=workDir?path.resolve(workDir):fs.mkdtempSync(path.join(os.tmpdir(),'pokerlab-hu-'));fs.mkdirSync(dir,{recursive:true});
  const executable=enginePath??path.join(ROOT,'engines/HUPostflop/console_solver.exe'),resources=resourceDir??path.join(ROOT,'engines/TexasSolverCPU/resources');
  let nativeSha256=null;
  const inFile=path.join(dir,'commands.txt'),outFile=path.join(dir,'native-result.json');fs.writeFileSync(inFile,huCommandFile(prepared));
  const started=Date.now();let log='',iterations=null,reportedExploitabilityPctPot=null;
  try{
    nativeSha256=createHash('sha256').update(fs.readFileSync(executable)).digest('hex');
    await new Promise((resolve,reject)=>{
      if(signal?.aborted){reject(Error('求解已取消。'));return;}
      let done=false,timedOut=false;const child=spawn(executable,['-i',inFile,'-r',resources],{cwd:dir,windowsHide:true});onProgress({phase:'running',processId:child.pid});
      const abort=()=>child.kill(),timer=setTimeout(()=>{timedOut=true;child.kill();},prepared.settings.maxSeconds*1000),cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};signal?.addEventListener('abort',abort,{once:true});
      const read=chunk=>{log=(log+chunk.toString()).slice(-120000);const it=[...log.matchAll(/Iter:\s*(\d+)/g)].at(-1),ex=[...log.matchAll(/Total exploitability\s+([-\d.eE+]+)\s+precent/g)].at(-1);if(it)iterations=Number(it[1]);if(ex)reportedExploitabilityPctPot=Number(ex[1]);onProgress({phase:'running',iterations,reportedExploitabilityPctPot,seconds:(Date.now()-started)/1000});};child.stdout.on('data',read);child.stderr.on('data',read);
      child.on('error',e=>{if(done)return;done=true;cleanup();reject(e);});child.on('close',code=>{if(done)return;done=true;cleanup();if(signal?.aborted)return reject(Error('求解已取消。'));if(timedOut)return reject(Error('HU 三街求解达到时间上限，未返回部分结果作为完整答案。'));if(code!==0)return reject(Error(`HU 原引擎退出 ${code}：${log.slice(-2500)}`));resolve();});
    });
    if(!fs.existsSync(outFile))throw Error('原引擎没有生成策略文件。');if(fs.statSync(outFile).size>prepared.settings.maxBytes)throw Error('原始完整策略超过导出字节预算；请缩小树。');
    onProgress({phase:'normalizing',iterations,reportedExploitabilityPctPot});
    const result=normalizeHUTree(JSON.parse(fs.readFileSync(outFile)),prepared,{iterations,reportedExploitabilityPctPot,seconds:(Date.now()-started)/1000});
    result.implementationVersion=HU_POSTFLOP_VERSION;result.source={...result.source,adapter:`PokerLab HUPostflop ${HU_POSTFLOP_VERSION}`,nativeSha256,nativeJointChanceVerified:nativeSha256===HU_NATIVE_SHA256,publicChanceRule:'52 - publicCards - 4 privateCards'};
    if(nativeSha256!==HU_NATIVE_SHA256)result.limits.push('本次使用外部原生构建，其公共牌概率修复版本未由已验证的二进制校验和确认。');
    if(outputFile){fs.mkdirSync(path.dirname(outputFile),{recursive:true});fs.writeFileSync(outputFile,JSON.stringify(result));}
    if(workDir)fs.writeFileSync(path.join(dir,'solver.log'),log);return result;
  } finally {
    // Only the exact, freshly-created temporary directory is removed.
    if(!workDir&&dir.startsWith(path.join(os.tmpdir(),'pokerlab-hu-')))fs.rmSync(dir,{recursive:true,force:true});
  }
}
