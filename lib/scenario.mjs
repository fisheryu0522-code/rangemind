import {cards, cardText, range} from './poker.mjs';

/** All solver-facing money is expressed in BB. A Scenario is a new-street root,
 * never a silently reconstructed decision after an unrecorded bet. */
export const SCENARIO_VERSION = 1;
const EPS = 1e-7;
const round = n => Math.round(n * 1e8) / 1e8;
const issue = (severity, code, message, field, line) => ({severity, code, message, ...(field ? {field} : {}), ...(line ? {line} : {})});
const cardString = text => cards(text).map(cardText).join(' ');
const finite = n => typeof n === 'number' && Number.isFinite(n);
const clone = x => JSON.parse(JSON.stringify(x));
const nonempty = x => typeof x === 'string' && x.trim();
const numberField = x => x === null || x === undefined || (typeof x === 'string' && !x.trim()) ? NaN : Number(x);
const POSITIONS = ['SB','BB','UTG','UTG+1','UTG+2','LJ','HJ','CO','BTN','MP','EP','IP','OOP'];
const POSTFLOP_ORDER=['OOP','SB','BB','EP','UTG','UTG+1','UTG+2','MP','LJ','HJ','CO','BTN','IP'];

function compatibleAssignment(ranges, fixed = null, limit = 150000) {
  let visited = 0;
  const sorted = ranges.map((r, i) => ({r: fixed && i === fixed.seat ? r.filter(c => c.label === fixed.label) : r, i})).sort((a,b) => a.r.length - b.r.length);
  const search = (n, mask) => {
    if (n === sorted.length) return true;
    for (const combo of sorted[n].r) {
      if (++visited > limit) return null;
      const bits = combo.cards.reduce((m,c) => m | (1n << BigInt(c)), 0n);
      if ((mask & bits) === 0n) { const answer = search(n+1, mask | bits); if (answer !== false) return answer; }
    }
    return false;
  };
  return search(0,0n);
}

export function validateScenario(input, {requireRanges = true} = {}) {
  const issues = [], rangeStats = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok:false, scenario:null, issues:[issue('error','invalid_object','牌局必须是一个对象。')], rangeStats};
  const s = {version:SCENARIO_VERSION,title:String(input.title || '未命名研究').slice(0,160),format:['online','live','study'].includes(input.format) ? input.format : 'study',unit:'BB',board:'',hero:'',heroSeat:input.heroSeat == null || input.heroSeat==='' ? null : numberField(input.heroSeat),pot:numberField(input.pot),players:[],toAct:input.toAct == null ? null : numberField(input.toAct)};
  if(input.preexistingSidePot===true||(Array.isArray(input.sidePots)&&input.sidePots.length)){s.preexistingSidePot=true;issues.push(issue('error','preexisting_sidepot','当前街起点之前已形成不同参池资格的边池，不能合并为所有玩家均可赢的单一底池；请选择边池形成之前的研究起点。','pot'));}
  if(input.requiresStreetRoot===true||Number(input.currentBet)>EPS||Number(input.toCall)>EPS||(Array.isArray(input.streetContributions)&&input.streetContributions.some(x=>Number(x)>EPS))||(Array.isArray(input.players)&&input.players.some(p=>Number(p?.streetBet)>EPS))){s.requiresStreetRoot=true;issues.push(issue('error','not_street_root','输入含本街已经发生的下注。请恢复本街起始底池和剩余筹码，把下注、跟注及加注写入行动记录；不能把决策中途状态直接当街起点。','pot'));}
  if(input.hasFoldedRootPlayer===true||(Array.isArray(input.players)&&input.players.some(p=>p?.folded===true))){s.hasFoldedRootPlayer=true;issues.push(issue('error','folded_root_player','起点玩家列表含已弃牌者。根范围只应包含此时仍在底池中的玩家；更早弃牌者的底牌与范围暂不建模。','players'));}
  if(input.hasUnsupportedDeadCards===true||[input.deadCards,input.foldedCards].some(x=>Array.isArray(x)?x.length>0:typeof x==='string'&&x.trim())){s.hasUnsupportedDeadCards=true;issues.push(issue('error','unsupported_dead_cards','当前策略引擎不支持额外已知死牌/弃牌底牌；不能默默忽略这些牌再声称精确求解。','deadCards'));}
  s.rake=input.rake===undefined?0:numberField(input.rake);s.rakeCap=input.rakeCap===undefined?(input.cap===undefined?0:numberField(input.cap)):numberField(input.rakeCap);
  if(!finite(s.rake)||s.rake<0||s.rake>20)issues.push(issue('error','invalid_rake','抽水比例必须为 0–20 的百分数，例如 5 表示 5%。','rake'));
  if(!finite(s.rakeCap)||s.rakeCap<0||s.rakeCap>1e7)issues.push(issue('error','invalid_rake_cap','抽水上限必须是非负 BB 金额。','rakeCap'));
  if (input.unit && input.unit !== 'BB') issues.push(issue('error','unit_conversion_required','求解场景金额必须换算为 BB；导入时请提供大盲金额。','unit'));
  let board = [], hero = [];
  try { board = cards(input.board,[3,4,5]); s.board = board.map(cardText).join(' '); } catch(e) { issues.push(issue('error','invalid_board',e.message,'board')); }
  try { hero = cards(input.hero || '',[0,2]); s.hero = hero.map(cardText).join(' '); } catch(e) { issues.push(issue('error','invalid_hero',e.message,'hero')); }
  if (new Set([...board,...hero]).size !== board.length + hero.length) issues.push(issue('error','duplicate_known_card','手牌与公共牌出现了同一张牌。','hero'));
  if (!finite(s.pot) || s.pot <= 0 || s.pot > 1e7) issues.push(issue('error','invalid_pot','请输入大于 0 的街起点底池（BB）。','pot'));
  if (!Array.isArray(input.players) || input.players.length < 2 || input.players.length > 9) issues.push(issue('error','invalid_player_count','一个牌局需要 2–9 名仍在底池中的玩家。','players'));
  const ranges = [];
  for (const [i,rawPlayer] of (Array.isArray(input.players) ? input.players.slice(0,9) : []).entries()) {
    const p=rawPlayer&&typeof rawPlayer==='object'&&!Array.isArray(rawPlayer)?rawPlayer:{};
    if(p!==rawPlayer)issues.push(issue('error','invalid_player','玩家数据必须是对象。',`players.${i}`));
    const player = {id:String(p.id || `p${i+1}`),name:String(p.name || p.position || `玩家 ${i+1}`).slice(0,80),position:String(p.position || '').trim().toUpperCase(),range:String(p.range || '').trim(),stack:numberField(p.stack)};
    s.players.push(player);
    if (!player.position) issues.push(issue('error','missing_position',`请补充 ${player.name} 的位置。`,`players.${i}.position`));
    if (!finite(player.stack) || player.stack < 0 || player.stack > 1e7) issues.push(issue('error','invalid_stack',`请补充 ${player.name} 在当前街开始时的剩余筹码（BB）。`,`players.${i}.stack`));
    if (!player.range) { issues.push(issue(requireRanges?'error':'warning','missing_range',`${player.name} 的范围尚未指定；系统不会用默认范围替代。`,`players.${i}.range`)); ranges.push(null); continue; }
    try {
      const r = range(player.range,board); ranges.push(r.live);
      let focus = null;
      if (hero.length === 2 && i !== s.heroSeat) { try { const hr = range(player.range,[...board,...hero]); focus = {count:hr.count,weighted:hr.weighted,removed:r.count-hr.count}; } catch { focus = {count:0,weighted:0,removed:r.count}; } }
      rangeStats.push({seat:i,id:player.id,total:r.total,count:r.count,weighted:r.weighted,removed:r.removed,focus});
    } catch(e) { ranges.push(null); issues.push(issue('error','invalid_range',`${player.name}：${e.message}`,`players.${i}.range`)); }
  }
  if (new Set(s.players.map(p=>p.id)).size !== s.players.length) issues.push(issue('error','duplicate_player_id','每位玩家的 id 必须不同。','players'));
  if (!Number.isInteger(s.toAct) || s.toAct < 0 || s.toAct >= s.players.length) issues.push(issue('error','missing_to_act','请选择街起点首先行动的玩家。','toAct'));
  else if (s.players[s.toAct].stack === 0 && s.players.some(p=>p.stack>0)) issues.push(issue('error','actor_all_in','首先行动的玩家不能已经全下。','toAct'));
  if (s.heroSeat !== null && (!Number.isInteger(s.heroSeat) || s.heroSeat < 0 || s.heroSeat >= s.players.length)) issues.push(issue('error','invalid_hero_seat','Hero 位置不在当前玩家列表中。','heroSeat'));
  if (hero.length && s.heroSeat === null) issues.push(issue('error','missing_hero_seat','已填写手牌，请指定哪位玩家是你。','heroSeat'));
  if (!issues.some(x=>x.severity==='error') && ranges.length && ranges.every(Boolean)) {
    const possible = compatibleAssignment(ranges);
    if (possible === false) issues.push(issue('error','incompatible_ranges','所有玩家的范围之间没有一组能同时发出的合法底牌。','players'));
    if (possible === null) issues.push(issue('warning','compatibility_search_limit','范围兼容检查达到搜索上限；求解器必须继续检查合法联合发牌。','players'));
    if (hero.length && s.heroSeat !== null) {
      const label = [...hero].sort((a,b)=>a-b).map(cardText).join('');
      if (!ranges[s.heroSeat].some(c=>c.label === label)) issues.push(issue('error','hero_outside_range','聚焦手牌不在 Hero 的输入范围中。','hero'));
      else if (compatibleAssignment(ranges,{seat:s.heroSeat,label}) === false) issues.push(issue('error','hero_incompatible','这手 Hero 底牌阻断了其他玩家所有合法联合组合。','hero'));
    }
  }
  if (input.notes) s.notes = String(input.notes).slice(0,20000);
  if (Array.isArray(input.assumptions)) s.assumptions = input.assumptions.map(String).slice(0,30);
  // The solver advances around this array. Replaying by position while solving
  // in pasted line order would otherwise create two different poker games.
  if(s.players.every(p=>POSTFLOP_ORDER.includes(p.position))&&new Set(s.players.map(p=>p.position)).size===s.players.length){
    const order=s.players.map((p,i)=>({p,i})).sort((a,b)=>POSTFLOP_ORDER.indexOf(a.p.position)-POSTFLOP_ORDER.indexOf(b.p.position));
    if(order.some((x,i)=>x.i!==i)){const remap=new Map(order.map((x,i)=>[x.i,i]));s.players=order.map(x=>x.p);if(Number.isInteger(s.toAct))s.toAct=remap.get(s.toAct)??s.toAct;if(Number.isInteger(s.heroSeat))s.heroSeat=remap.get(s.heroSeat)??s.heroSeat;issues.forEach(x=>{if(x.field)x.field=x.field.replace(/^players\.(\d+)\./,(_,i)=>`players.${remap.get(Number(i))??i}.`);});rangeStats.forEach(row=>row.seat=remap.get(row.seat));rangeStats.sort((a,b)=>a.seat-b.seat);s.assumptions=[...(s.assumptions??[]),'玩家列表已按翻后位置排序；Hero 与首先行动者保持原玩家身份。'];}
  }
  return {ok:!issues.some(x=>x.severity==='error'),scenario:s,issues,rangeStats};
}

export function normalizeScenario(input, options) {
  const result = validateScenario(input,options);
  if (!result.ok) { const error = new Error(result.issues.filter(x=>x.severity==='error').map(x=>x.message).join(' ')); error.issues=result.issues; throw error; }
  return result.scenario;
}

/** Replays already structured actions. Amount on a call/bet is an incremental
 * payment; raiseTo is a total for that street. Returns every conservation step. */
export function replayActions(initial, actions, {strict = true, minBet = 1, enforceOrder = false} = {}) {
  const state = {pot:Number(initial.pot || 0),board:initial.board || '',street:initial.street || 'preflop',players:initial.players.map(p=>({...p,stack:Number(p.stack),contributed:0,streetBet:0,folded:false,allIn:Number(p.stack)===0})),currentBet:0,lastFullRaise:minBet,acted:[],actedAt:{}};
  if(!finite(state.pot)||state.pot<0||!finite(minBet)||minBet<=0||state.players.some(p=>!finite(p.stack)||p.stack<0))throw Error('初始底池、筹码和最小下注金额无效。');
  const total = state.pot + state.players.reduce((s,p)=>s+p.stack,0), ledger = [], issues = [], snapshots=[];
  const positionOrder=['OOP','SB','BB','EP','UTG','UTG+1','UTG+2','MP','LJ','HJ','CO','BTN','IP'];
  const ordered=state.players.map((p,i)=>({p,i})).sort((a,b)=>finite(a.p.seat)&&finite(b.p.seat)?a.p.seat-b.p.seat:(positionOrder.indexOf(a.p.position)<0?a.i:positionOrder.indexOf(a.p.position))-(positionOrder.indexOf(b.p.position)<0?b.i:positionOrder.indexOf(b.p.position))).map(x=>x.i);
  let pending=new Set(state.players.map((p,i)=>!p.allIn?i:-1).filter(i=>i>=0));
  const nextFrom=(from,candidates=pending)=>{const ix=ordered.indexOf(from);for(let k=1;k<=ordered.length;k++){const i=ordered[(ix+k+ordered.length)%ordered.length],p=state.players[i];if(candidates.has(i)&&!p.folded&&!p.allIn)return i;}return null;};
  const firstOnStreet=()=>{const button=state.players.findIndex(p=>p.position==='BTN');return button>=0?nextFrom(button):ordered.find(i=>pending.has(i))??null;};
  let nextActor=state.street==='preflop'?null:(Number.isInteger(initial.toAct)?initial.toAct:firstOnStreet());
  const fail = (code,message,a) => { const x=issue('error',code,message,undefined,a.line); issues.push(x); if(strict) {const e=new Error(message);e.issues=issues;throw e;} return false; };
  const pay = (p,amount,a) => {
    if (!finite(amount)||amount<-EPS||amount>p.stack+EPS) return fail('invalid_payment',`${p.name} 的投入超出剩余筹码或金额无效。`,a);
    amount=Math.min(p.stack,Math.max(0,amount)); p.stack=round(p.stack-amount);p.streetBet=round(p.streetBet+amount);p.contributed=round(p.contributed+amount);state.pot=round(state.pot+amount);p.allIn=p.stack<EPS;return true;
  };
  for (const [index,a] of actions.entries()) {
    const before = {pot:state.pot,stacks:state.players.map(p=>p.stack),currentBet:state.currentBet};
    if (a.type==='street') {
      let cs;try{cs=cards(a.board,{flop:[3],turn:[4],river:[5]}[a.street]||[0]);}catch(e){fail('invalid_street_board',e.message,a);continue;}
      const old=cards(state.board);
      if(old.some((c,i)=>cs[i]!==c)) {fail('board_changed','后续公共牌必须保留已经出现的牌及其顺序。',a);continue;}
      const outstanding=state.players.filter(p=>!p.folded&&!p.allIn&&p.streetBet<state.currentBet-EPS);
      if(outstanding.length) {fail('unfinished_betting','上一街仍有玩家未跟足下注，不能进入下一街。',a);continue;}
      if(enforceOrder&&pending.size&&state.players.filter(p=>!p.folded).length>1&&state.players.filter(p=>!p.folded&&!p.allIn).length>1){fail('unfinished_action_round','上一街仍有玩家尚未完成行动，不能省略过牌或大盲行动权。',a);continue;}
      state.street=a.street;state.board=cs.map(cardText).join(' ');state.currentBet=0;state.lastFullRaise=minBet;state.acted=[];state.actedAt={};for(const p of state.players)p.streetBet=0;
      pending=new Set(state.players.map((p,i)=>!p.folded&&!p.allIn?i:-1).filter(i=>i>=0));nextActor=firstOnStreet();
      snapshots.push({street:state.street,board:state.board,pot:state.pot,players:clone(state.players),actionIndex:index});
    } else {
      const p=state.players.find(p=>p.id===a.player);
      if(!p) {fail('unknown_player','行动中的玩家不存在。',a);continue;}
      const pi=state.players.indexOf(p),voluntary=['fold','check','call','bet','raiseTo'].includes(a.type);
      if(enforceOrder&&voluntary){if(nextActor===null&&state.street==='preflop'&&!state.acted.length){const big=state.players.findIndex(p=>p.position==='BB');nextActor=big>=0?nextFrom(big):ordered.find(i=>pending.has(i))??null;}if(nextActor!==pi){fail('wrong_action_order',nextActor===null?'这一轮行动已结束，不能继续新增行动。':`当前应由 ${state.players[nextActor].name} 行动，记录却是 ${p.name}。`,a);continue;}}
      const amount=Number(a.amount),owed=Math.max(0,state.currentBet-p.streetBet);
      if(p.folded&&!['return','collect'].includes(a.type)){fail('folded_actor',`${p.name} 已弃牌，不能再次行动。`,a);continue;}
      if(p.allIn&&!['return','collect','show'].includes(a.type)){fail('all_in_actor',`${p.name} 已全下，不能再次行动。`,a);continue;}
      if(a.type==='post'||a.type==='ante') {
        if(a.type==='post'&&state.street==='preflop'&&a.blindRole!=='straddle'&&((p.position==='BB'&&amount<minBet-EPS)||((p.position==='SB'||p.position==='BB'||state.players.length===2&&p.position==='BTN')&&initial.players.find(x=>x.id===p.id)?.stack<minBet-EPS))){fail('short_blind_unsupported','发牌前不足一个大盲的强制盲注暂不支持；保留原文，但不能按较小盲注重建入池价格。',a);continue;}
        const saved=p.streetBet;if(!pay(p,amount,a))continue;if(a.type==='ante')p.streetBet=saved;else {state.currentBet=Math.max(state.currentBet,p.streetBet);state.lastFullRaise=Math.max(state.lastFullRaise,p.streetBet);}if(p.allIn)pending.delete(pi);if(a.blindRole==='straddle')nextActor=nextFrom(pi);
      } else if(a.type==='fold') {p.folded=true;state.acted.push(p.id);}
      else if(a.type==='check') {if(owed>EPS){fail('illegal_check',`${p.name} 面对 ${round(owed)} BB 不能过牌。`,a);continue;}state.acted.push(p.id);state.actedAt[p.id]=state.currentBet;}
      else if(a.type==='call') {
        const expected=Math.min(owed,p.stack);
        if(owed<=EPS||Math.abs(amount-expected)>EPS){fail('ambiguous_call_amount',`${p.name} 应跟入 ${round(expected)} BB，记录为 ${amount} BB；请检查“投入额”和“跟到”是否混淆。`,a);continue;}
        if(!pay(p,amount,a))continue;state.acted.push(p.id);state.actedAt[p.id]=state.currentBet;
      } else if(a.type==='bet'||a.type==='raiseTo') {
        if(a.type==='bet'&&state.currentBet>EPS){fail('bet_facing_bet','已有下注，请使用“加注到”记录总额。',a);continue;}
        const target=a.type==='bet'?p.streetBet+amount:amount, increase=target-state.currentBet;
        if(!finite(target)||increase<=EPS){fail('invalid_raise','加注到金额必须大于本街当前最高投入。',a);continue;}
        if(a.type==='raiseTo'&&state.acted.includes(p.id)&&state.currentBet-(state.actedAt[p.id]??state.currentBet)<state.lastFullRaise-EPS){fail('betting_not_reopened',`${p.name} 已行动；未达到完整加注的全下没有重新开放加注权。`,a);continue;}
        const payment=target-p.streetBet, isAllIn=Math.abs(payment-p.stack)<EPS;
        if(increase<state.lastFullRaise-EPS&&!isAllIn){fail('raise_too_small',`完整加注至少加到 ${round(state.currentBet+state.lastFullRaise)} BB，较小金额只可用全部剩余筹码全下。`,a);continue;}
        if(!pay(p,payment,a))continue;
        if(increase>=state.lastFullRaise-EPS){state.lastFullRaise=increase;state.acted=[];}
        state.currentBet=target;state.acted.push(p.id);state.actedAt[p.id]=state.currentBet;
      } else if(a.type==='return') {
        if(!finite(amount)||amount<0||amount>p.streetBet+EPS){fail('invalid_return','退回未跟注金额超过玩家本街投入。',a);continue;}
        const otherMax=Math.max(0,...state.players.filter(x=>x.id!==p.id).map(x=>x.streetBet));
        if(amount>p.streetBet-otherMax+EPS){fail('contested_return','不能退回其他玩家已匹配的筹码。',a);continue;}
        p.stack=round(p.stack+amount);p.streetBet=round(p.streetBet-amount);p.contributed=round(p.contributed-amount);state.pot=round(state.pot-amount);p.allIn=p.stack<EPS;state.currentBet=Math.max(...state.players.map(x=>x.streetBet));
      } else if(a.type==='show') { /* Showdown information does not change money. */ }
      else if(a.type==='collect') { /* Award information is preserved separately; pot remains gross for review. */ }
      else {fail('unknown_action',`不支持的行动：${a.type}`,a);continue;}
      if(voluntary){pending.delete(pi);if(a.type==='bet'||a.type==='raiseTo')for(let j=0;j<state.players.length;j++){const other=state.players[j];if(j!==pi&&!other.folded&&!other.allIn&&other.streetBet<state.currentBet-EPS)pending.add(j);}const alive=state.players.filter(p=>!p.folded),able=alive.filter(p=>!p.allIn);if(alive.length===1||(able.length===1&&able[0].streetBet>=state.currentBet-EPS))pending.clear();nextActor=nextFrom(pi);}
    }
    const accounted=state.pot+state.players.reduce((s,p)=>s+p.stack,0);
    if(Math.abs(accounted-total)>EPS*Math.max(1,total))throw Error('内部资金守恒检查失败。');
    ledger.push({...a,index,street:state.street,potBefore:before.pot,potAfter:state.pot,stackAfter:a.player?state.players.find(p=>p.id===a.player)?.stack:null,paid:round(state.pot-before.pot),currentBet:state.currentBet,...(enforceOrder?{nextActor:nextActor===null?null:state.players[nextActor].id}:{})});
  }
  return {ok:!issues.some(x=>x.severity==='error'),state,ledger,snapshots,issues,conservation:{initialTotal:total,finalTotal:round(state.pot+state.players.reduce((s,p)=>s+p.stack,0)),difference:round(state.pot+state.players.reduce((s,p)=>s+p.stack,0)-total)}};
}

const amountPattern='(?:[$€£¥￥]\\s*)?([\\d,]+(?:\\.\\d+)?)';
const amountNumber = text => Number(String(text).replace(/[$€£¥￥,\s]/g,''));
function seatPositions(seats,button) {
  const clockwise=[...seats].sort((a,b)=>a.seat-b.seat), bi=clockwise.findIndex(p=>p.seat===button);
  if(bi<0)return new Map();
  const ordered=[...clockwise.slice(bi),...clockwise.slice(0,bi)],n=ordered.length;
  if(n===2)return new Map([[ordered[0].id,'BTN'],[ordered[1].id,'BB']]);
  const middle={3:[],4:['CO'],5:['UTG','CO'],6:['UTG','HJ','CO'],7:['UTG','LJ','HJ','CO'],8:['UTG','UTG+1','LJ','HJ','CO'],9:['UTG','UTG+1','UTG+2','LJ','HJ','CO']}[n]||[];
  return new Map(ordered.map((p,i)=>[p.id,['BTN','SB','BB',...middle][i]||`Seat${p.seat}`]));
}

function annotateStartingPots(snapshots,ledger,issues,selectedStreet){
 for(const snapshot of snapshots){
  const s=snapshot.scenario,prior=new Map(s.players.map(p=>[p.id,0]));
  for(const a of ledger)if(a.index<snapshot.actionIndex&&a.type!=='ante'&&prior.has(a.player))prior.set(a.player,round(prior.get(a.player)+(a.paid??0)));
  const paid=[...prior.values()];
  if(s.players.some(p=>p.stack<=EPS)&&Math.max(...paid)-Math.min(...paid)>EPS){
   s.preexistingSidePot=true;
   const warning=issue(snapshot.street===selectedStreet?'error':'warning','preexisting_sidepot',`${snapshot.street} 起点之前已有不同参池资格的主池/边池或未退回投入，不能把总额合并为全员可赢的初始底池；请选择更早的研究起点。`,'pot');warning.street=snapshot.street;issues.push(warning);
  }
 }
}

function annotateFoldedHero(snapshots,hero,heroId,issues,selectedStreet){
 if(!hero||!heroId)return;
 for(const snapshot of snapshots)if(!snapshot.scenario.players.some(p=>p.id===heroId)){
  snapshot.scenario.hasUnsupportedDeadCards=true;
  issues.push({...issue(snapshot.street===selectedStreet?'error':'warning','unsupported_dead_cards',`${snapshot.street} 起点之前 Hero 已弃牌，其已知底牌仍影响牌张移除。当前引擎不支持这个额外死牌条件；请选择更早的街，或明确另建忽略该条件的假设模型。`,'deadCards'),street:snapshot.street});
 }
}

function parseHandHistory(raw,options) {
  const issues=[],missing=[],assumptions=[],lines=raw.replace(/\r/g,'').split('\n'),players=[],actions=[];
  const header=lines.find(l=>/(?:PokerStars Hand|Poker Hand|GGPoker Hand|GGNetwork Hand) #/i.test(l))||lines[0];
  const blindMatch=header.match(/\(\s*[$€£¥￥]?([\d,.]+)\s*\/\s*[$€£¥￥]?([\d,.]+)(?:[^)]*)\)/);
  const bigBlind=blindMatch?amountNumber(blindMatch[2]):options.bigBlind?Number(options.bigBlind):null;
  if(!finite(bigBlind)||bigBlind<=0) {issues.push(issue('error','missing_big_blind','未识别大盲金额，无法把牌谱金额转换为 BB。','bigBlind'));missing.push('bigBlind');}
  const divisor=bigBlind||1;
  const buttonMatch=raw.match(/Seat\s+#?(\d+)\s+is the button/i),button=buttonMatch?Number(buttonMatch[1]):null;
  if(button===null){issues.push(issue('error','missing_button','没有识别庄位；请补充位置后再研究。','button'));missing.push('button');}
  for(let i=0;i<lines.length;i++){
    const m=lines[i].match(/^Seat\s+(\d+):\s+(.+?)\s+\(\s*[$€£¥￥]?([\d,.]+)(?:\s+in chips)?\s*\)/i);
    if(m)players.push({id:`seat${m[1]}`,seat:Number(m[1]),name:m[2],stack:round(amountNumber(m[3])/divisor),range:''});
  }
  if(players.length<2){issues.push(issue('error','missing_seats','未识别至少两位玩家的起始筹码。','players'));missing.push('players');}
  const positions=seatPositions(players,button);for(const p of players)p.position=positions.get(p.id)||'';
  const byName=new Map(players.map(p=>[p.name,p]));
  let heroName=null,hero='',summary=false;
  const board=[];
  const lineAction=(i,type,player,amount,extra={})=>actions.push({type,player, ...(amount==null?{}:{amount:round(amount/divisor)}),line:i+1,raw:lines[i],...extra});
  for(let i=0;i<lines.length;i++) {
    const text=lines[i].trim();if(/^\*\*\* SUMMARY/.test(text)){summary=true;continue;}if(summary)continue;
    const dealt=text.match(/^Dealt to (.+?) \[([^\]]+)\]/i);if(dealt){heroName=dealt[1];try{hero=cardString(dealt[2]);}catch(e){issues.push(issue('error','invalid_hero',e.message,'hero',i+1));}continue;}
    const street=text.match(/^\*\*\* (FLOP|TURN|RIVER) \*\*\* (.+)/);
    if(street){const groups=[...street[2].matchAll(/\[([^\]]+)\]/g)].map(m=>m[1]);try{const next=cards(groups.join(' '));board.splice(0,board.length,...next);actions.push({type:'street',street:street[1].toLowerCase(),board:next.map(cardText).join(' '),line:i+1,raw:lines[i]});}catch(e){issues.push(issue('error','invalid_board',e.message,'board',i+1));}continue;}
    const refund=text.match(new RegExp(`^Uncalled bet \\(${amountPattern}\\) returned to (.+)$`,'i'));
    if(refund){const p=byName.get(refund[2]);if(p)lineAction(i,'return',p.id,amountNumber(refund[1]));else issues.push(issue('error','unknown_player','未跟注退回记录中的玩家不存在。',undefined,i+1));continue;}
    // Player names may contain spaces or punctuation, so select the observed prefix.
    const p=[...players].sort((a,b)=>b.name.length-a.name.length).find(p=>text.startsWith(p.name+': '));
    if(!p){if(/^.+?:\s+(?:posts|bets|raises|calls|folds|checks)\b/i.test(text))issues.push(issue('error','unknown_player','行动中的玩家不在已识别座位列表中。',undefined,i+1));continue;}
    const action=text.slice(p.name.length+2);
    if(/^folds\b/.test(action))lineAction(i,'fold',p.id);
    else if(/^checks\b/.test(action))lineAction(i,'check',p.id);
    else if(/^shows\b|^doesn't show|^mucks\b/.test(action))lineAction(i,'show',p.id);
    else {
      let m;
      if((m=action.match(new RegExp(`^posts small & big blinds ${amountPattern}`,'i')))){const total=amountNumber(m[1]);if(total<divisor)issues.push(issue('error','ambiguous_dead_blind','补盲金额小于一个大盲，不能确定死盲与活盲分配。',undefined,i+1));else {lineAction(i,'ante',p.id,total-divisor,{description:'补盲中的死盲'});lineAction(i,'post',p.id,divisor,{description:'补盲中的活大盲'});}}
      else if((m=action.match(new RegExp(`^posts (?:small blind|big blind|straddle) ${amountPattern}`,'i'))))lineAction(i,'post',p.id,amountNumber(m[1]),/^posts straddle/i.test(action)?{blindRole:'straddle'}:{});
      else if((m=action.match(new RegExp(`^posts (?:the ante|ante) ${amountPattern}`,'i'))))lineAction(i,'ante',p.id,amountNumber(m[1]));
      else if((m=action.match(new RegExp(`^calls ${amountPattern}`,'i'))))lineAction(i,'call',p.id,amountNumber(m[1]));
      else if((m=action.match(new RegExp(`^bets ${amountPattern}`,'i'))))lineAction(i,'bet',p.id,amountNumber(m[1]));
      else if((m=action.match(new RegExp(`^raises ${amountPattern} to ${amountPattern}`,'i'))))lineAction(i,'raiseTo',p.id,amountNumber(m[2]));
      else if(/^collected\b/.test(action))lineAction(i,'collect',p.id);
      else if(action&&!/^(?:sits out|is sitting out|has timed out|is disconnected|is connected|said,|has returned|will be allowed|joins the table)/i.test(action))issues.push(issue(/(?:bets|raises|calls|posts|all-in|[$€£¥￥])/i.test(action)?'error':'warning','unparsed_action',`这行行动未识别，请核对：${text}`,undefined,i+1));
    }
  }
  if(!heroName){issues.push(issue('warning','missing_hero','牌谱没有可识别的 Dealt to 行；可以先研究范围，或自行指定 Hero。','hero'));missing.push('hero');}
  let replay={ledger:[],snapshots:[],issues:[],ok:false,state:null,conservation:null};
  if(players.length>=2)try{replay=replayActions({pot:0,players,street:'preflop',board:''},actions,{strict:false,minBet:1,enforceOrder:true});}catch(e){issues.push(issue('error','replay_failed',e.message));}
  issues.push(...replay.issues);
  const snapshots=replay.snapshots.map(snapshot=>{
    const active=snapshot.players.filter(p=>!p.folded);
    // Postflop action proceeds clockwise after the button; preserve all-in players in pot.
    active.sort((a,b)=>((a.seat-button+100)%100||100)-((b.seat-button+100)%100||100));
    const activePlayers=active.map(p=>({id:p.id,name:p.name,position:p.position,range:'',stack:p.stack}));
    return {street:snapshot.street,actionIndex:snapshot.actionIndex,scenario:{version:1,title:`${header.match(/#([\w-]+)/)?.[1]||'导入牌局'} · ${snapshot.street}`,format:'online',unit:'BB',board:snapshot.board,hero:active.some(p=>p.name===heroName)?hero:'',heroSeat:active.findIndex(p=>p.name===heroName)>=0?active.findIndex(p=>p.name===heroName):null,pot:snapshot.pot,players:activePlayers,toAct:activePlayers.findIndex(p=>p.stack>EPS)}};
  });
  const chosen=options.street?snapshots.find(s=>s.street===options.street):snapshots[0];
  annotateStartingPots(snapshots,replay.ledger,issues,chosen?.street);
  annotateFoldedHero(snapshots,hero,players.find(p=>p.name===heroName)?.id,issues,chosen?.street);
  if(!chosen){issues.push(issue('error','missing_postflop','牌谱没有可研究的翻后街起点。','board'));missing.push('board');}
  const scenario=chosen?.scenario||null;
  if(scenario){for(let i=0;i<scenario.players.length;i++)missing.push(`players.${i}.range`);issues.push(issue('warning','ranges_required','行动记录已恢复；玩家范围仍需由你指定，牌谱本身不包含完整范围。','players'));}
  if(/(?:Run It Twice|FIRST FLOP|SECOND FLOP|BOMB POT|Short Deck|Omaha|Tournament #)/i.test(raw))issues.push(issue('error','unsupported_variant','当前导入器仅支持标准单公共牌面无限注德州扑克现金局。'));
  const rakeMatch=raw.match(/Total pot\s+[$€£¥￥]?([\d,.]+).*?Rake\s+[$€£¥￥]?([\d,.]+)/i);
  if(rakeMatch&&replay.state){const reported=round(amountNumber(rakeMatch[1])/divisor);if(Math.abs(reported-replay.state.pot)>1e-5)issues.push(issue('error','pot_mismatch',`牌谱总结底池 ${reported} BB 与行动重建 ${replay.state.pot} BB 不一致。`));}
  assumptions.push('金额按牌谱大盲换算为 BB。','研究场景是所选街的起点；本街后续行动保留在行动账本中。','没有根据对手亮牌反向填入其整个范围。');
  return {ok:!issues.some(x=>x.severity==='error'),ready:false,kind:/PokerStars/i.test(header)?'pokerstars':'gg',raw,scenario,ledger:replay.ledger,snapshots,issues,missing,assumptions,metadata:{header,bigBlind,button,heroName,rake:rakeMatch?round(amountNumber(rakeMatch[2])/divisor):null,conservation:replay.conservation}};
}

function parseNotation(raw,options) {
  const issues=[],missing=[],assumptions=[],normalized=raw.replace(/\r/g,'').replace(/[；;]/g,'\n'),lines=normalized.split('\n').map(s=>s.trim()).filter(Boolean);
  const s={version:1,title:'现场速记',format:/线上|online/i.test(raw)?'online':'live',unit:'BB',board:'',hero:'',heroSeat:null,pot:NaN,players:[],toAct:null};
  const recognized=new Set(),pendingActions=[],explicitUnits=[];
  let inputUnit=options.unit||null,bigBlind=options.bigBlind?Number(options.bigBlind):null,heroIdentifier=null,actorIdentifier=null;
  const pick=(regex,fn)=>{for(let i=0;i<lines.length;i++){const m=lines[i].match(regex);if(m){fn(m,i);recognized.add(i);}}};
  pick(/^(?:标题|title)\s*[:：]\s*(.+)$/i,m=>s.title=m[1]);
  pick(/^(?:场景|类型|format)\s*[:：]\s*(线上|现场|研究|live|online|study)/i,m=>s.format=({线上:'online',现场:'live',研究:'study'})[m[1]]||m[1].toLowerCase());
  pick(/^(?:单位|unit)\s*[:：]\s*(BB|美元|美金|\$|USD|筹码|currency)$/i,m=>inputUnit=/^BB$/i.test(m[1])?'BB':'currency');
  pick(/^(?:盲注|blinds?)\s*[:：]?\s*[$¥￥€£]?([\d.]+)\s*[/／]\s*[$¥￥€£]?([\d.]+)/i,m=>bigBlind=Number(m[2]));
  const factor=()=>inputUnit==='currency'?(bigBlind||1):1;
  pick(/^(?:底池|pot)\s*[:：]?\s*[$¥￥€£]?([\d,.]+)\s*(BB|美元|美金|USD|筹码)?$/i,(m,i)=>{const fieldUnit=m[2]?(/^BB$/i.test(m[2])?'BB':'currency'):/[$¥￥€£]/.test(lines[i])?'currency':null;if(fieldUnit){explicitUnits.push({unit:fieldUnit,line:i+1});if(!inputUnit)inputUnit=fieldUnit;}s.pot=amountNumber(m[1]);});
  pick(/^(?:公共牌|牌面|board|翻牌|转牌|河牌|flop|turn|river)\s*[:：]?\s*(.+)$/i,(m,i)=>{try{s.board=cardString(m[1]);}catch(e){issues.push(issue('error','invalid_board',e.message,'board',i+1));}});
  pick(/^(?:Hero|我的手牌|手牌|我)\s*[:：]\s*(?:(SB|BB|UTG(?:\+[12])?|LJ|HJ|CO|BTN|IP|OOP)\s+)?(.+)$/i,(m,i)=>{heroIdentifier=m[1]?.toUpperCase()||heroIdentifier;try{s.hero=cardString(m[2]);}catch(e){issues.push(issue('error','invalid_hero',e.message,'hero',i+1));}});
  pick(/^(?:我的位置|heroSeat|hero position)\s*[:：]\s*(.+)$/i,m=>heroIdentifier=m[1].trim());
  pick(/^(?:先行动|轮到|toAct|first)\s*[:：]\s*(.+)$/i,m=>actorIdentifier=m[1].trim());
  pick(/^(?:备注|假设|notes?)\s*[:：]\s*(.+)$/i,m=>{s.notes=(s.notes?s.notes+'\n':'')+m[1];});
  // Intentionally explicit grammar: positional/player lines are editable, not guessed ranges.
  for(let i=0;i<lines.length;i++) {
    if(recognized.has(i))continue;
    const m=lines[i].match(/^(?:玩家\s*[:：]?\s*)?(SB|BB|UTG(?:\+[12])?|LJ|HJ|CO|BTN|MP|EP|IP|OOP)\s*(?:\(([^)]+)\)|（([^）]+)）)?\s*[:：]?\s*(?:筹码|stack)?\s*[:：]?\s*[$¥￥€£]?([\d,.]+)\s*(BB|美元|美金|USD|筹码)?\s*(?:[,，]\s*)?(?:(?:范围|range)\s*[:：]?\s*(.*))?$/i);
    if(m){const position=m[1].toUpperCase(),name=m[2]||m[3]||position,fieldUnit=m[5]?(/^BB$/i.test(m[5])?'BB':'currency'):/[$¥￥€£]/.test(lines[i])?'currency':null;if(fieldUnit){explicitUnits.push({unit:fieldUnit,line:i+1});if(!inputUnit)inputUnit=fieldUnit;}s.players.push({id:`p${s.players.length+1}`,position,name,stack:amountNumber(m[4]),range:(m[6]||'').trim()});recognized.add(i);if(/hero|自己|我/i.test(name))heroIdentifier=position;continue;}
    const a=lines[i].match(/^(?:(?:行动|action)\s*[:：]\s*)?(SB|BB|UTG(?:\+[12])?|LJ|HJ|CO|BTN|MP|EP|IP|OOP)\s*(过牌|check|弃牌|fold|下注|bet|跟注|call|加注到|raise\s+to|加注|raise|全下|all[- ]?in)\s*[$¥￥€£]?([\d,.]+)?\s*(BB)?$/i);
    if(a){if(a[4])explicitUnits.push({unit:'BB',line:i+1});else if(/[$¥￥€£]/.test(lines[i]))explicitUnits.push({unit:'currency',line:i+1});const verb=a[2].toLowerCase();if(['加注','raise','全下','allin','all-in','all in'].includes(verb)){issues.push(issue('error','ambiguous_raise_amount','请明确写“加注到 XX”，它表示本街累计投入；全下也请注明加注到总额。',undefined,i+1));}else pendingActions.push({position:a[1].toUpperCase(),type:({'过牌':'check','弃牌':'fold','下注':'bet','跟注':'call','加注到':'raiseTo','raise to':'raiseTo'})[verb]||verb,amount:a[3]===undefined?undefined:amountNumber(a[3]),line:i+1,raw:lines[i]});recognized.add(i);}
  }
  if(!inputUnit){issues.push(issue('error','missing_unit','请写明“单位：BB”或“单位：美元”；不能猜测底池与筹码单位。','unit'));missing.push('unit');}
  for(const item of explicitUnits)if(inputUnit&&item.unit!==inputUnit)issues.push(issue('error','mixed_units','这行金额单位与场景单位不同；请统一为 BB 或现金金额后导入，避免静默误算。','unit',item.line));
  if(inputUnit==='currency'&&(!finite(bigBlind)||bigBlind<=0)){issues.push(issue('error','missing_big_blind','现金金额需要大盲金额才能换算为 BB，例如“盲注：1/3”。','bigBlind'));missing.push('bigBlind');}
  const divisor=factor();s.pot=round(s.pot/divisor);s.players.forEach(p=>p.stack=round(p.stack/divisor));
  if(heroIdentifier)s.heroSeat=s.players.findIndex(p=>p.position.toLowerCase()===heroIdentifier.toLowerCase()||p.name.toLowerCase()===heroIdentifier.toLowerCase());
  if(actorIdentifier)s.toAct=s.players.findIndex(p=>p.position.toLowerCase()===actorIdentifier.toLowerCase()||p.name.toLowerCase()===actorIdentifier.toLowerCase());
  else if(s.players.length&&s.players.every(p=>POSITIONS.includes(p.position))){const order=['OOP','SB','BB','EP','UTG','UTG+1','UTG+2','MP','LJ','HJ','CO','BTN','IP'];s.toAct=s.players.map((p,i)=>({p,i})).filter(x=>x.p.stack>0).sort((a,b)=>order.indexOf(a.p.position)-order.indexOf(b.p.position))[0]?.i??0;assumptions.push(`依照翻后位置顺序，街起点由 ${s.players[s.toAct].name} 先行动；可在编辑器修改。`);}
  for(let i=0;i<lines.length;i++)if(!recognized.has(i)&&!/^#|^\/\//.test(lines[i]))issues.push(issue('warning','unparsed_text',`未识别这行，请在场景编辑器补充或确认：${lines[i]}`,undefined,i+1));
  const validation=validateScenario(s,{requireRanges:false});issues.push(...validation.issues);for(const x of validation.issues)if(x.field&&(x.code.startsWith('missing')||x.code.startsWith('invalid')))missing.push(x.field);
  Object.assign(s,validation.scenario);
  let replay={ledger:[],issues:[],conservation:null};
  if(pendingActions.length&&validation.ok)try{replay=replayActions({...s,street:cards(s.board).length===3?'flop':cards(s.board).length===4?'turn':'river'},pendingActions.map(a=>({...a,player:s.players.find(p=>p.position===a.position)?.id,amount:a.amount===undefined?undefined:round(a.amount/divisor)})),{strict:false,enforceOrder:true});issues.push(...replay.issues);}catch(e){issues.push(issue('error','replay_failed',e.message));}
  if(pendingActions.length&&validation.ok)replay.ledger.unshift({type:'street',street:({3:'flop',4:'turn',5:'river'})[cards(s.board).length],board:s.board,potBefore:s.pot,potAfter:s.pot,index:-1,source:'explicit-street-root',raw:'速记中明确给定的当前街起点'});
  assumptions.push('底池与筹码均解释为当前街开始时的金额；行动行在这个起点上回放。');
  return {ok:!issues.some(x=>x.severity==='error'),ready:!issues.some(x=>x.severity==='error'||x.code==='missing_range'||x.code==='unparsed_text'),kind:'notation',raw,scenario:validation.scenario,ledger:replay.ledger,snapshots:[],issues,missing:[...new Set(missing)],assumptions,metadata:{inputUnit,bigBlind,conservation:replay.conservation}};
}

/** A deliberately bounded natural-language grammar for common live-hand notes.
 * Every inferred call is resolved against the ledger; unsupported phrases stay
 * visible, and ranges remain missing rather than being guessed. */
function parseNaturalHand(raw,options){
  const issues=[],assumptions=[],missing=[],clauses=raw.replace(/\r/g,'').split(/[，,。；;\n]+/).map(x=>x.trim()).filter(Boolean);
  const positionPattern='(?:UTG\\+[12]|UTG|BTN|SB|BB|LJ|HJ|CO|MP|EP)';
  const b=raw.match(/(?:SB\s*\/\s*BB|盲注)\s*(?:为|是|[:：])?\s*[$¥￥]?([\d.]+)\s*\/\s*[$¥￥]?([\d.]+)\s*(BB|美元|美金|USD)?/i);
  if(!b)return parseNotation(raw,options);
  const bigBlind=Number(b[2]),smallBlind=Number(b[1]),inputUnit=b[3]?(/^BB$/i.test(b[3])?'BB':'currency'):options.unit||'currency',divisor=inputUnit==='BB'?1:bigBlind;
  if(!(bigBlind>0&&smallBlind>0&&smallBlind<=bigBlind))return {ok:false,ready:false,kind:'natural',raw,scenario:null,ledger:[],snapshots:[],issues:[issue('error','invalid_blinds','盲注金额无效。')],missing:[],assumptions:[]};
  const players=[],recognized=new Set();let hero='',heroPosition=null;
  const amountValue=(n,unit)=>round(Number(n)/(unit&&/^BB$/i.test(unit)?1:divisor));
  const stackRegex=new RegExp(`^(${positionPattern})\\s*(?:筹码|剩余筹码)?\\s*[:：]?\\s*[$¥￥]?([\\d.]+)\\s*(BB|美元|美金|USD)?$`,'i');
  for(let i=0;i<clauses.length;i++){
    const c=clauses[i],m=c.match(stackRegex);
    if(m){players.push({id:m[1].toUpperCase(),name:m[1].toUpperCase(),position:m[1].toUpperCase(),stack:amountValue(m[2],m[3]),range:''});recognized.add(i);continue;}
    if(/(?:SB\s*\/\s*BB|盲注)/i.test(c)){recognized.add(i);continue;}
    if(/^(?:PokerLab现场行动记录 v1|[二三四五六七八九十\d]+人桌|现场|线上|现金局|德州扑克|六人桌现金局|其他人弃牌|其余玩家弃牌)/.test(c)){recognized.add(i);continue;}
    const hp=c.match(new RegExp(`(?:我在|Hero\\s*(?:在|位于|[:：])|我是)\\s*(${positionPattern})`,'i'));if(hp){heroPosition=hp[1].toUpperCase();recognized.add(i);}
    const hc=c.match(/(?:持有?|手牌(?:为|是)?|Hero\s*[:：])\s*((?:(?:10|[2-9TJQKA])[cdhs♣♦♥♠]\s*){2})/i);if(hc){try{hero=cardString(hc[1]);}catch(e){issues.push(issue('error','invalid_hero',e.message,'hero',i+1));}recognized.add(i);}
    if(/^(?:研究|想研究|重点|备注|有效筹码)/.test(c)&&!/有效筹码/.test(c)){recognized.add(i);}
  }
  const order=['SB','BB','UTG','UTG+1','UTG+2','EP','MP','LJ','HJ','CO','BTN'];players.sort((a,b)=>order.indexOf(a.position)-order.indexOf(b.position));
  if(new Set(players.map(p=>p.position)).size!==players.length)issues.push(issue('error','duplicate_position','同一位置出现多次筹码记录，请分别注明初始和当前街筹码。','players'));
  const headsUp=players.length===2&&players.some(p=>p.id==='BTN');
  if(!players.some(p=>p.id===(headsUp?'BTN':'SB'))||!players.some(p=>p.id==='BB'))issues.push(issue('error','missing_blind_players','重建翻前底池需要 SB 与 BB 的初始筹码；双人桌的小盲为 BTN。','players'));
  if(players.length<2||players.length>9)issues.push(issue('error','invalid_player_count','需要记录 2–9 位相关玩家的初始筹码。','players'));
  const actions=[];
  const sb=players.find(p=>p.id===(headsUp?'BTN':'SB')),bb=players.find(p=>p.id==='BB');
  if(sb&&bb){actions.push({type:'post',player:sb.id,amount:round(smallBlind/divisor),raw:'由明确盲注补全 SB 强制投入',inferred:true});actions.push({type:'post',player:bb.id,amount:round(bigBlind/divisor),raw:'由明确盲注补全 BB 强制投入',inferred:true});}
  let board=[],street='preflop';
  const initial={pot:0,players,street:'preflop',board:''};
  const currentReplay=()=>replayActions(initial,actions,{strict:false,minBet:round(bigBlind/divisor),enforceOrder:true});
  for(let i=0;i<clauses.length;i++){
    if(recognized.has(i))continue;
    const c=clauses[i],sm=c.match(/^(翻牌|转牌|河牌|flop|turn|river)\s*[:：]?\s*(.+)$/i);
    if(sm){
      const stage=({'翻牌':'flop','转牌':'turn','河牌':'river'})[sm[1]]||sm[1].toLowerCase();
      try{const next=cards(sm[2]);if(stage==='flop')board=next;else if(next.length===1)board=[...board,...next];else board=next;const expected={flop:3,turn:4,river:5}[stage];if(board.length!==expected)throw Error(`${sm[1]} 需要累计 ${expected} 张公共牌。`);actions.push({type:'street',street:stage,board:board.map(cardText).join(' '),raw:c,line:i+1});street=stage;}catch(e){issues.push(issue('error','invalid_board',e.message,'board',i+1));}recognized.add(i);continue;
    }
    const refund=c.match(new RegExp(`^(${positionPattern})\\s*退回未跟注额\\s*[$¥￥]?([\\d.]+)\\s*(BB|美元|美金|USD)?$`,'i'));
    if(refund){recognized.add(i);actions.push({type:'return',player:refund[1].toUpperCase(),amount:amountValue(refund[2],refund[3]),raw:c,line:i+1});continue;}
    const m=c.match(new RegExp(`^(${positionPattern})\\s*(加注到|raise\\s+to|跟注到|跟注|call|下注|bet|过牌|check|弃牌|fold|加注|全下)\\s*[$¥￥]?([\\d.]+)?\\s*(BB|美元|美金|USD)?$`,'i'));
    if(m){
      const player=m[1].toUpperCase(),verb=m[2].toLowerCase();recognized.add(i);
      if(!players.some(p=>p.id===player)){issues.push(issue('error','unknown_player',`${player} 未提供初始筹码。`,'players',i+1));continue;}
      if(['加注','全下'].includes(verb)){issues.push(issue('error','ambiguous_raise_amount','请把加注/全下写成“加注到 XX BB”，明确本街总投入。',undefined,i+1));continue;}
      const type=({'加注到':'raiseTo','raise to':'raiseTo','跟注':'call','跟注到':'call','下注':'bet','过牌':'check','弃牌':'fold'})[verb]||verb;
      let amount=m[3]===undefined?undefined:amountValue(m[3],m[4]),inferred=false;
      if(type==='call'){
        try{const prior=currentReplay();if(!prior.ok){issues.push(issue('error','unresolved_prior_action','前面行动尚有错误，不能推导本次跟注金额。',undefined,i+1));continue;}const p=prior.state.players.find(p=>p.id===player),owed=Math.min(p.stack,prior.state.currentBet-p.streetBet);if(amount===undefined){amount=owed;inferred=true;}else if(verb==='跟注到')amount=round(amount-p.streetBet);}catch(e){issues.push(issue('error','replay_failed',e.message,undefined,i+1));continue;}
      }
      if(['bet','raiseTo'].includes(type)&&amount===undefined){issues.push(issue('error','missing_action_amount','下注或加注需要明确金额。',undefined,i+1));continue;}
      actions.push({type,player,...(amount===undefined?{}:{amount}),raw:c,line:i+1,...(inferred?{inferred:true,description:'根据前序投入自动算出本次跟入金额'}:{})});continue;
    }
    // An explicit pot is a check against the ledger, never an overwrite.
    const pm=c.match(/^(?:底池|pot)\s*[:：]?\s*[$¥￥]?([\d.]+)\s*(BB|美元|美金|USD)?$/i);
    if(pm){recognized.add(i);try{const r=currentReplay(),declared=amountValue(pm[1],pm[2]);if(Math.abs(r.state.pot-declared)>EPS)issues.push(issue('error','pot_mismatch',`你记录底池 ${declared} BB，但前序行动重建为 ${r.state.pot} BB。`,'pot',i+1));}catch(e){issues.push(issue('error','replay_failed',e.message,undefined,i+1));}continue;}
  }
  let replay={ok:false,ledger:[],snapshots:[],issues:[],conservation:null,state:null};
  if(players.length>=2)try{replay=currentReplay();issues.push(...replay.issues);}catch(e){issues.push(issue('error','replay_failed',e.message));}
  for(let i=0;i<clauses.length;i++)if(!recognized.has(i))issues.push(issue('warning','unparsed_text',`未识别这段，请核对：${clauses[i]}`,undefined,i+1));
  if(!heroPosition&&hero){issues.push(issue('warning','missing_hero_seat','已识别手牌，但需要指定 Hero 位置。','heroSeat'));missing.push('heroSeat');}
  const snapshots=replay.snapshots.map(snapshot=>{
    const active=snapshot.players.filter(p=>!p.folded).map(p=>({id:p.id,name:p.id===heroPosition?'Hero':p.name,position:p.position,stack:p.stack,range:''}));
    return {street:snapshot.street,actionIndex:snapshot.actionIndex,scenario:{version:1,title:`${/线上|GG|PokerStars/i.test(raw)?'线上':'现场'}速记 · ${snapshot.street}`,format:/线上|GG|PokerStars/i.test(raw)?'online':'live',unit:'BB',board:snapshot.board,hero:active.some(p=>p.id===heroPosition)?hero:'',heroSeat:active.findIndex(p=>p.id===heroPosition)>=0?active.findIndex(p=>p.id===heroPosition):null,pot:snapshot.pot,players:active,toAct:active.findIndex(p=>p.stack>0),rake:0,rakeCap:0}};
  });
  const selected=options.street?snapshots.find(s=>s.street===options.street):snapshots[0],scenario=selected?.scenario||null;
  annotateStartingPots(snapshots,replay.ledger,issues,selected?.street);
  annotateFoldedHero(snapshots,hero,heroPosition,issues,selected?.street);
  if(!scenario){issues.push(issue('error','missing_postflop','未能从行动记录恢复一个完整的翻后街起点。','board'));missing.push('board');}
  else {scenario.players.forEach((p,i)=>missing.push(`players.${i}.range`));issues.push(issue('warning','ranges_required','行动账本已恢复；请为每位玩家补充到达该街起点的范围。','players'));const valid=validateScenario(scenario,{requireRanges:false});issues.push(...valid.issues.filter(i=>i.code!=='missing_range'));}
  assumptions.push('筹码行解释为发牌前的起始筹码；SB/BB 强制投入已按明确盲注加入。','未列出的弃牌玩家被视为没有额外投入；如有 ante、straddle 或此前跟注，请补充完整记录。','未指定抽水规则，场景暂标为 0；求解前需核对。','未注明金额的跟注只在前序账本合法时按应跟金额推导；每项推导都标记在账本。','研究场景保留所选街起点；本街实际行动在账本显示，不伪装为起点已包含。');
  return {ok:!issues.some(x=>x.severity==='error'),ready:false,kind:'natural',raw,scenario,ledger:replay.ledger,snapshots,issues,missing,assumptions,metadata:{inputUnit,bigBlind,smallBlind,conservation:replay.conservation,selectedStreet:selected?.street||null}};
}

export function parseScenario(text, options = {}) {
  const raw=String(text||'');
  if(raw.length>500000)return {ok:false,ready:false,kind:'unknown',raw:raw.slice(0,1000),scenario:null,ledger:[],snapshots:[],issues:[issue('error','input_too_long','单次导入限制 500 KB；请先选择一手牌。')],missing:[],assumptions:[]};
  if(!raw.trim())return {ok:false,ready:false,kind:'unknown',raw,scenario:null,ledger:[],snapshots:[],issues:[issue('error','empty_input','请粘贴一手牌谱、结构化速记或场景 JSON。')],missing:[],assumptions:[]};
  if(raw.trim().startsWith('{')){
    try {const data=JSON.parse(raw),validation=validateScenario(data.scenario||data,{requireRanges:false});return {ok:validation.ok,ready:validation.ok&&!validation.issues.some(x=>x.code==='missing_range'),kind:'json',raw,scenario:validation.scenario,ledger:[],snapshots:[],issues:validation.issues,missing:validation.issues.filter(x=>x.code.startsWith('missing')).map(x=>x.field),assumptions:[]};}
    catch(e){return {ok:false,ready:false,kind:'json',raw,scenario:null,ledger:[],snapshots:[],issues:[issue('error','invalid_json',`JSON 无法读取：${e.message}`)],missing:[],assumptions:[]};}
  }
  // A comma is accepted only as a three-digit thousands separator in money.
  // Range commas are unrelated syntax and are excluded from this check.
  const moneyLines=raw.split(/\r?\n/).map(line=>line.replace(/(?:范围|range)\s*[:：]?\s*.*$/i,''));
  const moneyIssues=[];
  if(moneyLines.some(line=>[...line.matchAll(/\b\d[\d,.]*,[\d,.]*\d\b/g)].some(m=>!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(m[0]))))moneyIssues.push(issue('error','unsupported_numeric_format','金额逗号格式不明确；小数请用小数点，千位逗号必须每组三位，例如 2.50 或 2,500。'));
  const currencies=new Set(moneyLines.flatMap(line=>[...line.matchAll(/([$€£¥￥])\s*[\d,.]+/g)].map(m=>m[1]==='￥'?'¥':m[1])));
  if(currencies.size>1)moneyIssues.push(issue('error','mixed_currency','同一手牌中出现不同货币符号；请统一金额单位后导入，系统不会猜测汇率。'));
  if(moneyIssues.length)return {ok:false,ready:false,kind:'unknown',raw,scenario:null,ledger:[],snapshots:[],issues:moneyIssues,missing:[],assumptions:[]};
  if((raw.match(/(?:PokerStars Hand|Poker Hand|GGPoker Hand|GGNetwork Hand) #/gi)||[]).length>1)return {ok:false,ready:false,kind:'hand-history',raw,scenario:null,ledger:[],snapshots:[],issues:[issue('error','multiple_hands','检测到多手牌谱；请一次选取一手，避免把不同牌局的资金和行动合并。')],missing:[],assumptions:[]};
  if(/(?:PokerStars Hand|Poker Hand|GGPoker Hand|GGNetwork Hand) #/i.test(raw)||options.format==='pokerstars'||options.format==='gg')return parseHandHistory(raw,options);
  if(/^\s*PokerLab现场行动记录 v1\s*(?:[。；;\r\n]|$)/.test(raw))return parseNaturalHand(raw,options);
  if(/(?:SB\s*\/\s*BB|盲注)\s*(?:为|是|[:：])?\s*[$¥￥]?[\d.]+\s*\/\s*[$¥￥]?[\d.]+/i.test(raw)&&/翻牌|flop/i.test(raw)&&/加注到|raise\s+to/i.test(raw)&&!/^\s*(?:单位|unit)\s*[:：]/im.test(raw))return parseNaturalHand(raw,options);
  return parseNotation(raw,options);
}

export const IMPORT_EXAMPLES = [
  {id:'live-three-way',title:'赌场三人底池 · 中文速记',format:'notation',text:'标题：三人河牌，身后还有玩家\n类型：现场\n单位：BB\n盲注：1/3\n公共牌：Ks 7h 2h 9c 3s\n底池：60\nHero：BB Ac Kd\nSB（前位）：筹码 120 范围 77,22,99,KQs,AhQh,AhJh\nBB（Hero）：筹码 160 范围 AA,AK,KQs,77,22\nBTN（后位）：筹码 90 范围 99,77,KQs,KJs,AhTh\n先行动：SB'},
  {id:'online-heads-up',title:'线上单挑 · 可直接研究',format:'notation',text:'标题：河牌价值加注与差牌跟注\n类型：线上\n单位：BB\n公共牌：Ks 7h 2h 9c 3s\n底池：40\nHero：BTN Ac Kd\nBB：筹码 160 范围 99,77,22,KQs,KJs,AhQh,AhJh,AhTh,QhJh\nBTN（Hero）：筹码 160 范围 AA,AK,KQs,99,77,22\n先行动：BB'},
  {id:'stars-example',title:'PokerStars 文本牌谱示例',format:'pokerstars',text:"PokerStars Hand #20260928001: Hold'em No Limit ($0.10/$0.25 USD) - 2026/09/28 12:00:00 ET\nTable 'Training example' 6-max Seat #3 is the button\nSeat 1: SBPlayer ($25 in chips)\nSeat 2: BBPlayer ($25 in chips)\nSeat 3: Hero ($25 in chips)\nSBPlayer: posts small blind $0.10\nBBPlayer: posts big blind $0.25\n*** HOLE CARDS ***\nDealt to Hero [Ac Kd]\nHero: raises $0.50 to $0.75\nSBPlayer: calls $0.65\nBBPlayer: calls $0.50\n*** FLOP *** [Ks 7h 2h]\nSBPlayer: checks\nBBPlayer: checks\nHero: bets $1.50\nSBPlayer: calls $1.50\nBBPlayer: folds\n*** TURN *** [Ks 7h 2h] [9c]\nSBPlayer: checks\nHero: checks\n*** RIVER *** [Ks 7h 2h 9c] [3s]\nSBPlayer: bets $3\nHero: calls $3\n*** SHOW DOWN ***\nSBPlayer: shows [Ah Qh]\nHero: shows [Ac Kd]\nHero collected $11.25 from pot\n*** SUMMARY ***\nTotal pot $11.25 | Rake $0"}
];
