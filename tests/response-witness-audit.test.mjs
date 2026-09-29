import test from 'node:test';
import assert from 'node:assert/strict';
import {cards,cardText,range,rankHand} from '../lib/poker.mjs';
import {prepareRiverGame,solveRiverGame} from '../lib/river-engine.mjs';
import {solveTurnGame} from '../lib/turn-engine.mjs';
import {solveHUPostflop} from '../lib/hu-postflop.mjs';
import {createRangeConstruction} from '../lib/strategy-construction.mjs';
import {buildResponseWitness} from '../lib/response-witness.mjs';
import {evaluateHUPolicy} from '../lib/hu-policy-evaluation.mjs';

const close=(a,b,e=1e-8)=>assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=e,`${a} != ${b}`);
const canon=x=>cards(x,[2]).sort((a,b)=>a-b).map(cardText).join('');
const full=r=>({...r,capabilities:{...r.capabilities,fullTree:true}});
function submission(raw,result,nodeId='n0',actionId='check'){
 const q=createRangeConstruction(raw,result,{nodeId}).publicQuestion;
 return {nodeId,sourceFingerprint:q.sourceFingerprint,assignments:q.combos.filter(c=>c.editable).map(c=>({combo:c.combo,probabilities:Object.fromEntries(q.actions.map(a=>[a.id,a.id===actionId?1:0]))}))};
}
function applyResponse(source,player){
 const result=structuredClone(source),policy=new Map(source.bestResponsePolicies[player].map(r=>[r.nodeId+':'+canon(r.combo),r]));
 for(const n of result.nodes)if(n.actor===player)for(const row of n.combos){const selected=policy.get(n.id+':'+canon(row.combo));assert.ok(selected);row.probabilities=n.actions.map((_,i)=>i===selected.actionIndex?1:0);}
 return result;
}
function replaceSubmission(source,sub){
 const result=structuredClone(source),node=result.nodes.find(n=>n.id===sub.nodeId),assign=new Map(sub.assignments.map(r=>[canon(r.combo),r.probabilities]));
 for(const c of node.combos)if(assign.has(canon(c.combo)))c.probabilities=node.actions.map(a=>assign.get(canon(c.combo))[a.id]);
 return full(result);
}

/** Independent literal joint-deal traversal. It consumes only action policies,
 * cards and accounting states: no exported reaches, Q values, BR values or public
 * aggregate frequencies. Future cards are uniform conditional on ALL four holes.
 * It integrates any early all-in's unexposed board, including two-card runouts. */
function profileOracle(source){
 const input=source.input,initial=cards(input.board),rs=input.players.map(p=>range(p.range,initial).live),nodes=new Map(source.nodes.map(n=>[n.id,n])),rows=new Map(source.nodes.filter(n=>n.actor>=0).map(n=>[n.id,new Map(n.combos.map(c=>[canon(c.combo),c.probabilities]))]));
 const fee=Number(input.rake??0)>0?Number(input.rakeCap):0,root=source.nodes.find(n=>n.parentId===null),sum=[0,0];let mass=0,visits=0;
 for(const a of rs[0])for(const b of rs[1]){
  const hole=[...a.cards,...b.cards];if(new Set(hole).size!==4)continue;
  const weight=a.weight*b.weight,labels=[canon(a.label),canon(b.label)],equityCache=new Map();mass+=weight;
  function equity(board){
   const key=board.join(',');if(equityCache.has(key))return equityCache.get(key);
   const dead=new Set([...board,...hole]),left=Array.from({length:52},(_,i)=>i).filter(c=>!dead.has(c));let wins=0,count=0;
   const showdown=complete=>{const x=rankHand([...complete,...a.cards]),y=rankHand([...complete,...b.cards]);wins+=x===y?.5:x>y?1:0;count++;};
   if(board.length===5)showdown(board);else if(board.length===4)for(const c of left)showdown([...board,c]);else for(let i=0;i<left.length;i++)for(let j=i+1;j<left.length;j++)showdown([...board,left[i],left[j]]);
   const e=wins/count;equityCache.set(key,e);return e;
  }
  function visit(n){
   visits++;const board=cards(n.board??input.board);
   if(n.terminal){
    const [x,y]=n.contributions,common=input.pot-fee+2*Math.min(x,y),e=n.folded[0]?0:n.folded[1]?1:equity(board);
    return [common*e-x+Math.max(0,x-y),common*(1-e)-y+Math.max(0,y-x)];
   }
   const out=[0,0];if(n.chance){const denominator=52-board.length-4;let branches=0;for(const action of n.actions)if(!hole.includes(action.card)){const v=visit(nodes.get(action.childId));out[0]+=v[0]/denominator;out[1]+=v[1]/denominator;branches++;}assert.equal(branches,denominator);return out;}
   const probabilities=rows.get(n.id).get(labels[n.actor]);assert.ok(probabilities);for(let i=0;i<n.actions.length;i++)if(probabilities[i]>0){const v=visit(nodes.get(n.actions[i].childId));out[0]+=probabilities[i]*v[0];out[1]+=probabilities[i]*v[1];}return out;
  }
  const v=visit(root);sum.forEach((_,p)=>sum[p]+=weight*v[p]);
 }
 return {profileEV:sum.map(x=>x/mass),visits};
}

const counterexample={title:'A locally costly bet enables a profitable later call',board:'2c3d7h9sJc',pot:10,toAct:0,heroSeat:0,players:[{id:'u',name:'User',position:'BB',range:'KcKd',stack:30},{id:'o',name:'Opponent',position:'BTN',range:'AcAd',stack:30}],sizes:[50],raiseSizes:[50],maxRaises:1,allIn:false,iterations:1,averagingDelay:0};
async function negativeFixture(){
 const prepared=prepareRiverGame(counterexample),locks=prepared.nodes.filter(n=>n.actor>=0&&n.id!=='n0').map(n=>{
  const action=n.actor===1?n.actions.find(a=>a.id==='check')??n.actions.find(a=>a.id==='fold'):n.actions.find(a=>a.type==='raise')??n.actions.find(a=>a.id==='check')??n.actions.find(a=>a.id==='call');
  assert.ok(action);return {nodeId:n.id,actions:{[action.id]:1}};
 });
 const raw={...counterexample,locks},source=await solveRiverGame(raw),sub=submission(raw,source);
 return {raw,source,sub};
}

test('negative early gain and old own-zero-reach continuation reconstruct a hand-calculable unrestricted response',async()=>{
 const {raw,source,sub}=await negativeFixture(),w=buildResponseWitness(raw,source,sub),fixed=evaluateHUPolicy(replaceSubmission(source,sub),{captureBestResponse:true}),responded=applyResponse(fixed,1);
 // Original IP checks AA and wins the 10 BB starting pot. Its alternative bet
 // loses 5 BB under its ORIGINAL fold-to-raise continuation: local cost -15 BB.
 // The BR bets 5, faces the user's raise-to-15, then calls AA: root EV +25 BB.
 // At that last infoset the 5 BB is sunk; replacing fold by call adds +30 BB.
 close(w.values.fixedPolicyEV[1],10);close(w.values.bestResponseEV,25);close(w.values.opponentGainBB,15);
 close(w.values.negativeContributionBB,-15);close(w.values.positiveContributionBB,30);close(w.values.rootGainContributionBB,15);
 const early=w.topCombos.find(r=>r.rootGainContributionBB<0),later=w.topCombos.find(r=>r.rootGainContributionBB>0);
 assert.equal(early.responseActionId,'bet_5');assert.equal(later.responseActionId,'call');close(early.fixedContinuationAdvantageBB,-15);close(later.fixedContinuationAdvantageBB,30);
 const oldLater=fixed.nodes.find(n=>n.id===later.nodeId).combos[0];close(oldLater.reach,0);assert.ok(oldLater.counterfactualReach>0);assert.equal(oldLater.locked,true);
 assert.equal(w.verification.constrainedResidualUsed,false);assert.ok(w.limits.some(s=>s.includes('负')));
 const bet=early.actions.find(a=>a.id==='bet_5');close(bet.fixedContinuationEV,-5);close(bet.bestResponseContinuationEV,25);
 const oracle=profileOracle(responded);oracle.profileEV.forEach((v,p)=>close(v,w.values.witnessPolicyEV[p]));
 // Truly zero COUNTERFACTUAL reach is different: the fixed user's check
 // prevents these root-bet branches even if the responder changes every policy.
 // Capture may tie-break arbitrarily there; it must neither invent a conditional
 // continuation value nor make those decisions contribute to the witness.
 const impossible=fixed.bestResponsePolicies[1].filter(c=>c.counterfactualReach===0);assert.ok(impossible.length>0);const altered=structuredClone(responded),alteredNodes=new Map(altered.nodes.map(n=>[n.id,n]));
 for(const c of impossible){assert.equal(c.continuationEV,null);const n=alteredNodes.get(c.nodeId),r=n.combos.find(x=>canon(x.combo)===canon(c.combo));r.probabilities=n.actions.map((_,i)=>i===n.actions.length-1?1:0);assert.ok(!w.topCombos.some(x=>x.nodeId===c.nodeId&&canon(x.combo)===canon(c.combo)));}
 profileOracle(altered).profileEV.forEach((v,p)=>close(v,oracle.profileEV[p]));
 // A second independently compiled implementation verifies the captured full
 // pure response, even though the original opponent nodes were locked badly.
 const locks=responded.nodes.filter(n=>n.actor>=0).flatMap(n=>n.combos.map(c=>({nodeId:n.id,combo:c.combo,probabilities:c.probabilities})));
 const native=await solveRiverGame({...raw,locks,evaluationOnly:true});native.diagnostics.profileEV.forEach((v,p)=>close(v,w.values.witnessPolicyEV[p]));
});

test('own nonuniform priors alter occupancies, never same-hand response choices or conditional continuation values',async()=>{
 const raw={...counterexample,board:'Ks7h2h9c3s',pot:20,players:[{...counterexample.players[0],range:'AcKd:70%,AhQh:30%,7c7d:0.07'},{...counterexample.players[1],range:'AcQd:20%,QhJh:80%,9h9s:0.09'}],iterations:30},source=full(await solveRiverGame(raw)),first=evaluateHUPolicy(source,{captureBestResponse:true}),changed=structuredClone(source);
 // AcQd collides with AcKd, and QhJh collides with AhQh. Reweighting the
 // responder itself must cancel inside each private-hand information set.
 changed.input.players[1].range='AcQd:0.001,QhJh:0.02,9h9s:0.9';const second=evaluateHUPolicy(changed,{captureBestResponse:true}),byKey=new Map(second.bestResponsePolicies[1].map(c=>[c.nodeId+':'+canon(c.combo),c]));let changedReach=0,positive=0;
 for(const c of first.bestResponsePolicies[1]){const d=byKey.get(c.nodeId+':'+canon(c.combo));assert.equal(c.actionId,d.actionId);if(c.continuationEV){positive++;c.continuationEV.forEach((v,i)=>close(v,d.continuationEV[i]));}else assert.equal(d.continuationEV,null);if(Math.abs(c.counterfactualReach-d.counterfactualReach)>1e-9)changedReach++;}
 assert.ok(positive>0&&changedReach>0);
 for(const evaluated of [first,second]){const realized=applyResponse(evaluated,1),oracle=profileOracle(realized);close(oracle.profileEV[1],evaluated.diagnostics.bestResponseEV[1]);}
});

test('turn-card posteriors and truncated top lists retain all positive and negative root contributions',async()=>{
 const raw={...counterexample,board:'Ks7h2h9c',pot:20,rake:5,rakeCap:.5,players:[{...counterexample.players[0],range:'AcKd:70%,AhQh:30%'},{...counterexample.players[1],range:'KcQd:20%,QhJh:80%',stack:20}],maxRaises:0,riverMaxRaises:0,iterations:30},source=await solveTurnGame(raw),sub=submission(raw,source),w=buildResponseWitness(raw,source,sub,{maxSeconds:30}),fixed=evaluateHUPolicy(replaceSubmission(source,sub),{captureBestResponse:true}),response=applyResponse(fixed,1),realized=evaluateHUPolicy(response,{computeBestResponse:false});
 const oracle=profileOracle(response);oracle.profileEV.forEach((v,p)=>close(v,w.values.witnessPolicyEV[p]));close(oracle.profileEV[0]+oracle.profileEV[1],19.5);
 let sum=0,infosets=0;const before=new Map(fixed.nodes.map(n=>[n.id,n])),choices=new Map(fixed.bestResponsePolicies[1].map(c=>[c.nodeId+':'+canon(c.combo),c]));
 for(const n of realized.nodes)if(n.actor===1)for(const row of n.combos)if(row.reach>0){const old=before.get(n.id).combos.find(c=>canon(c.combo)===canon(row.combo)),a=choices.get(n.id+':'+canon(row.combo)).actionIndex;sum+=row.reach*(old.actionEV[a]-old.probabilities.reduce((s,p,i)=>s+p*old.actionEV[i],0));infosets++;}
 close(sum,w.values.opponentGainBB);assert.equal(infosets,w.counts.reachableInformationSets);assert.ok(w.counts.respondingNodes>12);assert.equal(w.nodes.length,12);assert.equal(w.topCombos.length,24);
 assert.ok(Math.abs(w.nodes.reduce((s,n)=>s+n.rootGainContributionBB,0)-sum)>1e-5,'top nodes must not be presented as the complete sum');
 assert.ok(w.limits.some(s=>s.includes('截取')&&s.includes('完整加总')));
 // Every card-specific response remains a single action for the responder's
 // hand, despite differing compatible opponent hands and future card blockers.
 const unique=new Set(fixed.bestResponsePolicies[1].map(c=>c.nodeId+':'+canon(c.combo)));assert.equal(unique.size,fixed.bestResponsePolicies[1].length);
});

test('complete shallow flop response matches literal private-conditioned two-street traversal and early all-in integration',async()=>{
 const raw={title:'Full flop response oracle',board:'Ks7h2d',pot:10,toAct:0,heroSeat:0,players:[{id:'a',name:'BB',position:'BB',stack:2,range:'AcKd,AhQh:0.3'},{id:'b',name:'BTN',position:'BTN',stack:2,range:'KhQd,QcJc:0.7'}],sizes:[],raiseSizes:[],maxRaises:0,allIn:true,iterations:10,accuracy:.000001,maxNodes:50000,maxSeconds:60},exported=await solveHUPostflop(raw),source=evaluateHUPolicy(exported),sub=submission(raw,source),w=buildResponseWitness(raw,source,sub,{maxNodes:50000,maxSeconds:30}),fixed=evaluateHUPolicy(replaceSubmission(source,sub),{captureBestResponse:true}),response=applyResponse(fixed,1),oracle=profileOracle(response);
 assert.deepEqual([...new Set(source.nodes.map(n=>cards(n.board).length))].sort(),[3,4,5]);assert.ok(oracle.visits>1000);oracle.profileEV.forEach((v,p)=>close(v,w.values.witnessPolicyEV[p]));close(oracle.profileEV[1],fixed.diagnostics.bestResponseEV[1]);close(w.values.rootGainContributionBB,w.values.opponentGainBB);
 // Replace an all-in's explicit future tree with early settlement. This cannot
 // change policy value or any information-set BR, and exercises the evaluator's
 // exact all-in integration rather than accidentally relying on public marginal
 // deal-card frequencies. Preserve IDs to avoid changing policy lookup keys.
 const collapsed=structuredClone(response),byId=new Map(collapsed.nodes.map(n=>[n.id,n])),kept=[];let removedChance=0;
 function visit(n){kept.push(n);if(n.chance&&n.contributions.every(x=>x>=2)){n.actor=-1;n.chance=false;n.terminal=true;n.actions=[];removedChance++;return;}for(const a of n.actions)visit(byId.get(a.childId));}visit(collapsed.nodes.find(n=>n.parentId===null));collapsed.nodes=kept;assert.ok(removedChance>0);
 const early=profileOracle(collapsed),evaluated=evaluateHUPolicy(collapsed,{computeBestResponse:false});early.profileEV.forEach((v,p)=>{close(v,oracle.profileEV[p]);close(v,evaluated.diagnostics.profileEV[p]);});
});
