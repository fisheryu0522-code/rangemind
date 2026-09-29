import {cards,cardText} from './poker.mjs';
import {replayActions,parseScenario,normalizeScenario} from './scenario.mjs';

const EPS=1e-7,round=n=>Math.round(n*1e8)/1e8,clone=structuredClone;
const POSITIONS={2:['BB','BTN'],3:['SB','BB','BTN'],4:['SB','BB','CO','BTN'],5:['SB','BB','UTG','CO','BTN'],6:['SB','BB','UTG','HJ','CO','BTN'],7:['SB','BB','UTG','LJ','HJ','CO','BTN'],8:['SB','BB','UTG','UTG+1','LJ','HJ','CO','BTN'],9:['SB','BB','UTG','UTG+1','UTG+2','LJ','HJ','CO','BTN']};
const streetNames={preflop:'翻前',flop:'翻牌',turn:'转牌',river:'河牌'},nextStreet=street=>({preflop:'flop',flop:'turn',turn:'river'})[street]??null;
const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
const money=(n,label,{zero=false}={})=>{if(typeof n!=='number'||!Number.isFinite(n)||n<(zero?0:EPS)||n>1e8)fail('invalid_amount',label+'必须是明确有效的金额。');return round(n);};
const text=(value,max=160)=>String(value??'').trim().slice(0,max);
const cents=(n,unit)=>{if(unit==='currency'&&Math.abs(n*100-Math.round(n*100))>1e-6)fail('invalid_currency_precision','实际金额请精确到分（最多两位小数）；BB 模式可记录更细的比例。');return n;};
export function liveRecorderPositions(count){if(!Number.isInteger(count)||!POSITIONS[count])fail('unsupported_player_count','现场记录支持 2–9 人标准无限注德州扑克。');return [...POSITIONS[count]];}

function cleanDraft(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))fail('invalid_record','现场记录格式无效。');
 if(input.kind!=null&&input.kind!=='live-hand-record'||input.version!=null&&input.version!==1)fail('unsupported_record','不支持此现场记录版本。');
 for(const key of ['ante','straddle','rake','rakeCap'])if(input[key]!=null&&input[key]!==0)fail('unsupported_structure','记录器目前支持普通盲注、无 ante / straddle 的现金牌局；抽水留到研究模型明确设置。');
 if(input.board||input.pot||input.street&&input.street!=='preflop')fail('partial_hand_not_supported','完整行动记录从发牌前开始；缺少前序时，请在研究台另建明确的街起点假设。');
 if(input.variant&&!['NLHE','nlhe'].includes(input.variant))fail('unsupported_variant','记录器目前只支持无限注德州扑克。');
 const unit=input.unit??'currency';if(!['currency','BB'].includes(unit))fail('invalid_unit','金额单位必须明确选择实际金额或 BB。');
 const bigBlind=money(input.bigBlind??(unit==='BB'?1:3),'大盲'),smallBlind=money(input.smallBlind??(unit==='BB'?.5:1),'小盲');
 cents(bigBlind,unit);cents(smallBlind,unit);
 if(unit==='BB'&&bigBlind!==1)fail('invalid_bb_unit','BB 模式中一个大盲固定为 1；记录 1/3 现金请选实际金额。');
 if(smallBlind>bigBlind)fail('invalid_blinds','小盲不能大于大盲。');
 const count=input.players?.length??input.playerCount??input.count??6,positions=liveRecorderPositions(count),defaultStack=money(input.stack??input.defaultStack??bigBlind*100,'默认筹码');
 if(input.players!=null&&!Array.isArray(input.players))fail('invalid_players','玩家列表格式无效。');
 const source=input.players??positions.map(position=>({id:position,position,stack:defaultStack}));
 if(source.length!==count||new Set(source.map(p=>p?.position)).size!==count)fail('invalid_positions','请为每个座位提供唯一的标准位置。');
 const players=positions.map(position=>{const p=source.find(p=>p?.position===position);if(!p||p.id!=null&&p.id!==position)fail('invalid_positions','位置和稳定玩家编号必须与本桌标准位置一致。');const stack=cents(money(p.stack,'起始筹码'),unit);if(stack<bigBlind-EPS)fail('short_blind_unsupported','发牌前每位玩家的筹码须至少一个大盲；不足盲注的起点暂不支持。中途短全下正常支持。');return {id:position,position,name:text(p.name||position,80),stack};});
 const suppliedHero=input.hero??{playerId:positions.includes('SB')?'SB':'BTN',hand:''};if(typeof suppliedHero!=='object'||Array.isArray(suppliedHero))fail('invalid_hero','Hero 位置与手牌格式无效。');
 const hero={playerId:suppliedHero.playerId??null,hand:cards(suppliedHero.hand||'',suppliedHero.hand?[2]:[0]).map(cardText).join(' ')};
 if(hero.playerId!=null&&!positions.includes(hero.playerId)||hero.hand&&!hero.playerId)fail('invalid_hero','请先选择本桌 Hero 位置，再填写手牌。');
 if(input.actions!=null&&!Array.isArray(input.actions)||input.actions?.length>300)fail('invalid_actions','一手记录最多支持 300 个动作。');
 return {version:1,kind:'live-hand-record',title:text(input.title||'现场牌局记录'),question:text(input.question,2000),unit,smallBlind,bigBlind,players,hero,actions:clone(input.actions??[])};
}

/** All legality and money replay use the shared ledger. UI suggestions are
 * tested against that ledger, rather than a second set of betting rules. */
function reconstruct(input){
 const draft=cleanDraft(input),factor=draft.unit==='currency'?draft.bigBlind:1,toBB=n=>round(n/factor),display=n=>draft.unit==='currency'?Math.round(n*factor*100)/100:round(n);
 const initial={pot:0,street:'preflop',board:'',players:draft.players.map(p=>({...p,stack:toBB(p.stack)}))};
 const small=draft.players.length===2?'BTN':'SB',events=[{type:'post',player:small,amount:toBB(draft.smallBlind),system:true},{type:'post',player:'BB',amount:1,system:true}],actions=[],history=[];
 const replay=more=>replayActions(initial,more??events,{strict:true,minBet:1,enforceOrder:true});
 let current=replay();
 const actor=()=>{
  const alive=current.state.players.filter(p=>!p.folded),able=alive.filter(p=>!p.allIn);
  if(alive.length<=1||able.length===0||able.length===1&&able[0].streetBet>=current.state.currentBet-EPS)return null;
  for(const p of able)try{replay([...events,{type:'fold',player:p.id}]);return p.id;}catch{}
  return null;
 };
 const control=()=>{
  const currentActorId=actor(),p=current.state.players.find(p=>p.id===currentActorId),owed=p?Math.max(0,current.state.currentBet-p.streetBet):0,minTarget=current.state.currentBet+current.state.lastFullRaise,maxTarget=p?p.streetBet+p.stack:null;
  const canRespond=p&&current.state.players.some(q=>q.id!==p.id&&!q.folded&&!q.allIn);
  let canRaise=false;
  if(p&&canRespond&&maxTarget>current.state.currentBet+EPS)try{replay([...events,{type:current.state.currentBet>EPS?'raiseTo':'bet',player:p.id,amount:Math.min(minTarget,maxTarget)}]);canRaise=true;}catch{}
  const roundComplete=!currentActorId,handComplete=current.state.players.filter(p=>!p.folded).length===1||current.state.street==='river'&&roundComplete;
  return {currentActorId,toCall:p?Math.min(owed,p.stack):null,fullToCall:p?owed:null,minRaiseTo:p&&canRaise?minTarget:null,maxRaiseTo:p?maxTarget:null,canCheck:!!p&&owed<=EPS,canRaise,canAllIn:!!p&&(p.stack<=owed+EPS||canRaise),roundComplete,handComplete,nextStreet:roundComplete&&!handComplete?nextStreet(current.state.street):null};
 };
 const autoReturn=()=>{
  if(actor())return;
  const sorted=[...current.state.players].sort((a,b)=>b.streetBet-a.streetBet),excess=sorted[0].streetBet-(sorted[1]?.streetBet??0);
  if(excess>EPS){events.push({type:'return',player:sorted[0].id,amount:round(excess),system:true});current=replay();}
 };
 for(const [actionIndex,raw] of draft.actions.entries()){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('invalid_action','行动记录格式无效。');
  const c=control();let event,clean;
  if(raw.type==='street'){
   if(!c.nextStreet)fail('street_not_ready',c.handComplete?'这手牌已经结束。':'本街还有玩家未完成行动，不能提前发牌。');
   if(raw.street!=null&&raw.street!==c.nextStreet)fail('invalid_street_order','必须依次记录翻牌、转牌、河牌，不可重复或跳过。');
   const provided=cards(raw.cards??raw.board??''),before=cards(current.state.board),next=c.nextStreet==='flop'?provided:provided.length===1?[...before,...provided]:provided,expected={flop:3,turn:4,river:5}[c.nextStreet];
   if(next.length!==expected||before.some((v,i)=>next[i]!==v))fail('invalid_board','公共牌数量或前序牌面不一致。');
   const known=[...next,...cards(draft.hero.hand)];if(new Set(known).size!==known.length)fail('card_collision','公共牌与已知 Hero 手牌冲突；已弃牌的已知牌也不能再次发出。');
   clean={type:'street',street:c.nextStreet,cards:next.map(cardText).join(' ')};event={type:'street',street:c.nextStreet,board:clean.cards};
  }else{
   if(!['fold','check','call','bet','raiseTo','allIn'].includes(raw.type))fail('unsupported_action','只支持弃牌、过牌、跟注、下注、加注到、全下及发牌；不手动结算或改写底池。');
   if(!c.currentActorId)fail('round_complete','本轮已结束，请发下一街或选择历史决定研究。');
   const playerId=raw.playerId??raw.player??c.currentActorId;if(playerId!==c.currentActorId)fail('wrong_action_order',`当前轮到 ${c.currentActorId}，不能记录其他人的动作。`);
   const p=current.state.players.find(p=>p.id===playerId);clean={type:raw.type,playerId};event={type:raw.type,player:playerId};
   if(raw.type==='call'){
    if(!(c.toCall>EPS))fail('illegal_call','当前无需跟注，请选择过牌或下注。');
    if(raw.amount!=null&&Math.abs(toBB(money(raw.amount,'跟注金额'))-c.toCall)>EPS)fail('call_amount_mismatch','跟注金额由已记录投入自动计算，不能手动改成另一个数。');
    event.amount=c.toCall;
   }else if(raw.type==='allIn'){
    if(!c.canAllIn)fail('illegal_all_in','当前没有合法全下动作；对手全下后只可跟注或弃牌，短加注也不自动重开加注权。');
    if(c.fullToCall>=p.stack-EPS){event.type='call';event.amount=p.stack;}else{event.type=current.state.currentBet>EPS?'raiseTo':'bet';event.amount=round(p.streetBet+p.stack);}
   }else if(raw.type==='bet'||raw.type==='raiseTo'){
    if(!c.canRaise)fail('betting_not_reopened','当前没有加注权，或已没有能回应额外下注的玩家。');
    const amount=cents(money(raw.amount,raw.type==='bet'?'下注额':'加注到金额'),draft.unit);clean.amount=amount;event.amount=toBB(amount);
   }else if(raw.amount!=null)fail('unexpected_amount','过牌和弃牌不需要金额。');
  }
  events.push(event);current=replay();actions.push(clean);
  const row=current.ledger.at(-1),verb=({fold:'弃牌',check:'过牌',call:'跟入',bet:'下注',raiseTo:'加注到'})[event.type];
  history.push({actionIndex,ledgerIndex:row.index,type:clean.type,playerId:event.player??null,position:event.player??null,label:event.type==='street'?streetNames[event.street]+' '+event.board:`${event.player} ${verb}${event.amount==null?'':' '+display(event.amount)}${clean.type==='allIn'?'（全下）':''}`,street:row.street,amount:event.amount==null?null:display(event.amount),paid:display(row.paid),potBefore:display(row.potBefore),potAfter:display(row.potAfter),stackAfter:row.stackAfter==null?null:display(row.stackAfter)});
  autoReturn();
 }
 const c=control(),view={street:current.state.street,board:current.state.board,pot:display(current.state.pot),players:current.state.players.map(p=>({...p,stack:display(p.stack),streetBet:display(p.streetBet),contributed:display(p.contributed)})),...c,toCall:c.toCall==null?null:display(c.toCall),fullToCall:c.fullToCall==null?null:display(c.fullToCall),minRaiseTo:c.minRaiseTo==null?null:display(c.minRaiseTo),maxRaiseTo:c.maxRaiseTo==null?null:display(c.maxRaiseTo),history,issues:[],conservation:{initialTotal:display(current.conservation.initialTotal),finalTotal:display(current.conservation.finalTotal),difference:display(current.conservation.difference)}};
 return {draft:{...draft,actions},view,events,ledger:current.ledger,display};
}

function canonicalText(draft,events,display){
 const unit=draft.unit==='BB'?'BB':'美元',lines=['PokerLab现场行动记录 v1',`${draft.players.length}人桌现金局`,`SB/BB 为 ${draft.smallBlind}/${draft.bigBlind} ${unit}`,...draft.players.map(p=>`${p.position} ${p.stack} ${unit}`)];
 if(draft.hero.playerId)lines.push(`我在 ${draft.hero.playerId}`);if(draft.hero.hand)lines.push(`持 ${draft.hero.hand}`);
 for(const a of events){
  if(a.type==='post')continue;
  if(a.type==='street'){lines.push(`${streetNames[a.street]} ${a.board}`);continue;}
  if(a.type==='return'){lines.push(`${a.player} 退回未跟注额 ${display(a.amount)} ${unit}`);continue;}
  const verb=({fold:'弃牌',check:'过牌',call:'跟注',bet:'下注',raiseTo:'加注到'})[a.type];lines.push(`${a.player} ${verb}${a.type==='call'||a.amount==null?'':` ${display(a.amount)} ${unit}`}`);
 }
 return lines.join('。\n')+'。';
}

export function createLiveRecorder(config={}){return reconstruct({...config,actions:[]}).draft;}
export function applyLiveRecorderAction(draft,action){const checked=reconstruct(draft).draft;return reconstruct({...checked,actions:[...checked.actions,clone(action)]}).draft;}
export function undoLiveRecorderAction(draft){const checked=reconstruct(draft).draft;if(!checked.actions.length)fail('nothing_to_undo','尚无可撤销的用户行动。');return reconstruct({...checked,actions:checked.actions.slice(0,-1)}).draft;}
export function replayLiveRecorder(input,{street}={}){
 const r=reconstruct(input),raw=canonicalText(r.draft,r.events,r.display),parse=parseScenario(raw,{...(street?{street}:{})}),names=new Map(r.draft.players.map(p=>[p.id,p.name]));
 const decorate=s=>s?{...s,title:r.draft.title,players:s.players.map(p=>({...p,name:names.get(p.id)??p.name}))}:s;
 parse.scenario=decorate(parse.scenario);parse.snapshots=parse.snapshots.map(s=>({...s,scenario:decorate(s.scenario)}));
 r.view.issues=parse.issues.filter(i=>i.code!=='missing_postflop'&&i.code!=='ranges_required');
 const inputContext={raw,sourceUnit:r.draft.unit,sourceBigBlind:r.draft.bigBlind,ledger:clone(parse.ledger),snapshots:clone(parse.snapshots),issues:clone(parse.issues),metadata:{...clone(parse.metadata),recordingKind:'manual-action-ledger'},assumptions:[...parse.assumptions,'这是用户手工记录，不证明原文准确复现了现实牌局；范围仍需独立填写。']};
 return {draft:r.draft,view:r.view,ledger:parse.ledger,snapshots:parse.snapshots,parse,inputContext};
}

/** Return a NEW-STREET study root plus an exact ledger boundary. Amounts in
 * scenario are BB; the selected decision itself can be later in that street. */
export function buildLiveRecorderStudy(draft,{actionIndex,street}={}){
 const all=replayLiveRecorder(draft);let target,selectedStreet=street;
 if(actionIndex!=null){if(!Number.isInteger(actionIndex)||actionIndex<0||actionIndex>=all.view.history.length)fail('invalid_study_action','所选历史行动不存在。');const h=all.view.history[actionIndex];if(h.type==='street')fail('not_a_decision','发牌不是玩家决策，请选择该街或一个玩家动作。');if(street!=null&&street!==h.street)fail('study_street_mismatch','所选动作不属于指定街。');selectedStreet=h.street;target={ledgerIndex:h.ledgerIndex,actionIndex,mode:'before-action',actorId:h.playerId};}
 else if(street!=null){const snapshot=all.snapshots.find(s=>s.street===street);if(!snapshot)fail('study_street_missing','这份记录尚没有该街起点。');target={ledgerIndex:snapshot.actionIndex+1,mode:'street-start'};}
 else{if(!all.view.currentActorId)fail('no_pending_decision','目前没有待行动决定，请明确选择历史动作或街起点。');selectedStreet=all.view.street;target={ledgerIndex:(all.ledger.at(-1)?.index??-1)+1,mode:'current-decision',actorId:all.view.currentActorId};}
 if(selectedStreet==='preflop')fail('preflop_study_unsupported','当前研究台从翻后街起点求解；请继续记录到翻牌，或保留草稿。');
 const chosen=replayLiveRecorder(draft,{street:selectedStreet});if(!chosen.parse.scenario)fail('study_street_missing','未能重建该街起点。');
 const errors=chosen.parse.issues.filter(i=>i.severity==='error');if(errors.length)fail('unresolved_record',errors[0].message);
 const scenario=normalizeScenario(chosen.parse.scenario,{requireRanges:false});
 // Display the actual selected boundary separately from the new-street solver
 // root. Replaying its prefix also includes any derived uncalled-bet return.
 const prefixLength=target.mode==='before-action'?target.actionIndex:target.mode==='street-start'?all.draft.actions.findIndex(a=>a.type==='street'&&a.street===selectedStreet)+1:all.draft.actions.length;
 const atDecision=reconstruct({...all.draft,actions:all.draft.actions.slice(0,prefixLength)}).view,factor=all.draft.unit==='currency'?all.draft.bigBlind:1;
 const decisionContext={street:atDecision.street,board:atDecision.board,actorId:atDecision.currentActorId,pot:round(atDecision.pot/factor),toCall:atDecision.toCall==null?null:round(atDecision.toCall/factor),mode:target.mode,unit:'BB'};
 return {scenario,inputContext:{...chosen.inputContext,studyTarget:target},targetLedgerIndex:target.ledgerIndex,target,decisionContext,question:chosen.draft.question};
}
