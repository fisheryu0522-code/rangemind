export const RANKS='23456789TJQKA', SUITS='cdhs', GRID='AKQJT98765432';
export const cardText=c=>RANKS[c>>2]+SUITS[c%4];
export function cards(text,allowed){
  const clean=String(text??'').replace(/10/g,'T').replace(/♣/g,'c').replace(/♦/g,'d').replace(/♥/g,'h').replace(/♠/g,'s').replace(/[\s,;\[\]]/g,'');
  if(clean.length%2) throw Error('牌面格式应为 Qs Jh 2h；T 表示 10。');
  const out=[];
  for(let i=0;i<clean.length;i+=2){const r=RANKS.indexOf(clean[i].toUpperCase()),s=SUITS.indexOf(clean[i+1].toLowerCase());if(r<0||s<0)throw Error('无法识别牌：'+clean.slice(i,i+2));out.push(r*4+s);}
  if(new Set(out).size!==out.length)throw Error('同一张牌不能出现两次。');
  if(allowed&&!allowed.includes(out.length))throw Error('请选择 '+allowed.join(' / ')+' 张牌。');
  return out;
}
export function handClass(a,b){let x=a>>2,y=b>>2;if(x<y)[x,y]=[y,x];return RANKS[x]+RANKS[y]+(x===y?'':a%4===b%4?'s':'o');}
function expandClass(name){
  if(/^[2-9TJQKA][cdhs][2-9TJQKA][cdhs]$/i.test(name))return [cards(name,[2])];
  const m=name.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)$/i);if(!m)throw Error('无法识别范围：'+name);
  let a=RANKS.indexOf(m[1].toUpperCase()),b=RANKS.indexOf(m[2].toUpperCase());const suit=m[3].toLowerCase();
  if(a===b&&suit)throw Error('对子无需 s/o：'+name);
  const out=[];for(let i=0;i<4;i++)for(let j=0;j<4;j++){if(a===b&&i>=j)continue;if(a!==b&&suit==='s'&&i!==j)continue;if(a!==b&&suit==='o'&&i===j)continue;out.push([a*4+i,b*4+j]);}return out;
}
function expandToken(token){
  if(token.endsWith('+')){const m=token.slice(0,-1).match(/^([2-9TJQKA])([2-9TJQKA])([so]?)$/i);if(!m)throw Error('无效的 + 范围：'+token);let a=RANKS.indexOf(m[1].toUpperCase()),b=RANKS.indexOf(m[2].toUpperCase());if(a<b)[a,b]=[b,a];const names=[];if(a===b){for(let i=a;i<13;i++)names.push(RANKS[i]+RANKS[i]);}else for(let i=b;i<a;i++)names.push(RANKS[a]+RANKS[i]+m[3]);return names.flatMap(expandClass);}
  if(token.includes('-')){const [lo,hi,...rest]=token.split('-');const a=lo.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)$/i),b=hi?.match(/^([2-9TJQKA])([2-9TJQKA])([so]?)$/i);if(rest.length||!a||!b||a[3]!==b[3])throw Error('无效区间：'+token);const names=[];if(a[1]===a[2]&&b[1]===b[2]){for(let i=Math.min(RANKS.indexOf(a[1]),RANKS.indexOf(b[1]));i<=Math.max(RANKS.indexOf(a[1]),RANKS.indexOf(b[1]));i++)names.push(RANKS[i]+RANKS[i]);}else if(a[1]===b[1]){for(let i=Math.min(RANKS.indexOf(a[2]),RANKS.indexOf(b[2]));i<=Math.max(RANKS.indexOf(a[2]),RANKS.indexOf(b[2]));i++){if(RANKS[i]===a[1])throw Error('区间跨越对子：'+token);names.push(a[1]+RANKS[i]+a[3]);}}else throw Error('区间需固定高张，例如 A5s-A2s。');return names.flatMap(expandClass);}
  return expandClass(token);
}
export function range(text,dead=[]){
  const map=new Map();for(const raw of String(text??'').trim().split(/[,;\s]+/).filter(Boolean)){
    const [tok,w,...extra]=raw.split(':');let weight=w===undefined?1:Number(w.replace('%',''))/(w.endsWith('%')?100:1);
    if(extra.length||!Number.isFinite(weight)||weight<0||weight>1)throw Error('频率需为 0–1 或百分比：'+raw);
    for(const pair of expandToken(tok)){pair.sort((a,b)=>a-b);const label=pair.map(cardText).join('');map.set(label,{cards:pair,label,hand:handClass(...pair),weight});}
  }
  const all=[...map.values()].filter(c=>c.weight>0);if(!all.length)throw Error('范围不能为空。');
  const live=all.filter(c=>!c.cards.some(x=>dead.includes(x)));if(!live.length)throw Error('已知牌阻断了范围内的所有组合。');
  const groups={};for(const c of all){const g=groups[c.hand]??={hand:c.hand,before:0,after:0,weighted:0,combos:[]};g.before++;const blocked=c.cards.some(x=>dead.includes(x));if(!blocked){g.after++;g.weighted+=c.weight;}g.combos.push({...c,blocked});}
  return {all,live,groups,total:all.length,count:live.length,weighted:live.reduce((s,c)=>s+c.weight,0),removed:all.length-live.length};
}
function straight(mask){for(let r=12;r>=4;r--)if((mask&(31<<(r-4)))===(31<<(r-4)))return r+2;return (mask&0x100f)===0x100f?5:0;}
function encode(cat,rs){let n=cat;for(let i=0;i<5;i++)n=n*15+(rs[i]??0);return n;}
export function rankHand(cs){
  const rc=new Uint8Array(13),sc=new Uint8Array(4),sm=new Uint16Array(4);let mask=0;
  for(const c of cs){const r=c>>2,s=c%4;rc[r]++;sc[s]++;sm[s]|=1<<r;mask|=1<<r;}
  const fs=sc.findIndex(x=>x>=5);if(fs>=0){const st=straight(sm[fs]);if(st)return encode(8,[st]);}
  const quads=[],trip=[],pairs=[],single=[];for(let r=12;r>=0;r--){if(rc[r]===4)quads.push(r+2);if(rc[r]>=3)trip.push(r+2);if(rc[r]>=2)pairs.push(r+2);if(rc[r])single.push(r+2);}
  if(quads.length)return encode(7,[quads[0],single.find(x=>x!==quads[0])]);
  if(trip.length&&pairs.some(x=>x!==trip[0]))return encode(6,[trip[0],pairs.find(x=>x!==trip[0])]);
  if(fs>=0){const rr=[];for(let r=12;r>=0;r--)if(sm[fs]&(1<<r))rr.push(r+2);return encode(5,rr);}
  const st=straight(mask);if(st)return encode(4,[st]);
  if(trip.length)return encode(3,[trip[0],...single.filter(x=>x!==trip[0]).slice(0,2)]);
  if(pairs.length>=2)return encode(2,[pairs[0],pairs[1],single.find(x=>x!==pairs[0]&&x!==pairs[1])]);
  if(pairs.length)return encode(1,[pairs[0],...single.filter(x=>x!==pairs[0]).slice(0,3)]);
  return encode(0,single);
}
export const CATEGORIES=['高牌','一对','两对','三条','顺子','同花','葫芦','四条','同花顺'];
export const category=cs=>Math.floor(rankHand(cs)/15**5);
export function composition(r,board){const hist=Array(9).fill(0);for(const c of r.live){hist[category([...board,...c.cards])]+=c.weight;}return hist.map((weight,i)=>({name:CATEGORIES[i],weight,percent:weight/r.weighted})).filter(x=>x.weight>0);}
export function validState(s){
  const board=cards(s.board,[3,4,5]),hero=cards(s.hero??'',[0,2]);if(new Set([...board,...hero]).size!==board.length+hero.length)throw Error('手牌与公共牌重复。');
  const oop=range(s.oop,board),ip=range(s.ip,board);let compatible=false;outer:for(const a of oop.live)for(const b of ip.live)if(!a.cards.some(c=>b.cards.includes(c))){compatible=true;break outer;}if(!compatible)throw Error('双方范围没有可同时出现的组合。');
  const pot=Number(s.pot),stack=Number(s.stack),bet=Number(s.bet??0),rake=Number(s.rake??0),cap=Number(s.cap??0);
  if(!Number.isFinite(pot)||pot<=0||pot>100000||!Number.isFinite(stack)||stack<0||stack>100000||!Number.isFinite(bet)||bet<0||bet>stack||!Number.isFinite(rake)||rake<0||rake>20||!Number.isFinite(cap)||cap<0||cap>100000)throw Error('请检查底池、剩余有效筹码、下注和抽水。下注不得超过剩余有效筹码。');
  return {board,hero,oop,ip,pot,stack,bet,rake,cap};
}
export function cpuEquity(a,b,board,n=50000,seed=20260928){
  const initialSeed=seed;
  const rng=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)/4294967296;};
  let win=0,tie=0,total=0,mass=0;const exact=board.length===5;
  if(exact){const ar=a.map(c=>rankHand([...board,...c.cards])),br=b.map(c=>rankHand([...board,...c.cards]));for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++){if(a[i].cards.some(c=>b[j].cards.includes(c)))continue;const w=a[i].weight*b[j].weight;mass+=w;total++;win+=w*(ar[i]>br[j]);tie+=w*(ar[i]===br[j]);}}
  else{const cdf=r=>{let t=0;return r.map(c=>t+=c.weight);},ac=cdf(a),bc=cdf(b);const pick=(r,c)=>{const x=rng()*c.at(-1);let l=0,h=c.length-1;while(l<h){const m=(l+h)>>1;if(x<c[m])h=m;else l=m+1;}return r[l];};let attempts=0;while(total<n){if(++attempts>n*200)throw Error('范围重叠过高，请缩小范围后重试。');const x=pick(a,ac),y=pick(b,bc);if(x.cards.some(c=>y.cards.includes(c)))continue;const used=[...board,...x.cards,...y.cards],run=[...board];while(run.length<5){const c=Math.floor(rng()*52);if(!used.includes(c)){used.push(c);run.push(c);}}const ar=rankHand([...run,...x.cards]),br=rankHand([...run,...y.cards]);win+=ar>br;tie+=ar===br;total++;}mass=total;}
  if(!mass)throw Error('范围间没有兼容组合。');const equity=(win+tie/2)/mass,ci=exact?0:1.96*Math.sqrt(Math.max(0,(win+tie/4)/mass-equity*equity)/total);return {equity,tie:tie/mass,ci,samples:total,exact,engine:exact?'CPU 精确枚举':'CPU 蒙特卡洛',seed:initialSeed};
}
export function explain(s,v,e,he){
  const {pot,bet,rake,cap,board,hero}=v,finalPot=pot+2*bet,fee=Math.min(finalPot*rake/100,cap),threshold=bet?bet/(finalPot-fee):0,mdf=pot/(pot+bet),bluff=bet/(pot+2*bet);const lines=[];
  lines.push({title:'先明确范围假设',body:`双方范围是当前街起点的输入假设。OOP 有 ${v.oop.count} 个合法组合（加权 ${v.oop.weighted.toFixed(2)}），IP 有 ${v.ip.count} 个（加权 ${v.ip.weighted.toFixed(2)}）。这些数量只移除公共牌；双方互相阻断由权益引擎在配对时处理。`});
  lines.push({title:'范围权益回答了什么',body:`OOP 对 IP 的摊牌权益为 ${(e.equity*100).toFixed(2)}%${e.exact?'，当前河牌已精确枚举':`，95% 近似置信区间 ±${(e.ci*100).toFixed(2)} 个百分点`}。它衡量从当前牌面直接发完牌的结果；位置、后续下注和弃牌收益需要策略树才能计入。`});
  if(hero.length&&he)lines.push({title:'聚焦这手牌',body:`${hero.map(cardText).join(' ')} 对 ${s.heroSeat==='oop'?'IP':'OOP'} 输入范围的权益为 ${(he.equity*100).toFixed(2)}%。对手组合已额外移除你的两张手牌。输入范围若是对手整段范围，而不是本次下注范围，就不能据此直接决定跟注。`});
  if(bet>0)lines.push({title:'跟注需要怎样的证据',body:`底池 ${pot} BB 是对手下注前的金额，对手下注 ${bet} BB 后，你需再投入 ${bet} BB。若跟注后直接摊牌，按设定抽水 ${fee.toFixed(2)} BB，盈亏平衡权益为 ${(threshold*100).toFixed(2)}%。${board.length<5?'当前仍有后续街，这只是立即摊牌模型；权益实现、反向隐含赔率与后续投入仍需判断。':'河牌可将该门槛与对手本次下注范围对比；忽略加注选项时，跟注相对弃牌 EV = 权益 × 净最终底池 − 跟注额。'}`});
  if(bet>0)lines.push({title:'把诈唬比例变成组合数问题',body:`在无抽水、河牌纯极化、诈唬无摊牌胜率的简化模型中，${(bet/pot*100).toFixed(0)}% 底池下注对应 ${(bluff*100).toFixed(2)}% 的下注范围诈唬占比；最低防守频率参考为 ${(mdf*100).toFixed(2)}%。这两个数是模型基准，不能代替对对手范围的判断，也不能机械用于多人池。`});
  lines.push({title:'下一步研究：改变一个假设',body:'先写出对手的价值组合，再列出能到达这里的诈唬。将可疑诈唬的频率从 100% 改为 50%，重新计算并保存对比。若判断随少量组合就翻转，优先记录临界点与观察依据，而非记一个固定动作。'});
  return {lines,threshold,mdf,bluff,fee,callEV:he&&bet?(he.equity*(finalPot-fee)-bet):null,showdownOnly:board.length<5};
}
export function riverSensitivity(s){
  const v=validState(s);if(v.board.length!==5||v.hero.length!==2||v.bet<=0)throw Error('此实验需要河牌、两张聚焦手牌和大于 0 的对手下注额。');
  if(String(s.bluffs).includes(':'))throw Error('此处只选择组合，不填写权重；频率继承对手范围。');
  const opponent=range(s.heroSeat==='oop'?s.ip:s.oop,[...v.board,...v.hero]),selected=new Set(range(s.bluffs).all.map(c=>c.label));
  const heroRank=rankHand([...v.board,...v.hero]);let tagged=0,other=0,twins=0,owins=0;
  for(const c of opponent.live){const cr=rankHand([...v.board,...c.cards]),outcome=heroRank>cr?1:heroRank===cr?.5:0;if(selected.has(c.label)){tagged+=c.weight;twins+=outcome*c.weight;}else{other+=c.weight;owins+=outcome*c.weight;}}
  if(!tagged)throw Error('选择的诈唬组合不在当前对手范围内，或被已知牌阻断。');
  const net=v.pot+2*v.bet-Math.min((v.pot+2*v.bet)*v.rake/100,v.cap),denom=net*twins-v.bet*tagged,critical=denom?(v.bet*other-net*owins)/denom:null;
  const rows=Array.from({length:21},(_,i)=>{const frequency=i/20,total=other+tagged*frequency,equity=total?(owins+twins*frequency)/total:null;return {frequency,weighted:total,equity,ev:equity===null?null:equity*net-v.bet};});
  return {rows,tagged,other,critical:critical!==null&&critical>=0&&critical<=1?critical:null,threshold:v.bet/net,net,hero:v.hero.map(cardText).join(''),state:s};
}
