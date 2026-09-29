import crypto from 'node:crypto';
import {parseScenario,validateScenario} from './scenario.mjs';
import {cards,cardText} from './poker.mjs';

/** Pure, local cash-game archive import. No range inference, remote calls or
 * learning conclusions. Raw records, including rejected records, stay intact.
 * `index` is the zero-based position of the hand header in the source file.
 * Summary players never contain opponent hole cards from later showdown lines.
 */
export const HAND_HISTORY_BATCH_VERSION=1;
const round=n=>Math.round(n*1e8)/1e8;
const amount=s=>Number(String(s).replace(/,/g,''));
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const canonical=s=>s.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim();
const problem=(code,message,severity='error')=>({code,message,severity});
const voluntary=new Set(['fold','check','call','bet','raiseTo']);
const money='(?:[$€£¥￥]\\s*)?([\\d,]+(?:\\.\\d+)?)';

function headerDetails(header){
  const clean=header.replace(/^\uFEFF/,'').trim();
  const site=/^PokerStars(?: Zoom)? (?:Hand|Game)\s*#/i.test(clean)?'pokerstars':/^(?:Poker Hand|GGPoker Hand|GGNetwork Hand)\s*#/i.test(clean)?'gg':null;
  const handId=clean.match(/(?:Hand|Game)\s*#([A-Za-z0-9_-]+)/i)?.[1]??null;
  const blinds=clean.match(/\(\s*([$€£¥￥])?\s*([\d,.]+)\s*\/\s*([$€£¥￥])?\s*([\d,.]+)([^)]*)\)/);
  const symbol=blinds?.[1]??blinds?.[3]??null;
  const currency=blinds?.[5]?.match(/\b(USD|EUR|GBP|CNY|CAD|AUD|JPY|RUB|BRL|INR|KRW|HKD|TWD)\b/i)?.[1]?.toUpperCase()??null;
  const stakes=blinds?{smallBlind:amount(blinds[2]),bigBlind:amount(blinds[4]),currency,symbol,label:`${symbol??''}${blinds[2]}/${symbol??''}${blinds[4]}${currency?' '+currency:''}`,unit:'source-amount',normalizedUnit:'BB'}:null;
  return {site,handId,header:clean,stakes};
}

function unsupported(raw,info){
  if(!info.site)return problem('unsupported_site','未支持这个牌谱来源；目前支持 PokerStars 与 GG 的标准现金局文本。');
  if(/^PokerStars Game\s*#/i.test(info.header))return problem('unsupported_legacy_header','旧式 PokerStars Game 格式尚未验证，请使用标准 Hand 文本导出。');
  if(/\b(?:Tournament|Tourney|Sit\s*&?\s*Go|Spin\s*&?\s*Go)\b/i.test(info.header))return problem('unsupported_tournament','此批量导入器目前处理现金局，不把锦标赛筹码或盲注级别当作现金局。');
  if(/\b(?:Omaha|PLO|Stud|Razz|Short\s*Deck|Badugi|Draw|Mixed)\b|\b6\+/i.test(info.header))return problem('unsupported_variant','目前仅支持标准 52 张牌、两张底牌的无限注德州扑克。');
  if(!/(?:Hold['’]?em\s+No\s+Limit|No\s+Limit\s+Hold['’]?em)/i.test(info.header))return problem('unsupported_betting_structure','牌谱标题没有明确标识无限注德州扑克；不猜测游戏种类或下注结构。');
  if(/\b(?:Play\s*Money|Free\s*Play)\b/i.test(info.header))return problem('unsupported_play_money','当前现金局导入器不把游戏币牌局当作真实货币现金局。');
  if(/^(?:.*\bRun It Twice\b|\*\*\* (?:FIRST|SECOND|THIRD) (?:FLOP|TURN|RIVER)|.*\bBOMB POT\b)/im.test(raw))return problem('unsupported_runout','暂不支持多次发牌或炸弹底池；不能把其中一副牌面冒充完整牌局。');
  return null;
}

function rosterFromRaw(raw,bigBlind,button){
  const roster=[];
  for(const line of raw.replace(/\r/g,'').split('\n')){
    if(/^\*\*\* SUMMARY/i.test(line.trim()))break;
    const m=line.match(new RegExp(`^Seat\\s+(\\d+):\\s+(.+?)\\s+\\(\\s*${money}(?:\\s+in chips)?\\s*\\)`,'i'));
    if(m)roster.push({id:`seat${m[1]}`,seat:Number(m[1]),name:m[2],stack:bigBlind>0?round(amount(m[3])/bigBlind):null,position:'',range:''});
  }
  const clockwise=[...roster].sort((a,b)=>a.seat-b.seat),bi=clockwise.findIndex(p=>p.seat===button);
  if(bi>=0){
    const ordered=[...clockwise.slice(bi),...clockwise.slice(0,bi)],n=ordered.length;
    const middle={3:[],4:['CO'],5:['UTG','CO'],6:['UTG','HJ','CO'],7:['UTG','LJ','HJ','CO'],8:['UTG','UTG+1','LJ','HJ','CO'],9:['UTG','UTG+1','UTG+2','LJ','HJ','CO']}[n]??[];
    ordered.forEach((p,i)=>p.position=n===2?(i===0?'BTN':'BB'):['BTN','SB','BB',...middle][i]??'');
  }
  return roster;
}

function initialHero(raw){
  const found=[];
  for(const m of raw.matchAll(/^\s*Dealt to (.+?)\s+\[([^\]]*)\]/gmi)){
    if(!m[2].trim())continue;
    try{const hand=cards(m[2],[2]).map(cardText).join(' ');found.push({name:m[1],hand});}catch{}
  }
  return {hero:found.length===1?found[0]:null,ambiguous:found.length>1};
}

function preflopSnapshot(parse,roster,hero){
  if(!roster.length||roster.some(p=>!Number.isFinite(p.stack)))return null;
  const players=roster.map(p=>({...p}));let pot=0,toActPlayerId=null;
  for(const action of parse.ledger??[]){
    if(action.street!=='preflop'||action.type==='street')break;
    if(voluntary.has(action.type)){toActPlayerId=action.player;break;}
    if(action.type==='post'||action.type==='ante'){
      pot=action.potAfter;const p=players.find(p=>p.id===action.player);if(p)p.stack=action.stackAfter;
    }
  }
  const heroPlayer=players.find(p=>p.name===hero?.name);
  return {street:'preflop',board:'',pot,players,heroInHand:!!heroPlayer,heroToAct:toActPlayerId&&heroPlayer?toActPlayerId===heroPlayer.id:null,toActPlayerId,point:'after-forced-posts-before-first-voluntary-action',canOpenStudy:false};
}

function extraChecks(raw,parse,roster,heroInfo,stakes){
  const issues=[];
  if(!/^\s*\*\*\* SUMMARY \*\*\*/im.test(raw))issues.push(problem('incomplete_history','牌谱缺少完整 SUMMARY 标记，可能是截断记录；请先核对行动是否完整。'));
  if(heroInfo.ambiguous)issues.push(problem('multiple_dealt_hands','识别到多名玩家的 Dealt to 底牌；不能自动决定哪一位是 Hero。'));
  if(parse.issues.some(i=>i.code==='unparsed_action'))issues.push(problem('unverified_action','至少一行玩家行动尚未识别，不能把这手牌标记为已完整重建。'));
  if(new Set(roster.map(p=>p.id)).size!==roster.length)issues.push(problem('duplicate_seat','起始座位编号重复，不能可靠重建行动与筹码。'));
  if(new Set(roster.map(p=>p.name)).size!==roster.length)issues.push(problem('duplicate_name','玩家名称重复，无法唯一对应行动。'));
  if(stakes&&(!(stakes.smallBlind>0)||!(stakes.bigBlind>=stakes.smallBlind)))issues.push(problem('invalid_stakes','标题中的大小盲金额不合法。'));
  const monetaryLines=raw.split(/\r?\n/).filter(l=>/^(?:PokerStars|Poker Hand|GGPoker|GGNetwork|Seat\s+\d+:|Total pot|Uncalled bet)/i.test(l.trim())||/:\s*(?:posts|bets|raises|calls)\b/i.test(l));
  for(const line of monetaryLines){
    if([...line.matchAll(/\b\d[\d,.]*,[\d,.]*\d\b/g)].some(m=>!/^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(m[0]))){issues.push(problem('unsupported_numeric_format','金额含无法明确识别的逗号格式；目前仅支持小数点与三位分组的千位逗号。'));break;}
  }
  const symbols=new Set(monetaryLines.flatMap(l=>[...l.matchAll(/([$€£¥￥])\s*[\d,.]+/g)].map(m=>m[1]==='￥'?'¥':m[1])));
  if(symbols.size>1)issues.push(problem('mixed_currency','同一手的货币符号不一致；不会在未确认汇率与单位时合并金额。'));
  if(/^(?:Seat\s+\d+:.*is sitting out|.+?:\s+(?:sits out|is sitting out))\b/im.test(raw))issues.push(problem('sitting_out_review','记录含离桌玩家；当前位置推导仍按座位列表，请先核对实际参局人数和庄盲位置。'));
  for(const snapshot of parse.snapshots??[]){
    const s=snapshot.scenario;
    // An all-in runout is valid history even though it has no next actor. Use
    // an existing index only for card/money validation; do not edit the snapshot.
    const checked=validateScenario({...s,toAct:s.toAct<0&&s.players.every(p=>p.stack===0)?0:s.toAct},{requireRanges:false});
    // A limitation of a later study root is not a corrupt earlier ledger.
    // Keep the per-street flag and block that street instead of all prior play.
    for(const issue of checked.issues.filter(i=>i.severity==='error'))issues.push({...issue,...(['unsupported_dead_cards','preexisting_sidepot'].includes(issue.code)?{severity:'warning'}:{}),street:snapshot.street});
  }
  return issues;
}

function makeSummary(info,raw,parse,roster,heroInfo,status){
  const hero=heroInfo.hero,heroPlayer=roster.find(p=>p.name===hero?.name),pre=preflopSnapshot(parse,roster,hero);
  const streets=(parse.snapshots??[]).map(({street,scenario:s})=>{
    const heroHere=s.players.find(p=>p.name===hero?.name),actor=s.toAct>=0?s.players[s.toAct]:null;
    const scenario=hero&&!heroHere?{...s,notes:'Hero 已在之前弃牌，研究场景已清空 Hero 手牌和座位。当前模型未计入已弃牌者底牌造成的牌张移除，也未推断其余弃牌者的范围。'}:s;
    return {street,board:s.board,pot:s.pot,players:s.players.map(p=>({...p,range:''})),heroInHand:!!heroHere,heroToAct:actor&&heroHere?actor.id===heroHere.id:null,toActPlayerId:actor?.id??null,point:'street-start-before-actions',canOpenStudy:status==='parsed'&&!s.hasUnsupportedDeadCards&&!s.preexistingSidePot&&s.players.filter(p=>p.stack>0).length>=2,scenario};
  });
  if(pre)streets.unshift(pre);
  const table=raw.match(/^Table\s+(.+?)\s+(\d+)-max\b/im),maxPlayers=table?Number(table[2]):null;
  return {title:`${info.site==='pokerstars'?'PokerStars':'GG'} ${info.handId?'#'+info.handId:'未编号牌局'}${info.stakes?' · '+info.stakes.label:''}`,stakes:info.stakes,heroPosition:heroPlayer?.position||null,heroHand:hero?.hand??null,heroName:hero?.name??null,maxPlayers,seatedPlayers:roster.length,streets,lastStreet:streets.at(-1)?.street??null,tableName:table?.[1]??null,playedAtText:info.header.match(/\s-\s(.+)$/)?.[1]??null,unit:'BB',rangesSpecified:false,hasSummary:/^\s*\*\*\* SUMMARY \*\*\*/im.test(raw),postflopRaises:(parse.ledger??[]).filter(a=>a.type==='raiseTo'&&a.street!=='preflop').length,finalGrossPot:parse.ledger?.at(-1)?.potAfter??null};
}

/** Throws only for invalid API options, non-text input, or whole-file byte
 * limit. Unsupported/invalid individual hands never discard their neighbors. */
export function parseHandHistoryBatch(text,{maxHands=1000,maxBytes=16*1024*1024,fileName=null}={}){
  if(typeof text!=='string')throw TypeError('请提供已经按 UTF-8 解码的牌谱文本。');
  if(!Number.isInteger(maxHands)||maxHands<1||maxHands>10000)throw RangeError('maxHands 必须为 1–10000 的整数。');
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)throw RangeError('maxBytes 必须为 1 字节至 64 MB 的整数。');
  const bytes=Buffer.byteLength(text,'utf8');if(bytes>maxBytes){const e=Error(`文件为 ${bytes} 字节，超过 ${maxBytes} 字节上限；请分成较小文件导入。`);e.code='batch_too_large';throw e;}
  const headerPattern=/^[\uFEFF\t ]*((?:[A-Za-z][A-Za-z0-9 ._-]{0,70}\s+)?(?:Hand|Game))\s*#([A-Za-z0-9_-]+)?[^\r\n]*/gmi;
  const headers=[...text.matchAll(headerPattern)],hands=[],rejected=[],duplicates=[],unassigned=[],warnings=[],seen=new Map();
  const result={version:HAND_HISTORY_BATCH_VERSION,ok:false,fileName:fileName==null?null:String(fileName).split(/[\\/]/).at(-1).slice(0,256),bytes,hands,rejected,duplicates,unassigned,warnings,stats:null,assumptions:['全部解析在本地完成，未调用外部服务或语言模型。','金额只按每手标题明确记录的大盲换算为 BB。','玩家范围保持空白；摘要不使用对手事后亮出的底牌。','每个翻后快照位于该街首个行动之前；翻前快照位于强制盲注和前注之后。']};
  if(!headers.length){rejected.push({index:0,site:null,handId:null,sourceKey:'sha256:'+digest(canonical(text)),raw:text,code:'unrecognized_file',reason:'没有找到支持分割的逐手 Hand # 标题；请导出原始文本牌谱。'});result.stats={detected:0,imported:0,parsed:0,needsReview:0,preflopOnly:0,rejected:1,duplicates:0};return result;}
  const prefix=text.slice(0,headers[0].index);if(prefix.replace(/\uFEFF/g,'').trim()){unassigned.push({raw:prefix,reason:'首个牌局标题前的原文未被当作任何一手行动。'});warnings.push(problem('unassigned_preamble','文件开头有未分配给牌局的文字，已保留供核对。','warning'));}
  for(let index=0;index<headers.length;index++){
    const raw=text.slice(headers[index].index,headers[index+1]?.index??text.length),info=headerDetails(headers[index][0]),hash=digest(canonical(raw)),sourceKey=info.site&&info.handId?`${info.site}:${info.handId}`:'sha256:'+hash;
    const reject=(code,reason)=>rejected.push({index,site:info.site,handId:info.handId,sourceKey,raw,code,reason});
    if(index>=maxHands){reject('hand_limit',`本次最多处理 ${maxHands} 手；这一手原文仍已保留，未进行解析。`);continue;}
    const unsupportedReason=unsupported(raw,info);if(unsupportedReason){reject(unsupportedReason.code,unsupportedReason.message);continue;}
    if(seen.has(sourceKey)){
      const previous=seen.get(sourceKey);
      if(previous.hash===hash){duplicates.push({index,site:info.site,handId:info.handId,sourceKey,duplicateOfIndex:previous.index,reason:'相同来源编号和相同原文（忽略文件换行与首尾空白）已保留。'});continue;}
      const issue=problem('conflicting_hand_id','同一来源和手牌编号出现不同原文，已保留第一份并单独保留冲突记录；请核对再研究。');previous.hand.status='needs-review';previous.hand.eligibleForStudy=false;previous.hand.parse.issues.push(issue);previous.hand.parse.ok=false;previous.hand.summary.streets.forEach(s=>s.canOpenStudy=false);reject(issue.code,issue.message);continue;
    }
    try{
      const parse=parseScenario(raw,{format:info.site}),heroInfo=initialHero(raw),roster=rosterFromRaw(raw,parse.metadata?.bigBlind,parse.metadata?.button);
      if(parse.issues?.some(i=>i.code==='input_too_long')){reject('hand_too_large','单手原文超过当前逐手解析器的大小限制。');continue;}
      const extras=extraChecks(raw,parse,roster,heroInfo,info.stakes);parse.issues.push(...extras);
      const errors=parse.issues.filter(i=>i.severity==='error'&&i.code!=='missing_postflop');
      const noPostflop=!(parse.snapshots?.length),status=errors.length?'needs-review':noPostflop?'preflop-only':'parsed';
      parse.ok=!parse.issues.some(i=>i.severity==='error');
      const summary=makeSummary(info,raw,parse,roster,heroInfo,status),hand={index,sourceKey,site:info.site,handId:info.handId,raw,status,eligibleForStudy:status==='parsed'&&summary.streets.some(s=>s.canOpenStudy),parse,summary};
      hands.push(hand);seen.set(sourceKey,{index,hash,hand});
    }catch(e){reject('parse_exception',`这一手未能安全解析：${e.message}`);}
  }
  result.ok=hands.length>0;result.stats={detected:headers.length,imported:hands.length,parsed:hands.filter(h=>h.status==='parsed').length,needsReview:hands.filter(h=>h.status==='needs-review').length,preflopOnly:hands.filter(h=>h.status==='preflop-only').length,rejected:rejected.length,duplicates:duplicates.length};
  if(rejected.length)warnings.push(problem('partial_import','部分记录没有进入可研究牌局，拒绝原因和原文已逐手保留。','warning'));
  return result;
}
